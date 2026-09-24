use super::ClientError;
use crate::pairing::{sign_request, HEADER_DEVICE_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP};
use base64::Engine;
use ed25519_dalek::SigningKey;
use std::sync::LazyLock;
use std::time::Duration;

/// Reusable HTTP client shared across all transport calls.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("valid reqwest client config")
});

fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|segment| urlencoding::encode(segment))
        .collect::<Vec<_>>()
        .join("/")
}

/// Issue a signed GET to `http://{peer_addr}/files/{remote_path}`.
pub async fn get_stream(
    peer_addr: &str,
    remote_path: &str,
    device_id: &str,
    signing_key: &SigningKey,
) -> Result<reqwest::Response, ClientError> {
    let encoded = encode_path(remote_path);
    let url = format!("http://{}/files/{}", peer_addr, encoded);

    let (ts, sig) = sign_request(signing_key, device_id);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let response = CLIENT
        .get(&url)
        .header(HEADER_DEVICE_ID, device_id)
        .header(HEADER_TIMESTAMP, ts.to_string())
        .header(HEADER_SIGNATURE, &sig_b64)
        .send()
        .await
        .map_err(|e| ClientError::ConnectionFailed(e.to_string()))?;

    Ok(response)
}

/// Issue a signed PUT to `http://{peer_addr}/files/{remote_path}`.
///
/// `content_length` is declared explicitly. A streaming body has no length
/// reqwest can infer, so without this header hyper frames the request as
/// `Transfer-Encoding: chunked` -- which the phone's NanoHTTPD rejects with
/// 400, because it reads `content-length` directly to size its read loop.
pub async fn put_stream(
    peer_addr: &str,
    remote_path: &str,
    body: reqwest::Body,
    content_length: u64,
    device_id: &str,
    signing_key: &SigningKey,
) -> Result<reqwest::StatusCode, ClientError> {
    let encoded = encode_path(remote_path);
    let url = format!("http://{}/files/{}", peer_addr, encoded);

    let (ts, sig) = sign_request(signing_key, device_id);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let response = CLIENT
        .put(&url)
        .header(HEADER_DEVICE_ID, device_id)
        .header(HEADER_TIMESTAMP, ts.to_string())
        .header(HEADER_SIGNATURE, &sig_b64)
        .header(reqwest::header::CONTENT_LENGTH, content_length)
        .body(body)
        .send()
        .await
        .map_err(|e| ClientError::ConnectionFailed(e.to_string()))?;

    Ok(response.status())
}

/// Ask the peer for the fingerprint of `remote_path`.
///
/// With `expected_size`, the peer skips hashing when its copy has a
/// different size. `Ok(None)` on 404 -- the file is absent, or the peer
/// predates the endpoint; callers treat both as "not a duplicate".
pub async fn get_fingerprint(
    peer_addr: &str,
    remote_path: &str,
    expected_size: Option<u64>,
    device_id: &str,
    signing_key: &SigningKey,
) -> Result<Option<crate::dedupe::Fingerprint>, ClientError> {
    let encoded = encode_path(remote_path);
    let mut url = format!("http://{}/api/sandbox/fingerprint/{}", peer_addr, encoded);
    if let Some(size) = expected_size {
        url.push_str(&format!("?size={size}"));
    }

    let (ts, sig) = sign_request(signing_key, device_id);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let response = CLIENT
        .get(&url)
        .header(HEADER_DEVICE_ID, device_id)
        .header(HEADER_TIMESTAMP, ts.to_string())
        .header(HEADER_SIGNATURE, &sig_b64)
        .send()
        .await
        .map_err(|e| ClientError::ConnectionFailed(e.to_string()))?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(ClientError::ServerRejected(status.as_u16()));
    }

    response
        .json()
        .await
        .map(Some)
        .map_err(|e| ClientError::HttpError(e.to_string()))
}
