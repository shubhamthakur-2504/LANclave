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
use tauri::{Manager, State};

static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .expect("valid reqwest client config")
});

use crate::settings::{AppSettings, save_settings};

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

pub struct CliState {
    pub app_data_dir: PathBuf,
    pub sandbox_root: PathBuf,
    pub settings: Arc<RwLock<AppSettings>>,
    pub identity_key: SigningKey,
    pub device_id: String,
    pub device_store: Arc<RwLock<DeviceStore>>,
    pub server_controller: Arc<ServerController>,
    pub presence: Arc<crate::presence::PresenceStore>,
}

pub enum CancelHandle {
    Pull(tokio::sync::oneshot::Sender<()>),
    Push(std::sync::Arc<std::sync::atomic::AtomicBool>),
}

#[derive(Default)]
pub struct TransferState {
    pub cancellations: RwLock<std::collections::HashMap<String, CancelHandle>>,
}

// ---------------------------------------------------------------------------
// Serializable types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct PeerInfo {
    pub addr: String,
    pub device_id: String,
    pub device_name: Option<String>,
    /// "laptop" | "phone" | ... as reported by the peer over `/health`.
    pub device_type: Option<String>,
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
    let app_state = Arc::new(AppState {
        settings: state.settings.clone(),
        device_id: state.device_id.clone(),
        identity_key: state.identity_key.clone(),
        app_handle: Some(app),
        presence: state.presence.clone(),
        auth: Arc::new(AuthState {
            store: state.device_store.clone(),
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

    // Build a map of live device_id -> peer for quick lookup
    let mut live_map: std::collections::HashMap<String, crate::discovery::DiscoveredPeer> = live
        .into_iter()
        .filter(|p| p.device_id != state.device_id)
        .map(|p| (p.device_id.clone(), p))
        .collect();

    // Start with all stored paired peers (they always appear in the list)
    let mut peers: Vec<PeerInfo> = store
        .devices
        .values()
        .filter(|d| d.device_id != state.device_id)
        .map(|d| {
            // Use live details if we found them, otherwise leave addr empty
            // (the peer is offline).
            let live = live_map.remove(&d.device_id);
            PeerInfo {
                addr: live.as_ref().map(|p| p.addr.clone()).unwrap_or_default(),
                device_id: d.device_id.clone(),
                device_name: live
                    .as_ref()
                    .map(|p| p.device_name.clone())
                    .filter(|n| !n.is_empty())
                    .or_else(|| d.device_name.clone()),
                device_type: live
                    .as_ref()
                    .and_then(|p| p.device_type.clone())
                    .or_else(|| d.device_type.clone()),
                paired: true,
            }
        })
        .collect();

    // A successful probe is a liveness signal -- record it so the peer shows
    // as online immediately instead of waiting for the next heartbeat.
    for peer in &peers {
        if !peer.addr.is_empty() {
            state.presence.mark_seen(
                &peer.device_id,
                peer.device_name.clone(),
                Some(peer.addr.clone()),
            );
        }
    }

    // Add any live-discovered peers that are NOT already in the paired store
    for (id, p) in live_map {
        peers.push(PeerInfo {
            addr: p.addr,
            device_id: id,
            device_name: Some(p.device_name),
            device_type: p.device_type,
            paired: false,
        });
    }

    drop(store);
    persist_scan_addrs(&state, &peers);

    Ok(peers)
}

/// Write freshly discovered addresses back to the paired store so the next
/// launch can reach these peers without scanning.
fn persist_scan_addrs(state: &State<'_, CliState>, peers: &[PeerInfo]) {
    let Ok(mut store) = state.device_store.write() else {
        return;
    };
    let mut dirty = false;
    for peer in peers {
        if peer.addr.is_empty() {
            continue;
        }
        if let Some(dev) = store.devices.get_mut(&peer.device_id) {
            if dev.last_addr.as_ref() != Some(&peer.addr) {
                dev.last_addr = Some(peer.addr.clone());
                dirty = true;
            }
            if peer.device_type.is_some() && dev.device_type != peer.device_type {
                dev.device_type = peer.device_type.clone();
                dirty = true;
            }
        }
    }
    if dirty {
        let _ = store.save(&state.app_data_dir);
    }
}

/// Reveal a sandbox file in the OS file manager.
///
/// Gives a completed transfer somewhere to go (U2.2). The name is resolved
/// inside the sandbox, so it cannot be used to point at arbitrary paths.
#[tauri::command]
pub fn reveal_in_sandbox(
    app: tauri::AppHandle,
    state: State<'_, CliState>,
    file_name: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let sandbox_root = {
        let settings = state.settings.read().map_err(|e| e.to_string())?;
        PathBuf::from(&settings.sandbox_path)
    };
    let path = crate::sandbox::verify_sandboxed_path(&sandbox_root, &file_name)
        .map_err(|_| "that file is not inside the sandbox".to_string())?;

    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

/// Paired peers with their current presence, read straight from the in-memory
/// table. Costs nothing: no mDNS, no probes, no subnet sweep.
#[tauri::command]
pub fn list_peers(state: State<'_, CliState>) -> Result<Vec<PeerInfo>, String> {
    let store = state.device_store.read().map_err(|e| e.to_string())?;

    Ok(store
        .devices
        .values()
        .filter(|d| d.device_id != state.device_id)
        .map(|d| {
            let pres = state.presence.get(&d.device_id);
            let online = pres.as_ref().map(|p| p.online).unwrap_or(false);
            let addr = pres
                .as_ref()
                .and_then(|p| p.addr.clone())
                .or_else(|| d.last_addr.clone())
                .unwrap_or_default();

            PeerInfo {
                // An address is only meaningful while the peer is reachable.
                addr: if online { addr } else { String::new() },
                device_id: d.device_id.clone(),
                device_name: pres
                    .as_ref()
                    .and_then(|p| p.device_name.clone())
                    .or_else(|| d.device_name.clone()),
                device_type: d.device_type.clone(),
                paired: true,
            }
        })
        .collect())
}

/// Re-resolve one peer that has gone quiet, without sweeping the subnet.
///
/// Tries mDNS first, then the last known address. Covers the common hotspot
/// case where a DHCP lease rotated and the stored address went stale.
#[tauri::command]
pub async fn rescan_peer(
    state: State<'_, CliState>,
    device_id: String,
) -> Result<bool, String> {
    let ctx = crate::presence::PresenceContext {
        presence: state.presence.clone(),
        device_store: state.device_store.clone(),
        settings: state.settings.clone(),
        device_id: state.device_id.clone(),
        identity_key: state.identity_key.clone(),
        app_handle: None,
    };

    if let Some(addr) = crate::discovery::resolve_peer_addr(&device_id).await {
        if ctx.hello_one(&device_id, &addr).await {
            return Ok(true);
        }
    }

    let last = state
        .presence
        .addr_of(&device_id)
        .or_else(|| {
            state
                .device_store
                .read()
                .ok()
                .and_then(|s| s.devices.get(&device_id).and_then(|d| d.last_addr.clone()))
        });

    if let Some(addr) = last {
        if ctx.hello_one(&device_id, &addr).await {
            return Ok(true);
        }
    }

    state.presence.mark_offline(&device_id);
    Ok(false)
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
    app: tauri::AppHandle,
    state: State<'_, CliState>,
    peer_addr: String,
    remote_path: String,
    local_filename: String,
) -> Result<String, String> {
    let safe_path = {
        let settings = state.settings.read().map_err(|e| e.to_string())?;
        let sandbox_root = PathBuf::from(&settings.sandbox_path);
        sandbox::verify_sandboxed_path(&sandbox_root, &local_filename)
            .map_err(|e| format!("invalid save path: {e}"))?
    };

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();

    // Store the cancellation sender in the server controller or a new state.
    // Wait, ServerController is for the HTTP server. Let's add a new state for TransferController or just put it in a static Mutex since it's just for cancellation.
    // Actually, we can add a new Managed State: TransferState
    // Let's assume TransferState is passed. If not, we'll need to define it.
    let transfer_state: State<'_, TransferState> = app.state();
    transfer_state.cancellations.write().unwrap().insert(transfer_id.clone(), CancelHandle::Pull(cancel_tx));

    let device_id = state.device_id.clone();
    let identity_key = state.identity_key.clone();
    let transfer_id_clone = transfer_id.clone();

    tokio::spawn(async move {
        let _ = client::pull_file_from_peer(
            app,
            transfer_id_clone,
            &peer_addr,
            &remote_path,
            &safe_path,
            &device_id,
            &identity_key,
            cancel_rx,
        )
        .await;
    });

    Ok(transfer_id)
}

#[tauri::command]
pub fn cancel_transfer(
    transfer_state: State<'_, TransferState>,
    transfer_id: String,
) {
    if let Some(handle) = transfer_state.cancellations.write().unwrap().remove(&transfer_id) {
        match handle {
            CancelHandle::Pull(tx) => {
                let _ = tx.send(());
            }
            CancelHandle::Push(flag) => {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
    }
}

#[tauri::command]
pub async fn push_file(
    app: tauri::AppHandle,
    state: State<'_, CliState>,
    peer_addr: String,
    local_relative_path: String,
    remote_path: String,
) -> Result<String, String> {
    let safe_local_path = {
        let settings = state.settings.read().map_err(|e| e.to_string())?;
        let sandbox_root = PathBuf::from(&settings.sandbox_path);
        sandbox::verify_sandboxed_path(&sandbox_root, &local_relative_path)
            .map_err(|e| format!("invalid source path: {e}"))?
    };

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    let transfer_state: State<'_, TransferState> = app.state();
    transfer_state.cancellations.write().unwrap().insert(transfer_id.clone(), CancelHandle::Push(cancel_flag.clone()));

    let device_id = state.device_id.clone();
    let identity_key = state.identity_key.clone();
    let transfer_id_clone = transfer_id.clone();

    tokio::spawn(async move {
        let _ = crate::client::push::push_file_to_peer_managed(
            app,
            transfer_id_clone,
            &peer_addr,
            &safe_local_path,
            &remote_path,
            &device_id,
            &identity_key,
            cancel_flag,
        )
        .await;
    });

    Ok(transfer_id)
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn initiate_pairing(
    state: State<'_, CliState>,
    _peer_addr: String,
    peer_device_id: String,
    _peer_device_name: Option<String>,
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
    _peer_addr: String,
    peer_device_id: String,
    peer_device_name: Option<String>,
) -> Result<(), String> {
    // Decode the peer's public key.
    let peer_key = crate::pairing::public_key_from_b64(&peer_device_id)
        .map_err(|e| format!("invalid peer key: {e}"))?;

    // Build a pairing session and commit it to the store.
    let session = crate::pairing::PairingSession {
        peer_device_id: peer_device_id.clone(),
        peer_public_key: peer_key,
        peer_device_name,
    };

    let app_data_dir = &state.app_data_dir;
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

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_settings(state: State<'_, CliState>) -> Result<AppSettings, String> {
    let settings = state.settings.read().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, CliState>,
    new_settings: AppSettings,
) -> Result<(), String> {
    save_settings(&state.app_data_dir, &new_settings)?;
    
    // Update active settings
    let mut current = state.settings.write().map_err(|e| e.to_string())?;
    *current = new_settings;
    Ok(())
}

#[tauri::command]
pub async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    
    // Use a oneshot channel to bridge the async block with the callback
    let (tx, rx) = tokio::sync::oneshot::channel();
    
    app.dialog().file().pick_folder(move |folder| {
        let path = folder.map(|f| f.into_path().unwrap().to_string_lossy().to_string());
        let _ = tx.send(path);
    });
    
    rx.await.map_err(|_| "Dialog cancelled".to_string())
}

#[tauri::command]
pub async fn pick_file(app: tauri::AppHandle, state: State<'_, CliState>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    
    let sandbox_root = {
        let settings = state.settings.read().map_err(|e| e.to_string())?;
        PathBuf::from(&settings.sandbox_path)
    };
    let root_clone = sandbox_root.clone();
    
    let (tx, rx) = tokio::sync::oneshot::channel();
    
    app.dialog().file().set_directory(sandbox_root).pick_file(move |file| {
        let path = file.and_then(|f| {
            let p = f.into_path().unwrap();
            // Convert absolute path to relative path inside sandbox
            p.strip_prefix(&root_clone).ok().map(|rel| rel.to_string_lossy().to_string().replace("\\", "/"))
        });
        let _ = tx.send(path);
    });
    
    rx.await.map_err(|_| "Dialog cancelled".to_string())
}
