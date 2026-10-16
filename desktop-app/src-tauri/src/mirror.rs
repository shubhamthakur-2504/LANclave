//! Showing a paired phone's screen in a window of its own.
//!
//! The video itself is WebRTC between the phone and that window: encrypted,
//! direct, no relay. What travels here is only the setup, over the same
//! paired, TLS-protected API as everything else, so only a paired device can
//! be on the other end. On a LAN every candidate address is known at once,
//! so the offer and answer each go in one request, and nothing ever has to
//! reach the phone: this works with its server off.
//!
//! 1. `POST /api/mirror/sessions` -- the phone asks. A window opens here
//!    asking the user; the request is held until they answer.
//! 2. `POST /api/mirror/sessions/{id}/offer {sdp}` -- the window turns into
//!    the viewer, and its answer is the reply.
//! 3. Either side ends it: the phone with `/stop`, the user by closing the
//!    window, which drops the connection the phone is watching.

use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{oneshot, Notify};

use crate::server::AppState;

/// How long the user has to answer the prompt; the phone gives up too.
const DECISION_TIMEOUT: Duration = Duration::from_secs(60);
/// How long the window has to produce an answer once it has the offer.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(20);
/// Prompts open at once, from all phones together. Each phone gets one.
const MAX_PROMPTS: usize = 3;
/// How long a phone must wait to ask again after its 1st, 2nd, ... decline in
/// a row; the last repeats. Gentle at first, since a paired phone declined
/// once was likely a mis-tap or bad timing, and firm for one that keeps on.
const DECLINE_COOLDOWNS: [Duration; 4] = [
    Duration::from_secs(10),
    Duration::from_secs(60),
    Duration::from_secs(5 * 60),
    Duration::from_secs(30 * 60),
];
/// Quiet this long after a cooldown ends, and earlier declines are forgiven.
const FORGIVE_AFTER: Duration = Duration::from_secs(60 * 60);

/// Window labels are `mirror-<session id>`.
pub const WINDOW_PREFIX: &str = "mirror-";

/// WebView2 arguments; must match `additionalBrowserArgs` in
/// `tauri.conf.json` exactly, or this window cannot open beside the main
/// one (they share one WebView2 environment). The first three are wry's
/// defaults. The last makes WebRTC offer this machine's real addresses
/// instead of random `.local` names, which the phone cannot resolve: a phone
/// that is itself the hotspot otherwise has no way to reach the window.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,WebRtcHideLocalIpsWithMdns";

#[derive(Default)]
struct Session {
    peer_id: String,
    peer_name: String,
    /// Until the user answers the prompt.
    decide: Option<oneshot::Sender<bool>>,
    accepted: bool,
    offer: Option<String>,
    offer_ready: Arc<Notify>,
    /// Until the window answers the offer.
    answer: Option<oneshot::Sender<String>>,
}

/// A phone's recent declines.
#[derive(Clone, Copy)]
struct Declines {
    count: usize,
    until: Instant,
}

/// Why a phone may not ask right now.
#[derive(Debug, PartialEq)]
enum Refused {
    /// Its earlier prompt is still open.
    AlreadyAsking,
    /// Too many prompts are open, from all phones.
    TooMany,
    /// Declined recently; may ask again after this long.
    CoolingDown(Duration),
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        match self {
            Refused::AlreadyAsking => StatusCode::CONFLICT.into_response(),
            Refused::TooMany => StatusCode::TOO_MANY_REQUESTS.into_response(),
            Refused::CoolingDown(wait) => (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({ "retry_after_secs": wait.as_secs().max(1) })),
            )
                .into_response(),
        }
    }
}

#[derive(Default)]
pub struct MirrorHub {
    sessions: Mutex<HashMap<String, Session>>,
    /// Each phone's recent declines, for [DECLINE_COOLDOWNS].
    declined: Mutex<HashMap<String, Declines>>,
    app: Mutex<Option<tauri::AppHandle>>,
}

static HUB: OnceLock<MirrorHub> = OnceLock::new();

pub fn hub() -> &'static MirrorHub {
    HUB.get_or_init(MirrorHub::default)
}

impl MirrorHub {
    pub fn set_app_handle(&self, app: tauri::AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    fn app(&self) -> Option<tauri::AppHandle> {
        self.app.lock().unwrap().clone()
    }

    /// A new session for `peer_id`, and the channel its decision arrives
    /// on. Refused while that phone already has a prompt open, just after
    /// it was declined, or when too many prompts are open: a paired phone
    /// cannot bury the desktop in windows.
    fn open(&self, peer_id: &str, peer_name: &str) -> Result<(String, oneshot::Receiver<bool>), Refused> {
        if let Some(wait) = self.cooling_down(peer_id, Instant::now()) {
            return Err(Refused::CoolingDown(wait));
        }
        let mut sessions = self.sessions.lock().unwrap();
        let asking = || sessions.values().filter(|s| s.decide.is_some());
        if asking().any(|s| s.peer_id == peer_id) {
            return Err(Refused::AlreadyAsking);
        }
        if asking().count() >= MAX_PROMPTS {
            return Err(Refused::TooMany);
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let (tx, rx) = oneshot::channel();
        sessions.insert(
            id.clone(),
            Session {
                peer_id: peer_id.into(),
                peer_name: peer_name.into(),
                decide: Some(tx),
                ..Default::default()
            },
        );
        Ok((id, rx))
    }

    /// How long `peer_id` must still wait after being declined, if at all.
    fn cooling_down(&self, peer_id: &str, now: Instant) -> Option<Duration> {
        let mut declined = self.declined.lock().unwrap();
        let d = *declined.get(peer_id)?;
        if now >= d.until + FORGIVE_AFTER {
            declined.remove(peer_id);
            return None;
        }
        (d.until > now).then(|| d.until - now)
    }

    /// The user declined `peer_id`: it waits longer each time in a row.
    fn record_decline(&self, peer_id: &str, now: Instant) {
        let mut declined = self.declined.lock().unwrap();
        let count = match declined.get(peer_id) {
            Some(d) if now < d.until + FORGIVE_AFTER => d.count + 1,
            _ => 1,
        };
        let wait = DECLINE_COOLDOWNS[(count - 1).min(DECLINE_COOLDOWNS.len() - 1)];
        declined.insert(peer_id.to_string(), Declines { count, until: now + wait });
    }

    /// Sessions `peer_id` had before `current`. The phone shares with one
    /// laptop at a time, so a new request means those are over.
    fn earlier(&self, peer_id: &str, current: &str) -> Vec<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions.iter().filter(|(id, s)| s.peer_id == peer_id && *id != current).map(|(id, _)| id.clone()).collect()
    }

    /// The user answered the prompt. `false` when there was nothing to answer.
    pub fn decide(&self, id: &str, accept: bool) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
        let Some(session) = sessions.get_mut(id) else { return false };
        session.accepted = accept;
        session.decide.take().is_some_and(|tx| tx.send(accept).is_ok())
    }

    /// End a session from this side: the window closed, or the phone stopped.
    pub fn end(&self, id: &str) {
        if let Some(mut session) = self.sessions.lock().unwrap().remove(id) {
            if let Some(tx) = session.decide.take() {
                let _ = tx.send(false);
            }
        }
    }

    fn owner(&self, id: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(id).map(|s| s.peer_id.clone())
    }
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

fn open_window(id: &str, peer_name: &str) {
    let Some(app) = hub().app() else { return };
    let label = format!("{WINDOW_PREFIX}{id}");
    let url = tauri::WebviewUrl::App(format!("index.html?mirror={id}").into());
    // Its own window, titled after the phone, so a call's "share a window"
    // can pick it alone.
    let _ = tauri::WebviewWindowBuilder::new(&app, label, url)
        .title(format!("LANclave — {peer_name}"))
        .inner_size(440.0, 860.0)
        .min_inner_size(240.0, 320.0)
        .additional_browser_args(BROWSER_ARGS)
        .focused(true)
        .build();
}

fn close_window(id: &str) {
    let Some(app) = hub().app() else { return };
    use tauri::Manager;
    if let Some(window) = app.get_webview_window(&format!("{WINDOW_PREFIX}{id}")) {
        let _ = window.close();
    }
}

fn tell_window(id: &str, event: &str) {
    let Some(app) = hub().app() else { return };
    use tauri::Emitter;
    let _ = app.emit_to(format!("{WINDOW_PREFIX}{id}"), event, id.to_string());
}

/// A mirror window went away: the session ends with it.
pub fn window_destroyed(label: &str) {
    if let Some(id) = label.strip_prefix(WINDOW_PREFIX) {
        hub().end(id);
    }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

fn caller(state: &AppState, headers: &HeaderMap) -> Result<String, StatusCode> {
    crate::pairing::check_request(&state.auth, headers)
        .map_err(|s| StatusCode::from_u16(s.code()).expect("valid HTTP status"))
}

/// `POST /api/mirror/sessions` -- a paired phone asks to show its screen.
/// Held until the user answers: 200 with the session id, 403 declined, 408
/// no answer. Refused at once with 409 while its earlier prompt is open,
/// and 429 when declined recently (with `retry_after_secs`) or when too many
/// prompts are open.
pub async fn request_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let peer_id = caller(&state, &headers).map_err(IntoResponse::into_response)?;
    let peer_name = state.peer_name(&peer_id).unwrap_or_else(|| "A paired device".into());
    let (id, decision) = hub().open(&peer_id, &peer_name).map_err(IntoResponse::into_response)?;
    for old in hub().earlier(&peer_id, &id) {
        hub().end(&old);
        tell_window(&old, "mirror-ended");
    }
    // Ends the session and closes its prompt however this returns, including
    // when the phone gives up and the request is dropped mid-wait.
    let mut prompt = Prompt { id: &id, answered: false };
    open_window(&id, &peer_name);

    match tokio::time::timeout(DECISION_TIMEOUT, decision).await {
        Ok(Ok(true)) => {
            prompt.answered = true;
            // Accepted: whatever went before is forgiven.
            hub().declined.lock().unwrap().remove(&peer_id);
            Ok(Json(serde_json::json!({ "session_id": id })))
        }
        Ok(_) => {
            hub().record_decline(&peer_id, Instant::now());
            Err(StatusCode::FORBIDDEN.into_response())
        }
        Err(_) => Err(StatusCode::REQUEST_TIMEOUT.into_response()),
    }
}

/// A prompt the phone is waiting on. Unless it was accepted, the session
/// and its window go when this does.
struct Prompt<'a> {
    id: &'a str,
    answered: bool,
}

impl Drop for Prompt<'_> {
    fn drop(&mut self) {
        if !self.answered {
            hub().end(self.id);
            close_window(self.id);
        }
    }
}

#[derive(Deserialize, Serialize)]
pub struct Sdp {
    pub sdp: String,
}

/// `POST /api/mirror/sessions/{id}/offer` -- the phone's offer; the reply
/// is the window's answer.
pub async fn post_offer(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
    Json(offer): Json<Sdp>,
) -> Result<Json<Sdp>, StatusCode> {
    let peer_id = caller(&state, &headers)?;
    let answer = {
        let mut sessions = hub().sessions.lock().unwrap();
        let session = sessions.get_mut(&id).filter(|s| s.peer_id == peer_id).ok_or(StatusCode::NOT_FOUND)?;
        if !session.accepted {
            return Err(StatusCode::FORBIDDEN);
        }
        let (tx, rx) = oneshot::channel();
        session.offer = Some(offer.sdp);
        session.answer = Some(tx);
        session.offer_ready.notify_one();
        rx
    };
    match tokio::time::timeout(ANSWER_TIMEOUT, answer).await {
        Ok(Ok(sdp)) => Ok(Json(Sdp { sdp })),
        _ => Err(StatusCode::GATEWAY_TIMEOUT),
    }
}

/// `POST /api/mirror/sessions/{id}/stop` -- the phone stopped sharing.
pub async fn stop_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let peer_id = caller(&state, &headers)?;
    if hub().owner(&id).as_deref() == Some(peer_id.as_str()) {
        hub().end(&id);
        tell_window(&id, "mirror-ended");
    }
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// ---------------------------------------------------------------------------
// Commands, for the window
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct MirrorInfo {
    pub peer_id: String,
    pub peer_name: String,
}

/// Who is asking. `None` once the session is gone.
#[tauri::command]
pub fn mirror_info(id: String) -> Option<MirrorInfo> {
    let sessions = hub().sessions.lock().unwrap();
    sessions.get(&id).map(|s| MirrorInfo { peer_id: s.peer_id.clone(), peer_name: s.peer_name.clone() })
}

#[tauri::command]
pub fn mirror_decide(id: String, accept: bool) -> bool {
    hub().decide(&id, accept)
}

/// The phone's offer, once it arrives.
#[tauri::command]
pub async fn mirror_take_offer(id: String) -> Result<String, String> {
    let ready = {
        let sessions = hub().sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or("This sharing session has ended.")?;
        if let Some(offer) = &session.offer {
            return Ok(offer.clone());
        }
        session.offer_ready.clone()
    };
    tokio::time::timeout(Duration::from_secs(30), ready.notified())
        .await
        .map_err(|_| "The phone did not start sharing.".to_string())?;
    hub()
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .and_then(|s| s.offer.clone())
        .ok_or_else(|| "This sharing session has ended.".to_string())
}

#[tauri::command]
pub fn mirror_answer(id: String, sdp: String) -> bool {
    let mut sessions = hub().sessions.lock().unwrap();
    sessions
        .get_mut(&id)
        .and_then(|s| s.answer.take())
        .is_some_and(|tx| tx.send(sdp).is_ok())
}

/// The window is going: decline if still asking, end if showing.
#[tauri::command]
pub fn mirror_close(id: String) {
    hub().end(&id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_accepted_request_gets_the_windows_answer_to_its_offer() {
        let (id, decision) = hub().open("phone-a", "Galaxy A14").unwrap();
        assert!(hub().decide(&id, true));
        assert!(decision.await.unwrap());

        // The window waits for the offer while the phone sends it.
        let window = tokio::spawn({
            let id = id.clone();
            async move {
                let offer = mirror_take_offer(id.clone()).await.unwrap();
                assert_eq!(offer, "v=0 offer");
                assert!(mirror_answer(id, "v=0 answer".into()));
            }
        });
        let answer = {
            let mut sessions = hub().sessions.lock().unwrap();
            let session = sessions.get_mut(&id).unwrap();
            let (tx, rx) = oneshot::channel();
            session.offer = Some("v=0 offer".into());
            session.answer = Some(tx);
            session.offer_ready.notify_one();
            rx
        };
        assert_eq!(answer.await.unwrap(), "v=0 answer");
        window.await.unwrap();
        hub().end(&id);
    }

    #[tokio::test]
    async fn closing_the_window_before_answering_declines() {
        let (id, decision) = hub().open("phone-b", "Galaxy A14").unwrap();
        window_destroyed(&format!("{WINDOW_PREFIX}{id}"));
        assert!(!decision.await.unwrap());
        assert!(mirror_info(id).is_none());
    }

    #[test]
    fn a_session_can_only_be_answered_once() {
        let hub = MirrorHub::default();
        let (id, _decision) = hub.open("phone", "Galaxy A14").unwrap();
        assert!(hub.decide(&id, false));
        assert!(!hub.decide(&id, true));
    }

    #[test]
    fn a_phone_gets_one_prompt_at_a_time() {
        let hub = MirrorHub::default();
        let (id, _decision) = hub.open("phone", "Galaxy A14").unwrap();
        assert_eq!(hub.open("phone", "Galaxy A14").unwrap_err(), Refused::AlreadyAsking);
        hub.end(&id);
        assert!(hub.open("phone", "Galaxy A14").is_ok());
    }

    #[test]
    fn only_a_few_prompts_are_open_at_once() {
        let hub = MirrorHub::default();
        let mut waiting = Vec::new();
        for n in 0..MAX_PROMPTS {
            waiting.push(hub.open(&format!("phone-{n}"), "Galaxy A14").unwrap());
        }
        assert_eq!(hub.open("one-more", "Galaxy A14").unwrap_err(), Refused::TooMany);
        // An accepted session is no longer a prompt.
        assert!(hub.decide(&waiting[0].0, true));
        assert!(hub.open("one-more", "Galaxy A14").is_ok());
    }

    #[test]
    fn a_phone_declined_again_and_again_waits_longer_each_time() {
        let hub = MirrorHub::default();
        let mut now = Instant::now();
        for wait in DECLINE_COOLDOWNS {
            hub.record_decline("phone", now);
            assert_eq!(hub.cooling_down("phone", now), Some(wait));
            now += wait;
            assert_eq!(hub.cooling_down("phone", now), None);
        }
        // The longest wait repeats.
        hub.record_decline("phone", now);
        assert_eq!(hub.cooling_down("phone", now), Some(DECLINE_COOLDOWNS[3]));
    }

    #[test]
    fn a_declined_phone_is_told_how_long_to_wait() {
        let hub = MirrorHub::default();
        hub.record_decline("phone", Instant::now());
        match hub.open("phone", "Galaxy A14").unwrap_err() {
            Refused::CoolingDown(wait) => assert!(wait <= DECLINE_COOLDOWNS[0] && wait.as_secs() >= 9),
            other => panic!("expected a cooldown, got {other:?}"),
        }
    }

    #[test]
    fn declines_are_forgiven_after_a_quiet_hour() {
        let hub = MirrorHub::default();
        let now = Instant::now();
        hub.record_decline("phone", now);
        hub.record_decline("phone", now + DECLINE_COOLDOWNS[0]);
        let later = now + DECLINE_COOLDOWNS[0] + DECLINE_COOLDOWNS[1] + FORGIVE_AFTER;
        assert_eq!(hub.cooling_down("phone", later), None);
        hub.record_decline("phone", later);
        assert_eq!(hub.cooling_down("phone", later), Some(DECLINE_COOLDOWNS[0]));
    }

    #[test]
    fn a_prompt_nobody_waits_for_any_more_is_closed() {
        let (id, _decision) = hub().open("phone-f", "Galaxy A14").unwrap();
        drop(Prompt { id: &id, answered: false });
        assert!(mirror_info(id).is_none());

        let (id, _decision) = hub().open("phone-f", "Galaxy A14").unwrap();
        drop(Prompt { id: &id, answered: true });
        assert!(mirror_info(id.clone()).is_some());
        hub().end(&id);
    }

    #[test]
    fn the_window_opens_with_the_same_webview_arguments_as_the_main_one() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["app"]["windows"][0]["additionalBrowserArgs"], BROWSER_ARGS);
    }
}
