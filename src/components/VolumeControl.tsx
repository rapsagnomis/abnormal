import { useEffect, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { VOLUME_MIN_DB } from "./TransportBar";

/** Bars in the control, drawn like the bar waveform (3 px bars, 2 px apart). */
const BARS = 24;
const BAR_WIDTH = 3;
const BAR_GAP = 2;
/** Bar heights, px: rising from the quietest to the loudest. */
const MIN_HEIGHT = 5;
const MAX_HEIGHT = 20;
/** Wheel and arrow-key step, dB. */
const STEP_DB = 1;

const clampDb = (db: number) => Math.min(0, Math.max(VOLUME_MIN_DB, Math.round(db * 2) / 2));
/** Share of the bars lit at `db` (0 when muted). */
const fill = (db: number) => (db <= VOLUME_MIN_DB ? 0 : (db - VOLUME_MIN_DB) / -VOLUME_MIN_DB);

interface Props {
  /** Output volume, dB (`VOLUME_MIN_DB` = muted). */
  volumeDb: number;
  onVolume: (db: number) => void;
}

/** App-wide output volume, as a row of waveform bars rising left to right: those up to the level
 *  are lit. Click or drag along them to set it, wheel or arrows to nudge it, double-click for 0 dB;
 *  the speaker mutes and unmutes. */
export function VolumeControl({ volumeDb, onVolume }: Props) {
  const bars = useRef<HTMLDivElement>(null);
  /** The level before muting, to come back to. */
  const beforeMute = useRef(volumeDb > VOLUME_MIN_DB ? volumeDb : 0);
  if (volumeDb > VOLUME_MIN_DB) beforeMute.current = volumeDb;
  const latest = useRef({ volumeDb, onVolume });
  latest.current = { volumeDb, onVolume };

  const dbAt = (x: number) => {
    const r = bars.current!.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (x - r.left) / r.width));
    return clampDb(VOLUME_MIN_DB + t * -VOLUME_MIN_DB);
  };

  const press = (down: ReactPointerEvent<HTMLDivElement>) => {
    if (down.button !== 0) return;
    down.preventDefault();
    onVolume(dbAt(down.clientX));
    const move = (e: PointerEvent) => latest.current.onVolume(dbAt(e.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.classList.remove("dragging-volume");
    };
    document.body.classList.add("dragging-volume");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  // The wheel nudges the level (non-passive, so the page doesn't take it).
  useEffect(() => {
    const el = bars.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? -e.deltaY : e.deltaX;
      if (delta === 0) return;
      const { volumeDb: db, onVolume: set } = latest.current;
      set(clampDb(db + Math.sign(delta) * STEP_DB));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const muted = volumeDb <= VOLUME_MIN_DB;
  const lit = fill(volumeDb) * BARS;
  const readout = muted ? "Mute" : `${volumeDb < 0 ? "−" : ""}${Math.abs(volumeDb).toFixed(1)} dB`;

  return (
    <div className={`volume-control${muted ? " muted" : ""}`}>
      <button
        className="volume-speaker"
        onClick={(e) => {
          onVolume(muted ? beforeMute.current : VOLUME_MIN_DB);
          e.currentTarget.blur();
        }}
        title={muted ? "Unmute" : "Mute"}
        aria-label={muted ? "Unmute" : "Mute"}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
          {muted ? <path d="M16 9.5l5 5M21 9.5l-5 5" /> : <path d="M15.5 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />}
        </svg>
      </button>
      <div
        ref={bars}
        className="volume-bars"
        role="slider"
        tabIndex={0}
        aria-label="Output volume"
        aria-valuemin={VOLUME_MIN_DB}
        aria-valuemax={0}
        aria-valuenow={volumeDb}
        aria-valuetext={readout}
        title="Output volume for every track: click or drag, wheel to nudge, double-click for 0 dB"
        style={{ "--bar-width": `${BAR_WIDTH}px`, "--bar-gap": `${BAR_GAP}px`, height: MAX_HEIGHT } as CSSProperties}
        onPointerDown={press}
        onDoubleClick={() => onVolume(0)}
        onKeyDown={(e) => {
          const step = e.key === "ArrowUp" || e.key === "ArrowRight" ? STEP_DB : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -STEP_DB : 0;
          if (!step) return;
          // Arrows belong to the volume while it has focus, not to the transport.
          e.preventDefault();
          e.stopPropagation();
          onVolume(clampDb(volumeDb + step));
        }}
        // Give focus back on release, so space and the arrows go back to the transport.
        onPointerUp={(e) => e.currentTarget.blur()}
      >
        {Array.from({ length: BARS }, (_, i) => {
          const height = MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * (i / (BARS - 1)) ** 1.15;
          // The bar the level falls in is lit in part, so the level moves smoothly.
          const on = Math.min(1, Math.max(0, lit - i));
          return <span key={i} className="volume-bar" style={{ height, "--on": on } as CSSProperties} />;
        })}
      </div>
      <span className="volume-value">{readout}</span>
    </div>
  );
}
