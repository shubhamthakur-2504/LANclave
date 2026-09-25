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

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            display_name: "Desktop Workstation".to_string(),
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

    settings
}

pub fn save_settings(app_data_dir: &Path, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app_data_dir);
    let data = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(())
}
