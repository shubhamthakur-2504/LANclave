mod client;
mod dedupe;
mod commands;
mod discovery;
mod file_ops;
mod files;
mod fs_util;
mod pairing;
mod presence;
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
    let presence = Arc::new(presence::PresenceStore::new());

    // Seed presence with the addresses we knew last run so paired peers can be
    // reached without a subnet sweep.
    if let Ok(store) = device_store.read() {
        for dev in store.devices.values() {
            if let Some(addr) = &dev.last_addr {
                presence.set_addr(&dev.device_id, addr.clone());
            }
        }
    }

    let presence_ctx = presence::PresenceContext {
        presence: presence.clone(),
        device_store: device_store.clone(),
        settings: settings.clone(),
        device_id: device_id.clone(),
        identity_key: identity_key.clone(),
        app_handle: None,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CliState {
            app_data_dir,
            sandbox_root,
            settings,
            identity_key,
            device_id,
            device_store,
            server_controller,
            presence,
        })
        .manage(commands::TransferState::default())
        .setup(move |app| {
            let mut ctx = presence_ctx;
            ctx.app_handle = Some(app.handle().clone());

            // Announce ourselves to every paired peer, then poll them on a
            // timer. One request per peer -- not a subnet sweep.
            let hello_ctx = ctx.clone();
            tauri::async_runtime::spawn(async move {
                hello_ctx.announce_hello().await;
            });
            ctx.clone().spawn_heartbeat();

            app.manage(ctx);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Server lifecycle
            commands::start_server,
            commands::stop_server,
            commands::is_server_running,
            // Peer discovery
            commands::discover_peers,
            commands::list_peers,
            commands::rescan_peer,
            commands::reveal_in_sandbox,
            commands::import_files,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Best effort. A crash or a kill sends nothing, which is
                // exactly why presence is TTL-based rather than bye-based.
                if let Some(ctx) = app.try_state::<presence::PresenceContext>() {
                    let ctx = ctx.inner().clone();
                    tauri::async_runtime::block_on(async move {
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(2),
                            ctx.announce_bye(),
                        )
                        .await;
                    });
                }
            }
        });
}
