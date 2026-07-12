use std::fs;
use std::path::{Component, Path, PathBuf};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// Errors returned by [`verify_sandboxed_path`].
///
/// The caller **must** treat `TraversalAttempt` and `InvalidPath` as security
/// events — the connection should be closed immediately and **no** partial
/// error details should be sent to the remote client (doing so would leak
/// information about the filesystem layout).  The `Display` impl intentionally
/// hides those details; use the `Debug` or `kind()` discriminant for your
/// own server-side logging.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxError {
    /// The requested path attempted to escape the sandbox (e.g. `..` components
    /// that resolve outside the root, or a symlink pointing outwards).
    TraversalAttempt,
    /// The request path is syntactically invalid (null bytes, an absolute path
    /// prefix, or empty).
    InvalidPath,
    /// An I/O error occurred while resolving the path on disk.
    IoError(String),
}

impl std::fmt::Display for SandboxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // Keep the client-facing message opaque — never leak filesystem
            // structure to a potential attacker.
            Self::TraversalAttempt | Self::InvalidPath => {
                f.write_str("invalid path")
            }
            Self::IoError(msg) => write!(f, "I/O error: {msg}"),
        }
    }
}

impl std::error::Error for SandboxError {}

// ---------------------------------------------------------------------------
// Core validator
// ---------------------------------------------------------------------------

/// Verify that `requested_path` is a safe, sandboxed sub-path of
/// `sandbox_root`, and return its canonical (`std::fs::canonicalize`-resolved)
/// absolute [`PathBuf`].
///
/// # Security model
///
/// This is the **single most security-critical function** in LANclave.  Every
/// filesystem operation — file download, upload, listing, and deletion — must
/// route through this function before touching the disk.
///
/// The verification happens in three layers, each catching attacks the
/// previous layer might miss:
///
/// 1. **Lexical pre-checks** (before any I/O)
///    - Reject empty paths.
///    - Reject **null bytes** (`\0`), which can trick C runtime APIs into
///      silently truncating the path at the null position.
///    - Reject `..` path components, which are the standard traversal vector.
///      We use `Path::components()` to match the semantic component `..`
///      rather than doing a naive string search (which would flag innocent
///      filenames like `foo..bar`).
///    - Reject **absolute path prefixes** – a leading `/`, `\`, or a Windows
///      drive letter `C:` — because joining an absolute path onto a relative
///      base discards the base (the sandbox root) entirely.
///
/// 2. **Filesystem resolution** (controlled I/O)
///    - Join the (now-sanitised) relative path onto `sandbox_root`.
///    - Call `std::fs::canonicalize` on the result.  This resolves all
///      symlinks, `.`, `..`, and junction points to their real locations on
///      disk.  If a malicious actor placed a symlink *inside* the sandbox
///      that points outside, this step exposes the true path.
///    - If the target doesn't exist yet (e.g. an upload destination that
///      hasn't been created), `canonicalize` fails.  In that case we
///      canonicalize the **parent directory** instead and re-append the
///      original filename, then still verify the prefix.
///
/// 3. **Prefix verification**
///    - Canonicalize `sandbox_root` itself.
///    - Check that the resolved target path **starts with** the canonical
///      root using `Path::starts_with`, which compares component-by-component
///      (not as raw strings).  This prevents false positives: a string
///      `starts_with("C:\\LocalCloudPortal")` would also match
///      `"C:\\LocalCloudPortalEvil"`, but `Path::starts_with` correctly
///      rejects it.
///
/// # Arguments
///
/// * `sandbox_root` – The single allowed directory.  Must be a real directory
///   on disk (it will be canonicalized).
/// * `requested_path` – A relative path received from the client.  It is
///   interpreted as relative to `sandbox_root`.
///
/// # Returns
///
/// A canonical, absolute [`PathBuf`] that is guaranteed to reside under
/// `sandbox_root`.  The caller can safely use this path for I/O.
///
/// # Errors
///
/// Returns [`SandboxError::TraversalAttempt`] if the path tries to escape,
/// [`SandboxError::InvalidPath`] if the path is syntactically malformed, or
/// [`SandboxError::IoError`] if the filesystem can't be read.
/// Validate `requested_path` using only lexical (no-I/O) checks and return
/// the joined [`PathBuf`] relative to `sandbox_root`.
///
/// This is safe to call before the parent directory exists on disk — the
/// checks only look at the string itself.  Useful when a handler needs to
/// create intermediate directories before running the full canonicalization
/// in [`verify_sandboxed_path`].
///
/// # Errors
///
/// Returns [`SandboxError::InvalidPath`] for empty/malformed paths and
/// [`SandboxError::TraversalAttempt`] for paths containing `..`.
pub fn validate_sandboxed_path(
    sandbox_root: &Path,
    requested_path: &str,
) -> Result<PathBuf, SandboxError> {
    // Empty paths are never valid
    if requested_path.is_empty() {
        return Err(SandboxError::InvalidPath);
    }

    // Null bytes: C runtime functions treat '\0' as string terminator
    if requested_path.contains('\0') {
        return Err(SandboxError::InvalidPath);
    }

    // Check for ".." using semantic component matching, not string search
    if Path::new(requested_path)
        .components()
        .any(|c| c == Component::ParentDir)
    {
        return Err(SandboxError::TraversalAttempt);
    }

    // Reject absolute path prefixes
    if requested_path.starts_with('/') || requested_path.starts_with('\\') {
        return Err(SandboxError::InvalidPath);
    }

    #[cfg(windows)]
    {
        let bytes = requested_path.as_bytes();
        if bytes.len() >= 2
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
        {
            return Err(SandboxError::InvalidPath);
        }
    }

    Ok(sandbox_root.join(requested_path))
}

pub fn verify_sandboxed_path(
    sandbox_root: &Path,
    requested_path: &str,
) -> Result<PathBuf, SandboxError> {
    // ---- Layer 1: lexical pre-checks (no I/O) ---------------------------
    let joined = validate_sandboxed_path(sandbox_root, requested_path)?;

    // ---- Layer 2: filesystem resolution --------------------------------

    // Canonicalize the sandbox root first so we have a trusted, absolute
    // base to compare against.
    let canonical_root =
        fs::canonicalize(sandbox_root).map_err(|e| SandboxError::IoError(e.to_string()))?;

    // Try to canonicalize the full joined path.
    let canonical_path = match fs::canonicalize(&joined) {
        Ok(p) => p,
        // The target doesn't exist yet (e.g. an upload or new-directory
        // operation).  Canonicalize the parent directory instead, then
        // re-attach the filename, and we'll still verify the prefix.
        Err(_) => {
            let parent = joined.parent().ok_or(SandboxError::InvalidPath)?;
            let file_name = joined.file_name().ok_or(SandboxError::InvalidPath)?;
            let canonical_parent = fs::canonicalize(parent)
                .map_err(|e| SandboxError::IoError(e.to_string()))?;
            canonical_parent.join(file_name)
        }
    };

    // ---- Layer 3: prefix verification ----------------------------------

    // `Path::starts_with` compares component-by-component, so this check is
    // immune to the "shared prefix string" attack
    // (e.g. "/safe/rootEvil" would NOT match "/safe/root").
    if !canonical_path.starts_with(&canonical_root) {
        return Err(SandboxError::TraversalAttempt);
    }

    Ok(canonical_path)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::path::PathBuf;

    /// Create a temporary sandbox root directory that is automatically cleaned
    /// up when the returned `PathBuf` wrapper is dropped.
    struct TempSandbox {
        path: PathBuf,
    }

    impl TempSandbox {
        fn new() -> Self {
            // Use a counter + thread ID so parallel test runs don't collide.
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = std::sync::atomic::AtomicU32::fetch_add(&COUNTER, 1, std::sync::atomic::Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!("lanclave_test_{}_{}", std::process::id(), n));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("create temp sandbox");
            // Also create a nested subdirectory
            fs::create_dir_all(path.join("subdir")).expect("create subdir");
            // Write a dummy file
            File::create(path.join("subdir").join("file.txt"))
                .expect("create test file");
            Self { path }
        }

        fn root(&self) -> PathBuf {
            // Return canonicalized form so tests compare against what
            // verify_sandboxed_path actually sees.
            fs::canonicalize(&self.path).unwrap()
        }
    }

    impl Drop for TempSandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    // -----------------------------------------------------------------------
    // Happy path
    // -----------------------------------------------------------------------

    #[test]
    fn valid_nested_file() {
        let sb = TempSandbox::new();
        let result = verify_sandboxed_path(&sb.root(), "subdir/file.txt");
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("subdir/file.txt"));
        assert!(path.starts_with(&sb.root()));
    }

    #[test]
    fn valid_top_level_file() {
        let sb = TempSandbox::new();
        // Create a temp file in the root
        File::create(sb.root().join("readme.md")).unwrap();
        let result = verify_sandboxed_path(&sb.root(), "readme.md");
        assert!(result.is_ok());
    }

    #[test]
    fn valid_subdirectory_path() {
        let sb = TempSandbox::new();
        let result = verify_sandboxed_path(&sb.root(), "subdir");
        assert!(result.is_ok());
        assert!(result.unwrap().ends_with("subdir"));
    }

    // -----------------------------------------------------------------------
    // Traversal attempts (lexical)
    // -----------------------------------------------------------------------

    #[test]
    fn traversal_dotdot_prefix() {
        let sb = TempSandbox::new();
        let result = verify_sandboxed_path(&sb.root(), "../../etc/passwd");
        assert_eq!(result, Err(SandboxError::TraversalAttempt));
    }

    #[test]
    fn traversal_dotdot_midpath() {
        let sb = TempSandbox::new();
        let result =
            verify_sandboxed_path(&sb.root(), "subdir/../../../etc/passwd");
        assert_eq!(result, Err(SandboxError::TraversalAttempt));
    }

    #[test]
    fn traversal_dotdot_only() {
        let sb = TempSandbox::new();
        let result = verify_sandboxed_path(&sb.root(), "..");
        assert_eq!(result, Err(SandboxError::TraversalAttempt));
    }

    #[test]
    fn traversal_dotdot_encoded_like() {
        // A filename that literally contains ".." as a substring but is NOT
        // a path component separator — this MUST be allowed.
        let sb = TempSandbox::new();
        File::create(sb.root().join("foo..txt")).unwrap();
        let result = verify_sandboxed_path(&sb.root(), "foo..txt");
        assert!(result.is_ok(), "filename with embedded '..' is safe");
    }

    // -----------------------------------------------------------------------
    // Absolute path attempts
    // -----------------------------------------------------------------------

    #[test]
    fn absolute_unix_style() {
        let sb = TempSandbox::new();
        let result = verify_sandboxed_path(&sb.root(), "/etc/passwd");
        assert_eq!(result, Err(SandboxError::InvalidPath));
    }

    #[test]
    fn absolute_windows_backslash() {
        let sb = TempSandbox::new();
        let result = verify_sandboxed_path(&sb.root(), "\\Windows\\System32");
        assert_eq!(result, Err(SandboxError::InvalidPath));
    }

    #[cfg(windows)]
    #[test]
    fn absolute_windows_drive_letter() {
        let sb = TempSandbox::new();
        let result = verify_sandboxed_path(&sb.root(), "C:\\Windows");
        assert_eq!(result, Err(SandboxError::InvalidPath));
    }

    // -----------------------------------------------------------------------
    // Null byte injection
    // -----------------------------------------------------------------------

    #[test]
    fn null_byte_injection() {
        let sb = TempSandbox::new();
        let result = verify_sandboxed_path(&sb.root(), "safe.txt\0malicious.exe");
        assert_eq!(result, Err(SandboxError::InvalidPath));
    }

    // -----------------------------------------------------------------------
    // Empty path
    // -----------------------------------------------------------------------

    #[test]
    fn empty_path() {
        let sb = TempSandbox::new();
        let result = verify_sandboxed_path(&sb.root(), "");
        assert_eq!(result, Err(SandboxError::InvalidPath));
    }

    // -----------------------------------------------------------------------
    // Non-existent path (upload target)
    // -----------------------------------------------------------------------

    #[test]
    fn non_existent_file_upload_target() {
        let sb = TempSandbox::new();
        let result = verify_sandboxed_path(&sb.root(), "new_upload.zip");
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("new_upload.zip"));
        assert!(path.starts_with(&sb.root()));
    }

    #[test]
    fn non_existent_file_in_subdir() {
        let sb = TempSandbox::new();
        let result =
            verify_sandboxed_path(&sb.root(), "subdir/new_document.pdf");
        assert!(result.is_ok());
        let path = result.unwrap();
        assert!(path.ends_with("new_document.pdf"));
        assert!(path.starts_with(&sb.root()));
    }

    // -----------------------------------------------------------------------
    // Symlink escape
    // -----------------------------------------------------------------------

    #[test]
    fn symlink_escape_outside_sandbox() {
        let sb = TempSandbox::new();
        // Create a real file outside the sandbox
        let outside_dir = std::env::temp_dir().join(format!(
            "lanclave_outside_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&outside_dir);
        fs::create_dir_all(&outside_dir).expect("create outside dir");
        let outside_file = outside_dir.join("secret.txt");
        File::create(&outside_file).expect("create outside file");

        // Create a symlink inside the sandbox that points to the outside file
        let link_path = sb.root().join("evil_link");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside_file, &link_path)
                .expect("create symlink");
        }
        #[cfg(windows)]
        {
            // Windows requires either admin privileges or Developer Mode for
            // symlinks.  If this fails we skip the assertion.
            if std::os::windows::fs::symlink_file(&outside_file, &link_path)
                .is_err()
            {
                eprintln!("skipping symlink test — not enough privileges on Windows");
                let _ = fs::remove_dir_all(&outside_dir);
                return;
            }
        }

        // Now try to access the symlink
        let result = verify_sandboxed_path(&sb.root(), "evil_link");
        assert_eq!(
            result,
            Err(SandboxError::TraversalAttempt),
            "symlink pointing outside the sandbox MUST be rejected"
        );

        // Cleanup
        let _ = fs::remove_dir_all(&outside_dir);
    }

    // -----------------------------------------------------------------------
    // Symlink inside sandbox (should be allowed)
    // -----------------------------------------------------------------------

    #[test]
    fn symlink_inside_sandbox_allowed() {
        let sb = TempSandbox::new();
        let target = sb.root().join("subdir").join("file.txt");
        let link_path = sb.root().join("safe_link");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&target, &link_path)
                .expect("create symlink");
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_file(&target, &link_path).is_err()
            {
                eprintln!("skipping symlink test — not enough privileges on Windows");
                return;
            }
        }

        let result = verify_sandboxed_path(&sb.root(), "safe_link");
        assert!(result.is_ok());
        // The canonical path should resolve to the real file inside sandbox
        assert!(result.unwrap().ends_with("file.txt"));
    }
}
