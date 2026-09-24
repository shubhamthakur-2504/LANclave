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
    pub settings: Arc<RwLock<AppSettings>>,
    pub identity_key: SigningKey,
    pub device_id: String,
    pub device_store: Arc<RwLock<DeviceStore>>,
    pub server_controller: Arc<ServerController>,
    pub presence: Arc<crate::presence::PresenceStore>,
    pub history: Arc<crate::history::HistoryStore>,
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
    /// Paired here but not on the peer: it rejected the pairing or unpaired
    /// us. Nothing works until it is removed and paired again.
    #[serde(default)]
    pub untrusted: bool,
}

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub size: u64,
    pub is_directory: bool,
    /// Last modified, Unix ms. `None` from peers that predate the field.
    pub modified: Option<u64>,
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_server(
    app: tauri::AppHandle,
    state: State<'_, CliState>,
) -> Result<(), String> {
    launch_server(&app, &state).await.map_err(|e| e.to_string())
}

/// Start the HTTP server and announce the result as `server-status`.
///
/// Called from `setup` at launch, so the server runs whether or not the
/// window's page ever loads, and from the `start_server` command when the
/// user turns it back on.
pub async fn launch_server(
    app: &tauri::AppHandle,
    state: &CliState,
) -> Result<(), crate::server::ServerError> {
    let app_state = Arc::new(AppState {
        settings: state.settings.clone(),
        device_id: state.device_id.clone(),
        identity_key: state.identity_key.clone(),
        app_handle: Some(app.clone()),
        presence: state.presence.clone(),
        history: state.history.clone(),
        auth: Arc::new(AuthState {
            store: state.device_store.clone(),
            enabled: true,
            data_dir: Some(state.app_data_dir.clone()),
        }),
    });

    let result = state
        .server_controller
        .start(app_state, "0.0.0.0:8377")
        .await;
    emit_server_status(app, state.server_controller.is_running());
    result
}

/// Tell the UI whether the server is up. The page may load before or after
/// the launch finishes, so it reads `is_server_running` once and then
/// follows this event.
fn emit_server_status(app: &tauri::AppHandle, running: bool) {
    use tauri::Emitter;
    let _ = app.emit("server-status", running);
}

#[tauri::command]
pub async fn stop_server(app: tauri::AppHandle, state: State<'_, CliState>) -> Result<(), String> {
    let result = state.server_controller.stop().map_err(|e| e.to_string());
    emit_server_status(&app, state.server_controller.is_running());
    result
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
                untrusted: state.presence.is_untrusted(&d.device_id),
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
            untrusted: false,
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

/// Copy files from anywhere on disk into the sandbox.
///
/// Backs drag-and-drop (U3.1): `pick_file` only accepts paths that are
/// already inside the sandbox, so a dropped file needs copying in first.
/// Returns the sandbox-relative names of everything that landed.
#[tauri::command]
pub async fn import_files(
    state: State<'_, CliState>,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    let sandbox_root = {
        let settings = state.settings.read().map_err(|e| e.to_string())?;
        PathBuf::from(&settings.sandbox_path)
    };
    tokio::fs::create_dir_all(&sandbox_root)
        .await
        .map_err(|e| e.to_string())?;

    let mut imported = Vec::new();

    for raw in paths {
        let src = PathBuf::from(&raw);

        // Directories would need a recursive copy and a size warning; out of
        // scope for a drop target, and silently skipping is better than
        // half-copying a tree.
        match tokio::fs::metadata(&src).await {
            Ok(m) if m.is_file() => {}
            _ => continue,
        }

        let Some(file_name) = src.file_name().and_then(|n| n.to_str()) else {
            continue;
        };

        let dest_name = unique_sandbox_name(&sandbox_root, file_name);
        let dest = sandbox_root.join(&dest_name);

        // Copying a file onto itself would truncate it.
        if src == dest {
            imported.push(dest_name);
            continue;
        }

        tokio::fs::copy(&src, &dest)
            .await
            .map_err(|e| format!("could not copy {file_name}: {e}"))?;
        imported.push(dest_name);
    }

    Ok(imported)
}

/// Find a free name, turning `notes.txt` into `notes (1).txt` on collision so
/// a drop never silently overwrites something already in the sandbox. Same
/// scheme as transfers use (`fs_util::create_unique`).
fn unique_sandbox_name(root: &std::path::Path, file_name: &str) -> String {
    (0..1000)
        .map(|n| crate::fs_util::numbered_name(file_name, n))
        .find(|candidate| !root.join(candidate).exists())
        .unwrap_or_else(|| file_name.to_string())
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
                untrusted: pres.as_ref().map(|p| p.untrusted).unwrap_or(false),
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
                        modified: e.modified,
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
    #[serde(default)]
    modified: Option<u64>,
}

#[tauri::command]
pub async fn pull_file(
    app: tauri::AppHandle,
    state: State<'_, CliState>,
    peer_addr: String,
    remote_path: String,
    local_filename: String,
    // Size from the peer's listing. Lets an existing local file of a
    // different size rule out a duplicate without asking the peer.
    remote_size: Option<u64>,
    // Who the peer is, for the history log. Looked up by address if absent.
    peer_id: Option<String>,
    peer_name: Option<String>,
) -> Result<String, String> {
    let safe_path = {
        let settings = state.settings.read().map_err(|e| e.to_string())?;
        let sandbox_root = PathBuf::from(&settings.sandbox_path);
        sandbox::verify_sandboxed_path(&sandbox_root, &local_filename)
            .map_err(|e| format!("invalid save path: {e}"))?
    };

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();

    let transfer_state: State<'_, TransferState> = app.state();
    transfer_state.cancellations.write().unwrap().insert(transfer_id.clone(), CancelHandle::Pull(cancel_tx));

    let device_id = state.device_id.clone();
    let identity_key = state.identity_key.clone();
    let transfer_id_clone = transfer_id.clone();
    let (peer_id, peer_name) = peer_identity(&state, &peer_addr, peer_id, peer_name);
    let history = state.history.clone();

    tokio::spawn(async move {
        let result = client::pull_file_from_peer(
            app.clone(),
            transfer_id_clone.clone(),
            &peer_addr,
            &remote_path,
            &safe_path,
            remote_size,
            &device_id,
            &identity_key,
            cancel_rx,
        )
        .await;

        forget_transfer(&app, &transfer_id_clone);
        history.record(crate::history::entry_for_local_transfer(
            crate::history::Direction::Received,
            peer_id,
            peer_name,
            remote_path,
            &result,
        ));
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
    // Who the peer is, for the history log. Looked up by address if absent.
    peer_id: Option<String>,
    peer_name: Option<String>,
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
    let (peer_id, peer_name) = peer_identity(&state, &peer_addr, peer_id, peer_name);
    let history = state.history.clone();

    tokio::spawn(async move {
        let result = crate::client::push::push_file_to_peer_managed(
            app.clone(),
            transfer_id_clone.clone(),
            &peer_addr,
            &safe_local_path,
            &remote_path,
            &device_id,
            &identity_key,
            cancel_flag,
        )
        .await;

        forget_transfer(&app, &transfer_id_clone);
        history.record(crate::history::entry_for_local_transfer(
            crate::history::Direction::Sent,
            peer_id,
            peer_name,
            remote_path,
            &result,
        ));
    });

    Ok(transfer_id)
}

/// Drop a finished transfer's cancel handle; nothing is left to cancel.
fn forget_transfer(app: &tauri::AppHandle, transfer_id: &str) {
    if let Some(ts) = app.try_state::<TransferState>() {
        ts.cancellations.write().unwrap().remove(transfer_id);
    }
}

/// Resolve the peer at `addr` to a device id and display name for the
/// history log. Prefers what the UI passed; otherwise matches the address
/// against presence and the paired store.
fn peer_identity(
    state: &State<'_, CliState>,
    addr: &str,
    id: Option<String>,
    name: Option<String>,
) -> (String, Option<String>) {
    let store = state.device_store.read().ok();
    let id = id.filter(|i| !i.is_empty()).or_else(|| {
        store.as_ref().and_then(|s| {
            s.devices
                .values()
                .find(|d| {
                    state.presence.addr_of(&d.device_id).as_deref() == Some(addr)
                        || d.last_addr.as_deref() == Some(addr)
                })
                .map(|d| d.device_id.clone())
        })
    });
    let name = name.or_else(|| {
        let id = id.as_ref()?;
        store.as_ref()?.devices.get(id)?.device_name.clone()
    });
    (id.unwrap_or_else(|| addr.to_string()), name)
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/// Every transfer from the last 30 days, newest first.
#[tauri::command]
pub fn get_transfer_history(state: State<'_, CliState>) -> Vec<crate::history::HistoryEntry> {
    state.history.list()
}

#[tauri::command]
pub fn clear_transfer_history(state: State<'_, CliState>) {
    state.history.clear();
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn initiate_pairing(
    state: State<'_, CliState>,
    peer_addr: String,
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

    // Ask the peer to open its side of the comparison. Without this, a
    // pairing started here was one-sided: only this computer ever stored
    // anything, and the other device never showed a code to compare.
    if let Some(addr) = normalize_peer_addr(&peer_addr) {
        let display_name = state
            .settings
            .read()
            .map(|s| s.display_name.clone())
            .unwrap_or_default();
        let res = CLIENT
            .post(format!("http://{addr}/api/pairing/request"))
            .timeout(std::time::Duration::from_secs(5))
            .json(&serde_json::json!({
                "device_id": state.device_id,
                "name": display_name,
            }))
            .send()
            .await
            .map_err(|e| format!("could not reach the device: {e}"))?;

        // 404: a peer from before this endpoint. Still show the code, but
        // that device has to start pairing from its own side too.
        if !res.status().is_success() && res.status() != reqwest::StatusCode::NOT_FOUND {
            return Err(format!("the device refused the pairing request (HTTP {})", res.status()));
        }
    }

    Ok(fingerprint)
}

#[tauri::command]
pub async fn confirm_pairing(
    app: tauri::AppHandle,
    state: State<'_, CliState>,
    peer_addr: String,
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

    // Keep the address we paired over. Without it the heartbeat has nowhere
    // to probe, and the new peer shows offline until *its* heartbeat happens
    // to reach us -- up to 20s, longer if that first contact races our
    // confirm and is refused.
    let addr = normalize_peer_addr(&peer_addr);
    {
        let app_data_dir = &state.app_data_dir;
        let mut store = state.device_store.write().map_err(|e| e.to_string())?;
        crate::pairing::confirm_pairing(session, &mut store, app_data_dir)
            .map_err(|e| e.to_string())?;
        if let (Some(addr), Some(dev)) = (&addr, store.devices.get_mut(&peer_device_id)) {
            dev.last_addr = Some(addr.clone());
            let _ = store.save(app_data_dir);
        }
    }

    // Say hello now rather than on the next heartbeat. If the peer has
    // already confirmed, both sides show online within a round trip; if not,
    // its own confirm sends a hello back to us.
    if let Some(addr) = addr {
        state.presence.set_addr(&peer_device_id, addr.clone());
        if let Some(ctx) = app.try_state::<crate::presence::PresenceContext>() {
            let ctx = ctx.inner().clone();
            tauri::async_runtime::spawn(async move {
                if ctx.hello_one(&peer_device_id, &addr).await {
                    ctx.emit_changed();
                }
            });
        }
    }

    Ok(())
}

/// `"10.0.0.5"` -> `"10.0.0.5:8377"`; `None` for an empty or non-address
/// value (the manual pairing path can pass a device id instead).
fn normalize_peer_addr(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let with_port = if raw.contains(':') {
        raw.to_string()
    } else {
        format!("{raw}:{}", crate::presence::SERVER_PORT)
    };
    with_port
        .parse::<std::net::SocketAddr>()
        .ok()
        .map(|a| a.to_string())
}

/// The user rejected the codes: tell the peer, so its dialog closes and --
/// if it already accepted -- it drops the pairing instead of keeping a key
/// the user just flagged as suspicious. Best effort; nothing to undo here,
/// since a rejection never stored anything on this side.
#[tauri::command]
pub async fn cancel_pairing(state: State<'_, CliState>, peer_addr: String) -> Result<(), String> {
    let Some(addr) = normalize_peer_addr(&peer_addr) else {
        return Ok(());
    };
    client::transport::send_pairing_cancel(&addr, &state.device_id, &state.identity_key)
        .await
        .map_err(|e| e.to_string())
}

/// Forget a paired peer here, and ask it to forget us too.
///
/// Removal is local and immediate. Telling the peer is best effort: if it is
/// offline it keeps us until its heartbeat sees our 401s and marks the
/// pairing one-sided, where its user can remove it.
#[tauri::command]
pub async fn unpair_peer(
    app: tauri::AppHandle,
    state: State<'_, CliState>,
    device_id: String,
) -> Result<(), String> {
    let addr = {
        let mut store = state.device_store.write().map_err(|e| e.to_string())?;
        let addr = state
            .presence
            .addr_of(&device_id)
            .or_else(|| store.devices.get(&device_id).and_then(|d| d.last_addr.clone()));
        if store.remove_peer(&device_id) {
            store.save(&state.app_data_dir).map_err(|e| e.to_string())?;
        }
        addr
    };
    state.presence.forget(&device_id);
    if let Some(ctx) = app.try_state::<crate::presence::PresenceContext>() {
        ctx.emit_changed();
    }

    if let Some(addr) = addr {
        let own_id = state.device_id.clone();
        let key = state.identity_key.clone();
        tauri::async_runtime::spawn(async move {
            let _ = client::transport::send_pairing_cancel(&addr, &own_id, &key).await;
        });
    }
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

#[cfg(test)]
mod tests {
    use super::normalize_peer_addr;

    #[test]
    fn peer_addr_gets_default_port_and_rejects_non_addresses() {
        assert_eq!(normalize_peer_addr("10.0.0.5").as_deref(), Some("10.0.0.5:8377"));
        assert_eq!(normalize_peer_addr(" 10.0.0.5:9000 ").as_deref(), Some("10.0.0.5:9000"));
        assert_eq!(normalize_peer_addr(""), None);
        assert_eq!(normalize_peer_addr("Mobile"), None);
        assert_eq!(normalize_peer_addr("dGVzdC1rZXk="), None);
    }
}
