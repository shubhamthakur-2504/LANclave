//! Peer presence tracking.
//!
//! Discovery ("who is out there?") and presence ("is a peer I already know
//! still alive?") are different problems with very different costs. Discovery
//! needs a subnet sweep and is user-driven. Presence only ever touches peers
//! whose address we already know, so it costs one request per paired peer.
//!
//! Three signals feed the same `last_seen` timestamp:
//!
//! 1. An outbound heartbeat to each paired peer's known address.
//! 2. Any authenticated inbound request from that peer, including its signed
//!    heartbeat to our `/health` -- so each side also hears from the other
//!    without extra traffic, and learns the other's current address.
//! 3. Explicit `hello` / `bye` announcements.
//!
//! `hello`/`bye` only make transitions instant. They can never be the source
//! of truth, because the cases that matter most — a crash, a kill, or the
//! peer walking out of Wi-Fi range — send nothing at all. The TTL below is
//! what actually decides whether a peer is online.

use base64::Engine;
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::pairing::{
    sign_request, DeviceStore, HEADER_DEVICE_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP,
};

/// A peer is considered online if it was last seen within this window.
pub const ONLINE_TTL: Duration = Duration::from_secs(45);
/// How often we poll paired peers. Comfortably inside `ONLINE_TTL`.
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
/// Per-heartbeat request timeout.
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(3);
/// Consecutive heartbeat failures tolerated before a peer is marked offline.
pub const MAX_HEARTBEAT_FAILS: u32 = 2;

pub const SERVER_PORT: u16 = 8377;

/// What we advertise ourselves as over `/health`.
pub const DEVICE_TYPE: &str = "laptop";

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerPresence {
    pub device_id: String,
    pub device_name: Option<String>,
    /// Last address we successfully reached this peer on, as `ip:port`.
    pub addr: Option<String>,
    pub last_seen_ms: u64,
    pub online: bool,
}

#[derive(Debug, Clone)]
struct Entry {
    device_name: Option<String>,
    addr: Option<String>,
    last_seen_ms: u64,
    fail_count: u32,
}

/// Shared, in-memory presence table. Cheap to read; written on every
/// authenticated request, so writes are kept trivial.
#[derive(Default)]
pub struct PresenceStore {
    inner: RwLock<HashMap<String, Entry>>,
}

impl PresenceStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that we just heard from this peer. Clears any failure streak.
    pub fn mark_seen(&self, device_id: &str, device_name: Option<String>, addr: Option<String>) {
        let Ok(mut map) = self.inner.write() else {
            return;
        };
        let entry = map.entry(device_id.to_string()).or_insert(Entry {
            device_name: None,
            addr: None,
            last_seen_ms: 0,
            fail_count: 0,
        });
        entry.last_seen_ms = now_ms();
        entry.fail_count = 0;
        if device_name.is_some() {
            entry.device_name = device_name;
        }
        if addr.is_some() {
            entry.addr = addr;
        }
    }

    /// Mark a peer offline immediately, without waiting out the TTL.
    pub fn mark_offline(&self, device_id: &str) {
        if let Ok(mut map) = self.inner.write() {
            if let Some(entry) = map.get_mut(device_id) {
                entry.last_seen_ms = 0;
                entry.fail_count = MAX_HEARTBEAT_FAILS;
            }
        }
    }

    /// Record a failed heartbeat, returning the new consecutive failure count.
    pub fn record_failure(&self, device_id: &str) -> u32 {
        let Ok(mut map) = self.inner.write() else {
            return 0;
        };
        let entry = map.entry(device_id.to_string()).or_insert(Entry {
            device_name: None,
            addr: None,
            last_seen_ms: 0,
            fail_count: 0,
        });
        entry.fail_count = entry.fail_count.saturating_add(1);
        if entry.fail_count >= MAX_HEARTBEAT_FAILS {
            entry.last_seen_ms = 0;
        }
        entry.fail_count
    }

    pub fn addr_of(&self, device_id: &str) -> Option<String> {
        self.inner.read().ok()?.get(device_id)?.addr.clone()
    }

    pub fn set_addr(&self, device_id: &str, addr: String) {
        if let Ok(mut map) = self.inner.write() {
            map.entry(device_id.to_string())
                .or_insert(Entry {
                    device_name: None,
                    addr: None,
                    last_seen_ms: 0,
                    fail_count: 0,
                })
                .addr = Some(addr);
        }
    }

    pub fn is_online(&self, device_id: &str) -> bool {
        self.inner
            .read()
            .ok()
            .and_then(|m| m.get(device_id).map(|e| is_fresh(e.last_seen_ms)))
            .unwrap_or(false)
    }

    pub fn get(&self, device_id: &str) -> Option<PeerPresence> {
        let map = self.inner.read().ok()?;
        let entry = map.get(device_id)?;
        Some(to_public(device_id, entry))
    }

    pub fn snapshot(&self) -> Vec<PeerPresence> {
        let Ok(map) = self.inner.read() else {
            return Vec::new();
        };
        map.iter().map(|(id, e)| to_public(id, e)).collect()
    }
}

fn is_fresh(last_seen_ms: u64) -> bool {
    last_seen_ms > 0 && now_ms().saturating_sub(last_seen_ms) < ONLINE_TTL.as_millis() as u64
}

fn to_public(device_id: &str, entry: &Entry) -> PeerPresence {
    PeerPresence {
        device_id: device_id.to_string(),
        device_name: entry.device_name.clone(),
        addr: entry.addr.clone(),
        last_seen_ms: entry.last_seen_ms,
        online: is_fresh(entry.last_seen_ms),
    }
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloPayload {
    pub device_name: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceAck {
    pub status: String,
    pub device_id: String,
    pub device_name: String,
}

// ---------------------------------------------------------------------------
// Outbound presence
// ---------------------------------------------------------------------------

static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(HEARTBEAT_TIMEOUT)
        .build()
        .expect("valid reqwest client config")
});

/// Everything the background presence tasks need.
#[derive(Clone)]
pub struct PresenceContext {
    pub presence: Arc<PresenceStore>,
    pub device_store: Arc<RwLock<DeviceStore>>,
    pub settings: Arc<RwLock<crate::settings::AppSettings>>,
    pub device_id: String,
    pub identity_key: SigningKey,
    pub app_handle: Option<tauri::AppHandle>,
}

impl PresenceContext {
    fn display_name(&self) -> String {
        self.settings
            .read()
            .map(|s| s.display_name.clone())
            .unwrap_or_else(|_| "Desktop Workstation".to_string())
    }

    /// Paired peers as `(device_id, last_known_addr)`.
    fn paired_targets(&self) -> Vec<(String, Option<String>)> {
        let Ok(store) = self.device_store.read() else {
            return Vec::new();
        };
        store
            .devices
            .values()
            .filter(|d| d.device_id != self.device_id)
            .map(|d| {
                let addr = self
                    .presence
                    .addr_of(&d.device_id)
                    .or_else(|| d.last_addr.clone());
                (d.device_id.clone(), addr)
            })
            .collect()
    }

    fn sign_headers(&self) -> (String, String) {
        let (ts, sig) = sign_request(&self.identity_key, &self.device_id);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
        (ts.to_string(), sig_b64)
    }

    fn emit_changed(&self) {
        if let Some(app) = &self.app_handle {
            use tauri::Emitter;
            let _ = app.emit("presence-changed", self.presence.snapshot());
        }
    }

    /// Persist a peer's address so presence survives a restart without a scan.
    fn remember_addr(&self, device_id: &str, addr: &str) {
        self.presence.set_addr(device_id, addr.to_string());
        if let Ok(mut store) = self.device_store.write() {
            if let Some(dev) = store.devices.get_mut(device_id) {
                if dev.last_addr.as_deref() != Some(addr) {
                    dev.last_addr = Some(addr.to_string());
                }
            }
        }
    }

    /// Record what kind of device a peer says it is, so the UI can show a
    /// laptop/phone glyph even while the peer is offline.
    fn remember_kind(&self, device_id: &str, kind: Option<String>) {
        let Some(kind) = kind else { return };
        if let Ok(mut store) = self.device_store.write() {
            if let Some(dev) = store.devices.get_mut(device_id) {
                if dev.device_type.as_deref() != Some(kind.as_str()) {
                    dev.device_type = Some(kind);
                }
            }
        }
    }

    /// One `/health` probe. Confirms identity before trusting the result --
    /// a stale address may now belong to an entirely different device.
    async fn probe(&self, device_id: &str, addr: &str) -> bool {
        let url = format!("http://{addr}/health");
        // Signed so the peer can count this heartbeat as contact from us and
        // learn our current address. /health still answers unsigned probes.
        let (ts, sig) = self.sign_headers();
        let Ok(res) = CLIENT
            .get(&url)
            .header(HEADER_DEVICE_ID, &self.device_id)
            .header(HEADER_TIMESTAMP, ts)
            .header(HEADER_SIGNATURE, sig)
            .send()
            .await
        else {
            return false;
        };
        let Ok(body) = res.json::<serde_json::Value>().await else {
            return false;
        };
        if body.get("app").and_then(|v| v.as_str()) != Some("lanclave") {
            return false;
        }
        if body.get("device_id").and_then(|v| v.as_str()) != Some(device_id) {
            return false;
        }
        let name = body
            .get("device_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let kind = body
            .get("device_type")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        self.presence
            .mark_seen(device_id, name, Some(addr.to_string()));
        self.remember_addr(device_id, addr);
        self.remember_kind(device_id, kind);
        true
    }

    /// Announce ourselves to one peer and record whatever it answers with.
    pub async fn hello_one(&self, device_id: &str, addr: &str) -> bool {
        let url = format!("http://{addr}/api/presence/hello");
        let (ts, sig) = self.sign_headers();
        let payload = HelloPayload {
            device_name: self.display_name(),
            port: SERVER_PORT,
        };

        let Ok(res) = CLIENT
            .post(&url)
            .header(HEADER_DEVICE_ID, &self.device_id)
            .header(HEADER_TIMESTAMP, ts)
            .header(HEADER_SIGNATURE, sig)
            .json(&payload)
            .send()
            .await
        else {
            return false;
        };
        if !res.status().is_success() {
            return false;
        }
        let name = res
            .json::<PresenceAck>()
            .await
            .ok()
            .map(|ack| ack.device_name);
        self.presence
            .mark_seen(device_id, name, Some(addr.to_string()));
        self.remember_addr(device_id, addr);
        true
    }

    /// Tell every paired peer we are online. Runs once at startup.
    pub async fn announce_hello(&self) {
        for (device_id, addr) in self.paired_targets() {
            let Some(addr) = addr else { continue };
            self.hello_one(&device_id, &addr).await;
        }
        self.emit_changed();
    }

    /// Best-effort goodbye. A crash, a kill, or a peer leaving Wi-Fi range
    /// sends nothing -- the TTL is what covers those cases.
    pub async fn announce_bye(&self) {
        for (device_id, addr) in self.paired_targets() {
            let Some(addr) = addr else { continue };
            let url = format!("http://{addr}/api/presence/bye");
            let (ts, sig) = self.sign_headers();
            let _ = CLIENT
                .post(&url)
                .header(HEADER_DEVICE_ID, &self.device_id)
                .header(HEADER_TIMESTAMP, ts)
                .header(HEADER_SIGNATURE, sig)
                .send()
                .await;
            let _ = device_id;
        }
    }

    /// Background loop: poll paired peers, and re-resolve any that go quiet.
    pub fn spawn_heartbeat(self) {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(HEARTBEAT_INTERVAL).await;

                let targets = self.paired_targets();
                if targets.is_empty() {
                    continue;
                }

                let mut changed = false;
                for (device_id, addr) in targets {
                    let was_online = self.presence.is_online(&device_id);

                    let reached = match &addr {
                        Some(a) => self.probe(&device_id, a).await,
                        None => false,
                    };

                    if !reached {
                        let fails = self.presence.record_failure(&device_id);
                        // Phase 3: a stale address is the common failure on a
                        // hotspot, where DHCP leases rotate. Ask mDNS for the
                        // current one before declaring the peer offline --
                        // targeted, not a subnet sweep.
                        if fails >= MAX_HEARTBEAT_FAILS {
                            if let Some(new_addr) =
                                crate::discovery::resolve_peer_addr(&device_id).await
                            {
                                if Some(&new_addr) != addr.as_ref() {
                                    self.probe(&device_id, &new_addr).await;
                                }
                            }
                        }
                    }

                    if self.presence.is_online(&device_id) != was_online {
                        changed = true;
                    }
                }

                if changed {
                    self.emit_changed();
                }
            }
        });
    }
}
