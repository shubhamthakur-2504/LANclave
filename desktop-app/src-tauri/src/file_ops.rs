use serde::Serialize;
use std::fs;

#[derive(Serialize)]
pub struct FileItem {
    pub name: String,
    pub size: u64,
    pub is_directory: bool,
    /// Last modified, Unix ms, for sorting.
    pub modified: Option<u64>,
}

#[tauri::command]
pub fn list_sandbox_files(state: tauri::State<'_, crate::commands::CliState>) -> Result<Vec<FileItem>, String> {
    let settings = state.settings.read().map_err(|e| e.to_string())?;
    let sandbox_path_raw = std::path::PathBuf::from(&settings.sandbox_path);
    let sandbox_path = fs::canonicalize(&sandbox_path_raw)
        .map_err(|e| format!("Failed to resolve sandbox path: {}", e))?;
    let mut file_list = Vec::new();

    match fs::read_dir(&sandbox_path) {
        Ok(entries) => {
            for entry in entries {
                if let Ok(entry) = entry {
                    let name = entry.file_name().into_string().unwrap_or_default();
                    
                    // Skip hidden files and internal system files
                    if name.starts_with('.') || name == "paired_devices.json" || name == "identity.json" {
                        continue;
                    }

                    let metadata = entry.metadata().map_err(|_| "Failed to read metadata".to_string())?;
                    let path = entry.path();

                    if let Ok(canonical_item_path) = fs::canonicalize(&path) {
                        if !canonical_item_path.starts_with(&sandbox_path) {
                            continue;
                        }

                        file_list.push(FileItem {
                            name,
                            size: metadata.len(),
                            is_directory: metadata.is_dir(),
                            modified: crate::fs_util::modified_ms(&metadata),
                        });
                    }
                }
            }
            Ok(file_list)
        }
        Err(e) => Err(format!("Failed to read sandbox vault: {}", e)),
    }
}
