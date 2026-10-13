import type { Slot } from "../lib/api";
import type { CurveMode } from "../lib/overlay";

interface Props {
  playing: boolean;
  active: Slot;
  loopEnabled: boolean;
  linked: boolean;
  hasTracks: [boolean, boolean];
  curveMode: CurveMode;
  matchEnabled: boolean;
  /** What loudness matching is based on, for the tooltip. */
  matchBasis: string;
  onTogglePlay: () => void;
  onToStart: () => void;
  onSkip: (seconds: number) => void;
  onSelect: (slot: Slot) => void;
  onToggleLoop: () => void;
  onToggleLinked: () => void;
  onCurveMode: (mode: CurveMode) => void;
  onToggleMatch: () => void;
}

const CURVES: [CurveMode, string, string][] = [
  ["off", "Off", "Hide curve"],
  ["momentary", "M", "Momentary loudness (400 ms), LUFS"],
  ["shortTerm", "S", "Short-term loudness (3 s), LUFS"],
  ["psr", "PSR", "Peak-to-short-term-loudness ratio over time, 0–24 LU"],
  ["correlation", "Corr", "Phase correlation over time, −1…+1 (below 0 = out of phase)"],
];

export function TransportBar(p: Props) {
  const any = p.hasTracks[0] || p.hasTracks[1];
  return (
    <footer className="transport">
      <div className="transport-group">
        <button onClick={p.onToStart} disabled={!any} title="Back to start (Home)">
          ⏮
        </button>
        <button onClick={() => p.onSkip(-5)} disabled={!any} title="Back 5 s (←)">
          −5s
        </button>
        <button className="play" onClick={p.onTogglePlay} disabled={!any} title="Play / pause (Space)">
          {p.playing ? "❚❚" : "▶"}
        </button>
        <button onClick={() => p.onSkip(5)} disabled={!any} title="Forward 5 s (→)">
          +5s
        </button>
      </div>

      <div className="transport-group">
        <div className="ab-switch" role="radiogroup" aria-label="Listen to">
          {([0, 1] as Slot[]).map((slot) => (
            <button
              key={slot}
              role="radio"
              aria-checked={p.active === slot}
              className={`slot-${slot ? "b" : "a"}${p.active === slot ? " on" : ""}`}
              onClick={() => p.onSelect(slot)}
              disabled={!p.hasTracks[slot]}
              title={`Listen to ${slot ? "B" : "A"} (${slot + 1}) — Tab toggles`}
            >
              {slot ? "B" : "A"}
            </button>
          ))}
        </div>
        <button
          className={`toggle${p.matchEnabled ? " on" : ""}`}
          onClick={p.onToggleMatch}
          title={`Match loudness (M): turn the louder track down to the quieter one, based on ${p.matchBasis}`}
        >
          Match
        </button>
      </div>

      <div className="transport-group">
        <span className="control-label">Curve</span>
        <div className="segmented" role="radiogroup" aria-label="Curve overlay (C cycles)">
          {CURVES.map(([mode, label, title]) => (
            <button
              key={mode}
              className={p.curveMode === mode ? "on" : ""}
              onClick={() => p.onCurveMode(mode)}
              title={`${title} (C cycles)`}
            >
              {label}
            </button>
          ))}
        </div>
        <button className={`toggle${p.loopEnabled ? " on" : ""}`} onClick={p.onToggleLoop} title="Loop selections (L)">
          Loop
        </button>
        <button
          className={`toggle${p.linked ? " on" : ""}`}
          onClick={p.onToggleLinked}
          title="Link playheads, selections and zoom across tracks (K)"
        >
          Link
        </button>
      </div>
    </footer>
  );
}
