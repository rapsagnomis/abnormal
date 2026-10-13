mod activity;
mod decode;
mod deemix;
mod dynamics;
mod eq;
mod library;
mod loudness;
mod peaks;
mod player;
mod sections;
mod similarity;
mod spectrogram;
mod spectrum;
mod stereo;
mod stft;
mod structure;
#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::path::PathBuf;
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

/// Library folder, relative to the home directory.
const LIBRARY_DIR: &str = "Music/albums";

/// Overview waveform resolution sent with each track. Enough for a full-width display on a
/// large screen; zoomed views request finer peaks per range via `range_peaks`.
const PEAK_BUCKETS: usize = 8192;

struct AppState {
    player: Arc<Shared>,
    audio_error: Option<String>,
    /// Original-rate decoded audio, kept for analysis.
    tracks: Arc<Mutex<[Option<Arc<AudioData>>; SLOTS]>>,
}

#[derive(Serialize)]
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

#[tauri::command]
fn audio_status(state: State<'_, AppState>) -> AudioStatus {
    let rate = state.player.device_rate.load(std::sync::atomic::Ordering::Relaxed);
    AudioStatus {
        device_rate: (rate > 0 && state.audio_error.is_none()).then_some(rate),
        error: state.audio_error.clone(),
    }
}

#[tauri::command]
async fn load_track(
    slot: usize,
    path: String,
    state: State<'_, AppState>,
    library: State<'_, Arc<Library>>,
) -> Result<TrackInfo, String> {
    check_slot(slot)?;
    let player = state.player.clone();
    let library = library.inner().clone();
    let tracks = state.tracks.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let path_buf = PathBuf::from(&path);
        let audio = decode::decode_file(&path_buf).map_err(|e| format!("{e:#}"))?;
        let device_rate = player.device_rate.load(std::sync::atomic::Ordering::Relaxed);
        if device_rate > 0 {
            let buffer = PlaybackBuffer::new(&audio, device_rate).map_err(|e| format!("{e:#}"))?;
            player.set_track(slot, Some(buffer));
        }
        let info = TrackInfo {
            slot,
            name: path_buf
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone()),
            path,
            sample_rate: audio.sample_rate,
            channels: audio.channels.len(),
            duration: audio.duration(),
            peaks: peaks::compute_peaks(&audio, PEAK_BUCKETS),
            meta: library.track_meta(&path_buf),
        };
        tracks.lock().unwrap()[slot] = Some(Arc::new(audio));
        Ok(info)
    })
    .await
    .map_err(|e| e.to_string())?
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
}

/// Full analysis of frames `start..end`; shared by the `analyze` command and library indexing.
fn analyze_range(audio: &AudioData, start: usize, end: usize, curves: bool) -> Result<AnalysisReport, String> {
    let loudness = loudness::analyze(audio, start, end, curves).map_err(|e| format!("{e:#}"))?;
    let start_s = start as f64 / audio.sample_rate as f64;
    let dynamics = dynamics::analyze(audio, start, end, &loudness.blocks, start_s, curves);
    let spectrum = spectrum::analyze(audio, start, end, loudness.stats.integrated);
    let stereo = stereo::analyze(audio, start, end, start_s, curves);
    let features = Features::new(&loudness.stats, &dynamics.stats, &spectrum, &stereo.stats);
    Ok(AnalysisReport { loudness, dynamics, spectrum, stereo, features })
}

/// Loudness, dynamics, tonal balance and stereo image of a whole track (`range = None`) or a time range in seconds.
#[tauri::command]
async fn analyze(
    slot: usize,
    range: Option<(f64, f64)>,
    curves: bool,
    state: State<'_, AppState>,
) -> Result<AnalysisReport, String> {
    with_audio(&state, slot, move |audio| {
        let (start, end) = to_frame_range(audio, range);
        analyze_range(audio, start, end, curves)
    })
    .await
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

/// EQ moves for `track` to approach `reference` (loudness-normalised spectra on the shared grid).
#[tauri::command]
fn suggest_eq(track: Vec<f32>, reference: Vec<f32>) -> eq::EqReport {
    eq::suggest(&spectrum::grid(), &track, &reference)
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

/// Song sections of a whole track, labelled so that sections that sound alike share a label.
#[tauri::command]
async fn sections(slot: usize, state: State<'_, AppState>) -> Result<Vec<sections::Section>, String> {
    with_audio(&state, slot, |audio| Ok(sections::analyze(audio, 0, audio.frames()))).await
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

/// Pro-Q 4's user preset folder, relative to the home directory.
const PRO_Q_PRESETS: &str = "Documents/FabFilter/Presets/Pro-Q 4";
/// Subfolder of it that EQ-match presets are saved to (it shows up in Pro-Q's preset browser).
const PRO_Q_FOLDER: &str = "abnormal";

/// The user's Pro-Q 4 "Default Setting" preset, used as the template for EQ-match presets so
/// they carry the user's own analyser and display settings. `None` if Pro-Q 4 has none.
#[tauri::command]
fn pro_q_template(app: tauri::AppHandle) -> Option<String> {
    let path = app.path().home_dir().ok()?.join(PRO_Q_PRESETS).join("Default Setting.ffp");
    let text = std::fs::read_to_string(path).ok()?;
    // Old presets carried over from Pro-Q 3 can be binary; only the text format is a template.
    text.contains("[Parameters]").then_some(text)
}

/// Save a Pro-Q 4 preset into Pro-Q's preset folder, returning where it went.
#[tauri::command]
fn save_pro_q_preset(name: String, contents: String, app: tauri::AppHandle) -> Result<String, String> {
    let root = app.path().home_dir().map_err(|e| e.to_string())?.join(PRO_Q_PRESETS);
    if !root.is_dir() {
        return Err("Pro-Q 4's preset folder was not found: is Pro-Q 4 installed?".into());
    }
    let dir = root.join(PRO_Q_FOLDER);
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    // File names can't hold path separators (or a leading dot, which would hide the preset).
    let clean: String = name.chars().map(|c| if matches!(c, '/' | ':' | '\\') { '-' } else { c }).collect();
    let path = dir.join(format!("{}.ffp", clean.trim().trim_start_matches('.')));
    std::fs::write(&path, contents).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Write a report to a path the user picked in the save dialog.
#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("could not write {path}: {e}"))
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

/// Library tracks whose path contains every word of `query`.
#[tauri::command]
fn search_library(query: String, limit: usize, library: State<'_, Arc<Library>>) -> Vec<LibraryTrack> {
    library.search(&query, limit)
}

/// Whether the song-structure model is set up, and install progress.
#[tauri::command]
fn structure_status(engine: State<'_, Arc<structure::Engine>>) -> structure::SetupStatus {
    engine.status()
}

/// Set up the song-structure model's Python environment in the background, emitting
/// `structure-setup` as it goes.
#[tauri::command]
fn structure_install(app: tauri::AppHandle, engine: State<'_, Arc<structure::Engine>>) {
    let engine = engine.inner().clone();
    std::thread::spawn(move || {
        engine.install(&|status| {
            let _ = app.emit("structure-setup", status);
        })
    });
}

/// The structure of a file if it's been analysed; otherwise `None`, and it is queued for
/// analysis (when the model is set up), with the result sent as a `structure` event.
#[tauri::command]
fn song_structure(path: String, app: tauri::AppHandle, engine: State<'_, Arc<structure::Engine>>) -> Option<structure::Structure> {
    let path = PathBuf::from(path);
    if let Some(found) = engine.cached(&path) {
        return Some(found);
    }
    engine.request(
        path,
        Arc::new(move |outcome| {
            let _ = app.emit("structure", outcome);
        }),
    );
    None
}

/// Keep the user's corrected song parts for a file (they win over the detected ones).
#[tauri::command]
fn save_structure_edit(
    path: String,
    segments: Vec<structure::Segment>,
    engine: State<'_, Arc<structure::Engine>>,
) -> Result<structure::Structure, String> {
    engine.save_edit(&PathBuf::from(path), segments)
}

/// Forget the user's corrections for a file, returning the detected structure.
#[tauri::command]
fn reset_structure_edit(path: String, engine: State<'_, Arc<structure::Engine>>) -> Option<structure::Structure> {
    engine.reset_edit(&PathBuf::from(path))
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
fn set_trims(db: [f64; SLOTS], state: State<'_, AppState>) {
    for (slot, d) in db.into_iter().enumerate() {
        state.player.set_trim_db(slot, d);
    }
}

#[tauri::command]
fn set_volume(gain: f64, state: State<'_, AppState>) {
    state.player.set_volume(gain);
}

#[tauri::command]
fn unload_track(slot: usize, state: State<'_, AppState>) -> Result<(), String> {
    check_slot(slot)?;
    state.player.set_track(slot, None);
    state.tracks.lock().unwrap()[slot] = None;
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

#[tauri::command]
fn set_loop_enabled(enabled: bool, state: State<'_, AppState>) {
    state.player.set_loop_enabled(enabled);
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            player,
            audio_error,
            tracks: Arc::new(Mutex::new([None, None])),
        })
        .setup(|app| {
            let root = app.path().home_dir()?.join(LIBRARY_DIR);
            let db_path = app.path().app_data_dir()?.join("library.json");
            let library = Arc::new(Library::new(root.clone(), db_path));
            let deemix = Deemix::new(&app.path().home_dir()?, app.path().app_data_dir()?.join("deemix"), root);
            app.manage(Arc::new(Downloads { deemix, watching: AtomicBool::new(false) }));
            app.manage(Arc::new(structure::Engine::new(app.path().home_dir()?, app.path().app_data_dir()?.join("allin1"))));
            app.manage(library.clone());
            // Pick up tracks added since the last run.
            let handle = app.handle().clone();
            std::thread::spawn(move || index_library(&library, &handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            audio_status,
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
            set_volume,
            set_eq,
            suggest_eq,
            spectrogram,
            sections,
            band_activity,
            write_text_file,
            pro_q_template,
            save_pro_q_preset,
            library_status,
            rescan_library,
            similar_tracks,
            search_library,
            deezer_connect,
            deezer_login,
            deezer_search,
            deezer_download,
            deezer_queue,
            structure_status,
            structure_install,
            song_structure,
            save_structure_edit,
            reset_structure_edit,
            transport,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Stop the headless Deemix server with us.
            if let tauri::RunEvent::Exit = event {
                if let Some(downloads) = app.try_state::<Arc<Downloads>>() {
                    downloads.deemix.shutdown();
                }
            }
        });
}
