//! App settings kept in `settings.json` in the app data folder: for now the library folder.
//!
//! Before the setting existed the library was always `~/Music/albums`; when no folder has been
//! chosen yet and that one exists, it is still used, so an existing library carries on.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The library folder used before it could be chosen, relative to the home directory.
const LEGACY_LIBRARY_DIR: &str = "Music/albums";

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    library_folder: Option<PathBuf>,
}

fn load(path: &Path) -> Settings {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// The library folder: the one chosen, else the legacy one if it exists, else none.
pub fn library_folder(path: &Path, home: Option<&Path>) -> Option<PathBuf> {
    load(path).library_folder.or_else(|| home.map(|h| h.join(LEGACY_LIBRARY_DIR)).filter(|d| d.is_dir()))
}

/// Remember `folder` as the library folder.
pub fn set_library_folder(path: &Path, folder: &Path) -> Result<(), String> {
    let mut settings = load(path);
    settings.library_folder = Some(folder.to_owned());
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| format!("cannot save the settings: {e}"))
}
