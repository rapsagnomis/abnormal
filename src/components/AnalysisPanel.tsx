import type { AnalysisReport, EqFilter, LibraryStatus, MatchReport, Region, Slot, SongStructure, StructureSetup } from "../lib/api";
import { curveOf, describe, formatGain, formatHz, isSide, isWidth, midSideCurves, typeLabel } from "../lib/eq";
import { formatTime } from "../lib/format";
import { fmt, SECTIONS, showValue } from "../lib/metrics";
import type { Section, Tab } from "../lib/metrics";
import { FrequencyChart } from "./FrequencyChart";
import { Goniometer } from "./Goniometer";
import { HistogramChart } from "./HistogramChart";
import { LibraryView } from "./LibraryView";
import { PartsTable } from "./PartsTable";
import { ProQExport } from "./ProQExport";

export type Scope = "full" | "selection";
/** What the EQ audition plays: the chosen moves, or the full (Matchering-style) match. */
export type AuditionKind = "moves" | "full";
export type { Tab };

const TABS: [Tab, string][] = [
  ["loudness", "Loudness"],
  ["dynamics", "Dynamics"],
  ["tonal", "Tonal"],
  ["stereo", "Stereo"],
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
  eq: MatchReport | null;
  /** Every suggested move, as listed: stereo, then width and side (`movesOf`). */
  eqMoves: EqFilter[];
  /** The match measures only the loudest parts. */
  eqLoudest: boolean;
  onEqLoudest: (on: boolean) => void;
  auditionKind: AuditionKind;
  onAuditionKind: (kind: AuditionKind) => void;
  /** The full match is wanted but A's rendering isn't ready yet. */
  fullRendering: boolean;
  /** Paths of the loaded tracks. */
  paths: [string | null, string | null];
  library: LibraryStatus | null;
  /** Which suggested EQ moves are switched on (index-aligned with `eqMoves`). */
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
  /** Whole-track reports, whatever is being measured. */
  fullReports: [AnalysisReport | null, AnalysisReport | null];
  structures: [SongStructure | null, SongStructure | null];
  structurePending: [boolean, boolean];
  structureSetup: StructureSetup | null;
  onStructureInstall: () => void;
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

      {p.tab === "library" ? (
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
          <PartsTable
            structures={p.structures}
            fullReports={p.fullReports}
            paths={p.paths}
            pending={p.structurePending}
            setup={p.structureSetup}
            onInstall={p.onStructureInstall}
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
          <section className="panel-section">
            <h3 className="results-heading">EQ match</h3>
            <EqView
              eq={p.eq}
              moves={p.eqMoves}
              freqs={freqs}
              hasBoth={!!(ra && rb)}
              active={p.eqActive}
              audition={p.eqAudition}
              compensation={p.eqCompensation}
              onActive={p.onEqActive}
              onAudition={p.onEqAudition}
              loudest={p.eqLoudest}
              onLoudest={p.onEqLoudest}
              kind={p.auditionKind}
              onKind={p.onAuditionKind}
              rendering={p.fullRendering}
              passages={p.eqPassages}
              onListen={p.onListen}
              names={p.paths.map((path) => path?.split("/").pop() ?? null) as [string | null, string | null]}
            />
          </section>
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
  eq: MatchReport | null;
  moves: EqFilter[];
  freqs: number[];
  hasBoth: boolean;
  active: boolean[];
  audition: boolean;
  compensation: number;
  onActive: (index: number, on: boolean) => void;
  onAudition: (on: boolean) => void;
  loudest: boolean;
  onLoudest: (on: boolean) => void;
  kind: AuditionKind;
  onKind: (kind: AuditionKind) => void;
  rendering: boolean;
  passages: (Region | null)[];
  onListen: (region: Region) => void;
  /** File names of A and B, for the exported preset's name. */
  names: [string | null, string | null];
}

function EqView(p: EqViewProps) {
  const { eq, moves, freqs, active, audition, kind } = p;
  if (!p.hasBoth) {
    return <p className="chart-note">Load a track in A and a reference in B to get EQ suggestions.</p>;
  }
  const loudestToggle = (
    <label className="eq-option" title="Measure both tracks only over their louder-than-average stretches (as Matchering does), so quiet intros and breakdowns don't sway the match">
      <input type="checkbox" checked={p.loudest} onChange={(e) => p.onLoudest(e.target.checked)} /> Loudest parts only
    </label>
  );
  if (!eq) {
    return (
      <>
        {loudestToggle}
        <p className="chart-note">Fitting…</p>
      </>
    );
  }
  const chosen = moves.filter((_, i) => active[i] ?? true);
  const curves = midSideCurves(chosen, freqs);
  return (
    <>
      <p className="chart-note">
        Moves on <span className="col-a">A</span> to approach the tonal balance of <span className="col-b">B</span>, compared at
        equal loudness. A level difference of {formatGain(eq.offset)} is left to loudness matching.
        {eq.side && " Side moves act on the stereo difference (L − R) only: they make that range wider or narrower."}
      </p>
      {loudestToggle}
      {moves.length === 0 ? (
        <p className="chart-note">No move larger than 0.75 dB needed: the tonal balances already match.</p>
      ) : (
        <table className="metrics eq-table">
          <thead>
            <tr>
              <th title="Include this move in the audition, the charts and the export">On</th>
              <th>#</th>
              <th title="Stereo: both channels alike. Side: the stereo difference only (Pro-Q's Side placement)">Where</th>
              <th>Type</th>
              <th>Freq</th>
              <th>Gain</th>
              <th>Q</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {moves.map((f, i) => (
              <tr key={i} title={describe(f)} className={active[i] ?? true ? "" : "off"}>
                <td>
                  <input
                    type="checkbox"
                    checked={active[i] ?? true}
                    onChange={(e) => p.onActive(i, e.target.checked)}
                    aria-label={`Use move ${i + 1}`}
                  />
                </td>
                <td>{i + 1}</td>
                <td>{isSide(f) ? "Side" : "Stereo"}</td>
                <th>{typeLabel(f)}</th>
                <td>{isWidth(f) ? "all" : formatHz(f.freq)}</td>
                <td>{formatGain(f.gain)}</td>
                <td>{isWidth(f) ? "–" : f.q.toFixed(1)}</td>
                <td>
                  {p.passages[i] && (
                    <button
                      className="listen"
                      onClick={() => p.onListen(p.passages[i]!)}
                      title={`Loop A at ${formatTime(p.passages[i]!.start)}–${formatTime(p.passages[i]!.end)}, where this move matters most`}
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
        {moves.map((f, i) => (
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
          { label: "Full match", color: "var(--series-diff)", values: eq.full.total },
          { label: "Suggested EQ", color: "var(--series-a)", values: curveOf(chosen.filter((f) => !isSide(f)), freqs) },
        ]}
      />
      {eq.side && (
        <FrequencyChart
          title="Side correction · dB"
          unit="dB"
          freqs={freqs}
          minSpan={6}
          zeroLine
          symmetric
          height={110}
          series={[
            { label: "Needed on side", color: "var(--series-b)", values: eq.side.target, dashed: true },
            { label: "Full match", color: "var(--series-diff)", values: eq.full.side },
            { label: "Suggested EQ", color: "var(--series-a)", values: curves.side },
          ]}
        />
      )}
      <div className="eq-footer">
        <span className="chart-note">
          Fit: {eq.errorBefore.toFixed(1)} → {eq.errorAfter.toFixed(1)} dB RMS left
          {eq.side && `, side ${eq.side.errorBefore.toFixed(1)} → ${eq.side.errorAfter.toFixed(1)}`}. The moves are{" "}
          {eq.full.gap.toFixed(1)} dB RMS from the full match{eq.full.sideGap !== null && ` (side ${eq.full.sideGap.toFixed(1)})`}: the
          smoothed difference itself, as Matchering applies it, limited to ±12 dB.
        </span>
      </div>
      {chosen.length > 0 && <ProQExport filters={chosen} names={p.names} />}
      <div className="eq-audition">
        <button
          className={`toggle${audition ? " on" : ""}`}
          onClick={() => p.onAudition(!audition)}
          disabled={kind === "moves" && chosen.length === 0}
          title="Hear the EQ on A's playback (E)"
        >
          {audition ? "Auditioning on A" : "Audition on A"}
        </button>
        <div className="segmented" role="radiogroup" aria-label="Audition">
          <button className={kind === "moves" ? "on" : ""} onClick={() => p.onKind("moves")} title="The switched-on moves above">
            Moves
          </button>
          <button
            className={kind === "full" ? "on" : ""}
            onClick={() => p.onKind("full")}
            title="The full match: A through linear-phase mid and side filters that follow the full-match curves"
          >
            Full match
          </button>
        </div>
        <span className="chart-note">
          {audition
            ? p.rendering
              ? "Rendering the full match…"
              : `Level-compensated by ${formatGain(p.compensation)} so the EQ doesn't just sound louder. Switch A/B, or press E to compare with and without.`
            : kind === "moves"
              ? "Play A with the selected moves applied."
              : "Play A through the full match, to hear what the moves leave out."}
        </span>
      </div>
    </>
  );
}

