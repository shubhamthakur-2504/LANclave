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

pub(crate) fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|segment| urlencoding::encode(segment))
        .collect::<Vec<_>>()
        .join("/")
}

/// Signed GET of `path` (percent-encoded, leading `/`) on the peer.
///
/// With `resume = Some((offset, etag))` it asks for the file from byte
/// `offset` on, but only if it is still version `etag` (`If-Range`); a peer
/// whose file changed answers with the whole new file instead.
pub async fn get_stream_at(
    peer_addr: &str,
    path: &str,
    resume: Option<(u64, &str)>,
    device_id: &str,
    signing_key: &SigningKey,
) -> Result<reqwest::Response, ClientError> {
    let url = format!("http://{peer_addr}{path}");

    let (ts, sig) = sign_request(signing_key, device_id);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let mut request = CLIENT
        .get(&url)
        .header(HEADER_DEVICE_ID, device_id)
        .header(HEADER_TIMESTAMP, ts.to_string())
        .header(HEADER_SIGNATURE, &sig_b64);
    if let Some((offset, etag)) = resume {
        request = request
            .header(reqwest::header::RANGE, format!("bytes={offset}-"))
            .header(reqwest::header::IF_RANGE, etag);
    }

    request
        .send()
        .await
        .map_err(|e| ClientError::ConnectionFailed(e.to_string()))
}

/// Issue a signed PUT to `http://{peer_addr}/files/{remote_path}`.
///
/// `content_length` is declared explicitly. A streaming body has no length
/// reqwest can infer, so without this header hyper frames the request as
/// `Transfer-Encoding: chunked` -- which the phone's NanoHTTPD rejects with
/// 400, because it reads `content-length` directly to size its read loop.
///
/// Returns the status and, on success, the name the peer saved the file
/// under (`{"name": ...}`). Peers that predate that body yield `None`.
pub async fn put_stream(
    peer_addr: &str,
    remote_path: &str,
    body: reqwest::Body,
    content_length: u64,
    device_id: &str,
    signing_key: &SigningKey,
) -> Result<(reqwest::StatusCode, Option<String>), ClientError> {
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

    #[derive(serde::Deserialize)]
    struct Saved {
        name: String,
    }

    let status = response.status();
    let saved_as = if status.is_success() {
        response.json::<Saved>().await.ok().map(|s| s.name)
    } else {
        None
    };
    Ok((status, saved_as))
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
    let path = format!("/api/sandbox/fingerprint/{}", encode_path(remote_path));
    get_fingerprint_at(peer_addr, &path, expected_size, device_id, signing_key).await
}

/// [`get_fingerprint`] for any fingerprint route (`path` percent-encoded,
/// leading `/`), e.g. an offered file's.
pub async fn get_fingerprint_at(
    peer_addr: &str,
    path: &str,
    expected_size: Option<u64>,
    device_id: &str,
    signing_key: &SigningKey,
) -> Result<Option<crate::dedupe::Fingerprint>, ClientError> {
    let mut url = format!("http://{peer_addr}{path}");
    if let Some(size) = expected_size {
        let join = if path.contains('?') { '&' } else { '?' };
        url.push_str(&format!("{join}size={size}"));
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

/// Tell a peer we are withdrawing our pairing: we rejected its codes, or we
/// unpaired. Signed with our own key, which is all the peer needs -- it can
/// check the signature against our device id without having paired us.
pub async fn send_pairing_cancel(
    peer_addr: &str,
    device_id: &str,
    signing_key: &SigningKey,
) -> Result<(), ClientError> {
    let (ts, sig) = sign_request(signing_key, device_id);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let response = CLIENT
        .post(format!("http://{peer_addr}/api/pairing/cancel"))
        .header(HEADER_DEVICE_ID, device_id)
        .header(HEADER_TIMESTAMP, ts.to_string())
        .header(HEADER_SIGNATURE, &sig_b64)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| ClientError::ConnectionFailed(e.to_string()))?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(ClientError::ServerRejected(response.status().as_u16()))
    }
}

/// Signed POST of a JSON body to `path` (leading `/`) on the peer. Returns
/// the status; the offer protocol's replies carry nothing else.
pub async fn post_json<T: serde::Serialize + ?Sized>(
    peer_addr: &str,
    path: &str,
    body: &T,
    device_id: &str,
    signing_key: &SigningKey,
) -> Result<reqwest::StatusCode, ClientError> {
    let (ts, sig) = sign_request(signing_key, device_id);
    let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

    let response = CLIENT
        .post(format!("http://{peer_addr}{path}"))
        .header(HEADER_DEVICE_ID, device_id)
        .header(HEADER_TIMESTAMP, ts.to_string())
        .header(HEADER_SIGNATURE, &sig_b64)
        .timeout(Duration::from_secs(10))
        .json(body)
        .send()
        .await
        .map_err(|e| ClientError::ConnectionFailed(e.to_string()))?;
    Ok(response.status())
}
