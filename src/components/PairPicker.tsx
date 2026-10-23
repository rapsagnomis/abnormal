import { useEffect, useRef } from "react";
import type { Slot } from "../lib/api";
import { flash, RING } from "../lib/motion";
import { pairColors } from "../lib/pair";
import type { ComparedPair } from "../lib/pair";

interface Props {
  pair: ComparedPair;
  /** Lanes that can be put in the pair, in lane order. */
  lanes: { slot: Slot; label: string; loaded: boolean }[];
  onPairTrack: (slot: Slot) => void;
  onPairReference: (slot: Slot) => void;
}

/** Which two tracks are compared: the mix (the one listened to) vs the pinned reference. */
export function PairPicker(p: Props) {
  const [track, reference] = p.pair.slots;
  // The picks change on their own (Tab to another track, a pin): ring the one that moved.
  const trackRef = useRef<HTMLSelectElement>(null);
  const referenceRef = useRef<HTMLSelectElement>(null);
  useChanged(track, () => flash(trackRef.current, RING, 420));
  useChanged(reference, () => flash(referenceRef.current, RING, 420));
  // Loaded lanes, plus the current pick even while it's empty, so the picker always shows the pair.
  const options = (current: Slot) => p.lanes.filter((l) => l.loaded || l.slot === current);
  return (
    <div className="pair-picker" style={pairColors(p.pair.labels)}>
      <span className="scope-label">Mix</span>
      <select
        ref={trackRef}
        className="col-a"
        value={track}
        onChange={(e) => p.onPairTrack(Number(e.target.value) as Slot)}
        title="The mix: analysed against the reference, EQ-matched, auditioned and exported. Always the track you listen to: picking one here switches to it."
      >
        {options(track).map((l) => (
          <option key={l.slot} value={l.slot} disabled={l.slot === reference}>
            {l.label}
          </option>
        ))}
      </select>
      <span className="scope-label pair-vs">Reference</span>
      <select
        ref={referenceRef}
        className="col-b"
        value={reference}
        onChange={(e) => p.onPairReference(Number(e.target.value) as Slot)}
        title="The reference: the mix is compared with it (pinned)"
      >
        {options(reference).map((l) => (
          <option key={l.slot} value={l.slot}>
            {l.label}
          </option>
        ))}
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
