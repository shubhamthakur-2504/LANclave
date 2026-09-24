use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};
use std::sync::Arc;
use tokio::{
    fs as tokio_fs,
    io::{AsyncWriteExt, BufReader, BufWriter},
};
use tokio_util::io::ReaderStream;

use crate::server::AppState;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum payload size for a single file upload (10 GiB).
///
/// Overridden in test builds so the size-limit test doesn't need gigabytes
/// of memory.
const MAX_UPLOAD_SIZE: u64 = if cfg!(test) { 200_000 } else { 10_737_418_240 };

// ---------------------------------------------------------------------------
// Clean‑up guard
// ---------------------------------------------------------------------------

use crate::fs_util::WriteGuard;

// ---------------------------------------------------------------------------
// Download handler
// ---------------------------------------------------------------------------

/// Download a file from the sandboxed vault, identified by its relative path.
///
/// ## TOCTOU (Time‑Of‑Check Time‑Of‑Use)
///
/// `verify_sandboxed_path` canonicalises the path and confirms it lives
/// inside `sandbox_root`.  Between that call and `tokio::fs::metadata` /
/// `File::open` the file could be deleted, renamed, or replaced.  The
/// `metadata` call — which runs immediately before `File::open` — narrows
/// this window.
///
/// **Accepted limitation:** a determined local attacker who already has
/// write access to the sandbox folder could race the window and replace the
/// file with a symlink pointing outside.  Since LANclave is a single‑user
/// local‑LAN tool this is out of scope for v1.  Revisit with `O_NOFOLLOW`
/// if multi‑user access control is ever added.
pub async fn download_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(requested_path): Path<String>,
) -> Result<Response, StatusCode> {
    // ---- 0. Authorize (pairing check) ------------------------------------
    crate::pairing::check_request(&state.auth, &headers)
        .map_err(|s| StatusCode::from_u16(s.code()).expect("valid HTTP status"))?;

    let sandbox_root = {
        let settings = state.settings.read().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        std::path::PathBuf::from(&settings.sandbox_path)
    };

    let path = crate::sandbox::verify_sandboxed_path(&sandbox_root, &requested_path)
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let metadata = tokio_fs::metadata(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    if !metadata.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }

    let file = tokio_fs::File::open(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let content_length = metadata.len();
    let content_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();

    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let content_disposition = format!("attachment; filename=\"{}\"", filename);

    let reader = BufReader::new(file);
    let stream = ReaderStream::with_capacity(reader, 64 * 1024);
    let body = axum::body::Body::from_stream(stream);

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, content_length.to_string())
        .header(header::CONTENT_DISPOSITION, content_disposition)
        .body(body)
        .unwrap();

    Ok(response)
}

// ---------------------------------------------------------------------------
// Upload handler
// ---------------------------------------------------------------------------

/// Upload (push) a file into the sandboxed vault at the given relative path.
///
/// The caller sends the file bytes in the request body.  The handler streams
/// them to disk in 64 KB chunks — never buffering the whole upload in memory.
/// On success, returns **201 Created**; on failure, the partial file is
/// deleted and an appropriate error status is returned.
///
/// ## TOCTOU (Time‑Of‑Check Time‑Of‑Use)
///
/// As with [`download_file`], `verify_sandboxed_path` pins the destination
/// inside the sandbox.  The `File::create_new` call below is **atomic** — it
/// simultaneously creates the file and checks that it didn't already exist.
pub async fn upload_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(requested_path): Path<String>,
    body: axum::body::Body,
) -> Result<(StatusCode, &'static str), StatusCode> {
    // ---- 0. Authorize (pairing check) ------------------------------------
    crate::pairing::check_request(&state.auth, &headers)
        .map_err(|s| StatusCode::from_u16(s.code()).expect("valid HTTP status"))?;

    let sandbox_root = {
        let settings = state.settings.read().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        std::path::PathBuf::from(&settings.sandbox_path)
    };

    // ---- 1. Lexical validation only (no I/O) ----------------------------
    let joined =
        crate::sandbox::validate_sandboxed_path(&sandbox_root, &requested_path)
            .map_err(|_| StatusCode::BAD_REQUEST)?;

    // ---- 2. Ensure the parent directory tree exists ----------------------
    if let Some(parent) = joined.parent() {
        tokio_fs::create_dir_all(parent)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    // ---- 3. Full canonicalised validation -------------------------------
    let path = crate::sandbox::verify_sandboxed_path(&sandbox_root, &requested_path)
        .map_err(|_| StatusCode::BAD_REQUEST)?;

    // ---- 4. Atomically create the file (fails if already exists) ---------
    let file = match tokio_fs::File::create_new(&path).await {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(StatusCode::CONFLICT);
        }
        Err(_) => return Err(StatusCode::INTERNAL_SERVER_ERROR),
    };

    // ---- 5. Arm the cleanup guard ----------------------------------------
    let mut guard = WriteGuard::new(path.clone());

    // ---- 6. Stream the request body to disk in 64 KB chunks --------------
    use bytes::Bytes;
    use futures_util::StreamExt;
    use http_body_util::BodyStream;

    let mut writer = BufWriter::with_capacity(64 * 1024, file);
    let mut stream = BodyStream::new(body);
    let mut written: u64 = 0;

    while let Some(chunk_result) = stream.next().await {
        let frame = chunk_result.map_err(|_| StatusCode::BAD_REQUEST)?;
        let chunk: Bytes = frame.data_ref().ok_or(StatusCode::BAD_REQUEST)?.clone();
        let chunk_len = chunk.len() as u64;

        if written.saturating_add(chunk_len) > MAX_UPLOAD_SIZE {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }

        writer
            .write_all(&chunk)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        written += chunk_len;
    }

    writer
        .flush()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    guard.disarm();
    Ok((StatusCode::CREATED, ""))
}

// ---------------------------------------------------------------------------
// File-list handler (for remote peers)
// ---------------------------------------------------------------------------

/// List the contents of our sandbox root (public endpoint for remote peers).
///
/// This handler is mounted at `GET /api/sandbox/files` and requires the
/// same pairing‑auth as any other route.
pub async fn list_files_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<ListFileItem>>, StatusCode> {
    // ---- 0. Authorize ----------------------------------------------------
    crate::pairing::check_request(&state.auth, &headers)
        .map_err(|s| StatusCode::from_u16(s.code()).expect("valid HTTP status"))?;

    let sandbox_root = {
        let settings = state.settings.read().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        std::path::PathBuf::from(&settings.sandbox_path)
    };

    // ---- 1. Scan the sandbox root ----------------------------------------
    let mut entries = Vec::new();
    let mut dir = tokio_fs::read_dir(&sandbox_root)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    while let Some(entry) = dir.next_entry().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)? {
        let name = entry.file_name().into_string().unwrap_or_default();
        // Skip hidden files and internal system files
        if name.starts_with('.') || name == "paired_devices.json" || name == "identity.json" {
            continue;
        }
        let metadata = match entry.metadata().await {
            Ok(m) => m,
            Err(_) => continue,
        };
        entries.push(ListFileItem {
            name,
            size: metadata.len(),
            is_directory: metadata.is_dir(),
        });
    }

    Ok(Json(entries))
}

// ---------------------------------------------------------------------------
// Fingerprint handler (on-demand dedupe, see `crate::dedupe`)
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct FingerprintQuery {
    /// The size the caller holds. When ours differs we answer without
    /// hashing -- the files cannot be identical.
    pub size: Option<u64>,
}

/// `GET /api/sandbox/fingerprint/{*path}` -- size and SHA-256 of one file.
///
/// Deliberately separate from the listing: hashing costs a full read, so it
/// is paid only for the few files a peer cannot tell apart by name and size.
pub async fn fingerprint_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(requested_path): Path<String>,
    axum::extract::Query(query): axum::extract::Query<FingerprintQuery>,
) -> Result<Json<crate::dedupe::Fingerprint>, StatusCode> {
    crate::pairing::check_request(&state.auth, &headers)
        .map_err(|s| StatusCode::from_u16(s.code()).expect("valid HTTP status"))?;

    let sandbox_root = {
        let settings = state.settings.read().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        std::path::PathBuf::from(&settings.sandbox_path)
    };

    let path = crate::sandbox::verify_sandboxed_path(&sandbox_root, &requested_path)
        .map_err(|_| StatusCode::NOT_FOUND)?;

    match crate::dedupe::fingerprint_local(&path, query.size).await {
        Ok(Some(fp)) => Ok(Json(fp)),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Serializable file entry for the JSON list endpoint.
#[derive(serde::Serialize)]
pub struct ListFileItem {
    pub name: String,
    pub size: u64,
    pub is_directory: bool,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use bytes::Bytes;
    use tempfile::TempDir;
    use tower::ServiceExt;

    use crate::server::build_raw_router;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn make_state(dir: &TempDir) -> Arc<AppState> {
        use rand::rngs::OsRng;
        Arc::new(AppState {
            settings: Arc::new(std::sync::RwLock::new(crate::settings::AppSettings {
                display_name: "Test Node".to_string(),
                sandbox_path: dir.path().to_string_lossy().into_owned(),
            })),
            device_id: "test-device".to_string(),
            identity_key: ed25519_dalek::SigningKey::generate(&mut OsRng),
            app_handle: None,
            presence: std::sync::Arc::new(crate::presence::PresenceStore::new()),
            auth: Arc::new(crate::pairing::AuthState::disabled()),
        })
    }

    fn setup_with_file(file_name: &str, contents: &[u8]) -> (TempDir, axum::Router) {
        let dir = TempDir::new().expect("create temp dir");
        let file_path = dir.path().join(file_name);
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).expect("create parent dirs");
        }
        std::fs::write(&file_path, contents).expect("write test file");

        let app = build_raw_router(make_state(&dir));
        (dir, app)
    }

    fn empty_router() -> (TempDir, axum::Router) {
        let dir = TempDir::new().expect("create temp dir");
        let app = build_raw_router(make_state(&dir));
        (dir, app)
    }

    // =======================================================================
    // Upload tests
    // =======================================================================

    #[tokio::test]
    async fn upload_small_file() {
        let (_dir, app) = empty_router();
        let payload = b"hello from peer!";

        let req = Request::builder()
            .method("PUT")
            .uri("/files/incoming.txt")
            .header("Content-Type", "application/octet-stream")
            .body(axum::body::Body::from(Bytes::from_static(payload)))
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);

        let saved = std::fs::read(_dir.path().join("incoming.txt")).unwrap();
        assert_eq!(saved, payload);
    }

    #[tokio::test]
    async fn upload_file_in_subdirectory_creates_parents() {
        let (_dir, app) = empty_router();

        let req = Request::builder()
            .method("PUT")
            .uri("/files/deeply/nested/note.md")
            .header("Content-Type", "text/markdown")
            .body(axum::body::Body::from(Bytes::from_static(b"# Hello")))
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);

        let saved = std::fs::read(_dir.path().join("deeply/nested/note.md")).unwrap();
        assert_eq!(saved, b"# Hello");
    }

    #[tokio::test]
    async fn upload_traversal_dotdot_returns_400() {
        let (_dir, app) = empty_router();

        let req = Request::builder()
            .method("PUT")
            .uri("/files/../../etc/passwd")
            .header("Content-Type", "application/octet-stream")
            .body(axum::body::Body::from(Bytes::from_static(b"pwned")))
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn upload_existing_file_returns_409() {
        let (_dir, app) = setup_with_file("existing.bin", b"original data");

        let req = Request::builder()
            .method("PUT")
            .uri("/files/existing.bin")
            .header("Content-Type", "application/octet-stream")
            .body(axum::body::Body::from(Bytes::from_static(b"overwrite")))
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::CONFLICT);

        let saved = std::fs::read(_dir.path().join("existing.bin")).unwrap();
        assert_eq!(saved, b"original data");
    }

    #[tokio::test]
    async fn upload_exceeds_size_limit_returns_413_and_no_partial_file() {
        let (_dir, app) = empty_router();
        let oversized = vec![0u8; 200_001];

        let req = Request::builder()
            .method("PUT")
            .uri("/files/too_big.bin")
            .header("Content-Type", "application/octet-stream")
            .body(axum::body::Body::from(Bytes::from(oversized)))
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let full_path = _dir.path().join("too_big.bin");
        assert!(
            !full_path.exists(),
            "partial file must be cleaned up after size-limit rejection"
        );
    }

    #[tokio::test]
    async fn upload_large_file_content_matches() {
        let (_dir, app) = empty_router();
        let payload = vec![0xBBu8; 65_536 + 1];

        let req = Request::builder()
            .method("PUT")
            .uri("/files/large.bin")
            .header("Content-Type", "application/octet-stream")
            .body(axum::body::Body::from(Bytes::from(payload.clone())))
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::CREATED);

        let saved = std::fs::read(_dir.path().join("large.bin")).unwrap();
        assert_eq!(saved.len(), payload.len());
        assert!(saved.iter().all(|b| *b == 0xBB));
    }

    // =======================================================================
    // Download tests
    // =======================================================================

    #[tokio::test]
    async fn download_returns_200_with_correct_body() {
        let (_dir, app) = setup_with_file("hello.txt", b"Hello, LANclave!");

        let req = Request::builder()
            .uri("/files/hello.txt")
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let ct = res
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok());
        assert_eq!(ct, Some("text/plain"));

        use http_body_util::BodyExt;
        let body_bytes = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body_bytes, Bytes::from_static(b"Hello, LANclave!"));
    }

    #[tokio::test]
    async fn download_file_in_subdirectory() {
        let (_dir, app) = setup_with_file("docs/report.pdf", b"%PDF-1.4 mock");

        let req = Request::builder()
            .uri("/files/docs/report.pdf")
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        use http_body_util::BodyExt;
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body, Bytes::from_static(b"%PDF-1.4 mock"));
    }

    #[tokio::test]
    async fn traversal_dotdot_returns_404() {
        let (_dir, app) = setup_with_file("innocent.txt", b"safe");

        let req = Request::builder()
            .uri("/files/../../etc/passwd")
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn absolute_path_returns_404() {
        let (_dir, app) = setup_with_file("innocent.txt", b"safe");

        let req = Request::builder()
            .uri("/files//etc/passwd")
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn nonexistent_file_returns_404() {
        let (_dir, app) = setup_with_file("actual.txt", b"real");

        let req = Request::builder()
            .uri("/files/nope.txt")
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn directory_returns_404() {
        let (_dir, app) = setup_with_file("subdir/dummy", b"x");

        let req = Request::builder()
            .uri("/files/subdir")
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn content_type_falls_back_to_octet_stream() {
        let (_dir, app) = setup_with_file("data.bin", &[0u8; 32]);

        let req = Request::builder()
            .uri("/files/data.bin")
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        let ct = res
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok());
        assert_eq!(ct, Some("application/octet-stream"));
    }

    #[tokio::test]
    async fn content_length_is_correct() {
        let big = vec![0xABu8; 65_000];
        let (_dir, app) = setup_with_file("big.bin", &big);

        let req = Request::builder()
            .uri("/files/big.bin")
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();

        let len: usize = res
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap();
        assert_eq!(len, 65_000);

        use http_body_util::BodyExt;
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body.len(), 65_000);
        assert_eq!(body[0], 0xAB);
        assert_eq!(body[64_999], 0xAB);
    }
}
