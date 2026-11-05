import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { SLOT_COUNT } from "../lib/api";
import type { Slot } from "../lib/api";
import { flash, LOADED_ROW, RING } from "../lib/motion";
import { Chevron } from "./Chevron";

/** Click feedback: ring the button, tint its row. */
const clickFeedback = (button: HTMLElement | null) => {
  if (!button) return;
  flash(button, RING, 420);
  flash(button.closest(".match"), LOADED_ROW, 650);
};

/** Where the library can load a file: every lane in display order, or a new one. */
export interface LoadTargets {
  lanes: { slot: Slot; label: string; path: string | null; name: string | null }[];
  into: (slot: Slot, path: string) => void;
  /** What the library was opened for from a lane's menu (its number and what loading does), shown
   *  first; null when it was opened on its own. */
  target: { label: string; text: string; load: (path: string) => void } | null;
  /** Add the file as a reference of the current song (its lane number and name), or null
   *  without one. */
  asReference: { label: string; name: string; add: (path: string) => void } | null;
  /** Make the file the session's default reference. */
  asDefault: (path: string) => void;
  /** Letter of the lane "New track" would go to (the first empty one, else a new one), or null
   *  when all 50 are in use. */
  newLabel: string | null;
  loadNew: (path: string) => void;
  /** Start dragging a file from a row (pointer down): dropping it on a lane loads it there. */
  drag: (item: DragItem, e: ReactPointerEvent) => void;
}
/** A file being dragged out of the library, shown under the pointer. */
export interface DragItem {
  path: string;
  title: string;
  /** Image URL, ready for `src`. */
  cover: string | null;
}
export const LoadTargetsContext = createContext<LoadTargets | null>(null);

/** Menu width, px; it opens right-aligned under the button, or above it near the bottom. */
const MENU_WIDTH = 230;

/** "Load ▾" for a file: a small menu to load it into any lane (A, B, C…) or a new track. Reads
 *  "In A" when it, or one of its `copies`, is loaded in a lane. */
export function LoadMenu({ path, copies = [] }: { path: string; copies?: string[] }) {
  const targets = useContext(LoadTargetsContext);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Close on Escape, a click elsewhere, or scrolling (the menu is fixed, the row would move away).
  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node))) return;
      setPos(null);
    };
    const onScroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) setPos(null);
    };
    window.addEventListener("keydown", close, true);
    window.addEventListener("mousedown", close, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  if (!targets) return null;
  const isHere = (p: string | null) => p !== null && (p === path || copies.includes(p));
  const loadedIn = targets.lanes.filter((l) => isHere(l.path)).map((l) => l.label);

  const toggle = () => {
    if (pos || !button.current) return setPos(null);
    const r = button.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    // Rows near the bottom of the window open upwards.
    const below = window.innerHeight - r.bottom > 40 + 30 * (targets.lanes.length + 3);
    setPos(below ? { left, top: r.bottom + 4 } : { left, bottom: window.innerHeight - r.top + 4 });
  };
  const pick = (load: () => void) => {
    setPos(null);
    clickFeedback(button.current);
    load();
  };

  return (
    <>
      <button
        ref={button}
        className={`load-menu-button${loadedIn.length ? " on" : ""}${pos ? " open" : ""}`}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        title={loadedIn.length ? `Loaded in ${loadedIn.join(", ")}: choose a track to load it into` : "Choose a track to load it into"}
      >
        {loadedIn.length ? `In ${loadedIn.join(", ")}` : "Load"}
        <Chevron />
      </button>
      {pos && (
        <div ref={menu} className="load-menu" role="menu" style={{ ...pos, width: MENU_WIDTH }}>
          {targets.target && (
            <button
              role="menuitem"
              className="load-menu-target"
              style={{ "--lane-color": `var(--lane-${targets.target.label.toLowerCase()})` } as CSSProperties}
              onClick={() => pick(() => targets.target!.load(path))}
              title={`${targets.target.text} (what the Library was opened for)`}
            >
              <span className="load-menu-letter">{targets.target.label}</span>
              <span className="load-menu-name">{targets.target.text}</span>
            </button>
          )}
          {targets.lanes.map((lane) => (
            <button
              key={lane.slot}
              role="menuitem"
              style={{ "--lane-color": `var(--lane-${lane.label.toLowerCase()})` } as CSSProperties}
              onClick={() => pick(() => targets.into(lane.slot, path))}
              title={isHere(lane.path) ? `Loaded in ${lane.label}: click to reload` : lane.name ? `Replace ${lane.name} in ${lane.label}` : `Load in ${lane.label}`}
            >
              <span className="load-menu-letter">{lane.label}</span>
              <span className="load-menu-name">{lane.name ?? "Empty"}</span>
              {isHere(lane.path) && <span className="load-menu-check">✓</span>}
            </button>
          ))}
          {targets.asReference && (
            <button
              role="menuitem"
              className="load-menu-new"
              style={{ "--lane-color": `var(--lane-${targets.asReference.label.toLowerCase()})` } as CSSProperties}
              onClick={() => pick(() => targets.asReference!.add(path))}
              title={`Add as a reference of ${targets.asReference.name} (${targets.asReference.label}): it's compared with it, and shown under its lane`}
            >
              <span className="load-menu-letter">R</span>
              <span className="load-menu-name">Reference of {targets.asReference.label} · {targets.asReference.name}</span>
            </button>
          )}
          <button
            role="menuitem"
            className="load-menu-new"
            style={{ "--lane-color": "var(--lane-r)" } as CSSProperties}
            onClick={() => pick(() => targets.asDefault(path))}
            title="Make it the default reference: every song without its own is compared with it"
          >
            <span className="load-menu-letter">R</span>
            <span className="load-menu-name">Default reference</span>
          </button>
          <button
            role="menuitem"
            className="load-menu-new"
            disabled={!targets.newLabel}
            onClick={() => pick(() => targets.loadNew(path))}
            title={targets.newLabel ? `Load into a new track (${targets.newLabel})` : `All ${SLOT_COUNT} tracks are in use`}
          >
            <span className="load-menu-letter">+</span>
            <span className="load-menu-name">New track{targets.newLabel ? ` (${targets.newLabel})` : ""}</span>
          </button>
        </div>
      )}
    </>
  );
}
