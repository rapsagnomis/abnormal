# (a/b)normal — Plan

Desktop tool to analyse and compare the sonic characteristics of a song against a reference track.

## Decisions
- **Platform:** native desktop, Tauri v2 (Rust core + React/TypeScript UI)
- **Comparison:** 1:1 (track A vs reference track B), full song or selected regions
- **Stereo analysis:** yes
- **Tonal suggestions:** concrete EQ moves (type, freq, gain, Q)
- **Formats:** mp3, flac, wav

## Architecture

```
┌─────────── React UI (TypeScript) ───────────┐
│ drop zone · 2× canvas waveform (Rust peaks) │
│ transport · regions · uPlot charts · A/B    │
└──────────────┬──────────────────────────────┘
               │ Tauri commands + events (playhead, progress)
┌──────────────▼──────────────────────────────┐
│ Rust core                                   │
│  decode   : symphonia → f32 planar buffers  │
│  playback : cpal stream, A/B crossfade,     │
│             loudness-match gain, seek, loop │
│  analysis : rayon workers per track/region  │
│    loudness ─ ebur128 (I, S, M, LRA, dBTP)  │
│    dynamics ─ crest, PSR, TT-DR, histogram  │
│    tonal    ─ realfft LTAS, 1/6-oct smooth  │
│    stereo   ─ correlation, M/S, width/band  │
│  suggest  : diff curve → EQ moves           │
└─────────────────────────────────────────────┘
```

- Audio is decoded once and stays in Rust; the UI only receives downsampled peaks and analysis results.
- All analysis takes a `(track, start, end)` range — whole song = `0..len`, so region comparison is the same code path.
- Playback is a single cpal stream: A/B switch is a short crossfade, loudness-match is a gain derived from the integrated LUFS difference, optional playhead lock between tracks.

## Metrics

| Area | Measures |
|---|---|
| Loudness | Integrated LUFS, short-term/momentary curves, LRA, sample peak, true peak (dBTP), PLR |
| Micro dynamics | Crest factor and PSR over time, peak-vs-RMS histogram, transient strength |
| Macro dynamics | LRA, short-term loudness distribution, TT-DR score, section contrast |
| Tonal | Loudness-normalized LTAS (1/6 oct), band energies (sub → air), spectral tilt, centroid, A−B diff curve |
| Stereo | Correlation over time, M/S ratio, width per band, goniometer for selected region |

**EQ suggestions:** smooth diff curve → find contiguous deviations above ~1 dB → fit to shelf/peak (f, gain, Q) → rank by perceptual weight.

## Phases
1. **Skeleton** ✅ — Tauri + Vite + React scaffold, drag & drop 1–2 files, symphonia decode, waveform peaks → custom canvas waveform (wavesurfer dropped: it is built around an HTML media element, but playback is native), cpal transport (play/seek/loop region), A/B switch.
2. **Loudness** ✅ — ebur128 integration (mono measured as dual mono), M/S curve overlay, loudness-matched A/B (attenuate the louder track, never boost), full-track vs selection stats, validated against EBU Tech 3341/3342 signals and cross-checked with ffmpeg. Also: waveform zoom/pan with on-demand detail peaks.
3. **Dynamics** ✅ — crest factor (whole + 50 ms median), PSR (median/min + gated curve overlay), onset rate and attack rise, TT DR (matches ffmpeg drmeter within 0.05), short-term P10/P50/P95, short-term loudness and crest distributions (A/B overlaid histograms). Curve + Match controls moved to the transport bar.
4. **Tonal + stereo** ✅ — loudness-normalised LTAS (energy per 1/6 oct, pink = flat), A−B difference, centroid, tilt, 7 band levels; correlation (mean, worst 5%, % out of phase, curve overlay), side/mid, L/R balance, width per band and per frequency, goniometers. Waveform simplified to a single min/max layer; Link off by default.
5. **Region compare + suggestions** ✅ — every tab measures full tracks or selections (a lane without a selection falls back to its full track; load the same file twice to compare two parts of one song); "EQ match" tab fits up to 6 bell/shelf moves for A towards B (1/3-oct smoothed, median level offset removed, Q ≤ 2, ±6 dB, ≥ ½ oct apart) with needed-vs-suggested chart and copy; report export as Markdown or JSON summary.
6. **Library matching** ✅ — every mp3/flac/wav under `~/Music/albums` is analysed in the background (≤ 4 workers, decoded audio is held in memory) into a JSON database in the app data folder; each start re-scans and only analyses new/changed files (size + mtime), dropping deleted ones; failures are stored so they aren't retried until the file changes. Fingerprint per track: 1/3-oct spectrum shape (32 Hz–16 kHz, mean removed; lossy files are low-passed above), dynamics (LRA, PLR, PSR, 50 ms crest, DR, log onset rate, attack rise) and stereo (correlation, width per band). Distance = RMS of z-scores, each value scaled by its spread over the library, per group, combined 0.5/0.3/0.2 (or one group alone); score = 100·e^−d. "Similar" tab lists the top 30 for A or B (full track or selection), with per-aspect scores and load-into-A/B.
7. **Listening & structure** ✅ — *EQ audition*: the suggested moves (each switchable in the EQ tab) play on A through RBJ biquads in the player (TDF-II, f64, always running so on/off is a 15 ms crossfade), level-compensated by the K-weighted loudness change estimated from A's spectrum; trims never boost (if compensation would, both tracks come down). *Spectrogram* lane display (S): STFT 4096, log rows 30 Hz–20 kHz as energy per ⅓-oct equivalent (pink = flat), bytes over raw IPC, whole-track overview then screen-resolution detail per view; each track scaled to its own ceiling (99.8th percentile, 66 dB range). *Sections*: 0.5 s cells of timbre (octave bands) + chroma + level, z-scored with spread floors, Foote checkerboard novelty (8 s half-width, scaled to mean across-minus-within distance, peaks ≥ 0.15 and ≥ 8 s apart), grouped by distance between section means (< 0.6 × median); shown as a clickable strip under each lane (Shift+click extends). *Where it matters*: half-octave band levels per 0.5 s relative to the surrounding 3 s (`activity.rs`); each EQ move gets a ▶ that loops the 4 s of A where its range is furthest from B's median in the direction it corrects. (A separate Masking tab — heat map, crowded/thin lists — was tried and dropped as too complicated for what it told you.) Shared STFT helper in `stft.rs`.
8. **Library + Deezer downloads** ✅ — "Similar" became the "Library" tab (same matches view); its search box now lists library hits (first 8, "Show all") and Deezer tracks below, each with ↓ Track / ↓ Album buttons that download FLAC into `~/Music/albums`. Downloads go through Deemix without its window (`deemix.rs`): the Deemix app's bundled server is run with its own Electron binary in Node mode (`ELECTRON_RUN_AS_NODE`), headless, single-user, on a free local port, with `DEEMIX_DATA_DIR` pointing inside our app data so the GUI's queue and login are never touched and it works whether or not the GUI is open. Its config is the GUI's `config.json` copied on each start, download folder forced to the library. The Deezer ARL is pasted once in the tab and saved by Deemix itself (single-user mode), which hands it back on `/api/connect` for auto-login; we never store it. A watcher thread polls the queue while anything is pending (`deezer-queue` event) and rescans the library when a download finishes. The server is killed on exit; a stale one from a crash is killed via its pid file. Also: the EQ match tab was folded into Tonal, under the spectrum charts.
