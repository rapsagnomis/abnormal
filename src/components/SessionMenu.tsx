import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../lib/api";
import type { RecentSession } from "../lib/api";
import { Chevron } from "./Chevron";
import { flash } from "../lib/motion";

/** Saved: a green ring out of the button. */
const SAVED_RING: Keyframe[] = [
  { boxShadow: "0 0 0 0 rgba(74, 222, 128, 0.75)" },
  { boxShadow: "0 0 0 6px rgba(74, 222, 128, 0)" },
];
/** How long the button reads "Saved" after a save. */
const SAVED_MS = 1600;

interface Props {
  /** The open session's name, or null when the lanes aren't one. */
  name: string | null;
  /** The lanes differ from the session as saved. */
  modified: boolean;
  /** Some track is loaded, so there's something to save. */
  canSave: boolean;
  /** Counts saves: each new value shows the "Saved" feedback. */
  saves: number;
  onOpen: () => void;
  /** A clean session (the open one is saved first). */
  onNew: () => void;
  onOpenPath: (path: string) => void;
  onSave: () => void;
  onSaveAs: () => void;
}

const MENU_WIDTH = 270;

/** "Session ▾": open, save, and the recent sessions one click away. */
export function SessionMenu({ name, modified, canSave, saves, onOpen, onNew, onOpenPath, onSave, onSaveAs }: Props) {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const [recent, setRecent] = useState<RecentSession[]>([]);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!saves) return;
    setJustSaved(true);
    flash(button.current, SAVED_RING, 700);
    const timer = setTimeout(() => setJustSaved(false), SAVED_MS);
    return () => clearTimeout(timer);
  }, [saves]);

  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node))) return;
      if (e instanceof KeyboardEvent) e.stopPropagation();
      setPos(null);
    };
    window.addEventListener("keydown", close, true);
    window.addEventListener("mousedown", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  const toggle = () => {
    if (pos || !button.current) return setPos(null);
    const r = button.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8)), top: r.bottom + 4, width: MENU_WIDTH });
    api.recentSessions().then(setRecent).catch(() => setRecent([]));
  };
  const pick = (action: () => void) => {
    setPos(null);
    action();
  };

  return (
    <>
      <button
        ref={button}
        className={`session-button${pos ? " open" : ""}${justSaved ? " saved" : ""}`}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        title={name ? `Session “${name}”${modified ? " (changed since saved)" : ""}: open, save, recent sessions` : "Sessions: save these tracks in order, open one, or a recent one"}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 6h11M4 12h11M4 18h7M18 14v7M14.5 17.5 18 21l3.5-3.5" />
        </svg>
        <span className="session-name">{justSaved ? `Saved ${name ?? ""}`.trim() : (name ?? "Session")}</span>
        {justSaved ? (
          <span className="session-saved-check" aria-hidden="true">✓</span>
        ) : (
          name && modified && <span className="session-modified" aria-label="changed since saved" />
        )}
        <Chevron />
      </button>
      {pos && (
        <div ref={menu} className="load-menu session-menu" role="menu" style={pos}>
          <button role="menuitem" onClick={() => pick(onNew)} title={name ? `Save “${name}”, then start with empty tracks` : "Start with empty tracks"}>
            <span className="load-menu-name">New session</span>
            <kbd>⌘N</kbd>
          </button>
          <button role="menuitem" onClick={() => pick(onOpen)}>
            <span className="load-menu-name">Open session…</span>
            <kbd>⌘O</kbd>
          </button>
          <button role="menuitem" disabled={!canSave} onClick={() => pick(onSave)}>
            <span className="load-menu-name">{name ? `Save “${name}”` : "Save session…"}</span>
            <kbd>⌘S</kbd>
          </button>
          <button role="menuitem" disabled={!canSave} onClick={() => pick(onSaveAs)}>
            <span className="load-menu-name">Save session as…</span>
            <kbd>⇧⌘S</kbd>
          </button>
          <div className="session-menu-heading">Open recent</div>
          {recent.length === 0 && <div className="session-menu-empty">No recent sessions</div>}
          {recent.map((r) => (
            <button key={r.path} role="menuitem" onClick={() => pick(() => onOpenPath(r.path))} title={r.path}>
              <span className="load-menu-name">{r.name}</span>
              <span className="session-menu-count">
                {r.tracks} track{r.tracks === 1 ? "" : "s"}
              </span>
            </button>
          ))}
          {recent.length > 0 && (
            <button
              role="menuitem"
              className="session-menu-clear"
              onClick={() => {
                setRecent([]);
                api.clearRecentSessions();
              }}
            >
              <span className="load-menu-name">Clear recent</span>
            </button>
          )}
        </div>
      )}
    </>
  );
}
