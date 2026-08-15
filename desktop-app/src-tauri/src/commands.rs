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
pub async fn start_server(
    app: tauri::AppHandle,
    state: State<'_, CliState>,
) -> Result<(), String> {
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
        identity_key: state.identity_key.clone(),
        app_handle: Some(app),
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
    // Run live discovery (mDNS + subnet probe)
    let live = discovery::browse_peers(1).await.unwrap_or_default();

    let store = state.device_store.read().map_err(|e| e.to_string())?;

    // Build a map of live device_id -> addr for quick lookup
    let mut live_map: std::collections::HashMap<String, String> = live
        .into_iter()
        .filter(|(_, id)| id != &state.device_id)
        .map(|(addr, id)| (id, addr))
        .collect();

    // Start with all stored paired peers (they always appear in the list)
    let mut peers: Vec<PeerInfo> = store
        .devices
        .values()
        .filter(|d| d.device_id != state.device_id)
        .map(|d| {
            // Use live addr if we found it, otherwise leave addr empty (peer is offline)
            let addr = live_map.remove(&d.device_id).unwrap_or_default();
            PeerInfo {
                addr,
                device_id: d.device_id.clone(),
                paired: true,
            }
        })
        .collect();

    // Add any live-discovered peers that are NOT already in the paired store
    for (id, addr) in live_map {
        peers.push(PeerInfo {
            addr,
            device_id: id,
            paired: false,
        });
    }

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

    // Retry up to 3 times — mobile TCP servers on WiFi can drop connections transiently
    let mut last_err = String::new();
    for attempt in 0..3u32 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500 * (attempt as u64))).await;
        }

        let result = CLIENT
            .get(&url)
            .header(crate::pairing::HEADER_DEVICE_ID, &state.device_id)
            .header(crate::pairing::HEADER_TIMESTAMP, ts.to_string())
            .header(crate::pairing::HEADER_SIGNATURE, &sig_b64)
            .send()
            .await;

        match result {
            Ok(response) => {
                if !response.status().is_success() {
                    last_err = format!("peer returned HTTP {}", response.status());
                    continue;
                }

                let entries: Vec<RemoteFileEntry> = response
                    .json()
                    .await
                    .map_err(|e| format!("failed to parse peer response: {e}"))?;

                return Ok(entries
                    .into_iter()
                    .map(|e| FileEntry {
                        name: e.name,
                        size: e.size,
                        is_directory: e.is_directory,
                    })
                    .collect());
            }
            Err(e) => {
                last_err = format!("connection to peer failed: {e}");
                continue;
            }
        }
    }

    Err(last_err)
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

    // Save to the parent of sandbox_root (which is app_data_dir) where it is loaded from
    let app_data_dir = state.sandbox_root.parent().unwrap();
    let mut store = state.device_store.write().map_err(|e| e.to_string())?;
    crate::pairing::confirm_pairing(session, &mut store, app_data_dir)
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
