import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { withMod } from "../lib/platform";

/** Shown once, on the first launch; the app menu's Getting started brings it back. */
const SEEN_KEY = "tourSeen";

export const tourSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return true; // Storage unavailable: don't pester on every launch.
  }
};

const markSeen = () => {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Not remembered: it shows again next launch.
  }
};

interface Step {
  title: string;
  body: ReactNode;
  /** What the step points at (the first match); none, or not on screen: the card sits centred. */
  target?: string;
}

const STEPS: Step[] = [
  {
    title: "Welcome to (a/b)normal",
    body: <p>Compare your mixes with reference tracks, side by side.</p>,
  },
  {
    title: "Your songs",
    target: ".lanes > .lane",
    body: <p>Drop audio files on a lane. Drag on a waveform to select and loop.</p>,
  },
  {
    title: "The reference",
    target: "[data-default-ref]",
    body: (
      <p>
        Drop a track to compare against. <kbd>Tab</kbd> flips to it.
      </p>
    ),
  },
  {
    title: "Versions",
    target: ".lanes > .lane .lane-tile",
    body: <p>Click a song's title to add its other bounces.</p>,
  },
  {
    title: "Compare fairly",
    target: ".compare-bar",
    body: (
      <p>
        <kbd>M</kbd> matches loudness. <kbd>E</kbd> plays the suggested EQ.
      </p>
    ),
  },
  {
    title: "Play",
    target: ".transport",
    body: (
      <p>
        <kbd>Space</kbd> plays all lanes in sync. <kbd>1</kbd>–<kbd>8</kbd> switch.
      </p>
    ),
  },
  {
    title: "Analysis",
    target: ".analysis-toggle",
    body: (
      <p>
        Loudness, dynamics, tone and stereo. <kbd>A</kbd>
      </p>
    ),
  },
  {
    title: "Library",
    target: ".library-toggle",
    body: (
      <p>
        Find references that sound like your mix. <kbd>{withMod("K")}</kbd>
      </p>
    ),
  },
  {
    title: "Sessions",
    target: ".app-title",
    body: (
      <p>
        Save, export, and this tour again. <kbd>?</kbd> lists every shortcut.
      </p>
    ),
  },
];

/** Room left around a highlighted part, px. */
const PAD = 6;
/** Gap between the highlight and the card, and from the window's edges. */
const GAP = 12;
const CARD_WIDTH = 300;

type Box = { top: number; left: number; width: number; height: number };

const boxOf = (selector?: string): Box | null => {
  const el = selector ? document.querySelector<HTMLElement>(selector) : null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
};

const same = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

/** Where the card goes: under the highlight, else above it, else inside its bottom edge. */
function cardPlace(box: Box | null, cardHeight: number): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(CARD_WIDTH, vw - GAP * 2);
  if (!box) return { width, left: (vw - width) / 2, top: Math.max(GAP, (vh - cardHeight) / 2) };
  const left = Math.min(Math.max(GAP, box.left), vw - width - GAP);
  if (box.top + box.height + GAP + cardHeight <= vh - GAP) return { width, left, top: box.top + box.height + GAP };
  if (box.top - GAP - cardHeight >= GAP) return { width, left, top: box.top - GAP - cardHeight };
  return { width, left, top: Math.max(GAP, Math.min(box.top + box.height, vh) - cardHeight - GAP) };
}

/** A guided tour of the app: a card per step, pointing at the part it describes (the rest dims).
 *  ← → / Enter move through it; Esc or Skip ends it. Nothing in the app reacts while it's open. */
export function Tour({ onClose, onExample }: { onClose: () => void; onExample: () => void }) {
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [cardHeight, setCardHeight] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  const close = () => {
    markSeen();
    onClose();
  };
  const next = () => (last ? close() : setIndex((i) => i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));
  const actions = useRef({ next, back, close });
  actions.current = { next, back, close };

  // Follow the highlighted part as the layout moves (the panel sliding, the window resizing).
  useEffect(() => {
    if (step.target) document.querySelector(step.target)?.scrollIntoView({ block: "nearest" });
    let frame = 0;
    let shown: Box | null = null;
    const follow = () => {
      const now = boxOf(step.target);
      if (!same(now, shown)) setBox((shown = now));
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [step.target]);

  useLayoutEffect(() => {
    setCardHeight(card.current?.offsetHeight ?? 0);
  }, [index]);

  // Keys go to the tour only (Space mustn't start playback behind it).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      e.stopPropagation();
      const { next, back, close } = actions.current;
      const act = ({ Escape: close, Enter: next, ArrowRight: next, ArrowLeft: back } as Record<string, () => void>)[e.key];
      if (!act) return; // Tab still moves focus between the card's buttons.
      e.preventDefault();
      act();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className={`tour-spotlight${box ? "" : " none"}`} style={box ?? undefined} aria-hidden="true" />
      <div ref={card} className="tour-card" style={cardPlace(box, cardHeight)} tabIndex={-1} key={index}>
        <div className="tour-top">
          <span className="tour-count">
            {index + 1} of {STEPS.length}
          </span>
          <div className="tour-dots" aria-hidden="true">
            {STEPS.map((_, i) => (
              <span key={i} className={i === index ? "on" : ""} />
            ))}
          </div>
        </div>
        <h2 id="tour-title">{step.title}</h2>
        <div className="tour-body">{step.body}</div>
        <div className="tour-actions">
          {!last && (
            <button className="tour-skip" onClick={close}>
              Skip
            </button>
          )}
          {index > 0 && <button onClick={back}>Back</button>}
          {index === 0 && (
            <button
              onClick={() => {
                onExample();
                next();
              }}
              title="Load two example songs and take the tour over them"
            >
              Try the example
            </button>
          )}
          <button className="tour-next" onClick={next} autoFocus>
            {last ? "Get started" : index === 0 ? "Show me" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
