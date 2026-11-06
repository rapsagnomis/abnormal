import { invoke } from "@tauri-apps/api/core";

/** A playback slot: 0 and 1 = the first two lanes, 2–49 = extra lanes and hidden references. */
export type Slot = number;
/** A side of the compared pair: 0 = the track, 1 = the reference (any two slots, see `pair.ts`). */
export type ABSlot = 0 | 1;
export const SLOTS: ABSlot[] = [0, 1];
/** Engine slots; keep in step with `SLOTS` in player.rs. */
/** Engine slots (`player::SLOTS` in Rust): the most tracks loaded at once, references included. */
export const SLOT_COUNT = 50;
export const ALL_SLOTS: Slot[] = Array.from({ length: SLOT_COUNT }, (_, i) => i);
/** Engine slots the extra tracks can take. */
export const EXTRA_SLOTS: Slot[] = ALL_SLOTS.slice(2);
/** Labels in display order: the lanes' numbers, 1 to 50 (also the keys of their colours, `--lane-N`). */
export const SLOT_LABELS: readonly string[] = Array.from({ length: SLOT_COUNT }, (_, i) => String(i + 1));

export interface Peaks {
  buckets: number;
  min: number[];
  max: number[];
}

export interface TrackInfo {
  slot: Slot;
  path: string;
  name: string;
  sampleRate: number;
  channels: number;
  duration: number;
  peaks: Peaks;
  /** From the file's tags, when it has them. */
  title: string | null;
  artist: string | null;
  album: string | null;
  /** Absolute path of the album art thumbnail. */
  cover: string | null;
  /** The cover's colour ("#rrggbb"), used for the lane in place of its letter's; null without one. */
  accent: string | null;
  /** Identity of the decoded audio: markers follow it when the file is moved or renamed. */
  audioId: string;
}

export interface Transport {
  playing: boolean;
  active: Slot;
  /** Per slot: looping its selection. */
  loopEnabled: boolean[];
  /** Playhead per slot, in seconds. */
  positions: number[];
  /** Peak level per slot over the last audio buffer, linear; 0 when paused (for the meters). */
  levels: number[];
}

export interface AudioStatus {
  deviceRate: number | null;
  error: string | null;
}

/** Selected time range on a track, in seconds. */
export interface Region {
  start: number;
  end: number;
}

export interface LoudnessStats {
  integrated: number | null;
  range: number | null;
  momentaryMax: number | null;
  shortTermMax: number | null;
  samplePeak: number | null;
  truePeak: number | null;
  plr: number | null;
}

/** A measurement over time; point `i` is centred at `t0 + i * hop` seconds. `null` = no reading. */
export interface Curve {
  t0: number;
  hop: number;
  values: (number | null)[];
}

export interface LoudnessReport {
  stats: LoudnessStats;
  curves: { momentary: Curve; shortTerm: Curve } | null;
}

export interface DynamicsStats {
  crest: number | null;
  crestShortMedian: number | null;
  psrMedian: number | null;
  psrMin: number | null;
  dr: number | null;
  onsetRate: number | null;
  onsetRise: number | null;
  shortTermP10: number | null;
  shortTermP50: number | null;
  shortTermP95: number | null;
}

/** Fraction of time per bin; bin `i` covers `[min + i*step, min + (i+1)*step)`. */
export interface Histogram {
  min: number;
  step: number;
  fractions: number[];
}

export interface DynamicsReport {
  stats: DynamicsStats;
  shortTermHistogram: Histogram;
  crestHistogram: Histogram;
  psr: Curve | null;
}

export interface Band {
  name: string;
  low: number;
  high: number;
  /** Band energy relative to integrated loudness, dB. */
  level: number | null;
  /** Side − mid energy, dB (0 = as wide as uncorrelated L/R). */
  width: number | null;
}

export interface SpectrumReport {
  freqs: number[];
  /** Energy per 1/6 octave relative to integrated loudness, dB (pink noise is flat). */
  level: number[];
  width: (number | null)[];
  bands: Band[];
  centroid: number | null;
  tilt: number | null;
}

export interface StereoStats {
  mono: boolean;
  correlation: number | null;
  correlationP5: number | null;
  negativeFraction: number | null;
  sideToMid: number | null;
  balance: number | null;
}

export interface StereoReport {
  stats: StereoStats;
  /** Row-major density of (side, mid) positions, top = +mid, left = −side; max cell = 1. */
  goniometer: number[];
  goniometerSize: number;
  correlation: Curve | null;
}

/** Sonic fingerprint used to match tracks against the library; passed back as is. */
export interface Features {
  tonal: (number | null)[];
  dynamics: (number | null)[];
  stereo: (number | null)[];
}

export interface AnalysisReport {
  loudness: LoudnessReport;
  dynamics: DynamicsReport;
  spectrum: SpectrumReport;
  stereo: StereoReport;
  features: Features;
  /** Sharpness and roughness from hearing models, heard at matched loudness (75 dB SPL). */
  psycho: PsychoStats | null;
}

export interface PsychoStats {
  /** DIN 45692 sharpness, acum: median over 0.5 s blocks, and the sharpest 10 %. */
  sharpness: number | null;
  sharpnessP90: number | null;
  /** Daniel & Weber roughness, asper: median over 200 ms frames, and the roughest 10 %. */
  roughness: number | null;
  roughnessP90: number | null;
  /** Zwicker loudness at the listening level, sone (median). */
  loudness: number | null;
}

/** Where tracks sit within the library for one mix quality (see `standing.rs`). */
export interface LibraryStanding {
  key: string;
  label: string;
  unit: string;
  group: string;
  /** What a higher value means. */
  higher: string;
  /** Library values at 0, 5, …, 100 %. */
  quantiles: number[];
  /** Per given track (mix, reference): value and percentile 0–100. */
  values: (number | null)[];
  percentiles: (number | null)[];
  count: number;
}

export interface LibraryStatus {
  root: string;
  /** Tracks in the database with a fingerprint. */
  indexed: number;
  failed: number;
  scanning: boolean;
  /** Files to analyse in the current scan, and how many are done. */
  queued: number;
  done: number;
  error: string | null;
}

export interface LibraryTrack {
  path: string;
  /** Path below the library folder. */
  relPath: string;
  duration: number;
  summary: { integrated: number | null; dr: number | null; tilt: number | null; correlation: number | null } | null;
  /** From the file's tags, when it has them. */
  title: string | null;
  artist: string | null;
  album: string | null;
  /** Absolute path of the album art thumbnail. */
  cover: string | null;
  /** Other files with the same audio, folded into this entry. */
  copies: string[];
}

export interface LibraryMatch extends LibraryTrack {
  /** Similarity 0–100, overall and per aspect. */
  score: number;
  tonal: number | null;
  dynamics: number | null;
  stereo: number | null;
}

/** A timestamped note on a file, kept across sessions. */
export interface Marker {
  /** Seconds from the start. */
  time: number;
  note: string;
}

/** A lane's song: its versions (file paths), the one in front (heard, analysed, shown) and the
 *  name given to the song ("" = none: the front version's title is shown). */
export interface LaneVersions {
  name: string;
  versions: string[];
  front: number;
  /** The versions play loudness-matched (each turned down to the quietest); left out when off. */
  matchLoudness?: boolean;
  /** The song's own reference tracks (file paths): while it's the current track, it's compared
   *  with the one in use instead of the pinned reference. Left out when there are none. */
  references?: string[];
  /** The reference in use; left out when it's the first. */
  referenceFront?: number;
  /** In a saved session: compared with another lane (its index) instead of its own references. */
  compareLane?: number;
  /** In a saved session: compared with the session's default reference even though it has its own. */
  compareDefault?: boolean;
  /** The colour picked for the song ("#rrggbb"); left out for its automatic one (its cover's, else
   *  its engine slot's hue), so it keeps its colour wherever its lane is moved. */
  color?: string;
}

/** Saved lanes, in order (`sessions.rs`). */
export interface Session {
  path: string;
  /** The file's name without extension. */
  name: string;
  lanes: LaneVersions[];
  /** Compared with by every song without a reference of its own. */
  defaultReference: string | null;
  /** Files not at their saved path, found elsewhere (renamed or moved); the session was re-saved with them. */
  relinked: { from: string; to: string }[];
}

export interface RecentSession {
  path: string;
  name: string;
  /** Number of lanes when last saved or opened. */
  tracks: number;
  /** Unix seconds. */
  used: number;
}

/** Headless Deemix (Deezer search and downloads) state. */
export interface DeezerStatus {
  /** This build includes Deezer downloads. */
  available: boolean;
  /** Deemix is installed (at `location`). */
  installed: boolean;
  /** Where Deemix is looked for. */
  location: string | null;
  loggedIn: boolean;
  user: string | null;
  /** The account can download FLAC. */
  lossless: boolean;
}

export interface DeezerTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  albumId: number;
  duration: number;
  cover: string | null;
}

export type DownloadKind = "track" | "album";

export interface DownloadItem {
  uuid: string;
  kind: DownloadKind;
  id: number;
  title: string;
  artist: string;
  /** Tracks in the item, and how many are downloaded or failed. */
  size: number;
  downloaded: number;
  failed: number;
  /** 0–100. */
  progress: number;
  status: "inQueue" | "downloading" | "completed" | "withErrors" | "failed";
  /** Files written, once finished; an album has one per track. */
  files: { trackId: number; path: string }[];
}

/** Relative weight of tonal, dynamics and stereo distances. */
export type MatchWeights = [number, number, number];

export type FilterKind = "peak" | "lowShelf" | "highShelf";
/** What a move acts on: both channels alike, or only the side (L − R). */
export type Placement = "stereo" | "side";

export interface EqFilter {
  kind: FilterKind;
  freq: number;
  gain: number;
  q: number;
  /** Absent means stereo. */
  placement?: Placement;
}

export interface EqReport {
  /** Moves for A to approach B, largest effect first. */
  suggestions: EqFilter[];
  /** What A needs (B − A, smoothed, level offset removed), dB per grid point. */
  target: (number | null)[];
  /** Combined response of the suggestions, dB per grid point. */
  curve: number[];
  offset: number;
  errorBefore: number;
  errorAfter: number;
}

/** What is left of the side's difference after the stereo moves (see `eq.rs`). */
export interface SideReport {
  /** Broadband side change (wider/narrower overall), as a side high shelf at 10 Hz. */
  width: EqFilter | null;
  /** Side-only moves, largest effect first. */
  suggestions: EqFilter[];
  /** What A's side needs (B − A side, smoothed, same offset removed), dB per grid point. */
  target: (number | null)[];
  /** Weighted RMS of the side target left after the stereo moves, and after the side moves too. */
  errorBefore: number;
  errorAfter: number;
}

/** Matchering-style correction: the smoothed difference itself, not reduced to moves. */
export interface FullMatch {
  /** dB per grid point, for the combined signal, mid and side. */
  total: number[];
  mid: number[];
  side: number[];
  /** Weighted RMS between the full match and the moves, dB (total, and side). */
  gap: number;
  sideGap: number | null;
}

export interface MatchReport extends EqReport {
  /** Null when either track is mono. */
  side: SideReport | null;
  full: FullMatch;
}

/** Export as Zip's encodings: 24-bit WAV, 24-bit FLAC, 320 kb/s MP3. */
export type ZipFormat = "wav" | "flac" | "mp3";

/** A cover as Export as Zip shows it: a small JPEG data URL and the size it's embedded at. */
export interface CoverPreview {
  url: string;
  width: number;
  height: number;
}

/** One file of an Export as Zip, in track order. */
export interface ZipItem {
  /** The audio file. */
  source: string;
  /** File name in the archive, without extension. */
  name: string;
  /** Title tag. */
  title: string;
}

/** Per-band share of the moment's energy over time (masking view). */
export interface BandActivity {
  /** Band edges, Hz. */
  bands: [number, number][];
  /** Cell `i` is centred at `t0 + i * hop` seconds. */
  t0: number;
  hop: number;
  /** `levels[band][cell]`: dB relative to the surrounding 3 s; null = silence. */
  levels: (number | null)[][];
}

/** Spectrogram rows are log-spaced over this range (see `spectrogram.rs`). */
export const SPECTROGRAM_HZ = [30, 20000] as const;
/** Spectrogram bytes map linearly from this level (0) to 0 dB (255). */
export const SPECTROGRAM_FLOOR_DB = -120;

/** As `library::EXTENSIONS` in Rust. */
export const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "wave", "aif", "aiff", "aifc", "m4a", "aac"];

export const isAudioFile = (path: string) =>
  AUDIO_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");

export const SESSION_EXTENSION = "abnormal";

export const isSessionFile = (path: string) => path.split(".").pop()?.toLowerCase() === SESSION_EXTENSION;

export const api = {
  audioStatus: () => invoke<AudioStatus>("audio_status"),
  /** Files opened from Finder or Explorer since the last call. */
  takeOpenedFiles: () => invoke<string[]>("take_opened_files"),
  /** Load a file into a slot, playing from `at` seconds (a prepared version swaps in at once). */
  loadTrack: (slot: Slot, path: string, at: number | null = null) => invoke<TrackInfo>("load_track", { slot, path, at }),
  /** Keep these files prepared for switching (decoded and analysed in the background); each one
   *  ready is announced as a `version-prepared` event. Returns the ones already ready. */
  prepareVersions: (paths: string[]) => invoke<string[]>("prepare_versions", { paths }),
  /** Integrated loudness (LUFS) of prepared versions; null where not measured yet (or silent). */
  versionLoudness: (paths: string[]) => invoke<(number | null)[]>("version_loudness", { paths }),
  unloadTrack: (slot: Slot) => invoke<void>("unload_track", { slot }),
  setPlaying: (playing: boolean) => invoke<void>("set_playing", { playing }),
  setActive: (slot: Slot) => invoke<void>("set_active", { slot }),
  seek: (slot: Slot, seconds: number) => invoke<void>("seek", { slot, seconds }),
  setLoop: (slot: Slot, region: Region | null) =>
    invoke<void>("set_loop", { slot, region: region ? [region.start, region.end] : null }),
  /** Loop a track's selection (or stop). */
  setLoopEnabled: (slot: Slot, enabled: boolean) => invoke<void>("set_loop_enabled", { slot, enabled }),
  transport: () => invoke<Transport>("transport"),
  analyze: (slot: Slot, region: Region | null, curves: boolean) =>
    invoke<AnalysisReport>("analyze", {
      slot,
      range: region ? [region.start, region.end] : null,
      curves,
    }),
  rangePeaks: (slot: Slot, start: number, end: number, buckets: number) =>
    invoke<Peaks>("range_peaks", { slot, start, end, buckets }),
  setTrims: (db: number[]) => invoke<void>("set_trims", { db }),
  /** App-wide output volume, linear 0–1. */
  /** Player mode: tracks play one after another in `order` (lane order) instead of together. */
  setPlayerMode: (on: boolean, order: Slot[]) => invoke<void>("set_player_mode", { on, order }),
  /** A track's markers: found by its audio, else by its path (a re-bounce over the same file). */
  markers: (audioId: string, path: string) => invoke<Marker[]>("markers", { audioId, path }),
  saveMarkers: (audioId: string, path: string, markers: Marker[]) => invoke<void>("save_markers", { audioId, path, markers }),
  /** Save the lanes (in order, with their versions) as a session; also remembered as recent. */
  saveSession: (path: string, lanes: LaneVersions[], defaultReference: string | null) =>
    invoke<Session>("save_session", { path, lanes, defaultReference }),
  openSession: (path: string) => invoke<Session>("open_session", { path }),
  /** The example session bundled with the app (its `path` is empty: it's saved elsewhere). */
  exampleSession: () => invoke<Session>("example_session"),
  recentSessions: () => invoke<RecentSession[]>("recent_sessions"),
  clearRecentSessions: () => invoke<void>("clear_recent_sessions"),
  /** Write the notes recap to a .md file. */
  writeNotes: (path: string, contents: string) => invoke<void>("write_notes", { path, contents }),
  setVolume: (gain: number) => invoke<void>("set_volume", { gain }),
  setEq: (slot: Slot, filters: EqFilter[], enabled: boolean) => invoke<void>("set_eq", { slot, filters, enabled }),
  /** Spectrum of the ~0.4 s up to `seconds` on a track, normalised by its loudness like the long-term one; null if silent. */
  liveSpectrum: (slot: Slot, seconds: number, integrated: number | null) =>
    invoke<number[] | null>("live_spectrum", { slot, seconds, integrated }),
  /** `rows × columns` bytes, row 0 = highest frequency. */
  spectrogram: (slot: Slot, start: number, end: number, columns: number, rows: number) =>
    invoke<ArrayBuffer>("spectrogram", { slot, start, end, columns, rows }).then((b) => new Uint8Array(b)),
  bandActivity: (slot: Slot, region: Region | null) =>
    invoke<BandActivity>("band_activity", { slot, range: region ? [region.start, region.end] : null }),
  /** EQ match of the track towards the reference (`slots`), over each one's range (null = whole track). */
  matchEq: (slots: [Slot, Slot], ranges: [Region | null, Region | null], loudest: boolean) =>
    invoke<MatchReport>("match_eq", { slots, ranges: ranges.map((r) => (r ? [r.start, r.end] : null)), loudest }),
  /** Render a track's playback through full-match curves (null drops it); false if overtaken. */
  renderFullMatch: (slot: Slot, curves: { mid: number[]; side: number[] } | null) =>
    invoke<boolean>("render_full_match", { slot, curves }),
  setFullMatch: (slot: Slot, enabled: boolean) => invoke<void>("set_full_match", { slot, enabled }),
  /** Write the files into one zip at `path`, tagged with `artist` and `album` (and their title
   *  and track number); a `zip-progress` event carries the number of files done. */
  /** `cover`: an image, or an audio file whose own cover is used; embedded in FLAC and MP3. */
  exportZip: (path: string, items: ZipItem[], format: ZipFormat, artist: string, album: string, cover: string | null) =>
    invoke<void>("export_zip", { path, items, format, artist, album, cover }),
  /** What a cover (an image, or an audio file's own cover) looks like, for Export as Zip. */
  coverPreview: (path: string) => invoke<CoverPreview>("cover_preview", { path }),
  /** The user's Pro-Q 4 "Default Setting" preset text, if any. */
  proQTemplate: () => invoke<string | null>("pro_q_template"),
  libraryStatus: () => invoke<LibraryStatus>("library_status"),
  rescanLibrary: () => invoke<void>("rescan_library"),
  /** Make `path` the library folder (and where Deezer downloads go), and index it. */
  setLibraryFolder: (path: string) => invoke<LibraryStatus>("set_library_folder", { path }),
  /** Percentiles of the given tracks within the library; `near` limits it to the closest tracks. */
  libraryStanding: (tracks: ({ features: Features; integrated: number | null } | null)[], near: number | null) =>
    invoke<LibraryStanding[]>("library_standing", { tracks, near }),
  similarTracks: (features: Features, exclude: string[], weights: MatchWeights, limit: number) =>
    invoke<LibraryMatch[]>("similar_tracks", { features, exclude, weights, limit }),
  searchLibrary: (query: string, limit: number) => invoke<LibraryTrack[]>("search_library", { query, limit }),
  deezerConnect: () => invoke<DeezerStatus>("deezer_connect"),
  deezerLogin: (arl: string) => invoke<DeezerStatus>("deezer_login", { arl }),
  deezerSearch: (query: string, limit: number) => invoke<DeezerTrack[]>("deezer_search", { query, limit }),
  deezerDownload: (kind: DownloadKind, id: number) => invoke<void>("deezer_download", { kind, id }),
  deezerQueue: () => invoke<DownloadItem[]>("deezer_queue"),
};
