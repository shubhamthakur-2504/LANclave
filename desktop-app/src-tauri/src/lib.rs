mod client;
mod commands;
mod discovery;
mod file_ops;
mod files;
mod fs_util;
mod pairing;
mod sandbox;
mod server;
mod settings;

use commands::CliState;
use ed25519_dalek::SigningKey;
use pairing::DeviceStore;
use server::ServerController;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tauri::Manager;
use settings::{AppSettings, load_settings};
#[cfg_attr(mobile, tauri::mobile)]
pub fn run() {
    let app_data_dir = dirs_next::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("LANclave");
    std::fs::create_dir_all(&app_data_dir).ok();

    // The default sandbox root if none is configured
    let default_sandbox_root = app_data_dir.join("Sandbox");
    std::fs::create_dir_all(&default_sandbox_root).ok();

    let settings = load_settings(&app_data_dir, &default_sandbox_root);
    
    // We create the actual active sandbox root from the settings
    let sandbox_root = std::path::PathBuf::from(&settings.sandbox_path);
    std::fs::create_dir_all(&sandbox_root).ok();

    let settings = Arc::new(RwLock::new(settings));

    // ---- Load or generate our device identity (ed25519 keypair) ----------
    let identity_key =
        pairing::load_or_generate_identity(&app_data_dir).unwrap_or_else(|_| {
            use rand::rngs::OsRng;
            SigningKey::generate(&mut OsRng)
        });

    let device_id = pairing::public_key_b64(&identity_key);
    let device_name = settings.read().unwrap().display_name.clone();

    let device_store = Arc::new(RwLock::new(
        DeviceStore::load(&app_data_dir).unwrap_or_default(),
    ));

    let server_controller = Arc::new(ServerController::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(CliState {
            app_data_dir,
            sandbox_root,
            settings,
            identity_key,
            device_id,
            device_store,
            server_controller,
        })
        .manage(commands::TransferState::default())
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
            commands::cancel_transfer,
            // Pairing
            commands::initiate_pairing,
            commands::confirm_pairing,
            commands::get_paired_peers,
            // Settings
            commands::get_settings,
            commands::update_settings,
            commands::pick_directory,
            commands::pick_file,
            // Legacy (migrate to commands eventually)
            file_ops::list_sandbox_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
