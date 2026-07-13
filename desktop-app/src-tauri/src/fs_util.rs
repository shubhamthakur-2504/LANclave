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
