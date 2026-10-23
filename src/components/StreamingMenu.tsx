import { useEffect, useRef, useState } from "react";
import { platformById, PLATFORMS } from "../lib/streaming";
import type { PlatformId } from "../lib/streaming";
import { Chevron } from "./Chevron";

interface Props {
  platform: PlatformId | null;
  onPlatform: (id: PlatformId | null) => void;
  /** Loaded tracks and the gain the chosen platform gives each (null until measured). */
  gains: { label: string; gain: number | null }[];
}

const signed = (db: number) => `${db > 0.05 ? "+" : db < -0.05 ? "−" : "±"}${Math.abs(db).toFixed(1)}`;

/** Streaming preview: hear every track at the level a platform would play it. */
export function StreamingMenu({ platform, onPlatform, gains }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const chosen = platformById(platform);

  // Close on Escape or a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", close, true);
    window.addEventListener("mousedown", close, true);
    return () => {
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("mousedown", close, true);
    };
  }, [open]);

  return (
    <div className="export streaming" ref={ref}>
      <button
        className={`toggle${chosen ? " on" : ""}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          chosen
            ? `Hearing every track as ${chosen.name} plays it (${chosen.target} LUFS)`
            : "Streaming preview: hear every track at the level a streaming platform would play it"
        }
      >
        {chosen ? `${chosen.name} ${chosen.target}` : "Streaming"}
        <Chevron />
      </button>
      {open && (
        <div className="export-menu streaming-menu" role="menu">
          <div className="export-title">Play as on</div>
          <button role="menuitemradio" aria-checked={!chosen} className={!chosen ? "on" : ""} onClick={() => onPlatform(null)}>
            <span className="streaming-name">Off</span>
          </button>
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              role="menuitemradio"
              aria-checked={platform === p.id}
              className={platform === p.id ? "on" : ""}
              onClick={() => onPlatform(p.id)}
              title={`${p.note}${p.published ? "" : " (Not published by the platform.)"}`}
            >
              <span className="streaming-name">{p.name}</span>
              <span className="streaming-target">
                {p.target} LUFS{p.published ? "" : "*"}
              </span>
            </button>
          ))}
          {chosen && (
            <div className="streaming-detail">
              <p className="export-status">{chosen.note}</p>
              {gains.length > 0 && (
                <div className="streaming-gains">
                  {gains.map((g) => (
                    <span key={g.label} style={{ color: `var(--lane-${g.label.toLowerCase()})` }}>
                      {g.label} {g.gain === null ? "…" : `${signed(g.gain)} dB`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          <p className="export-status">* Not published by the platform: measured by engineers. Spotify publishes its rules.</p>
        </div>
      )}
    </div>
  );
}
