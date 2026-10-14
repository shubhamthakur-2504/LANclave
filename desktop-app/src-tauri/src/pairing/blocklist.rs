//! Devices the user blocked from asking to pair.
//!
//! A blocked device's pairing requests are refused before anything reaches
//! the screen. Pairing requests are signed, so a block names the device that
//! really asked; a determined nuisance can still make a new identity, which
//! the pairing guard's address cooldown covers.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockedDevice {
    pub device_id: String,
    /// The name it asked under, to recognise it in the list.
    pub device_name: Option<String>,
    /// Unix ms.
    pub blocked_at: u64,
}

#[derive(Default)]
pub struct BlockList {
    /// `blocked_devices.json`; `None` keeps the list in memory (tests).
    path: Option<PathBuf>,
    devices: RwLock<Vec<BlockedDevice>>,
}

impl BlockList {
    /// The list saved in `data_dir`, or an empty one.
    pub fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("blocked_devices.json");
        let devices = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self { path: Some(path), devices: RwLock::new(devices) }
    }

    pub fn contains(&self, device_id: &str) -> bool {
        self.devices
            .read()
            .map(|list| list.iter().any(|d| d.device_id == device_id))
            .unwrap_or(false)
    }

    pub fn list(&self) -> Vec<BlockedDevice> {
        self.devices.read().map(|list| list.clone()).unwrap_or_default()
    }

    pub fn block(&self, device_id: &str, device_name: Option<String>) {
        let Ok(mut list) = self.devices.write() else { return };
        if list.iter().any(|d| d.device_id == device_id) {
            return;
        }
        list.push(BlockedDevice {
            device_id: device_id.to_string(),
            device_name,
            blocked_at: crate::presence::now_ms(),
        });
        self.save(&list);
    }

    /// `true` when it was blocked.
    pub fn unblock(&self, device_id: &str) -> bool {
        let Ok(mut list) = self.devices.write() else { return false };
        let before = list.len();
        list.retain(|d| d.device_id != device_id);
        let removed = list.len() != before;
        if removed {
            self.save(&list);
        }
        removed
    }

    fn save(&self, list: &[BlockedDevice]) {
        if let (Some(path), Ok(text)) = (&self.path, serde_json::to_string_pretty(list)) {
            let _ = std::fs::write(path, text);
        }
    }
}

static BLOCKS: OnceLock<BlockList> = OnceLock::new();

/// Load the saved list. Called once at launch; until then the list is empty.
pub fn init_blocklist(data_dir: &Path) {
    let _ = BLOCKS.set(BlockList::load(data_dir));
}

/// The process-wide block list.
pub fn blocklist() -> &'static BlockList {
    BLOCKS.get_or_init(BlockList::default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_survives_a_restart_and_can_be_lifted() {
        let dir = tempfile::TempDir::new().unwrap();
        let list = BlockList::load(dir.path());
        list.block("pest", Some("Somebody's phone".into()));
        list.block("pest", None);
        assert!(list.contains("pest"));
        assert!(!list.contains("friend"));

        let reloaded = BlockList::load(dir.path());
        assert_eq!(reloaded.list().len(), 1, "blocking twice keeps one entry");
        assert_eq!(reloaded.list()[0].device_name.as_deref(), Some("Somebody's phone"));

        assert!(reloaded.unblock("pest"));
        assert!(!BlockList::load(dir.path()).contains("pest"));
    }
}
