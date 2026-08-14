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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

struct MdnsController {
    shutdown_flag: Arc<AtomicBool>,
}

#[cfg_attr(mobile, tauri::mobile)]
pub fn run() {

    let app_data_dir = dirs_next::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("LANclave");
    std::fs::create_dir_all(&app_data_dir).ok();

    // Sandbox is a sub-folder of the data dir so paired_devices.json
    // is never exposed through the file listing endpoint.
    let sandbox_root = app_data_dir.join("Sandbox");
    std::fs::create_dir_all(&sandbox_root).ok();

    // ---- Load or generate our device identity (ed25519 keypair) ----------
    let identity_key =
        pairing::load_or_generate_identity(&app_data_dir).unwrap_or_else(|_| {
            use rand::rngs::OsRng;
            SigningKey::generate(&mut OsRng)
        });

    let device_id = pairing::public_key_b64(&identity_key);

    let mdns_shutdown_flag = discovery::start_mdns_broadcast(&device_id);

    let device_store = Arc::new(std::sync::RwLock::new(
        DeviceStore::load(&app_data_dir).unwrap_or_default(),
    ));

    let server_controller = Arc::new(ServerController::new());

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
            commands::confirm_pairing,
            commands::get_paired_peers,
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
