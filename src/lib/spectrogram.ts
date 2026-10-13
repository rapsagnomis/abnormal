import { SPECTROGRAM_FLOOR_DB, SPECTROGRAM_HZ } from "./api";

/** Displayed dynamic range below the track's ceiling, dB. */
export const SPECTROGRAM_RANGE_DB = 66;

/** Sequential ramp, dark (quiet) → light (loud), one hue so magnitude reads as lightness. */
const RAMP = ["#121417", "#0d2747", "#104281", "#1c5cab", "#2a78d6", "#5598e7", "#9ec5f4", "#e6f0fd"];

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** 256-entry RGB lookup over the ramp. */
const LUT: Uint8Array = (() => {
  const stops = RAMP.map(rgb);
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const pos = (i / 255) * (stops.length - 1);
    const k = Math.min(Math.floor(pos), stops.length - 2);
    const t = pos - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(stops[k][c] * (1 - t) + stops[k + 1][c] * t);
  }
  return lut;
})();

export const byteToDb = (b: number) => SPECTROGRAM_FLOOR_DB + (b / 255) * -SPECTROGRAM_FLOOR_DB;

/** Byte level near the top of the track's distribution, used as its display ceiling. */
export function ceilingOf(data: Uint8Array): number {
  const counts = new Array<number>(256).fill(0);
  for (const v of data) counts[v]++;
  let seen = 0;
  for (let v = 255; v >= 0; v--) {
    seen += counts[v];
    if (seen >= data.length * 0.002) return v;
  }
  return 255;
}

/** Colour a `rows × columns` byte image into a canvas, mapping [ceiling − range, ceiling]. */
export function renderSpectrogram(data: Uint8Array, columns: number, rows: number, ceiling: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = rows;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(columns, rows);
  const span = (SPECTROGRAM_RANGE_DB / -SPECTROGRAM_FLOOR_DB) * 255;
  const floor = ceiling - span;
  for (let i = 0; i < data.length; i++) {
    const t = Math.min(255, Math.max(0, Math.round(((data[i] - floor) / span) * 255)));
    img.data[i * 4] = LUT[t * 3];
    img.data[i * 4 + 1] = LUT[t * 3 + 1];
    img.data[i * 4 + 2] = LUT[t * 3 + 2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Vertical position (0 = top, 1 = bottom) of frequency `f` on the spectrogram's log axis. */
export function freqToY(f: number): number {
  const [lo, hi] = SPECTROGRAM_HZ;
  return 1 - Math.log(f / lo) / Math.log(hi / lo);
}
