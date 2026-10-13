import type { BandActivity, EqFilter, Region } from "./api";

const LISTEN_SECONDS = 4;

/** Frequency range an EQ move acts on, Hz: a bell's bandwidth, or everything beyond a shelf. */
function rangeOf(f: EqFilter): [number, number] {
  if (f.kind === "lowShelf") return [20, f.freq];
  if (f.kind === "highShelf") return [f.freq, 20000];
  const octaves = (2 / Math.LN2) * Math.asinh(1 / (2 * f.q));
  const half = Math.pow(2, octaves / 2);
  return [f.freq / half, f.freq * half];
}

const median = (values: number[]) => {
  const v = [...values].sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

/**
 * The LISTEN_SECONDS of A where `move` matters most: where A's level in the move's range is
 * furthest from B's median in the direction the move corrects (below it for a boost, above it
 * for a cut). Null when A never strays that way.
 */
export function passageFor(move: EqFilter, a: BandActivity, b: BandActivity): Region | null {
  const [lo, hi] = rangeOf(move);
  const centre = (band: [number, number]) => Math.sqrt(band[0] * band[1]);
  let bands = a.bands.map((band, i) => [i, centre(band)] as const).filter(([, c]) => c >= lo && c <= hi).map(([i]) => i);
  if (bands.length === 0) {
    const nearest = a.bands.reduce((best, band, i) =>
      Math.abs(Math.log(centre(band) / move.freq)) < Math.abs(Math.log(centre(a.bands[best]) / move.freq)) ? i : best, 0);
    bands = [nearest];
  }
  const reference = bands.map((band) => median(b.levels[band].filter((x): x is number => x !== null)));
  const sign = move.gain > 0 ? 1 : -1;

  const cells = a.levels[0]?.length ?? 0;
  const perCell = Array.from({ length: cells }, (_, c) =>
    bands.reduce((s, band, k) => {
      const v = a.levels[band][c];
      const r = reference[k];
      return v === null || r === null ? s : s + Math.max(0, sign * (r - v));
    }, 0),
  );

  const width = Math.min(cells, Math.max(1, Math.round(LISTEN_SECONDS / a.hop)));
  let best = 0;
  let bestStart = -1;
  let sum = 0;
  for (let c = 0; c < cells; c++) {
    sum += perCell[c];
    if (c >= width) sum -= perCell[c - width];
    if (c >= width - 1 && sum > best) {
      best = sum;
      bestStart = c - width + 1;
    }
  }
  if (bestStart < 0) return null;
  const start = a.t0 - a.hop / 2 + bestStart * a.hop;
  return { start, end: start + width * a.hop };
}
