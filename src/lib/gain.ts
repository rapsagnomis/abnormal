import type { AnalysisReport, Curve } from "./api";

const shift = (v: number | null, db: number) => (v === null ? null : v + db);
const shiftCurve = (c: Curve, db: number): Curve => ({ ...c, values: c.values.map((v) => shift(v, db)) });

/**
 * A report as it would read with the track played `db` louder (normalizing): absolute levels
 * (loudness, peaks, short-term percentiles and their curves) move by `db`; everything relative
 * (loudness range, PLR, crest, PSR, DR, the spectrum relative to integrated loudness, stereo) is
 * unchanged. `features` stay as measured, so library matching is about the music, not the gain.
 */
export function withGain(r: AnalysisReport | null, db: number): AnalysisReport | null {
  if (!r || db === 0) return r;
  const l = r.loudness.stats;
  const d = r.dynamics.stats;
  return {
    ...r,
    loudness: {
      stats: {
        ...l,
        integrated: shift(l.integrated, db),
        momentaryMax: shift(l.momentaryMax, db),
        shortTermMax: shift(l.shortTermMax, db),
        samplePeak: shift(l.samplePeak, db),
        truePeak: shift(l.truePeak, db),
      },
      curves: r.loudness.curves && {
        momentary: shiftCurve(r.loudness.curves.momentary, db),
        shortTerm: shiftCurve(r.loudness.curves.shortTerm, db),
      },
    },
    dynamics: {
      ...r.dynamics,
      stats: {
        ...d,
        shortTermP10: shift(d.shortTermP10, db),
        shortTermP50: shift(d.shortTermP50, db),
        shortTermP95: shift(d.shortTermP95, db),
      },
      shortTermHistogram: { ...r.dynamics.shortTermHistogram, min: r.dynamics.shortTermHistogram.min + db },
    },
  };
}
