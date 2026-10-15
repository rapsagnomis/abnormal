import type { ReactNode } from "react";

interface Props {
  matchEnabled: boolean;
  /** What loudness matching is based on, for the tooltip. */
  matchBasis: string;
  onToggleMatch: () => void;
  /** Suggested EQ is playing on A. */
  eqOn: boolean;
  /** There are suggested moves to audition. */
  eqAvailable: boolean;
  onToggleEq: () => void;
  /** EQ is on but not heard yet: the match is being fitted or the full match rendered. */
  eqBusy: boolean;
  /** Letter of the compared track, which the EQ is auditioned on. */
  trackLabel: string;
  /** The export button and its menu, after EQ. */
  children: ReactNode;
}

/** How the compared pair is heard (loudness match, EQ audition), then export, in the top bar. */
export function MatchControls(p: Props) {
  return (
    <div className="match-controls">
      <button
        className={`toggle${p.matchEnabled ? " on" : ""}`}
        onClick={p.onToggleMatch}
        title={`Match loudness (M): turn the louder tracks down to the quietest, based on ${p.matchBasis}`}
      >
        Loudness Match
      </button>
      <button
        className={`toggle${p.eqOn ? " on" : ""}${p.eqBusy ? " busy" : ""}`}
        onClick={p.onToggleEq}
        disabled={!p.eqAvailable && !p.eqOn}
        title={
          p.eqBusy
            ? `Preparing the EQ for ${p.trackLabel}…`
            : `Audition the suggested EQ on ${p.trackLabel} (E), level-compensated. Choose moves in the EQ match section of the Tonal tab.`
        }
      >
        EQ
      </button>
      <span className="bar-divider" aria-hidden="true" />
      {p.children}
    </div>
  );
}
