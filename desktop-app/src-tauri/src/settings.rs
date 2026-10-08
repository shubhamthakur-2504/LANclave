use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppSettings {
    pub display_name: String,
    pub sandbox_path: String,
    /// Downloads that run at once; the rest wait their turn. Two fill a
    /// Wi-Fi link without spreading it thin.
    #[serde(default = "default_max_downloads")]
    pub max_downloads: usize,
}

fn default_max_downloads() -> usize {
    2
}

/// What every desktop was called before names defaulted to the computer's.
/// Nobody chose it, so it is replaced like an empty name.
const LEGACY_DEFAULT_NAME: &str = "Desktop Workstation";

/// The name this device goes by until the user picks one: the computer's
/// own name, which is what its owner already knows it as.
pub fn default_display_name() -> String {
    ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|var| std::env::var(var).ok())
        .map(|name| name.trim().to_string())
        .find(|name| !name.is_empty())
        .unwrap_or_else(|| "Desktop".to_string())
}

/// Whether `name` was chosen by the user, as opposed to never set.
fn is_chosen_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty() && name != LEGACY_DEFAULT_NAME
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            display_name: default_display_name(),
            // The default path will be populated dynamically if loaded empty
            sandbox_path: "".to_string(),
            max_downloads: default_max_downloads(),
        }
    }
}

pub fn settings_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("settings.json")
}

pub fn load_settings(app_data_dir: &Path, default_sandbox_path: &Path) -> AppSettings {
    let path = settings_path(app_data_dir);
    let mut settings = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|data| serde_json::from_str::<AppSettings>(&data).ok())
            .unwrap_or_default()
    } else {
        AppSettings::default()
    };

    if settings.sandbox_path.is_empty() {
        settings.sandbox_path = default_sandbox_path.to_string_lossy().to_string();
    }
    if !is_chosen_name(&settings.display_name) {
        settings.display_name = default_display_name();
    }

    settings
}

pub fn save_settings(app_data_dir: &Path, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app_data_dir);
    let data = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lanclave-settings-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn saved(dir: &Path, name: &str) {
        let settings = AppSettings { display_name: name.into(), sandbox_path: "x".into(), max_downloads: 2 };
        save_settings(dir, &settings).unwrap();
    }

    #[test]
    fn a_fresh_install_is_named_after_the_computer() {
        let dir = dir("fresh");
        let settings = load_settings(&dir, &dir.join("Sandbox"));
        assert_eq!(settings.display_name, default_display_name());
        assert!(!settings.display_name.is_empty());
        assert_ne!(settings.display_name, LEGACY_DEFAULT_NAME);
    }

    #[test]
    fn a_name_the_user_chose_is_kept() {
        let dir = dir("chosen");
        saved(&dir, "Shubham's laptop");
        assert_eq!(load_settings(&dir, &dir).display_name, "Shubham's laptop");
    }

    #[test]
    fn the_old_default_and_a_blank_name_are_replaced() {
        for (tag, name) in [("legacy", LEGACY_DEFAULT_NAME), ("blank", "   ")] {
            let dir = dir(tag);
            saved(&dir, name);
            assert_eq!(load_settings(&dir, &dir).display_name, default_display_name());
        }
    }
}
