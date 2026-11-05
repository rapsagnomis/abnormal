# (a/b)normal

A desktop tool to analyse a track and compare its sonic characteristics with a reference: loudness, dynamics, tonal balance and stereo image, plus EQ suggestions to move your track towards the reference.

Built with [Tauri](https://tauri.app) — a Rust audio/analysis core and a React + TypeScript UI. Everything runs locally.

## Features

- **Load** mp3, flac, wav, aiff or m4a (AAC/ALAC) into slot **A** (your track) and **B** (reference): drag and drop or *Open…*.
- **Play** both tracks in sync and switch A/B with a short crossfade (`Tab`, `1`/`2`). Loudness-match playback (`M`) to compare tone rather than level.
- **Navigate**: click to seek, drag to select and loop (`L`), zoom with the wheel or pinch, link playheads/selections/zoom across tracks (`K`).
- **Measure** full tracks or selections — a lane without a selection is measured as a whole, so you can compare your chorus against the full reference. To compare two parts of one song, load it in both slots.

| Tab | What it shows |
|---|---|
| Loudness | Integrated / max short-term / max momentary LUFS, LRA, true peak, sample peak, PLR (EBU R128 / BS.1770-4) |
| Dynamics | Crest factor, PSR, onsets and attack rise, TT DR, short-term percentiles, loudness and crest distributions |
| Tonal | Loudness-normalised spectrum (1/6 oct), A − B difference, centroid, tilt, 7 band levels |
| Stereo | Phase correlation, side/mid, L/R balance, width per band and per frequency, goniometers |
| EQ match | Up to 6 bell/shelf moves for A to approach B, with the needed vs. suggested curve |
| Similar | Songs from your library that sound most like A or B — overall, or on tonal balance, dynamics or stereo only. Search the library by artist, album or title. Load any match or result into A or B |

**Library**: every mp3, flac, wav, aiff and m4a/aac file under the library folder (all subfolders; chosen with *Folder…* in the Library drawer, ⌘K / Ctrl+K) is analysed in the background and kept in a database (`library.json` in the app data folder). At each start only new or changed files are analysed, and deleted ones are dropped; *Rescan* does the same on demand. The first run over a large library takes a while — matches fill in as it goes.

Curves can be overlaid on the waveforms: momentary or short-term loudness, PSR, or correlation (`C` cycles).

## Running

Requirements: [Node.js](https://nodejs.org) and [Rust](https://rustup.rs).

```sh
npm install
npm run tauri dev     # development, with hot reload
npm run tauri build   # release app in src-tauri/target/release/bundle/
```

Universal macOS build (Apple Silicon and Intel; needs `rustup target add x86_64-apple-darwin`):

```sh
npm run build:mac          # with Deezer downloads
npm run build:mac:shared   # without them, for builds given to others
```

Pushing a `v*` tag builds macOS and Windows installers on GitHub Actions (`.github/workflows/release.yml`); see `DISTRIBUTION.md` for signing.

### Installing an unsigned build on another Mac

Until builds are signed with a Developer ID, macOS says the app is damaged. After copying it to Applications, run once in Terminal:

```sh
xattr -cr /Applications/abnormal.app
```

On Windows, SmartScreen warns about an unknown publisher: *More info → Run anyway*.

## Tests

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```

The suite checks the analysis against reference signals (EBU Tech 3341/3342 loudness cases, known DR, spectra and correlations). Tests that need audio files are skipped unless their environment variables are set — see `src-tauri/src/tests.rs`.

## Project layout

```
src-tauri/src/   decode, player (playback), peaks, loudness, dynamics,
                 spectrum, stereo, eq, similarity (fingerprints), library (index),
                 lib (Tauri commands)
src/             App, components (lanes, waveform, panel, charts), lib (API, metrics, report)
PLAN.md          design decisions and build phases
```
