import { useEffect, useRef } from "react";
import type { Slot } from "../lib/api";
import { flash, RING } from "../lib/motion";
import { pairColors } from "../lib/pair";
import type { ComparedPair } from "../lib/pair";

/** What the current song can be compared with, as picked here. */
export type CompareChoice = { kind: "own"; index: number } | { kind: "default" } | { kind: "lane"; slot: Slot };

interface Props {
  pair: ComparedPair;
  /** The current song's name. */
  songName: string | null;
  /** Its own references (label "R3", title), the one in use first among equals by `index`. */
  own: { index: number; label: string; title: string }[];
  /** The session's default reference, when loaded. */
  defaultReference: { label: string; title: string } | null;
  /** The other loaded lanes. */
  lanes: { slot: Slot; label: string; title: string }[];
  /** What it's compared with now, or null (no reference). */
  current: CompareChoice | null;
  onChoose: (choice: CompareChoice) => void;
  onAddReference: () => void;
  /** Make the reference in use the session's default; null when it already is (or there's none). */
  onUseForAll: (() => void) | null;
}

const encode = (c: CompareChoice | null) => (!c ? "none" : c.kind === "own" ? `own:${c.index}` : c.kind === "default" ? "default" : `lane:${c.slot}`);

/** "Current 3 · Song — Compared with [R3 · Its reference ▾]": the song you listen to, and what it's
 *  compared with. The reference belongs to the song: its own, else the default, or a lane. */
export function ComparedWith(p: Props) {
  const [track, reference] = p.pair.slots;
  const [trackLabel] = p.pair.labels;
  const trackRef = useRef<HTMLSpanElement>(null);
  const referenceRef = useRef<HTMLSelectElement>(null);
  useChanged(track, () => flash(trackRef.current, RING, 420));
  useChanged(reference, () => flash(referenceRef.current, RING, 420));

  const pick = (value: string) => {
    if (value === "add") return p.onAddReference();
    if (value === "all") return p.onUseForAll?.();
    if (value === "default") return p.onChoose({ kind: "default" });
    const [kind, n] = value.split(":");
    if (kind === "own") p.onChoose({ kind: "own", index: Number(n) });
    if (kind === "lane") p.onChoose({ kind: "lane", slot: Number(n) as Slot });
  };

  return (
    <div className="pair-picker" style={pairColors(p.pair.labels)}>
      <span ref={trackRef} className="pair-song col-a" title="The song you're listening to: it's analysed, EQ-matched and auditioned against its reference">
        {trackLabel}
        {p.songName && <span className="pair-song-name"> · {p.songName}</span>}
      </span>
      <span className="scope-label pair-vs">Compared with</span>
      <select
        ref={referenceRef}
        className="col-b"
        value={encode(p.current)}
        onChange={(e) => pick(e.target.value)}
        title="The song's reference: its own, else the session's default; or another track"
      >
        {!p.current && <option value="none">No reference</option>}
        {p.own.length > 0 && (
          <optgroup label="This song's references">
            {p.own.map((r) => (
              <option key={r.index} value={`own:${r.index}`}>
                {r.label} · {r.title}
              </option>
            ))}
          </optgroup>
        )}
        {p.defaultReference && (
          <optgroup label="Default reference">
            <option value="default">
              {p.defaultReference.label} · {p.defaultReference.title}
            </option>
          </optgroup>
        )}
        {p.lanes.length > 0 && (
          <optgroup label="Another track">
            {p.lanes.map((l) => (
              <option key={l.slot} value={`lane:${l.slot}`}>
                {l.label} · {l.title}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="―">
          <option value="add">+ Add a reference to this song…</option>
          <option value="all" disabled={!p.onUseForAll}>
            Use for all songs (as the default reference)
          </option>
        </optgroup>
      </select>
    </div>
  );
}

/** Run `effect` when `value` changes after the first render. */
function useChanged<T>(value: T, effect: () => void) {
  const last = useRef(value);
  useEffect(() => {
    if (last.current !== value) effect();
    last.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}
