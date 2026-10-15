import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

/** A written file: where it is, and what was applied (gain, loudness, peak). */
export interface ExportResult {
  path: string;
  details: string;
}

export interface ExportOptions {
  eq: boolean;
  loudness: boolean;
  /** 32-bit float instead of 24-bit PCM. */
  float: boolean;
}

interface Props {
  /** Letters of the compared track (exported) and the reference. */
  labels: [string, string];
  /** The compared track is loaded and measured. */
  available: boolean;
  /** What the EQ match would render ("chosen moves", "full match"), or null if there is none. */
  eqLabel: string | null;
  /** The reference is measured, so the track can be matched to its loudness. */
  canMatchLoudness: boolean;
  /** What's switched on for playback, used as the starting choice each time the menu opens. */
  eqOn: boolean;
  matchOn: boolean;
  /** Ask where to save and write the file; resolves to what was written, or null if cancelled. */
  onExport: (options: ExportOptions) => Promise<ExportResult | null>;
}

/** Export button and its options: the compared track with the EQ match and/or loudness match, as WAV. */
export function ExportMenu(p: Props) {
  const [a, b] = p.labels;
  const [open, setOpen] = useState(false);
  const [eq, setEq] = useState(false);
  const [loudness, setLoudness] = useState(false);
  const [float, setFloat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean; saved?: ExportResult } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const useEq = eq && p.eqLabel !== null;
  const useLoudness = loudness && p.canMatchLoudness;

  // Close on Escape or a click elsewhere (not while writing, so the result stays visible).
  useEffect(() => {
    if (!open || busy) return;
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
  }, [open, busy]);

  const toggle = () => {
    if (!open) {
      setEq(p.eqOn);
      setLoudness(p.matchOn);
      setStatus(null);
    }
    setOpen(!open);
  };

  const run = async () => {
    setBusy(true);
    setStatus({ text: "Rendering…" });
    try {
      const saved = await p.onExport({ eq: useEq, loudness: useLoudness, float });
      setStatus(saved ? { text: saved.details, saved } : null);
    } catch (err) {
      setStatus({ text: String(err), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="export" ref={ref}>
      <button
        className={`icon-button${open ? " on" : ""}${busy ? " busy" : ""}`}
        onClick={toggle}
        disabled={!p.available}
        title={`Export ${a} with the EQ match and/or loudness match to ${b}, as WAV`}
        aria-label="Export"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5" />
          <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </svg>
      </button>
      {open && (
        <div className="export-menu" role="dialog" aria-label={`Export ${a}`}>
          <div className="export-title">Export {a}</div>
          <label title={p.eqLabel ? "The EQ match as auditioned (choose moves or the full match in the EQ match tab)" : `No EQ match yet: load and measure ${a} and ${b}`}>
            <input type="checkbox" checked={useEq} disabled={!p.eqLabel || busy} onChange={(e) => setEq(e.target.checked)} />
            EQ match{p.eqLabel ? ` (${p.eqLabel})` : ""}
          </label>
          <label title={p.canMatchLoudness ? `Set ${a}'s integrated loudness to ${b}'s (may boost)` : `Load and measure ${b} to match its loudness`}>
            <input
              type="checkbox"
              checked={useLoudness}
              disabled={!p.canMatchLoudness || busy}
              onChange={(e) => setLoudness(e.target.checked)}
            />
            Loudness match to {b}
          </label>
          <label title="Keep peaks above 0 dBFS instead of clipping them (a loudness match may boost)">
            <input type="checkbox" checked={float} disabled={busy} onChange={(e) => setFloat(e.target.checked)} />
            32-bit float
          </label>
          <button onClick={run} disabled={busy || (!useEq && !useLoudness)}>
            Export WAV…
          </button>
          {status?.saved ? (
            <div className="export-status export-saved">
              <span>
                <span className="export-check">✓</span>Saved {status.saved.path.split("/").pop()}
              </span>
              <span className="chart-note">{status.text}</span>
              <button onClick={() => revealItemInDir(status.saved!.path).catch(() => {})}>Reveal in Finder</button>
            </div>
          ) : (
            status && <div className={`export-status${status.error ? " error" : ""}`}>{status.text}</div>
          )}
        </div>
      )}
    </div>
  );
}
