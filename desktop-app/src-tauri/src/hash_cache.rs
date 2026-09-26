//! Recently computed SHA-256 digests, so a file is read once, not twice.
//!
//! Every transfer is verified (the receiver asks the sender for the file's
//! hash). Hashing it separately means reading the whole file a second time;
//! instead the sender hashes the bytes as it serves them and keeps the
//! result here, and the verification request that follows is answered from
//! memory. Duplicate checks and a second offer of the same file hit it too.
//!
//! In memory only, and small: a digest is useful for seconds to minutes
//! after it is computed, and after a restart hashing a file again costs
//! seconds. An entry is trusted only while the file's size and modified
//! time are unchanged, and a file modified in the last couple of seconds is
//! never cached -- it may still be changing within one timestamp tick
//! (the "racily clean" rule git uses for its index).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Entries kept; the least recently used goes first.
const CAPACITY: usize = 256;
/// A file changed this recently may still be changing: do not cache it.
const SETTLE_MS: u64 = 2_000;

#[derive(Clone)]
struct Entry {
    size: u64,
    modified_ms: u64,
    sha256: String,
    used: u64,
}

#[derive(Default)]
pub struct HashCache {
    map: Mutex<HashMap<PathBuf, Entry>>,
    clock: Mutex<u64>,
}

/// The process-wide cache.
pub fn global() -> &'static HashCache {
    static CACHE: OnceLock<HashCache> = OnceLock::new();
    CACHE.get_or_init(HashCache::default)
}

/// Size and modified time: what must be unchanged for a digest to hold.
pub fn stamp(meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    Some((meta.len(), crate::fs_util::modified_ms(meta)?))
}

impl HashCache {
    fn tick(&self) -> u64 {
        let mut c = self.clock.lock().unwrap();
        *c += 1;
        *c
    }

    /// The digest of `path`, if cached and the file is unchanged since.
    pub fn get(&self, path: &Path) -> Option<String> {
        let path = &key(path)?;
        let (size, modified_ms) = stamp(&std::fs::metadata(path).ok()?)?;
        let used = self.tick();
        let mut map = self.map.lock().unwrap();
        let entry = map.get_mut(path)?;
        if entry.size != size || entry.modified_ms != modified_ms {
            map.remove(path);
            return None;
        }
        entry.used = used;
        Some(entry.sha256.clone())
    }

    /// Remember `sha256` for `path`, as hashed when it had `hashed_stamp`.
    /// Skipped if the file has changed since, or changed too recently to
    /// trust.
    pub fn put(&self, path: &Path, hashed_stamp: (u64, u64), sha256: String) {
        let Some(path) = key(path) else { return };
        let path = path.as_path();
        let Some(now_stamp) = std::fs::metadata(path).ok().and_then(|m| stamp(&m)) else { return };
        if now_stamp != hashed_stamp {
            return; // changed while being hashed
        }
        if crate::presence::now_ms().saturating_sub(hashed_stamp.1) < SETTLE_MS {
            return; // racily clean: may still change within this tick
        }
        let used = self.tick();
        let mut map = self.map.lock().unwrap();
        if map.len() >= CAPACITY && !map.contains_key(path) {
            if let Some(oldest) = map.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone()) {
                map.remove(&oldest);
            }
        }
        map.insert(path.to_path_buf(), Entry { size: hashed_stamp.0, modified_ms: hashed_stamp.1, sha256, used });
    }
}

/// One key per file, however it was named: the server reaches files through
/// canonical paths (`\\?\C:\...` on Windows), other callers through plain ones.
fn key(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// SHA-256 of `path`, from the cache if it is unchanged, else read and
/// cached. Blocking; call from `spawn_blocking`.
pub fn sha256_file_cached(path: &Path) -> std::io::Result<String> {
    if let Some(hit) = global().get(path) {
        return Ok(hit);
    }
    let before = std::fs::metadata(path).ok().and_then(|m| stamp(&m));
    let sha = crate::dedupe::sha256_file(path)?;
    if let Some(stamp) = before {
        global().put(path, stamp, sha.clone());
    }
    Ok(sha)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    /// A file whose modified time is safely in the past.
    fn settled(dir: &tempfile::TempDir, name: &str, body: &[u8]) -> PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, body).unwrap();
        let old = SystemTime::now() - Duration::from_secs(60);
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(old).unwrap();
        path
    }

    fn stamp_of(path: &Path) -> (u64, u64) {
        stamp(&std::fs::metadata(path).unwrap()).unwrap()
    }

    #[test]
    fn a_cached_digest_holds_until_the_file_changes() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = settled(&dir, "a.bin", b"abc");
        let cache = HashCache::default();
        cache.put(&path, stamp_of(&path), "digest".into());
        assert_eq!(cache.get(&path).as_deref(), Some("digest"));

        std::fs::write(&path, b"abcd").unwrap();
        assert_eq!(cache.get(&path), None, "a changed file must miss");
    }

    #[test]
    fn a_just_modified_file_is_not_cached() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("fresh.bin");
        std::fs::write(&path, b"abc").unwrap();
        let cache = HashCache::default();
        cache.put(&path, stamp_of(&path), "digest".into());
        assert_eq!(cache.get(&path), None);
    }

    #[test]
    fn a_stamp_that_no_longer_matches_is_not_cached() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = settled(&dir, "b.bin", b"abc");
        let (size, modified) = stamp_of(&path);
        let cache = HashCache::default();
        cache.put(&path, (size + 1, modified), "digest".into());
        assert_eq!(cache.get(&path), None);
    }

    #[test]
    fn the_least_recently_used_entry_goes_first() {
        let dir = tempfile::TempDir::new().unwrap();
        let cache = HashCache::default();
        let paths: Vec<_> = (0..=CAPACITY).map(|i| settled(&dir, &format!("{i}.bin"), b"x")).collect();
        for p in &paths[..CAPACITY] {
            cache.put(p, stamp_of(p), "d".into());
        }
        cache.get(&paths[0]); // recently used: survives
        cache.put(&paths[CAPACITY], stamp_of(&paths[CAPACITY]), "d".into());
        assert!(cache.get(&paths[0]).is_some());
        assert!(cache.get(&paths[1]).is_none(), "the oldest unused entry was evicted");
    }
}
