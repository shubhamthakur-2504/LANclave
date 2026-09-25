//! Sending as "offer, consent, receiver pulls".
//!
//! The sender registers an offer (files it is willing to serve, to one
//! device, for a limited time) and posts it to the receiver. The receiver
//! shows one prompt for the whole selection; on acceptance it pulls each
//! chosen file from the sender with the same resumable, verified pull used
//! everywhere else, then reports how each file ended.
//!
//! ```text
//! sender                                         receiver
//!   POST /api/offers ─────────────────────────▶  (prompt)
//!   ◀── POST /api/offers/{id}/accept {file_ids}   or  /decline
//!   ◀── GET  /api/offers/{id}/files/{fid}         Range / If-Range
//!   ◀── GET  /api/offers/{id}/files/{fid}/fingerprint
//!   ◀── POST /api/offers/{id}/report {results}
//!   POST /api/offers/{id}/cancel ─────────────▶  (sender withdrew)
//! ```
//!
//! Security: offers come only from paired devices; an offered file is served
//! only to the device it was offered to, only after it accepted, only until
//! the offer expires, and only by random id -- never by path. Offered names
//! are reduced to a bare file name before they touch the receiver's disk.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::{
    extract::{Path as UrlPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::client::transport;
use crate::history::{Direction, HistoryEntry, Initiator, Outcome};
use crate::presence::now_ms;
use crate::server::AppState;

/// An unanswered offer lapses after this long.
pub const PENDING_TTL_MS: u64 = 10 * 60 * 1000;
/// An accepted offer stays pullable (and resumable) this long.
pub const ACCEPTED_TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// Finished offers are forgotten this long after they end.
const FINISHED_TTL_MS: u64 = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OfferFile {
    pub id: String,
    pub name: String,
    pub size: u64,
    #[serde(default)]
    pub modified: Option<u64>,
}

/// Body of `POST /api/offers`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfferPayload {
    pub offer_id: String,
    #[serde(default)]
    pub sender_name: Option<String>,
    pub files: Vec<OfferFile>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OfferState {
    /// Sent, not yet answered.
    Waiting,
    /// Accepted; files are being (or can be) pulled.
    Accepted,
    Declined,
    Cancelled,
    Expired,
    /// Every accepted file has ended one way or another.
    Done,
}

impl OfferState {
    fn is_final(self) -> bool {
        matches!(self, Self::Declined | Self::Cancelled | Self::Expired | Self::Done)
    }
}

/// How one file of an offer ended, as the receiver reports it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileResult {
    /// `completed`, `skipped`, `failed` or `cancelled`.
    pub outcome: String,
    #[serde(default)]
    pub dest_name: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutgoingOffer {
    pub id: String,
    pub peer_id: String,
    pub peer_name: Option<String>,
    #[serde(skip)]
    pub peer_addr: String,
    pub files: Vec<OfferFile>,
    /// Where each offered file lives here. Never sent anywhere.
    #[serde(skip)]
    pub paths: HashMap<String, PathBuf>,
    pub state: OfferState,
    /// Sender-side pause: the files answer 503 until resumed.
    pub paused: bool,
    /// The files the receiver chose.
    pub accepted: Vec<String>,
    /// Highest byte each file has been served up to.
    pub served: HashMap<String, u64>,
    pub results: HashMap<String, FileResult>,
    pub created_ms: u64,
    pub expires_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct IncomingOffer {
    pub id: String,
    pub peer_id: String,
    pub peer_name: Option<String>,
    #[serde(skip)]
    pub peer_addr: String,
    pub files: Vec<OfferFile>,
    pub state: OfferState,
    pub accepted: Vec<String>,
    pub results: HashMap<String, FileResult>,
    pub received_ms: u64,
    pub expires_ms: u64,
}

impl IncomingOffer {
    /// Accepted files without a result yet, in offer order.
    fn remaining(&self) -> Vec<OfferFile> {
        self.files
            .iter()
            .filter(|f| self.accepted.contains(&f.id) && !self.results.contains_key(&f.id))
            .cloned()
            .collect()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OffersSnapshot {
    pub outgoing: Vec<OutgoingOffer>,
    pub incoming: Vec<IncomingOffer>,
}

#[derive(Default)]
pub struct OfferStore {
    outgoing: Mutex<HashMap<String, OutgoingOffer>>,
    incoming: Mutex<HashMap<String, IncomingOffer>>,
    app: Mutex<Option<tauri::AppHandle>>,
}

impl OfferStore {
    pub fn set_app_handle(&self, app: tauri::AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    fn app(&self) -> Option<tauri::AppHandle> {
        self.app.lock().unwrap().clone()
    }

    pub fn snapshot(&self) -> OffersSnapshot {
        let mut outgoing: Vec<_> = self.outgoing.lock().unwrap().values().cloned().collect();
        let mut incoming: Vec<_> = self.incoming.lock().unwrap().values().cloned().collect();
        outgoing.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
        incoming.sort_by(|a, b| b.received_ms.cmp(&a.received_ms));
        OffersSnapshot { outgoing, incoming }
    }

    /// Tell the UI something changed.
    pub fn emit_changed(&self) {
        if let Some(app) = self.app() {
            use tauri::Emitter;
            let _ = app.emit("offers-changed", self.snapshot());
        }
    }

    fn update_outgoing<T>(&self, id: &str, f: impl FnOnce(&mut OutgoingOffer) -> T) -> Option<T> {
        self.outgoing.lock().unwrap().get_mut(id).map(f)
    }

    fn update_incoming<T>(&self, id: &str, f: impl FnOnce(&mut IncomingOffer) -> T) -> Option<T> {
        self.incoming.lock().unwrap().get_mut(id).map(f)
    }

    pub fn incoming(&self, id: &str) -> Option<IncomingOffer> {
        self.incoming.lock().unwrap().get(id).cloned()
    }

    /// Expire lapsed offers and forget long-finished ones. Returns the
    /// outgoing offers that just expired unanswered (for the history log).
    pub fn sweep(&self, now: u64) -> Vec<OutgoingOffer> {
        let mut expired = Vec::new();
        {
            let mut out = self.outgoing.lock().unwrap();
            for offer in out.values_mut() {
                if !offer.state.is_final() && now >= offer.expires_ms {
                    if offer.state == OfferState::Waiting {
                        expired.push(offer.clone());
                    }
                    offer.state = OfferState::Expired;
                }
            }
            out.retain(|_, o| !(o.state.is_final() && now >= o.expires_ms + FINISHED_TTL_MS));
        }
        {
            let mut inc = self.incoming.lock().unwrap();
            // An accepted offer past its time is refused by the sender
            // anyway; its unfinished downloads fail when they next start.
            for offer in inc.values_mut() {
                if !offer.state.is_final() && now >= offer.expires_ms {
                    offer.state = OfferState::Expired;
                }
            }
            inc.retain(|_, o| !(o.state.is_final() && now >= o.expires_ms + FINISHED_TTL_MS));
        }
        expired
    }
}

/// Reduce an offered name to a bare file name, or refuse it. Names come
/// from the peer and are about to become paths on this disk.
pub fn safe_file_name(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next()?.trim();
    let ok = !base.is_empty()
        && base != "."
        && base != ".."
        && !base.starts_with('.')
        && !base.contains('\0')
        && !base.contains(':');
    ok.then(|| base.to_string())
}

fn status_err(s: crate::pairing::Status) -> StatusCode {
    StatusCode::from_u16(s.code()).expect("valid HTTP status")
}

// ---------------------------------------------------------------------------
// Receiver-side routes
// ---------------------------------------------------------------------------

/// `POST /api/offers` -- a paired device offers us files.
pub async fn receive_offer(
    State(state): State<Arc<AppState>>,
    remote: Option<axum::Extension<axum::extract::ConnectInfo<std::net::SocketAddr>>>,
    headers: HeaderMap,
    Json(body): Json<OfferPayload>,
) -> Result<StatusCode, StatusCode> {
    let peer_id = crate::pairing::check_request(&state.auth, &headers).map_err(status_err)?;

    // Validate every name now: an offer with a name we would refuse to
    // write is refused whole, rather than half-accepted later.
    let mut files = Vec::with_capacity(body.files.len());
    for f in body.files {
        let name = safe_file_name(&f.name).ok_or(StatusCode::BAD_REQUEST)?;
        files.push(OfferFile { name, ..f });
    }
    if files.is_empty() || files.len() > 10_000 {
        return Err(StatusCode::BAD_REQUEST);
    }

    let peer_addr = remote
        .map(|axum::Extension(ci)| format!("{}:{}", ci.0.ip(), crate::presence::SERVER_PORT))
        .or_else(|| state.presence.addr_of(&peer_id))
        .ok_or(StatusCode::BAD_REQUEST)?;
    let peer_name = state.peer_name(&peer_id).or(body.sender_name);

    let now = now_ms();
    let offer = IncomingOffer {
        id: body.offer_id.clone(),
        peer_id,
        peer_name,
        peer_addr,
        files,
        state: OfferState::Waiting,
        accepted: Vec::new(),
        results: HashMap::new(),
        received_ms: now,
        expires_ms: now + PENDING_TTL_MS,
    };

    {
        let mut inc = state.offers.incoming.lock().unwrap();
        if inc.contains_key(&offer.id) {
            return Ok(StatusCode::ACCEPTED); // a retried post
        }
        inc.insert(offer.id.clone(), offer.clone());
    }
    state.offers.emit_changed();
    announce_offer(&state, &offer);
    Ok(StatusCode::ACCEPTED)
}

/// Prompt the user: an event for the open window, and a system notification
/// when the window is hidden in the tray.
fn announce_offer(state: &AppState, offer: &IncomingOffer) {
    let Some(app) = &state.app_handle else { return };
    use tauri::{Emitter, Manager};
    let _ = app.emit("offer-received", offer);

    let visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if !visible {
        use tauri_plugin_notification::NotificationExt;
        let who = offer.peer_name.clone().unwrap_or_else(|| "A paired device".into());
        let total: u64 = offer.files.iter().map(|f| f.size).sum();
        let count = offer.files.len();
        let _ = app
            .notification()
            .builder()
            .title(format!("{who} wants to send {count} file{}", if count == 1 { "" } else { "s" }))
            .body(format!("{} · open LANclave to accept or decline", crate::fmt_bytes(total)))
            .show();
    }
}

/// `POST /api/offers/{id}/cancel` -- the sender withdrew its offer.
pub async fn offer_withdrawn(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
) -> Result<StatusCode, StatusCode> {
    let caller = crate::pairing::check_request(&state.auth, &headers).map_err(status_err)?;
    let offer = state.offers.incoming(&id).ok_or(StatusCode::NOT_FOUND)?;
    if offer.peer_id != caller {
        return Err(StatusCode::NOT_FOUND);
    }
    state.offers.update_incoming(&id, |o| {
        if !o.state.is_final() {
            o.state = OfferState::Cancelled;
        }
    });
    // Stop whatever is being pulled for it.
    if let Some(app) = &state.app_handle {
        use tauri::Manager;
        if let Some(transfers) = app.try_state::<Arc<crate::transfers::TransferManager>>() {
            transfers.cancel_offer(&offer.id);
        }
    }
    state.offers.emit_changed();
    Ok(StatusCode::OK)
}

// ---------------------------------------------------------------------------
// Sender-side routes
// ---------------------------------------------------------------------------

/// The outgoing offer `id`, if `caller` is the device it was offered to.
fn offer_for(state: &AppState, id: &str, caller: &str) -> Result<OutgoingOffer, StatusCode> {
    let offer = state
        .offers
        .outgoing
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or(StatusCode::NOT_FOUND)?;
    // Someone else's offer does not exist, as far as this caller knows.
    if offer.peer_id != caller {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(offer)
}

#[derive(Deserialize)]
pub struct AcceptBody {
    pub file_ids: Vec<String>,
}

/// `POST /api/offers/{id}/accept` -- the receiver takes some or all files.
pub async fn offer_accepted(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<AcceptBody>,
) -> Result<StatusCode, StatusCode> {
    let caller = crate::pairing::check_request(&state.auth, &headers).map_err(status_err)?;
    let offer = offer_for(&state, &id, &caller)?;
    if offer.state != OfferState::Waiting && offer.state != OfferState::Accepted {
        return Err(StatusCode::GONE);
    }
    let offered: Vec<&str> = offer.files.iter().map(|f| f.id.as_str()).collect();
    let accepted: Vec<String> =
        body.file_ids.into_iter().filter(|f| offered.contains(&f.as_str())).collect();

    let (declined_files, peer_name) = {
        let now = now_ms();
        state
            .offers
            .update_outgoing(&id, |o| {
                o.state = OfferState::Accepted;
                o.accepted = accepted.clone();
                o.expires_ms = now + ACCEPTED_TTL_MS;
                let declined: Vec<OfferFile> =
                    o.files.iter().filter(|f| !accepted.contains(&f.id)).cloned().collect();
                (declined, o.peer_name.clone())
            })
            .ok_or(StatusCode::NOT_FOUND)?
    };
    // Files left unticked were declined, one by one.
    for f in declined_files {
        log_sent(&state, &caller, peer_name.clone(), &f, Outcome::Declined, None, None);
    }
    state.offers.emit_changed();
    Ok(StatusCode::OK)
}

/// `POST /api/offers/{id}/decline`
pub async fn offer_declined(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
) -> Result<StatusCode, StatusCode> {
    let caller = crate::pairing::check_request(&state.auth, &headers).map_err(status_err)?;
    let offer = offer_for(&state, &id, &caller)?;
    if offer.state != OfferState::Waiting {
        return Err(StatusCode::GONE);
    }
    state.offers.update_outgoing(&id, |o| o.state = OfferState::Declined);
    for f in &offer.files {
        log_sent(&state, &caller, offer.peer_name.clone(), f, Outcome::Declined, None, None);
    }
    state.offers.emit_changed();
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
pub struct ReportBody {
    pub results: HashMap<String, FileResult>,
}

/// `POST /api/offers/{id}/report` -- how each accepted file ended.
pub async fn offer_reported(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<ReportBody>,
) -> Result<StatusCode, StatusCode> {
    let caller = crate::pairing::check_request(&state.auth, &headers).map_err(status_err)?;
    let offer = offer_for(&state, &id, &caller)?;

    let mut newly = Vec::new();
    state.offers.update_outgoing(&id, |o| {
        for (fid, result) in body.results {
            // A file that failed may be retried and reported again.
            let open = o.results.get(&fid).is_none_or(|r| r.outcome == "failed");
            if o.accepted.contains(&fid) && open && o.results.get(&fid) != Some(&result) {
                newly.push((fid.clone(), result.clone()));
                o.results.insert(fid, result);
            }
        }
        if all_settled(&o.accepted, &o.results) {
            o.state = OfferState::Done;
        }
    });

    for (fid, result) in newly {
        let Some(file) = offer.files.iter().find(|f| f.id == fid) else { continue };
        let outcome = match result.outcome.as_str() {
            "completed" => Outcome::Completed,
            "skipped" => Outcome::Skipped,
            "cancelled" => Outcome::Cancelled,
            _ => Outcome::Failed,
        };
        log_sent(&state, &caller, offer.peer_name.clone(), file, outcome, result.dest_name, result.error);
    }
    state.offers.emit_changed();
    Ok(StatusCode::OK)
}

fn log_sent(
    state: &AppState,
    peer_id: &str,
    peer_name: Option<String>,
    file: &OfferFile,
    outcome: Outcome,
    dest_name: Option<String>,
    error: Option<String>,
) {
    let mut entry = HistoryEntry::new(Direction::Sent, Initiator::Me, peer_id.to_string(), peer_name, file.name.clone());
    entry.outcome = outcome;
    entry.bytes = if outcome == Outcome::Completed || outcome == Outcome::Skipped { file.size } else { 0 };
    entry.dest_name = dest_name.filter(|d| *d != file.name);
    entry.error = error;
    state.history.record(entry);
}

/// Every accepted file has a result, and none failed. A failed file keeps
/// the offer open (still servable) so the receiver can retry it.
fn all_settled(accepted: &[String], results: &HashMap<String, FileResult>) -> bool {
    accepted
        .iter()
        .all(|f| results.get(f).is_some_and(|r| r.outcome != "failed"))
}

/// Whether `caller` may pull file `fid` of offer `id` right now.
fn servable(state: &AppState, id: &str, fid: &str, caller: &str) -> Result<(OutgoingOffer, PathBuf, OfferFile), Response> {
    let offer = offer_for(state, id, caller).map_err(IntoResponse::into_response)?;
    if offer.state != OfferState::Accepted || now_ms() >= offer.expires_ms {
        return Err(StatusCode::GONE.into_response());
    }
    if !offer.accepted.iter().any(|f| f == fid) {
        return Err(StatusCode::NOT_FOUND.into_response());
    }
    if offer.paused {
        // Paused by the sender: come back later.
        return Err(([(axum::http::header::RETRY_AFTER, "5")], StatusCode::SERVICE_UNAVAILABLE).into_response());
    }
    let path = offer.paths.get(fid).cloned().ok_or_else(|| StatusCode::NOT_FOUND.into_response())?;
    let file = offer.files.iter().find(|f| f.id == fid).cloned().ok_or_else(|| StatusCode::NOT_FOUND.into_response())?;
    Ok((offer, path, file))
}

/// `GET /api/offers/{id}/files/{fid}` -- the resumable download.
pub async fn serve_offer_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    UrlPath((id, fid)): UrlPath<(String, String)>,
) -> Response {
    let caller = match crate::pairing::check_request(&state.auth, &headers) {
        Ok(c) => c,
        Err(s) => return status_err(s).into_response(),
    };
    let (_, path, file) = match servable(&state, &id, &fid, &caller) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let observer = OfferServe {
        store: state.clone(),
        offer_id: id,
        file_id: fid,
        position: 0,
        last_emit: std::time::Instant::now(),
    };
    match crate::range::serve_file(&path, &headers, &file.name, observer).await {
        Ok(r) => r,
        Err(s) => s.into_response(),
    }
}

#[derive(Deserialize)]
pub struct FingerprintQuery {
    pub size: Option<u64>,
}

/// `GET /api/offers/{id}/files/{fid}/fingerprint`
pub async fn offer_file_fingerprint(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    UrlPath((id, fid)): UrlPath<(String, String)>,
    Query(q): Query<FingerprintQuery>,
) -> Response {
    let caller = match crate::pairing::check_request(&state.auth, &headers) {
        Ok(c) => c,
        Err(s) => return status_err(s).into_response(),
    };
    let (_, path, _) = match servable(&state, &id, &fid, &caller) {
        Ok(v) => v,
        Err(r) => return r,
    };
    match crate::dedupe::fingerprint_local(&path, q.size, false).await {
        Ok(Some(fp)) => Json(fp).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Tracks how far an offered file has been served, for the sender's view.
struct OfferServe {
    store: Arc<AppState>,
    offer_id: String,
    file_id: String,
    position: u64,
    last_emit: std::time::Instant,
}

impl OfferServe {
    fn publish(&self) {
        let id = &self.offer_id;
        let pos = self.position;
        self.store.offers.update_outgoing(id, |o| {
            let seen = o.served.entry(self.file_id.clone()).or_insert(0);
            *seen = (*seen).max(pos);
        });
        if let Some(app) = self.store.offers.app() {
            use tauri::Emitter;
            let _ = app.emit(
                "offer-progress",
                serde_json::json!({ "offer_id": id, "file_id": self.file_id, "bytes": pos }),
            );
        }
    }
}

impl crate::range::ServeObserver for OfferServe {
    fn on_start(&mut self, start: u64, _len: u64) {
        self.position = start;
    }

    fn add_bytes(&mut self, n: u64) {
        self.position += n;
        if self.last_emit.elapsed().as_millis() >= 250 {
            self.publish();
            self.last_emit = std::time::Instant::now();
        }
    }
}

impl Drop for OfferServe {
    fn drop(&mut self) {
        self.publish();
    }
}

// ---------------------------------------------------------------------------
// Commands: sending
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SendResult {
    /// Offered; the receiver will pull once it accepts.
    Offer { offer_id: String },
    /// The peer predates offers: push the files the old way.
    Legacy,
}

/// Whether the peer supports offers, from its pairing status.
async fn peer_supports_offers(addr: &str, device_id: &str, key: &ed25519_dalek::SigningKey) -> bool {
    let Ok(res) = transport::get_stream_at(addr, "/api/pairing/status", None, device_id, key).await else {
        return false;
    };
    if !res.status().is_success() {
        return false;
    }
    let Ok(body) = res.json::<serde_json::Value>().await else { return false };
    body.get("features")
        .and_then(|f| f.as_array())
        .is_some_and(|f| f.iter().any(|v| v == "offers"))
}

/// Offer sandbox files to a peer: one offer, one prompt on its side.
#[tauri::command]
pub async fn send_files(
    state: tauri::State<'_, crate::commands::CliState>,
    offers: tauri::State<'_, Arc<OfferStore>>,
    peer_addr: String,
    peer_id: String,
    peer_name: Option<String>,
    local_names: Vec<String>,
) -> Result<SendResult, String> {
    if local_names.is_empty() {
        return Err("nothing to send".into());
    }
    if !peer_supports_offers(&peer_addr, &state.device_id, &state.identity_key).await {
        return Ok(SendResult::Legacy);
    }

    let sandbox_root = PathBuf::from(&state.settings.read().map_err(|e| e.to_string())?.sandbox_path);
    let mut files = Vec::new();
    let mut paths = HashMap::new();
    for name in &local_names {
        let path = crate::sandbox::verify_sandboxed_path(&sandbox_root, name)
            .map_err(|e| format!("{name}: {e}"))?;
        let meta = std::fs::metadata(&path).map_err(|e| format!("{name}: {e}"))?;
        if !meta.is_file() {
            return Err(format!("{name} is not a file"));
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let display = path.file_name().and_then(|n| n.to_str()).unwrap_or(name).to_string();
        files.push(OfferFile { id: id.clone(), name: display, size: meta.len(), modified: crate::fs_util::modified_ms(&meta) });
        paths.insert(id, path);
    }

    let now = now_ms();
    let offer = OutgoingOffer {
        id: uuid::Uuid::new_v4().simple().to_string(),
        peer_id,
        peer_name,
        peer_addr: peer_addr.clone(),
        files: files.clone(),
        paths,
        state: OfferState::Waiting,
        paused: false,
        accepted: Vec::new(),
        served: HashMap::new(),
        results: HashMap::new(),
        created_ms: now,
        expires_ms: now + PENDING_TTL_MS,
    };
    let offer_id = offer.id.clone();
    // Registered before posting: the receiver may accept faster than our
    // request returns.
    offers.outgoing.lock().unwrap().insert(offer_id.clone(), offer);

    let display_name = state.settings.read().map(|s| s.display_name.clone()).ok();
    let payload = OfferPayload { offer_id: offer_id.clone(), sender_name: display_name, files };
    let posted = transport::post_json(&peer_addr, "/api/offers", &payload, &state.device_id, &state.identity_key).await;
    match posted {
        Ok(status) if status.is_success() => {
            offers.emit_changed();
            Ok(SendResult::Offer { offer_id })
        }
        Ok(status) => {
            offers.outgoing.lock().unwrap().remove(&offer_id);
            Err(format!("the device refused the files (HTTP {status})"))
        }
        Err(e) => {
            offers.outgoing.lock().unwrap().remove(&offer_id);
            Err(e.to_string())
        }
    }
}

/// Withdraw an offer we sent. Its files stop being served at once.
#[tauri::command]
pub async fn cancel_offer(
    state: tauri::State<'_, crate::commands::CliState>,
    offers: tauri::State<'_, Arc<OfferStore>>,
    offer_id: String,
) -> Result<(), String> {
    let offer = offers
        .update_outgoing(&offer_id, |o| {
            if !o.state.is_final() {
                o.state = OfferState::Cancelled;
            }
            o.clone()
        })
        .ok_or("no such offer")?;
    offers.emit_changed();
    let path = format!("/api/offers/{offer_id}/cancel");
    let _ = transport::post_json(&offer.peer_addr, &path, &serde_json::json!({}), &state.device_id, &state.identity_key).await;
    Ok(())
}

/// Pause or resume serving an accepted offer.
#[tauri::command]
pub fn pause_offer(offers: tauri::State<'_, Arc<OfferStore>>, offer_id: String, paused: bool) -> Result<(), String> {
    offers.update_outgoing(&offer_id, |o| o.paused = paused).ok_or("no such offer")?;
    offers.emit_changed();
    Ok(())
}

#[tauri::command]
pub fn list_offers(offers: tauri::State<'_, Arc<OfferStore>>) -> OffersSnapshot {
    offers.snapshot()
}

// ---------------------------------------------------------------------------
// Commands: receiving
// ---------------------------------------------------------------------------

/// Take some or all files of an incoming offer: each goes into the
/// download queue, which pulls them as slots come free.
#[tauri::command]
pub async fn accept_offer(
    state: tauri::State<'_, crate::commands::CliState>,
    offers: tauri::State<'_, Arc<OfferStore>>,
    transfers: tauri::State<'_, Arc<crate::transfers::TransferManager>>,
    offer_id: String,
    file_ids: Vec<String>,
) -> Result<(), String> {
    let offer = offers.incoming(&offer_id).ok_or("this offer is gone")?;
    if offer.state != OfferState::Waiting || now_ms() >= offer.expires_ms {
        return Err("this offer is no longer open".into());
    }
    let chosen: Vec<OfferFile> = offer.files.iter().filter(|f| file_ids.contains(&f.id)).cloned().collect();
    if chosen.is_empty() {
        return Err("choose at least one file".into());
    }

    let sandbox_root = PathBuf::from(&state.settings.read().map_err(|e| e.to_string())?.sandbox_path);
    let needed: u64 = chosen.iter().map(|f| f.size).sum();
    if let Ok(free) = fs2::available_space(&sandbox_root) {
        // Leave a little room: a disk filled to the last byte breaks more
        // than this download.
        if needed.saturating_add(64 * 1024 * 1024) > free {
            return Err(format!(
                "not enough space: needs {}, {} free",
                crate::fmt_bytes(needed),
                crate::fmt_bytes(free)
            ));
        }
    }

    let path = format!("/api/offers/{offer_id}/accept");
    let ids: Vec<&str> = chosen.iter().map(|f| f.id.as_str()).collect();
    let status = transport::post_json(&offer.peer_addr, &path, &serde_json::json!({ "file_ids": ids }), &state.device_id, &state.identity_key)
        .await
        .map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("the sender no longer offers these files (HTTP {status})"));
    }

    offers.update_incoming(&offer_id, |o| {
        o.state = OfferState::Accepted;
        o.accepted = chosen.iter().map(|f| f.id.clone()).collect();
        o.expires_ms = now_ms() + ACCEPTED_TTL_MS;
    });
    offers.emit_changed();
    for file in &chosen {
        transfers.enqueue(crate::transfers::Transfer::offer_file(&offer, file));
    }
    Ok(())
}

/// Let a failed file of an accepted offer be pulled again.
pub fn reopen_file(offers: &OfferStore, offer_id: &str, file_id: &str) -> Result<(), String> {
    offers
        .update_incoming(offer_id, |o| {
            if o.state != OfferState::Accepted {
                return Err("this offer is no longer active".to_string());
            }
            // Only a failure is undone; a finished file stays finished.
            if o.results.get(file_id).is_some_and(|r| r.outcome == "failed") {
                o.results.remove(file_id);
            }
            Ok(())
        })
        .ok_or("this offer is gone")??;
    offers.emit_changed();
    Ok(())
}

/// Turn an incoming offer down.
#[tauri::command]
pub async fn decline_offer(
    state: tauri::State<'_, crate::commands::CliState>,
    offers: tauri::State<'_, Arc<OfferStore>>,
    offer_id: String,
) -> Result<(), String> {
    let offer = offers.incoming(&offer_id).ok_or("this offer is gone")?;
    offers.update_incoming(&offer_id, |o| o.state = OfferState::Declined);
    offers.emit_changed();
    let path = format!("/api/offers/{offer_id}/decline");
    let _ = transport::post_json(&offer.peer_addr, &path, &serde_json::json!({}), &state.device_id, &state.identity_key).await;
    Ok(())
}

pub fn transfer_id(offer_id: &str, file_id: &str) -> String {
    format!("offer:{offer_id}:{file_id}")
}

/// A download of an offered file ended. Once every accepted file has, tell
/// the sender how each went -- again after a retry, which the sender
/// accepts for files that had failed.
pub fn file_ended(app: &tauri::AppHandle, offer_id: &str, file_id: &str, result: FileResult) {
    use tauri::Manager;
    let offers = app.state::<Arc<OfferStore>>().inner().clone();
    let offer = offers.update_incoming(offer_id, |o| {
        o.results.insert(file_id.to_string(), result);
        // Failures keep it open, so Retry can pull them again.
        if o.state == OfferState::Accepted && all_settled(&o.accepted, &o.results) {
            o.state = OfferState::Done;
        }
        o.clone()
    });
    offers.emit_changed();

    let ended = |o: &IncomingOffer| matches!(o.state, OfferState::Accepted | OfferState::Done) && o.remaining().is_empty();
    let Some(offer) = offer.filter(ended) else { return };
    let cli = app.state::<crate::commands::CliState>();
    let (device_id, key) = (cli.device_id.clone(), cli.identity_key.clone());
    let addr = cli.presence.addr_of(&offer.peer_id).unwrap_or(offer.peer_addr.clone());
    tauri::async_runtime::spawn(async move {
        let body = serde_json::json!({ "results": offer.results });
        let path = format!("/api/offers/{}/report", offer.id);
        let _ = transport::post_json(&addr, &path, &body, &device_id, &key).await;
    });
}

/// Run every 30 s: expire lapsed offers, and log unanswered ones we sent.
pub fn spawn_sweeper(offers: Arc<OfferStore>, history: Arc<crate::history::HistoryStore>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let expired = offers.sweep(now_ms());
            for offer in &expired {
                for f in &offer.files {
                    let mut entry = HistoryEntry::new(Direction::Sent, Initiator::Me, offer.peer_id.clone(), offer.peer_name.clone(), f.name.clone());
                    entry.outcome = Outcome::Cancelled;
                    entry.error = Some("not answered in time".into());
                    history.record(entry);
                }
            }
            offers.emit_changed();
        }
    });
}

/// Offer helpers for tests: register an outgoing offer directly.
#[cfg(test)]
pub fn insert_outgoing_for_test(store: &OfferStore, offer: OutgoingOffer) {
    store.outgoing.lock().unwrap().insert(offer.id.clone(), offer);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offered_names_are_reduced_to_a_bare_name() {
        assert_eq!(safe_file_name("photo.jpg").as_deref(), Some("photo.jpg"));
        assert_eq!(safe_file_name("../../etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(safe_file_name("C:\\Windows\\x.dll").as_deref(), Some("x.dll"));
        for bad in ["", "..", ".", ".hidden", "a\0b", "evil:stream", "dir/"] {
            assert_eq!(safe_file_name(bad), None, "{bad:?}");
        }
    }

    // ---- Protocol, against a real router with auth on ------------------

    use axum::http::Request;
    use rand::rngs::OsRng;
    use tower::ServiceExt;

    /// A sender server that has paired `receivers`, with one outgoing offer
    /// of two files to the first of them.
    fn sender_with_offer(
        dir: &tempfile::TempDir,
        receivers: &[&ed25519_dalek::SigningKey],
    ) -> (Arc<AppState>, axum::Router) {
        let mut store = crate::pairing::DeviceStore::new();
        for key in receivers {
            store.add_peer(crate::pairing::public_key_b64(key), &key.verifying_key(), None).unwrap();
        }
        std::fs::write(dir.path().join("a.txt"), b"alpha file").unwrap();
        std::fs::write(dir.path().join("b.txt"), b"beta").unwrap();

        let state = Arc::new(AppState {
            settings: Arc::new(std::sync::RwLock::new(crate::settings::AppSettings {
                display_name: "Sender".into(),
                sandbox_path: dir.path().to_string_lossy().into_owned(),
                ..Default::default()
            })),
            device_id: "sender".into(),
            identity_key: ed25519_dalek::SigningKey::generate(&mut OsRng),
            app_handle: None,
            presence: Arc::new(crate::presence::PresenceStore::new()),
            history: Arc::new(crate::history::HistoryStore::in_memory()),
            offers: Arc::new(OfferStore::default()),
            auth: Arc::new(crate::pairing::AuthState {
                store: Arc::new(std::sync::RwLock::new(store)),
                enabled: true,
                data_dir: None,
            }),
        });
        let now = now_ms();
        insert_outgoing_for_test(
            &state.offers,
            OutgoingOffer {
                id: "o1".into(),
                peer_id: crate::pairing::public_key_b64(receivers[0]),
                peer_name: None,
                peer_addr: "127.0.0.1:1".into(),
                files: vec![
                    OfferFile { id: "fa".into(), name: "a.txt".into(), size: 10, modified: None },
                    OfferFile { id: "fb".into(), name: "b.txt".into(), size: 4, modified: None },
                ],
                paths: HashMap::from([
                    ("fa".to_string(), dir.path().join("a.txt")),
                    ("fb".to_string(), dir.path().join("b.txt")),
                ]),
                state: OfferState::Waiting,
                paused: false,
                accepted: vec![],
                served: HashMap::new(),
                results: HashMap::new(),
                created_ms: now,
                expires_ms: now + PENDING_TTL_MS,
            },
        );
        (state.clone(), crate::server::build_router(state))
    }

    fn signed(
        method: &str,
        uri: &str,
        key: &ed25519_dalek::SigningKey,
        json: Option<serde_json::Value>,
    ) -> Request<axum::body::Body> {
        use base64::Engine;
        let id = crate::pairing::public_key_b64(key);
        let (ts, sig) = crate::pairing::sign_request(key, &id);
        let mut b = Request::builder()
            .method(method)
            .uri(uri)
            .header(crate::pairing::HEADER_DEVICE_ID, &id)
            .header(crate::pairing::HEADER_TIMESTAMP, ts.to_string())
            .header(
                crate::pairing::HEADER_SIGNATURE,
                base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()),
            );
        let body = match json {
            Some(v) => {
                b = b.header("content-type", "application/json");
                axum::body::Body::from(v.to_string())
            }
            None => axum::body::Body::empty(),
        };
        b.body(body).unwrap()
    }

    async fn body_of(res: Response) -> Vec<u8> {
        use http_body_util::BodyExt;
        res.into_body().collect().await.unwrap().to_bytes().to_vec()
    }

    #[tokio::test]
    async fn offered_files_are_served_only_after_acceptance_and_only_to_the_recipient() {
        let dir = tempfile::TempDir::new().unwrap();
        let receiver = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let other = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let (state, app) = sender_with_offer(&dir, &[&receiver, &other]);

        // Not before acceptance.
        let res = app.clone().oneshot(signed("GET", "/api/offers/o1/files/fa", &receiver, None)).await.unwrap();
        assert_eq!(res.status(), StatusCode::GONE);

        // Accept only file a; b is declined.
        let accept = serde_json::json!({ "file_ids": ["fa"] });
        let res = app.clone().oneshot(signed("POST", "/api/offers/o1/accept", &receiver, Some(accept))).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let log = state.history.list();
        assert!(log.iter().any(|e| e.file_name == "b.txt" && e.outcome == Outcome::Declined));

        // The recipient gets a; nobody gets b; another paired device gets nothing.
        let res = app.clone().oneshot(signed("GET", "/api/offers/o1/files/fa", &receiver, None)).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(body_of(res).await, b"alpha file");
        let res = app.clone().oneshot(signed("GET", "/api/offers/o1/files/fb", &receiver, None)).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        let res = app.clone().oneshot(signed("GET", "/api/offers/o1/files/fa", &other, None)).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);

        // Resumable like any download.
        let mut req = signed("GET", "/api/offers/o1/files/fa", &receiver, None);
        req.headers_mut().insert("range", "bytes=6-".parse().unwrap());
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(body_of(res).await, b"file");

        // Paused by the sender: come back later.
        state.offers.update_outgoing("o1", |o| o.paused = true);
        let res = app.clone().oneshot(signed("GET", "/api/offers/o1/files/fa", &receiver, None)).await.unwrap();
        assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
        state.offers.update_outgoing("o1", |o| o.paused = false);

        // The report closes the offer and logs the send.
        let report = serde_json::json!({ "results": { "fa": { "outcome": "completed", "dest_name": "a (1).txt" } } });
        let res = app.clone().oneshot(signed("POST", "/api/offers/o1/report", &receiver, Some(report))).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(state.offers.snapshot().outgoing[0].state, OfferState::Done);
        let sent = state.history.list().into_iter().find(|e| e.file_name == "a.txt").unwrap();
        assert_eq!((sent.outcome, sent.dest_name.as_deref()), (Outcome::Completed, Some("a (1).txt")));
    }

    #[tokio::test]
    async fn a_failed_file_can_be_retried_and_reported_again() {
        let dir = tempfile::TempDir::new().unwrap();
        let receiver = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let (state, app) = sender_with_offer(&dir, &[&receiver]);

        let accept = serde_json::json!({ "file_ids": ["fa"] });
        app.clone().oneshot(signed("POST", "/api/offers/o1/accept", &receiver, Some(accept))).await.unwrap();

        // First attempt failed: the offer stays open and the file servable.
        let failed = serde_json::json!({ "results": { "fa": { "outcome": "failed", "error": "network" } } });
        app.clone().oneshot(signed("POST", "/api/offers/o1/report", &receiver, Some(failed))).await.unwrap();
        assert_eq!(state.offers.snapshot().outgoing[0].state, OfferState::Accepted);
        let res = app.clone().oneshot(signed("GET", "/api/offers/o1/files/fa", &receiver, None)).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // The retry succeeded: now it is done.
        let ok = serde_json::json!({ "results": { "fa": { "outcome": "completed" } } });
        app.clone().oneshot(signed("POST", "/api/offers/o1/report", &receiver, Some(ok))).await.unwrap();
        assert_eq!(state.offers.snapshot().outgoing[0].state, OfferState::Done);
        let outcomes: Vec<_> = state.history.list().into_iter().filter(|e| e.file_name == "a.txt").map(|e| e.outcome).collect();
        assert!(outcomes.contains(&Outcome::Failed) && outcomes.contains(&Outcome::Completed), "{outcomes:?}");
    }

    #[tokio::test]
    async fn declining_closes_the_offer() {
        let dir = tempfile::TempDir::new().unwrap();
        let receiver = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let (state, app) = sender_with_offer(&dir, &[&receiver]);

        let res = app.clone().oneshot(signed("POST", "/api/offers/o1/decline", &receiver, None)).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(state.offers.snapshot().outgoing[0].state, OfferState::Declined);
        let res = app.oneshot(signed("GET", "/api/offers/o1/files/fa", &receiver, None)).await.unwrap();
        assert_eq!(res.status(), StatusCode::GONE);
    }

    #[tokio::test]
    async fn received_offers_with_unsafe_names_are_refused() {
        let dir = tempfile::TempDir::new().unwrap();
        let sender = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let (state, app) = sender_with_offer(&dir, &[&sender]);

        let offer = |name: &str| {
            serde_json::json!({ "offer_id": "in1", "files": [{ "id": "f", "name": name, "size": 3 }] })
        };
        let res = app.clone().oneshot(signed("POST", "/api/offers", &sender, Some(offer(".bashrc")))).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert!(state.offers.snapshot().incoming.is_empty());

        // A path is reduced to its bare name, which is fine. (No connect
        // info in oneshot tests, so the peer address comes from presence.)
        state.presence.set_addr(&crate::pairing::public_key_b64(&sender), "127.0.0.1:8377".into());
        let res = app.clone().oneshot(signed("POST", "/api/offers", &sender, Some(offer("../../notes.txt")))).await.unwrap();
        assert_eq!(res.status(), StatusCode::ACCEPTED);
        assert_eq!(state.offers.snapshot().incoming[0].files[0].name, "notes.txt");
    }

    #[test]
    fn sweep_expires_unanswered_offers() {
        let store = OfferStore::default();
        let offer = OutgoingOffer {
            id: "o1".into(),
            peer_id: "p".into(),
            peer_name: None,
            peer_addr: "127.0.0.1:1".into(),
            files: vec![OfferFile { id: "f".into(), name: "a".into(), size: 1, modified: None }],
            paths: HashMap::new(),
            state: OfferState::Waiting,
            paused: false,
            accepted: vec![],
            served: HashMap::new(),
            results: HashMap::new(),
            created_ms: 0,
            expires_ms: 100,
        };
        insert_outgoing_for_test(&store, offer);
        assert!(store.sweep(50).is_empty());
        let expired = store.sweep(100);
        assert_eq!(expired.len(), 1);
        assert_eq!(store.snapshot().outgoing[0].state, OfferState::Expired);
    }
}
