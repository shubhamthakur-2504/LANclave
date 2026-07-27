//! # Tauri command bridge
//!
//! This is the **only** layer the React frontend talks to.  Every Tauri
//! command below is a thin wrapper that extracts shared state, calls into
//! the backend modules (sandbox, server, client, pairing), and converts
//! internal error types (`ClientError`, `PairingError`, `ServerError`,
//! `SandboxError`) into plain `String`s via their `Display` impl.
//!
//! No React code should ever import or know about any backend error type
//! directly.  If a command fails, the UI receives a human-readable error
//! string — nothing more.

use crate::client;
use crate::discovery;
use crate::pairing::{AuthState, DeviceStore};
use crate::sandbox;
use crate::server::{AppState, ServerController};
use base64::Engine;
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::RwLock;
use tauri::State;

static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .expect("valid reqwest client config")
});

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

pub struct CliState {
    pub sandbox_root: PathBuf,
    pub identity_key: SigningKey,
    pub device_id: String,
    pub device_store: Arc<RwLock<DeviceStore>>,
    pub server_controller: Arc<ServerController>,
}

// ---------------------------------------------------------------------------
// Serializable types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct PeerInfo {
    pub addr: String,
    pub device_id: String,
    pub paired: bool,
}

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub size: u64,
    pub is_directory: bool,
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_server(state: State<'_, CliState>) -> Result<(), String> {
    // Drop the read guard BEFORE any .await to satisfy Send bounds.
    let cloned = state
        .device_store
        .read()
        .map_err(|e| e.to_string())?
        .clone();
    // Guard is dropped here — safe to await below.

    let app_state = Arc::new(AppState {
        sandbox_root: state.sandbox_root.clone(),
        device_id: state.device_id.clone(),
        auth: Arc::new(AuthState {
            store: std::sync::RwLock::new(cloned),
            enabled: true,
        }),
    });

    state
        .server_controller
        .start(app_state, "0.0.0.0:8377")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_server(state: State<'_, CliState>) -> Result<(), String> {
    state
        .server_controller
        .stop()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn is_server_running(state: State<'_, CliState>) -> bool {
    state.server_controller.is_running()
}

// ---------------------------------------------------------------------------
// Peer discovery
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn discover_peers(state: State<'_, CliState>) -> Result<Vec<PeerInfo>, String> {
    let raw = discovery::browse_peers(2).await?;

    let store = state.device_store.read().map_err(|e| e.to_string())?;

    let peers: Vec<PeerInfo> = raw
        .into_iter()
        .filter(|(_, device_id)| device_id != &state.device_id)
        .map(|(addr, device_id)| PeerInfo {
            paired: store.is_paired(&device_id),
            addr,
            device_id,
        })
        .collect();

    Ok(peers)
}

// ---------------------------------------------------------------------------
// File operations against a remote peer
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_peer_files(
    state: State<'_, CliState>,
    peer_addr: String,
) -> Result<Vec<FileEntry>, String> {
    let url = format!("http://{peer_addr}/api/sandbox/files");

    let (ts, sig) = crate::pairing::sign_request(&state.identity_key, &state.device_id);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let response = CLIENT
        .get(&url)
        .header(crate::pairing::HEADER_DEVICE_ID, &state.device_id)
        .header(crate::pairing::HEADER_TIMESTAMP, ts.to_string())
        .header(crate::pairing::HEADER_SIGNATURE, &sig_b64)
        .send()
        .await
        .map_err(|e| format!("connection to peer failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("peer returned HTTP {}", response.status()));
    }

    let entries: Vec<RemoteFileEntry> = response
        .json()
        .await
        .map_err(|e| format!("failed to parse peer response: {e}"))?;

    Ok(entries
        .into_iter()
        .map(|e| FileEntry {
            name: e.name,
            size: e.size,
            is_directory: e.is_directory,
        })
        .collect())
}

#[derive(Deserialize)]
struct RemoteFileEntry {
    name: String,
    size: u64,
    is_directory: bool,
}

#[tauri::command]
pub async fn pull_file(
    state: State<'_, CliState>,
    peer_addr: String,
    remote_path: String,
    local_filename: String,
) -> Result<(), String> {
    let safe_path = sandbox::verify_sandboxed_path(&state.sandbox_root, &local_filename)
        .map_err(|e| format!("invalid save path: {e}"))?;

    client::pull_file_from_peer(
        &peer_addr,
        &remote_path,
        &safe_path,
        &state.device_id,
        &state.identity_key,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn push_file(
    state: State<'_, CliState>,
    peer_addr: String,
    local_relative_path: String,
    remote_path: String,
) -> Result<(), String> {
    let safe_local_path =
        sandbox::verify_sandboxed_path(&state.sandbox_root, &local_relative_path)
            .map_err(|e| format!("invalid source path: {e}"))?;

    client::push_file_to_peer(
        &peer_addr,
        &safe_local_path,
        &remote_path,
        &state.device_id,
        &state.identity_key,
    )
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn initiate_pairing(
    state: State<'_, CliState>,
    peer_addr: String,
    peer_device_id: String,
) -> Result<String, String> {
    // Decode the peer's device_id (base64 public key) to get their
    // ed25519 verifying key.
    let peer_key = crate::pairing::public_key_from_b64(&peer_device_id)
        .map_err(|e| format!("invalid peer key: {e}"))?;

    // Compute the 6-digit fingerprint from both public keys.
    let fingerprint = crate::pairing::compute_pairing_fingerprint(
        &state.identity_key.verifying_key(),
        &peer_key,
    );

    Ok(fingerprint)
}

#[tauri::command]
pub async fn confirm_pairing(
    state: State<'_, CliState>,
    peer_addr: String,
    peer_device_id: String,
) -> Result<(), String> {
    // Decode the peer's public key.
    let peer_key = crate::pairing::public_key_from_b64(&peer_device_id)
        .map_err(|e| format!("invalid peer key: {e}"))?;

    // Build a pairing session and commit it to the store.
    let session = crate::pairing::PairingSession {
        peer_device_id: peer_device_id.clone(),
        peer_public_key: peer_key,
    };

    let mut store = state.device_store.write().map_err(|e| e.to_string())?;
    crate::pairing::confirm_pairing(session, &mut store, &state.sandbox_root)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn get_paired_peers(
    state: State<'_, CliState>,
) -> Result<Vec<crate::pairing::PairedDevice>, String> {
    let store = state.device_store.read().map_err(|e| e.to_string())?;
    Ok(store.devices.values().cloned().collect())
}
