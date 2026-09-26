//! Resumable downloads: HTTP `Range` / `If-Range` on the serving side, and
//! the shared file-serving routine both download routes use.
//!
//! Only the one form a resuming client needs is supported: `bytes=N-`,
//! "everything from byte N". The `ETag` is the file's size and modified
//! time; a client resuming sends it back as `If-Range`, and if the file has
//! changed since, it gets the whole new file (`200`) instead of the tail of
//! the new one spliced onto the head of the old.

use axum::{
    http::{header, HeaderMap, StatusCode},
    response::Response,
};
use std::path::Path;
use tokio::io::{AsyncSeekExt, BufReader};
use tokio_util::io::ReaderStream;

/// What a request asked for, resolved against the file's current state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Requested {
    /// No usable range: send the whole file with `200`.
    Full,
    /// Send from this byte to the end with `206`.
    From(u64),
    /// The start is at or past the end: `416`.
    Unsatisfiable,
}

/// Version tag for a file: size and modified time, quoted as HTTP requires.
pub fn etag(meta: &std::fs::Metadata) -> String {
    let modified = crate::fs_util::modified_ms(meta).unwrap_or(0);
    format!("\"{:x}-{:x}\"", meta.len(), modified)
}

/// Resolve `Range` / `If-Range` against a file of `size` bytes whose
/// current tag is `current_etag`.
pub fn requested(headers: &HeaderMap, current_etag: &str, size: u64) -> Requested {
    let Some(range) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) else {
        return Requested::Full;
    };

    // A range conditional on an older version of the file is void: the
    // client's partial copy belongs to content that no longer exists.
    if let Some(if_range) = headers.get(header::IF_RANGE).and_then(|v| v.to_str().ok()) {
        if if_range.trim() != current_etag {
            return Requested::Full;
        }
    }

    match parse_open_range(range) {
        Some(start) if start >= size => Requested::Unsatisfiable,
        Some(0) | None => Requested::Full,
        Some(start) => Requested::From(start),
    }
}

/// `bytes=N-` -> `Some(N)`. Anything else (suffix ranges, multiple ranges,
/// closed ranges) is ignored, which RFC 9110 allows: the server may always
/// answer with the full representation instead.
fn parse_open_range(value: &str) -> Option<u64> {
    let spec = value.trim().strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    if !end.trim().is_empty() || spec.contains(',') {
        return None;
    }
    start.trim().parse().ok()
}

/// Gets told how a served body is going, so a caller can log or report it.
/// Dropped when the body is -- finished or abandoned -- which is when it
/// should record the outcome.
pub trait ServeObserver: Send + 'static {
    /// `start` is the first byte sent, `len` how many this response will send.
    fn on_start(&mut self, start: u64, len: u64);
    fn add_bytes(&mut self, n: u64);
}

/// Serve `path` honouring `Range`/`If-Range`, streaming in 64 KiB chunks.
pub async fn serve_file(
    path: &Path,
    headers: &HeaderMap,
    download_name: &str,
    mut observer: impl ServeObserver,
) -> Result<Response, StatusCode> {
    let meta = tokio::fs::metadata(path).await.map_err(|_| StatusCode::NOT_FOUND)?;
    if !meta.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    let size = meta.len();
    let tag = etag(&meta);

    let start = match requested(headers, &tag, size) {
        Requested::Unsatisfiable => {
            return Ok(Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .header(header::ETAG, &tag)
                .body(axum::body::Body::empty())
                .unwrap());
        }
        Requested::From(n) => Some(n),
        Requested::Full => None,
    };

    let mut file = tokio::fs::File::open(path).await.map_err(|_| StatusCode::NOT_FOUND)?;
    if let Some(n) = start {
        file.seek(std::io::SeekFrom::Start(n))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    let first = start.unwrap_or(0);
    let len = size - first;
    observer.on_start(first, len);

    // Sending the whole file: hash it on the way out, so the receiver's
    // verification is answered from the cache instead of a second read.
    // A resumed (partial) response cannot, and falls back to hashing later.
    let mut tap = match (start, crate::hash_cache::stamp(&meta)) {
        (None, Some(stamp)) => Some(HashTap::new(path.to_path_buf(), stamp)),
        _ => None,
    };

    use futures_util::StreamExt;
    let stream = ReaderStream::with_capacity(BufReader::new(file), 64 * 1024).map(move |chunk| {
        if let Ok(bytes) = &chunk {
            // Method calls, not field updates: edition-2021 closures
            // capture only the fields they touch, which would move a copy
            // of a counter in and leave the observer to drop -- and record
            // a failed transfer -- as soon as this function returns.
            observer.add_bytes(bytes.len() as u64);
            if let Some(t) = tap.as_mut() {
                t.update(bytes);
            }
        }
        chunk
    });

    let content_type = mime_guess::from_path(path).first_or_octet_stream().to_string();
    let mut builder = Response::builder()
        .status(if start.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, len.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, &tag)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", download_name.replace('"', "")),
        );
    if let Some(n) = start {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {n}-{}/{size}", size - 1));
    }
    Ok(builder.body(axum::body::Body::from_stream(stream)).unwrap())
}

/// Hashes a file as it is served; caches the digest once every byte went out.
struct HashTap {
    path: std::path::PathBuf,
    stamp: (u64, u64),
    seen: u64,
    hasher: Option<sha2::Sha256>,
}

impl HashTap {
    fn new(path: std::path::PathBuf, stamp: (u64, u64)) -> Self {
        use sha2::Digest;
        Self { path, stamp, seen: 0, hasher: Some(sha2::Sha256::new()) }
    }

    fn update(&mut self, bytes: &[u8]) {
        use sha2::Digest;
        let Some(h) = self.hasher.as_mut() else { return };
        h.update(bytes);
        self.seen += bytes.len() as u64;
        if self.seen == self.stamp.0 {
            let digest = self.hasher.take().unwrap().finalize();
            let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
            // `put` re-checks the file is unchanged since serving began.
            crate::hash_cache::global().put(&self.path, self.stamp, hex);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn with(range: &str, if_range: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::RANGE, HeaderValue::from_str(range).unwrap());
        if let Some(v) = if_range {
            h.insert(header::IF_RANGE, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn open_range_resolves() {
        assert_eq!(requested(&with("bytes=10-", None), "\"t\"", 100), Requested::From(10));
        assert_eq!(requested(&with("bytes=0-", None), "\"t\"", 100), Requested::Full);
        assert_eq!(requested(&HeaderMap::new(), "\"t\"", 100), Requested::Full);
    }

    #[test]
    fn past_the_end_is_unsatisfiable() {
        assert_eq!(requested(&with("bytes=100-", None), "\"t\"", 100), Requested::Unsatisfiable);
        assert_eq!(requested(&with("bytes=5-", None), "\"t\"", 0), Requested::Unsatisfiable);
    }

    #[test]
    fn stale_if_range_gets_the_whole_file() {
        assert_eq!(requested(&with("bytes=10-", Some("\"old\"")), "\"new\"", 100), Requested::Full);
        assert_eq!(requested(&with("bytes=10-", Some("\"new\"")), "\"new\"", 100), Requested::From(10));
    }

    #[test]
    fn unsupported_forms_fall_back_to_full() {
        for r in ["bytes=-10", "bytes=0-9", "bytes=1-,5-", "items=1-", "bytes=x-"] {
            assert_eq!(requested(&with(r, None), "\"t\"", 100), Requested::Full, "{r}");
        }
    }
}
