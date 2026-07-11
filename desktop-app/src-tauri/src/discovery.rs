use mdns_sd::{DaemonEvent, ServiceDaemon, ServiceInfo};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Starts an mDNS service broadcaster on a background thread and keeps it alive
/// for the lifetime of the process (or until the returned shutdown flag is set).
///
/// The service is registered as `_lanclave-portal._tcp.local.` on port 8377
/// so that LANclave peers (mobile, other desktops) can discover this node
/// without any manual IP configuration.
pub fn start_mdns_broadcast() -> Arc<AtomicBool> {
    let shutdown = Arc::new(AtomicBool::new(false));

    thread::spawn({
        let shutdown = shutdown.clone();
        move || {
            // 1. Initialise the mDNS service daemon
            let mdns = match ServiceDaemon::new() {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("[lanclave] Failed to create mDNS daemon: {e}");
                    return;
                }
            };

            // 2. Build the service properties
            let mut props = HashMap::new();
            props.insert("version".to_string(), "1.0.0".to_string());
            props.insert("node_type".to_string(), "desktop".to_string());

            // 3. Construct and register the service info.
            //    Pass an empty IP string so the daemon auto-resolves addresses.
            let service_info = match ServiceInfo::new(
                "_lanclave-portal._tcp.local.",
                "Desktop-Node-Workstation",
                "lanclave-desktop.local.",
                "", // auto-detect IP
                8377u16,
                props,
            ) {
                Ok(info) => info,
                Err(e) => {
                    eprintln!("[lanclave] Failed to build ServiceInfo: {e}");
                    return;
                }
            }
            .enable_addr_auto();

            if let Err(e) = mdns.register(service_info) {
                eprintln!("[lanclave] Failed to register mDNS service: {e}");
                return;
            }

            eprintln!(
                "[lanclave] mDNS broadcast active: _lanclave-portal._tcp.local. port 8377"
            );

            // 4. Spawn a companion thread that listens for daemon errors
            let error_monitor = mdns.monitor().expect("valid monitor receiver");
            thread::spawn(move || {
                while let Ok(event) = error_monitor.recv() {
                    if let DaemonEvent::Error(e) = event {
                        eprintln!("[lanclave] mDNS daemon error: {e}");
                    }
                }
            });

            // 5. Keep the daemon alive indefinitely until shutdown is requested
            while !shutdown.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_secs(5));
            }

            let _ = mdns.unregister("_lanclave-portal._tcp.local.");
            eprintln!("[lanclave] mDNS broadcast shutting down.");
        }
    });

    shutdown
}
