import type { Region, SongStructure, StructureSegment } from "./api";

/** Song-part labels in display order; the index also picks the colour (`--section-N`). The
 *  model also says inst / solo / break; "other" is for the user's own corrections. */
export const PART_LABELS = ["intro", "verse", "chorus", "bridge", "inst", "solo", "break", "outro", "other"] as const;

/** Names offered when correcting a part: everything the model can say, plus "other". */
export const EDIT_LABELS = PART_LABELS;

export const partColor = (label: string) => {
  const i = PART_LABELS.indexOf(label as (typeof PART_LABELS)[number]);
  // Eight categorical colours; "other" (and anything unknown) is the neutral grey.
  return i >= 0 && i < 8 ? String(i) : "other";
};

/** A song part with its occurrence number (the 2nd chorus has `ordinal` 1). */
export interface Part extends StructureSegment {
  ordinal: number;
  /** How many parts share this label. */
  count: number;
}

/** The labelled parts, without the silent "start" / "end" pieces. The model often splits a part
 *  into phrases (verse, verse); consecutive ones with the same label are merged. */
export function partsOf(structure: SongStructure): Part[] {
  const parts: StructureSegment[] = [];
  for (const s of structure.segments) {
    if (s.label === "start" || s.label === "end" || s.end <= s.start) continue;
    const last = parts[parts.length - 1];
    if (last && last.label === s.label && Math.abs(last.end - s.start) < 0.05) last.end = s.end;
    else parts.push({ ...s });
  }
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const p of parts) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
  return parts.map((p) => {
    const ordinal = seen.get(p.label) ?? 0;
    seen.set(p.label, ordinal + 1);
    return { ...p, ordinal, count: counts.get(p.label)! };
  });
}

/** The part in `other` that corresponds to `part`: same label, same occurrence (or the last). */
export function matchingPart(part: Part, other: SongStructure): Region | null {
  const same = partsOf(other).filter((p) => p.label === part.label);
  if (same.length === 0) return null;
  const m = same[Math.min(part.ordinal, same.length - 1)];
  return { start: m.start, end: m.end };
}

export const partName = (p: Part) => (p.count > 1 ? `${p.label} ${p.ordinal + 1}` : p.label);

/** Segments with the boundary after part `index` moved to `time` (seconds). */
export function moveBoundary(parts: Part[], index: number, time: number): StructureSegment[] {
  return parts.map((p, i) => ({
    start: i === index + 1 ? time : p.start,
    end: i === index ? time : p.end,
    label: p.label,
  }));
}

/** Segments with part `index` renamed. */
export function rename(parts: Part[], index: number, label: string): StructureSegment[] {
  return parts.map((p, i) => ({ start: p.start, end: p.end, label: i === index ? label : p.label }));
}

/** The downbeat (bar line) nearest to `time`, if within `tolerance` seconds. */
export function snapToBar(structure: SongStructure, time: number, tolerance: number): number {
  let best = time;
  let distance = tolerance;
  for (const d of structure.downbeats) {
    const gap = Math.abs(d - time);
    if (gap < distance) {
      best = d;
      distance = gap;
    }
  }
  return best;
}
