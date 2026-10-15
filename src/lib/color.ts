/** Colour helpers for deriving palettes from a track's cover colour. */

/** "#rrggbb" → hue (degrees), saturation and lightness (0–1). */
function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const hsl = (h: number, s: number, l: number) => `hsl(${((h % 360) + 360) % 360} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;

/**
 * Colours for a track's song-part labels (`--section-0` … `--section-7`), from its cover's dominant
 * colours. With two, labels alternate between the two colour families (A, B, A, B…), each stepping
 * a little in hue (±15° at most) and in lightness, so consecutive parts always change family and
 * the strip reads as the cover's palette. With one, a variation on it alone: narrow hue steps
 * either side (±45° at most) with alternating lightness.
 */
export function partPalette(colors: string[]): string[] {
  const clampSat = (s: number) => Math.min(0.72, Math.max(0.42, s));
  if (colors.length >= 2) {
    const [a, b] = colors.slice(0, 2).map(toHsl);
    // [family, hue step, lightness]
    const steps: [0 | 1, number, number][] = [
      [0, 0, 0.56],
      [1, 0, 0.52],
      [0, 12, 0.42],
      [1, -12, 0.64],
      [0, -12, 0.68],
      [1, 12, 0.42],
      [0, 0, 0.48],
      [1, 0, 0.6],
    ];
    return steps.map(([family, dh, l]) => {
      const [h, s] = family ? b : a;
      return hsl(h + dh, clampSat(s), l);
    });
  }
  const [h, s] = toHsl(colors[0]);
  // Narrow hue steps (±15° at most 45° out): mostly lightness tells neighbouring parts apart.
  const steps: [number, number][] = [
    [0, 0.56],
    [15, 0.44],
    [-15, 0.64],
    [30, 0.5],
    [-30, 0.4],
    [0, 0.7],
    [45, 0.58],
    [-45, 0.48],
  ];
  return steps.map(([dh, l]) => hsl(h + dh, clampSat(s), l));
}
