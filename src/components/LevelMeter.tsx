import { useRef } from "react";

/** Meter range: silence at the bottom, full scale at the top. */
const FLOOR_DB = -48;
/** Falls back this fast, dB per second, so peaks stay readable. */
const RELEASE_DB_PER_S = 30;

/**
 * A thin vertical peak meter for a track button: instant attack, steady release. `level` is the
 * engine's linear peak, refreshed every animation frame with the transport.
 */
export function LevelMeter({ level }: { level: number }) {
  const state = useRef({ db: FLOOR_DB, at: performance.now() });
  const now = performance.now();
  const target = level > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(level)) : FLOOR_DB;
  const fallen = state.current.db - ((now - state.current.at) / 1000) * RELEASE_DB_PER_S;
  const db = Math.max(target, fallen, FLOOR_DB);
  state.current = { db, at: now };
  const fill = (db - FLOOR_DB) / -FLOOR_DB;
  return (
    <span className={`level-meter${db > -1 ? " hot" : ""}`} aria-hidden="true">
      <span style={{ transform: `scaleY(${fill})` }} />
    </span>
  );
}
