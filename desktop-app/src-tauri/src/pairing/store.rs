use super::PairingError;
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// A record of a paired device.
///
/// The `public_key_b64` field is a base64-encoded ed25519 public key.
/// Public keys are not secrets — they are shared openly during the
/// handshake and are used to verify signed requests from the peer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairedDevice {
    pub device_id: String,
    /// Base64-encoded ed25519 [`VerifyingKey`] belonging to the peer.
    pub public_key_b64: String,
    /// ISO-like timestamp of when this device was first paired.
    pub paired_at: String,
    /// Human-readable name of the device.
    #[serde(default)]
    pub device_name: Option<String>,
}

/// In-memory store of paired devices.
///
/// Persisted to disk as `paired_devices.json` inside the app data directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceStore {
    pub devices: HashMap<String, PairedDevice>,
}

impl DeviceStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self {
            devices: HashMap::new(),
        }
    }

    /// Load the store from `paired_devices.json` in `app_data_dir`.
    ///
    /// Returns an empty store if the file doesn't exist yet (first run).
    pub fn load(app_data_dir: &Path) -> Result<Self, PairingError> {
        let path = app_data_dir.join("paired_devices.json");
        match std::fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str(&json)
                .map_err(|e| PairingError::StorageError(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::new()),
            Err(e) => Err(PairingError::IoError(e.to_string())),
        }
    }

    /// Write the store to `paired_devices.json` atomically.
    pub fn save(&self, app_data_dir: &Path) -> Result<(), PairingError> {
        let path = app_data_dir.join("paired_devices.json");
        let tmp_path = app_data_dir.join("paired_devices.json.tmp");

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| PairingError::StorageError(e.to_string()))?;

        std::fs::write(&tmp_path, &json)
            .map_err(|e| PairingError::IoError(e.to_string()))?;

        std::fs::rename(&tmp_path, &path)
            .map_err(|e| PairingError::IoError(e.to_string()))?;

        Ok(())
    }

    /// Record a paired peer's public key.
    pub fn add_peer(
        &mut self,
        device_id: String,
        public_key: &VerifyingKey,
        device_name: Option<String>,
    ) -> Result<(), PairingError> {
        use base64::Engine;
        let engine = base64::engine::general_purpose::STANDARD;
        let public_key_b64 = engine.encode(public_key.to_bytes());
        self.devices.insert(
            device_id.clone(),
            PairedDevice {
                device_id,
                public_key_b64,
                paired_at: iso_timestamp_now(),
                device_name,
            },
        );
        Ok(())
    }

    /// Update the device name for an existing peer
    pub fn update_peer_name(&mut self, device_id: &str, device_name: String) -> bool {
        if let Some(peer) = self.devices.get_mut(device_id) {
            if peer.device_name.as_ref() != Some(&device_name) {
                peer.device_name = Some(device_name);
                return true;
            }
        }
        false
    }

    /// Retrieve the stored [`VerifyingKey`] for a paired device.
    pub fn get_peer_key(&self, device_id: &str) -> Option<VerifyingKey> {
        let record = self.devices.get(device_id)?;
        use base64::Engine;
        let engine = base64::engine::general_purpose::STANDARD;
        let bytes = engine.decode(&record.public_key_b64).ok()?;
        let arr: [u8; 32] = bytes.try_into().ok()?;
        VerifyingKey::from_bytes(&arr).ok()
    }

    /// Check whether a device is paired (exists in the store).
    pub fn is_paired(&self, device_id: &str) -> bool {
        self.devices.contains_key(device_id)
    }
}

impl Default for DeviceStore {
    fn default() -> Self {
        Self::new()
    }
}

fn iso_timestamp_now() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let hours = time_secs / 3600;
    let mins = (time_secs % 3600) / 60;
    let secs_remain = time_secs % 60;
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, m, d, hours, mins, secs_remain
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;
    use tempfile::TempDir;

    #[test]
    fn save_load_roundtrip() {
        let dir = TempDir::new().unwrap();
        let key = SigningKey::generate(&mut OsRng);
        let mut store = DeviceStore::new();
        store.add_peer("device-a".into(), &key.verifying_key(), None).unwrap();

        store.save(dir.path()).unwrap();

        let loaded = DeviceStore::load(dir.path()).unwrap();
        assert_eq!(loaded.devices.len(), 1);
        assert!(loaded.devices.contains_key("device-a"));
        let stored_key = loaded.get_peer_key("device-a").unwrap();
        assert_eq!(stored_key, key.verifying_key());
    }

    #[test]
    fn load_empty_when_file_missing() {
        let dir = TempDir::new().unwrap();
        let store = DeviceStore::load(dir.path()).unwrap();
        assert!(store.devices.is_empty());
    }

    #[test]
    fn add_peer_stores_key() {
        let key = SigningKey::generate(&mut OsRng);
        let mut store = DeviceStore::new();
        store.add_peer("dev".into(), &key.verifying_key(), None).unwrap();
        let stored = store.get_peer_key("dev").unwrap();
        assert_eq!(stored, key.verifying_key());
    }

    #[test]
    fn is_paired_returns_false_for_unknown() {
        let store = DeviceStore::new();
        assert!(!store.is_paired("unknown"));
    }

    #[test]
    fn is_paired_returns_true_for_known() {
        let key = SigningKey::generate(&mut OsRng);
        let mut store = DeviceStore::new();
        store.add_peer("known-dev".into(), &key.verifying_key(), None).unwrap();
        assert!(store.is_paired("known-dev"));
    }

    #[test]
    fn get_peer_key_returns_none_for_unknown() {
        let store = DeviceStore::new();
        assert!(store.get_peer_key("ghost").is_none());
    }
}
