//! Timestamped markers with notes, kept in `markers.json` in the app data folder so they come back
//! whenever a track is opened again, with no session to save.
//!
//! Markers belong to the audio, not the file: they are keyed by `decode::audio_id` (a hash of the
//! decoded samples), so moving, renaming or retagging a file keeps them, and identical copies share
//! them. Each entry also remembers the paths it was seen at. When a file's audio is new but its
//! path is known (a mix re-bounced over the same file), the notes carry over to the new audio.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Marker {
    /// Seconds from the start of the file.
    pub time: f64,
    pub note: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Entry {
    /// Where this audio has been opened from.
    paths: Vec<String>,
    markers: Vec<Marker>,
}

#[derive(Default, Serialize, Deserialize)]
struct Db {
    /// By audio id.
    tracks: HashMap<String, Entry>,
}

/// Prefix for entries migrated from the first format (keyed by path, audio unknown): they're
/// claimed by path the next time their file is opened.
const UNKNOWN_AUDIO: &str = "path:";

impl Db {
    fn load(path: &PathBuf) -> Self {
        let Ok(bytes) = std::fs::read(path) else { return Self::default() };
        if let Ok(db) = serde_json::from_slice::<Db>(&bytes) {
            return db;
        }
        // First format: { path: [markers] }.
        let old: HashMap<String, Vec<Marker>> = serde_json::from_slice(&bytes).unwrap_or_default();
        let tracks = old
            .into_iter()
            .map(|(path, markers)| (format!("{UNKNOWN_AUDIO}{path}"), Entry { paths: vec![path], markers }))
            .collect();
        Self { tracks }
    }

    /// The markers for this audio. Not known by its audio but by its path: the file there changed
    /// (or the entry predates audio ids), so its notes are carried over, moved if that path was the
    /// old audio's only one, copied if the old audio is still elsewhere. Returns whether it changed.
    fn find(&mut self, id: &str, path: &str) -> (Vec<Marker>, bool) {
        if let Some(entry) = self.tracks.get_mut(id) {
            let new_path = !entry.paths.iter().any(|p| p == path);
            if new_path {
                entry.paths.push(path.to_owned());
            }
            return (entry.markers.clone(), new_path);
        }
        let Some(old_id) = self.tracks.iter().find(|(_, e)| e.paths.iter().any(|p| p == path)).map(|(k, _)| k.clone()) else {
            return (Vec::new(), false);
        };
        let old = self.tracks.get_mut(&old_id).unwrap();
        old.paths.retain(|p| p != path);
        let markers = old.markers.clone();
        if old.paths.is_empty() {
            self.tracks.remove(&old_id);
        }
        self.tracks.insert(id.to_owned(), Entry { paths: vec![path.to_owned()], markers: markers.clone() });
        (markers, true)
    }
}

pub struct Markers {
    path: PathBuf,
    /// Loaded on first use.
    db: Mutex<Option<Db>>,
}

impl Markers {
    pub fn new(path: PathBuf) -> Self {
        Self { path, db: Mutex::new(None) }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Db) -> T) -> T {
        let mut db = self.db.lock().unwrap();
        f(db.get_or_insert_with(|| Db::load(&self.path)))
    }

    /// Markers for the audio `id` opened from `path` (see `Db::find`).
    pub fn get(&self, id: &str, path: &str) -> Vec<Marker> {
        let (markers, changed) = self.with(|db| db.find(id, path));
        if changed {
            let _ = self.save();
        }
        markers
    }

    /// Replace the markers of audio `id` (sorted by time; none removes its entry) and save.
    pub fn set(&self, id: &str, path: &str, mut markers: Vec<Marker>) -> Result<(), String> {
        markers.retain(|m| m.time.is_finite() && m.time >= 0.0);
        markers.sort_by(|a, b| a.time.total_cmp(&b.time));
        self.with(|db| {
            if markers.is_empty() {
                db.tracks.remove(id);
            } else {
                let entry = db.tracks.entry(id.to_owned()).or_default();
                if !entry.paths.iter().any(|p| p == path) {
                    entry.paths.push(path.to_owned());
                }
                entry.markers = markers;
            }
        });
        self.save()
    }

    /// Write the database atomically.
    fn save(&self) -> Result<(), String> {
        let json = self.with(|db| serde_json::to_vec_pretty(db)).map_err(|e| e.to_string())?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &self.path)).map_err(|e| e.to_string())
    }
}
