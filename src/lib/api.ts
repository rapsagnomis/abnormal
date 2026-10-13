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

export interface AnalysisReport {
  loudness: LoudnessReport;
  dynamics: DynamicsReport;
  spectrum: SpectrumReport;
  stereo: StereoReport;
}

export type FilterKind = "peak" | "lowShelf" | "highShelf";

export interface EqFilter {
  kind: FilterKind;
  freq: number;
  gain: number;
  q: number;
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

export const AUDIO_EXTENSIONS = ["mp3", "flac", "wav"];

export const isAudioFile = (path: string) =>
  AUDIO_EXTENSIONS.includes(path.split(".").pop()?.toLowerCase() ?? "");

export const api = {
  audioStatus: () => invoke<AudioStatus>("audio_status"),
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
  suggestEq: (track: number[], reference: number[]) => invoke<EqReport>("suggest_eq", { track, reference }),
  writeTextFile: (path: string, contents: string) => invoke<void>("write_text_file", { path, contents }),
};
