import type { Slot } from "../lib/api";
import type { CurveMode } from "../lib/overlay";
import type { Display } from "./Waveform";

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
  display: Display;
  onDisplay: (d: Display) => void;
  /** Suggested EQ is playing on A. */
  eqOn: boolean;
  /** There are suggested moves to audition. */
  eqAvailable: boolean;
  onToggleEq: () => void;
  /** App-wide output volume, dB (`VOLUME_MIN_DB` = muted). */
  volumeDb: number;
  onVolume: (db: number) => void;
}

/** Bottom of the volume slider, which mutes. */
export const VOLUME_MIN_DB = -40;

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
        <label className="volume" title="Output volume for both tracks (double-click for 0 dB)">
          <span className="control-label">Vol</span>
          <input
            type="range"
            min={VOLUME_MIN_DB}
            max={0}
            step={0.5}
            value={p.volumeDb}
            onChange={(e) => p.onVolume(Number(e.target.value))}
            onDoubleClick={() => p.onVolume(0)}
            // Give focus back so the arrow and space shortcuts keep working on the transport.
            onPointerUp={(e) => e.currentTarget.blur()}
          />
          <span className="volume-value">
            {p.volumeDb <= VOLUME_MIN_DB ? "Mute" : `${p.volumeDb < 0 ? "−" : ""}${Math.abs(p.volumeDb).toFixed(1)} dB`}
          </span>
        </label>
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
        <button
          className={`toggle${p.eqOn ? " on" : ""}`}
          onClick={p.onToggleEq}
          disabled={!p.eqAvailable && !p.eqOn}
          title="Audition the suggested EQ on A (E), level-compensated. Choose moves in the EQ match tab."
        >
          EQ
        </button>
      </div>

      <div className="transport-group">
        <div className="segmented" role="radiogroup" aria-label="Lane display (S toggles)">
          {(
            [
              ["wave", "Wave", "Waveform"],
              ["spectrogram", "Spec", "Spectrogram, 30 Hz–20 kHz (log), each track scaled to its own level"],
            ] as [Display, string, string][]
          ).map(([d, label, title]) => (
            <button key={d} className={p.display === d ? "on" : ""} onClick={() => p.onDisplay(d)} title={`${title} (S toggles)`}>
              {label}
            </button>
          ))}
        </div>
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
