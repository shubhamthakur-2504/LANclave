//! Skip transfers the destination already has.
//!
//! **Tier 1** compares name and size, which both sides already know from the
//! listing or a local `stat`. Different size means different file, and no one
//! hashes anything.
//!
//! **Tier 2** only runs when name and size match: the peer hashes its copy
//! on demand via `GET /api/sandbox/fingerprint/{name}?size=N`, we hash ours,
//! and equal digests mean the transfer is skipped. Cost scales with how many
//! files are ambiguous, not with folder size.
//!
//! Every uncertain answer -- file missing, a peer too old to have the route,
//! a network error -- resolves to "transfer it". A false skip silently loses
//! the file the user asked for; a false transfer only costs time.

use std::io::Read;
use std::path::Path;

use ed25519_dalek::SigningKey;

use crate::client::transport;

/// Wire format of the fingerprint endpoint, shared with the Kotlin server.
///
/// `sha256` is `None` when the caller's expected size did not match: the
/// server answers Tier 1 without paying for Tier 2.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Fingerprint {
    pub size: u64,
    pub sha256: Option<String>,
}

/// Hex SHA-256 of a whole file. Blocking; call from `spawn_blocking`.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};

    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

async fn sha256_file_async(path: &Path) -> std::io::Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || sha256_file(&path))
        .await
        .map_err(std::io::Error::other)?
}

/// Fingerprint a local file, hashing only when `expected_size` is absent or
/// matches. `Ok(None)` when there is no regular file at `path`.
pub async fn fingerprint_local(
    path: &Path,
    expected_size: Option<u64>,
) -> std::io::Result<Option<Fingerprint>> {
    let meta = match tokio::fs::metadata(path).await {
        Ok(m) if m.is_file() => m,
        Ok(_) => return Ok(None),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let size = meta.len();

    if expected_size.is_some_and(|expected| expected != size) {
        return Ok(Some(Fingerprint { size, sha256: None }));
    }

    let sha256 = sha256_file_async(path).await?;
    Ok(Some(Fingerprint {
        size,
        sha256: Some(sha256),
    }))
}

/// Does the peer already hold a byte-identical copy of `local_path` at
/// `remote_path`?
///
/// `known_remote_size` is the size from the peer's listing, when the caller
/// has one: a mismatch there answers the question with no network traffic.
pub(crate) async fn peer_has_identical(
    peer_addr: &str,
    remote_path: &str,
    local_path: &Path,
    known_remote_size: Option<u64>,
    device_id: &str,
    signing_key: &SigningKey,
) -> bool {
    // ---- Tier 1: sizes -------------------------------------------------
    let local_size = match tokio::fs::metadata(local_path).await {
        Ok(m) if m.is_file() => m.len(),
        _ => return false,
    };
    if known_remote_size.is_some_and(|remote| remote != local_size) {
        return false;
    }

    // ---- Tier 2: digests, only for same-name same-size files ------------
    let remote = match transport::get_fingerprint(
        peer_addr,
        remote_path,
        Some(local_size),
        device_id,
        signing_key,
    )
    .await
    {
        Ok(Some(fp)) => fp,
        _ => return false,
    };
    let Some(remote_sha) = remote.sha256 else {
        return false;
    };
    if remote.size != local_size {
        return false;
    }

    match sha256_file_async(local_path).await {
        Ok(local_sha) => local_sha.eq_ignore_ascii_case(&remote_sha),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn sha256_matches_known_vector() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("abc.txt");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[tokio::test]
    async fn fingerprint_local_skips_hash_on_size_mismatch() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("f.bin");
        std::fs::write(&path, b"12345").unwrap();

        let fp = fingerprint_local(&path, Some(4)).await.unwrap().unwrap();
        assert_eq!(fp, Fingerprint { size: 5, sha256: None });

        let fp = fingerprint_local(&path, Some(5)).await.unwrap().unwrap();
        assert!(fp.sha256.is_some());
    }

    #[tokio::test]
    async fn fingerprint_local_missing_is_none() {
        let dir = TempDir::new().unwrap();
        let fp = fingerprint_local(&dir.path().join("nope"), None).await.unwrap();
        assert!(fp.is_none());
    }
}
