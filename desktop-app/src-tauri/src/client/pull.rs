use super::{transport, ClientError};
use std::path::Path;
use tokio::{
    fs as tokio_fs,
    io::{AsyncWriteExt, BufWriter},
};

/// Pull (download) a file from a peer and save it to `local_save_path`.
///
/// The response body is streamed to disk in 64 KB chunks — the full file is
/// never buffered in memory.
///
/// ## Path safety for `local_save_path`
///
/// This function does **not** validate `local_save_path` against a sandbox
/// root.  The caller (our own Tauri command layer) already knows the local
/// sandbox root and is responsible for ensuring the save destination stays
/// inside it.  The `remote_path` argument, by contrast, will be validated by
/// the **peer's** `verify_sandboxed_path` when they receive our GET request.
///
/// ## Error handling
///
/// If the peer responds with a non‑200 status, the function returns an error
/// immediately — no local file is created.  If an I/O error occurs mid‑stream,
/// the partial file is deleted via the [`WriteGuard`] drop guard before
/// returning.
pub async fn pull_file_from_peer(
    peer_addr: &str,
    remote_path: &str,
    local_save_path: &Path,
) -> Result<(), ClientError> {
    // ---- 1. Request the stream from the peer -----------------------------
    let response = transport::get_stream(peer_addr, remote_path).await?;

    // ---- 2. Check the response status before creating a local file -------
    let status = response.status();
    if !status.is_success() {
        return Err(ClientError::ServerRejected(status.as_u16()));
    }

    // ---- 3. Open the local file for writing ------------------------------
    // Create parent directories if they don't exist (e.g. nested save paths).
    if let Some(parent) = local_save_path.parent() {
        tokio_fs::create_dir_all(parent)
            .await
            .map_err(|e| ClientError::IoError(e.to_string()))?;
    }

    let file = tokio_fs::File::create(local_save_path)
        .await
        .map_err(|e| ClientError::IoError(e.to_string()))?;

    // Arm the RAII guard — the partial file is deleted on any early return.
    let mut guard = crate::fs_util::WriteGuard::new(local_save_path.to_path_buf());

    // ---- 4. Stream the response body to disk in 64 KB chunks -------------
    use futures_util::StreamExt;

    let mut writer = BufWriter::with_capacity(64 * 1024, file);
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| ClientError::HttpError(e.to_string()))?;
        writer
            .write_all(&chunk)
            .await
            .map_err(|e| ClientError::IoError(e.to_string()))?;
    }

    writer
        .flush()
        .await
        .map_err(|e| ClientError::IoError(e.to_string()))?;

    guard.disarm();
    Ok(())
}
