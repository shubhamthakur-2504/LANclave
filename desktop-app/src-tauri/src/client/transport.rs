use super::ClientError;
use std::sync::LazyLock;
use std::time::Duration;

/// Reusable HTTP client shared across all transport calls.
///
/// Using [`LazyLock`] (from `std`, not `once_cell`) means the client is
/// built exactly once — on first use — and lives for the lifetime of the
/// process.  This reuses the underlying connection pool, DNS cache, and
/// TLS session cache, which matters when the UI triggers many transfers
/// in quick succession.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("valid reqwest client config")
});

/// Percent-encode each path segment of `path` while preserving `/` as a
/// separator, so that filenames containing spaces, Unicode, or other
/// URL‑special characters produce a valid HTTP request.
fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|segment| urlencoding::encode(segment))
        .collect::<Vec<_>>()
        .join("/")
}

/// Issue a GET to `http://{peer_addr}/files/{remote_path}` and return the
/// raw streaming response.
///
/// The caller is responsible for consuming the body (see [`pull`](super::pull)).
/// This function only sets up the connection and validates the initial
/// response — it does **not** buffer the body in memory.
pub async fn get_stream(
    peer_addr: &str,
    remote_path: &str,
) -> Result<reqwest::Response, ClientError> {
    let encoded = encode_path(remote_path);
    let url = format!("http://{}/files/{}", peer_addr, encoded);

    let response = CLIENT
        .get(&url)
        .send()
        .await
        .map_err(|e| ClientError::ConnectionFailed(e.to_string()))?;

    Ok(response)
}

/// Issue a PUT to `http://{peer_addr}/files/{remote_path}` with a streaming
/// body, and return the peer's response status code.
///
/// `body` can be any [`reqwest::Body`]; the caller constructs it
/// (see [`push`](super::push)).
pub async fn put_stream(
    peer_addr: &str,
    remote_path: &str,
    body: reqwest::Body,
) -> Result<reqwest::StatusCode, ClientError> {
    let encoded = encode_path(remote_path);
    let url = format!("http://{}/files/{}", peer_addr, encoded);

    let response = CLIENT
        .put(&url)
        .body(body)
        .send()
        .await
        .map_err(|e| ClientError::ConnectionFailed(e.to_string()))?;

    Ok(response.status())
}
