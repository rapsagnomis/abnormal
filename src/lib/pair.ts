import { createContext, useContext } from "react";
import type { CSSProperties } from "react";
import type { Slot } from "./api";

/**
 * The compared pair: the track (side 0, the one being worked on) and the reference (side 1).
 * With more than two tracks loaded, every analysis, the EQ match and export are one-to-one
 * between these two; the track follows whatever is being listened to, the reference is pinned.
 */
export interface ComparedPair {
  /** Engine slots of the track and the reference. */
  slots: [Slot, Slot];
  /** Their lane letters, e.g. ["C", "B"]. */
  labels: [string, string];
}

export const PairContext = createContext<ComparedPair>({ slots: [0, 1], labels: ["A", "B"] });

export const usePair = () => useContext(PairContext);

/** Points `--a`/`--b` and `--series-a`/`--series-b` at the pair's lane colours, for an element
 *  whose contents draw the pair (columns, charts, the picker). */
export function pairColors([track, reference]: [string, string]): CSSProperties {
  const [a, b] = [track.toLowerCase(), reference.toLowerCase()];
  return {
    "--a": `var(--lane-${a})`,
    "--b": `var(--lane-${b})`,
    "--series-a": `var(--series-lane-${a})`,
    "--series-b": `var(--series-lane-${b})`,
  } as CSSProperties;
}
