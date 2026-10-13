import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, SLOTS } from "../lib/api";
import type { AnalysisReport, Slot, SongStructure, StructureSetup } from "../lib/api";
import { fmt } from "../lib/metrics";
import { PART_LABELS, partsOf } from "../lib/structure";

const ALL_IN_ONE = "https://github.com/mir-aidj/all-in-one";

type Metric = "loudness" | "width" | "tilt";

const METRICS: [Metric, string, string, string][] = [
  // key, button, unit, explanation
  ["loudness", "Loudness", "LU", "Integrated loudness of each part relative to the whole track: how much the chorus lifts above the verse."],
  ["width", "Width", "dB", "Side − mid level of each part: higher is wider."],
  ["tilt", "Tilt", "dB/oct", "Spectral tilt of each part: higher is brighter."],
];

/** Per song-part type: duration-weighted means over its occurrences. */
interface PartStats {
  count: number;
  loudness: number | null;
  width: number | null;
  tilt: number | null;
}

interface Props {
  structures: [SongStructure | null, SongStructure | null];
  /** Whole-track reports (not the selection's), for loudness relative to the track. */
  fullReports: [AnalysisReport | null, AnalysisReport | null];
  paths: [string | null, string | null];
  pending: [boolean, boolean];
  setup: StructureSetup | null;
  onInstall: () => void;
}

/** Loudness, width and tilt of each song part (intro, verse, chorus…) in A and B. */
export function PartsTable({ structures, fullReports, paths, pending, setup, onInstall }: Props) {
  const [metric, setMetric] = useState<Metric>("loudness");
  const stats = [usePartStats(0, structures[0], paths[0]), usePartStats(1, structures[1], paths[1])];

  const header = <h3 className="results-heading">By song part</h3>;
  if (!setup?.installed) {
    return (
      <section className="panel-section">
        {header}
        <Setup setup={setup} onInstall={onInstall} />
      </section>
    );
  }
  if (!structures[0] && !structures[1]) {
    return (
      <section className="panel-section">
        {header}
        <p className="chart-note">{pending[0] || pending[1] ? "Analysing song structure (about half a minute per track)…" : "Load a track to see its song parts."}</p>
      </section>
    );
  }

  const [, , unit, note] = METRICS.find(([m]) => m === metric)!;
  const value = (slot: Slot, label: string): number | null => {
    const s = stats[slot]?.get(label);
    if (!s) return null;
    const v = s[metric];
    if (v === null || metric !== "loudness") return v;
    const track = fullReports[slot]?.loudness.stats.integrated;
    return track == null ? null : v - track;
  };
  const labels = PART_LABELS.filter((l) => stats.some((s) => s?.has(l)));
  return (
    <section className="panel-section">
      <div className="row">
        {header}
        <div className="segmented" role="radiogroup" aria-label="Metric by song part">
          {METRICS.map(([m, name]) => (
            <button key={m} className={metric === m ? "on" : ""} onClick={() => setMetric(m)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      <table className="metrics">
        <thead>
          <tr>
            <th />
            <th className="col-a">A</th>
            <th className="col-b">B</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((l) => {
            const [a, b] = SLOTS.map((s) => value(s, l));
            const counts = SLOTS.map((s) => stats[s]?.get(l)?.count ?? 0);
            return (
              <tr key={l}>
                <th title={`${counts[0]} in A, ${counts[1]} in B`}>
                  {l} <span className="unit">{unit}</span>
                </th>
                <td className={stats[0] ? "" : "pending"}>{fmt(a, 1, metric !== "width")}</td>
                <td className={stats[1] ? "" : "pending"}>{fmt(b, 1, metric !== "width")}</td>
                <td className="delta">{a !== null && b !== null ? fmt(a - b, 1, true) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="chart-note">{note} Click a part on a waveform to compare it with the same part of the other track.</p>
    </section>
  );
}

/** Measure every part of a track (each analysed on its own) and average per label. */
function usePartStats(slot: Slot, structure: SongStructure | null, path: string | null) {
  const [stats, setStats] = useState<Map<string, PartStats> | null>(null);
  useEffect(() => {
    setStats(null);
    if (!structure || !path) return;
    let cancelled = false;
    (async () => {
      const sums = new Map<string, { count: number; w: Record<Metric, number>; v: Record<Metric, number> }>();
      for (const part of partsOf(structure)) {
        const r = await api.analyze(slot, { start: part.start, end: part.end }, false).catch(() => null);
        if (cancelled) return;
        if (!r) continue;
        const values: Record<Metric, number | null> = {
          loudness: r.loudness.stats.integrated,
          width: r.stereo.stats.sideToMid,
          tilt: r.spectrum.tilt,
        };
        const sum = sums.get(part.label) ?? { count: 0, w: { loudness: 0, width: 0, tilt: 0 }, v: { loudness: 0, width: 0, tilt: 0 } };
        sum.count += 1;
        const weight = part.end - part.start;
        for (const m of ["loudness", "width", "tilt"] as Metric[]) {
          const v = values[m];
          if (v === null) continue;
          sum.w[m] += weight;
          sum.v[m] += v * weight;
        }
        sums.set(part.label, sum);
      }
      const out = new Map<string, PartStats>();
      for (const [label, s] of sums) {
        const mean = (m: Metric) => (s.w[m] > 0 ? s.v[m] / s.w[m] : null);
        out.set(label, { count: s.count, loudness: mean("loudness"), width: mean("width"), tilt: mean("tilt") });
      }
      if (!cancelled) setStats(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [slot, structure, path]);
  return stats;
}

function Setup({ setup, onInstall }: { setup: StructureSetup | null; onInstall: () => void }) {
  return (
    <>
      <p className="chart-note">
        Song parts (intro, verse, chorus…), tempo and bars come from{" "}
        <a
          href={ALL_IN_ONE}
          onClick={(e) => {
            e.preventDefault();
            openUrl(ALL_IN_ONE);
          }}
        >
          All-In-One
        </a>
        , a neural network. It runs in its own Python environment, set up once (about 1 GB, a few minutes, needs{" "}
        <code>uv</code>); after that each track takes about half a minute, the first time it's loaded.
      </p>
      {setup?.installing ? (
        <p className="chart-note">{setup.step ?? "Setting up…"}</p>
      ) : (
        <div className="row">
          <button onClick={onInstall}>Set up song structure</button>
        </div>
      )}
      {setup?.error && <p className="chart-note library-error">{setup.error}</p>}
    </>
  );
}
