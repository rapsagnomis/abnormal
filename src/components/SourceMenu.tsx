import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Chevron } from "./Chevron";

const MENU_WIDTH = 190;

interface Props {
  /** The button's label: "Open", "Add", "Replace". */
  label: string;
  /** Extra class for the button, to fit where it sits. */
  className?: string;
  title?: string;
  disabled?: boolean;
  /** Pick a file in the file dialog. */
  onFile: () => void;
  /** Open the Library drawer to load from it. */
  onLibrary: () => void;
}

/** A lane's Open / Add / Replace button: a small menu to take the file from disk or from the Library. */
export function SourceMenu(p: Props) {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Close on Escape, a click elsewhere, scrolling or resizing (the menu is fixed in the window).
  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && (menu.current?.contains(e.target as Node) || button.current?.contains(e.target as Node))) return;
      if (e instanceof KeyboardEvent) e.stopPropagation();
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

  const toggle = () => {
    if (pos || !button.current) return setPos(null);
    const r = button.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    // Near the bottom of the window it opens upwards.
    setPos(window.innerHeight - r.bottom > 90 ? { left, top: r.bottom + 4 } : { left, bottom: window.innerHeight - r.top + 4 });
  };
  const pick = (action: () => void) => {
    setPos(null);
    action();
  };

  return (
    <>
      <button
        ref={button}
        className={`load-menu-button source-menu-button${p.className ? ` ${p.className}` : ""}${pos ? " open" : ""}`}
        onClick={toggle}
        disabled={p.disabled}
        title={p.title}
        aria-haspopup="menu"
        aria-expanded={!!pos}
      >
        {p.label}
        <Chevron />
      </button>
      {pos && (
        <div ref={menu} className="load-menu" role="menu" style={{ ...pos, width: MENU_WIDTH }}>
          <button role="menuitem" onClick={() => pick(p.onFile)} title="Choose a file on disk">
            <FileIcon />
            <span className="load-menu-name">From File…</span>
          </button>
          <button role="menuitem" onClick={() => pick(p.onLibrary)} title="Open the Library (⌘K) to load a track from it">
            <LibraryIcon />
            <span className="load-menu-name">From Library</span>
            <kbd className="source-menu-key">⌘K</kbd>
          </button>
        </div>
      )}
    </>
  );
}

function FileIcon() {
  return (
    <svg className="source-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

/** Books on a shelf, as on the Library button. */
function LibraryIcon() {
  return (
    <svg className="source-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19V5M8.5 19V5M13 19 11.5 5.5M16 19.5l3.5-13.5" />
      <path d="M3 20h18" />
    </svg>
  );
}
