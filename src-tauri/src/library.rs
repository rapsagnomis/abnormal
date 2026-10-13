//! Music library index: every audio file under a root folder is analysed once and its sonic
//! fingerprint kept in a JSON database, so loaded tracks can be matched against the library.
//!
//! Indexing runs in the background at startup and only analyses files that are new or changed
//! since the last run (by size and modification time); entries for deleted files are dropped.

use std::collections::{HashMap, HashSet};
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
/// Album art is kept as thumbnails this big (px, longest side), shown at ~30 px.
const COVER_SIZE: u32 = 128;
/// Image files next to the audio used as album art when the file has none embedded.
const FOLDER_COVERS: [&str; 6] = ["cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.png", "front.jpg"];

/// A few headline numbers per track, shown next to matches.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub integrated: Option<f64>,
    pub dr: Option<f64>,
    pub tilt: Option<f64>,
    pub correlation: Option<f64>,
}

/// What the UI shows for a track. Read once per file; all `None` when the file has no tags.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
struct Meta {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    /// File name of the album art thumbnail in the covers folder.
    cover: Option<String>,
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
    /// Tags, read separately from the analysis (so adding them didn't need a re-analysis);
    /// `None` until read.
    #[serde(default)]
    meta: Option<Meta>,
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
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Absolute path of the album art thumbnail.
    pub cover: Option<String>,
    /// Other files with the same audio (the same song kept in several folders); only this one
    /// is listed.
    pub copies: Vec<String>,
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
    /// Album art thumbnails, named by a hash of the original image so an album's share one.
    covers_dir: PathBuf,
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
        let covers_dir = db_path.with_file_name("covers");
        let lib = Library { root, db_path, covers_dir, db: Mutex::new(db), status: Mutex::new(status) };
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

        let last_save = Mutex::new(Instant::now());
        for_each_parallel(&todo, |(path, size, modified)| {
            let mut entry = analyze_file(path, *size, *modified);
            let ok = entry.features.is_some();
            if ok {
                entry.meta = Some(self.read_meta(path));
            }
            self.db.lock().unwrap().tracks.insert(key(path), entry);
            self.update(notify, |s| {
                s.done += 1;
                if ok { s.indexed += 1 } else { s.failed += 1 }
            });
            self.save_every(&last_save);
        });
        self.read_missing_tags(&last_save);
        self.save()
    }

    /// Tags for analysed tracks indexed before tags were read. Only the tags are read (no
    /// decoding), so this is quick even for the whole library.
    fn read_missing_tags(&self, last_save: &Mutex<Instant>) {
        let missing: Vec<String> = {
            let db = self.db.lock().unwrap();
            db.tracks.iter().filter(|(_, e)| e.features.is_some() && e.meta.is_none()).map(|(p, _)| p.clone()).collect()
        };
        for_each_parallel(&missing, |path| {
            let meta = self.read_meta(Path::new(path));
            if let Some(e) = self.db.lock().unwrap().tracks.get_mut(path) {
                e.meta = Some(meta);
            }
            self.save_every(last_save);
        });
    }

    fn read_meta(&self, path: &Path) -> Meta {
        let tags = decode::read_tags(path).unwrap_or_default();
        let image = tags.cover.map(Vec::from).or_else(|| folder_cover(path));
        Meta { title: tags.title, artist: tags.artist, album: tags.album, cover: image.and_then(|bytes| self.save_cover(&bytes)) }
    }

    /// Store a thumbnail of an encoded image, returning its file name; an album's tracks carry
    /// the same image, so it is only resized once.
    fn save_cover(&self, bytes: &[u8]) -> Option<String> {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        bytes.hash(&mut h);
        let name = format!("{:016x}.jpg", h.finish());
        let path = self.covers_dir.join(&name);
        if path.exists() {
            return Some(name);
        }
        let thumb = image::load_from_memory(bytes).ok()?.thumbnail(COVER_SIZE, COVER_SIZE).to_rgb8();
        std::fs::create_dir_all(&self.covers_dir).ok()?;
        // Write then rename: two workers may be saving the same album's cover.
        let tmp = path.with_extension(format!("{:?}.tmp", std::thread::current().id()).replace(['(', ')'], ""));
        let file = std::fs::File::create(&tmp).ok()?;
        let encoded = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 85).encode_image(&thumb);
        if encoded.is_err() || std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return None;
        }
        Some(name)
    }

    fn save_every(&self, last_save: &Mutex<Instant>) {
        let mut last = last_save.lock().unwrap();
        if last.elapsed().as_secs() >= SAVE_EVERY_SECONDS {
            if let Err(e) = self.save() {
                eprintln!("library: {e}");
            }
            *last = Instant::now();
        }
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

    /// Library tracks closest to `features`, best first, one per song (copies are folded in).
    /// Copies of the `exclude`d files are left out too. `weights` balance tonal, dynamics and
    /// stereo distances.
    pub fn similar(&self, features: &Features, exclude: &[String], weights: [f64; 3], limit: usize) -> Vec<Match> {
        let db = self.db.lock().unwrap();
        let copies = copies(&db);
        let excluded: HashSet<u64> = exclude.iter().filter_map(|p| Some(db.tracks.get(p)?.features.as_ref()?.identity())).collect();
        let spread = Spread::of(db.tracks.values().filter_map(|e| e.features.as_ref()));
        let mut seen = HashSet::new();
        let mut scored: Vec<(&String, &Entry, f64, [Option<f64>; 3])> = db
            .tracks
            .iter()
            .filter_map(|(path, e)| {
                let f = e.features.as_ref()?;
                if exclude.contains(path) || excluded.contains(&f.identity()) {
                    return None;
                }
                let d = similarity::distances(features, f, &spread);
                let total = similarity::combine(&d, &weights)?;
                Some((path, e, similarity::score(total), d.map(|d| d.map(similarity::score))))
            })
            .collect();
        // Copies score the same; the path tie-break keeps the choice stable.
        scored.sort_by(|a, b| b.2.total_cmp(&a.2).then_with(|| a.0.cmp(b.0)));
        scored
            .into_iter()
            .filter(|(_, e, ..)| seen.insert(e.features.as_ref().unwrap().identity()))
            .take(limit)
            .map(|(path, e, score, [tonal, dynamics, stereo])| Match { track: self.track(path, e, &copies), score, tonal, dynamics, stereo })
            .collect()
    }

    /// Analysed tracks whose path below the root contains every word of `query` (any case),
    /// sorted by path, one per song: of several copies, the first matching one is listed.
    pub fn search(&self, query: &str, limit: usize) -> Vec<LibraryTrack> {
        let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        let db = self.db.lock().unwrap();
        let copies = copies(&db);
        let mut found: Vec<(&String, &Entry, String)> = db
            .tracks
            .iter()
            .filter(|(_, e)| e.features.is_some())
            .map(|(path, e)| (path, e, self.rel_path(path)))
            .filter(|(_, e, rel)| {
                // Match the path and the tags, so "artist title" finds files named otherwise.
                let mut text = rel.to_lowercase();
                if let Some(m) = &e.meta {
                    for v in [&m.title, &m.artist, &m.album].into_iter().flatten() {
                        text.push('\n');
                        text.push_str(&v.to_lowercase());
                    }
                }
                words.iter().all(|w| text.contains(w.as_str()))
            })
            .collect();
        found.sort_by(|a, b| a.2.cmp(&b.2));
        let mut seen = HashSet::new();
        found
            .into_iter()
            .filter(|(_, e, _)| seen.insert(e.features.as_ref().unwrap().identity()))
            .take(limit)
            .map(|(path, e, _)| self.track(path, e, &copies))
            .collect()
    }

    fn rel_path(&self, path: &str) -> String {
        Path::new(path)
            .strip_prefix(&self.root)
            .map_or_else(|_| path.to_owned(), |p| p.to_string_lossy().into_owned())
    }

    fn track(&self, path: &str, e: &Entry, copies: &HashMap<u64, Vec<&str>>) -> LibraryTrack {
        let others = e
            .features
            .as_ref()
            .and_then(|f| copies.get(&f.identity()))
            .map_or_else(Vec::new, |group| group.iter().filter(|p| **p != path).map(|p| (*p).to_owned()).collect());
        let meta = e.meta.clone().unwrap_or_default();
        LibraryTrack {
            rel_path: self.rel_path(path),
            path: path.to_owned(),
            duration: e.duration,
            summary: e.summary.clone(),
            title: meta.title,
            artist: meta.artist,
            album: meta.album,
            cover: meta.cover.map(|name| self.covers_dir.join(name).to_string_lossy().into_owned()),
            copies: others,
        }
    }
}

/// Paths of analysed files grouped by identical audio, sorted; only groups of two or more.
fn copies(db: &Db) -> HashMap<u64, Vec<&str>> {
    let mut groups: HashMap<u64, Vec<&str>> = HashMap::new();
    for (path, e) in &db.tracks {
        if let Some(f) = &e.features {
            groups.entry(f.identity()).or_default().push(path);
        }
    }
    groups.retain(|_, g| g.len() > 1);
    groups.values_mut().for_each(|g| g.sort_unstable());
    groups
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

/// Run `f` on every item using a few worker threads.
fn for_each_parallel<T: Sync>(items: &[T], f: impl Fn(&T) + Sync) {
    let next = AtomicUsize::new(0);
    let workers = std::thread::available_parallelism().map_or(1, |n| (n.get() / 2).clamp(1, MAX_WORKERS));
    std::thread::scope(|scope| {
        for _ in 0..workers.min(items.len()) {
            scope.spawn(|| {
                while let Some(item) = items.get(next.fetch_add(1, Ordering::Relaxed)) {
                    f(item);
                }
            });
        }
    });
}

/// A cover image saved next to the audio file (Deemix writes `cover.jpg` per album).
fn folder_cover(path: &Path) -> Option<Vec<u8>> {
    let dir = path.parent()?;
    FOLDER_COVERS.iter().find_map(|name| std::fs::read(dir.join(name)).ok())
}

fn analyze_file(path: &Path, size: u64, modified: u64) -> Entry {
    let failed = |error: String| Entry { size, modified, duration: 0.0, features: None, summary: None, error: Some(error), meta: None };
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
            meta: None,
        },
        Err(e) => failed(e),
    }
}
