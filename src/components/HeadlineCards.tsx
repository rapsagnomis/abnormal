import type { AnalysisReport } from "../lib/api";
import { BAND_RANGES, BANDS, fmt, HEADLINES, showValue } from "../lib/metrics";
import type { Headline, Row, Tab } from "../lib/metrics";
import { usePair } from "../lib/pair";
import { TweenedValue } from "./TweenedValue";

interface Props {
  tab: Exclude<Tab, "library">;
  /** The compared pair's reports: track, reference. */
  reports: [AnalysisReport | null, AnalysisReport | null];
  pending: [boolean, boolean];
  loaded: [boolean, boolean];
}

/** The tab's few headline numbers, big, for an overview (hover one for what it means); the full
 *  table follows below. */
export function HeadlineCards(p: Props) {
  return (
    <div className="headlines">
      {HEADLINES[p.tab].map((h, i) => (
        <HeadlineCard key={i} headline={h} {...p} />
      ))}
    </div>
  );
}

function HeadlineCard({ headline, ...p }: { headline: Headline } & Props) {
  switch (headline.kind) {
    case "metric":
      return <MetricCard title={headline.title} row={headline.row} explain={headline.explain} {...p} />;
    case "biggestDifference":
      return <BiggestDifference explain={headline.explain} {...p} />;
  }
}

/** One metric for both tracks, each in its colour, and the difference track − reference. */
function MetricCard({ title, row, explain, reports, pending, loaded }: { title: string; row: Row; explain: string } & Props) {
  const { labels } = usePair();
  const values = reports.map((r) => (r ? row.get(r) : null));
  const [a, b] = values;
  const delta = a !== null && b !== null ? a - b : null;
  return (
    <div className="headline" data-explain={explain}>
      <div className="headline-title">
        {title} {row.unit && <span className="unit">{row.unit}</span>}
      </div>
      {values.map((v, i) => {
        const warning = v !== null && row.warn ? row.warn(v) : null;
        return (
          <div
            key={i}
            className={`headline-value ${i ? "col-b" : "col-a"}${pending[i] ? " pending" : ""}${warning ? " warn" : ""}`}
            title={warning ?? undefined}
          >
            <span className="headline-letter">{labels[i]}</span>
            <span className="headline-number">{loaded[i] ? <TweenedValue value={v} show={(x) => showValue(row, x)} /> : "—"}</span>
            {warning && <span className="headline-warn">⚠</span>}
          </div>
        );
      })}
      <div className="headline-delta">Δ {fmt(delta, row.digits, true)}</div>
    </div>
  );
}

/** The band where the two differ most at equal loudness, and which way. */
function BiggestDifference({ reports, explain }: { explain: string } & Props) {
  const { labels } = usePair();
  const [a, b] = reports;
  let best: { band: number; diff: number } | null = null;
  if (a && b) {
    a.spectrum.bands.forEach((band, i) => {
      const other = b.spectrum.bands[i];
      if (band.level === null || other?.level == null) return;
      const diff = band.level - other.level;
      if (!best || Math.abs(diff) > Math.abs(best.diff)) best = { band: i, diff };
    });
  }
  const found = best as { band: number; diff: number } | null;
  return (
    <div className="headline" data-explain={explain}>
      <div className="headline-title">Biggest difference</div>
      <div className="headline-big">
        {found ? (
          <>
            <TweenedValue value={found.diff} show={(x) => fmt(x, 1, true)} /> <span className="unit">dB</span>
          </>
        ) : (
          "—"
        )}
      </div>
      {found && (
        <div className="headline-delta">
          <span className="headline-band">{BANDS[found.band]}</span> {BAND_RANGES[found.band]}
          <br />
          <span className="col-a">{labels[0]}</span> has {found.diff > 0 ? "more" : "less"}
        </div>
      )}
    </div>
  );
}

