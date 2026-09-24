use std::path::PathBuf;

/// A guard that deletes a partially‑written file on drop unless
/// [`Self::disarm`] is called first.
///
/// # Why RAII (Drop) instead of explicit cleanup?
///
/// * **Coverage** – `Drop` runs on every exit path: early `return`,
///   the `?` operator, and even panics.  An explicit `if let Err` /
///   `match` chain on every branch is easy to forget and becomes
///   brittle as the function evolves.
/// * **Idiom** – This is the standard Rust pattern for resource
///   cleanup (c.f. `MutexGuard`, `tempfile::TempDir`, etc.).
///
/// The guard is *armed* at construction and *disarmed* by calling
/// [`disarm`](Self::disarm) once the file is fully written.
pub struct WriteGuard {
    path: Option<PathBuf>,
}

impl WriteGuard {
    /// Arm the guard: the file at `path` will be deleted on drop
    /// unless disarmed first.
    pub fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    /// Disarm the guard: the file is now fully written and should
    /// survive drop.
    pub fn disarm(&mut self) {
        self.path.take();
    }
}

impl Drop for WriteGuard {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Last-modified time as Unix milliseconds, for sorting file lists.
/// `None` where the platform or filesystem does not report one.
pub fn modified_ms(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// `"notes.txt"` with `n = 1` becomes `"notes (1).txt"`; `n = 0` is the name
/// itself. The same scheme Android's SAF uses, so both apps name collisions
/// alike.
pub fn numbered_name(file_name: &str, n: u32) -> String {
    if n == 0 {
        return file_name.to_string();
    }
    let path = std::path::Path::new(file_name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
    match path.extension().and_then(|s| s.to_str()) {
        Some(ext) => format!("{stem} ({n}).{ext}"),
        None => format!("{stem} ({n})"),
    }
}

/// Create a new file at `path`, or at the first free `name (n).ext` beside
/// it. Never overwrites.
///
/// Each attempt is an atomic `create_new`, so two writers racing for the
/// same name each get their own file instead of interleaving into one.
pub async fn create_unique(path: &std::path::Path) -> std::io::Result<(tokio::fs::File, PathBuf)> {
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new(""));
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;

    for n in 0..10_000 {
        let candidate = dir.join(numbered_name(file_name, n));
        match tokio::fs::File::create_new(&candidate).await {
            Ok(file) => return Ok((file, candidate)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "no free name for this file",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbered_name_keeps_extension() {
        assert_eq!(numbered_name("notes.txt", 0), "notes.txt");
        assert_eq!(numbered_name("notes.txt", 2), "notes (2).txt");
        assert_eq!(numbered_name("README", 1), "README (1)");
        assert_eq!(numbered_name("archive.tar.gz", 1), "archive.tar (1).gz");
    }

    #[tokio::test]
    async fn create_unique_never_overwrites() {
        let dir = tempfile::TempDir::new().unwrap();
        let target = dir.path().join("a.txt");
        std::fs::write(&target, b"original").unwrap();

        let (_f, first) = create_unique(&target).await.unwrap();
        let (_g, second) = create_unique(&target).await.unwrap();

        assert_eq!(first, dir.path().join("a (1).txt"));
        assert_eq!(second, dir.path().join("a (2).txt"));
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
    }
}
