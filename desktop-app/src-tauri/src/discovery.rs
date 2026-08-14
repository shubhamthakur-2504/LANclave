use mdns_sd::{DaemonEvent, ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use serde::Deserialize;

#[derive(Deserialize)]
struct HealthResponse {
    app: String,
    device_id: String,
}

const SERVICE_TYPE: &str = "_lanclave-portal._tcp.local.";

/// Starts an mDNS service broadcaster on a background thread and keeps it
/// alive for the lifetime of the process (or until the returned shutdown
/// flag is set).
///
/// The service advertises our `device_id` in the TXT record so that peers
/// who browse the network can pair with us by identifier.
pub fn start_mdns_broadcast(device_id: &str) -> Arc<AtomicBool> {
    let shutdown = Arc::new(AtomicBool::new(false));

    thread::spawn({
        let shutdown = shutdown.clone();
        let device_id = device_id.to_owned();
        move || {
            let mdns = match ServiceDaemon::new() {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("[lanclave] Failed to create mDNS daemon: {e}");
                    return;
                }
            };

            let mut props = HashMap::new();
            props.insert("version".to_string(), "1.0.0".to_string());
            props.insert("node_type".to_string(), "desktop".to_string());
            props.insert("device_id".to_string(), device_id);

            let service_info = match ServiceInfo::new(
                SERVICE_TYPE,
                "Desktop-Node-Workstation",
                "lanclave-desktop.local.",
                "",
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

            eprintln!("[lanclave] mDNS broadcast active: {SERVICE_TYPE} port 8377");

            let error_monitor = mdns.monitor().expect("valid monitor receiver");
            thread::spawn(move || {
                while let Ok(event) = error_monitor.recv() {
                    if let DaemonEvent::Error(e) = event {
                        eprintln!("[lanclave] mDNS daemon error: {e}");
                    }
                }
            });

            while !shutdown.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_secs(5));
            }

            let _ = mdns.unregister(SERVICE_TYPE);
            eprintln!("[lanclave] mDNS broadcast shutting down.");
        }
    });

    shutdown
}

/// Browse the LAN for other LANclave peers advertising
/// `_lanclave-portal._tcp.local.`.
///
/// Returns a list of `(socket_addr, device_id)` tuples, where:
/// - `socket_addr` is `"IP:PORT"` suitable for use in HTTP requests.
/// - `device_id` is the base64-encoded ed25519 public key extracted from
///   the peer's mDNS TXT record.
///
/// The function blocks for up to `timeout_secs` seconds, collecting
/// `ServiceResolved` events.  Pass `0` for a single quick scan.
pub async fn browse_peers(timeout_secs: u64) -> Result<Vec<(String, String)>, String> {
    let mdns = ServiceDaemon::new().map_err(|e| format!("mDNS daemon: {e}"))?;

    let receiver = mdns
        .browse(SERVICE_TYPE)
        .map_err(|e| format!("mDNS browse: {e}"))?;

    // Allow a short window for mDNS responses — subnet probe runs concurrently.
    let deadline = if timeout_secs == 0 {
        Duration::from_millis(500)
    } else {
        Duration::from_millis(timeout_secs * 1000)
    };
    let start = std::time::Instant::now();
    let mut peers: Vec<(String, String)> = Vec::new();

    loop {
        let remaining = deadline.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                if let Some(entry) = parse_peer(&*info) {
                    if !peers.iter().any(|(_, id)| id == &entry.1) {
                        peers.push(entry);
                    }
                }
            }
            _ => {} // timeout / channel closed
        }
    }

    // Active Subnet & Gateway Probe Fallback
    // Because hotspots drop mDNS, we query the gateway instantly, then scan the local /24 subnet.
    let mut probe_tasks = Vec::new();

    if let Ok(gateway) = default_net::get_default_gateway() {
        let gw_ip = gateway.ip_addr.to_string();
        probe_tasks.push(tokio::spawn(async move {
            probe_ip(&gw_ip).await
        }));
    }

    if let Ok(interface) = default_net::get_default_interface() {
        if let Some(ipv4) = interface.ipv4.first() {
            let ip: Ipv4Addr = ipv4.addr;
            if ipv4.prefix_len == 24 {
                let octets = ip.octets();
                for i in 1..=254 {
                    let test_ip = format!("{}.{}.{}.{}", octets[0], octets[1], octets[2], i);
                    if test_ip != ip.to_string() {
                        probe_tasks.push(tokio::spawn(async move {
                            probe_ip(&test_ip).await
                        }));
                    }
                }
            }
        }
    }

    // Await all probe tasks and merge with mDNS results
    for task in probe_tasks {
        if let Ok(Some(peer)) = task.await {
            if !peers.iter().any(|(_, id)| id == &peer.1) {
                peers.push(peer);
            }
        }
    }

    Ok(peers)
}

async fn probe_ip(ip: &str) -> Option<(String, String)> {
    let url = format!("http://{ip}:8377/health");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .ok()?;

    let res = client.get(&url).send().await.ok()?;
    if res.status().is_success() || res.status() == 401 {
        if let Ok(body) = res.json::<HealthResponse>().await {
            if body.app == "lanclave" {
                let addr = format!("{ip}:8377");
                return Some((addr, body.device_id));
            }
        }
    }
    None
}

/// Extract `(socket_addr, device_id)` from a resolved mDNS service.
fn parse_peer(info: &mdns_sd::ResolvedService) -> Option<(String, String)> {
    // Build the socket address from the first resolved IP + port.
    let ip = info.get_addresses().iter().next()?;
    let addr = format!("{ip}:{}", info.get_port());

    // Device ID is stored in the TXT properties.
    let device_id = info.get_property_val_str("device_id")?.to_owned();

    Some((addr, device_id))
}
