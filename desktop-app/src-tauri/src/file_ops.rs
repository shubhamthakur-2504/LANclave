use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
pub struct FileItem {
    pub name: String,
    pub size: u64,
    pub is_directory: bool,
}

#[tauri::command]
pub fn list_sandbox_files() -> Result<Vec<FileItem>, String> {
    let sandbox_path_raw = "D:\\shubham\\code\\assignment";
    let sandbox_path = fs::canonicalize(Path::new(sandbox_path_raw))
        .map_err(|e| format!("Failed to resolve sandbox path: {}", e))?;
    let mut file_list = Vec::new();

    match fs::read_dir(&sandbox_path) {
        Ok(entries) => {
            for entry in entries {
                if let Ok(entry) = entry {
                    let metadata = entry.metadata().map_err(|_| "Failed to read metadata".to_string())?;
                    let path = entry.path();

                    if let Ok(canonical_item_path) = fs::canonicalize(&path) {
                        if !canonical_item_path.starts_with(&sandbox_path) {
                            continue;
                        }

                        file_list.push(FileItem {
                            name: entry.file_name().into_string().unwrap_or_default(),
                            size: metadata.len(),
                            is_directory: metadata.is_dir(),
                        });
                    }
                }
            }
            Ok(file_list)
        }
        Err(e) => Err(format!("Failed to read sandbox vault: {}", e)),
    }
}
