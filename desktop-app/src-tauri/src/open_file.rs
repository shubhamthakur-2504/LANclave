//! Opening sandbox files with the default app (docs/open-files-plan O1).
//!
//! The files come from other devices, so two guards:
//! - **Risky types** (programs, scripts, shortcuts) are never opened on a
//!   double-click. The page is told first, with who sent the file, and must
//!   come back with the user's confirmation.
//! - **Mark of the Web.** Files received from a peer get the same
//!   `Zone.Identifier` stream browsers give downloads, so Windows itself
//!   applies SmartScreen to programs and Protected View to Office files --
//!   however they are opened later, including from Explorer.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::commands::CliState;

/// Extensions that run code, or point at something that does, when opened.
const RISKY: &[&str] = &[
    // Windows programs, installers, scripts and shortcuts
    "exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "bat", "cmd", "com", "scr", "pif",
    "cpl", "msc", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "lnk",
    "url", "scf", "reg", "inf", "application", "gadget", "jar", "dll", "sys",
    // other platforms' equivalents, harmless to warn about here too
    "sh", "command", "app", "pkg", "dmg", "apk",
];

pub fn is_risky(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| RISKY.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Mark a file as having come from another machine (Windows only; a no-op
/// elsewhere). Best effort: a filesystem without alternate streams (FAT,
/// some network drives) simply keeps no mark.
pub fn mark_from_peer(path: &Path) {
    #[cfg(windows)]
    {
        let stream = format!("{}:Zone.Identifier", path.display());
        // ZoneId 3 is "Internet": the zone browsers use for downloads.
        let _ = std::fs::write(stream, b"[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    #[cfg(not(windows))]
    let _ = path;
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpenResult {
    Opened,
    /// A risky type: ask the user, then call again with `confirmed`.
    Confirm { sender: Option<String> },
}

/// Who sent `name`, from the history log, if it arrived from a peer.
fn sender_of(state: &CliState, name: &str) -> Option<String> {
    state
        .history
        .list()
        .into_iter()
        .find(|e| {
            e.direction == crate::history::Direction::Received
                && e.dest_name.as_deref().unwrap_or(&e.file_name) == name
        })
        .and_then(|e| e.peer_name)
}

fn sandbox_file(state: &CliState, name: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(&state.settings.read().map_err(|e| e.to_string())?.sandbox_path);
    let path = crate::sandbox::verify_sandboxed_path(&root, name).map_err(|_| "This file is gone.".to_string())?;
    if !path.is_file() {
        return Err("This file is gone.".into());
    }
    Ok(path)
}

/// Open a sandbox file with the default app. Paths outside the sandbox are
/// refused; risky types need `confirmed`.
#[tauri::command]
pub fn open_sandbox_file(
    app: tauri::AppHandle,
    state: State<'_, CliState>,
    name: String,
    confirmed: bool,
) -> Result<OpenResult, String> {
    let path = sandbox_file(&state, &name)?;
    if is_risky(&name) && !confirmed {
        return Ok(OpenResult::Confirm { sender: sender_of(&state, &name) });
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Could not open {name}: {e}"))?;
    Ok(OpenResult::Opened)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn programs_and_scripts_are_risky_documents_are_not() {
        for name in ["setup.exe", "RUN.BAT", "x.ps1", "a.lnk", "tool.jar", "app.apk", "page.hta"] {
            assert!(is_risky(name), "{name}");
        }
        for name in ["photo.jpg", "report.pdf", "notes.txt", "movie.mp4", "archive.zip", "noext"] {
            assert!(!is_risky(name), "{name}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn received_files_carry_the_mark_of_the_web() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("got.exe");
        std::fs::write(&path, b"MZ").unwrap();
        mark_from_peer(&path);
        let mark = std::fs::read_to_string(format!("{}:Zone.Identifier", path.display())).unwrap();
        assert!(mark.contains("ZoneId=3"), "{mark}");
        assert_eq!(std::fs::read(&path).unwrap(), b"MZ", "the file itself is untouched");
    }
}
