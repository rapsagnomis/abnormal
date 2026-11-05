import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { Marker } from "../lib/api";
import { formatTime } from "../lib/format";

interface View {
  start: number;
  end: number;
}

interface Props {
  markers: Marker[];
  view: View;
  /** Time of the marker whose note is being edited, or null. */
  editing: number | null;
  onChange: (markers: Marker[]) => void;
  onEdit: (time: number | null) => void;
}

const NOTE_WIDTH = 260;
/** Typing is saved after this pause (and when the note closes). */
const SAVE_DELAY_MS = 400;

/** Height of a flag row, px; flags that would overlap move down a row. */
const ROW_HEIGHT = 19;
/** Space kept between flags on the same row, px. */
const FLAG_GAP = 4;
/** A press on a flag becomes a drag after this many pixels. */
const DRAG_THRESHOLD = 4;

/** Timestamped markers over a lane: a line with a numbered flag showing its note; click the flag
 *  to open the note in full, like a post-it, and write in it; drag it sideways to move the marker.
 *  Flags that would overlap stack into rows. */
export function MarkerLayer({ markers, view, editing, onChange, onEdit }: Props) {
  const span = view.end - view.start;
  const pct = (t: number) => `${((t - view.start) / span) * 100}%`;
  const flags = useRef(new Map<number, HTMLButtonElement>());
  const index = editing === null ? -1 : markers.findIndex((m) => m.time === editing);
  /** The markers as of this render, for a note saving as it closes (after they may have changed). */
  const current = useRef(markers);
  current.current = markers;

  /** A flag being dragged: the marker's time, and where it would land. */
  const [drag, setDrag] = useState<{ from: number; time: number } | null>(null);
  /** The press that just ended was a drag, not a click. */
  const dragged = useRef(false);
  const shownTime = (t: number) => (drag?.from === t ? drag.time : t);

  /** Press on a flag: past a few pixels it drags the marker along the lane; Esc cancels. */
  const startDrag = (time: number, down: ReactPointerEvent<HTMLButtonElement>) => {
    if (down.button !== 0) return;
    const lane = down.currentTarget.closest(".marker")?.parentElement;
    if (!lane) return;
    const startX = down.clientX;
    let active = false;
    let to = time;
    const timeAt = (x: number) => {
      const r = lane.getBoundingClientRect();
      const t = view.start + Math.min(1, Math.max(0, (x - r.left) / r.width)) * span;
      return Math.max(0, Math.round(t * 100) / 100);
    };
    const move = (e: PointerEvent) => {
      if (!active && Math.abs(e.clientX - startX) < DRAG_THRESHOLD) return;
      if (!active) {
        active = true;
        document.body.classList.add("dragging-marker");
        if (editing !== null) onEdit(null);
      }
      to = timeAt(e.clientX);
      setDrag({ from: time, time: to });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      if (!active) return;
      document.body.classList.remove("dragging-marker");
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
      setDrag(null);
      const list = current.current;
      // Never on top of another marker (markers are told apart by their time).
      while (list.some((m) => m.time === to && m.time !== time)) to = Math.round((to + 0.01) * 100) / 100;
      if (commit && to !== time && list.some((m) => m.time === time)) {
        onChange(list.map((m) => (m.time === time ? { ...m, time: to } : m)));
      }
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
  };

  // Stack the flags: left to right, each goes on the first row where it clears the flag before it.
  // Measured after layout (a flag's width depends on its note); only re-rendered when rows change.
  const [rows, setRows] = useState<Map<number, number>>(new Map());
  useLayoutEffect(() => {
    const placed: number[] = [];
    const next = new Map<number, number>();
    for (const m of markers) {
      const el = flags.current.get(m.time);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      let row = placed.findIndex((right) => r.left >= right + FLAG_GAP);
      if (row < 0) row = placed.length;
      placed[row] = r.right;
      next.set(m.time, row);
    }
    const same = next.size === rows.size && [...next].every(([t, row]) => rows.get(t) === row);
    if (!same) setRows(next);
  });

  /** Write a marker's note, if it's still there (its track may have been closed meanwhile). */
  const setNote = (time: number, note: string) => {
    const list = current.current;
    const m = list.find((m) => m.time === time);
    if (m && m.note !== note) onChange(list.map((m) => (m.time === time ? { ...m, note } : m)));
  };
  /** The note closed: kept with its text, or the marker dropped if it was left empty. */
  const closeNote = (time: number, note: string) => {
    const list = current.current;
    if (note) setNote(time, note);
    else if (list.some((m) => m.time === time)) onChange(list.filter((m) => m.time !== time));
  };

  return (
    <>
      {markers.map((m, i) => {
        const t = shownTime(m.time);
        if (t < view.start || t > view.end) return null;
        return (
          <div
            key={m.time}
            className={`marker${i === index ? " editing" : ""}${drag?.from === m.time ? " dragging" : ""}`}
            style={{ left: pct(t), "--row": rows.get(m.time) ?? 0, "--row-height": `${ROW_HEIGHT}px` } as CSSProperties}
          >
            <button
              ref={(el) => {
                if (el) flags.current.set(m.time, el);
                else flags.current.delete(m.time);
              }}
              className="marker-flag"
              onPointerDown={(e) => {
                e.stopPropagation();
                startDrag(m.time, e);
              }}
              onClick={() => !dragged.current && onEdit(i === index ? null : m.time)}
              onDoubleClick={(e) => e.stopPropagation()}
              title={`${formatTime(t)}${m.note ? ` · ${m.note}` : ""}\nClick to open the note, drag to move the marker`}
              aria-label={`Marker ${i + 1} at ${formatTime(m.time)}${m.note ? `: ${m.note}` : ""}`}
            >
              {i + 1}
              {drag?.from === m.time ? <span className="marker-note">{formatTime(t)}</span> : m.note && <span className="marker-note">{m.note}</span>}
            </button>
          </div>
        );
      })}
      {index >= 0 && (
        <NoteEditor
          key={markers[index].time}
          marker={markers[index]}
          number={index + 1}
          // Looked up after layout: a marker just added has no flag yet while this renders.
          anchor={() => flags.current.get(markers[index].time) ?? null}
          onNote={(note) => setNote(markers[index].time, note)}
          onDone={(note) => closeNote(markers[index].time, note)}
          onDelete={() => {
            onChange(markers.filter((_, i) => i !== index));
            onEdit(null);
          }}
          onClose={() => onEdit(null)}
        />
      )}
    </>
  );
}

/** A marker's note opened in full, like a post-it: one line (wrapped on the paper), saved as it's
 *  typed and on closing (Enter, Esc or a click elsewhere), where an empty note drops its marker;
 *  (−) in the corner deletes the marker. */
function NoteEditor({
  marker,
  number,
  anchor,
  onNote,
  onDone,
  onDelete,
  onClose,
}: {
  marker: Marker;
  number: number;
  /** The marker's flag, to open under. */
  anchor: () => HTMLElement | null;
  onNote: (note: string) => void;
  /** Closing, with the note trimmed (empty: drop the marker). */
  onDone: (note: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState(marker.note);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ note, onNote, onDone, deleted: false });
  latest.current.note = note;
  latest.current.onNote = onNote;
  latest.current.onDone = onDone;

  // Fixed under the flag (above it near the bottom of the window), so the lane's clipping doesn't cut it off.
  useLayoutEffect(() => {
    const flag = anchor();
    if (!flag) return onClose();
    const r = flag.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - NOTE_WIDTH - 8));
    setPos(window.innerHeight - r.bottom > 220 ? { left, top: r.bottom + 4, width: NOTE_WIDTH } : { left, bottom: window.innerHeight - r.top + 4, width: NOTE_WIDTH });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // As tall as its text.
  useLayoutEffect(() => {
    const el = text.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [note, pos]);

  // Saved after a pause in typing, and when the note closes (trimmed; empty drops the marker),
  // unless it was deleted.
  useEffect(() => {
    const timer = setTimeout(() => latest.current.onNote(note), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [note]);
  useEffect(
    () => () => {
      if (!latest.current.deleted) latest.current.onDone(latest.current.note.trim());
    },
    [],
  );

  // A click elsewhere closes it (its own flag closes it too, by toggling).
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor()?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", away, true);
    return () => window.removeEventListener("mousedown", away, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!pos) return null;
  return (
    <div ref={ref} className="note-paper" style={pos} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="note-paper-head">
        <span>
          {number} · {formatTime(marker.time)}
        </span>
        <button
          className="note-paper-delete"
          onClick={() => {
            latest.current.deleted = true;
            onDelete();
          }}
          title="Delete this marker"
          aria-label="Delete this marker"
        >
          −
        </button>
      </div>
      <textarea
        ref={text}
        autoFocus
        rows={2}
        value={note}
        placeholder="Write a note…"
        // One line: pasted line breaks become spaces (long notes still wrap on the paper).
        onChange={(e) => setNote(e.target.value.replace(/\s*\n+\s*/g, " "))}
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape" || e.key === "Enter") {
            e.preventDefault();
            onClose();
          }
        }}
      />
    </div>
  );
}
