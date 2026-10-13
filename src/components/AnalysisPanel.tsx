import type { AnalysisReport, EqFilter, EqReport, LibraryStatus, Region, Slot } from "../lib/api";
import { curveOf, describe, eqAsText, formatGain, formatHz, KIND_LABEL } from "../lib/eq";
import { formatTime } from "../lib/format";
import { fmt, SECTIONS, showValue } from "../lib/metrics";
import type { Section, Tab } from "../lib/metrics";
import { FrequencyChart } from "./FrequencyChart";
import { Goniometer } from "./Goniometer";
import { HistogramChart } from "./HistogramChart";
import { LibraryView } from "./LibraryView";

export type Scope = "full" | "selection";
export type { Tab };

const TABS: [Tab, string][] = [
  ["loudness", "Loudness"],
  ["dynamics", "Dynamics"],
  ["tonal", "Tonal"],
  ["stereo", "Stereo"],
  ["eq", "EQ match"],
  ["library", "Library"],
];

interface Props {
  tab: Tab;
  reports: [AnalysisReport | null, AnalysisReport | null];
  /** Per-track "is this still being measured" flags. */
  pending: [boolean, boolean];
  loaded: [boolean, boolean];
  scope: Scope;
  hasSelection: boolean;
  /** Selected ranges per track, shown when measuring the selection. */
  regions: [Region | null, Region | null];
  eq: EqReport | null;
  /** Paths of the loaded tracks. */
  paths: [string | null, string | null];
  library: LibraryStatus | null;
  /** Which suggested EQ moves are switched on (index-aligned with `eq.suggestions`). */
  eqActive: boolean[];
  /** Suggested EQ is being auditioned on A's playback. */
  eqAudition: boolean;
  /** Level compensation applied to A while auditioning, dB. */
  eqCompensation: number;
  /** Per suggested move: the passage of A where it matters most (null = none / still measuring). */
  eqPassages: (Region | null)[];
  onTab: (tab: Tab) => void;
  onEqActive: (index: number, on: boolean) => void;
  onEqAudition: (on: boolean) => void;
  onListen: (region: Region) => void;
  onScope: (scope: Scope) => void;
  onLoad: (slot: Slot, path: string) => void;
  onRescan: () => void;
}


const SERIES_COLORS = ["var(--series-a)", "var(--series-b)"];
const label = (i: number) => (i ? "B" : "A");

export function AnalysisPanel(p: Props) {
  const [ra, rb] = p.reports;
  const freqs = (ra ?? rb)?.spectrum.freqs ?? [];

  return (
    <aside className="panel">
      <div className="tabs" role="tablist">
        {TABS.map(([t, name]) => (
          <button key={t} role="tab" aria-selected={p.tab === t} className={p.tab === t ? "on" : ""} onClick={() => p.onTab(t)}>
            {name}
          </button>
        ))}
      </div>
      <header className="panel-header">
        <span className="scope-label">Measure</span>
        <div className="segmented" role="radiogroup" aria-label="Measure">
          <button className={p.scope === "full" ? "on" : ""} onClick={() => p.onScope("full")}>
            Full
          </button>
          <button
            className={p.scope === "selection" ? "on" : ""}
            onClick={() => p.onScope("selection")}
            disabled={!p.hasSelection}
            title={p.hasSelection ? "" : "Drag on a waveform to select a section"}
          >
            Selection
          </button>
        </div>
      </header>

      {p.scope === "selection" && (
        <p className="scope-ranges">
          {p.regions.map((r, i) => (
            <span key={i} className={i ? "col-b" : "col-a"}>
              {label(i)} {r ? `${formatTime(r.start)}–${formatTime(r.end)}` : "full track"}
            </span>
          ))}
        </p>
      )}

      {p.tab === "eq" ? (
        <EqView
          eq={p.eq}
          freqs={freqs}
          hasBoth={!!(ra && rb)}
          active={p.eqActive}
          audition={p.eqAudition}
          compensation={p.eqCompensation}
          onActive={p.onEqActive}
          onAudition={p.onEqAudition}
          passages={p.eqPassages}
          onListen={p.onListen}
        />
      ) : p.tab === "library" ? (
        <LibraryView reports={p.reports} paths={p.paths} status={p.library} onLoad={p.onLoad} onRescan={p.onRescan} />
      ) : (
        <MetricsTable sections={SECTIONS[p.tab]} {...p} />
      )}

      {p.tab === "dynamics" && (
        <>
          <HistogramChart
            title="Short-term loudness · LUFS"
            unit="LUFS"
            domain={[-60, 0]}
            minSpan={12}
            markerLabel="median"
            series={p.reports.map((r, i) => ({
              label: label(i),
              color: SERIES_COLORS[i],
              histogram: r?.dynamics.shortTermHistogram ?? null,
              marker: r?.dynamics.stats.shortTermP50 ?? null,
            }))}
          />
          <HistogramChart
            title="Crest factor, 50 ms · dB"
            unit="dB"
            domain={[0, 30]}
            minSpan={8}
            markerLabel="median"
            series={p.reports.map((r, i) => ({
              label: label(i),
              color: SERIES_COLORS[i],
              histogram: r?.dynamics.crestHistogram ?? null,
              marker: r?.dynamics.stats.crestShortMedian ?? null,
            }))}
          />
        </>
      )}

      {p.tab === "tonal" && (
        <>
          <FrequencyChart
            title="Spectrum · dB re loudness, 1/6 oct"
            unit="dB"
            freqs={freqs}
            minSpan={24}
            series={p.reports.map((r, i) => ({ label: label(i), color: SERIES_COLORS[i], values: r?.spectrum.level ?? null }))}
          />
          <FrequencyChart
            title="Difference A − B · dB"
            unit="dB"
            freqs={freqs}
            minSpan={6}
            zeroLine
            symmetric
            height={110}
            series={[
              {
                label: "A − B",
                color: "var(--series-diff)",
                values: ra && rb ? ra.spectrum.level.map((v, i) => v - rb.spectrum.level[i]) : null,
              },
            ]}
          />
          <p className="chart-note">Positive: A has more energy there than B at equal loudness.</p>
        </>
      )}

      {p.tab === "stereo" && (
        <>
          <FrequencyChart
            title="Width by frequency · side − mid dB"
            unit="dB"
            freqs={freqs}
            minSpan={12}
            series={p.reports.map((r, i) => ({
              label: label(i),
              color: SERIES_COLORS[i],
              values: r && !r.stereo.stats.mono ? r.spectrum.width : null,
            }))}
          />
          <div className="gonio-row">
            {p.reports.map((r, i) =>
              p.loaded[i] ? (
                <Goniometer
                  key={i}
                  label={r?.stereo.stats.mono ? `${label(i)} · mono` : label(i)}
                  color={SERIES_COLORS[i]}
                  density={r?.stereo.goniometer ?? null}
                  size={r?.stereo.goniometerSize ?? 1}
                />
              ) : null,
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function MetricsTable({ sections, reports, pending, loaded }: { sections: Section[] } & Props) {
  return (
    <table className="metrics">
      <thead>
        <tr>
          <th />
          <th className="col-a">A</th>
          <th className="col-b">B</th>
          <th title="A − B">Δ</th>
        </tr>
      </thead>
      {sections.map((section, si) => (
        <tbody key={si}>
          {section.heading && (
            <tr className="section-heading">
              <th colSpan={4}>{section.heading}</th>
            </tr>
          )}
          {section.rows.map((row) => {
            const values = reports.map((r) => (r ? row.get(r) : null));
            const [a, b] = values;
            const delta = a !== null && b !== null ? a - b : null;
            return (
              <tr key={row.label} title={row.hint}>
                <th>
                  {row.label} <span className="unit">{row.unit}</span>
                </th>
                {values.map((v, i) => {
                  const warning = v !== null && row.warn ? row.warn(v) : null;
                  return (
                    <td key={i} className={`${pending[i] ? "pending" : ""}${warning ? " warn" : ""}`} title={warning ?? undefined}>
                      {loaded[i] ? showValue(row, v) : ""}
                    </td>
                  );
                })}
                <td className="delta">{fmt(delta, row.digits, true)}</td>
              </tr>
            );
          })}
        </tbody>
      ))}
    </table>
  );
}

interface EqViewProps {
  eq: EqReport | null;
  freqs: number[];
  hasBoth: boolean;
  active: boolean[];
  audition: boolean;
  compensation: number;
  onActive: (index: number, on: boolean) => void;
  onAudition: (on: boolean) => void;
  passages: (Region | null)[];
  onListen: (region: Region) => void;
}

function EqView({ eq, freqs, hasBoth, active, audition, compensation, onActive, onAudition, passages, onListen }: EqViewProps) {
  if (!hasBoth) {
    return <p className="chart-note">Load a track in A and a reference in B to get EQ suggestions.</p>;
  }
  if (!eq) return <p className="chart-note">Fitting…</p>;
  const chosen: EqFilter[] = eq.suggestions.filter((_, i) => active[i] ?? true);
  return (
    <>
      <p className="chart-note">
        Moves on <span className="col-a">A</span> to approach the tonal balance of <span className="col-b">B</span>, compared at
        equal loudness. A level difference of {formatGain(eq.offset)} is left to loudness matching.
      </p>
      {eq.suggestions.length === 0 ? (
        <p className="chart-note">No move larger than 0.75 dB needed: the tonal balances already match.</p>
      ) : (
        <table className="metrics eq-table">
          <thead>
            <tr>
              <th title="Include this move in the audition and the chart">On</th>
              <th>#</th>
              <th>Type</th>
              <th>Freq</th>
              <th>Gain</th>
              <th>Q</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {eq.suggestions.map((f, i) => (
              <tr key={i} title={describe(f)} className={active[i] ?? true ? "" : "off"}>
                <td>
                  <input
                    type="checkbox"
                    checked={active[i] ?? true}
                    onChange={(e) => onActive(i, e.target.checked)}
                    aria-label={`Use move ${i + 1}`}
                  />
                </td>
                <td>{i + 1}</td>
                <th>{KIND_LABEL[f.kind]}</th>
                <td>{formatHz(f.freq)}</td>
                <td>{formatGain(f.gain)}</td>
                <td>{f.q.toFixed(1)}</td>
                <td>
                  {passages[i] && (
                    <button
                      className="listen"
                      onClick={() => onListen(passages[i]!)}
                      title={`Loop A at ${formatTime(passages[i]!.start)}–${formatTime(passages[i]!.end)}, where this move matters most`}
                    >
                      ▶
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ul className="eq-notes">
        {eq.suggestions.map((f, i) => (
          <li key={i}>
            {i + 1}. {describe(f)}
          </li>
        ))}
      </ul>
      <FrequencyChart
        title="Tonal correction · dB"
        unit="dB"
        freqs={freqs}
        minSpan={6}
        zeroLine
        symmetric
        series={[
          { label: "Needed (B − A)", color: "var(--series-b)", values: eq.target, dashed: true },
          { label: "Suggested EQ", color: "var(--series-a)", values: curveOf(chosen, freqs) },
        ]}
      />
      <div className="eq-footer">
        <span className="chart-note">
          Fit: {eq.errorBefore.toFixed(1)} → {eq.errorAfter.toFixed(1)} dB RMS left
        </span>
        {eq.suggestions.length > 0 && (
          <button onClick={() => navigator.clipboard.writeText(eqAsText(chosen))} disabled={chosen.length === 0}>
            Copy
          </button>
        )}
      </div>
      {eq.suggestions.length > 0 && (
        <div className="eq-audition">
          <button
            className={`toggle${audition ? " on" : ""}`}
            onClick={() => onAudition(!audition)}
            disabled={chosen.length === 0}
            title="Hear the selected moves on A's playback (E)"
          >
            {audition ? "Auditioning on A" : "Audition on A"}
          </button>
          <span className="chart-note">
            {audition
              ? `Level-compensated by ${formatGain(compensation)} so the EQ doesn't just sound louder. Switch A/B, or press E to compare with and without.`
              : "Play A with the selected moves applied."}
          </span>
        </div>
      )}
    </>
  );
}
