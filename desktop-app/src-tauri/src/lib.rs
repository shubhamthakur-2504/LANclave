mod client;
mod discovery;
mod file_ops;
mod files;
mod fs_util;
mod pairing;
mod sandbox;
mod server;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

struct MdnsController {
    shutdown_flag: Arc<AtomicBool>,
}

#[cfg_attr(mobile, tauri::mobile)]
pub fn run() {
    let mdns_shutdown_flag = discovery::start_mdns_broadcast();

    tauri::Builder::default()
        .manage(MdnsController {
            shutdown_flag: mdns_shutdown_flag,
        })
        .invoke_handler(tauri::generate_handler![file_ops::list_sandbox_files])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(controller) = window.try_state::<MdnsController>() {
                    controller.shutdown_flag.store(true, Ordering::Relaxed);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
