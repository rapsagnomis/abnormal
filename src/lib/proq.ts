import type { EqFilter } from "./api";

/**
 * FabFilter Pro-Q 4 presets, as text: the format of its .ffp files, which is also what its
 * instance menu copies to and pastes from the clipboard. An INI-like `[Preset]` header, then
 * `[Parameters]` with 24 band slots and the global settings.
 *
 * Encodings (checked against the presets Pro-Q 4 ships and saves):
 *   Frequency  log2(Hz)                      1 kHz = 9.9658
 *   Gain       dB
 *   Q          normalised on a log scale over Pro-Q's 0.025–40, so Q 1 = 0.5
 *   Shape      0 Bell, 1 Low Shelf, 2 Low Cut, 3 High Shelf, 4 High Cut, 5 Notch, …
 *   Stereo Placement 0 Left, 1 Right, 2 Stereo, 3 Mid, 4 Side
 */

const BANDS = 24;
const Q_MIN = 0.025;
const Q_MAX = 40;

const SHAPE: Record<EqFilter["kind"], number> = { peak: 0, lowShelf: 1, highShelf: 3 };
const PLACEMENT = { stereo: 2, side: 4 } as const;

export const proQFrequency = (hz: number) => Math.log2(hz);
export const proQQ = (q: number) => Math.log(Math.min(Q_MAX, Math.max(Q_MIN, q)) / Q_MIN) / Math.log(Q_MAX / Q_MIN);

/** A fresh band and the global settings, as Pro-Q 4 writes them: used when the user has no
 *  "Default Setting" preset to take them from. */
const BAND_DEFAULTS: [string, string][] = [
  ["Used", "0"],
  ["Enabled", "1"],
  ["Frequency", "9.96578407287598"],
  ["Gain", "0"],
  ["Q", "0.5"],
  ["Shape", "0"],
  ["Slope", "2"],
  ["Stereo Placement", "2"],
  ["Speakers", "1"],
  ["Dynamic Range", "0"],
  ["Dynamics Enabled", "1"],
  ["Dynamics Auto", "1"],
  ["Threshold", "0.666666686534882"],
  ["Attack", "50"],
  ["Release", "50"],
  ["External Side Chain", "0"],
  ["Side Chain Filtering", "0"],
  ["Side Chain Low Frequency", "3.32192802429199"],
  ["Side Chain High Frequency", "14.287712097168"],
  ["Side Chain Audition", "0"],
  ["Spectral Enabled", "0"],
  ["Spectral Density", "50"],
  ["Solo", "0"],
];
const GLOBAL_DEFAULTS: [string, string][] = [
  ["Processing Mode", "0"],
  ["Processing Resolution", "1"],
  ["Character", "0"],
  ["Gain Scale", "1"],
  ["Output Level", "0"],
  ["Output Pan", "0"],
  ["Output Pan Mode", "0"],
  ["Bypass", "0"],
  ["Output Invert Phase", "0"],
  ["Auto Gain", "0"],
  ["Analyzer Show Pre-Processing", "1"],
  ["Analyzer Show Post-Processing", "1"],
  ["Analyzer Show External Spectrum", "1"],
  ["Analyzer External Spectrum", "-1"],
  ["Analyzer Range", "2"],
  ["Analyzer Resolution", "3"],
  ["Analyzer Speed", "2"],
  ["Analyzer Tilt", "0"],
  ["Analyzer Freeze", "0"],
  ["Analyzer Show Collisions", "0"],
  ["Spectrum Grab", "0"],
  ["Display Range", "2"],
  ["Receive Midi", "0"],
  ["Solo Gain", "0"],
];

function defaultParameters(): [string, string][] {
  const bands: [string, string][] = [];
  for (let i = 1; i <= BANDS; i++) for (const [k, v] of BAND_DEFAULTS) bands.push([`Band ${i} ${k}`, v]);
  return [...bands, ...GLOBAL_DEFAULTS];
}

/** The `[Parameters]` of a preset's text, in order. */
function parameters(template: string): [string, string][] {
  const body = template.split("[Parameters]")[1] ?? "";
  return body
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    });
}

/** Pro-Q's description field is quoted, with `\n` for line breaks. */
const quote = (text: string) => `"${text.replace(/"/g, "'").replace(/\n/g, "\\n")}"`;

/**
 * A Pro-Q 4 preset with `filters` as bands 1…n. Every other setting comes from `template`
 * (the user's "Default Setting" preset) when given, so their analyser and display preferences
 * carry over; the bands in it are cleared.
 */
export function proQPreset(filters: EqFilter[], name: string, description: string, template: string | null): string {
  const params = new Map(template ? parameters(template) : defaultParameters());
  if (!params.has("Band 1 Used")) for (const [k, v] of defaultParameters()) params.set(k, v);
  for (let i = 1; i <= BANDS; i++) params.set(`Band ${i} Used`, "0");
  filters.slice(0, BANDS).forEach((f, n) => {
    const band = (key: string, value: number | string) => params.set(`Band ${n + 1} ${key}`, String(value));
    band("Used", 1);
    band("Enabled", 1);
    band("Frequency", proQFrequency(f.freq));
    band("Gain", f.gain);
    band("Q", proQQ(f.q));
    band("Shape", SHAPE[f.kind]);
    band("Slope", 2);
    band("Stereo Placement", PLACEMENT[f.placement ?? "stereo"]);
    band("Speakers", 1);
    // A static EQ: no dynamics or spectral processing, whatever the template's band had.
    band("Dynamic Range", 0);
    band("Dynamics Enabled", 0);
    band("Spectral Enabled", 0);
    band("Solo", 0);
  });
  const header = [
    "[Preset]",
    "Signature=FQ4p",
    "Version=4",
    `Name=${name.replace(/[\r\n]/g, " ")}`,
    "Author=(a/b)normal",
    `Description=${quote(description)}`,
    "Tags=EQ Match",
  ];
  return [...header, "", "[Parameters]", ...[...params].map(([k, v]) => `${k}=${v}`), ""].join("\n");
}
