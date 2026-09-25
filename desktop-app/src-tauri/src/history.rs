//! Transfer history: who sent or pulled which file, kept for 30 days.
//!
//! Each device logs every transfer from its own point of view -- the ones it
//! started (`initiated_by: "me"`) and the ones a peer started against its
//! server (`"peer"`) -- so sender and receiver each hold a record.
//!
//! Stored as JSON lines in the app data folder: appending one transfer is
//! one short write, and the file is only rewritten when pruning drops
//! entries past [`RETENTION_MS`].

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

pub const RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const FILE_NAME: &str = "transfer_history.jsonl";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    /// The file left this device.
    Sent,
    /// The file arrived on this device.
    Received,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Initiator {
    /// Started from this device's UI.
    Me,
    /// Started by the peer against our server.
    Peer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    /// The destination already had an identical copy; nothing moved.
    Skipped,
    Failed,
    Cancelled,
    /// The receiver turned an offer (or this file of it) down.
    Declined,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    /// When the transfer finished, Unix milliseconds.
    pub at_ms: u64,
    pub direction: Direction,
    pub initiated_by: Initiator,
    pub peer_id: String,
    /// Name at the time, so the log still reads well after an unpair.
    #[serde(default)]
    pub peer_name: Option<String>,
    /// The name the file was requested under.
    pub file_name: String,
    /// Name at the destination, when it differs (numbered copy).
    #[serde(default)]
    pub dest_name: Option<String>,
    /// Bytes moved; for a skip, the size of the file already there.
    pub bytes: u64,
    pub outcome: Outcome,
    #[serde(default)]
    pub error: Option<String>,
}

impl HistoryEntry {
    pub fn new(
        direction: Direction,
        initiated_by: Initiator,
        peer_id: String,
        peer_name: Option<String>,
        file_name: String,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            at_ms: crate::presence::now_ms(),
            direction,
            initiated_by,
            peer_id,
            peer_name,
            file_name,
            dest_name: None,
            bytes: 0,
            outcome: Outcome::Completed,
            error: None,
        }
    }
}

/// Logs one transfer a peer started against our server, whenever and however
/// it ends: success, an early error return, or the peer dropping the
/// connection mid-stream (which drops the handler's future, and this with it).
pub struct PeerTransferLog {
    history: std::sync::Arc<HistoryStore>,
    entry: Option<HistoryEntry>,
    /// Bytes moved so far.
    pub bytes: u64,
    /// Size a complete transfer has; reaching it counts as success.
    pub expected: Option<u64>,
    /// Set once the transfer is known good, for when no size is known upfront.
    pub succeeded: bool,
}

impl PeerTransferLog {
    pub fn new(history: std::sync::Arc<HistoryStore>, entry: HistoryEntry) -> Self {
        Self {
            history,
            entry: Some(entry),
            bytes: 0,
            expected: None,
            succeeded: false,
        }
    }

    pub fn add_bytes(&mut self, n: u64) {
        self.bytes += n;
    }

    pub fn set_dest_name(&mut self, name: String) {
        if let Some(e) = self.entry.as_mut() {
            if e.file_name != name {
                e.dest_name = Some(name);
            }
        }
    }
}

impl crate::range::ServeObserver for PeerTransferLog {
    fn on_start(&mut self, _start: u64, len: u64) {
        // A resumed pull sends only the tail; completing *that* completes it.
        self.expected = Some(len);
    }

    fn add_bytes(&mut self, n: u64) {
        PeerTransferLog::add_bytes(self, n);
    }
}

impl Drop for PeerTransferLog {
    fn drop(&mut self) {
        let Some(mut entry) = self.entry.take() else { return };
        entry.at_ms = crate::presence::now_ms();
        entry.bytes = self.bytes;
        let complete = self.succeeded || self.expected.is_some_and(|n| n == self.bytes);
        if complete {
            entry.outcome = Outcome::Completed;
        } else {
            entry.outcome = Outcome::Failed;
            entry.error = Some(match self.expected {
                Some(n) => format!("stopped after {} of {n} bytes", self.bytes),
                None => format!("stopped after {} bytes", self.bytes),
            });
        }
        self.history.record(entry);
    }
}

pub struct HistoryStore {
    /// `None` keeps the log in memory only (tests).
    path: Option<PathBuf>,
    entries: Mutex<Vec<HistoryEntry>>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
}

impl HistoryStore {
    /// Load the log from `dir`, dropping anything older than 30 days.
    /// A missing or partly corrupt file is not an error: unreadable lines
    /// are skipped, since losing one record beats losing the log.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(FILE_NAME);
        let entries: Vec<HistoryEntry> = std::fs::read_to_string(&path)
            .map(|text| {
                text.lines()
                    .filter_map(|line| serde_json::from_str(line).ok())
                    .collect()
            })
            .unwrap_or_default();

        let store = Self {
            path: Some(path),
            entries: Mutex::new(entries),
            app_handle: Mutex::new(None),
        };
        store.prune(crate::presence::now_ms());
        store
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self {
            path: None,
            entries: Mutex::new(Vec::new()),
            app_handle: Mutex::new(None),
        }
    }

    /// Where to announce `history-changed`, so open pages refresh.
    pub fn set_app_handle(&self, handle: tauri::AppHandle) {
        *self.app_handle.lock().unwrap() = Some(handle);
    }

    pub fn record(&self, entry: HistoryEntry) {
        {
            let mut entries = self.entries.lock().unwrap();
            if let Some(path) = &self.path {
                if let Ok(line) = serde_json::to_string(&entry) {
                    let _ = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(path)
                        .and_then(|mut f| writeln!(f, "{line}"));
                }
            }
            entries.push(entry);
        }
        self.prune(crate::presence::now_ms());

        if let Some(app) = self.app_handle.lock().unwrap().as_ref() {
            use tauri::Emitter;
            let _ = app.emit("history-changed", ());
        }
    }

    /// Entries from the last 30 days, newest first.
    pub fn list(&self) -> Vec<HistoryEntry> {
        self.prune(crate::presence::now_ms());
        let mut entries = self.entries.lock().unwrap().clone();
        entries.sort_by(|a, b| b.at_ms.cmp(&a.at_ms));
        entries
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Drop entries older than the retention window, rewriting the file
    /// only when something was actually dropped.
    fn prune(&self, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(RETENTION_MS);
        let mut entries = self.entries.lock().unwrap();
        let before = entries.len();
        entries.retain(|e| e.at_ms >= cutoff);
        if entries.len() == before {
            return;
        }
        if let Some(path) = &self.path {
            let text: String = entries
                .iter()
                .filter_map(|e| serde_json::to_string(e).ok())
                .map(|line| line + "\n")
                .collect();
            let tmp = path.with_extension("jsonl.tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(at_ms: u64, name: &str) -> HistoryEntry {
        let mut e = HistoryEntry::new(
            Direction::Sent,
            Initiator::Me,
            "peer".into(),
            Some("Phone".into()),
            name.into(),
        );
        e.at_ms = at_ms;
        e
    }

    #[test]
    fn records_survive_reload_newest_first() {
        let dir = tempfile::TempDir::new().unwrap();
        let now = crate::presence::now_ms();
        let store = HistoryStore::load(dir.path());
        store.record(entry(now - 2_000, "a.txt"));
        store.record(entry(now - 1_000, "b.txt"));

        let reloaded = HistoryStore::load(dir.path());
        let names: Vec<_> = reloaded.list().into_iter().map(|e| e.file_name).collect();
        assert_eq!(names, ["b.txt", "a.txt"]);
    }

    #[test]
    fn entries_older_than_30_days_are_dropped_from_disk() {
        let dir = tempfile::TempDir::new().unwrap();
        let now = crate::presence::now_ms();
        let store = HistoryStore::load(dir.path());
        store.record(entry(now - RETENTION_MS - 60_000, "old.txt"));
        store.record(entry(now, "new.txt"));

        let reloaded = HistoryStore::load(dir.path());
        let names: Vec<_> = reloaded.list().into_iter().map(|e| e.file_name).collect();
        assert_eq!(names, ["new.txt"]);
        let on_disk = std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        assert!(!on_disk.contains("old.txt"));
    }

    #[test]
    fn corrupt_lines_are_skipped() {
        let dir = tempfile::TempDir::new().unwrap();
        let good = serde_json::to_string(&entry(crate::presence::now_ms(), "ok.txt")).unwrap();
        std::fs::write(dir.path().join(FILE_NAME), format!("not json\n{good}\n")).unwrap();

        let store = HistoryStore::load(dir.path());
        assert_eq!(store.list().len(), 1);
    }
}
