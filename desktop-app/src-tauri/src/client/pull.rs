use super::{transport, ClientError};
use ed25519_dalek::SigningKey;
use std::path::{Path, PathBuf};
use tokio::{
    fs as tokio_fs,
    io::{AsyncWriteExt, BufWriter},
    sync::oneshot,
};

#[derive(Clone, serde::Serialize)]
pub struct TransferProgressEvent {
    pub id: String,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub status: String,
    /// Why a transfer failed. `None` for every other status.
    ///
    /// Without this the UI can say a transfer failed but not what went
    /// wrong, which is the part a user can actually act on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// On completion or skip: the name the file has at the destination.
    /// Differs from the requested one when that was taken, or when an
    /// identical copy already lived under a numbered name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dest_name: Option<String>,
}

/// How a transfer that returned `Ok` ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferOutcome {
    Transferred,
    /// The destination already held an identical copy; nothing was sent.
    AlreadyPresent,
    /// Stopped by the user with the partial file kept; pulling the same
    /// file again resumes from where it stopped.
    Paused,
}

/// What a transfer that returned `Ok` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferReport {
    pub outcome: TransferOutcome,
    /// Size of the file (bytes moved, or the size of the copy already there).
    pub bytes: u64,
    /// Name at the destination; see [`TransferProgressEvent::dest_name`].
    pub dest_name: String,
}

/// Why a running pull is being stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// Keep the partial file so the pull can resume.
    Pause,
    /// Throw the partial file away.
    Cancel,
}

/// Where a pull reads from on the peer.
#[derive(Debug, Clone)]
pub struct PullSource {
    /// Request path, percent-encoded, e.g. `/files/a%20b.txt`.
    pub path: String,
    /// Fingerprint path for dedupe and verification, if the peer has one.
    pub fingerprint_path: Option<String>,
}

impl PullSource {
    /// A file in the peer's shared sandbox.
    pub fn sandbox(remote_path: &str) -> Self {
        let encoded = transport::encode_path(remote_path);
        Self {
            path: format!("/files/{encoded}"),
            fingerprint_path: Some(format!("/api/sandbox/fingerprint/{encoded}")),
        }
    }
}

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string()
}

// ---------------------------------------------------------------------------
// Partial files
// ---------------------------------------------------------------------------

/// A download in progress lives beside its destination as a hidden
/// `.name.<source tag>.lanclave-part`, with a `.json` note saying what it is
/// part of. Hidden (leading dot) so listings, dedupe and sorting never see
/// it. Tagged by source, so two downloads that will land under one name
/// (two offered `IMG_1.jpg`, running side by side) never share a partial.
pub(crate) fn partial_paths(dest: &Path, source: &str) -> (PathBuf, PathBuf) {
    use sha2::{Digest, Sha256};
    let tag: String = Sha256::digest(source.as_bytes())[..4].iter().map(|b| format!("{b:02x}")).collect();
    let dir = dest.parent().unwrap_or_else(|| Path::new(""));
    let name = file_name_of(dest);
    (
        dir.join(format!(".{name}.{tag}.lanclave-part")),
        dir.join(format!(".{name}.{tag}.lanclave-part.json")),
    )
}

struct Partial {
    data: PathBuf,
    note: PathBuf,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq)]
struct PartialNote {
    /// The peer request path it was downloaded from.
    source: String,
    /// The peer's version tag for the file; sent back as `If-Range`.
    etag: String,
    /// Full size of the file.
    size: u64,
}

impl Partial {
    fn new(dest: &Path, source: &str) -> Self {
        let (data, note) = partial_paths(dest, source);
        Self { data, note }
    }

    /// Bytes already on disk for `source`, with its tag and size, if the
    /// partial file belongs to it. Anything else found there is stale.
    async fn resumable(&self, source: &str) -> Option<(u64, PartialNote)> {
        let note: PartialNote =
            serde_json::from_slice(&tokio_fs::read(&self.note).await.ok()?).ok()?;
        if note.source != source {
            return None;
        }
        let have = tokio_fs::metadata(&self.data).await.ok()?.len();
        (have > 0 && have <= note.size).then_some((have, note))
    }

    async fn write_note(&self, note: &PartialNote) {
        if let Ok(json) = serde_json::to_vec(note) {
            let _ = tokio_fs::write(&self.note, json).await;
        }
    }

    async fn discard(&self) {
        let _ = tokio_fs::remove_file(&self.data).await;
        let _ = tokio_fs::remove_file(&self.note).await;
    }

    /// Move the finished file to a free name beside `dest` (never over an
    /// existing file) and drop the note. Returns the final path.
    async fn finish(&self, dest: &Path) -> Result<PathBuf, ClientError> {
        // Reserve the name atomically, then replace the empty placeholder.
        let (placeholder, final_path) = crate::fs_util::create_unique(dest)
            .await
            .map_err(|e| ClientError::IoError(e.to_string()))?;
        drop(placeholder);
        if let Err(e) = tokio_fs::rename(&self.data, &final_path).await {
            // Do not leave the reserved, empty file looking like a download.
            let _ = tokio_fs::remove_file(&final_path).await;
            return Err(ClientError::IoError(e.to_string()));
        }
        let _ = tokio_fs::remove_file(&self.note).await;
        Ok(final_path)
    }
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/// Stream a file from the peer's sandbox into `local_save_path`; see
/// [`pull_from_source`].
#[cfg(test)]
pub(crate) async fn pull_file_to_disk(
    transfer_id: &str,
    peer_addr: &str,
    remote_path: &str,
    local_save_path: &Path,
    remote_size: Option<u64>,
    device_id: &str,
    signing_key: &SigningKey,
    stop_rx: oneshot::Receiver<StopReason>,
    on_event: impl FnMut(&TransferProgressEvent),
) -> Result<TransferReport, ClientError> {
    pull_from_source(
        transfer_id,
        peer_addr,
        &PullSource::sandbox(remote_path),
        local_save_path,
        remote_size,
        device_id,
        signing_key,
        stop_rx,
        on_event,
    )
    .await
}

/// Download `source` from `peer_addr` into `local_save_path`, reporting
/// progress through `on_event`.
///
/// - **Dedupe:** if a local file with that name (or a numbered copy of it)
///   and size already exists, it is compared by digest first and the pull is
///   skipped when they match (status `"skipped"`).
/// - **Resume:** bytes land in a hidden partial file. A pull of the same
///   source finding one continues from its length (`Range`), guarded by the
///   peer's version tag (`If-Range`): a changed file restarts from zero.
/// - **Stop:** `Pause` keeps the partial file (status `"paused"`); `Cancel`
///   deletes it. A dropped connection keeps it too, so a retry resumes.
/// - **Never overwrite:** the finished file takes a free name beside
///   `local_save_path` (`name (1).ext` if taken).
///
/// Free of Tauri types so the test suite can drive it directly.
pub(crate) async fn pull_from_source(
    transfer_id: &str,
    peer_addr: &str,
    source: &PullSource,
    local_save_path: &Path,
    remote_size: Option<u64>,
    device_id: &str,
    signing_key: &SigningKey,
    mut stop_rx: oneshot::Receiver<StopReason>,
    mut on_event: impl FnMut(&TransferProgressEvent),
) -> Result<TransferReport, ClientError> {
    let mut emit = |status: &str, done: u64, total: u64, message: Option<String>, dest: Option<String>| {
        on_event(&TransferProgressEvent {
            id: transfer_id.to_string(),
            bytes_transferred: done,
            total_bytes: total,
            status: status.to_string(),
            message,
            dest_name: dest,
        });
    };

    // ---- 0. Skip if we already hold an identical copy --------------------
    let existing = match &source.fingerprint_path {
        Some(fp) => tokio::select! {
            reason = &mut stop_rx => {
                emit("failed", 0, remote_size.unwrap_or(0), None, None);
                return Err(stopped_before_start(reason));
            }
            same = crate::dedupe::local_copy_of(
                peer_addr,
                fp,
                local_save_path,
                remote_size,
                device_id,
                signing_key,
            ) => same,
        },
        None => None,
    };
    if let Some(existing) = existing {
        let size = tokio_fs::metadata(&existing).await.map(|m| m.len()).unwrap_or(0);
        let dest_name = file_name_of(&existing);
        emit("skipped", size, size, None, Some(dest_name.clone()));
        return Ok(TransferReport { outcome: TransferOutcome::AlreadyPresent, bytes: size, dest_name });
    }

    if let Some(parent) = local_save_path.parent() {
        tokio_fs::create_dir_all(parent)
            .await
            .map_err(|e| ClientError::IoError(e.to_string()))?;
    }
    let partial = Partial::new(local_save_path, &source.path);

    // Two passes at most: a partial the peer refuses to extend (416 on a
    // stale or oversized partial) is discarded and the pull starts over.
    for attempt in 0..2 {
        let resume = if attempt == 0 { partial.resumable(&source.path).await } else { None };
        if resume.is_none() {
            partial.discard().await;
        }

        // ---- 1. Request, from where the partial file stops ----------------
        let response = transport::get_stream_at(
            peer_addr,
            &source.path,
            resume.as_ref().map(|(have, note)| (*have, note.etag.as_str())),
            device_id,
            signing_key,
        )
        .await?;

        let status = response.status();
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            if let Some((have, note)) = &resume {
                if *have == note.size {
                    // Everything had already arrived; only the rename was lost.
                    let final_path = partial.finish(local_save_path).await?;
                    let dest_name = file_name_of(&final_path);
                    emit("completed", *have, *have, None, Some(dest_name.clone()));
                    return Ok(TransferReport { outcome: TransferOutcome::Transferred, bytes: *have, dest_name });
                }
            }
            continue; // stale partial: start over
        }
        if !status.is_success() {
            emit("failed", 0, 0, None, None);
            return Err(ClientError::ServerRejected(status.as_u16()));
        }

        // 206 continues the partial file; 200 is the whole file (the peer
        // ignored the range, or the file changed and If-Range voided it).
        let offset = match (&resume, status) {
            (Some((have, _)), reqwest::StatusCode::PARTIAL_CONTENT)
                if content_range_start(&response) == Some(*have) => *have,
            (_, reqwest::StatusCode::PARTIAL_CONTENT) => {
                // A range we did not ask for: trust nothing, start over.
                partial.discard().await;
                continue;
            }
            _ => 0,
        };
        let total = offset + response.content_length().unwrap_or(0);

        if let Some(etag) = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
        {
            partial
                .write_note(&PartialNote { source: source.path.clone(), etag: etag.to_string(), size: total })
                .await;
        }

        let file = if offset > 0 {
            tokio_fs::OpenOptions::new().append(true).open(&partial.data).await
        } else {
            tokio_fs::File::create(&partial.data).await
        }
        .map_err(|e| ClientError::IoError(e.to_string()))?;

        // ---- 2. Stream to the partial file --------------------------------
        use futures_util::StreamExt;
        let mut writer = BufWriter::with_capacity(64 * 1024, file);
        let mut stream = response.bytes_stream();
        let mut done = offset;
        let mut last_emit = std::time::Instant::now();
        emit("in_progress", done, total, None, None);

        loop {
            tokio::select! {
                reason = &mut stop_rx => {
                    let _ = writer.flush().await;
                    drop(writer);
                    return match reason.unwrap_or(StopReason::Cancel) {
                        StopReason::Pause => {
                            emit("paused", done, total, None, None);
                            Ok(TransferReport {
                                outcome: TransferOutcome::Paused,
                                bytes: done,
                                dest_name: file_name_of(local_save_path),
                            })
                        }
                        StopReason::Cancel => {
                            partial.discard().await;
                            emit("failed", done, total, None, None);
                            Err(ClientError::IoError("Transfer cancelled".into()))
                        }
                    };
                }
                chunk = stream.next() => match chunk {
                    Some(Ok(bytes)) => {
                        writer
                            .write_all(&bytes)
                            .await
                            .map_err(|e| ClientError::IoError(e.to_string()))?;
                        done += bytes.len() as u64;
                        if last_emit.elapsed().as_millis() >= 100 {
                            emit("in_progress", done, total, None, None);
                            last_emit = std::time::Instant::now();
                        }
                    }
                    Some(Err(e)) => {
                        // Keep what arrived: retrying resumes from here.
                        let _ = writer.flush().await;
                        let err = ClientError::HttpError(e.to_string());
                        emit("failed", done, total, Some(err.to_string()), None);
                        return Err(err);
                    }
                    None => break,
                },
            }
        }

        writer
            .flush()
            .await
            .map_err(|e| ClientError::IoError(e.to_string()))?;
        drop(writer);

        // A body that ends early is a truncated file, not a finished one.
        // The partial stays, so a retry resumes rather than restarting.
        if done != total {
            let err = ClientError::HttpError(format!("peer sent {done} of {total} bytes"));
            emit("failed", done, total, Some(err.to_string()), None);
            return Err(err);
        }

        // ---- 3. Check it against the sender's copy ------------------------
        emit("verifying", done, total, None, None);
        match verify(peer_addr, source, &partial.data, total, device_id, signing_key).await {
            Verified::Mismatch if attempt == 0 => {
                // A corrupted resume or transfer: once more, from scratch.
                partial.discard().await;
                continue;
            }
            Verified::Mismatch => {
                partial.discard().await;
                let err = ClientError::IoError(
                    "the file arrived damaged twice; it does not match the sender's copy".into(),
                );
                emit("failed", done, total, Some(err.to_string()), None);
                return Err(err);
            }
            Verified::Match | Verified::Unavailable => {}
        }

        // ---- 4. Give the file its real name --------------------------------
        let final_path = partial.finish(local_save_path).await?;
        let dest_name = file_name_of(&final_path);
        emit("completed", done, total, None, Some(dest_name.clone()));
        return Ok(TransferReport { outcome: TransferOutcome::Transferred, bytes: done, dest_name });
    }

    let err = ClientError::HttpError("peer kept refusing to resume the download".into());
    emit("failed", 0, 0, Some(err.to_string()), None);
    Err(err)
}

enum Verified {
    Match,
    Mismatch,
    /// The peer cannot say (no fingerprint route, too old, unreachable).
    Unavailable,
}

/// Compare the downloaded bytes with the sender's SHA-256 of the file.
async fn verify(
    peer_addr: &str,
    source: &PullSource,
    data: &Path,
    size: u64,
    device_id: &str,
    signing_key: &SigningKey,
) -> Verified {
    let Some(fp_path) = &source.fingerprint_path else {
        return Verified::Unavailable;
    };
    let exact = format!("{fp_path}?exact=1");
    let remote = match transport::get_fingerprint_at(peer_addr, &exact, Some(size), device_id, signing_key).await {
        Ok(Some(fp)) => fp,
        _ => return Verified::Unavailable,
    };
    let Some(remote_sha) = remote.sha256.filter(|_| remote.size == size) else {
        // The sender's file changed size since: this copy is not it.
        return Verified::Mismatch;
    };
    let data = data.to_path_buf();
    match tokio::task::spawn_blocking(move || crate::dedupe::sha256_file(&data)).await {
        Ok(Ok(local)) if local.eq_ignore_ascii_case(&remote_sha) => Verified::Match,
        Ok(Ok(_)) => Verified::Mismatch,
        _ => Verified::Unavailable,
    }
}

/// The first byte of a `206` response, from its `Content-Range`.
fn content_range_start(response: &reqwest::Response) -> Option<u64> {
    let value = response.headers().get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    let range = value.strip_prefix("bytes ")?;
    range.split('-').next()?.trim().parse().ok()
}

fn stopped_before_start(reason: Result<StopReason, oneshot::error::RecvError>) -> ClientError {
    match reason {
        Ok(StopReason::Pause) => ClientError::IoError("Transfer paused".into()),
        _ => ClientError::IoError("Transfer cancelled".into()),
    }
}

/// Delete the partial download of `source` into `dest`, if any.
pub async fn discard_partial_for(dest: &Path, source: &PullSource) {
    Partial::new(dest, &source.path).discard().await;
}

/// Delete partial downloads, and their notes, that nothing has written to
/// for `max_age`, anywhere under `root`. Returns how many files went.
/// Blocking: run it off the async runtime.
pub fn sweep_stale_partials(root: &Path, max_age: std::time::Duration) -> usize {
    fn walk(dir: &Path, depth: u32, cutoff: std::time::SystemTime, removed: &mut usize) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            // Not followed: a link out of the sandbox is not ours to clean.
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if depth < 8 {
                    walk(&entry.path(), depth + 1, cutoff, removed);
                }
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let partial = name.starts_with('.')
                && (name.ends_with(".lanclave-part") || name.ends_with(".lanclave-part.json"));
            if !kind.is_file() || !partial {
                continue;
            }
            let old = entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < cutoff);
            if old && std::fs::remove_file(entry.path()).is_ok() {
                *removed += 1;
            }
        }
    }
    let Some(cutoff) = std::time::SystemTime::now().checked_sub(max_age) else { return 0 };
    let mut removed = 0;
    walk(root, 0, cutoff, &mut removed);
    removed
}
