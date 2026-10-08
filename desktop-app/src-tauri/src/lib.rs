mod client;
mod dedupe;
mod commands;
mod discovery;
mod file_ops;
mod files;
mod fs_util;
mod hash_cache;
mod history;
mod offers;
mod open_file;
mod pairing;
mod presence;
mod range;
mod sandbox;
mod server;
mod settings;
mod transfers;
mod tray;

use commands::CliState;
use ed25519_dalek::SigningKey;
use pairing::DeviceStore;
use server::ServerController;
use std::sync::{Arc, RwLock};
use tauri::Manager;
use settings::load_settings;
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

    let device_store = Arc::new(RwLock::new(
        DeviceStore::load(&app_data_dir).unwrap_or_default(),
    ));

    let server_controller = Arc::new(ServerController::new());
    let history = Arc::new(history::HistoryStore::load(&app_data_dir));
    // Open offers and unfinished downloads from last time (P5).
    let offers = Arc::new(offers::OfferStore::load(&app_data_dir));
    let transfers = Arc::new(transfers::TransferManager::load(settings.clone(), history.clone(), &app_data_dir));
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
        // First: a second launch while we sit in the tray must not start
        // another copy (it could not bind the server port). It reopens this
        // one's window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(CliState {
            app_data_dir,
            settings,
            identity_key,
            device_id,
            device_store,
            server_controller,
            presence,
            history: history.clone(),
            offers: offers.clone(),
        })
        .manage(offers.clone())
        .manage(transfers.clone())
        .manage(commands::PendingPairing::default())
        .on_window_event(tray::on_window_event)
        .setup(move |app| {
            tray::install(app)?;

            // Start serving now, not when the page first renders: peers can
            // reach this computer even if the webview never loads, and a
            // tray-launched app has no page to wait for.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<CliState>();
                if let Err(e) = commands::launch_server(&handle, &state).await {
                    eprintln!("[lanclave] server did not start: {e}");
                }
            });

            let mut ctx = presence_ctx;
            ctx.app_handle = Some(app.handle().clone());
            history.set_app_handle(app.handle().clone());
            offers.set_app_handle(app.handle().clone());
            transfers.set_app_handle(app.handle().clone());
            // Downloads that were running or waiting when the app closed
            // pick up where their partial files stop.
            transfers.pump();
            transfers::spawn_cleanup(transfers.clone());
            offers::spawn_sweeper(offers.clone(), history.clone());

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
            open_file::open_sandbox_file,
            commands::import_files,
            // File transfer
            commands::list_peer_files,
            commands::pull_file,
            commands::push_file,
            transfers::list_transfers,
            transfers::cancel_transfer,
            transfers::pause_transfer,
            transfers::resume_transfer,
            transfers::discard_transfer,
            // History
            commands::get_transfer_history,
            // Offers
            offers::send_files,
            offers::send_paths,
            offers::cancel_offer,
            offers::pause_offer,
            offers::list_offers,
            offers::accept_offer,
            offers::decline_offer,
            commands::clear_transfer_history,
            // Pairing
            commands::initiate_pairing,
            commands::confirm_pairing,
            commands::get_paired_peers,
            commands::set_auto_accept,
            commands::cancel_pairing,
            commands::take_pairing_request,
            commands::unpair_peer,
            // Settings
            commands::get_device_id,
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
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                // No code: the last window went away -- released while
                // hidden in the tray (see `tray.rs`). Keep serving; only
                // the tray's Quit ends the app.
                if code.is_none() {
                    api.prevent_exit();
                    return;
                }
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

/// Compact byte size for messages: 812 B, 4.2 KB, 12.9 MB, 1.3 GB.
pub(crate) fn fmt_bytes(n: u64) -> String {
    const UNITS: [(u64, &str); 3] = [(1_000_000_000, "GB"), (1_000_000, "MB"), (1_000, "KB")];
    for (size, unit) in UNITS {
        if n >= size {
            return format!("{:.1} {unit}", n as f64 / size as f64);
        }
    }
    format!("{n} B")
}
