use mdns_sd::{DaemonEvent, ServiceDaemon, ServiceEvent, ServiceInfo};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::Duration;
use serde::Deserialize;

#[derive(Deserialize)]
struct HealthResponse {
    app: String,
    device_id: String,
    device_name: String,
    #[serde(default)]
    device_type: Option<String>,
}

/// A peer found by mDNS or by probing.
///
/// This replaced a bare `(String, String, String)` tuple: a fourth field made
/// the positional version genuinely hard to read at the call sites.
#[derive(Debug, Clone)]
pub struct DiscoveredPeer {
    /// `ip:port`.
    pub addr: String,
    pub device_id: String,
    pub device_name: String,
    pub device_type: Option<String>,
}

const SERVICE_TYPE: &str = "_lanclave-portal._tcp.local.";

/// Process-wide mDNS daemon.
///
/// `ServiceDaemon` spawns a background thread that owns multicast sockets on
/// every interface, and `mdns-sd` implements no `Drop` for it — the thread
/// only exits on an explicit `shutdown()`. Creating one per call therefore
/// leaked a thread plus its sockets on every invocation, and each leaked
/// daemon kept re-querying the network forever. One shared daemon for the
/// lifetime of the process removes that entire class of leak.
fn shared_daemon() -> Result<&'static ServiceDaemon, String> {
    static DAEMON: OnceLock<Option<ServiceDaemon>> = OnceLock::new();

    DAEMON
        .get_or_init(|| match ServiceDaemon::new() {
            Ok(d) => Some(d),
            Err(e) => {
                eprintln!("[lanclave] Failed to create shared mDNS daemon: {e}");
                None
            }
        })
        .as_ref()
        .ok_or_else(|| "shared mDNS daemon unavailable".to_string())
}

/// A DNS-label-safe tag from a base64 device id: its first 12 alphanumeric
/// characters, lowercased. Stable per device, distinct across devices.
pub fn mdns_tag(device_id: &str) -> String {
    device_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Starts an mDNS service broadcaster on a background thread and keeps it
/// alive for the lifetime of the process (or until the returned shutdown
/// flag is set).
///
/// The service advertises our `device_id` in the TXT record so that peers
/// who browse the network can pair with us by identifier.
pub fn start_mdns_broadcast(device_id: &str, device_name: &str) -> Arc<AtomicBool> {
    let shutdown = Arc::new(AtomicBool::new(false));

    thread::spawn({
        let shutdown = shutdown.clone();
        let device_id = device_id.to_owned();
        let device_name = device_name.to_owned();
        move || {
            let mdns = match shared_daemon() {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("[lanclave] {e}");
                    return;
                }
            };

            let mut props = HashMap::new();
            props.insert("version".to_string(), "1.0.0".to_string());
            props.insert("node_type".to_string(), "desktop".to_string());
            props.insert("device_type".to_string(), crate::presence::DEVICE_TYPE.to_string());
            props.insert("device_id".to_string(), device_id.clone());
            props.insert("device_name".to_string(), device_name);

            // Instance and host names must be unique on the network: with a
            // fixed name, two desktops advertised the same service and host,
            // and mDNS treated them as one device.
            let tag = mdns_tag(&device_id);
            let instance = format!("LANclave-{tag}");
            let host = format!("lanclave-{tag}.local.");

            let service_info = match ServiceInfo::new(
                SERVICE_TYPE,
                &instance,
                &host,
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
pub async fn browse_peers(timeout_secs: u64) -> Result<Vec<DiscoveredPeer>, String> {
    // A full sweep takes many seconds. Without this guard a caller firing on a
    // timer stacked sweeps on top of each other: more overlap meant more socket
    // contention, which made each sweep slower, which caused still more overlap.
    // Callers are expected to keep their previous peer list when this returns Err.
    static SCAN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _scan_guard = match SCAN_LOCK.try_lock() {
        Ok(g) => g,
        Err(_) => return Err("a peer scan is already in progress".to_string()),
    };

    let mdns = shared_daemon()?;

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
    let mut peers: Vec<DiscoveredPeer> = Vec::new();

    loop {
        let remaining = deadline.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                if let Some(entry) = parse_peer(&*info) {
                    if !peers.iter().any(|p| p.device_id == entry.device_id) {
                        peers.push(entry);
                    }
                }
            }
            _ => {} // timeout / channel closed
        }
    }

    // Release this browse so the shared daemon does not accumulate a
    // retransmission schedule for every call we ever made.
    let _ = mdns.stop_browse(SERVICE_TYPE);

    // Active Subnet & Gateway Probe Fallback
    // Because hotspots drop mDNS, we query the gateway instantly, then scan the local /24 subnet.
    let mut probe_tasks = Vec::new();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(600))
        .build()
        .unwrap_or_default();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(10));

    let mut subnets_to_scan = std::collections::HashSet::new();

    if let Ok(gateway) = default_net::get_default_gateway() {
        let gw_ip = gateway.ip_addr.to_string();
        if let std::net::IpAddr::V4(gw_v4) = gateway.ip_addr {
            let oct = gw_v4.octets();
            subnets_to_scan.insert([oct[0], oct[1], oct[2]]);
        }
        let client_clone = client.clone();
        let sem_clone = semaphore.clone();
        probe_tasks.push(tokio::spawn(async move {
            probe_ip(client_clone, &gw_ip, sem_clone).await
        }));
    }

    let interfaces = default_net::get_interfaces();
    for interface in interfaces {
        for ipv4 in interface.ipv4 {
            let ip: Ipv4Addr = ipv4.addr;
            if !ip.is_loopback() && !ip.is_link_local() {
                let oct = ip.octets();
                subnets_to_scan.insert([oct[0], oct[1], oct[2]]);
            }
        }
    }

    for [o0, o1, o2] in subnets_to_scan {
        for i in 1..=254 {
            let test_ip = format!("{o0}.{o1}.{o2}.{i}");
            let client_clone = client.clone();
            let sem_clone = semaphore.clone();
            probe_tasks.push(tokio::spawn(async move {
                probe_ip(client_clone, &test_ip, sem_clone).await
            }));
        }
    }

    // Await all probe tasks and merge with mDNS results
    for task in probe_tasks {
        if let Ok(Some(peer)) = task.await {
            if !peers.iter().any(|p| p.device_id == peer.device_id) {
                peers.push(peer);
            }
        }
    }

    Ok(peers)
}

/// Ask mDNS for one specific peer's current address.
///
/// Used when a heartbeat starts failing: on a phone hotspot a stored address
/// goes stale whenever the DHCP lease rotates, and re-resolving one device is
/// far cheaper than sweeping the subnet again.
pub async fn resolve_peer_addr(device_id: &str) -> Option<String> {
    let mdns = shared_daemon().ok()?;
    let receiver = mdns.browse(SERVICE_TYPE).ok()?;

    let deadline = Duration::from_millis(1500);
    let start = std::time::Instant::now();
    let mut found = None;

    loop {
        let remaining = deadline.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                if let Some(peer) = parse_peer(&*info) {
                    if peer.device_id == device_id {
                        found = Some(peer.addr);
                        break;
                    }
                }
            }
            _ => break,
        }
    }

    let _ = mdns.stop_browse(SERVICE_TYPE);
    found
}

async fn probe_ip(client: reqwest::Client, ip: &str, semaphore: Arc<tokio::sync::Semaphore>) -> Option<DiscoveredPeer> {
    let _permit = semaphore.acquire().await.ok()?;
    let url = format!("http://{ip}:8377/health");
    
    let res = client.get(&url).send().await.ok()?;
    if res.status().is_success() || res.status() == 401 {
        if let Ok(body) = res.json::<HealthResponse>().await {
            if body.app == "lanclave" {
                return Some(DiscoveredPeer {
                    addr: format!("{ip}:8377"),
                    device_id: body.device_id,
                    device_name: body.device_name,
                    device_type: body.device_type,
                });
            }
        }
    }
    None
}

/// Extract a peer from a resolved mDNS service.
fn parse_peer(info: &mdns_sd::ResolvedService) -> Option<DiscoveredPeer> {
    let ip = pick_peer_ip(info.get_addresses().iter().map(|a| a.to_ip_addr()))?;
    // `SocketAddr` brackets IPv6 (`[::1]:8377`), which every URL built from
    // `addr` depends on.
    let addr = std::net::SocketAddr::new(ip, info.get_port()).to_string();

    // Device ID is stored in the TXT properties.
    let device_id = info.get_property_val_str("device_id")?.to_owned();
    let device_name = info.get_property_val_str("device_name")
        .map(|s| s.to_owned())
        .unwrap_or_else(|| "Unknown Device".to_string());
    // `node_type` is what older builds advertise; accept either.
    let device_type = info
        .get_property_val_str("device_type")
        .or_else(|| info.get_property_val_str("node_type"))
        .map(|s| s.to_owned());

    Some(DiscoveredPeer {
        addr,
        device_id,
        device_name,
        device_type,
    })
}

/// Choose which of a peer's advertised addresses to dial.
///
/// mDNS hands back addresses in no particular order, and a phone typically
/// advertises its public IPv6 alongside its LAN IPv4. IPv4 is what the
/// servers are reached on here, so it wins; link-local IPv6 is never usable
/// because the address carries no interface scope.
fn pick_peer_ip(addrs: impl IntoIterator<Item = IpAddr>) -> Option<IpAddr> {
    let rank = |ip: &IpAddr| match ip {
        IpAddr::V4(v4) if v4.is_private() => Some(0),
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(1),
        IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) != 0xfe80 && !v6.is_loopback() => Some(2),
        _ => None,
    };
    addrs
        .into_iter()
        .filter_map(|ip| rank(&ip).map(|r| (r, ip)))
        .min_by_key(|(r, ip)| (*r, *ip))
        .map(|(_, ip)| ip)
}

#[cfg(test)]
mod pick_peer_ip_tests {
    use super::pick_peer_ip;
    use std::net::IpAddr;

    fn ips(list: &[&str]) -> Vec<IpAddr> {
        list.iter().map(|s| s.parse().unwrap()).collect()
    }

    #[test]
    fn prefers_lan_ipv4_over_public_ipv6() {
        let got = pick_peer_ip(ips(&["2409:40c0:1009:3a8a::50", "fe80::1", "192.168.1.7"]));
        assert_eq!(got, Some("192.168.1.7".parse().unwrap()));
    }

    #[test]
    fn falls_back_to_routable_ipv6_but_never_link_local() {
        assert_eq!(
            pick_peer_ip(ips(&["fe80::1", "2409:40c0::50"])),
            Some("2409:40c0::50".parse().unwrap())
        );
        assert_eq!(pick_peer_ip(ips(&["fe80::1", "127.0.0.1"])), None);
    }

    #[test]
    fn ipv6_peer_addr_is_bracketed() {
        let ip: IpAddr = "2409:40c0::50".parse().unwrap();
        assert_eq!(std::net::SocketAddr::new(ip, 8377).to_string(), "[2409:40c0::50]:8377");
    }
}

#[cfg(test)]
mod mdns_tag_tests {
    use super::mdns_tag;

    #[test]
    fn tag_is_dns_safe_and_distinct_per_device() {
        let a = mdns_tag("q+8/Zr3xK0vQ1a2b3c4d5e6f7g8h9i0jKlMnOpQrStU=");
        let b = mdns_tag("Zz9+Yy8/Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0PpOoNnMmLlK=");
        assert_eq!(a, "q8zr3xk0vq1a");
        assert!(a.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
        assert_ne!(a, b);
    }
}
