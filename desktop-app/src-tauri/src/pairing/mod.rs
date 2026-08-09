mod identity;
mod store;
mod handshake;
mod middleware;

pub use identity::{load_or_generate_identity, public_key_b64, public_key_from_b64, public_key_from_str};
pub use store::{DeviceStore, PairedDevice};
pub use handshake::{compute_pairing_fingerprint, confirm_pairing, PairingSession};
pub use middleware::{
    check_request, sign_request, AuthState,
    HEADER_DEVICE_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP,
};

/// Errors that can occur during device pairing operations.
#[derive(Debug)]
pub enum PairingError {
    /// The signature does not match the stored public key.
    SignatureMismatch,
    /// No pairing record exists for the given device.
    DeviceNotPaired,
    /// A local I/O error occurred while reading or writing store/key files.
    StorageError(String),
    /// Other I/O errors.
    IoError(String),
}

impl std::fmt::Display for PairingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SignatureMismatch => f.write_str("signature mismatch"),
            Self::DeviceNotPaired => f.write_str("device not paired"),
            Self::StorageError(msg) => write!(f, "storage error: {msg}"),
            Self::IoError(msg) => write!(f, "I/O error: {msg}"),
        }
    }
}

impl std::error::Error for PairingError {}
