//! Sessions: the lanes in order, each a song with one or more versions (bounces) and the one in
//! front, saved as a small JSON file (`.abnormal`) so an album being worked on opens in one go,
//! plus the recently used sessions, kept in `recent_sessions.json` in the app data folder.
//!
//! Each file is stored by its absolute path and by its path relative to the session file, so a
//! folder holding both the session and its audio can be moved or copied elsewhere. The first
//! format (v1, a flat list of tracks) still opens, as one version per lane.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Extension of session files.
pub const EXTENSION: &str = "abnormal";
const FORMAT_VERSION: u32 = 2;
/// How many recent sessions are remembered.
const MAX_RECENT: usize = 10;

#[derive(Serialize, Deserialize)]
struct SessionTrack {
    path: String,
    /// From the session file's folder, when the track is under it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relative: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct SessionLane {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    name: String,
    #[serde(default)]
    front: usize,
    versions: Vec<SessionTrack>,
}

#[derive(Serialize, Deserialize)]
struct SessionFile {
    version: u32,
    #[serde(default)]
    lanes: Vec<SessionLane>,
    /// v1: one track per lane.
    #[serde(default, skip_serializing)]
    tracks: Vec<SessionTrack>,
}

/// A lane: its versions' paths, the one in front, and the name given to the song (empty: none).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    #[serde(default)]
    pub name: String,
    pub versions: Vec<String>,
    #[serde(default)]
    pub front: usize,
}

/// A session as opened: where it is, its name (file stem) and its lanes, in order.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub path: String,
    pub name: String,
    pub lanes: Vec<Lane>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentSession {
    pub path: String,
    pub name: String,
    /// Number of lanes when last saved or opened.
    pub tracks: usize,
    /// Unix seconds.
    pub used: u64,
}

fn name_of(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Write `lanes` (in order) as a session at `path`. Lanes without a version are left out.
pub fn write(path: &Path, lanes: &[Lane]) -> Result<Session, String> {
    let dir = path.parent().unwrap_or(Path::new(""));
    let lanes: Vec<Lane> = lanes
        .iter()
        .filter(|l| !l.versions.is_empty())
        .map(|l| Lane { front: l.front.min(l.versions.len() - 1), ..l.clone() })
        .collect();
    let track = |t: &String| SessionTrack {
        path: t.clone(),
        relative: Path::new(t).strip_prefix(dir).ok().map(|r| r.to_string_lossy().into_owned()),
    };
    let file = SessionFile {
        version: FORMAT_VERSION,
        lanes: lanes
            .iter()
            .map(|l| SessionLane { name: l.name.clone(), front: l.front, versions: l.versions.iter().map(track).collect() })
            .collect(),
        tracks: Vec::new(),
    };
    let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{EXTENSION}.tmp"));
    std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| e.to_string())?;
    Ok(Session { path: path.to_string_lossy().into_owned(), name: name_of(path), lanes })
}

/// Read the session at `path`. A file missing from its absolute path is looked for relative to
/// the session (the folder was moved); if it's in neither place its absolute path is kept, so the
/// lane says what's missing.
pub fn read(path: &Path) -> Result<Session, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Can't open the session: {e}"))?;
    let file: SessionFile = serde_json::from_slice(&bytes).map_err(|e| format!("Not a session file: {e}"))?;
    let dir = path.parent().unwrap_or(Path::new(""));
    let locate = |t: SessionTrack| {
        if Path::new(&t.path).exists() {
            return t.path;
        }
        match t.relative.map(|r| dir.join(r)) {
            Some(moved) if moved.exists() => moved.to_string_lossy().into_owned(),
            _ => t.path,
        }
    };
    let lanes = if file.lanes.is_empty() {
        file.tracks.into_iter().map(|t| Lane { name: String::new(), versions: vec![locate(t)], front: 0 }).collect()
    } else {
        file.lanes
            .into_iter()
            .filter(|l| !l.versions.is_empty())
            .map(|l| {
                let front = l.front.min(l.versions.len() - 1);
                Lane { name: l.name, versions: l.versions.into_iter().map(locate).collect(), front }
            })
            .collect()
    };
    Ok(Session { path: path.to_string_lossy().into_owned(), name: name_of(path), lanes })
}

pub struct Recents {
    path: PathBuf,
    list: Mutex<Option<Vec<RecentSession>>>,
}

impl Recents {
    pub fn new(path: PathBuf) -> Self {
        Self { path, list: Mutex::new(None) }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Vec<RecentSession>) -> T) -> T {
        let mut list = self.list.lock().unwrap();
        let list = list.get_or_insert_with(|| {
            std::fs::read(&self.path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
        });
        f(list)
    }

    /// Recent sessions, most recent first, leaving out the ones whose file is gone.
    pub fn list(&self) -> Vec<RecentSession> {
        self.with(|list| list.iter().filter(|r| Path::new(&r.path).exists()).cloned().collect())
    }

    /// Put `session` at the top of the list.
    pub fn touch(&self, session: &Session) {
        self.with(|list| {
            list.retain(|r| r.path != session.path);
            list.insert(0, RecentSession { path: session.path.clone(), name: session.name.clone(), tracks: session.lanes.len(), used: now() });
            list.truncate(MAX_RECENT);
        });
        let _ = self.save();
    }

    pub fn clear(&self) {
        self.with(|list| list.clear());
        let _ = self.save();
    }

    fn save(&self) -> Result<(), String> {
        let json = self.with(|list| serde_json::to_vec_pretty(list)).map_err(|e| e.to_string())?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &self.path)).map_err(|e| e.to_string())
    }
}
