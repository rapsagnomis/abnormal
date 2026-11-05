mod accent;
mod activity;
mod bundle;
mod decode;
mod deemix;
mod dynamics;
mod eq;
mod fir;
mod library;
mod loudness;
mod peaks;
mod markers;
mod player;
mod prepared;
mod psycho;
mod relink;
mod sessions;
mod settings;
mod similarity;
mod standing;
mod spectrogram;
mod spectrum;
mod stereo;
mod stft;
mod wav;
#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, State};

use decode::AudioData;
use deemix::{Deemix, DeezerTrack, QueueItem};
use dynamics::DynamicsReport;
use loudness::LoudnessReport;
use spectrum::SpectrumReport;
use stereo::StereoReport;
use library::{Library, LibraryTrack, Match};
use similarity::Features;
use peaks::Peaks;
use player::{PlaybackBuffer, SLOTS, Shared, Transport};

/// Overview waveform resolution sent with each track. Enough for a full-width display on a
/// large screen; zoomed views request finer peaks per range via `range_peaks`.
const PEAK_BUCKETS: usize = 8192;

struct AppState {
    player: Arc<Shared>,
    audio_error: Option<String>,
    /// Original-rate decoded audio, kept for analysis.
    tracks: Arc<Mutex<[Option<Arc<AudioData>>; SLOTS]>>,
    /// Files opened via Finder or Explorer ("Open With", double-click) not yet picked up by the
    /// UI, which may not be listening yet on a cold launch.
    opened: Mutex<Vec<String>>,
    /// `settings.json` in the app data folder.
    settings_path: PathBuf,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrackInfo {
    slot: usize,
    path: String,
    name: String,
    sample_rate: u32,
    channels: usize,
    duration: f64,
    peaks: Peaks,
    /// Title, artist, album, cover from the file's tags.
    #[serde(flatten)]
    meta: library::TrackMeta,
    /// The cover's colour ("#rrggbb"), for the lane; none without a colourful cover.
    accent: Option<String>,
    /// Identity of the decoded audio (`decode::audio_id`): markers follow it across moves.
    audio_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioStatus {
    device_rate: Option<u32>,
    error: Option<String>,
}

fn check_slot(slot: usize) -> Result<(), String> {
    if slot < SLOTS { Ok(()) } else { Err(format!("invalid slot {slot}")) }
}

/// Drain the files the OS asked us to open (see `RunEvent::Opened` in `run`).
#[tauri::command]
fn take_opened_files(state: State<'_, AppState>) -> Vec<String> {
    std::mem::take(&mut *state.opened.lock().unwrap())
}

#[tauri::command]
fn audio_status(state: State<'_, AppState>) -> AudioStatus {
    let rate = state.player.device_rate.load(std::sync::atomic::Ordering::Relaxed);
    AudioStatus {
        device_rate: (rate > 0 && state.audio_error.is_none()).then_some(rate),
        error: state.audio_error.clone(),
    }
}

/// Versions prepared ahead of switching to them (see `prepared.rs`).
type Versions = prepared::Prepared<TrackInfo>;

/// Decode a file, resample it for playback (at `device_rate`; none without a device) and gather
/// what the UI shows of it. Its `slot` is set by whoever loads it.
fn decode_track(path: &str, device_rate: u32, library: &Library) -> Result<prepared::Decoded<TrackInfo>, String> {
    let path_buf = PathBuf::from(path);
    let audio = decode::decode_file(&path_buf).map_err(|e| format!("{e:#}"))?;
    // The audio's identity (~0.1 s for a song) is hashed while the playback copy is resampled.
    let (audio_id, buffer) = std::thread::scope(|scope| {
        let id = scope.spawn(|| decode::audio_id(&audio));
        let buffer = (device_rate > 0).then(|| PlaybackBuffer::new(&audio, device_rate));
        (id.join().unwrap(), buffer)
    });
    let buffer = buffer.transpose().map_err(|e| format!("{e:#}"))?.map(Arc::new);
    let meta = library.track_meta(&path_buf);
    let accent = meta.cover.as_deref().and_then(|c| accent::cover_accent(std::path::Path::new(c)));
    let info = TrackInfo {
        slot: 0,
        name: path_buf.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_owned()),
        path: path.to_owned(),
        sample_rate: audio.sample_rate,
        channels: audio.channels.len(),
        duration: audio.duration(),
        peaks: peaks::compute_peaks(&audio, PEAK_BUCKETS),
        meta,
        accent,
        audio_id,
    };
    Ok(prepared::Decoded { audio: Arc::new(audio), buffer, info })
}

/// Load a file into a slot, playing from `at` seconds (0 by default). A prepared version only
/// swaps buffers; anything else is decoded first.
#[tauri::command]
async fn load_track(
    slot: usize,
    path: String,
    at: Option<f64>,
    state: State<'_, AppState>,
    library: State<'_, Arc<Library>>,
    versions: State<'_, Arc<Versions>>,
) -> Result<TrackInfo, String> {
    check_slot(slot)?;
    let player = state.player.clone();
    let library = library.inner().clone();
    let versions = versions.inner().clone();
    let tracks = state.tracks.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let stamp = prepared::stamp_of(std::path::Path::new(&path)).ok_or_else(|| format!("Can't open {path}"))?;
        let decoded = match versions.decoded(&path) {
            Some(d) => d,
            None => {
                let device_rate = player.device_rate.load(Ordering::Relaxed);
                let d = decode_track(&path, device_rate, &library)?;
                versions.keep(&path, stamp, Some(&d), None);
                d
            }
        };
        if decoded.buffer.is_some() {
            player.set_shared_track(slot, decoded.buffer.clone(), at.unwrap_or(0.0).min(decoded.info.duration));
        }
        tracks.lock().unwrap()[slot] = Some(decoded.audio.clone());
        versions.set_slot(slot, Some((path, stamp)));
        Ok(TrackInfo { slot, ..decoded.info })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Keep these files prepared for switching to (every version of the songs with several), and
/// prepare the ones that aren't yet in the background, one at a time, sending `version-prepared`
/// (the path) as each is ready. Returns the ones already ready.
#[tauri::command]
fn prepare_versions(paths: Vec<String>, app: tauri::AppHandle, versions: State<'_, Arc<Versions>>) -> Vec<String> {
    versions.want(paths);
    if !versions.working.swap(true, Ordering::SeqCst) {
        let versions = versions.inner().clone();
        std::thread::spawn(move || prepare_worker(&versions, &app));
    }
    versions.ready()
}

/// Integrated loudness (LUFS) of prepared versions, for matching a song's versions; None where
/// it isn't measured yet (or the file is silent).
#[tauri::command]
fn version_loudness(paths: Vec<String>, versions: State<'_, Arc<Versions>>) -> Vec<Option<f64>> {
    versions.loudness(&paths)
}

fn prepare_worker(versions: &Versions, app: &tauri::AppHandle) {
    loop {
        let Some((path, stamp)) = versions.next() else {
            versions.working.store(false, Ordering::SeqCst);
            // Something wanted between the last look and the flag going down would wait forever.
            if versions.next().is_none() || versions.working.swap(true, Ordering::SeqCst) {
                return;
            }
            continue;
        };
        let device_rate = app.state::<AppState>().player.device_rate.load(Ordering::Relaxed);
        let library = app.state::<Arc<Library>>().inner().clone();
        let decoded = versions.decoded(&path).map_or_else(|| decode_track(&path, device_rate, &library), Ok);
        let report = decoded.as_ref().map_err(String::clone).and_then(|d| {
            let report = analyze_range(&d.audio, 0, d.audio.frames(), true, true)?;
            serde_json::to_string(&report).map_err(|e| e.to_string())
        });
        match (decoded, report) {
            (Ok(d), Ok(report)) => {
                versions.keep(&path, stamp, Some(&d), Some(report.into()));
                let _ = app.emit("version-prepared", &path);
            }
            _ => versions.fail(&path, stamp),
        }
    }
}

/// Run `f` on a loaded track's decoded audio off the async runtime.
async fn with_audio<T: Send + 'static>(
    state: &AppState,
    slot: usize,
    f: impl FnOnce(&AudioData) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    check_slot(slot)?;
    let audio = state.tracks.lock().unwrap()[slot]
        .clone()
        .ok_or_else(|| format!("no track loaded in slot {slot}"))?;
    tauri::async_runtime::spawn_blocking(move || f(&audio))
        .await
        .map_err(|e| e.to_string())?
}

fn to_frame_range(audio: &AudioData, range: Option<(f64, f64)>) -> (usize, usize) {
    let rate = audio.sample_rate as f64;
    match range {
        Some((s, e)) => ((s.max(0.0) * rate) as usize, (e.max(0.0) * rate).ceil() as usize),
        None => (0, audio.frames()),
    }
}

#[derive(Serialize)]
struct AnalysisReport {
    loudness: LoudnessReport,
    dynamics: DynamicsReport,
    spectrum: SpectrumReport,
    stereo: StereoReport,
    /// Fingerprint for matching against the library.
    features: Features,
    /// Sharpness and roughness (psychoacoustic models); not computed when indexing the library.
    psycho: Option<psycho::PsychoStats>,
}

/// Full analysis of frames `start..end`; shared by the `analyze` command and library indexing.
/// `psycho` adds sharpness and roughness (about a second for a song).
fn analyze_range(audio: &AudioData, start: usize, end: usize, curves: bool, psycho: bool) -> Result<AnalysisReport, String> {
    let loudness = loudness::analyze(audio, start, end, curves).map_err(|e| format!("{e:#}"))?;
    let start_s = start as f64 / audio.sample_rate as f64;
    let dynamics = dynamics::analyze(audio, start, end, &loudness.blocks, start_s, curves);
    let spectrum = spectrum::analyze(audio, start, end, loudness.stats.integrated);
    let stereo = stereo::analyze(audio, start, end, start_s, curves);
    let features = Features::new(&loudness.stats, &dynamics.stats, &spectrum, &stereo.stats);
    let psycho = psycho.then(|| psycho::analyze(audio, start, end, loudness.stats.integrated));
    Ok(AnalysisReport { loudness, dynamics, spectrum, stereo, features, psycho })
}

/// Loudness, dynamics, tonal balance and stereo image of a whole track (`range = None`) or a time
/// range in seconds, as JSON. A prepared version's whole-track analysis comes back at once.
#[tauri::command]
async fn analyze(
    slot: usize,
    range: Option<(f64, f64)>,
    curves: bool,
    state: State<'_, AppState>,
    versions: State<'_, Arc<Versions>>,
) -> Result<tauri::ipc::Response, String> {
    check_slot(slot)?;
    let whole = range.is_none() && curves;
    if whole && let Some(report) = versions.slot_report(slot) {
        return Ok(tauri::ipc::Response::new(report.to_string()));
    }
    let json = with_audio(&state, slot, move |audio| {
        let (start, end) = to_frame_range(audio, range);
        let report = analyze_range(audio, start, end, curves, true)?;
        serde_json::to_string(&report).map_err(|e| e.to_string())
    })
    .await?;
    if whole {
        versions.keep_slot_report(slot, json.as_str().into());
    }
    Ok(tauri::ipc::Response::new(json))
}

/// Waveform peaks for a time range, used when zoomed in beyond the overview resolution.
#[tauri::command]
async fn range_peaks(
    slot: usize,
    start: f64,
    end: f64,
    buckets: usize,
    state: State<'_, AppState>,
) -> Result<Peaks, String> {
    with_audio(&state, slot, move |audio| {
        let (s, e) = to_frame_range(audio, Some((start, end)));
        Ok(peaks::compute_peaks_range(audio, s, e, buckets.clamp(1, 16384)))
    })
    .await
}

/// The compared pair's audio: the track and the reference, by slot.
fn pair_audio(state: &AppState, slots: [usize; 2]) -> Result<[Option<Arc<AudioData>>; 2], String> {
    for slot in slots {
        check_slot(slot)?;
    }
    let tracks = state.tracks.lock().unwrap();
    Ok(slots.map(|s| tracks[s].clone()))
}

/// EQ match of the track in `slots[0]` towards the reference in `slots[1]` over each one's range
/// (`None` = whole track): stereo moves, side (width) moves and the full Matchering-style curves.
/// `loudest` measures only the louder parts.
#[tauri::command]
async fn match_eq(
    slots: [usize; 2],
    ranges: [Option<(f64, f64)>; 2],
    loudest: bool,
    state: State<'_, AppState>,
) -> Result<eq::MatchReport, String> {
    let [Some(a), Some(b)] = pair_audio(&state, slots)? else {
        return Err("load a track and a reference to compare it with".into());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mid_side = |audio: &AudioData, range| {
            let (start, end) = to_frame_range(audio, range);
            spectrum::mid_side(audio, start, end, loudest).ok_or_else(|| "nothing to measure: silent range".to_string())
        };
        Ok(eq::match_eq(&spectrum::grid(), &mid_side(&a, ranges[0])?, &mid_side(&b, ranges[1])?))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What's playing right now on a track, for the live analyser: the spectrum of the ~0.4 s up to
/// `seconds`, on the shared grid and normalised by `integrated` (the track's loudness, LUFS) like
/// the long-term spectrum, so the two overlay. `None` when that stretch is silent.
#[tauri::command]
async fn live_spectrum(
    slot: usize,
    seconds: f64,
    integrated: Option<f64>,
    state: State<'_, AppState>,
) -> Result<Option<Vec<f32>>, String> {
    with_audio(&state, slot, move |audio| Ok(spectrum::live(audio, seconds, integrated))).await
}

/// Spectrogram of a time range as `rows × columns` bytes (row 0 = highest frequency), sent as a
/// raw buffer rather than JSON.
#[tauri::command]
async fn spectrogram(
    slot: usize,
    start: f64,
    end: f64,
    columns: usize,
    rows: usize,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    let (columns, rows) = (columns.clamp(1, 4096), rows.clamp(1, 512));
    with_audio(&state, slot, move |audio| {
        let (s, e) = to_frame_range(audio, Some((start, end)));
        Ok(tauri::ipc::Response::new(spectrogram::compute(audio, s, e, columns, rows)))
    })
    .await
}

/// Per-band share of the moment's energy over time, used to find where each EQ move matters.
#[tauri::command]
async fn band_activity(
    slot: usize,
    range: Option<(f64, f64)>,
    state: State<'_, AppState>,
) -> Result<activity::BandActivity, String> {
    with_audio(&state, slot, move |audio| {
        let (start, end) = to_frame_range(audio, range);
        Ok(activity::analyze(audio, start, end))
    })
    .await
}

/// Audition EQ moves on a track's playback (`enabled = false` bypasses them).
#[tauri::command]
fn set_eq(slot: usize, filters: Vec<eq::Filter>, enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    check_slot(slot)?;
    state.player.set_eq(slot, &filters, enabled);
    Ok(())
}

#[derive(serde::Deserialize)]
struct MatchCurves {
    mid: Vec<f32>,
    side: Vec<f32>,
}

/// Render a track's playback through the full-match curves (dB on the shared grid) so it can be
/// switched to, or drop that rendering (`curves = None`). False if it was overtaken (a newer
/// render, or a different track loaded meanwhile).
#[tauri::command]
async fn render_full_match(slot: usize, curves: Option<MatchCurves>, state: State<'_, AppState>) -> Result<bool, String> {
    check_slot(slot)?;
    let player = state.player.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let freqs = spectrum::grid();
        player.render_alt(slot, curves.as_ref().map(|c| (&freqs[..], &c.mid[..], &c.side[..])))
    })
    .await
    .map_err(|e| e.to_string())
}

/// Play a track's full-match rendering instead of the track itself.
#[tauri::command]
fn set_full_match(slot: usize, enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    check_slot(slot)?;
    state.player.set_alt_enabled(slot, enabled);
    Ok(())
}

/// Write each lane's front version (`items`, in lane order) into one zip at `path`, encoded as
/// `format` and tagged with `artist` and `album`. Each file done is announced as a
/// `zip-progress` event with the number done so far.
#[tauri::command]
async fn export_zip(
    path: String,
    items: Vec<bundle::BundleItem>,
    format: bundle::Format,
    artist: String,
    album: String,
    cover: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cover = cover.map(|c| bundle::load_cover(Path::new(&c))).transpose().map_err(|e| format!("{e:#}"))?;
        bundle::write_zip(&PathBuf::from(path), &items, format, artist.trim(), album.trim(), cover.as_ref(), |done| {
            let _ = app.emit("zip-progress", done);
        })
        .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What Export as Zip's cover field shows for `path` (an image, or an audio file's own cover).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CoverPreview {
    /// A small JPEG, as a data URL.
    url: String,
    /// The size it's embedded at, px.
    width: u32,
    height: u32,
}

#[tauri::command]
async fn cover_preview(path: String) -> Result<CoverPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        bundle::cover_preview(Path::new(&path)).map(|(url, width, height)| CoverPreview { url, width, height }).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pro-Q 4's user preset folder, relative to the home directory.
const PRO_Q_PRESETS: &str = "Documents/FabFilter/Presets/Pro-Q 4";

/// The user's Pro-Q 4 "Default Setting" preset, used as the template for EQ-match presets so
/// they carry the user's own analyser and display settings. `None` if Pro-Q 4 has none.
#[tauri::command]
fn pro_q_template(app: tauri::AppHandle) -> Option<String> {
    let path = app.path().home_dir().ok()?.join(PRO_Q_PRESETS).join("Default Setting.ffp");
    let text = std::fs::read_to_string(path).ok()?;
    // Old presets carried over from Pro-Q 3 can be binary; only the text format is a template.
    text.contains("[Parameters]").then_some(text)
}

#[tauri::command]
fn library_status(library: State<'_, Arc<Library>>) -> library::Status {
    library.status()
}

/// Re-scan the library folder for new or changed files, in the background.
#[tauri::command]
fn rescan_library(app: tauri::AppHandle, library: State<'_, Arc<Library>>) {
    let library = library.inner().clone();
    std::thread::spawn(move || index_library(&library, &app));
}

/// Make `path` the library folder (remembered), where Deezer downloads go too, and index it.
#[tauri::command]
fn set_library_folder(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    library: State<'_, Arc<Library>>,
    downloads: State<'_, Arc<Downloads>>,
) -> Result<library::Status, String> {
    let folder = PathBuf::from(path);
    if !folder.is_dir() {
        return Err(format!("{} is not a folder", folder.display()));
    }
    settings::set_library_folder(&state.settings_path, &folder)?;
    library.set_root(folder.clone());
    downloads.deemix.set_music_dir(folder);
    let status = library.status();
    let _ = app.emit("library-status", &status);
    rescan_when_idle(library.inner().clone(), app);
    Ok(status)
}

fn index_library(library: &Library, app: &tauri::AppHandle) {
    library.index(&|status| {
        let _ = app.emit("library-status", status);
    });
}

/// Library tracks that sound most like `features`; `weights` balance tonal, dynamics, stereo.
#[tauri::command]
fn similar_tracks(
    features: Features,
    exclude: Vec<String>,
    weights: [f64; 3],
    limit: usize,
    library: State<'_, Arc<Library>>,
) -> Vec<Match> {
    library.similar(&features, &exclude, weights, limit)
}

/// Where the given tracks (mix, reference) sit among the library's tracks, per mix quality; with
/// `near`, among the `near` library tracks closest in sound to the first.
#[tauri::command]
fn library_standing(tracks: Vec<Option<standing::Input>>, near: Option<usize>, library: State<'_, Arc<Library>>) -> Vec<standing::Standing> {
    library.standing(&tracks, near)
}

/// Library tracks whose path contains every word of `query`.
#[tauri::command]
fn search_library(query: String, limit: usize, library: State<'_, Arc<Library>>) -> Vec<LibraryTrack> {
    library.search(&query, limit)
}

/// A track's markers (empty if it has none), found by its audio, else by its path (see `markers.rs`).
#[tauri::command]
fn markers(audio_id: String, path: String, store: State<'_, Arc<markers::Markers>>) -> Vec<markers::Marker> {
    store.get(&audio_id, &path)
}

/// Replace a track's markers.
#[tauri::command]
fn save_markers(
    audio_id: String,
    path: String,
    markers: Vec<markers::Marker>,
    store: State<'_, Arc<markers::Markers>>,
) -> Result<(), String> {
    store.set(&audio_id, &path, markers)
}

/// Save the lanes (in order, each with its versions) as a session file, and remember it as recent.
#[tauri::command]
fn save_session(
    path: String,
    lanes: Vec<sessions::Lane>,
    default_reference: Option<String>,
    recents: State<'_, Arc<sessions::Recents>>,
) -> Result<sessions::Session, String> {
    let session = sessions::write(&PathBuf::from(path), &lanes, default_reference.as_deref())?;
    recents.touch(&session);
    Ok(session)
}

/// Read a session file (its lanes, in order), and remember it as recent. Off the main thread:
/// finding files that moved may search the folders around them.
#[tauri::command]
async fn open_session(path: String, recents: State<'_, Arc<sessions::Recents>>) -> Result<sessions::Session, String> {
    let recents = recents.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let session = sessions::read(&path)?;
        // Files found elsewhere are saved where they are now (with fresh bookmarks), so the next
        // open needn't look for them; a session that can't be written (read-only) still opens.
        if !session.relinked.is_empty() {
            let _ = sessions::write(&path, &session.lanes, session.default_reference.as_deref());
        }
        recents.touch(&session);
        Ok(session)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Recently saved or opened sessions, most recent first.
#[tauri::command]
fn recent_sessions(recents: State<'_, Arc<sessions::Recents>>) -> Vec<sessions::RecentSession> {
    recents.list()
}

#[tauri::command]
fn clear_recent_sessions(recents: State<'_, Arc<sessions::Recents>>) {
    recents.clear();
}

/// Write the notes recap (Markdown) chosen in a save dialog.
#[tauri::command]
fn write_notes(path: String, contents: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) {
        return Err("Notes are written as a .md file".into());
    }
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

/// Deezer search and downloads through a headless Deemix server (see `deemix.rs`).
struct Downloads {
    deemix: Deemix,
    /// A thread is following the download queue.
    watching: AtomicBool,
}

/// Run a Deemix call (blocking HTTP, maybe a server start) off the async runtime.
async fn with_deemix<T: Send + 'static>(
    downloads: &Arc<Downloads>,
    f: impl FnOnce(&Deemix) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let downloads = downloads.clone();
    tauri::async_runtime::spawn_blocking(move || f(&downloads.deemix))
        .await
        .map_err(|e| e.to_string())?
}

/// Start Deemix if needed and log in with the saved ARL, if any.
#[tauri::command]
async fn deezer_connect(downloads: State<'_, Arc<Downloads>>) -> Result<deemix::Status, String> {
    with_deemix(&downloads, |d| d.connect()).await
}

#[tauri::command]
async fn deezer_login(arl: String, downloads: State<'_, Arc<Downloads>>) -> Result<deemix::Status, String> {
    with_deemix(&downloads, move |d| d.login(&arl)).await
}

#[tauri::command]
async fn deezer_search(query: String, limit: usize, downloads: State<'_, Arc<Downloads>>) -> Result<Vec<DeezerTrack>, String> {
    with_deemix(&downloads, move |d| d.search(&query, limit)).await
}

/// Queue a Deezer track or album for download into the library, then follow the queue.
#[tauri::command]
async fn deezer_download(
    kind: String,
    id: u64,
    app: tauri::AppHandle,
    downloads: State<'_, Arc<Downloads>>,
    library: State<'_, Arc<Library>>,
) -> Result<(), String> {
    // What had finished before, so the watcher notices this one finishing, even at once.
    let before = with_deemix(&downloads, move |d| {
        let before = finished_uuids(&d.queue()?);
        d.download(&kind, id)?;
        Ok(before)
    })
    .await?;
    watch_downloads(downloads.inner().clone(), library.inner().clone(), app, before);
    Ok(())
}

#[tauri::command]
async fn deezer_queue(downloads: State<'_, Arc<Downloads>>) -> Result<Vec<QueueItem>, String> {
    with_deemix(&downloads, |d| d.queue()).await
}

fn finished_uuids(items: &[QueueItem]) -> HashSet<String> {
    items.iter().filter(|i| i.finished()).map(|i| i.uuid.clone()).collect()
}

/// Poll the download queue while anything is pending, emitting `deezer-queue`, and rescan the
/// library whenever a download finishes so the new files get analysed.
fn watch_downloads(downloads: Arc<Downloads>, library: Arc<Library>, app: tauri::AppHandle, before: HashSet<String>) {
    if downloads.watching.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut finished = before;
        loop {
            let Ok(items) = downloads.deemix.queue() else { break };
            let _ = app.emit("deezer-queue", &items);
            let now = finished_uuids(&items);
            if now.difference(&finished).next().is_some() {
                rescan_when_idle(library.clone(), app.clone());
            }
            finished = now;
            if items.iter().all(QueueItem::finished) {
                downloads.watching.store(false, Ordering::SeqCst);
                // Something queued between the poll and the flag going down would go unwatched.
                let late = downloads.deemix.queue().is_ok_and(|q| !q.iter().all(QueueItem::finished));
                if !late || downloads.watching.swap(true, Ordering::SeqCst) {
                    break;
                }
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Index the library once any running scan is over (a scan already underway may have listed
/// the folder before the new files landed).
fn rescan_when_idle(library: Arc<Library>, app: tauri::AppHandle) {
    std::thread::spawn(move || {
        while library.status().scanning {
            std::thread::sleep(Duration::from_millis(500));
        }
        index_library(&library, &app);
    });
}

#[tauri::command]
fn set_trims(db: Vec<f64>, state: State<'_, AppState>) {
    for (slot, d) in db.into_iter().enumerate().take(SLOTS) {
        state.player.set_trim_db(slot, d);
    }
}

/// Player mode: tracks play one after another in `order` (lane order) instead of together.
#[tauri::command]
fn set_player_mode(on: bool, order: Vec<usize>, state: State<'_, AppState>) {
    state.player.set_player_mode(on, &order);
}

#[tauri::command]
fn set_volume(gain: f64, state: State<'_, AppState>) {
    state.player.set_volume(gain);
}

#[tauri::command]
fn unload_track(slot: usize, state: State<'_, AppState>, versions: State<'_, Arc<Versions>>) -> Result<(), String> {
    check_slot(slot)?;
    state.player.set_track(slot, None);
    state.tracks.lock().unwrap()[slot] = None;
    versions.set_slot(slot, None);
    Ok(())
}

#[tauri::command]
fn set_playing(playing: bool, state: State<'_, AppState>) {
    state.player.set_playing(playing);
}

#[tauri::command]
fn set_active(slot: usize, state: State<'_, AppState>) -> Result<(), String> {
    check_slot(slot)?;
    state.player.set_active(slot);
    Ok(())
}

#[tauri::command]
fn seek(slot: usize, seconds: f64, state: State<'_, AppState>) -> Result<(), String> {
    check_slot(slot)?;
    state.player.seek(slot, seconds);
    Ok(())
}

#[tauri::command]
fn set_loop(slot: usize, region: Option<(f64, f64)>, state: State<'_, AppState>) -> Result<(), String> {
    check_slot(slot)?;
    state.player.set_loop(slot, region);
    Ok(())
}

/// Loop a track's selection (or stop looping it).
#[tauri::command]
fn set_loop_enabled(slot: usize, enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    check_slot(slot)?;
    state.player.set_loop_enabled(slot, enabled);
    Ok(())
}

#[tauri::command]
fn transport(state: State<'_, AppState>) -> Transport {
    state.player.transport()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (player, audio_result) = player::start();
    let audio_error = audio_result.err().map(|e| format!("{e:#}"));
    if let Some(e) = &audio_error {
        eprintln!("audio output unavailable: {e}");
    }

    let builder = tauri::Builder::default();
    // Windows and Linux open files by starting the app with them as arguments: a second instance
    // hands them to this one, which comes to the front.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        open_files(app, file_args(args.into_iter().skip(1)));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let data = app.path().app_data_dir()?;
            let home = app.path().home_dir().ok();
            let settings_path = data.join("settings.json");
            let root = settings::library_folder(&settings_path, home.as_deref());
            app.manage(AppState {
                player,
                audio_error,
                tracks: Arc::new(Mutex::new(std::array::from_fn(|_| None))),
                // Files this launch was asked to open (Windows, Linux; macOS sends them as events).
                opened: Mutex::new(if cfg!(target_os = "macos") { Vec::new() } else { file_args(std::env::args().skip(1)) }),
                settings_path,
            });
            let library = Arc::new(Library::new(root.clone(), data.join("library.json")));
            let deemix = Deemix::new(home.as_deref().unwrap_or(Path::new("")), data.join("deemix"), root);
            app.manage(Arc::new(Downloads { deemix, watching: AtomicBool::new(false) }));
            app.manage(library.clone());
            app.manage(Arc::new(markers::Markers::new(data.join("markers.json"))));
            app.manage(Arc::new(Versions::new()));
            app.manage(Arc::new(sessions::Recents::new(data.join("recent_sessions.json"))));
            // Pick up tracks added since the last run.
            let handle = app.handle().clone();
            std::thread::spawn(move || index_library(&library, &handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio_status,
            take_opened_files,
            load_track,
            unload_track,
            set_playing,
            set_active,
            seek,
            set_loop,
            set_loop_enabled,
            analyze,
            range_peaks,
            set_trims,
            set_player_mode,
            set_volume,
            set_eq,
            match_eq,
            render_full_match,
            set_full_match,
            export_zip,
            cover_preview,
            spectrogram,
            live_spectrum,
            band_activity,
            pro_q_template,
            library_status,
            rescan_library,
            set_library_folder,
            similar_tracks,
            library_standing,
            search_library,
            deezer_connect,
            deezer_login,
            deezer_search,
            deezer_download,
            deezer_queue,
            markers,
            save_markers,
            save_session,
            prepare_versions,
            version_loudness,
            open_session,
            recent_sessions,
            clear_recent_sessions,
            write_notes,
            transport,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Stop the headless Deemix server with us.
            tauri::RunEvent::Exit => {
                if let Some(downloads) = app.try_state::<Arc<Downloads>>() {
                    downloads.deemix.shutdown();
                }
            }
            // Files opened from Finder.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                let paths = urls.iter().filter_map(|u| u.to_file_path().ok());
                open_files(app, paths.map(|p| p.to_string_lossy().into_owned()).collect());
            }
            _ => {}
        });
}

/// Queue files the OS asked us to open, and tell the UI to come and get them.
fn open_files(app: &tauri::AppHandle, paths: Vec<String>) {
    if !paths.is_empty() {
        app.state::<AppState>().opened.lock().unwrap().extend(paths);
        let _ = app.emit("open-files", ());
    }
}

/// The command-line arguments that are files (the rest are flags for the webview or tooling).
fn file_args(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter().filter(|a| !a.starts_with('-') && Path::new(a).is_file()).collect()
}
