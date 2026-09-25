use super::{transport, ClientError};
use ed25519_dalek::SigningKey;
use std::path::Path;
use tokio::io::BufReader;
use tokio_util::io::ReaderStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use crate::client::pull::{TransferOutcome, TransferProgressEvent, TransferReport};

/// Push (upload) a local file to a peer's sandbox at the given
/// `remote_path`, reporting progress through `on_event`.
///
/// Asks the peer for a fingerprint first when it may already hold the file
/// (under `remote_path` or a numbered copy), and returns
/// [`TransferOutcome::AlreadyPresent`] without sending a byte when it does
/// (see `crate::dedupe`). The peer never overwrites: a taken name is saved
/// as `name (1).ext`, reported back in [`TransferReport::dest_name`].
pub(crate) async fn push_file_with_progress(
    transfer_id: &str,
    peer_addr: &str,
    local_path: &Path,
    remote_path: &str,
    device_id: &str,
    signing_key: &SigningKey,
    cancel_flag: Arc<AtomicBool>,
    mut on_event: impl FnMut(&TransferProgressEvent) + Send + 'static,
) -> Result<TransferReport, ClientError> {
    // ---- 0. Skip if the peer already holds an identical copy -------------
    if let Some(dest_name) =
        crate::dedupe::peer_copy_of(peer_addr, remote_path, local_path, device_id, signing_key)
            .await
    {
        let bytes = tokio::fs::metadata(local_path).await.map(|m| m.len()).unwrap_or(0);
        return Ok(TransferReport {
            outcome: TransferOutcome::AlreadyPresent,
            bytes,
            dest_name,
        });
    }

    // ---- 1. Open the local file and get its size -------------------------
    let file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| ClientError::IoError(e.to_string()))?;
        
    let metadata = file.metadata().await.map_err(|e| ClientError::IoError(e.to_string()))?;
    let total_bytes = metadata.len();

    // ---- 2. Build a streaming request body with progress tracking --------
    let reader = BufReader::new(file);
    let stream = ReaderStream::with_capacity(reader, 64 * 1024);
    
    use futures_util::StreamExt;
    let mut bytes_transferred: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let transfer_id_str = transfer_id.to_string();
    
    let counting_stream = stream.map(move |chunk_result| {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                "Transfer cancelled",
            ));
        }
        
        match chunk_result {
            Ok(chunk) => {
                bytes_transferred += chunk.len() as u64;
                if last_emit.elapsed().as_millis() >= 100 {
                    on_event(&TransferProgressEvent {
                        id: transfer_id_str.clone(),
                        bytes_transferred,
                        total_bytes,
                        status: "in_progress".to_string(),
                        message: None,
                        dest_name: None,
                    });
                    last_emit = std::time::Instant::now();
                }
                Ok(chunk)
            }
            Err(e) => Err(e),
        }
    });

    let body = reqwest::Body::wrap_stream(counting_stream);

    // ---- 3. Send the request ---------------------------------------------
    let status_result =
        transport::put_stream(peer_addr, remote_path, body, total_bytes, device_id, signing_key)
            .await;

    // ---- 4. Map the response ---------------------------------------------
    match status_result {
        Ok((status, saved_as)) if status.is_success() => Ok(TransferReport {
            outcome: TransferOutcome::Transferred,
            bytes: total_bytes,
            dest_name: saved_as.unwrap_or_else(|| remote_path.to_string()),
        }),
        Ok((status, _)) => {
            Err(ClientError::ServerRejected(status.as_u16()))
        }
        Err(e) => {
            if e.to_string().contains("cancelled") {
                Err(ClientError::IoError("Transfer cancelled".into()))
            } else {
                Err(ClientError::HttpError(e.to_string()))
            }
        }
    }
}

/// [`push_file_with_progress`] without progress or cancellation, for tests.
#[cfg(test)]
pub async fn push_file_to_peer(
    peer_addr: &str,
    local_path: &Path,
    remote_path: &str,
    device_id: &str,
    signing_key: &SigningKey,
) -> Result<TransferReport, ClientError> {
    push_file_with_progress(
        "legacy-push",
        peer_addr,
        local_path,
        remote_path,
        device_id,
        signing_key,
        Arc::new(AtomicBool::new(false)),
        |_| {},
    ).await
}
