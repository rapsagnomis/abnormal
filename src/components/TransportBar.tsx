import { useState } from "react";
import { Glide } from "./Glide";
import { LevelMeter } from "./LevelMeter";
import { SLOT_COUNT } from "../lib/api";
import type { Slot } from "../lib/api";
import type { CurveMode } from "../lib/overlay";
import type { Display } from "./Waveform";
import { formatDuration } from "../lib/format";

interface Props {
  playing: boolean;
  active: Slot;
  /** Peak level per slot (linear), for the meters in the track buttons. */
  levels: number[];
  linked: boolean;
  /** Track buttons in lane order: A, B, then the extra tracks. */
  lanes: { slot: Slot; label: string; loaded: boolean; leaving: boolean; role?: "track" | "reference" | null }[];
  /** Length of all the loaded tracks together, when there are several; else null. */
  totalDuration: number | null;
  loadedCount: number;
  /** Another track can be added (up to Z). */
  canAdd: boolean;
  onAdd: () => void;
  /** Close an extra lane (3 onwards). */
  onRemove: (slot: Slot) => void;
  /** Close the last extra lane. */
  onRemoveLast: () => void;
  curveMode: CurveMode;
  onTogglePlay: () => void;
  onToStart: () => void;
  onSelect: (slot: Slot) => void;
  onToggleLinked: () => void;
  /** Player mode: tracks play one after another, in lane order. */
  playerMode: boolean;
  /** Play the tracks one after another (true) or all together (false). */
  onPlayerMode: (on: boolean) => void;
  onCurveMode: (mode: CurveMode) => void;
  display: Display;
  onDisplay: (d: Display) => void;
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
  const wantDensity = p.lanes.length > 10 ? " dense" : p.lanes.length > 4 ? " compact" : "";
  const [hovered, setHovered] = useState(false);
  const [density, setDensity] = useState(wantDensity);
  if (!hovered && density !== wantDensity) setDensity(wantDensity);
  return (
    <footer className="transport">
      {/* Playback: how the playhead moves. */}
      <div className="transport-group">
        <button onClick={p.onToStart} disabled={!any} title="Back to start (Home, ⌘←)">
          ⏮
        </button>
        <button className="play" onClick={p.onTogglePlay} disabled={!any} title="Play / pause (Space) · ← / → move 5 s (⇧ for 1 s)">
          {p.playing ? "❚❚" : "▶"}
        </button>
        <button
          className={`toggle link-toggle${p.linked ? " on" : ""}`}
          onClick={p.onToggleLinked}
          aria-pressed={p.linked}
          aria-label="Link the tracks"
          title={
            p.linked
              ? "Linked (K): the tracks seek, select and zoom together. Click to unlink"
              : "Link the tracks (K): seek, select and zoom them together"
          }
        >
          {/* A play triangle with a chain link at its foot. */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 4v12l9.5-6z" />
            <path d="M14.5 20.5H13a2.5 2.5 0 0 1 0-5h1.5M17.5 15.5H19a2.5 2.5 0 0 1 0 5h-1.5M14.5 18h3" />
          </svg>
        </button>
        {/* How the tracks play: all together (parallel lanes) or one after another (a staircase). */}
        <div className="segmented play-mode" role="radiogroup" aria-label="Play mode">
          <Glide />
          <button
            role="radio"
            aria-checked={!p.playerMode}
            className={p.playerMode ? "" : "on"}
            onClick={() => p.onPlayerMode(false)}
            aria-label="Parallel"
            title="Parallel (P): every track plays at once, switching only changes which one you hear"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
          <button
            role="radio"
            aria-checked={p.playerMode}
            className={p.playerMode ? "on" : ""}
            onClick={() => p.onPlayerMode(true)}
            aria-label="Player"
            title="Player (P): the tracks play one after another, in lane order, like an ordinary player"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M3 7h6M9 12h6M15 17h6" />
            </svg>
          </button>
        </div>
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
            title={p.canAdd ? `Add another track to switch to (up to ${SLOT_COUNT})` : `All ${SLOT_COUNT} tracks are in use`}
            aria-label="Add a track"
          >
            +
          </button>
        </div>
        <div
          className={`ab-switch${density}`}
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
                title={`Listen to track ${label} (number-row key ${i + 1}) — Tab switches current ⇄ reference${role === "track" ? " · current" : role === "reference" ? " · reference" : ""}`}
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
        {p.totalDuration !== null && (
          <span className="playlist-total" title={`${p.loadedCount} tracks, ${formatDuration(p.totalDuration)} in all`}>
            {p.loadedCount} tracks · {formatDuration(p.totalDuration)}
          </span>
        )}
      </div>

      {/* View: how the lanes are drawn and kept in step. */}
      <div className="transport-group view-group">
        <div className="segmented" role="radiogroup" aria-label="Lane display (S toggles)">
          <Glide />
          {(
            [
              ["wave", "Wave", "Waveform on a dB scale: a solid body as loud as each slice of time (momentary loudness) under a faint cap at its peak level. The gap between them shows how hard it's limited"],
              ["peak", "Peak", "Waveform: one bar per slice of time, as tall as its peak level"],
              ["spectrogram", "Spec", "Spectrogram, 30 Hz–20 kHz (log), each track scaled to its own level: dark purple quiet → red → orange → pale yellow loud"],
            ] as [Display, string, string][]
          ).map(([d, label, title]) => (
            <button key={d} className={p.display === d ? "on" : ""} onClick={() => p.onDisplay(d)} title={`${title} (S: spectrogram ⇄ waveform)`}>
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
      </div>
    </footer>
  );
}

