//! Music library index: every audio file under a root folder is analysed once and its sonic
//! fingerprint kept in a JSON database, so loaded tracks can be matched against the library.
//!
//! Indexing runs in the background at startup and only analyses files that are new or changed
//! since the last run (by size and modification time); entries for deleted files are dropped.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::decode;
use crate::similarity::{self, Features, Spread};

/// Bump when `Features` or the analysis behind them change, to re-analyse the whole library.
const DB_VERSION: u32 = 1;
const EXTENSIONS: [&str; 3] = ["mp3", "flac", "wav"];
/// Decoded tracks are held in memory while analysed (~100 MB for 5 min of 44.1 kHz stereo), so
/// the number of parallel workers is capped.
const MAX_WORKERS: usize = 4;
/// Save progress at least this often, so quitting mid-index loses little work.
const SAVE_EVERY_SECONDS: u64 = 20;

/// A few headline numbers per track, shown next to matches.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub integrated: Option<f64>,
    pub dr: Option<f64>,
    pub tilt: Option<f64>,
    pub correlation: Option<f64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Entry {
    size: u64,
    modified: u64,
    duration: f64,
    features: Option<Features>,
    summary: Option<Summary>,
    /// Why the file couldn't be analysed; kept so it isn't retried until it changes.
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Db {
    version: u32,
    tracks: HashMap<String, Entry>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub root: String,
    /// Tracks in the database with a fingerprint.
    pub indexed: usize,
    /// Files that could not be analysed.
    pub failed: usize,
    pub scanning: bool,
    /// Files to analyse in the current run, and how many are done.
    pub queued: usize,
    pub done: usize,
    pub error: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTrack {
    pub path: String,
    /// Path relative to the library root.
    pub rel_path: String,
    pub duration: f64,
    pub summary: Option<Summary>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    #[serde(flatten)]
    pub track: LibraryTrack,
    /// Similarity 0–100: overall, then tonal, dynamics, stereo.
    pub score: f64,
    pub tonal: Option<f64>,
    pub dynamics: Option<f64>,
    pub stereo: Option<f64>,
}

/// Called with the new status whenever indexing progresses.
pub type Notify<'a> = &'a (dyn Fn(&Status) + Sync);

pub struct Library {
    root: PathBuf,
    db_path: PathBuf,
    db: Mutex<Db>,
    status: Mutex<Status>,
}

impl Library {
    pub fn new(root: PathBuf, db_path: PathBuf) -> Self {
        let db = std::fs::read(&db_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Db>(&bytes).ok())
            .filter(|db| db.version == DB_VERSION)
            .unwrap_or(Db { version: DB_VERSION, tracks: HashMap::new() });
        let status = Status { root: root.to_string_lossy().into_owned(), ..Default::default() };
        let lib = Library { root, db_path, db: Mutex::new(db), status: Mutex::new(status) };
        lib.refresh_counts();
        lib
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    #[cfg(test)]
    pub fn paths(&self) -> Vec<String> {
        self.db.lock().unwrap().tracks.keys().cloned().collect()
    }

    fn refresh_counts(&self) {
        let db = self.db.lock().unwrap();
        let mut status = self.status.lock().unwrap();
        status.indexed = db.tracks.values().filter(|e| e.features.is_some()).count();
        status.failed = db.tracks.values().filter(|e| e.error.is_some()).count();
    }

    fn update(&self, notify: Notify, f: impl FnOnce(&mut Status)) {
        let status = {
            let mut s = self.status.lock().unwrap();
            f(&mut s);
            s.clone()
        };
        notify(&status);
    }

    /// Scan the root folder and analyse new or changed files, calling `notify` as progress is
    /// made. Returns at once if a scan is already running.
    pub fn index(&self, notify: Notify) {
        {
            let mut s = self.status.lock().unwrap();
            if s.scanning {
                return;
            }
            *s = Status { root: s.root.clone(), scanning: true, ..Default::default() };
        }
        let result = self.run_index(notify);
        self.refresh_counts();
        self.update(notify, |s| {
            s.scanning = false;
            s.error = result.err();
        });
    }

    fn run_index(&self, notify: Notify) -> Result<(), String> {
        if !self.root.is_dir() {
            return Err(format!("{} not found", self.root.display()));
        }
        let mut files = Vec::new();
        collect_audio_files(&self.root, &mut files);

        let todo: Vec<(PathBuf, u64, u64)> = {
            // Drop entries for files that are gone or changed; whatever is missing then gets analysed.
            let current: HashMap<String, (u64, u64)> = files.iter().map(|(p, size, modified)| (key(p), (*size, *modified))).collect();
            let mut db = self.db.lock().unwrap();
            db.tracks.retain(|path, e| current.get(path) == Some(&(e.size, e.modified)));
            files.into_iter().filter(|(p, ..)| !db.tracks.contains_key(&key(p))).collect()
        };
        self.refresh_counts();
        self.update(notify, |s| s.queued = todo.len());
        if todo.is_empty() {
            return self.save();
        }

        let next = AtomicUsize::new(0);
        let last_save = Mutex::new(Instant::now());
        let workers = std::thread::available_parallelism().map_or(1, |n| (n.get() / 2).clamp(1, MAX_WORKERS));
        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| {
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some((path, size, modified)) = todo.get(i) else { break };
                        let entry = analyze_file(path, *size, *modified);
                        let ok = entry.features.is_some();
                        self.db.lock().unwrap().tracks.insert(key(path), entry);
                        self.update(notify, |s| {
                            s.done += 1;
                            if ok { s.indexed += 1 } else { s.failed += 1 }
                        });
                        let mut last = last_save.lock().unwrap();
                        if last.elapsed().as_secs() >= SAVE_EVERY_SECONDS {
                            if let Err(e) = self.save() {
                                eprintln!("library: {e}");
                            }
                            *last = Instant::now();
                        }
                    }
                });
            }
        });
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        let json = serde_json::to_vec(&*self.db.lock().unwrap()).map_err(|e| e.to_string())?;
        if let Some(dir) = self.db_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
        // Write then rename, so a crash mid-write never leaves a truncated database.
        let tmp = self.db_path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &self.db_path).map_err(|e| format!("cannot save library: {e}"))
    }

    /// Library tracks closest to `features`, best first. `weights` balance tonal, dynamics and
    /// stereo distances.
    pub fn similar(&self, features: &Features, exclude: &[String], weights: [f64; 3], limit: usize) -> Vec<Match> {
        let db = self.db.lock().unwrap();
        let spread = Spread::of(db.tracks.values().filter_map(|e| e.features.as_ref()));
        let mut matches: Vec<Match> = db
            .tracks
            .iter()
            .filter(|(path, _)| !exclude.contains(path))
            .filter_map(|(path, e)| {
                let d = similarity::distances(features, e.features.as_ref()?, &spread);
                let total = similarity::combine(&d, &weights)?;
                let [tonal, dynamics, stereo] = d.map(|d| d.map(similarity::score));
                Some(Match { track: self.track(path, e), score: similarity::score(total), tonal, dynamics, stereo })
            })
            .collect();
        matches.sort_by(|a, b| b.score.total_cmp(&a.score));
        matches.truncate(limit);
        matches
    }

    /// Analysed tracks whose path below the root contains every word of `query` (any case),
    /// sorted by path.
    pub fn search(&self, query: &str, limit: usize) -> Vec<LibraryTrack> {
        let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        let db = self.db.lock().unwrap();
        let mut found: Vec<LibraryTrack> = db
            .tracks
            .iter()
            .filter(|(_, e)| e.features.is_some())
            .map(|(path, e)| self.track(path, e))
            .filter(|t| {
                let rel = t.rel_path.to_lowercase();
                words.iter().all(|w| rel.contains(w.as_str()))
            })
            .collect();
        found.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        found.truncate(limit);
        found
    }

    fn track(&self, path: &str, e: &Entry) -> LibraryTrack {
        LibraryTrack {
            rel_path: Path::new(path)
                .strip_prefix(&self.root)
                .map_or_else(|_| path.to_owned(), |p| p.to_string_lossy().into_owned()),
            path: path.to_owned(),
            duration: e.duration,
            summary: e.summary.clone(),
        }
    }
}

fn key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Audio files under `dir`, recursively, with size and modification time. Hidden files (incl.
/// macOS `._` resource forks) are skipped; symlinks are not followed.
fn collect_audio_files(dir: &Path, out: &mut Vec<(PathBuf, u64, u64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            collect_audio_files(&path, out);
        } else if kind.is_file() && is_audio(&path) {
            let Ok(meta) = entry.metadata() else { continue };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            out.push((path, meta.len(), modified));
        }
    }
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

fn analyze_file(path: &Path, size: u64, modified: u64) -> Entry {
    let failed = |error: String| Entry { size, modified, duration: 0.0, features: None, summary: None, error: Some(error) };
    let audio = match decode::decode_file(path) {
        Ok(a) => a,
        Err(e) => return failed(format!("{e:#}")),
    };
    match crate::analyze_range(&audio, 0, audio.frames(), false) {
        Ok(r) => Entry {
            size,
            modified,
            duration: audio.duration(),
            summary: Some(Summary {
                integrated: r.loudness.stats.integrated,
                dr: r.dynamics.stats.dr,
                tilt: r.spectrum.tilt,
                correlation: r.stereo.stats.correlation,
            }),
            features: Some(r.features),
            error: None,
        },
        Err(e) => failed(e),
    }
}
