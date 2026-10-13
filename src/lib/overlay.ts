import type { AnalysisReport, Curve } from "./api";

export type CurveMode = "off" | "momentary" | "shortTerm" | "psr" | "correlation";

/** A curve drawn over the waveform on its own vertical scale. */
export interface Overlay {
  curve: Curve;
  /** Value at the top and bottom of the lane. */
  top: number;
  bottom: number;
  grid: number[];
  /** Dashed reference line (e.g. integrated loudness, median PSR). */
  reference: number | null;
}

const LUFS_AXIS = { top: 0, bottom: -42, grid: [-6, -12, -18, -24, -30, -36] };
const PSR_AXIS = { top: 24, bottom: 0, grid: [4, 8, 12, 16, 20] };
const CORRELATION_AXIS = { top: 1, bottom: -1, grid: [0.5, 0, -0.5] };

/**
 * Build the overlay for a lane. Curves always come from the full-track analysis; the reference
 * line follows the panel's scope (full track or selection).
 */
export function overlayFor(
  mode: CurveMode,
  full: AnalysisReport | null,
  shown: AnalysisReport | null,
): Overlay | null {
  if (mode === "off" || !full) return null;
  if (mode === "correlation") {
    const curve = full.stereo.correlation;
    return curve && { curve, ...CORRELATION_AXIS, reference: shown?.stereo.stats.correlation ?? null };
  }
  if (mode === "psr") {
    const curve = full.dynamics.psr;
    return curve && { curve, ...PSR_AXIS, reference: shown?.dynamics.stats.psrMedian ?? null };
  }
  const curve = full.loudness.curves?.[mode];
  return curve ? { curve, ...LUFS_AXIS, reference: shown?.loudness.stats.integrated ?? null } : null;
}
