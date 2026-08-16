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
}

pub async fn pull_file_from_peer(
    app: tauri::AppHandle,
    transfer_id: String,
    peer_addr: &str,
    remote_path: &str,
    local_save_path: &Path,
    device_id: &str,
    signing_key: &SigningKey,
    mut cancel_rx: oneshot::Receiver<()>,
) -> Result<(), ClientError> {
    use tauri::Emitter;

    // ---- 1. Request the stream from the peer -----------------------------
    let response = transport::get_stream(peer_addr, remote_path, device_id, signing_key).await?;

    // ---- 2. Check the response status before creating a local file -------
    let status = response.status();
    if !status.is_success() {
        let _ = app.emit("transfer-failed", TransferProgressEvent {
            id: transfer_id.clone(),
            bytes_transferred: 0,
            total_bytes: 0,
            status: "failed".to_string(),
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

    let file = tokio_fs::File::create(local_save_path)
        .await
        .map_err(|e| ClientError::IoError(e.to_string()))?;

    let mut guard = crate::fs_util::WriteGuard::new(local_save_path.to_path_buf());

    // ---- 4. Stream the response body to disk in 64 KB chunks -------------
    use futures_util::StreamExt;

    let mut writer = BufWriter::with_capacity(64 * 1024, file);
    let mut stream = response.bytes_stream();
    let mut bytes_transferred: u64 = 0;
    
    // Throttle progress events to ~10 per second
    let mut last_emit = std::time::Instant::now();

    println!("[pull] Starting to write to file: {:?}", local_save_path);
    loop {
        tokio::select! {
            _ = &mut cancel_rx => {
                // Cancelled!
                println!("[pull] Cancellation received for {}", transfer_id);
                let _ = app.emit("transfer-failed", TransferProgressEvent {
                    id: transfer_id,
                    bytes_transferred,
                    total_bytes,
                    status: "failed".to_string(),
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
                            let _ = app.emit("transfer-progress", TransferProgressEvent {
                                id: transfer_id.clone(),
                                bytes_transferred,
                                total_bytes,
                                status: "in_progress".to_string(),
                            });
                            last_emit = std::time::Instant::now();
                        }
                    }
                    Some(Err(e)) => {
                        println!("[pull] Error reading chunk: {}", e);
                        let _ = app.emit("transfer-failed", TransferProgressEvent {
                            id: transfer_id.clone(),
                            bytes_transferred,
                            total_bytes,
                            status: "failed".to_string(),
                        });
                        return Err(ClientError::HttpError(e.to_string()));
                    }
                    None => {
                        // Done streaming
                        println!("[pull] Download complete for {}.", transfer_id);
                        break;
                    }
                }
            }
        }
    }

    writer
        .flush()
        .await
        .map_err(|e| ClientError::IoError(e.to_string()))?;

    guard.disarm();
    
    let _ = app.emit("transfer-completed", TransferProgressEvent {
        id: transfer_id,
        bytes_transferred,
        total_bytes,
        status: "completed".to_string(),
    });

    Ok(())
}
