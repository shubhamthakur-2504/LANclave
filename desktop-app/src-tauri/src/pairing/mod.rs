mod identity;
mod store;
mod handshake;
mod middleware;
mod guard;
mod blocklist;

pub use identity::{load_or_generate_identity, public_key_b64, public_key_from_b64, public_key_from_str};
pub use store::{DeviceStore, PairedDevice};
pub use guard::{guard, Admit};
pub use blocklist::{blocklist, init_blocklist, BlockedDevice};
pub use handshake::{compute_pairing_fingerprint, confirm_pairing, PairingSession};
pub use middleware::{
    check_request, sign_request, verify_caller_signature, AuthState, Status,
    HEADER_DEVICE_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP,
};

/// Errors that can occur during device pairing operations.
#[derive(Debug)]
pub enum PairingError {
    /// A local I/O error occurred while reading or writing store/key files.
    StorageError(String),
    /// Other I/O errors.
    IoError(String),
}

impl std::fmt::Display for PairingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StorageError(msg) => write!(f, "storage error: {msg}"),
            Self::IoError(msg) => write!(f, "I/O error: {msg}"),
        }
    }
}

impl std::error::Error for PairingError {}
