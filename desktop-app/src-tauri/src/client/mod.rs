pub(crate) mod transport;
pub(crate) mod pull;
pub(crate) mod push;
#[cfg(test)]
mod tests;

pub use pull::pull_file_from_peer;
#[cfg(test)]
pub(crate) use pull::pull_file_to_disk;
#[cfg(test)]
pub use push::push_file_to_peer;

/// Errors that can occur during client‑side file transfer operations.
///
/// The variants are granular enough that the Tauri UI layer can map them
/// to human‑readable messages ("peer unreachable", "file too large for peer",
/// etc.) without needing to parse inner error strings.
#[derive(Debug)]
pub enum ClientError {
    /// Could not establish a TCP connection to the peer address.
    ConnectionFailed(String),
    /// An HTTP‑level error occurred after connecting (timeout, bad response,
    /// body stream broke, etc.).
    HttpError(String),
    /// The peer returned an HTTP status code that we don't handle as a
    /// success (including their own security rejections such as 400/404).
    /// The status code is included so callers can inspect it if needed.
    ServerRejected(u16),
    /// A local I/O error (disk write failure, file not found locally, etc.).
    IoError(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ConnectionFailed(msg) => {
                write!(f, "could not reach peer: {msg}")
            }
            Self::HttpError(msg) => {
                write!(f, "transfer error: {msg}")
            }
            Self::ServerRejected(code) => {
                write!(f, "peer rejected the request (HTTP {code})")
            }
            Self::IoError(msg) => {
                write!(f, "local I/O error: {msg}")
            }
        }
    }
}

impl std::error::Error for ClientError {}
