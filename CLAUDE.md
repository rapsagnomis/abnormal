# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

(a/b)normal (bundle name `abnormal`): a Tauri v2 desktop app (Rust audio/analysis core + React/TypeScript UI) that measures a track (slot A) against a reference (slot B) — loudness, dynamics, tonal balance, stereo, EQ-match suggestions — and matches tracks against a pre-analysed music library. `PLAN.md` records design decisions and what each build phase added; update it when adding a phase-sized feature.

## Commands

`cargo` lives in `~/.cargo/bin`, which may not be on PATH in a non-login shell — prefix with `export PATH="$HOME/.cargo/bin:$PATH"`.

```sh
npm run tauri dev                                  # run the app (hot reload)
npx tsc --noEmit                                   # typecheck the UI (no linter is configured)
cargo test --manifest-path src-tauri/Cargo.toml    # Rust test suite
cargo test --manifest-path src-tauri/Cargo.toml loudness::   # one module / test by name filter
npm run tauri build -- --bundles app               # release .app in src-tauri/target/release/bundle/macos/
```

Installing a build means replacing `/Applications/abnormal.app` with the bundle (quit the app first).

All tests live in `src-tauri/src/tests.rs`, grouped in modules (`loudness`, `dynamics`, `spectrum_and_stereo`, `structure_and_activity`, `eq`). Synthetic-signal tests always run (EBU Tech 3341/3342 cases, known DR, spectra, correlations). Tests needing real audio silently pass unless their env vars are set: `SONIC_TEST_AUDIO` (dir of sine fixtures, see file header), `SONIC_BENCH_FILE`, `SONIC_DUMP_FILE`+`SONIC_DUMP_JSON`, `SONIC_EQ_TRACK`+`SONIC_EQ_REFERENCE`, `SONIC_SECTIONS_FILE`, `SONIC_DEEMIX_SEARCH` (starts Deemix headless in a temp folder and searches Deezer, no login), `SONIC_LIBRARY_DIR` (indexes a folder — point it at one album, the full library takes ~20 min). Use `-- --nocapture` to see their printed output.

The dev profile builds the app crate at opt-level 1 and dependencies at 3, because DSP is unusably slow unoptimised; tests use the same profile.

## Architecture

**Audio stays in Rust.** `decode.rs` (symphonia: mp3/flac/wav only — no AAC/m4a) produces `AudioData` (planar f32 at the file's own rate), kept per slot in `AppState.tracks`. The UI only ever receives downsampled peaks and analysis results. Playback (`player.rs`) uses a separate copy resampled to the device rate: one cpal stream plays both slots simultaneously with independent playheads/loops, and the A/B switch only crossfades gains. Loudness matching is a per-slot trim that only attenuates.

**One analysis path for everything.** `lib.rs::analyze_range(audio, start, end, curves)` runs loudness → dynamics (reuses loudness's per-100 ms `Blocks`) → spectrum (normalised by integrated loudness) → stereo, and builds a `similarity::Features` fingerprint. Whole tracks are `0..frames`, selections are a frame range — the same code. Both the `analyze` command and library indexing call it; `curves = false` skips the over-time curves.

**Shared frequency grid.** `spectrum::grid()` (20 Hz–20 kHz, 24 points/octave) is the x-axis for every spectrum, width curve, EQ target, and the tonal part of the fingerprint (every 8th point), so arrays from A, B and the library line up index for index. Changing the grid changes all of these.

**Library (`library.rs`, `similarity.rs`).** At startup (`setup` in `lib.rs`) a background thread scans `~/Music/albums` recursively and analyses files that are new or changed (size + mtime) with ≤ 4 workers; deleted files are dropped; failures are stored so they aren't retried. The DB is `library.json` in the app data dir (`~/Library/Application Support/com.simongaspar.soniccompare/`), saved atomically every 20 s. **Bump `DB_VERSION` whenever `Features` or the analysis feeding it changes**, otherwise stale fingerprints are compared with new ones. Similarity: per-value z-scores using the library's spread, RMS per group (tonal / dynamics / stereo), weighted combination, score = 100·e^−d. Progress reaches the UI via the `library-status` event.

**Deezer downloads (`deemix.rs`).** The Library tab searches Deezer and downloads FLAC into the library through the Deemix desktop app (`/Applications/deemix-gui.app`) without opening it: its bundled HTTP server is started headless (`ELECTRON_RUN_AS_NODE=1`, `--singleuser`, free port, `DEEMIX_DATA_DIR` = `deemix/` in our app data), lazily on first use and killed on exit. Deemix logs in per HTTP session, so the `ureq` agent keeps the cookie; the ARL is saved by Deemix in that data dir, never by us. Finished downloads trigger a library rescan.

**Frontend.** `src/App.tsx` owns all state (per-slot tuples `Pair<T>`, a `loadSeq` counter to discard results for replaced tracks, a `latest` ref for once-registered keyboard/drag-drop handlers). `src/lib/api.ts` mirrors the Rust types (serde `camelCase`) and wraps every `invoke` — keep the two in sync by hand. Metric tables are data-driven from `src/lib/metrics.ts` (`SECTIONS`), which the Markdown/JSON report export (`src/lib/report.ts`) also uses; the EQ and Library tabs have their own views. `Features` from an analysis report is opaque to the UI and passed back unchanged to `similar_tracks`, so matching works for selections too.
