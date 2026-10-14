import { invoke } from "@tauri-apps/api/core";

export type Slot = 0 | 1;
export const SLOTS: Slot[] = [0, 1];
export const SLOT_LABELS = ["A", "B"] as const;

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
}

export interface Transport {
  playing: boolean;
  active: Slot;
  loopEnabled: boolean;
  positions: [number, number];
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

/** A song part from the structure model (All-In-One). */
export interface StructureSegment {
  start: number;
  end: number;
  /** "start" / "end" (silence), "intro", "verse", "chorus", "bridge", "inst", "solo", "break", "outro". */
  label: string;
}

export interface SongStructure {
  bpm: number | null;
  beats: number[];
  /** First beat of each bar. */
  downbeats: number[];
  beatPositions: number[];
  segments: StructureSegment[];
  /** The segments are the user's corrections rather than what was detected. */
  edited: boolean;
}

export interface StructureSetup {
  installed: boolean;
  installing: boolean;
  step: string | null;
  error: string | null;
}

/** `structure` event: an analysis finished (or failed). */
export interface StructureOutcome {
  path: string;
  structure: SongStructure | null;
  error: string | null;
}

/** Headless Deemix (Deezer search and downloads) state. */
export interface DeezerStatus {
  /** Deemix is in /Applications. */
  installed: boolean;
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

/** A detected song section; sections with the same label sound alike. */
export interface Section {
  start: number;
  end: number;
  /** 0 = first kind of section heard, 1 = the next new one, … */
  label: number;
  /** Mean power relative to the whole track, dB. */
  level: number;
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

export const AUDIO_EXTENSIONS = ["mp3", "flac", "wav"];

export const isAudioFile = (path: string) =>
  AUDIO_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");

export const api = {
  audioStatus: () => invoke<AudioStatus>("audio_status"),
  /** Files opened from Finder since the last call. */
  takeOpenedFiles: () => invoke<string[]>("take_opened_files"),
  loadTrack: (slot: Slot, path: string) => invoke<TrackInfo>("load_track", { slot, path }),
  unloadTrack: (slot: Slot) => invoke<void>("unload_track", { slot }),
  setPlaying: (playing: boolean) => invoke<void>("set_playing", { playing }),
  setActive: (slot: Slot) => invoke<void>("set_active", { slot }),
  seek: (slot: Slot, seconds: number) => invoke<void>("seek", { slot, seconds }),
  setLoop: (slot: Slot, region: Region | null) =>
    invoke<void>("set_loop", { slot, region: region ? [region.start, region.end] : null }),
  setLoopEnabled: (enabled: boolean) => invoke<void>("set_loop_enabled", { enabled }),
  transport: () => invoke<Transport>("transport"),
  analyze: (slot: Slot, region: Region | null, curves: boolean) =>
    invoke<AnalysisReport>("analyze", {
      slot,
      range: region ? [region.start, region.end] : null,
      curves,
    }),
  rangePeaks: (slot: Slot, start: number, end: number, buckets: number) =>
    invoke<Peaks>("range_peaks", { slot, start, end, buckets }),
  setTrims: (db: [number, number]) => invoke<void>("set_trims", { db }),
  /** App-wide output volume, linear 0–1. */
  setVolume: (gain: number) => invoke<void>("set_volume", { gain }),
  setEq: (slot: Slot, filters: EqFilter[], enabled: boolean) => invoke<void>("set_eq", { slot, filters, enabled }),
  /** `rows × columns` bytes, row 0 = highest frequency. */
  spectrogram: (slot: Slot, start: number, end: number, columns: number, rows: number) =>
    invoke<ArrayBuffer>("spectrogram", { slot, start, end, columns, rows }).then((b) => new Uint8Array(b)),
  sections: (slot: Slot) => invoke<Section[]>("sections", { slot }),
  bandActivity: (slot: Slot, region: Region | null) =>
    invoke<BandActivity>("band_activity", { slot, range: region ? [region.start, region.end] : null }),
  /** EQ match of A towards B over each track's range (null = whole track). */
  matchEq: (ranges: [Region | null, Region | null], loudest: boolean) =>
    invoke<MatchReport>("match_eq", { ranges: ranges.map((r) => (r ? [r.start, r.end] : null)), loudest }),
  /** Render A's playback through full-match curves (null drops it); false if overtaken. */
  renderFullMatch: (slot: Slot, curves: { mid: number[]; side: number[] } | null) =>
    invoke<boolean>("render_full_match", { slot, curves }),
  setFullMatch: (slot: Slot, enabled: boolean) => invoke<void>("set_full_match", { slot, enabled }),
  /** The user's Pro-Q 4 "Default Setting" preset text, if any. */
  proQTemplate: () => invoke<string | null>("pro_q_template"),
  libraryStatus: () => invoke<LibraryStatus>("library_status"),
  rescanLibrary: () => invoke<void>("rescan_library"),
  similarTracks: (features: Features, exclude: string[], weights: MatchWeights, limit: number) =>
    invoke<LibraryMatch[]>("similar_tracks", { features, exclude, weights, limit }),
  searchLibrary: (query: string, limit: number) => invoke<LibraryTrack[]>("search_library", { query, limit }),
  structureStatus: () => invoke<StructureSetup>("structure_status"),
  structureInstall: () => invoke<void>("structure_install"),
  /** Cached structure, or null (then it's queued; the result comes as a `structure` event). */
  songStructure: (path: string) => invoke<SongStructure | null>("song_structure", { path }),
  saveStructureEdit: (path: string, segments: StructureSegment[]) =>
    invoke<SongStructure>("save_structure_edit", { path, segments }),
  resetStructureEdit: (path: string) => invoke<SongStructure | null>("reset_structure_edit", { path }),
  deezerConnect: () => invoke<DeezerStatus>("deezer_connect"),
  deezerLogin: (arl: string) => invoke<DeezerStatus>("deezer_login", { arl }),
  deezerSearch: (query: string, limit: number) => invoke<DeezerTrack[]>("deezer_search", { query, limit }),
  deezerDownload: (kind: DownloadKind, id: number) => invoke<void>("deezer_download", { kind, id }),
  deezerQueue: () => invoke<DownloadItem[]>("deezer_queue"),
};
