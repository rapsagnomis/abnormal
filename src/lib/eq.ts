import type { EqFilter } from "./api";
import { BANDS } from "./metrics";

const BAND_EDGES = [20, 60, 250, 500, 2000, 4000, 8000, 20000];

export const KIND_LABEL: Record<EqFilter["kind"], string> = {
  peak: "Bell",
  lowShelf: "Low shelf",
  highShelf: "High shelf",
};

export const formatHz = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`);

export const formatGain = (g: number) => `${g > 0 ? "+" : ""}${g.toFixed(1)} dB`;

function bandOf(freq: number) {
  const i = BAND_EDGES.findIndex((edge, k) => freq >= edge && freq < BAND_EDGES[k + 1]);
  return BANDS[Math.max(0, i)].toLowerCase();
}

/** Plain-language reading of a move, e.g. "More bass around 63 Hz" or "Less top end above 6 kHz". */
export function describe(f: EqFilter): string {
  const more = f.gain > 0 ? "More" : "Less";
  switch (f.kind) {
    case "lowShelf":
      return `${more} low end below ${formatHz(f.freq)}`;
    case "highShelf":
      return `${more} top end above ${formatHz(f.freq)}`;
    case "peak":
      return `${more} ${bandOf(f.freq)} around ${formatHz(f.freq)}`;
  }
}

/** One line per move, for the clipboard and reports. */
export function eqAsText(filters: EqFilter[]): string {
  return filters
    .map((f, i) => `${i + 1}. ${KIND_LABEL[f.kind]} ${formatHz(f.freq)} ${formatGain(f.gain)} Q ${f.q.toFixed(1)} (${describe(f)})`)
    .join("\n");
}

/** Magnitude response in dB at `f` (analog RBJ prototypes; mirrors `Filter::response_db` in eq.rs). */
export function responseDb(filter: EqFilter, f: number): number {
  const a = Math.pow(10, filter.gain / 40);
  const w = f / filter.freq;
  const w2 = w * w;
  const q = filter.q;
  let mag2: number;
  if (filter.kind === "peak") {
    mag2 = ((1 - w2) ** 2 + ((w * a) / q) ** 2) / ((1 - w2) ** 2 + (w / (a * q)) ** 2);
  } else {
    const k = (w2 * a) / (q * q);
    mag2 =
      filter.kind === "lowShelf"
        ? (a * a * ((a - w2) ** 2 + k)) / ((1 - a * w2) ** 2 + k)
        : (a * a * ((1 - a * w2) ** 2 + k)) / ((a - w2) ** 2 + k);
  }
  return 10 * Math.log10(mag2);
}

/** Combined response of `filters` at each frequency, dB. */
export const curveOf = (filters: EqFilter[], freqs: number[]) =>
  freqs.map((f) => filters.reduce((sum, x) => sum + responseDb(x, f), 0));

/** Approximate BS.1770 K-weighting: +4 dB high shelf around 1.7 kHz and a 38 Hz high-pass. */
function kWeightDb(f: number): number {
  const shelf = responseDb({ kind: "highShelf", freq: 1681, gain: 4, q: Math.SQRT1_2 }, f);
  const w = f / 38;
  const hp = (w ** 4) / ((1 - w * w) ** 2 + (w / 0.5) ** 2);
  return shelf + 10 * Math.log10(hp);
}

/**
 * How much louder `filters` make a track with spectrum `level` (dB per grid point), in LU.
 * Used to level-compensate EQ playback so switching it on doesn't just sound louder.
 */
export function loudnessChange(freqs: number[], level: number[], filters: EqFilter[]): number {
  if (filters.length === 0) return 0;
  let before = 0;
  let after = 0;
  freqs.forEach((f, i) => {
    const p = Math.pow(10, (level[i] + kWeightDb(f)) / 10);
    before += p;
    after += p * Math.pow(10, filters.reduce((s, x) => s + responseDb(x, f), 0) / 10);
  });
  return before > 0 ? 10 * Math.log10(after / before) : 0;
}
