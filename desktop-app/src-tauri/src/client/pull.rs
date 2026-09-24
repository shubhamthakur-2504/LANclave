use super::{transport, ClientError};
use ed25519_dalek::SigningKey;
use std::path::Path;
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

fn file_name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string()
}

/// Stream a file from `peer_addr` into `local_save_path`, reporting progress
/// through `on_event`.
///
/// `remote_size` is the size from the peer's listing, when known. If a local
/// file with that name (or a numbered copy of it) and size already exists,
/// it is compared by digest first and the download is skipped when they
/// match (see `crate::dedupe`). A skip is reported with status `"skipped"`.
///
/// An existing local file is never overwritten: a different file under the
/// same name is kept, and the download saved as `name (1).ext`.
///
/// This is the transport-level implementation and is intentionally free of
/// Tauri types so the test suite can exercise it directly without an
/// `AppHandle`.
pub(crate) async fn pull_file_to_disk(
    transfer_id: &str,
    peer_addr: &str,
    remote_path: &str,
    local_save_path: &Path,
    remote_size: Option<u64>,
    device_id: &str,
    signing_key: &SigningKey,
    mut cancel_rx: oneshot::Receiver<()>,
    mut on_event: impl FnMut(&TransferProgressEvent),
) -> Result<TransferReport, ClientError> {
    // ---- 0. Skip if we already hold an identical copy --------------------
    let existing = tokio::select! {
        _ = &mut cancel_rx => {
            on_event(&TransferProgressEvent {
                id: transfer_id.to_string(),
                bytes_transferred: 0,
                total_bytes: remote_size.unwrap_or(0),
                status: "failed".to_string(),
                message: None,
                dest_name: None,
            });
            return Err(ClientError::IoError("Transfer cancelled".into()));
        }
        same = crate::dedupe::local_copy_of(
            peer_addr,
            remote_path,
            local_save_path,
            remote_size,
            device_id,
            signing_key,
        ) => same,
    };
    if let Some(existing) = existing {
        let size = tokio_fs::metadata(&existing)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        let dest_name = file_name_of(&existing);
        on_event(&TransferProgressEvent {
            id: transfer_id.to_string(),
            bytes_transferred: size,
            total_bytes: size,
            status: "skipped".to_string(),
            message: None,
            dest_name: Some(dest_name.clone()),
        });
        return Ok(TransferReport {
            outcome: TransferOutcome::AlreadyPresent,
            bytes: size,
            dest_name,
        });
    }

    // ---- 1. Request the stream from the peer -----------------------------
    let response = transport::get_stream(peer_addr, remote_path, device_id, signing_key).await?;

    // ---- 2. Check the response status before creating a local file -------
    let status = response.status();
    if !status.is_success() {
        on_event(&TransferProgressEvent {
            id: transfer_id.to_string(),
            bytes_transferred: 0,
            total_bytes: 0,
            status: "failed".to_string(),
            message: None,
            dest_name: None,
});
        return Err(ClientError::ServerRejected(status.as_u16()));
    }

    let total_bytes = response.content_length().unwrap_or(0);

    // ---- 3. Open the local file for writing ------------------------------
    if let Some(parent) = local_save_path.parent() {
        tokio_fs::create_dir_all(parent)
            .await
            .map_err(|e| ClientError::IoError(e.to_string()))?;
    }

    let (file, saved_path) = crate::fs_util::create_unique(local_save_path)
        .await
        .map_err(|e| ClientError::IoError(e.to_string()))?;
    let dest_name = file_name_of(&saved_path);

    let mut guard = crate::fs_util::WriteGuard::new(saved_path);

    // ---- 4. Stream the response body to disk in 64 KB chunks -------------
    use futures_util::StreamExt;

    let mut writer = BufWriter::with_capacity(64 * 1024, file);
    let mut stream = response.bytes_stream();
    let mut bytes_transferred: u64 = 0;

    // Throttle progress events to ~10 per second.
    let mut last_emit = std::time::Instant::now();

    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                on_event(&TransferProgressEvent {
                    id: transfer_id.to_string(),
                    bytes_transferred,
                    total_bytes,
                    status: "failed".to_string(),
                    message: None,
                    dest_name: None,
});
                return Err(ClientError::IoError("Transfer cancelled".into()));
            }
            chunk_result = stream.next() => {
                match chunk_result {
                    Some(Ok(chunk)) => {
                        writer
                            .write_all(&chunk)
                            .await
                            .map_err(|e| ClientError::IoError(e.to_string()))?;

                        bytes_transferred += chunk.len() as u64;

                        if last_emit.elapsed().as_millis() >= 100 {
                            on_event(&TransferProgressEvent {
                                id: transfer_id.to_string(),
                                bytes_transferred,
                                total_bytes,
                                status: "in_progress".to_string(),
                                message: None,
                                dest_name: None,
                            });
                            last_emit = std::time::Instant::now();
                        }
                    }
                    Some(Err(e)) => {
                        let err = ClientError::HttpError(e.to_string());
                        on_event(&TransferProgressEvent {
                            id: transfer_id.to_string(),
                            bytes_transferred,
                            total_bytes,
                            status: "failed".to_string(),
                            message: Some(err.to_string()),
                            dest_name: None,
                        });
                        return Err(err);
                    }
                    None => break,
                }
            }
        }
    }

    writer
        .flush()
        .await
        .map_err(|e| ClientError::IoError(e.to_string()))?;

    // A body that ends early is a truncated file, not a finished one. The
    // guard deletes it on this return.
    if total_bytes > 0 && bytes_transferred != total_bytes {
        let err = ClientError::HttpError(format!(
            "peer sent {bytes_transferred} of {total_bytes} bytes"
        ));
        on_event(&TransferProgressEvent {
            id: transfer_id.to_string(),
            bytes_transferred,
            total_bytes,
            status: "failed".to_string(),
            message: Some(err.to_string()),
            dest_name: None,
        });
        return Err(err);
    }

    guard.disarm();

    on_event(&TransferProgressEvent {
        id: transfer_id.to_string(),
        bytes_transferred,
        total_bytes,
        status: "completed".to_string(),
        message: None,
        dest_name: Some(dest_name.clone()),
    });

    Ok(TransferReport {
        outcome: TransferOutcome::Transferred,
        bytes: bytes_transferred,
        dest_name,
    })
}

/// Tauri-facing wrapper around [`pull_file_to_disk`] that re-emits progress
/// events as Tauri events for the React frontend.
pub async fn pull_file_from_peer(
    app: tauri::AppHandle,
    transfer_id: String,
    peer_addr: &str,
    remote_path: &str,
    local_save_path: &Path,
    remote_size: Option<u64>,
    device_id: &str,
    signing_key: &SigningKey,
    cancel_rx: oneshot::Receiver<()>,
) -> Result<TransferReport, ClientError> {
    use tauri::Emitter;

    pull_file_to_disk(
        &transfer_id,
        peer_addr,
        remote_path,
        local_save_path,
        remote_size,
        device_id,
        signing_key,
        cancel_rx,
        |event| {
            let event_name = match event.status.as_str() {
                "in_progress" => "transfer-progress",
                "completed" | "skipped" => "transfer-completed",
                _ => "transfer-failed",
            };
            let _ = app.emit(event_name, (*event).clone());
        },
    )
    .await
}
