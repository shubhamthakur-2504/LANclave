//! Text messages between paired devices: one thread per device.
//!
//! There is no server in between, so a message moves only while both
//! devices can reach each other, and the sender keeps it until then:
//!
//! - **Push when possible.** `POST /api/messages` as soon as it is written,
//!   and again whenever the peer is next heard from. The message id makes a
//!   retry harmless: a message already stored is acknowledged, not doubled.
//! - **Otherwise the receiver pulls.** A phone's server runs only while its
//!   app is open, so it often cannot be reached even when it is around. The
//!   heartbeat reply (`/api/pairing/status`) says how many messages are
//!   waiting for the caller; the caller then fetches them from
//!   `/api/messages/pending` and acknowledges them.
//!
//! Notifications never carry the text: the screen may be shared.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::server::AppState;

/// Longer than this goes as a file.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

/// Oldest messages beyond this many per thread are dropped.
const MAX_PER_THREAD: usize = 2000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageState {
    /// Written here, not yet on the other device.
    Waiting,
    /// Written here, and the other device has it.
    Delivered,
    /// Written on the other device.
    Received,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub text: String,
    /// Unix ms, by the sender's clock.
    pub sent_at: u64,
    pub state: MessageState,
    /// Received messages: whether the thread has been opened since.
    #[serde(default)]
    pub read: bool,
}

/// One thread, as the thread list shows it: no text, on purpose.
#[derive(Clone, Debug, Serialize)]
pub struct ThreadSummary {
    pub peer_id: String,
    pub count: usize,
    pub unread: usize,
    pub waiting: usize,
    pub last_at: Option<u64>,
}

/// What travels between devices.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WireMessage {
    pub id: String,
    pub text: String,
    pub sent_at: u64,
}

#[derive(Default)]
pub struct MessageStore {
    /// `messages.json`; `None` keeps everything in memory (tests).
    path: Option<PathBuf>,
    threads: Mutex<HashMap<String, Vec<Message>>>,
    app: Mutex<Option<tauri::AppHandle>>,
    /// Peers a delivery or fetch is running for, so heartbeats do not stack.
    busy: Mutex<HashSet<String>>,
}

impl MessageStore {
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("messages.json");
        let threads = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self { path: Some(path), threads: Mutex::new(threads), ..Default::default() }
    }

    pub fn set_app_handle(&self, app: tauri::AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    fn save(&self, threads: &HashMap<String, Vec<Message>>) {
        let Some(path) = &self.path else { return };
        let Ok(text) = serde_json::to_string(threads) else { return };
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }

    /// Change the threads, save, and tell the page.
    fn change<T>(&self, f: impl FnOnce(&mut HashMap<String, Vec<Message>>) -> T) -> T {
        let result = {
            let mut threads = self.threads.lock().unwrap();
            let result = f(&mut threads);
            for thread in threads.values_mut() {
                if thread.len() > MAX_PER_THREAD {
                    let excess = thread.len() - MAX_PER_THREAD;
                    thread.drain(..excess);
                }
            }
            self.save(&threads);
            result
        };
        if let Some(app) = self.app.lock().unwrap().as_ref() {
            use tauri::Emitter;
            let _ = app.emit("messages-changed", ());
        }
        result
    }

    /// A message written here, to send. Refuses blank and oversized text.
    pub fn queue_outgoing(&self, peer_id: &str, text: &str) -> Result<Message, String> {
        if text.trim().is_empty() {
            return Err("Nothing to send.".into());
        }
        if text.len() > MAX_TEXT_BYTES {
            return Err("That is too long for a message. Send it as a file instead.".into());
        }
        let message = Message {
            id: uuid::Uuid::new_v4().to_string(),
            text: text.to_string(),
            sent_at: crate::presence::now_ms(),
            state: MessageState::Waiting,
            read: true,
        };
        self.change(|threads| threads.entry(peer_id.to_string()).or_default().push(message.clone()));
        Ok(message)
    }

    /// A message from `peer_id`. `true` when it is new (not a retry).
    pub fn receive(&self, peer_id: &str, wire: WireMessage) -> bool {
        self.change(|threads| {
            let thread = threads.entry(peer_id.to_string()).or_default();
            if thread.iter().any(|m| m.id == wire.id) {
                return false;
            }
            thread.push(Message {
                id: wire.id,
                text: wire.text,
                sent_at: wire.sent_at,
                state: MessageState::Received,
                read: false,
            });
            // By the sender's clock, which may differ from ours; keep the
            // order they were written in.
            thread.sort_by_key(|m| m.sent_at);
            true
        })
    }

    pub fn mark_delivered(&self, peer_id: &str, ids: &[String]) {
        self.change(|threads| {
            for m in threads.get_mut(peer_id).into_iter().flatten() {
                if m.state == MessageState::Waiting && ids.contains(&m.id) {
                    m.state = MessageState::Delivered;
                }
            }
        });
    }

    /// Messages written here and not yet on `peer_id`.
    pub fn waiting_for(&self, peer_id: &str) -> Vec<WireMessage> {
        self.threads
            .lock()
            .unwrap()
            .get(peer_id)
            .into_iter()
            .flatten()
            .filter(|m| m.state == MessageState::Waiting)
            .map(|m| WireMessage { id: m.id.clone(), text: m.text.clone(), sent_at: m.sent_at })
            .collect()
    }

    pub fn thread(&self, peer_id: &str) -> Vec<Message> {
        self.threads.lock().unwrap().get(peer_id).cloned().unwrap_or_default()
    }

    pub fn summaries(&self) -> Vec<ThreadSummary> {
        self.threads
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, thread)| !thread.is_empty())
            .map(|(peer_id, thread)| ThreadSummary {
                peer_id: peer_id.clone(),
                count: thread.len(),
                unread: thread.iter().filter(|m| m.state == MessageState::Received && !m.read).count(),
                waiting: thread.iter().filter(|m| m.state == MessageState::Waiting).count(),
                last_at: thread.last().map(|m| m.sent_at),
            })
            .collect()
    }

    pub fn mark_read(&self, peer_id: &str) {
        let any_unread = self
            .threads
            .lock()
            .unwrap()
            .get(peer_id)
            .is_some_and(|t| t.iter().any(|m| !m.read));
        if any_unread {
            self.change(|threads| {
                for m in threads.get_mut(peer_id).into_iter().flatten() {
                    m.read = true;
                }
            });
        }
    }

    /// Delete a thread, including what is still waiting to go. Used for
    /// "Clear thread", and when a device is unpaired.
    pub fn forget(&self, peer_id: &str) {
        self.change(|threads| {
            threads.remove(peer_id);
        });
    }

    fn try_claim(&self, peer_id: &str) -> bool {
        self.busy.lock().unwrap().insert(peer_id.to_string())
    }

    fn release(&self, peer_id: &str) {
        self.busy.lock().unwrap().remove(peer_id);
    }
}

static STORE: OnceLock<MessageStore> = OnceLock::new();

/// Load saved threads. Called once at launch; until then nothing is kept.
pub fn init(data_dir: &Path) {
    let _ = STORE.set(MessageStore::load(data_dir));
}

pub fn store() -> &'static MessageStore {
    STORE.get_or_init(MessageStore::default)
}

// ---------------------------------------------------------------------------
// Moving messages
// ---------------------------------------------------------------------------

/// We just heard from `peer_id` at `addr`: send what is waiting for it, and
/// fetch what it says is waiting for us. Runs in the background; does
/// nothing when there is nothing to move or a run for this peer is going.
pub fn on_contact(peer_id: &str, addr: &str, waiting_there: u64, device_id: &str, key: &SigningKey) {
    let messages = store();
    if (waiting_there == 0 && messages.waiting_for(peer_id).is_empty()) || !messages.try_claim(peer_id) {
        return;
    }
    let (peer_id, addr, device_id, key) = (peer_id.to_string(), addr.to_string(), device_id.to_string(), key.clone());
    tauri::async_runtime::spawn(async move {
        // Released however the run ends, so a peer that stops answering
        // mid-reply cannot hold its messages up until the app restarts.
        let _claim = Claim(&peer_id);
        let _ = tokio::time::timeout(RUN_LIMIT, async {
            if waiting_there > 0 {
                fetch_waiting(&peer_id, &addr, &device_id, &key).await;
            }
            deliver(&peer_id, &addr, &device_id, &key).await;
        })
        .await;
    });
}

/// The longest one delivery-and-fetch run may take; the next contact retries.
const RUN_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

struct Claim<'a>(&'a str);

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        store().release(self.0);
    }
}

/// Push each waiting message; one that is refused or unreachable stays
/// waiting for the next contact.
async fn deliver(peer_id: &str, addr: &str, device_id: &str, key: &SigningKey) {
    for message in store().waiting_for(peer_id) {
        match crate::client::transport::post_json(addr, "/api/messages", &message, device_id, key).await {
            Ok(status) if status.is_success() => store().mark_delivered(peer_id, &[message.id]),
            // Refused for what it is, not for where we are: the rest must
            // not wait behind it.
            Ok(StatusCode::BAD_REQUEST | StatusCode::PAYLOAD_TOO_LARGE) => continue,
            _ => break,
        }
    }
}

/// Fetch what `peer_id` holds for us, then tell it what arrived.
async fn fetch_waiting(peer_id: &str, addr: &str, device_id: &str, key: &SigningKey) {
    let Ok(res) = crate::client::transport::get_stream_at(addr, "/api/messages/pending", None, device_id, key).await
    else {
        return;
    };
    if !res.status().is_success() {
        return;
    }
    let Ok(messages) = res.json::<Vec<WireMessage>>().await else { return };
    let ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    let mut new = 0;
    for message in messages {
        if message.text.len() <= MAX_TEXT_BYTES && store().receive(peer_id, message) {
            new += 1;
        }
    }
    if !ids.is_empty() {
        let _ = crate::client::transport::post_json(addr, "/api/messages/ack", &serde_json::json!({ "ids": ids }), device_id, key)
            .await;
    }
    if new > 0 {
        announce(peer_id);
    }
}

/// A system notification, when the window is hidden. Never the text.
fn announce(peer_id: &str) {
    let Some(app) = store().app.lock().unwrap().clone() else { return };
    use tauri::Manager;
    let name = app
        .try_state::<crate::commands::CliState>()
        .and_then(|state| state.device_store.read().ok()?.devices.get(peer_id)?.device_name.clone())
        .unwrap_or_else(|| "a paired device".into());
    crate::tray::notify_if_hidden(&app, &format!("New message from {name}"), "Open LANclave to read it.");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

fn caller(state: &AppState, headers: &HeaderMap) -> Result<String, StatusCode> {
    crate::pairing::check_request(&state.auth, headers)
        .map_err(|s| StatusCode::from_u16(s.code()).expect("valid HTTP status"))
}

/// `POST /api/messages` -- a paired device sends us a message.
pub async fn receive_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(message): Json<WireMessage>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let peer_id = caller(&state, &headers)?;
    if message.text.len() > MAX_TEXT_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    if message.id.is_empty() || message.text.trim().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if store().receive(&peer_id, message) {
        announce(&peer_id);
    }
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

/// `GET /api/messages/pending` -- what we hold for the caller.
pub async fn pending_messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<WireMessage>>, StatusCode> {
    let peer_id = caller(&state, &headers)?;
    Ok(Json(store().waiting_for(&peer_id)))
}

#[derive(Deserialize)]
pub struct Ack {
    ids: Vec<String>,
}

/// `POST /api/messages/ack` -- the caller has these now.
pub async fn ack_messages(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(ack): Json<Ack>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let peer_id = caller(&state, &headers)?;
    store().mark_delivered(&peer_id, &ack.ids);
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_threads() -> Vec<ThreadSummary> {
    store().summaries()
}

#[tauri::command]
pub fn get_thread(peer_id: String) -> Vec<Message> {
    store().thread(&peer_id)
}

#[tauri::command]
pub fn mark_thread_read(peer_id: String) {
    store().mark_read(&peer_id);
}

#[tauri::command]
pub fn clear_thread(peer_id: String) {
    store().forget(&peer_id);
}

/// Write a message to a paired device. It goes now if the device can be
/// reached, and otherwise waits for the next contact either way.
#[tauri::command]
pub fn send_message(
    state: tauri::State<'_, crate::commands::CliState>,
    peer_id: String,
    text: String,
) -> Result<Message, String> {
    let paired = state
        .device_store
        .read()
        .map(|store| store.devices.contains_key(&peer_id))
        .unwrap_or(false);
    if !paired {
        return Err("That device is not paired.".into());
    }
    let message = store().queue_outgoing(&peer_id, &text)?;

    let addr = state.presence.addr_of(&peer_id).or_else(|| {
        state.device_store.read().ok()?.devices.get(&peer_id)?.last_addr.clone()
    });
    if let Some(addr) = addr {
        on_contact(&peer_id, &addr, 0, &state.device_id, &state.identity_key);
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(id: &str, text: &str, sent_at: u64) -> WireMessage {
        WireMessage { id: id.into(), text: text.into(), sent_at }
    }

    #[test]
    fn a_retried_message_is_stored_once() {
        let store = MessageStore::default();
        assert!(store.receive("phone", wire("m1", "123456", 10)));
        assert!(!store.receive("phone", wire("m1", "123456", 10)));
        assert_eq!(store.thread("phone").len(), 1);
        assert_eq!(store.summaries()[0].unread, 1);
    }

    #[test]
    fn a_message_waits_until_the_other_device_has_it() {
        let store = MessageStore::default();
        let sent = store.queue_outgoing("phone", "https://example.com").unwrap();
        assert_eq!(store.waiting_for("phone").len(), 1);

        store.mark_delivered("phone", &[sent.id.clone()]);
        assert!(store.waiting_for("phone").is_empty());
        assert_eq!(store.thread("phone")[0].state, MessageState::Delivered);
    }

    #[test]
    fn blank_and_oversized_text_is_refused() {
        let store = MessageStore::default();
        assert!(store.queue_outgoing("phone", "  \n ").is_err());
        assert!(store.queue_outgoing("phone", &"x".repeat(MAX_TEXT_BYTES + 1)).is_err());
        assert!(store.thread("phone").is_empty());
    }

    #[test]
    fn opening_a_thread_reads_it_and_clearing_forgets_it() {
        let store = MessageStore::default();
        store.receive("phone", wire("a", "one", 1));
        store.receive("phone", wire("b", "two", 2));
        store.mark_read("phone");
        assert_eq!(store.summaries()[0].unread, 0);

        store.forget("phone");
        assert!(store.thread("phone").is_empty());
        assert!(store.summaries().is_empty());
    }

    #[test]
    fn threads_survive_a_restart() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = MessageStore::load(dir.path());
        store.receive("phone", wire("a", "kept", 1));
        assert_eq!(MessageStore::load(dir.path()).thread("phone")[0].text, "kept");
    }
}
