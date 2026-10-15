import { createContext, useContext } from "react";
import { SLOTS } from "../lib/api";
import type { ABSlot } from "../lib/api";
import { flash, LOADED_ROW, RING } from "../lib/motion";
import { usePair } from "../lib/pair";

/** Click feedback: ring the button, tint its row. */
const clickFeedback = (button: HTMLElement) => {
  flash(button, RING, 420);
  flash(button.closest(".match"), LOADED_ROW, 650);
};

/** Loading a file into a new lane: the first empty one, or one opened for it (C, D, … up to H). */
export interface LoadNew {
  /** Letter of the lane it would go to, or null when all eight are in use. */
  label: string | null;
  load: (path: string) => void;
}
export const LoadNewContext = createContext<LoadNew | null>(null);

/** "Load A" / "Load B" for a file, into the compared pair's lanes (whatever their letters);
 *  shows "In A" when it, or one of its `copies`, is loaded there. */
export function LoadButtons({
  path,
  copies = [],
  paths,
  onLoad,
}: {
  path: string;
  copies?: string[];
  paths: [string | null, string | null];
  onLoad: (side: ABSlot, path: string) => void;
}) {
  const { labels } = usePair();
  const loadNew = useContext(LoadNewContext);
  return (
    <>
      {SLOTS.map((slot) => {
        const loaded = paths[slot] === path || copies.includes(paths[slot] ?? "");
        const label = labels[slot];
        return (
          <button
            key={slot}
            className={`${slot ? "col-b" : "col-a"}${loaded ? " on" : ""}`}
            onClick={(e) => {
              clickFeedback(e.currentTarget);
              onLoad(slot, path);
            }}
            title={loaded ? `Loaded in ${label}: click to reload` : `Load in ${label}`}
          >
            {loaded ? `In ${label}` : `Load ${label}`}
          </button>
        );
      })}
      {loadNew && (
        <button
          className="load-new"
          onClick={(e) => {
            clickFeedback(e.currentTarget);
            loadNew.load(path);
          }}
          disabled={!loadNew.label}
          title={loadNew.label ? `Load into a new track (${loadNew.label})` : "All eight tracks are in use"}
        >
          + New
        </button>
      )}
    </>
  );
}
