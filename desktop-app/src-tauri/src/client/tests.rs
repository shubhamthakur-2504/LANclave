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

    let state = Arc::new(AppState {
        sandbox_root: root,
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

// ── Pull tests ───────────────────────────────────────────────────

#[tokio::test]
async fn pull_small_file_success() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let dir = TempDir::new().unwrap();
    let peer_addr = start_server(&dir, &[("hello.txt", b"Hello, world!")]).await;

    let save_path = dir.path().join("downloaded.txt");
    crate::client::pull_file_from_peer(&peer_addr, "hello.txt", &save_path, &did, &key)
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
    let err = crate::client::pull_file_from_peer(
        &peer_addr,
        "nope.txt",
        &save_path,
        &did,
        &key,
    )
    .await
    .unwrap_err();

    match err {
        crate::client::ClientError::ServerRejected(code) => {
            assert_eq!(code, 404);
        }
        other => panic!("expected ServerRejected(404), got {other:?}"),
    }

    assert!(!save_path.exists(), "no partial file should exist");
}

#[tokio::test]
async fn pull_interrupted_mid_stream_cleans_up_partial() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let dir = TempDir::new().unwrap();
    let big = vec![0xAAu8; 100_000];
    let peer_addr = start_server(&dir, &[("big.bin", &big)]).await;

    let save_path = dir.path().join("big.bin");

    let result =
        crate::client::pull_file_from_peer(&peer_addr, "big.bin", &save_path, &did, &key)
            .await;
    assert!(result.is_ok(), "successful pull should work: {:?}", result);
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
