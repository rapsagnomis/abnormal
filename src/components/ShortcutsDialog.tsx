import { useEffect, useRef } from "react";

/** Keys, then what they do, in groups. */
const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: "Playback",
    keys: [
      [["Space"], "Play / pause"],
      [["←", "→"], "Back / forward 5 s"],
      [["⇧←", "⇧→"], "Back / forward 1 s"],
      [["⌘←", "Home"], "Back to the start (or the loop's start)"],
      [["L"], "Loop the selection"],
      [["P"], "Parallel ⇄ Player: tracks together, or one after another"],
    ],
  },
  {
    title: "Tracks",
    keys: [
      [["Tab"], "Switch between the song and its reference"],
      [["1 – 8"], "Listen to track 1–8 (number row: & é \" ' … on AZERTY)"],
      [["⌘↑", "⌘↓"], "Listen to the track above / below"],
      [["K"], "Link the tracks: seek and loop them together"],
      [["N"], "Add a note at the playhead"],
    ],
  },
  {
    title: "Comparing",
    keys: [
      [["M"], "Loudness match"],
      [["E"], "Audition the EQ match"],
      [["A"], "Show / hide the analysis panel"],
      [["⌘K"], "Library"],
    ],
  },
  {
    title: "View",
    keys: [
      [["S"], "Spectrogram / bars"],
      [["C"], "Cycle the curve over the waveform"],
      [["+", "−"], "Zoom in / out"],
      [["0"], "Fit every track (à on AZERTY)"],
      [["⌘ wheel"], "Zoom (or pinch)"],
      [["⇧ wheel"], "Pan (or swipe sideways)"],
      [["Drag"], "Select a passage (⟳ on it loops it)"],
      [["Double-click", "Esc"], "Clear the selection"],
    ],
  },
  {
    title: "Sessions",
    keys: [
      [["⌘N"], "New session"],
      [["⌘O"], "Open a session"],
      [["⌘S"], "Save the session"],
      [["⇧⌘S"], "Save the session as…"],
      [["?"], "These shortcuts"],
    ],
  },
];

/** Every keyboard shortcut, in a pop-up over the app; Esc, ?, a click outside or ✕ closes it. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "?") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", key, true);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);

  return (
    <div className="shortcuts-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1}>
        <header className="shortcuts-header">
          <h2>Keyboard shortcuts</h2>
          <button className="library-drawer-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="shortcuts-groups">
          {GROUPS.map((g) => (
            <section key={g.title} className="shortcuts-group">
              <h3>{g.title}</h3>
              <dl>
                {g.keys.map(([keys, what]) => (
                  <div key={what} className="shortcut">
                    <dt>
                      {keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="chart-note">Click a song's title for its versions and references; the (a/b)normal menu holds sessions and exports.</p>
      </div>
    </div>
  );
}
