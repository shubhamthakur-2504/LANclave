use super::{store::DeviceStore, PairingError};
use ed25519_dalek::VerifyingKey;
use sha2::{Digest, Sha256};
use std::path::Path;

// ---------------------------------------------------------------------------
// Pairing session
// ---------------------------------------------------------------------------

/// An in-progress, **not yet confirmed** pairing with a remote peer.
///
/// Created when the peer's public key is received during the handshake
/// exchange.  The session **must not** be committed to persistent storage
/// until the human operator has visually confirmed the fingerprint matches
/// on both screens.
pub struct PairingSession {
    /// The device identifier claimed by the remote peer.
    pub peer_device_id: String,
    /// The remote peer's public key (received during exchange).
    pub peer_public_key: VerifyingKey,
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/// Compute a 6-digit numeric pairing fingerprint from two public keys.
///
/// # Why this exists
///
/// This function lets a human **visually confirm** that both devices
/// received each other's correct, untampered public keys during the
/// handshake.  Both sides call this function with their own key and the
/// peer's key and display the resulting 6-digit code.  If a man‑in‑the‑
/// middle swapped in their own key during transit, each side would compute
/// a fingerprint over a *different* pair of actual inputs, producing two
/// different codes — and the mismatch would be immediately visible when
/// the two humans compare screens.
///
/// The hashing itself is not the security boundary here — **the human
/// comparing both screens is**.
///
/// # Determinism
///
/// The two keys are ordered **lexicographically by their raw 32‑byte
/// encoding** before hashing, so both sides always compute the **same**
/// code regardless of which device calls this function.
pub fn compute_pairing_fingerprint(a: &VerifyingKey, b: &VerifyingKey) -> String {
    let a_bytes = a.to_bytes();
    let b_bytes = b.to_bytes();

    // Sort deterministically: smaller bytes first.
    let (first, second) = if a_bytes < b_bytes {
        (a_bytes, b_bytes)
    } else {
        (b_bytes, a_bytes)
    };

    let mut hasher = Sha256::new();
    hasher.update(&first);
    hasher.update(&second);
    let hash = hasher.finalize();

    // First 3 bytes → interpret as a 6‑digit decimal, take first 6 chars.
    let value = (hash[0] as u32) << 16 | (hash[1] as u32) << 8 | (hash[2] as u32);
    format!("{:06}", value % 1_000_000)
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/// Commit a [`PairingSession`] to the persistent device store.
///
/// Call this **only** after the human has confirmed the fingerprint
/// displayed on both devices matches.
pub fn confirm_pairing(
    session: PairingSession,
    store: &mut DeviceStore,
    app_data_dir: &Path,
) -> Result<(), PairingError> {
    store.add_peer(session.peer_device_id.clone(), &session.peer_public_key)?;
    store.save(app_data_dir)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;

    fn make_keypair(i: u8) -> SigningKey {
        // Deterministic key for reproducible tests.
        let seed = [i; 32];
        SigningKey::from_bytes(&seed)
    }

    #[test]
    fn fingerprint_is_6_digits() {
        let a = SigningKey::generate(&mut OsRng);
        let b = SigningKey::generate(&mut OsRng);
        let fp = compute_pairing_fingerprint(&a.verifying_key(), &b.verifying_key());
        assert_eq!(fp.len(), 6);
        assert!(fp.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn fingerprint_deterministic_same_order() {
        let a = make_keypair(1);
        let b = make_keypair(2);
        let fp1 = compute_pairing_fingerprint(&a.verifying_key(), &b.verifying_key());
        let fp2 = compute_pairing_fingerprint(&a.verifying_key(), &b.verifying_key());
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn fingerprint_symmetric() {
        let a = make_keypair(3);
        let b = make_keypair(4);
        let fp_ab = compute_pairing_fingerprint(&a.verifying_key(), &b.verifying_key());
        let fp_ba = compute_pairing_fingerprint(&b.verifying_key(), &a.verifying_key());
        assert_eq!(fp_ab, fp_ba, "order must not matter");
    }

    #[test]
    fn different_keys_produce_different_fingerprints() {
        let a = make_keypair(5);
        let b = make_keypair(6);
        let c = make_keypair(7);
        let fp_ab = compute_pairing_fingerprint(&a.verifying_key(), &b.verifying_key());
        let fp_ac = compute_pairing_fingerprint(&a.verifying_key(), &c.verifying_key());
        assert_ne!(fp_ab, fp_ac);
    }

    #[test]
    fn confirm_pairing_persists_to_store() {
        use tempfile::TempDir;
        let dir = TempDir::new().unwrap();
        let key = SigningKey::generate(&mut OsRng);
        let mut store = DeviceStore::new();

        let session = PairingSession {
            peer_device_id: "test-device".into(),
            peer_public_key: key.verifying_key(),
        };

        confirm_pairing(session, &mut store, dir.path()).unwrap();

        assert!(store.devices.contains_key("test-device"));
        let record = store.devices.get("test-device").unwrap();
        assert_eq!(
            record.public_key_b64,
            super::super::identity::public_key_b64(&key)
        );
    }
}
