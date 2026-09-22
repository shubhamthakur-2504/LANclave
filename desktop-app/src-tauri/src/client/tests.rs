use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use std::sync::Arc;
use tempfile::TempDir;

use crate::server::{build_raw_router, AppState};

fn test_keypair() -> SigningKey {
    SigningKey::generate(&mut OsRng)
}

fn test_device_id(key: &SigningKey) -> String {
    crate::pairing::public_key_b64(key)
}

/// Spin up the real Axum server on a random port, seeded with files
/// from `dir`.  Returns the peer address string.
async fn start_server(
    dir: &TempDir,
    seed_files: &[(&str, &[u8])],
) -> String {
    let root = dir.path().to_path_buf();

    for (name, content) in seed_files {
        let path = root.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(&path, content).expect("write seed file");
    }

    use rand::rngs::OsRng;
    let state = Arc::new(AppState {
        settings: Arc::new(std::sync::RwLock::new(crate::settings::AppSettings {
            display_name: "Test Node".to_string(),
            sandbox_path: root.to_string_lossy().into_owned(),
        })),
        device_id: "test-device".to_string(),
        identity_key: ed25519_dalek::SigningKey::generate(&mut OsRng),
        app_handle: None,
        presence: std::sync::Arc::new(crate::presence::PresenceStore::new()),
        auth: Arc::new(crate::pairing::AuthState::disabled()),
    });
    let router = build_raw_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });

    format!("127.0.0.1:{port}")
}

fn cancel_channel() -> (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
) {
    tokio::sync::oneshot::channel()
}

// ── Pull tests ───────────────────────────────────────────────────

#[tokio::test]
async fn pull_small_file_success() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let dir = TempDir::new().unwrap();
    let peer_addr = start_server(&dir, &[("hello.txt", b"Hello, world!")]).await;

    let save_path = dir.path().join("downloaded.txt");
    let (_tx, rx) = cancel_channel();
    super::pull_file_to_disk(
        "test-transfer",
        &peer_addr,
        "hello.txt",
        &save_path,
        &did,
        &key,
        rx,
        |_| {},
    )
    .await
    .unwrap();

    let data = tokio::fs::read(&save_path).await.unwrap();
    assert_eq!(data, b"Hello, world!");
}

#[tokio::test]
async fn pull_peer_404_no_local_file_created() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let dir = TempDir::new().unwrap();
    let peer_addr = start_server(&dir, &[("actual.txt", b"real")]).await;

    let save_path = dir.path().join("nope.txt");
    let (_tx, rx) = cancel_channel();
    let err = super::pull_file_to_disk(
        "test-transfer",
        &peer_addr,
        "nope.txt",
        &save_path,
        &did,
        &key,
        rx,
        |_| {},
    )
    .await
    .unwrap_err();

    match err {
        super::ClientError::ServerRejected(code) => {
            assert_eq!(code, 404);
        }
        other => panic!("expected ServerRejected(404), got {other:?}"),
    }

    assert!(!save_path.exists(), "no partial file should exist");
}

#[tokio::test]
async fn pull_large_file_success() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let dir = TempDir::new().unwrap();
    let big = vec![0xAAu8; 100_000];
    let peer_addr = start_server(&dir, &[("big.bin", &big)]).await;

    let save_path = dir.path().join("big.bin");
    let (_tx, rx) = cancel_channel();

    let result = super::pull_file_to_disk(
        "test-transfer",
        &peer_addr,
        "big.bin",
        &save_path,
        &did,
        &key,
        rx,
        |_| {},
    )
    .await;
    assert!(result.is_ok(), "successful pull should work: {:?}", result);

    let data = tokio::fs::read(&save_path).await.unwrap();
    assert_eq!(data.len(), 100_000);
}

// ── Push tests ───────────────────────────────────────────────────

#[tokio::test]
async fn push_small_file_success() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let dir = TempDir::new().unwrap();
    let peer_addr = start_server(&dir, &[]).await;

    let src_path = dir.path().join("localfile.txt");
    tokio::fs::write(&src_path, b"content from client")
        .await
        .unwrap();

    crate::client::push_file_to_peer(&peer_addr, &src_path, "incoming.txt", &did, &key)
        .await
        .unwrap();

    let saved = tokio::fs::read(dir.path().join("incoming.txt"))
        .await
        .unwrap();
    assert_eq!(saved, b"content from client");
}

#[tokio::test]
async fn push_to_existing_file_returns_409() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let dir = TempDir::new().unwrap();
    let peer_addr =
        start_server(&dir, &[("existing.bin", b"original data")]).await;

    let src_path = dir.path().join("localfile.txt");
    tokio::fs::write(&src_path, b"new content").await.unwrap();

    let err = crate::client::push_file_to_peer(
        &peer_addr,
        &src_path,
        "existing.bin",
        &did,
        &key,
    )
    .await
    .unwrap_err();

    match err {
        crate::client::ClientError::ServerRejected(code) => {
            assert_eq!(code, 409);
        }
        other => panic!("expected ServerRejected(409), got {other:?}"),
    }
}

#[tokio::test]
async fn push_file_exceeds_peer_limit_returns_413() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let dir = TempDir::new().unwrap();
    let peer_addr = start_server(&dir, &[]).await;

    let src_dir = TempDir::new().unwrap();
    let oversized = vec![0xFFu8; 200_001];
    let src_path = src_dir.path().join("big.bin");
    tokio::fs::write(&src_path, &oversized).await.unwrap();

    let err = crate::client::push_file_to_peer(
        &peer_addr,
        &src_path,
        "big.bin",
        &did,
        &key,
    )
    .await
    .unwrap_err();

    match err {
        crate::client::ClientError::ServerRejected(code) => {
            assert_eq!(code, 413);
        }
        other => panic!("expected ServerRejected(413), got {other:?}"),
    }
}

// ── Wire-format tests ────────────────────────────────────────────

/// Accept one connection, capture the request head, drain the body, and
/// answer `201 Created`. Returns the head as a string.
///
/// The Axum server in the tests above accepts either framing, so it cannot
/// catch a missing `Content-Length`. The phone's NanoHTTPD cannot: it reads
/// `content-length` directly and 400s without it. So assert on the bytes.
async fn capture_push_head(listener: tokio::net::TcpListener) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (mut sock, _) = listener.accept().await.unwrap();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];

    // Read until the blank line that ends the head.
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = sock.read(&mut chunk).await.unwrap();
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head_end = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .unwrap_or(buf.len());
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();

    // Drain whatever else the client sends, then answer.
    let _ = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        loop {
            match sock.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    })
    .await;

    let _ = sock
        .write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\n\r\n")
        .await;
    let _ = sock.flush().await;

    head
}

#[tokio::test]
async fn push_sends_content_length_not_chunked() {
    let key = test_keypair();
    let did = test_device_id(&key);

    let src_dir = TempDir::new().unwrap();
    let src_path = src_dir.path().join("payload.bin");
    let payload = vec![7u8; 100_000];
    tokio::fs::write(&src_path, &payload).await.unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let peer_addr = format!("127.0.0.1:{}", listener.local_addr().unwrap().port());
    let capture = tokio::spawn(capture_push_head(listener));

    let _ = crate::client::push_file_to_peer(&peer_addr, &src_path, "payload.bin", &did, &key).await;

    let head = capture.await.unwrap().to_ascii_lowercase();

    assert!(
        head.contains(&format!("content-length: {}", payload.len())),
        "push must declare its length -- NanoHTTPD rejects PUTs without it. Head was:\n{head}"
    );
    assert!(
        !head.contains("transfer-encoding: chunked"),
        "push must not use chunked framing. Head was:\n{head}"
    );
}
