import type { AnalysisReport } from "./api";

export type Tab = "loudness" | "dynamics" | "tonal" | "stereo" | "eq" | "similar";

/** Streaming platforms commonly ask for a true-peak ceiling of −1 dBTP. */
export const TRUE_PEAK_CEILING = -1;

export interface Row {
  label: string;
  unit: string;
  hint: string;
  get: (r: AnalysisReport) => number | null;
  /** Decimals for values and Δ (default 1). */
  digits?: number;
  /** Custom display for values (Δ still uses `digits`). */
  format?: (v: number) => string;
  warn?: (v: number) => string | null;
}

export type Section = { heading?: string; rows: Row[] };

/** Band names in the order the backend reports them. */
export const BANDS = ["Sub", "Bass", "Low-mid", "Mid", "Upper-mid", "Presence", "Air"];
export const BAND_RANGES = ["20–60 Hz", "60–250 Hz", "250–500 Hz", "500 Hz–2 kHz", "2–4 kHz", "4–8 kHz", "8–20 kHz"];

const LOUDNESS: Section[] = [
  {
    rows: [
      { label: "Integrated", unit: "LUFS", hint: "Gated average loudness over the range (BS.1770-4)", get: (r) => r.loudness.stats.integrated },
      { label: "Max short-term", unit: "LUFS", hint: "Loudest 3 s window", get: (r) => r.loudness.stats.shortTermMax },
      { label: "Max momentary", unit: "LUFS", hint: "Loudest 400 ms window", get: (r) => r.loudness.stats.momentaryMax },
      { label: "Loudness range", unit: "LU", hint: "LRA (EBU Tech 3342): spread of short-term loudness, 10th–95th percentile", get: (r) => r.loudness.stats.range },
      {
        label: "True peak",
        unit: "dBTP",
        hint: "Inter-sample peak, 4× oversampled",
        get: (r) => r.loudness.stats.truePeak,
        warn: (v) => (v > TRUE_PEAK_CEILING ? `Above ${TRUE_PEAK_CEILING} dBTP` : null),
      },
      { label: "Sample peak", unit: "dBFS", hint: "Highest sample value", get: (r) => r.loudness.stats.samplePeak },
      { label: "PLR", unit: "LU", hint: "Peak-to-loudness ratio: true peak − integrated. Lower means more limited.", get: (r) => r.loudness.stats.plr },
    ],
  },
];

const DYNAMICS: Section[] = [
  {
    heading: "Micro · transients",
    rows: [
      { label: "Crest factor", unit: "dB", hint: "Peak / RMS over the whole range. A sine is 3 dB; heavily limited masters sit around 8–10 dB.", get: (r) => r.dynamics.stats.crest },
      { label: "Crest, 50 ms", unit: "dB", hint: "Median crest factor of 50 ms windows: how much peaks stand out locally", get: (r) => r.dynamics.stats.crestShortMedian },
      { label: "PSR median", unit: "LU", hint: "Peak-to-short-term-loudness ratio: true peak in each 3 s window − its loudness. Below ~8 sounds squashed.", get: (r) => r.dynamics.stats.psrMedian },
      { label: "PSR min", unit: "LU", hint: "Most compressed 3 s window", get: (r) => r.dynamics.stats.psrMin },
      { label: "Onsets", unit: "/s", hint: "Detected attacks per second (≥ 6 dB level jumps on a 10 ms envelope)", get: (r) => r.dynamics.stats.onsetRate },
      { label: "Attack rise", unit: "dB", hint: "Mean level jump at onsets: how hard transients pop out of what precedes them", get: (r) => r.dynamics.stats.onsetRise },
    ],
  },
  {
    heading: "Macro · sections",
    rows: [
      {
        label: "DR score",
        unit: "DR",
        hint: "TT Dynamic Range (as foobar2000's DR Meter): 2nd-highest peak vs. RMS of the loudest 20% of 3 s blocks",
        // DR is conventionally quoted as a whole number; Δ follows so the columns add up.
        get: (r) => (r.dynamics.stats.dr === null ? null : Math.round(r.dynamics.stats.dr)),
        digits: 0,
      },
      { label: "Loudness range", unit: "LU", hint: "LRA (EBU Tech 3342)", get: (r) => r.loudness.stats.range },
      { label: "Short-term P95", unit: "LUFS", hint: "Loud sections: 95th percentile of short-term loudness", get: (r) => r.dynamics.stats.shortTermP95 },
      { label: "Short-term P50", unit: "LUFS", hint: "Median short-term loudness", get: (r) => r.dynamics.stats.shortTermP50 },
      { label: "Short-term P10", unit: "LUFS", hint: "Quiet sections: 10th percentile of short-term loudness", get: (r) => r.dynamics.stats.shortTermP10 },
    ],
  },
];

const TONAL: Section[] = [
  {
    rows: [
      {
        label: "Centroid",
        unit: "Hz",
        hint: "Energy-weighted mean frequency: higher sounds brighter",
        get: (r) => r.spectrum.centroid,
        digits: 0,
      },
      {
        label: "Tilt",
        unit: "dB/oct",
        hint: "Slope of the spectrum from 50 Hz to 16 kHz (pink noise = 0). More negative is darker.",
        get: (r) => r.spectrum.tilt,
      },
    ],
  },
  {
    heading: "Band energy · dB re loudness",
    rows: BANDS.map((name, i) => ({
      label: name,
      unit: BAND_RANGES[i],
      hint: `Energy in ${BAND_RANGES[i]} relative to integrated loudness, so Δ compares tracks at equal loudness`,
      get: (r: AnalysisReport) => r.spectrum.bands[i]?.level ?? null,
    })),
  },
];

const STEREO: Section[] = [
  {
    rows: [
      {
        label: "Correlation",
        unit: "",
        hint: "Phase correlation, +1 = mono, 0 = fully decorrelated, below 0 = out of phase",
        get: (r) => r.stereo.stats.correlation,
        digits: 2,
      },
      {
        label: "Worst 5%",
        unit: "",
        hint: "5th percentile of 400 ms correlation: the least mono-compatible moments",
        get: (r) => r.stereo.stats.correlationP5,
        digits: 2,
        warn: (v) => (v < 0 ? "Out of phase at times: check mono compatibility" : null),
      },
      {
        label: "Out of phase",
        unit: "% time",
        hint: "Share of time with negative correlation",
        get: (r) => (r.stereo.stats.negativeFraction === null ? null : r.stereo.stats.negativeFraction * 100),
      },
      {
        label: "Side / mid",
        unit: "dB",
        hint: "Side energy relative to mid. 0 dB = as wide as uncorrelated L/R; very negative = near mono",
        get: (r) => r.stereo.stats.sideToMid,
      },
      {
        label: "Balance L − R",
        unit: "dB",
        hint: "Left energy relative to right; positive leans left",
        get: (r) => r.stereo.stats.balance,
      },
    ],
  },
  {
    heading: "Width by band · side − mid dB",
    rows: BANDS.map((name, i) => ({
      label: name,
      unit: BAND_RANGES[i],
      hint: `Side − mid energy in ${BAND_RANGES[i]}. Low bands are usually kept narrow.`,
      get: (r: AnalysisReport) => r.spectrum.bands[i]?.width ?? null,
    })),
  },
];

/** Metric tables per tab; the EQ and Similar tabs have their own views. */
export const SECTIONS: Record<Exclude<Tab, "eq" | "similar">, Section[]> = { loudness: LOUDNESS, dynamics: DYNAMICS, tonal: TONAL, stereo: STEREO };

/** "+1.2", "−", etc. Values in tables and reports share this format. */
export const fmt = (v: number | null | undefined, digits = 1, signed = false) =>
  v === null || v === undefined ? "—" : `${signed && v > 0 ? "+" : ""}${v.toFixed(digits)}`;

/** Display a row value: custom format, else fixed digits. */
export const showValue = (row: Row, v: number | null) => (v === null ? "—" : row.format ? row.format(v) : fmt(v, row.digits));
