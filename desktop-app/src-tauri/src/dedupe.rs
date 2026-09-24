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
//! "Name" includes numbered copies. A clash is saved as `name (1).ext`
//! rather than overwriting (see [`crate::fs_util::create_unique`]), so an
//! identical copy may live under a numbered name; without looking there, a
//! repeat transfer would pile up `name (2)`, `name (3)`, ...
//!
//! Every uncertain answer -- file missing, a peer too old to have the route,
//! a network error -- resolves to "transfer it". A false skip silently loses
//! the file the user asked for; a false transfer only costs time.

use std::io::Read;
use std::path::{Path, PathBuf};

use ed25519_dalek::SigningKey;

use crate::client::transport;
use crate::fs_util::numbered_name;

/// How many numbered copies (`name (1)` ... `name (N)`) are considered.
const MAX_SIBLINGS: u32 = 50;

/// Wire format of the fingerprint endpoint, shared with the Kotlin server.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Fingerprint {
    /// Size of the file under the exact requested name.
    pub size: u64,
    /// Its SHA-256, or `None` when the caller's expected size did not match:
    /// the server answers Tier 1 without paying for Tier 2.
    pub sha256: Option<String>,
    /// Numbered copies (`name (1).ext`, ...) whose size matched the caller's
    /// expected size, with their digests. Empty without an expected size.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub siblings: Vec<SiblingDigest>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SiblingDigest {
    pub name: String,
    pub sha256: String,
}

impl Fingerprint {
    /// The name on this side holding content `sha256`, if any. `base_name`
    /// is the exact name the fingerprint was requested for.
    fn holder_of(&self, base_name: &str, sha256: &str) -> Option<String> {
        if self.sha256.as_deref().is_some_and(|s| s.eq_ignore_ascii_case(sha256)) {
            return Some(base_name.to_string());
        }
        self.siblings
            .iter()
            .find(|s| s.sha256.eq_ignore_ascii_case(sha256))
            .map(|s| s.name.clone())
    }
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

async fn file_size(path: &Path) -> Option<u64> {
    match tokio::fs::metadata(path).await {
        Ok(m) if m.is_file() => Some(m.len()),
        _ => None,
    }
}

/// Numbered copies of `path` of exactly `size` bytes, in order. The scan
/// stops at the first missing number.
async fn same_size_siblings(path: &Path, size: u64) -> Vec<PathBuf> {
    let dir = path.parent().unwrap_or_else(|| Path::new(""));
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return Vec::new();
    };

    let mut found = Vec::new();
    for n in 1..=MAX_SIBLINGS {
        let candidate = dir.join(numbered_name(name, n));
        match file_size(&candidate).await {
            Some(s) if s == size => found.push(candidate),
            Some(_) => {}
            None => break,
        }
    }
    found
}

/// Fingerprint a local file for the endpoint. Hashes only what can match:
/// with `expected_size`, the file itself only if its size agrees, plus any
/// numbered copies of that size. `Ok(None)` when there is no regular file at
/// `path`.
pub async fn fingerprint_local(
    path: &Path,
    expected_size: Option<u64>,
    with_siblings: bool,
) -> std::io::Result<Option<Fingerprint>> {
    let Some(size) = file_size(path).await else {
        return Ok(None);
    };

    let Some(expected) = expected_size else {
        let sha256 = sha256_file_async(path).await?;
        return Ok(Some(Fingerprint { size, sha256: Some(sha256), siblings: Vec::new() }));
    };

    let sha256 = if size == expected {
        Some(sha256_file_async(path).await?)
    } else {
        None
    };

    let mut siblings = Vec::new();
    let candidates = if with_siblings { same_size_siblings(path, expected).await } else { Vec::new() };
    for sibling in candidates {
        let name = sibling
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        siblings.push(SiblingDigest { name, sha256: sha256_file_async(&sibling).await? });
    }

    Ok(Some(Fingerprint { size, sha256, siblings }))
}

/// Before a pull: does our side already hold the peer's file (whose
/// fingerprint route is `fingerprint_path`), under `local_path` or a
/// numbered copy of it? Returns the local path.
///
/// `known_remote_size` is the size from the peer's listing; with it, a
/// size mismatch on every local candidate needs no network traffic at all.
pub(crate) async fn local_copy_of(
    peer_addr: &str,
    fingerprint_path: &str,
    local_path: &Path,
    known_remote_size: Option<u64>,
    device_id: &str,
    signing_key: &SigningKey,
) -> Option<PathBuf> {
    // ---- Tier 1: sizes, all local ---------------------------------------
    let base_size = file_size(local_path).await;
    let size = known_remote_size.or(base_size)?;

    let mut candidates = Vec::new();
    if base_size == Some(size) {
        candidates.push(local_path.to_path_buf());
    }
    candidates.extend(same_size_siblings(local_path, size).await);
    if candidates.is_empty() {
        return None;
    }

    // ---- Tier 2: digests ------------------------------------------------
    let remote = transport::get_fingerprint_at(peer_addr, fingerprint_path, Some(size), device_id, signing_key)
        .await
        .ok()??;
    let remote_sha = remote.sha256.filter(|_| remote.size == size)?;

    for candidate in candidates {
        if let Ok(local_sha) = sha256_file_async(&candidate).await {
            if local_sha.eq_ignore_ascii_case(&remote_sha) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Before a push: does the peer already hold `local_path`'s content under
/// `remote_path` or a numbered copy of it? Returns the peer-side name.
pub(crate) async fn peer_copy_of(
    peer_addr: &str,
    remote_path: &str,
    local_path: &Path,
    device_id: &str,
    signing_key: &SigningKey,
) -> Option<String> {
    let size = file_size(local_path).await?;

    // The peer does Tier 1 itself and hashes only same-size candidates.
    let remote = transport::get_fingerprint(peer_addr, remote_path, Some(size), device_id, signing_key)
        .await
        .ok()??;
    if remote.sha256.is_none() && remote.siblings.is_empty() {
        return None;
    }

    let local_sha = sha256_file_async(local_path).await.ok()?;
    let base_name = remote_path.rsplit('/').next().unwrap_or(remote_path);
    let holder = remote.holder_of(base_name, &local_sha)?;
    Some(match remote_path.rsplit_once('/') {
        Some((dir, _)) => format!("{dir}/{holder}"),
        None => holder,
    })
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

        let fp = fingerprint_local(&path, Some(4), true).await.unwrap().unwrap();
        assert_eq!(fp, Fingerprint { size: 5, sha256: None, siblings: vec![] });

        let fp = fingerprint_local(&path, Some(5), true).await.unwrap().unwrap();
        assert!(fp.sha256.is_some());
    }

    #[tokio::test]
    async fn fingerprint_local_reports_same_size_siblings_only() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"old").unwrap();
        std::fs::write(dir.path().join("a (1).txt"), b"newer").unwrap();
        std::fs::write(dir.path().join("a (2).txt"), b"toolong!").unwrap();
        std::fs::write(dir.path().join("a (3).txt"), b"other").unwrap();

        let fp = fingerprint_local(&dir.path().join("a.txt"), Some(5), true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fp.sha256, None);
        let names: Vec<_> = fp.siblings.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["a (1).txt", "a (3).txt"]);
    }

    #[tokio::test]
    async fn fingerprint_local_missing_is_none() {
        let dir = TempDir::new().unwrap();
        let fp = fingerprint_local(&dir.path().join("nope"), None, true).await.unwrap();
        assert!(fp.is_none());
    }
}
