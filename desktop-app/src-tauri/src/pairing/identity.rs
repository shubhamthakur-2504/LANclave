use super::PairingError;
use base64::Engine;
use ed25519_dalek::Signature;
use std::path::Path;

/// Load an existing identity keypair from disk, or generate + persist a new
/// one if none exists.  Call once at app startup.
///
/// The private key is stored at `{app_data_dir}/identity.key` (32 bytes,
/// the ed25519 seed) and is **never** transmitted anywhere.  The public key
/// is derived on-the-fly.
///
/// New keys are generated using [`ed25519_dalek::SigningKey::generate`]
/// seeded from [`rand::rngs::OsRng`] (kernel entropy).
pub fn load_or_generate_identity(app_data_dir: &Path) -> Result<ed25519_dalek::SigningKey, PairingError> {
    use rand::rngs::OsRng;
    let path = app_data_dir.join("identity.key");

    match std::fs::read(&path) {
        Ok(bytes) => {
            let arr: [u8; 32] = bytes
                .try_into()
                .map_err(|_| PairingError::StorageError("invalid key file size".into()))?;
            Ok(ed25519_dalek::SigningKey::from_bytes(&arr))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut csprng = OsRng;
            let keypair = ed25519_dalek::SigningKey::generate(&mut csprng);
            std::fs::write(&path, keypair.to_bytes())
                .map_err(|e| PairingError::IoError(e.to_string()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
            Ok(keypair)
        }
        Err(e) => Err(PairingError::IoError(e.to_string())),
    }
}

/// Sign a message with the device's identity keypair.
pub fn sign(keypair: &ed25519_dalek::SigningKey, message: &[u8]) -> Signature {
    use ed25519_dalek::Signer;
    keypair.sign(message)
}

/// Verify a signature against a [`ed25519_dalek::VerifyingKey`] and message.
pub fn verify(
    public_key: &ed25519_dalek::VerifyingKey,
    message: &[u8],
    signature: &Signature,
) -> bool {
        public_key.verify_strict(message, signature).is_ok()
}

/// Return the base64-encoded public key for use as a device identifier or
/// for serialization in the device store.
pub fn public_key_b64(keypair: &ed25519_dalek::SigningKey) -> String {
    let engine = base64::engine::general_purpose::STANDARD;
    engine.encode(keypair.verifying_key().to_bytes())
}

/// Decode a base64-encoded public key.
pub fn public_key_from_b64(encoded: &str) -> Result<ed25519_dalek::VerifyingKey, PairingError> {
    let engine = base64::engine::general_purpose::STANDARD;
    let bytes = engine
        .decode(encoded)
        .map_err(|e| PairingError::StorageError(e.to_string()))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| PairingError::StorageError("invalid public key length".into()))?;
    ed25519_dalek::VerifyingKey::from_bytes(&arr)
        .map_err(|e| PairingError::StorageError(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing::{AuthState, DeviceStore};
    use ed25519_dalek::Signer;
    use rand::rngs::OsRng;
    use tempfile::TempDir;

    #[test]
    fn sign_and_verify() {
        let key = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let msg = b"test message";
        let sig = sign(&key, msg);
        assert!(verify(&key.verifying_key(), msg, &sig));
    }

    #[test]
    fn reject_tampered_message() {
        let key = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let msg = b"original";
        let sig = sign(&key, msg);
        assert!(!verify(&key.verifying_key(), b"tampered", &sig));
    }

    #[test]
    fn reject_wrong_key() {
        let key_a = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let key_b = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let msg = b"message";
        let sig = sign(&key_a, msg);
        assert!(!verify(&key_b.verifying_key(), msg, &sig));
    }

    #[test]
    fn load_or_generate_creates_new_file() {
        let dir = TempDir::new().unwrap();
        let key = load_or_generate_identity(dir.path()).unwrap();
        // A second call should load the same key.
        let key2 = load_or_generate_identity(dir.path()).unwrap();
        assert_eq!(key.to_bytes(), key2.to_bytes());
    }

    #[test]
    fn public_key_b64_roundtrip() {
        let key = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let b64 = public_key_b64(&key);
        let decoded = public_key_from_b64(&b64).unwrap();
        assert_eq!(decoded, key.verifying_key());
    }

    // -----------------------------------------------------------------------
    // Signature-based auth integration test
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn auth_rejects_request_without_headers() {
        use axum::http::Request;
        use std::sync::Arc;
        use tower::ServiceExt;

        let state = Arc::new(crate::server::AppState {
            sandbox_root: std::env::temp_dir(),
            auth: Arc::new(AuthState::new()), // enabled
        });
        let app = crate::server::build_router(state);

        let req = Request::builder()
            .uri("/files/some_file.txt")
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), 401);
    }

    #[tokio::test]
    async fn auth_accepts_valid_signed_request() {
        use axum::http::Request;
        use std::sync::Arc;
        use tower::ServiceExt;

        // Set up a router with a paired device.
        let key = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let device_id = public_key_b64(&key);
        let mut store = DeviceStore::new();
        store.add_peer(device_id.clone(), &key.verifying_key()).unwrap();

        let auth = Arc::new(AuthState {
            store: std::sync::RwLock::new(store),
            enabled: true,
        });

        let state = Arc::new(crate::server::AppState {
            sandbox_root: std::env::temp_dir(),
            auth,
        });
        let app = crate::server::build_router(state);

        // Create a properly signed request.
        let (ts, sig) = crate::pairing::sign_request(&key, &device_id);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

        let req = Request::builder()
            .uri("/files/some_file.txt")
            .header("X-LANclave-Device-Id", &device_id)
            .header("X-LANclave-Timestamp", ts.to_string())
            .header("X-LANclave-Signature", &sig_b64)
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        // Should pass auth, fail at file-not-found (we used a bogus file).
        // 404 means auth passed. 401 means auth failed.
        assert_eq!(res.status(), 404);
    }

    #[tokio::test]
    async fn auth_rejects_tampered_signature() {
        use axum::http::Request;
        use std::sync::Arc;
        use tower::ServiceExt;

        let key = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let device_id = public_key_b64(&key);
        let mut store = DeviceStore::new();
        store.add_peer(device_id.clone(), &key.verifying_key()).unwrap();

        let auth = Arc::new(AuthState {
            store: std::sync::RwLock::new(store),
            enabled: true,
        });

        let state = Arc::new(crate::server::AppState {
            sandbox_root: std::env::temp_dir(),
            auth,
        });
        let app = crate::server::build_router(state);

        // Sign with a different key.
        let wrong_key = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let (ts, sig) = crate::pairing::sign_request(&wrong_key, &device_id);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

        let req = Request::builder()
            .uri("/files/some_file.txt")
            .header("X-LANclave-Device-Id", &device_id)
            .header("X-LANclave-Timestamp", ts.to_string())
            .header("X-LANclave-Signature", &sig_b64)
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), 401);
    }

    #[tokio::test]
    async fn auth_rejects_replayed_timestamp() {
        use axum::http::Request;
        use std::sync::Arc;
        use tower::ServiceExt;

        let key = ed25519_dalek::SigningKey::generate(&mut OsRng);
        let device_id = public_key_b64(&key);
        let mut store = DeviceStore::new();
        store.add_peer(device_id.clone(), &key.verifying_key()).unwrap();

        let auth = Arc::new(AuthState {
            store: std::sync::RwLock::new(store),
            enabled: true,
        });

        let state = Arc::new(crate::server::AppState {
            sandbox_root: std::env::temp_dir(),
            auth,
        });
        let app = crate::server::build_router(state);

        // Use a timestamp that's 60 seconds in the past (>30s tolerance).
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let old_ts = now - 60;
        let payload = format!("{device_id}:{old_ts}");
        let sig = key.sign(payload.as_bytes());
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

        let req = Request::builder()
            .uri("/files/some_file.txt")
            .header("X-LANclave-Device-Id", &device_id)
            .header("X-LANclave-Timestamp", old_ts.to_string())
            .header("X-LANclave-Signature", &sig_b64)
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), 401);
    }
}
