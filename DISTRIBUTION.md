# Cross-platform distribution plan

What it takes to share (a/b)normal so it works on other Macs and on Windows. Written 2026-11-05
against commit `da78c30` (branch `multi-track-compare`); line numbers may have moved since.

**Status (2026-11-05):** the code side is done (ticked below). What's left needs accounts, money,
a Windows machine or a decision: signing, font licences, LAME notices, the identifier, the updater.

The core is portable already: symphonia, cpal, ebur128, the DSP, Tauri and the app-data paths
(`app_data_dir`, the `$APPDATA/covers` asset scope) are cross-platform. The work is in packaging and
signing, a few hard-coded macOS paths, the Deemix integration, path handling in the UI, and licensing.

## 1. Blocking: needed before anyone else can run it

- [ ] **Signing (macOS).** *(Needs an Apple Developer account. `release.yml` signs and notarizes
      once the `APPLE_*` secrets are set; until then README has the `xattr` step.)* `codesign -dv` shows `Signature=adhoc`, no Team ID: another Mac's
      Gatekeeper reports the app as damaged / from an unidentified developer.
      - Free: recipients run `xattr -cr /Applications/abnormal.app` (clumsy).
      - Proper: Apple Developer ID ($99/year), signed with hardened runtime and notarized. Tauri
        does it from env vars (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`).
- [x] **Apple Silicon only (macOS).** The binary is `arm64`; it won't run on Intel Macs. Build
      `--target universal-apple-darwin` (after `rustup target add x86_64-apple-darwin`).
      → `npm run build:mac` / `build:mac:shared`, and the release workflow.
- [x] **Hard-coded library folder.** `LIBRARY_DIR = "Music/albums"` (`src-tauri/src/lib.rs`, used
      in `setup`). Others won't have it, so the library is empty. Add a library-folder setting
      (folder picker, stored in app data); default `~/Music` or nothing until chosen. Handle a
      missing or unreachable folder without endless rescans.
      → `settings.rs` (`settings.json`), *Folder…* in the Library drawer (`set_library_folder`).
      Nothing until chosen, except an existing `~/Music/albums`, kept so this install carries on.
      A missing folder reports "not found" and keeps the index (no rescan loop existed).
- [x] **Deemix assumes macOS and this setup** (`src-tauri/src/deemix.rs`): `APP =
      "/Applications/deemix-gui.app"`, `BINARY = "Contents/MacOS/deemix-gui"`, and `ps` / `kill` in
      `kill_stale_server`.
      - Windows: find `deemix-gui.exe` (usually `%LOCALAPPDATA%\Programs\deemix-gui\`); replace
        `ps`/`kill` with a cross-platform check (`sysinfo` crate, or `tasklist`/`taskkill`).
      - Everywhere: if Deemix isn't installed, hide the Deezer part of the Library drawer and say why.
      → `Install::locate` per platform (also `~/Applications` on macOS); `tasklist`/`taskkill` on
      Windows, no console windows; downloads follow the library folder. The Windows paths are
      unverified on a real machine.
- [ ] **Licensing for redistribution.**
      - [ ] Fonts: the title font Blur (Neville Brody, `src/assets/fonts/blur/`) is commercial;
        embedding it in a distributed app usually needs an app/embedding licence. Same check for
        Garabosse (`src/assets/fonts/garabosse/`) if still shipped. Otherwise switch to an open font.
        *Garabosse isn't shipped: no CSS references it, so Vite leaves it out (the files can go).
        Blur is the one to decide.*
      - [x] Deezer downloads: fine for personal use; distributing a Deezer downloader is a ToS and
        copyright exposure. Consider leaving it out of shared builds (Cargo feature / build flag)
        or making it explicitly opt-in. → Cargo feature `deezer` (default on);
        `--no-default-features` removes it and the drawer's Deezer section. The release workflow
        builds without it unless the `INCLUDE_DEEZER` repository variable is `true`.
      - [ ] LAME (MP3 encoding, `mp3lame-encoder`): LGPL, compiled into the binary. Acknowledge it
        (About / licence notices) and keep the relinking obligation in mind.

## 2. Windows-specific

- [x] **UI path handling assumes `/`.** About a dozen places use `path.split("/")` or
      `/\/[^/]*$/`: `App.tsx` (`folderOf`, unsupported-file error, session/notes/zip default names,
      relinked list), `VersionsDrawer.tsx` (`fileName`), `ZipExport.tsx` (`stem`, saved name),
      `LibraryView.tsx` (`relPath`), `AnalysisPanel.tsx` (names). Windows paths are
      `C:\…\x.flac`, so names would show whole paths and default folders would be wrong.
      Add `basename` / `dirname` helpers in `src/lib` that split on `/` and `\`, use them
      everywhere, and have `library.rs` send `rel_path` with `/` separators.
      → `src/lib/paths.ts` (`basename`, `dirname`, `joinPath`; `\` only counts on Windows, where
      it can't be in a name). Sessions also store relative paths with `/`, so they cross systems.
- [x] **Opening files from Explorer.** Only `#[cfg(target_os = "macos")] RunEvent::Opened` is
      handled (`lib.rs`, `run`). Windows passes the file as a command-line argument and starts a
      second instance. Read `std::env::args()` at startup into `AppState.opened`, and add
      `tauri-plugin-single-instance` so a double-click while open forwards the path to the window.
      → `file_args` + `open_files` in `lib.rs`; the plugin is only a dependency off macOS.
- [x] **Shortcuts are Mac-only.** Nine handlers test `metaKey` (`App.tsx`, `Waveform.tsx`) and
      ~23 labels say ⌘ (`AppMenu`, `ShortcutsDialog`, `SourceMenu`, `LibraryDrawer`, `LibraryView`,
      `TransportBar`, `App.tsx`). On Windows that's the Windows key, so ⌘K/N/O/S, ⌘←, ⌘↑↓ and
      ⌘-wheel zoom don't work. Add `mod(e) = isMac ? e.metaKey : e.ctrlKey` and a `modLabel`
      ("⌘" / "Ctrl+") used by the menus and the shortcuts pop-up.
      → `src/lib/platform.ts` (`modKey`, `withMod`, `MOD`).
- [x] **Session relinking.** macOS bookmarks are already `cfg`'d out; the identity search works
      everywhere. Add Windows' `$Recycle.Bin` to `in_trash` in `relink.rs`.
- [x] **Build on Windows.** Tauri can't produce MSI/NSIS installers from a Mac. Use GitHub Actions
      with `tauri-action` on `windows-latest`. `mp3lame-sys` compiles LAME from vendored C with
      `cc`; it should build with MSVC but is unverified.
      → `.github/workflows/release.yml` (tag `v*`). Still unverified until the first run.
- [ ] **Windows code signing.** Unsigned installers get SmartScreen's "unknown publisher" warning.
      OV/EV certificate, or Azure Trusted Signing (cheapest). Without it: "More info → Run anyway".
- [ ] **Audio on Windows.** cpal uses WASAPI; the player follows the device rate, which should be
      fine, but the output sample format and device changes are unverified. *The output now opens
      in the device's own sample format (f32, f64, i32, i16, u16), not only f32. Device changes
      are still not followed on any platform: unplugging the interface in use stops playback
      until the app restarts.* Smoke-test playback,
      A/B, loops, seek and player mode on 44.1 and 48 kHz devices.

## 3. Good first impression (both systems)

- [x] Settings view (library folder, Deezer on/off) and a first-run hint when no library is set.
      → In the Library drawer's status line rather than a separate view; Deezer is a build flag.
- [ ] Decide the app identifier now: still `com.simongaspar.soniccompare` (`tauri.conf.json`).
      It fixes where libraries, markers and recent sessions live; changing it after others
      install loses their data (or needs a migration).
- [ ] Updates: `tauri-plugin-updater` with GitHub Releases.
- [x] UI text font: check `--font-text` falls back to Segoe UI on Windows, not a generic serif.
      → Segoe UI (Variable) added to both stacks.
- [x] `pro_q_template` (`lib.rs`) reads `~/Documents/FabFilter/Presets/Pro-Q 4`; harmless and
      cross-platform, but drop it if nothing calls it any more. → Still used (Pro-Q export); kept.
- [x] CI runs the Rust suite (synthetic tests, no fixtures needed) on macOS and Windows.
      → `.github/workflows/ci.yml` (also typechecks, and checks the build without Deezer). Needs
      a GitHub remote: the repo has none yet.

## Suggested order

1. **Mac sharing (~1 day):** universal build, library-folder setting, Deemix optional, font
   decision; then `xattr` instructions, or Developer ID signing + notarization.
2. **Windows code (~1–2 days):** path helpers, shortcut helper, argv + single instance, Deemix on
   Windows, Recycle Bin. None of it needs a Windows machine to write.
3. **CI and installers (~½ day):** GitHub repo, Actions with `tauri-action` building macOS
   (universal) and Windows, plus `cargo test` on both.
4. **Real Windows test (~½ day):** audio, file associations, drag and drop, sessions moved between
   machines.
