//! Sessions: the lanes in order, each a song with one or more versions (bounces) and the one in
//! front, saved as a small JSON file (`.abnormal`) so an album being worked on opens in one go,
//! plus the recently used sessions, kept in `recent_sessions.json` in the app data folder.
//!
//! Each file is stored by its absolute path and by its path relative to the session file, so a
//! folder holding both the session and its audio can be moved or copied elsewhere, and with a
//! bookmark and an identity (`relink.rs`), so a file renamed or moved outside the app is found
//! again. The first format (v1, a flat list of tracks) still opens, as one version per lane.
//! A lane may also hold the song's own reference tracks (and which one is in use), and the
//! session a default reference for songs without their own, saved and found again the same way.
//! A lane can instead be compared with another lane (by its index) or with the default.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::relink::{self, Identity};

/// Extension of session files.
pub const EXTENSION: &str = "abnormal";
const FORMAT_VERSION: u32 = 2;
/// How many recent sessions are remembered.
const MAX_RECENT: usize = 10;

#[derive(Serialize, Deserialize)]
struct SessionTrack {
    path: String,
    /// From the session file's folder, when the track is under it; `/`-separated, so a session
    /// saved on one system finds its files on another.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relative: Option<String>,
    /// macOS bookmark (base64): follows the file through renames and moves on its volume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bookmark: Option<String>,
    /// To recognise the file under another name, near where it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<Identity>,
}

#[derive(Serialize, Deserialize)]
struct SessionLane {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    name: String,
    #[serde(default)]
    front: usize,
    versions: Vec<SessionTrack>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    match_loudness: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    references: Vec<SessionTrack>,
    #[serde(default, skip_serializing_if = "is_zero")]
    reference_front: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    compare_lane: Option<usize>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    compare_default: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

#[derive(Serialize, Deserialize)]
struct SessionFile {
    version: u32,
    #[serde(default)]
    lanes: Vec<SessionLane>,
    /// v1: one track per lane.
    #[serde(default, skip_serializing)]
    tracks: Vec<SessionTrack>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_reference: Option<SessionTrack>,
}

/// A lane: its versions' paths, the one in front, the name given to the song (empty: none),
/// whether its versions play loudness-matched, and the song's own references with the one in use.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    #[serde(default)]
    pub name: String,
    pub versions: Vec<String>,
    #[serde(default)]
    pub front: usize,
    /// Left out when off, so the UI's lanes compare equal to the saved ones.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub match_loudness: bool,
    /// Reference tracks of this song; left out when there are none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<String>,
    /// The reference in use; left out when it's the first.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub reference_front: usize,
    /// Compared with another lane (its index in the session) instead of its own references.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compare_lane: Option<usize>,
    /// Compared with the session's default reference even though it has its own.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub compare_default: bool,
    /// The colour picked for the song ("#rrggbb"); left out for its automatic one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// A session as opened: where it is, its name (file stem), its lanes, in order, and the files
/// found somewhere else than saved.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub path: String,
    pub name: String,
    pub lanes: Vec<Lane>,
    /// Compared with by every song without a reference of its own.
    pub default_reference: Option<String>,
    pub relinked: Vec<Relinked>,
}

/// A file not at its saved path, found at `to`.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Relinked {
    pub from: String,
    pub to: String,
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

/// Write `lanes` (in order) and the default reference as a session at `path`. Lanes without a
/// version are left out (links to lanes are renumbered; one to a lane left out is dropped).
pub fn write(path: &Path, lanes: &[Lane], default_reference: Option<&str>) -> Result<Session, String> {
    let dir = path.parent().unwrap_or(Path::new(""));
    let kept: Vec<usize> = (0..lanes.len()).filter(|&i| !lanes[i].versions.is_empty()).collect();
    let lanes: Vec<Lane> = kept
        .iter()
        .map(|&i| &lanes[i])
        .enumerate()
        .map(|(at, l)| Lane {
            front: l.front.min(l.versions.len() - 1),
            reference_front: l.reference_front.min(l.references.len().saturating_sub(1)),
            compare_lane: l.compare_lane.and_then(|c| kept.iter().position(|&k| k == c)).filter(|&c| c != at),
            ..l.clone()
        })
        .collect();
    let track = |t: &String| SessionTrack {
        path: t.clone(),
        relative: Path::new(t).strip_prefix(dir).ok().map(portable),
        bookmark: relink::bookmark(Path::new(t)),
        identity: relink::identity(Path::new(t)),
    };
    let file = SessionFile {
        version: FORMAT_VERSION,
        lanes: lanes
            .iter()
            .map(|l| SessionLane {
                name: l.name.clone(),
                front: l.front,
                versions: l.versions.iter().map(track).collect(),
                match_loudness: l.match_loudness,
                references: l.references.iter().map(track).collect(),
                reference_front: l.reference_front,
                compare_lane: l.compare_lane,
                compare_default: l.compare_default,
                color: l.color.clone(),
            })
            .collect(),
        tracks: Vec::new(),
        default_reference: default_reference.map(|p| track(&p.to_string())),
    };
    let json = serde_json::to_vec_pretty(&file).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{EXTENSION}.tmp"));
    std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| e.to_string())?;
    Ok(Session {
        path: path.to_string_lossy().into_owned(),
        name: name_of(path),
        lanes,
        default_reference: default_reference.map(str::to_owned),
        relinked: Vec::new(),
    })
}

/// A relative path with `/` separators (Windows accepts them too).
fn portable(relative: &Path) -> String {
    relative.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// Where a saved file is now: at its path; else relative to the session (the folder was moved);
/// else where its bookmark leads (renamed or moved on its volume); else a file with its identity
/// in the folders around where it was (its old folder, the session's, the one above its old
/// folder). Found nowhere, its saved path is kept, so the lane says what's missing.
fn locate(t: SessionTrack, dir: &Path) -> (String, bool) {
    let saved = Path::new(&t.path);
    if saved.exists() {
        return (t.path, false);
    }
    let found = t
        .relative
        .as_ref()
        .map(|r| dir.join(r))
        .filter(|moved| moved.exists())
        .or_else(|| t.bookmark.as_deref().and_then(relink::resolve))
        .or_else(|| {
            let id = t.identity.as_ref()?;
            let old = saved.parent();
            let near: Vec<PathBuf> = [old, Some(dir), old.and_then(Path::parent)].into_iter().flatten().filter(|d| d.is_dir()).map(Path::to_owned).collect();
            relink::search(id, &near)
        });
    match found {
        Some(p) => (p.to_string_lossy().into_owned(), true),
        None => (t.path, false),
    }
}

/// Read the session at `path`, finding files that moved (`locate`); those are listed in
/// `relinked`.
pub fn read(path: &Path) -> Result<Session, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Can't open the session: {e}"))?;
    let file: SessionFile = serde_json::from_slice(&bytes).map_err(|e| format!("Not a session file: {e}"))?;
    let dir = path.parent().unwrap_or(Path::new(""));
    let mut relinked = Vec::new();
    let mut find = |t: SessionTrack| {
        let from = t.path.clone();
        let (to, moved) = locate(t, dir);
        if moved {
            relinked.push(Relinked { from, to: to.clone() });
        }
        to
    };
    let lanes = if file.lanes.is_empty() {
        file.tracks.into_iter().map(|t| Lane { versions: vec![find(t)], ..Lane::default() }).collect()
    } else {
        file.lanes
            .into_iter()
            .filter(|l| !l.versions.is_empty())
            .map(|l| {
                let front = l.front.min(l.versions.len() - 1);
                let reference_front = l.reference_front.min(l.references.len().saturating_sub(1));
                Lane {
                    name: l.name,
                    versions: l.versions.into_iter().map(&mut find).collect(),
                    front,
                    match_loudness: l.match_loudness,
                    references: l.references.into_iter().map(&mut find).collect(),
                    reference_front,
                    compare_lane: l.compare_lane,
                    compare_default: l.compare_default,
                    color: l.color,
                }
            })
            .collect()
    };
    let default_reference = file.default_reference.map(&mut find);
    Ok(Session { path: path.to_string_lossy().into_owned(), name: name_of(path), lanes, default_reference, relinked })
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
