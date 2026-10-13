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
