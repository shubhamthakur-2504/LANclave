use super::{transport, ClientError};
use std::path::Path;
use tokio::io::BufReader;
use tokio_util::io::ReaderStream;

/// Push (upload) a local file to a peer's sandbox at the given
/// `remote_path`.
///
/// The file is read from `local_path` and streamed to the peer in 64 KB
/// chunks — the full file is never buffered in memory.
///
/// Well‑known HTTP statuses are mapped to specific [`ClientError`] variants
/// so the UI can show a meaningful message:
///
/// | Status | Meaning | Variant |
/// |---|---|---|
/// | 409 | File already exists on peer | `ServerRejected(409)` |
/// | 413 | File exceeds peer's size limit | `ServerRejected(413)` |
/// | 400 | Peer rejected the path (traversal, etc.) | `ServerRejected(400)` |
pub async fn push_file_to_peer(
    peer_addr: &str,
    local_path: &Path,
    remote_path: &str,
) -> Result<(), ClientError> {
    // ---- 1. Open the local file for streaming ----------------------------
    let file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| ClientError::IoError(e.to_string()))?;

    // ---- 2. Build a streaming request body -------------------------------
    let reader = BufReader::new(file);
    let stream = ReaderStream::with_capacity(reader, 64 * 1024);
    let body = reqwest::Body::wrap_stream(stream);

    // ---- 3. Send the request ---------------------------------------------
    let status = transport::put_stream(peer_addr, remote_path, body).await?;

    // ---- 4. Map the response ---------------------------------------------
    if status.is_success() {
        Ok(())
    } else {
        Err(ClientError::ServerRejected(status.as_u16()))
    }
}
