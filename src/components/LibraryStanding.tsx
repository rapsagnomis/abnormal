import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../lib/api";
import type { AnalysisReport, LibraryStanding as Standing, LibraryStatus } from "../lib/api";
import { usePair } from "../lib/pair";
import { Glide } from "./Glide";

/** How many of the closest-sounding tracks the "Closest" scope compares with. */
const NEAR = 50;
/** While indexing, refresh every this many newly indexed tracks. */
const REFRESH_EVERY = 100;

/** 92 → "92nd", 11 → "11th". */
const ordinal = (p: number) => {
  const n = Math.round(p);
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
};
const formatValue = (v: number, unit: string) => `${unit === "dB" && v > 0 ? "+" : ""}${v.toFixed(unit === "" ? 2 : 1)}${unit ? ` ${unit}` : ""}`;

/**
 * Where the mix and the reference sit within the library, per mix quality: each strip runs from the
 * library's lowest (0) to highest (100) percentile, the middle half shaded, with a marker per track.
 */
export function LibraryStanding({ reports, status }: { reports: [AnalysisReport | null, AnalysisReport | null]; status: LibraryStatus | null }) {
  const [near, setNear] = useState(false);
  const [rows, setRows] = useState<Standing[] | null>(null);
  const { labels } = usePair();
  const indexedStep = Math.floor((status?.indexed ?? 0) / REFRESH_EVERY);
  const [mix, ref] = reports;

  useEffect(() => {
    if (!mix && !ref) {
      setRows(null);
      return;
    }
    let cancelled = false;
    const input = (r: AnalysisReport | null) => (r ? { features: r.features, integrated: r.loudness.stats.integrated } : null);
    api
      .libraryStanding([input(mix), input(ref)], near ? NEAR : null)
      .then((s) => !cancelled && setRows(s))
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mix?.features, ref?.features, near, indexedStep, status?.scanning]);

  if (!mix && !ref) return null;
  const groups = [...new Set((rows ?? []).map((r) => r.group))];
  return (
    <section className="standing">
      <div className="similar-controls">
        <h3 className="results-heading">In your library</h3>
        <div className="segmented" role="radiogroup" aria-label="Compare with">
          <Glide />
          <button className={!near ? "on" : ""} onClick={() => setNear(false)} title="Percentiles among every analysed library track">
            Whole library
          </button>
          <button
            className={near ? "on" : ""}
            onClick={() => setNear(true)}
            disabled={!mix}
            title={`Percentiles among the ${NEAR} library tracks that sound most like ${labels[0]}: your neighbourhood, not the whole collection`}
          >
            Closest {NEAR}
          </button>
        </div>
      </div>
      {rows === null ? (
        <p className="chart-note working">Placing…</p>
      ) : rows.length === 0 ? (
        <p className="chart-note">No analysed library tracks yet.</p>
      ) : (
        <>
          <div className="standing-legend chart-note">
            {mix && <span className="col-a">● {labels[0]}</span>}
            {ref && <span className="col-b">◆ {labels[1]}</span>}
            <span>among {rows[0].count} tracks · shaded: the middle half</span>
          </div>
          {groups.map((group) => (
            <div key={group} className="standing-group">
              <div className="standing-group-name">{group}</div>
              {rows
                .filter((r) => r.group === group)
                .map((r) => (
                  <StandingRow key={r.key} row={r} labels={labels} />
                ))}
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function StandingRow({ row, labels }: { row: Standing; labels: [string, string] }) {
  const median = row.quantiles[10];
  const describe = (i: number) => {
    const v = row.values[i];
    const p = row.percentiles[i];
    return v == null || p == null ? null : `${labels[i]}: ${formatValue(v, row.unit)}, ${ordinal(p)} percentile`;
  };
  const title = [
    `${row.label}: higher = ${row.higher}`,
    describe(0),
    describe(1),
    `Library: median ${formatValue(median, row.unit)}, middle half ${formatValue(row.quantiles[5], row.unit)} to ${formatValue(row.quantiles[15], row.unit)}`,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div className="standing-row" title={title}>
      <span className="standing-label">{row.label}</span>
      <div className="standing-strip">
        <span className="standing-iqr" />
        <span className="standing-median" />
        {row.percentiles.map((p, i) =>
          p == null ? null : (
            <span key={i} className={`standing-marker ${i ? "ref" : "mix"}`} style={{ left: `${p}%` } as CSSProperties} />
          ),
        )}
      </div>
      {row.percentiles.map((p, i) => (
        <span key={i} className={`standing-pct ${i ? "col-b" : "col-a"}`}>
          {p == null ? "—" : ordinal(p)}
        </span>
      ))}
    </div>
  );
}
