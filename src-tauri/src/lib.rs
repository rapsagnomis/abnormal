mod decode;
mod dynamics;
mod eq;
mod loudness;
mod peaks;
mod player;
mod spectrum;
mod stereo;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use decode::AudioData;
use dynamics::DynamicsReport;
use loudness::LoudnessReport;
use spectrum::SpectrumReport;
use stereo::StereoReport;
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
) -> Result<TrackInfo, String> {
    check_slot(slot)?;
    let player = state.player.clone();
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
        let loudness = loudness::analyze(audio, start, end, curves).map_err(|e| format!("{e:#}"))?;
        let start_s = start as f64 / audio.sample_rate as f64;
        let dynamics = dynamics::analyze(audio, start, end, &loudness.blocks, start_s, curves);
        let spectrum = spectrum::analyze(audio, start, end, loudness.stats.integrated);
        let stereo = stereo::analyze(audio, start, end, start_s, curves);
        Ok(AnalysisReport { loudness, dynamics, spectrum, stereo })
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

/// Write a report to a path the user picked in the save dialog.
#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("could not write {path}: {e}"))
}

#[tauri::command]
fn set_trims(db: [f64; SLOTS], state: State<'_, AppState>) {
    for (slot, d) in db.into_iter().enumerate() {
        state.player.set_trim_db(slot, d);
    }
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
            suggest_eq,
            write_text_file,
            transport,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
