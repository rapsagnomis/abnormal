import { SLOT_LABELS, SLOTS } from "../lib/api";
import type { Slot } from "../lib/api";

/** "Load A" / "Load B" for a file; shows "In A" when it, or one of its `copies`, is loaded. */
export function LoadButtons({
  path,
  copies = [],
  paths,
  onLoad,
}: {
  path: string;
  copies?: string[];
  paths: [string | null, string | null];
  onLoad: (slot: Slot, path: string) => void;
}) {
  return (
    <>
      {SLOTS.map((slot) => {
        const loaded = paths[slot] === path || copies.includes(paths[slot] ?? "");
        const label = SLOT_LABELS[slot];
        return (
          <button
            key={slot}
            className={`col-${label.toLowerCase()}${loaded ? " on" : ""}`}
            onClick={() => onLoad(slot, path)}
            title={loaded ? `Loaded in ${label}: click to reload` : `Load in ${label}`}
          >
            {loaded ? `In ${label}` : `Load ${label}`}
          </button>
        );
      })}
    </>
  );
}
