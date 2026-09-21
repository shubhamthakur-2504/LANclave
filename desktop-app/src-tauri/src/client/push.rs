use super::{transport, ClientError};
use ed25519_dalek::SigningKey;
use std::path::Path;
use tokio::io::BufReader;
use tokio_util::io::ReaderStream;
use tokio::sync::oneshot;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use crate::client::pull::TransferProgressEvent;

/// Push (upload) a local file to a peer's sandbox at the given
/// `remote_path`, reporting progress through `on_event`.
pub(crate) async fn push_file_with_progress(
    transfer_id: &str,
    peer_addr: &str,
    local_path: &Path,
    remote_path: &str,
    device_id: &str,
    signing_key: &SigningKey,
    cancel_flag: Arc<AtomicBool>,
    mut on_event: impl FnMut(&TransferProgressEvent) + Send + 'static,
) -> Result<(), ClientError> {
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
    let status_result = transport::put_stream(peer_addr, remote_path, body, device_id, signing_key).await;

    // ---- 4. Map the response ---------------------------------------------
    match status_result {
        Ok(status) if status.is_success() => {
            Ok(())
        }
        Ok(status) => {
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

pub async fn push_file_to_peer(
    peer_addr: &str,
    local_path: &Path,
    remote_path: &str,
    device_id: &str,
    signing_key: &SigningKey,
) -> Result<(), ClientError> {
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

/// Tauri-facing wrapper around [`push_file_with_progress`] that re-emits progress
/// events as Tauri events for the React frontend.
pub async fn push_file_to_peer_managed(
    app: tauri::AppHandle,
    transfer_id: String,
    peer_addr: &str,
    local_path: &Path,
    remote_path: &str,
    device_id: &str,
    signing_key: &SigningKey,
    cancel_flag: Arc<AtomicBool>,
) -> Result<(), ClientError> {
    use tauri::Emitter;

    let app_clone = app.clone();
    let res = push_file_with_progress(
        &transfer_id,
        peer_addr,
        local_path,
        remote_path,
        device_id,
        signing_key,
        cancel_flag,
        move |event| {
            let event_name = match event.status.as_str() {
                "in_progress" => "transfer-progress",
                "completed" => "transfer-completed",
                _ => "transfer-failed",
            };
            let _ = app_clone.emit(event_name, (*event).clone());
        },
    )
    .await;
    
    // Ensure final event is sent
    let final_status = if res.is_ok() { "completed" } else { "failed" };
    let metadata = tokio::fs::metadata(local_path).await;
    let total_bytes = metadata.map(|m| m.len()).unwrap_or(0);
    
    let _ = app.emit(
        match final_status {
            "completed" => "transfer-completed",
            _ => "transfer-failed",
        },
        TransferProgressEvent {
            id: transfer_id,
            bytes_transferred: if res.is_ok() { total_bytes } else { 0 },
            total_bytes,
            status: final_status.to_string(),
            message: res.as_ref().err().map(|e| e.to_string()),
        }
    );
    
    res
}
