mod client;
mod commands;
mod discovery;
mod file_ops;
mod files;
mod fs_util;
mod pairing;
mod sandbox;
mod server;

use commands::CliState;
use ed25519_dalek::SigningKey;
use pairing::DeviceStore;
use server::ServerController;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

struct MdnsController {
    shutdown_flag: Arc<AtomicBool>,
}

#[cfg_attr(mobile, tauri::mobile)]
pub fn run() {

    let app_data_dir = std::path::Path::new(".");
    let identity_key =
        pairing::load_or_generate_identity(app_data_dir).unwrap_or_else(|_| {
            // Fallback: generate an ephemeral key if file I/O fails.
            use rand::rngs::OsRng;
            SigningKey::generate(&mut OsRng)
        });

    let device_id = pairing::public_key_b64(&identity_key);

    let mdns_shutdown_flag = discovery::start_mdns_broadcast(&device_id);

    // ---- Load or generate our device identity (ed25519 keypair) ----------
    // The app data dir is where Tauri stores config; we use
    // app.path().app_data_dir() at runtime, but for startup we need a path.
    // We hardcode a sensible default; the user can configure it via the UI.
    
    let device_store = Arc::new(std::sync::RwLock::new(
        DeviceStore::load(app_data_dir).unwrap_or_default(),
    ));

    // ---- Server lifecycle controller ------------------------------------
    let server_controller = Arc::new(ServerController::new());

    // ---- Sandbox root directory -----------------------------------------
    // TODO: make this configurable via the frontend / settings file.
    let sandbox_root = PathBuf::from("D:\\shubham\\code\\assignment");

    tauri::Builder::default()
        .manage(MdnsController {
            shutdown_flag: mdns_shutdown_flag,
        })
        .manage(CliState {
            sandbox_root,
            identity_key,
            device_id,
            device_store,
            server_controller,
        })
        .invoke_handler(tauri::generate_handler![
            // Server lifecycle
            commands::start_server,
            commands::stop_server,
            commands::is_server_running,
            // Peer discovery
            commands::discover_peers,
            // File transfer
            commands::list_peer_files,
            commands::pull_file,
            commands::push_file,
            // Pairing
            commands::initiate_pairing,
            // Legacy (migrate to commands eventually)
            file_ops::list_sandbox_files,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(controller) = window.try_state::<MdnsController>()
                {
                    controller.shutdown_flag.store(true, Ordering::Relaxed);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
