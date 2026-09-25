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
            ..Default::default()
        })),
        device_id: "test-device".to_string(),
        identity_key: ed25519_dalek::SigningKey::generate(&mut OsRng),
        app_handle: None,
        presence: std::sync::Arc::new(crate::presence::PresenceStore::new()),
        history: Arc::new(crate::history::HistoryStore::in_memory()),
        offers: std::sync::Arc::new(crate::offers::OfferStore::default()),
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
    tokio::sync::oneshot::Sender<super::pull::StopReason>,
    tokio::sync::oneshot::Receiver<super::pull::StopReason>,
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
        None,
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
        None,
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

    // A separate directory: saving over the served file would now be
    // recognised as a duplicate and skipped, and this test is about transfer.
    let local_dir = TempDir::new().unwrap();
    let save_path = local_dir.path().join("big.bin");
    let (_tx, rx) = cancel_channel();

    let result = super::pull_file_to_disk(
        "test-transfer",
        &peer_addr,
        "big.bin",
        &save_path,
        None,
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
async fn push_to_taken_name_is_saved_as_numbered_copy() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let dir = TempDir::new().unwrap();
    let peer_addr =
        start_server(&dir, &[("existing.bin", b"original data")]).await;

    let src_path = dir.path().join("localfile.txt");
    tokio::fs::write(&src_path, b"new content").await.unwrap();

    let report = crate::client::push_file_to_peer(
        &peer_addr,
        &src_path,
        "existing.bin",
        &did,
        &key,
    )
    .await
    .unwrap();

    assert_eq!(report.outcome, super::pull::TransferOutcome::Transferred);
    assert_eq!(report.dest_name, "existing (1).bin");
    assert_eq!(std::fs::read(dir.path().join("existing.bin")).unwrap(), b"original data");
    assert_eq!(std::fs::read(dir.path().join("existing (1).bin")).unwrap(), b"new content");
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

/// Accept connections until a PUT arrives, capture its request head, drain
/// the body, and answer `201 Created`. Returns the head as a string.
///
/// The dedupe probe (`GET /api/sandbox/fingerprint/...`) comes first; it is
/// answered 404 and closed, as an older peer would.
///
/// The Axum server in the tests above accepts either framing, so it cannot
/// catch a missing `Content-Length`. The phone's NanoHTTPD cannot: it reads
/// `content-length` directly and 400s without it. So assert on the bytes.
async fn capture_push_head(listener: tokio::net::TcpListener) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut chunk = [0u8; 4096];
    let (mut sock, buf) = loop {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();

        // Read until the blank line that ends the head.
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = sock.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }

        if buf.starts_with(b"PUT ") {
            break (sock, buf);
        }
        let _ = sock
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
    };
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

// ── Dedupe tests ─────────────────────────────────────────────────

#[tokio::test]
async fn fingerprint_endpoint_hashes_only_on_size_match() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let dir = TempDir::new().unwrap();
    let peer_addr = start_server(&dir, &[("abc.txt", b"abc")]).await;

    let fp = super::transport::get_fingerprint(&peer_addr, "abc.txt", Some(3), &did, &key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fp.size, 3);
    assert_eq!(
        fp.sha256.as_deref(),
        Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    );

    let fp = super::transport::get_fingerprint(&peer_addr, "abc.txt", Some(99), &did, &key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fp.size, 3);
    assert_eq!(fp.sha256, None, "size mismatch must not pay for a hash");

    let missing = super::transport::get_fingerprint(&peer_addr, "nope.txt", None, &did, &key)
        .await
        .unwrap();
    assert!(missing.is_none());
}

#[tokio::test]
async fn pull_skips_identical_local_copy() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let remote_dir = TempDir::new().unwrap();
    let peer_addr = start_server(&remote_dir, &[("same.bin", b"same bytes")]).await;

    let local_dir = TempDir::new().unwrap();
    let save_path = local_dir.path().join("same.bin");
    std::fs::write(&save_path, b"same bytes").unwrap();

    let mut statuses = Vec::new();
    let (_tx, rx) = cancel_channel();
    let report = super::pull_file_to_disk(
        "t",
        &peer_addr,
        "same.bin",
        &save_path,
        Some(10),
        &did,
        &key,
        rx,
        |e| statuses.push(e.status.clone()),
    )
    .await
    .unwrap();

    assert_eq!(report.outcome, super::pull::TransferOutcome::AlreadyPresent);
    assert_eq!(statuses, vec!["skipped".to_string()]);
}

#[tokio::test]
async fn pull_same_size_different_content_downloads_beside_it() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let remote_dir = TempDir::new().unwrap();
    let peer_addr = start_server(&remote_dir, &[("doc.txt", b"version B")]).await;

    let local_dir = TempDir::new().unwrap();
    let save_path = local_dir.path().join("doc.txt");
    std::fs::write(&save_path, b"version A").unwrap();

    let (_tx, rx) = cancel_channel();
    let report = super::pull_file_to_disk(
        "t", &peer_addr, "doc.txt", &save_path, Some(9), &did, &key, rx, |_| {},
    )
    .await
    .unwrap();

    assert_eq!(report.outcome, super::pull::TransferOutcome::Transferred);
    assert_eq!(report.dest_name, "doc (1).txt");
    assert_eq!(std::fs::read(&save_path).unwrap(), b"version A", "never overwrite");
    assert_eq!(std::fs::read(local_dir.path().join("doc (1).txt")).unwrap(), b"version B");
}

#[tokio::test]
async fn push_skips_when_peer_has_identical_copy() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let remote_dir = TempDir::new().unwrap();
    let peer_addr = start_server(&remote_dir, &[("photo.jpg", b"jpeg bytes")]).await;

    let local_dir = TempDir::new().unwrap();
    let src_path = local_dir.path().join("photo.jpg");
    std::fs::write(&src_path, b"jpeg bytes").unwrap();

    let report = crate::client::push_file_to_peer(&peer_addr, &src_path, "photo.jpg", &did, &key)
        .await
        .unwrap();
    assert_eq!(report.outcome, super::pull::TransferOutcome::AlreadyPresent);
}

#[tokio::test]
async fn push_finds_identical_numbered_copy_on_peer() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let remote_dir = TempDir::new().unwrap();
    let peer_addr = start_server(
        &remote_dir,
        &[("photo.jpg", b"old version"), ("photo (1).jpg", b"new version")],
    )
    .await;

    let local_dir = TempDir::new().unwrap();
    let src_path = local_dir.path().join("photo.jpg");
    std::fs::write(&src_path, b"new version").unwrap();

    let report = crate::client::push_file_to_peer(&peer_addr, &src_path, "photo.jpg", &did, &key)
        .await
        .unwrap();
    assert_eq!(report.outcome, super::pull::TransferOutcome::AlreadyPresent);
    assert_eq!(report.dest_name, "photo (1).jpg");
    assert!(!remote_dir.path().join("photo (2).jpg").exists(), "no duplicate pile-up");
}

#[tokio::test]
async fn pull_finds_identical_numbered_copy_locally() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let remote_dir = TempDir::new().unwrap();
    let peer_addr = start_server(&remote_dir, &[("notes.txt", b"v2 text")]).await;

    let local_dir = TempDir::new().unwrap();
    std::fs::write(local_dir.path().join("notes.txt"), b"v1 text").unwrap();
    std::fs::write(local_dir.path().join("notes (1).txt"), b"v2 text").unwrap();

    let (_tx, rx) = cancel_channel();
    let report = super::pull_file_to_disk(
        "t",
        &peer_addr,
        "notes.txt",
        &local_dir.path().join("notes.txt"),
        Some(7),
        &did,
        &key,
        rx,
        |_| {},
    )
    .await
    .unwrap();

    assert_eq!(report.outcome, super::pull::TransferOutcome::AlreadyPresent);
    assert_eq!(report.dest_name, "notes (1).txt");
}

// ── Resume tests ─────────────────────────────────────────────────

/// A partial download of `name` as the client leaves it: the first `have`
/// bytes of `content`, plus the note naming the source and version.
fn seed_partial(local_dir: &std::path::Path, name: &str, content: &[u8], have: usize, etag: &str) {
    let source = format!("/files/{name}");
    let (data, note_path) = super::pull::partial_paths(&local_dir.join(name), &source);
    std::fs::write(data, &content[..have]).unwrap();
    let note = serde_json::json!({
        "source": source,
        "etag": etag,
        "size": content.len(),
    });
    std::fs::write(note_path, serde_json::to_vec(&note).unwrap()).unwrap();
}

fn etag_of(path: &std::path::Path) -> String {
    crate::range::etag(&std::fs::metadata(path).unwrap())
}

#[tokio::test]
async fn range_request_returns_only_the_tail() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let dir = TempDir::new().unwrap();
    let peer_addr = start_server(&dir, &[("r.bin", b"0123456789")]).await;
    let etag = etag_of(&dir.path().join("r.bin"));

    let res = super::transport::get_stream_at(&peer_addr, "/files/r.bin", Some((4, &etag)), &did, &key)
        .await
        .unwrap();
    assert_eq!(res.status(), 206);
    assert_eq!(
        res.headers().get("content-range").unwrap().to_str().unwrap(),
        "bytes 4-9/10"
    );
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"456789");

    // A stale version tag voids the range: the whole file comes back.
    let res = super::transport::get_stream_at(&peer_addr, "/files/r.bin", Some((4, "\"stale\"")), &did, &key)
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"0123456789");
}

#[tokio::test]
async fn pull_resumes_from_a_partial_file() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let content: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let remote_dir = TempDir::new().unwrap();
    let peer_addr = start_server(&remote_dir, &[("movie.bin", &content)]).await;
    let etag = etag_of(&remote_dir.path().join("movie.bin"));

    let local_dir = TempDir::new().unwrap();
    seed_partial(local_dir.path(), "movie.bin", &content, 120_000, &etag);

    let mut first_progress = None;
    let (_tx, rx) = cancel_channel();
    let report = super::pull_file_to_disk(
        "t",
        &peer_addr,
        "movie.bin",
        &local_dir.path().join("movie.bin"),
        Some(content.len() as u64),
        &did,
        &key,
        rx,
        |e| {
            if first_progress.is_none() && e.status == "in_progress" {
                first_progress = Some(e.bytes_transferred);
            }
        },
    )
    .await
    .unwrap();

    assert_eq!(report.outcome, super::pull::TransferOutcome::Transferred);
    assert_eq!(first_progress, Some(120_000), "progress starts where the partial ended");
    assert_eq!(std::fs::read(local_dir.path().join("movie.bin")).unwrap(), content);
    let (data, note) = super::pull::partial_paths(&local_dir.path().join("movie.bin"), "/files/movie.bin");
    assert!(!data.exists() && !note.exists());
}

#[tokio::test]
async fn stale_partial_is_replaced_by_a_full_download() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let remote_dir = TempDir::new().unwrap();
    let peer_addr = start_server(&remote_dir, &[("doc.txt", b"brand new contents")]).await;

    // A partial left from an older version of the file.
    let local_dir = TempDir::new().unwrap();
    seed_partial(local_dir.path(), "doc.txt", b"old old old old old", 8, "\"old-version\"");

    let (_tx, rx) = cancel_channel();
    super::pull_file_to_disk(
        "t", &peer_addr, "doc.txt", &local_dir.path().join("doc.txt"), None, &did, &key, rx, |_| {},
    )
    .await
    .unwrap();

    assert_eq!(std::fs::read(local_dir.path().join("doc.txt")).unwrap(), b"brand new contents");
}

#[tokio::test]
async fn complete_partial_is_just_renamed() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let remote_dir = TempDir::new().unwrap();
    let peer_addr = start_server(&remote_dir, &[("done.txt", b"all here")]).await;
    let etag = etag_of(&remote_dir.path().join("done.txt"));

    // Every byte arrived last time; only the final rename was lost.
    let local_dir = TempDir::new().unwrap();
    seed_partial(local_dir.path(), "done.txt", b"all here", 8, &etag);

    let (_tx, rx) = cancel_channel();
    let report = super::pull_file_to_disk(
        "t", &peer_addr, "done.txt", &local_dir.path().join("done.txt"), None, &did, &key, rx, |_| {},
    )
    .await
    .unwrap();

    assert_eq!(report.dest_name, "done.txt");
    assert_eq!(std::fs::read(local_dir.path().join("done.txt")).unwrap(), b"all here");
}

// ── Verification tests ───────────────────────────────────────────

#[tokio::test]
async fn corrupted_resume_is_caught_and_downloaded_again() {
    let key = test_keypair();
    let did = test_device_id(&key);
    let content: Vec<u8> = (0..50_000u32).map(|i| (i % 199) as u8).collect();
    let remote_dir = TempDir::new().unwrap();
    let peer_addr = start_server(&remote_dir, &[("clip.bin", &content)]).await;
    let etag = etag_of(&remote_dir.path().join("clip.bin"));

    // Right version tag, wrong bytes: resuming would stitch garbage onto
    // the real tail and produce a file of the right size.
    let mut damaged = content.clone();
    damaged[..20_000].fill(0xEE);
    let local_dir = TempDir::new().unwrap();
    seed_partial(local_dir.path(), "clip.bin", &damaged, 20_000, &etag);

    let mut statuses = Vec::new();
    let (_tx, rx) = cancel_channel();
    super::pull_file_to_disk(
        "t",
        &peer_addr,
        "clip.bin",
        &local_dir.path().join("clip.bin"),
        Some(content.len() as u64),
        &did,
        &key,
        rx,
        |e| statuses.push(e.status.clone()),
    )
    .await
    .unwrap();

    assert_eq!(std::fs::read(local_dir.path().join("clip.bin")).unwrap(), content);
    assert!(statuses.iter().filter(|s| *s == "verifying").count() >= 2, "{statuses:?}");
}
