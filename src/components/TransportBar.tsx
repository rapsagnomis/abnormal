import { useState } from "react";
import { Glide } from "./Glide";
import { LevelMeter } from "./LevelMeter";
import type { Slot } from "../lib/api";
import type { CurveMode } from "../lib/overlay";
import type { Display } from "./Waveform";

interface Props {
  playing: boolean;
  active: Slot;
  /** Peak level per slot (linear), for the meters in the track buttons. */
  levels: number[];
  linked: boolean;
  /** Track buttons in lane order: A, B, then the extra tracks. */
  lanes: { slot: Slot; label: string; loaded: boolean; leaving: boolean; role?: "track" | "reference" | null }[];
  /** Another track can be added (up to H). */
  canAdd: boolean;
  onAdd: () => void;
  /** Close an extra lane (C–H). */
  onRemove: (slot: Slot) => void;
  /** Close the last extra lane. */
  onRemoveLast: () => void;
  curveMode: CurveMode;
  onTogglePlay: () => void;
  onToStart: () => void;
  onSkip: (seconds: number) => void;
  onSelect: (slot: Slot) => void;
  onToggleLinked: () => void;
  onCurveMode: (mode: CurveMode) => void;
  display: Display;
  onDisplay: (d: Display) => void;
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
  const any = p.lanes.some((l) => l.loaded);
  const extras = p.lanes.filter((l) => l.slot > 1 && !l.leaving).length;
  // Narrower buttons past four tracks, but never switched while the pointer is over them, so a
  // button doesn't jump out from under it between two clicks.
  const wantCompact = p.lanes.length > 4;
  const [hovered, setHovered] = useState(false);
  const [compact, setCompact] = useState(wantCompact);
  if (!hovered && compact !== wantCompact) setCompact(wantCompact);
  return (
    <footer className="transport">
      {/* Playback: how the playhead moves. */}
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

      {/* Listen to: adding/removing tracks (always at the same place), then which track is heard. */}
      <div className="transport-group tracks-group">
        <div className="segmented track-stepper" role="group" aria-label="Tracks">
          <button
            onClick={p.onRemoveLast}
            disabled={extras === 0}
            title={extras ? `Remove the last track (${p.lanes[p.lanes.length - 1].label})` : "No extra track to remove"}
            aria-label="Remove the last track"
          >
            −
          </button>
          <button
            onClick={p.onAdd}
            disabled={!p.canAdd}
            title={p.canAdd ? "Add another track to switch to (up to H)" : "All eight tracks are in use"}
            aria-label="Add a track"
          >
            +
          </button>
        </div>
        <div
          className={`ab-switch${compact ? " compact" : ""}`}
          role="radiogroup"
          aria-label="Listen to"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          <Glide />
          {p.lanes.map(({ slot, label, loaded, leaving, role }, i) => (
            <div key={slot} className={`slot-switch${slot > 1 ? " extra" : ""}${leaving ? " leaving" : ""}`}>
              <button
                role="radio"
                aria-checked={p.active === slot}
                className={`slot-${label.toLowerCase()}${p.active === slot ? " on" : ""}${role ? ` in-pair role-${role}` : ""}`}
                onClick={() => p.onSelect(slot)}
                disabled={!loaded}
                title={`Listen to ${label} (number-row key ${i + 1}) — Tab switches track ⇄ reference${role === "track" ? " · analysed" : role === "reference" ? " · reference" : ""}`}
              >
                {label}
                {loaded && <LevelMeter level={p.levels[slot] ?? 0} />}
              </button>
              {slot > 1 && (
                <button className="slot-remove" onClick={() => p.onRemove(slot)} title={`Remove ${label}`} aria-label={`Remove ${label}`}>
                  −
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* View: how the lanes are drawn and kept in step. */}
      <div className="transport-group view-group">
        <div className="segmented" role="radiogroup" aria-label="Lane display (S toggles)">
          <Glide />
          {(
            [
              ["wave", "Wave", "Waveform: one bar per slice of time, as tall as its peak level"],
              ["spectrogram", "Spec", "Spectrogram, 30 Hz–20 kHz (log), each track scaled to its own level: dark purple quiet → red → orange → pale yellow loud"],
            ] as [Display, string, string][]
          ).map(([d, label, title]) => (
            <button key={d} className={p.display === d ? "on" : ""} onClick={() => p.onDisplay(d)} title={`${title} (S toggles)`}>
              {label}
            </button>
          ))}
        </div>
        <span className="control-label">Curve</span>
        <div className="segmented" role="radiogroup" aria-label="Curve overlay (C cycles)">
          <Glide />
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
        <button
          className={`toggle${p.linked ? " on" : ""}`}
          onClick={p.onToggleLinked}
          title="Link playheads, selections and zoom across tracks (K)"
        >
          Link
        </button>
      </div>

      {/* Output. */}
      <div className="transport-group">
        <label className="volume" title="Output volume for every track (double-click for 0 dB)">
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
    </footer>
  );
}
