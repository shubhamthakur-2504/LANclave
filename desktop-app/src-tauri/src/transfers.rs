//! Every transfer this computer runs, and the one scheduler that runs them
//! (docs/transfer-plan.md P6).
//!
//! The list lives here rather than in the page, so the page can come and go
//! (P7) and paused downloads can outlive the app (P5).
//!
//! Downloads -- pulls from a peer's sandbox and files of accepted offers --
//! share `max_downloads` slots (a setting, default 2); the rest wait in one
//! queue, so one big offer cannot starve everything else.
//! - Pausing frees the slot, and the next waiting download starts.
//! - Resuming goes to the front of the queue without interrupting a running
//!   download: it takes the next free slot.
//! - A download the sender paused (503) steps out of its slot and rejoins
//!   the queue after a few seconds.
//!
//! Uploads the old way (legacy push, to peers without offers) are listed
//! here too but sit outside the limit: the sender drives them.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, watch};

use crate::client::pull::{PullSource, StopReason, TransferOutcome, TransferProgressEvent};
use crate::client::ClientError;
use crate::history::{Direction, HistoryEntry, HistoryStore, Initiator, Outcome};
use crate::offers::{FileResult, IncomingOffer, OfferFile, OfferState};
use crate::presence::now_ms;
use crate::settings::AppSettings;

/// How long a download the sender paused waits before asking again.
const SENDER_PAUSE_MS: u64 = 5_000;
/// Network drops retried in place, with backoff, before a download fails.
const NETWORK_RETRIES: u32 = 5;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Waiting for a slot.
    Queued,
    InProgress,
    Verifying,
    Paused,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Way {
    Download,
    Upload,
}

/// One row of the Transfers list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transfer {
    pub id: String,
    pub file_name: String,
    pub file_size: u64,
    pub peer_id: String,
    pub peer_name: Option<String>,
    pub direction: Way,
    pub progress: u64,
    pub status: Status,
    /// Completed without moving a byte: an identical copy was already there.
    #[serde(default)]
    pub skipped: bool,
    /// Name at the destination, when the transfer finished.
    #[serde(default)]
    pub dest_name: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// Why it is waiting or paused: "Paused by sender", "Waiting for network".
    #[serde(default)]
    pub message: Option<String>,
    pub started_ms: u64,
    /// Queued downloads: how many wait ahead of this one. Set in snapshots.
    #[serde(default)]
    pub ahead: Option<usize>,
    // What to run: a sandbox pull has the paths, an offer file its ids.
    #[serde(default)]
    pub peer_addr: Option<String>,
    #[serde(default)]
    pub remote_path: Option<String>,
    #[serde(default)]
    pub local_path: Option<String>,
    #[serde(default)]
    pub offer_id: Option<String>,
    #[serde(default)]
    pub offer_file_id: Option<String>,
    /// A sender pause holds it back until this time (ms).
    #[serde(skip)]
    not_before: u64,
}

impl Transfer {
    fn new(id: String, file_name: String, file_size: u64, peer_id: String, peer_name: Option<String>, direction: Way) -> Self {
        Self {
            id,
            file_name,
            file_size,
            peer_id,
            peer_name,
            direction,
            progress: 0,
            status: Status::Queued,
            skipped: false,
            dest_name: None,
            error: None,
            message: None,
            started_ms: now_ms(),
            ahead: None,
            peer_addr: None,
            remote_path: None,
            local_path: None,
            offer_id: None,
            offer_file_id: None,
            not_before: 0,
        }
    }

    /// A file from a peer's shared sandbox, saved as `local_path`.
    pub fn sandbox_pull(
        peer_addr: String,
        peer_id: String,
        peer_name: Option<String>,
        remote_path: String,
        local_path: String,
        size: Option<u64>,
    ) -> Self {
        let mut t = Self::new(
            uuid::Uuid::new_v4().to_string(),
            remote_path.clone(),
            size.unwrap_or(0),
            peer_id,
            peer_name,
            Way::Download,
        );
        t.peer_addr = Some(peer_addr);
        t.remote_path = Some(remote_path);
        t.local_path = Some(local_path);
        t
    }

    /// One file of an accepted incoming offer.
    pub fn offer_file(offer: &IncomingOffer, file: &OfferFile) -> Self {
        let mut t = Self::new(
            crate::offers::transfer_id(&offer.id, &file.id),
            file.name.clone(),
            file.size,
            offer.peer_id.clone(),
            offer.peer_name.clone(),
            Way::Download,
        );
        t.peer_addr = Some(offer.peer_addr.clone());
        t.offer_id = Some(offer.id.clone());
        t.offer_file_id = Some(file.id.clone());
        t
    }

    /// A legacy push of `local_path` to the peer's `remote_path`.
    pub fn upload(
        peer_addr: String,
        peer_id: String,
        peer_name: Option<String>,
        local_path: String,
        remote_path: String,
        size: u64,
    ) -> Self {
        let mut t = Self::new(uuid::Uuid::new_v4().to_string(), remote_path.clone(), size, peer_id, peer_name, Way::Upload);
        t.status = Status::InProgress;
        t.peer_addr = Some(peer_addr);
        t.remote_path = Some(remote_path);
        t.local_path = Some(local_path);
        t
    }

    fn is_open(&self) -> bool {
        !matches!(self.status, Status::Completed | Status::Failed)
    }
}

/// How one run of a download (or an upload) ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum End {
    Done { skipped: bool, bytes: u64, dest_name: String },
    /// The user paused it; the partial file is kept.
    Paused,
    /// The sender answered 503: step out, ask again shortly.
    SenderPaused,
    Cancelled,
    Failed(String),
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

type StopTx = watch::Sender<Option<StopReason>>;
type StopRx = watch::Receiver<Option<StopReason>>;

/// Rows, the waiting queue and the running slots. No Tauri in here, so the
/// scheduling rules can be tested directly.
#[derive(Default)]
struct Inner {
    /// Newest first.
    rows: Vec<Transfer>,
    /// Queued downloads in the order they will start.
    waiting: VecDeque<String>,
    /// Downloads holding a slot, with the handle that stops them.
    running: HashMap<String, StopTx>,
    /// Legacy pushes, outside the limit.
    uploads: HashMap<String, Arc<AtomicBool>>,
}

impl Inner {
    fn row(&self, id: &str) -> Option<&Transfer> {
        self.rows.iter().find(|r| r.id == id)
    }

    fn row_mut(&mut self, id: &str) -> Option<&mut Transfer> {
        self.rows.iter_mut().find(|r| r.id == id)
    }

    fn add(&mut self, row: Transfer) {
        self.rows.retain(|r| r.id != row.id);
        self.rows.insert(0, row);
    }

    /// Put a queued download in line: at the front for a resume, at the back
    /// for anything new.
    fn queue(&mut self, id: &str, front: bool) {
        self.waiting.retain(|w| w != id);
        if front {
            self.waiting.push_front(id.to_string());
        } else {
            self.waiting.push_back(id.to_string());
        }
    }

    /// The downloads to start now: the first ready ones in the queue, as
    /// many as there are free slots. Each is marked running and gets its
    /// stop handle.
    fn take_startable(&mut self, max: usize, now: u64) -> Vec<(String, StopRx)> {
        let mut started = Vec::new();
        let mut i = 0;
        while self.running.len() < max && i < self.waiting.len() {
            let id = self.waiting[i].clone();
            match self.row(&id).map(|r| (r.status, r.not_before)) {
                Some((Status::Queued, not_before)) if not_before > now => i += 1, // cooling down
                Some((Status::Queued, _)) => {
                    self.waiting.remove(i);
                    let (tx, rx) = watch::channel(None);
                    self.running.insert(id.clone(), tx);
                    if let Some(row) = self.row_mut(&id) {
                        row.status = Status::InProgress;
                        row.message = None;
                    }
                    started.push((id, rx));
                }
                // Not waiting any more (paused, cancelled, gone).
                _ => {
                    self.waiting.remove(i);
                }
            }
        }
        started
    }

    /// When the earliest cooling-down download becomes ready, if any waits.
    fn next_ready_at(&self, now: u64) -> Option<u64> {
        self.waiting
            .iter()
            .filter_map(|id| self.row(id))
            .filter(|r| r.status == Status::Queued && r.not_before > now)
            .map(|r| r.not_before)
            .min()
    }

    fn snapshot(&self) -> Vec<Transfer> {
        self.rows
            .iter()
            .map(|r| {
                let mut r = r.clone();
                r.ahead = if r.status == Status::Queued {
                    self.waiting.iter().position(|w| *w == r.id)
                } else {
                    None
                };
                r
            })
            .collect()
    }

    /// Apply how a run ended to its row; frees its slot. `None` if the row
    /// is gone (discarded while it ran).
    fn apply_end(&mut self, id: &str, end: &End, now: u64) -> Option<Transfer> {
        self.running.remove(id);
        self.uploads.remove(id);
        let row = self.row_mut(id)?;
        row.message = None;
        match end {
            End::Done { skipped, bytes, dest_name } => {
                row.status = Status::Completed;
                row.skipped = *skipped;
                row.progress = *bytes;
                row.file_size = row.file_size.max(*bytes);
                row.dest_name = Some(dest_name.clone());
                row.error = None;
            }
            End::Paused => row.status = Status::Paused,
            End::SenderPaused => {
                row.status = Status::Queued;
                row.message = Some("Paused by sender".into());
                row.not_before = now + SENDER_PAUSE_MS;
            }
            End::Cancelled => {
                row.status = Status::Failed;
                row.error = Some("Transfer cancelled".into());
            }
            End::Failed(e) => {
                row.status = Status::Failed;
                row.error = Some(e.clone());
            }
        }
        let row = row.clone();
        if *end == End::SenderPaused {
            self.queue(id, false);
        }
        Some(row)
    }
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

pub struct TransferManager {
    inner: Mutex<Inner>,
    settings: Arc<RwLock<AppSettings>>,
    history: Arc<HistoryStore>,
    app: Mutex<Option<tauri::AppHandle>>,
    /// When a timer is already set to start a cooled-down download.
    wake_at: Mutex<Option<u64>>,
}

impl TransferManager {
    pub fn new(settings: Arc<RwLock<AppSettings>>, history: Arc<HistoryStore>) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            settings,
            history,
            app: Mutex::new(None),
            wake_at: Mutex::new(None),
        }
    }

    pub fn set_app_handle(&self, app: tauri::AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    fn app(&self) -> Option<tauri::AppHandle> {
        self.app.lock().unwrap().clone()
    }

    fn max_downloads(&self) -> usize {
        self.settings.read().map(|s| s.max_downloads).unwrap_or(2).clamp(1, 8)
    }

    fn sandbox_root(&self) -> PathBuf {
        PathBuf::from(self.settings.read().map(|s| s.sandbox_path.clone()).unwrap_or_default())
    }

    pub fn snapshot(&self) -> Vec<Transfer> {
        self.inner.lock().unwrap().snapshot()
    }

    pub fn get(&self, id: &str) -> Option<Transfer> {
        self.inner.lock().unwrap().row(id).cloned()
    }

    /// Tell the page the list changed.
    fn changed(&self) {
        if let Some(app) = self.app() {
            use tauri::Emitter;
            let _ = app.emit("transfers-changed", self.snapshot());
        }
    }

    /// Put a download in the queue; it starts when a slot is free.
    pub fn enqueue(&self, row: Transfer) -> String {
        let id = row.id.clone();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.add(row);
            inner.queue(&id, false);
        }
        self.changed();
        self.pump();
        id
    }

    /// A download into `local_path` that has not ended yet. Two downloads
    /// into one destination would share, and wreck, one partial file.
    pub fn open_pull_into(&self, local_path: &str) -> Option<Transfer> {
        let inner = self.inner.lock().unwrap();
        inner
            .rows
            .iter()
            .find(|r| r.direction == Way::Download && r.offer_id.is_none() && r.local_path.as_deref() == Some(local_path) && (r.is_open() || r.status == Status::Failed))
            .cloned()
    }

    /// List a legacy push; `cancel` stops it.
    pub fn add_upload(&self, row: Transfer, cancel: Arc<AtomicBool>) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.uploads.insert(row.id.clone(), cancel);
            inner.add(row);
        }
        self.changed();
    }

    /// Stop a download, keeping what arrived. A waiting one leaves the queue.
    pub fn pause(&self, id: &str) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(stop) = inner.running.get(id) {
                let _ = stop.send(Some(StopReason::Pause));
                return Ok(()); // the run ends as paused
            }
            if inner.uploads.contains_key(id) {
                return Err("sending can't be paused".into());
            }
            let row = inner.row_mut(id).ok_or("no such transfer")?;
            if row.status != Status::Queued {
                return Ok(());
            }
            row.status = Status::Paused;
            row.message = None;
            inner.waiting.retain(|w| w != id);
        }
        self.changed();
        Ok(())
    }

    /// Continue a paused or failed download: to the front of the queue.
    pub fn resume(&self, id: &str) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().unwrap();
            let row = inner.row_mut(id).ok_or("no such transfer")?;
            if row.direction != Way::Download || !matches!(row.status, Status::Paused | Status::Failed) {
                return Ok(());
            }
            row.status = Status::Queued;
            row.error = None;
            row.message = None;
            row.not_before = 0;
            inner.queue(id, true);
        }
        self.changed();
        self.pump();
        Ok(())
    }

    /// Stop a transfer for good and drop its partial file.
    pub fn cancel(&self, id: &str) {
        {
            let inner = self.inner.lock().unwrap();
            if let Some(stop) = inner.running.get(id) {
                let _ = stop.send(Some(StopReason::Cancel));
                return; // the run ends as cancelled
            }
            if let Some(flag) = inner.uploads.get(id) {
                flag.store(true, Ordering::Relaxed);
                return;
            }
            match inner.row(id) {
                Some(r) if r.is_open() => {}
                _ => return,
            }
        }
        self.end(id, End::Cancelled);
    }

    /// Cancel every open download of an offer (the sender withdrew it).
    pub fn cancel_offer(&self, offer_id: &str) {
        let ids: Vec<String> = {
            let inner = self.inner.lock().unwrap();
            inner.rows.iter().filter(|r| r.offer_id.as_deref() == Some(offer_id) && r.is_open()).map(|r| r.id.clone()).collect()
        };
        for id in ids {
            self.cancel(&id);
        }
    }

    /// Forget a transfer and its partial file (the user chose Discard). An
    /// offer file counts as skipped, so the offer can still finish.
    pub fn discard(&self, id: &str) {
        let row = {
            let mut inner = self.inner.lock().unwrap();
            if let Some(stop) = inner.running.get(id) {
                let _ = stop.send(Some(StopReason::Cancel));
            }
            if let Some(flag) = inner.uploads.get(id) {
                flag.store(true, Ordering::Relaxed);
            }
            inner.waiting.retain(|w| w != id);
            let Some(pos) = inner.rows.iter().position(|r| r.id == id) else { return };
            inner.rows.remove(pos)
        };
        if row.direction == Way::Download {
            self.discard_partial(&row);
            if row.status != Status::Completed {
                self.offer_file_ended(&row, &End::Cancelled);
            }
        }
        self.changed();
    }

    /// Progress from a running transfer: update its row and pass it on.
    pub fn on_event(&self, e: &TransferProgressEvent) {
        let status = match e.status.as_str() {
            "in_progress" => Status::InProgress,
            "verifying" => Status::Verifying,
            // Endings arrive through `end`, once, with the full story.
            _ => return,
        };
        let status_changed = {
            let mut inner = self.inner.lock().unwrap();
            let Some(row) = inner.row_mut(&e.id) else { return };
            row.progress = e.bytes_transferred;
            if e.total_bytes > 0 {
                row.file_size = e.total_bytes;
            }
            row.message = None;
            std::mem::replace(&mut row.status, status) != status
        };
        if let Some(app) = self.app() {
            use tauri::Emitter;
            let _ = app.emit("transfer-progress", e.clone());
        }
        if status_changed {
            self.changed();
        }
    }

    fn set_message(&self, id: &str, message: &str) {
        if let Some(row) = self.inner.lock().unwrap().row_mut(id) {
            row.message = Some(message.to_string());
        }
        self.changed();
    }

    /// A run ended: record it, tell the offer, free the slot, start the next.
    pub fn end(&self, id: &str, end: End) {
        let row = self.inner.lock().unwrap().apply_end(id, &end, now_ms());
        if let Some(row) = &row {
            if matches!(end, End::Done { .. } | End::Cancelled | End::Failed(_)) {
                self.record(row, &end);
                self.offer_file_ended(row, &end);
            }
            if end == End::Cancelled && row.direction == Way::Download {
                self.discard_partial(row);
            }
            if matches!(end, End::Done { .. } | End::Failed(_)) {
                if let Some(app) = self.app() {
                    use tauri::Emitter;
                    let _ = app.emit("transfer-ended", row);
                }
            }
        }
        self.changed();
        self.pump();
    }

    fn record(&self, row: &Transfer, end: &End) {
        let (direction, initiator) = match (row.direction, row.offer_id.is_some()) {
            (Way::Upload, _) => (Direction::Sent, Initiator::Me),
            (Way::Download, true) => (Direction::Received, Initiator::Peer),
            (Way::Download, false) => (Direction::Received, Initiator::Me),
        };
        let mut entry = HistoryEntry::new(direction, initiator, row.peer_id.clone(), row.peer_name.clone(), row.file_name.clone());
        match end {
            End::Done { skipped, bytes, dest_name } => {
                entry.outcome = if *skipped { Outcome::Skipped } else { Outcome::Completed };
                entry.bytes = *bytes;
                entry.dest_name = Some(dest_name.clone()).filter(|d| *d != row.file_name);
            }
            End::Failed(e) => {
                entry.outcome = Outcome::Failed;
                entry.error = Some(e.clone());
            }
            _ => entry.outcome = Outcome::Cancelled,
        }
        self.history.record(entry);
    }

    fn offer_file_ended(&self, row: &Transfer, end: &End) {
        let (Some(offer_id), Some(file_id)) = (&row.offer_id, &row.offer_file_id) else { return };
        let result = match end {
            End::Done { skipped, dest_name, .. } => FileResult {
                outcome: if *skipped { "skipped" } else { "completed" }.into(),
                dest_name: Some(dest_name.clone()),
                error: None,
            },
            End::Failed(e) => FileResult { outcome: "failed".into(), dest_name: None, error: Some(e.clone()) },
            _ => FileResult { outcome: "cancelled".into(), dest_name: None, error: None },
        };
        if let Some(app) = self.app() {
            crate::offers::file_ended(&app, offer_id, file_id, result);
        }
    }

    fn discard_partial(&self, row: &Transfer) {
        if let Ok((_, dest, _)) = job_source(&self.sandbox_root(), row) {
            tauri::async_runtime::spawn(async move {
                crate::client::pull::discard_partial_for(&dest).await;
            });
        }
    }

    /// Start whatever the free slots allow, and set a timer for downloads
    /// the sender paused.
    pub fn pump(&self) {
        let Some(app) = self.app() else { return };
        let now = now_ms();
        let (started, ready_at) = {
            let mut inner = self.inner.lock().unwrap();
            (inner.take_startable(self.max_downloads(), now), inner.next_ready_at(now))
        };
        if !started.is_empty() {
            self.changed();
        }
        for (id, stop) in started {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { run(app, id, stop).await });
        }
        if let Some(at) = ready_at {
            let mut wake = self.wake_at.lock().unwrap();
            if !wake.is_some_and(|w| w > now && w <= at) {
                *wake = Some(at);
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(at.saturating_sub(now))).await;
                    use tauri::Manager;
                    let manager = app.state::<Arc<TransferManager>>().inner().clone();
                    *manager.wake_at.lock().unwrap() = None;
                    manager.pump();
                });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Running one download
// ---------------------------------------------------------------------------

/// Where a download reads from, where it lands, and how big it should be.
fn job_source(root: &Path, row: &Transfer) -> Result<(PullSource, PathBuf, Option<u64>), String> {
    if let (Some(o), Some(f)) = (&row.offer_id, &row.offer_file_id) {
        let source = PullSource {
            path: format!("/api/offers/{o}/files/{f}"),
            fingerprint_path: Some(format!("/api/offers/{o}/files/{f}/fingerprint")),
        };
        // Offered names were reduced to a bare, safe name on arrival.
        return Ok((source, root.join(&row.file_name), Some(row.file_size)));
    }
    let remote = row.remote_path.as_deref().ok_or("nothing to download")?;
    let local = row.local_path.as_deref().unwrap_or(remote);
    let dest = crate::sandbox::validate_sandboxed_path(root, local).map_err(|e| format!("invalid save path: {e}"))?;
    Ok((PullSource::sandbox(remote), dest, (row.file_size > 0).then_some(row.file_size)))
}

async fn run(app: tauri::AppHandle, id: String, stop: StopRx) {
    use tauri::Manager;
    let manager = app.state::<Arc<TransferManager>>().inner().clone();
    let end = match manager.get(&id) {
        Some(row) => download(&app, &manager, &row, stop).await,
        None => End::Cancelled,
    };
    manager.end(&id, end);
}

/// Pull one file, riding out network drops. Resumes from the partial file
/// every time, so a retry costs only what was lost.
async fn download(app: &tauri::AppHandle, manager: &Arc<TransferManager>, row: &Transfer, mut stop: StopRx) -> End {
    use tauri::Manager;
    let cli = app.state::<crate::commands::CliState>();
    let (source, dest, size) = match job_source(&manager.sandbox_root(), row) {
        Ok(v) => v,
        Err(e) => return End::Failed(e),
    };

    let mut retries = 0u32;
    loop {
        if let Some(offer_id) = &row.offer_id {
            match cli.offers.incoming(offer_id).map(|o| o.state) {
                Some(OfferState::Accepted) => {}
                Some(OfferState::Expired) => return End::Failed("the offer expired".into()),
                _ => return End::Cancelled, // withdrawn, or gone
            }
        }
        if let Some(reason) = *stop.borrow() {
            return stopped(reason);
        }

        // The sender's address can change mid-transfer (hotspot DHCP);
        // presence follows it.
        let addr = cli.presence.addr_of(&row.peer_id).or_else(|| row.peer_addr.clone()).unwrap_or_default();
        let result = crate::client::pull::pull_from_source(
            &row.id,
            &addr,
            &source,
            &dest,
            size,
            &cli.device_id,
            &cli.identity_key,
            stop_signal(&stop),
            |e| manager.on_event(e),
        )
        .await;

        match result {
            Ok(r) => {
                return match r.outcome {
                    TransferOutcome::Paused => End::Paused,
                    outcome => End::Done {
                        skipped: outcome == TransferOutcome::AlreadyPresent,
                        bytes: r.bytes,
                        dest_name: r.dest_name,
                    },
                }
            }
            Err(ClientError::ServerRejected(503)) => return End::SenderPaused,
            Err(ClientError::ConnectionFailed(_)) | Err(ClientError::HttpError(_)) if retries < NETWORK_RETRIES => {
                retries += 1;
                manager.set_message(&row.id, "Waiting for network");
                let wait = std::time::Duration::from_secs(2u64.pow(retries).min(30));
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    _ = stop.changed() => {}
                }
            }
            Err(e) => {
                let message = e.to_string();
                return if message.contains("cancelled") {
                    End::Cancelled
                } else if message.contains("paused") {
                    End::Paused
                } else {
                    End::Failed(message)
                };
            }
        }
    }
}

fn stopped(reason: StopReason) -> End {
    match reason {
        StopReason::Pause => End::Paused,
        StopReason::Cancel => End::Cancelled,
    }
}

/// A one-shot stop for one pull attempt, fed by the download's lasting stop
/// handle. The sender is held until the pull ends, so a pull is never
/// cancelled by its channel closing.
fn stop_signal(stop: &StopRx) -> oneshot::Receiver<StopReason> {
    let (mut tx, rx) = oneshot::channel();
    let mut stop = stop.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Some(reason) = *stop.borrow_and_update() {
                let _ = tx.send(reason);
                return;
            }
            tokio::select! {
                changed = stop.changed() => if changed.is_err() {
                    tx.closed().await;
                    return;
                },
                _ = tx.closed() => return,
            }
        }
    });
    rx
}

/// How a legacy push ended, from its result.
pub fn upload_end(result: &Result<crate::client::pull::TransferReport, ClientError>) -> End {
    match result {
        Ok(r) => End::Done {
            skipped: r.outcome == TransferOutcome::AlreadyPresent,
            bytes: r.bytes,
            dest_name: r.dest_name.clone(),
        },
        Err(e) if e.to_string().contains("cancelled") => End::Cancelled,
        Err(e) => End::Failed(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_transfers(transfers: tauri::State<'_, Arc<TransferManager>>) -> Vec<Transfer> {
    transfers.snapshot()
}

#[tauri::command]
pub fn pause_transfer(transfers: tauri::State<'_, Arc<TransferManager>>, transfer_id: String) -> Result<(), String> {
    transfers.pause(&transfer_id)
}

#[tauri::command]
pub fn cancel_transfer(transfers: tauri::State<'_, Arc<TransferManager>>, transfer_id: String) {
    transfers.cancel(&transfer_id);
}

/// Continue a paused download, or try a failed one again.
#[tauri::command]
pub fn resume_transfer(
    transfers: tauri::State<'_, Arc<TransferManager>>,
    offers: tauri::State<'_, Arc<crate::offers::OfferStore>>,
    transfer_id: String,
) -> Result<(), String> {
    let row = transfers.get(&transfer_id).ok_or("no such transfer")?;
    if let (Some(offer_id), Some(file_id)) = (&row.offer_id, &row.offer_file_id) {
        crate::offers::reopen_file(&offers, offer_id, file_id)?;
    }
    transfers.resume(&transfer_id)
}

/// Drop a paused or failed download and its partial file.
#[tauri::command]
pub fn discard_transfer(transfers: tauri::State<'_, Arc<TransferManager>>, transfer_id: String) {
    transfers.discard(&transfer_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pull(name: &str) -> Transfer {
        Transfer::sandbox_pull("127.0.0.1:1".into(), "peer".into(), None, name.into(), name.into(), Some(10))
    }

    fn started(inner: &mut Inner, max: usize) -> Vec<String> {
        inner.take_startable(max, 1_000).into_iter().map(|(id, _)| id).collect()
    }

    /// Queue `names` in order; returns their ids.
    fn queued(inner: &mut Inner, names: &[&str]) -> Vec<String> {
        names
            .iter()
            .map(|n| {
                let row = pull(n);
                let id = row.id.clone();
                inner.add(row);
                inner.queue(&id, false);
                id
            })
            .collect()
    }

    #[test]
    fn at_most_max_run_and_the_rest_wait_in_order() {
        let mut inner = Inner::default();
        let ids = queued(&mut inner, &["a", "b", "c", "d"]);
        assert_eq!(started(&mut inner, 2), vec![ids[0].clone(), ids[1].clone()]);
        assert!(started(&mut inner, 2).is_empty(), "no free slot");

        let snap = inner.snapshot();
        let ahead = |id: &str| snap.iter().find(|r| r.id == id).unwrap().ahead;
        assert_eq!((ahead(&ids[2]), ahead(&ids[3])), (Some(0), Some(1)));
        assert_eq!(ahead(&ids[0]), None, "running rows have no place in line");
    }

    #[test]
    fn a_pause_frees_the_slot_for_the_next_waiting_download() {
        let mut inner = Inner::default();
        let ids = queued(&mut inner, &["a", "b", "c"]);
        started(&mut inner, 2);

        inner.apply_end(&ids[0], &End::Paused, 1_000);
        assert_eq!(started(&mut inner, 2), vec![ids[2].clone()]);
        assert_eq!(inner.row(&ids[0]).unwrap().status, Status::Paused);
    }

    #[test]
    fn a_resume_goes_to_the_front_without_interrupting_anyone() {
        let mut inner = Inner::default();
        let ids = queued(&mut inner, &["a", "b", "c", "d"]);
        started(&mut inner, 2); // a, b run; c, d wait
        inner.apply_end(&ids[0], &End::Paused, 1_000);
        // Before anything else starts, a is resumed: it jumps the queue.
        inner.row_mut(&ids[0]).unwrap().status = Status::Queued;
        inner.queue(&ids[0], true);
        assert_eq!(started(&mut inner, 2), vec![ids[0].clone()]);
        assert!(inner.running.contains_key(&ids[1]), "b kept running");
        assert_eq!(inner.waiting, VecDeque::from(vec![ids[2].clone(), ids[3].clone()]));
    }

    #[test]
    fn a_sender_pause_steps_out_and_waits_its_turn_again() {
        let mut inner = Inner::default();
        let ids = queued(&mut inner, &["a", "b"]);
        assert_eq!(started(&mut inner, 1), vec![ids[0].clone()]);

        inner.apply_end(&ids[0], &End::SenderPaused, 1_000);
        let row = inner.row(&ids[0]).unwrap();
        assert_eq!((row.status, row.message.as_deref()), (Status::Queued, Some("Paused by sender")));
        // b takes the slot; a is not retried until its delay is over.
        assert_eq!(started(&mut inner, 1), vec![ids[1].clone()]);
        inner.apply_end(&ids[1], &End::Failed("x".into()), 1_000);
        assert!(inner.take_startable(1, 1_000 + SENDER_PAUSE_MS - 1).is_empty());
        assert_eq!(inner.next_ready_at(1_000), Some(1_000 + SENDER_PAUSE_MS));
        let later: Vec<_> = inner.take_startable(1, 1_000 + SENDER_PAUSE_MS).into_iter().map(|(id, _)| id).collect();
        assert_eq!(later, vec![ids[0].clone()]);
    }

    #[test]
    fn rows_that_stopped_waiting_are_dropped_from_the_queue() {
        let mut inner = Inner::default();
        let ids = queued(&mut inner, &["a", "b"]);
        inner.row_mut(&ids[0]).unwrap().status = Status::Paused;
        assert_eq!(started(&mut inner, 2), vec![ids[1].clone()]);
        assert!(inner.waiting.is_empty());
    }

    #[test]
    fn stop_handles_reach_the_running_download() {
        let mut inner = Inner::default();
        let ids = queued(&mut inner, &["a"]);
        let (id, rx) = inner.take_startable(1, 0).pop().unwrap();
        assert_eq!(id, ids[0]);
        inner.running[&id].send(Some(StopReason::Pause)).unwrap();
        assert_eq!(*rx.borrow(), Some(StopReason::Pause));
    }
}
