use super::store::DeviceStore;
use ed25519_dalek::{Signature, Signer};
use std::sync::RwLock;
use std::time::SystemTime;

// ---------------------------------------------------------------------------
// AuthState
// ---------------------------------------------------------------------------

/// Shared state for the pairing/auth system.
///
/// Contains the device store synchronised behind an `RwLock`.
///
/// ## Why `RwLock` instead of `Mutex`?
///
/// Auth checks are **read-heavy** (every request verifies a signature) and
/// **write-rare** (only when a new device is paired).  `RwLock` allows
/// multiple concurrent readers.
pub struct AuthState {
    pub store: std::sync::Arc<RwLock<DeviceStore>>,
    /// Set to `false` to skip all auth checks (unit tests).
    pub enabled: bool,
}

impl AuthState {
    pub fn new() -> Self {
        Self {
            store: std::sync::Arc::new(RwLock::new(DeviceStore::new())),
            enabled: true,
        }
    }

    /// Create an auth‑disabled state for testing.
    pub fn disabled() -> Self {
        Self {
            store: std::sync::Arc::new(RwLock::new(DeviceStore::new())),
            enabled: false,
        }
    }
}

impl Default for AuthState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Header constants
// ---------------------------------------------------------------------------

pub const HEADER_DEVICE_ID: &str = "x-lanclave-device-id";
pub const HEADER_TIMESTAMP: &str = "x-lanclave-timestamp";
pub const HEADER_SIGNATURE: &str = "x-lanclave-signature";

// ---------------------------------------------------------------------------
// Request signing helpers (client side)
// ---------------------------------------------------------------------------

/// Build the message payload that the client signs and the receiver
/// verifies.  Format: `"{device_id}:{timestamp}"`.
pub fn signing_payload(device_id: &str, timestamp_secs: u64) -> String {
    format!("{device_id}:{timestamp_secs}")
}

/// Sign a request payload with the device's identity key.
pub fn sign_request(keypair: &ed25519_dalek::SigningKey, device_id: &str) -> (u64, Signature) {
    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let payload = signing_payload(device_id, timestamp);
    let signature = keypair.sign(payload.as_bytes());
    (timestamp, signature)
}

// ---------------------------------------------------------------------------
// Request verification (server/receiver side)
// ---------------------------------------------------------------------------

/// Maximum allowed clock skew for incoming signed requests (seconds).
const TIMESTAMP_TOLERANCE_SECS: u64 = 30;

/// Check request headers against the paired device store.
///
/// Expects three headers:
/// - `X-LANclave-Device-Id` — the sender's device identifier.
/// - `X-LANclave-Timestamp` — Unix epoch seconds when the signature was
///   created.  Must be within ±30 seconds of the receiver's clock to
///   prevent replay attacks (a captured signature becomes useless shortly
///   after capture).
/// - `X-LANclave-Signature` — ed25519 signature over
///   `"{device_id}:{timestamp}"` using the sender's private key.
///
/// Returns `Ok(device_id)` for the verified caller, or `Err(Status)` with 401
/// on any failure. The specific reason is logged server-side only.
///
/// The identity is returned so handlers can attribute a request to a peer --
/// presence tracking treats any authenticated request as a liveness signal.
pub fn check_request(
    auth: &AuthState,
    headers: &axum::http::HeaderMap,
) -> Result<String, Status> {
    if !auth.enabled {
        return Ok(String::new());
    }

    // --- Extract headers --------------------------------------------------
    let device_id = header_value(headers, HEADER_DEVICE_ID).map_err(|_| {
        eprintln!("[lanclave/auth] missing device_id header");
        Status(401)
    })?;

    let timestamp_str = header_value(headers, HEADER_TIMESTAMP).map_err(|_| {
        eprintln!("[lanclave/auth] missing timestamp header");
        Status(401)
    })?;

    let sig_b64 = header_value(headers, HEADER_SIGNATURE).map_err(|_| {
        eprintln!("[lanclave/auth] missing signature header");
        Status(401)
    })?;

    // --- Parse timestamp and check freshness (anti-replay) ----------------
    let timestamp: u64 = timestamp_str.parse::<u64>().map_err(|_| {
        eprintln!("[lanclave/auth] invalid timestamp format");
        Status(401)
    })?;

    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let age = if timestamp > now {
        timestamp - now // future (clock skew)
    } else {
        now - timestamp // past
    };

    if age > TIMESTAMP_TOLERANCE_SECS {
        eprintln!(
            "[lanclave/auth] timestamp too far from current time: age={age}s, limit={TIMESTAMP_TOLERANCE_SECS}s"
        );
        return Err(Status(401));
    }

    // --- Look up the paired peer's public key -----------------------------
    // Only devices that completed the one-time pairing confirmation are
    // authorised.  We must NOT derive the public key from the device_id
    // itself, otherwise any device could self-authorise by signing with a
    // key it controls.
    let store = auth.store.read().map_err(|_| {
        eprintln!("[lanclave/auth] RwLock poisoned");
        Status(500)
    })?;

    let peer_key = store.get_peer_key(&device_id).ok_or_else(|| {
        eprintln!("[lanclave/auth] unknown or unpaired device_id {device_id}");
        Status(401)
    })?;

    // --- Verify the signature ---------------------------------------------
    use base64::Engine;
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(&sig_b64)
        .map_err(|_| {
            eprintln!("[lanclave/auth] invalid signature encoding");
            Status(401)
        })?;

    let signature = Signature::try_from(&*sig_bytes).map_err(|_| {
        eprintln!("[lanclave/auth] invalid signature bytes");
        Status(401)
    })?;

    let payload = signing_payload(&device_id, timestamp);

    if peer_key.verify_strict(payload.as_bytes(), &signature).is_ok() {
        drop(store);
        Ok(device_id.to_string())
    } else {
        eprintln!("[lanclave/auth] signature verification failed for device {device_id}");
        Err(Status(401))
    }
}

// ---------------------------------------------------------------------------
// Status newtype
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct Status(pub u16);

impl Status {
    pub fn code(self) -> u16 {
        self.0
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn header_value<'a>(headers: &'a axum::http::HeaderMap, name: &str) -> Result<&'a str, ()> {
    headers.get(name).and_then(|v| v.to_str().ok()).ok_or(())
}
