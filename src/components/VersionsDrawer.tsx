import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { LaneVersions, TrackInfo } from "../lib/api";
import { formatDuration } from "../lib/format";

interface Props {
  /** The lane's engine slot: the drawer opens at its title tile. */
  slot: number;
  /** The lane's letter. */
  label: string;
  versions: LaneVersions;
  /** The version in front, once loaded. */
  track: TrackInfo | null;
  /** The version in front is loading. */
  loading: boolean;
  /** Files are being dragged over the drawer (dropping adds them as versions). */
  dropTarget: boolean;
  /** Versions prepared in the background: switching to them is instant. */
  prepared: Set<string>;
  onFront: (index: number) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onRename: (name: string) => void;
  onClose: () => void;
}

const fileName = (path: string) => path.split("/").pop() ?? path;

const WIDTH = 380;
/** Room kept from the window's edges, px. */
const MARGIN = 8;

/** The lane's title tile the drawer hangs from. */
const tileOf = (slot: number) => document.querySelector<HTMLElement>(`.lane[data-slot="${slot}"] .lane-tile`);

/** Under the tile (above it when there's more room there), kept inside the window. */
function placeAt(tile: HTMLElement): CSSProperties {
  const r = tile.getBoundingClientRect();
  const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - WIDTH - MARGIN));
  const below = window.innerHeight - r.bottom - MARGIN;
  const above = r.top - MARGIN;
  return below >= 260 || below >= above
    ? { left, top: r.bottom + 6, width: WIDTH, maxHeight: below - 6 }
    : { left, bottom: window.innerHeight - r.top + 6, width: WIDTH, maxHeight: above - 6 };
}

/** What the song is called when it hasn't been named: the front version's title, else its file. */
export const defaultName = (track: TrackInfo | null, path: string | undefined) =>
  track?.title ?? (path ? fileName(path).replace(/\.[^.]+$/, "") : "");

/** A lane's versions in a drawer hanging from its title tile: name the song, choose the version
 *  in front (the one heard, analysed and shown), add versions (or drop files here), remove them.
 *  A click elsewhere, Esc or the tile closes it. */
export function VersionsDrawer(p: Props) {
  const { versions, track } = p;
  const ref = useRef<HTMLElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const latest = useRef(p);
  latest.current = p;

  // Hang from the tile, and follow it as the lanes scroll, resize or reorder.
  useLayoutEffect(() => {
    let raf = 0;
    let last = "";
    const follow = () => {
      const tile = tileOf(latest.current.slot);
      if (!tile) return latest.current.onClose();
      const next = placeAt(tile);
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setPos(next);
      }
      raf = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(raf);
  }, []);

  // A click elsewhere closes it (its own tile toggles it).
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || tileOf(latest.current.slot)?.contains(target)) return;
      latest.current.onClose();
    };
    window.addEventListener("mousedown", away, true);
    return () => window.removeEventListener("mousedown", away, true);
  }, []);

  if (!pos) return null;
  const frontPath = versions.versions[versions.front];
  const placeholder = defaultName(track, frontPath);
  return (
    <aside
      ref={ref}
      className={`versions-drawer${p.dropTarget ? " drop-target" : ""}${"bottom" in pos ? " above" : ""}`}
      data-versions-drop
      style={{ ...pos, "--lane-color": `var(--lane-${p.label.toLowerCase()})` } as CSSProperties}
      aria-label={`Versions of ${p.label}`}
    >
      <header className="versions-header">
        {track?.cover ? (
          <img className="versions-cover" src={convertFileSrc(track.cover)} alt="" />
        ) : (
          <span className="versions-cover" aria-hidden="true">
            ♪
          </span>
        )}
        <div className="versions-title">
          <span className="versions-kicker">
            <span className="versions-letter">{p.label}</span> Versions
          </span>
          <input
            className="versions-name"
            value={versions.name}
            placeholder={placeholder || "Name this song"}
            onChange={(e) => p.onRename(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") p.onClose();
            }}
            spellCheck={false}
            title="The song's name, for every version of it (empty: the version in front's title)"
          />
        </div>
        <button className="library-drawer-close" onClick={p.onClose} title="Close (Esc)" aria-label="Close the versions">
          ✕
        </button>
      </header>

      <ol className="versions-list">
        {versions.versions.map((path, i) => {
          const front = i === versions.front;
          return (
            <li key={path} className={`version-row${front ? " front" : ""}`}>
              <button
                className="version-pick"
                onClick={() => p.onFront(i)}
                aria-pressed={front}
                title={
                  front
                    ? `In front: ${path}`
                    : `Put this version in front (heard, analysed and shown)${p.prepared.has(path) ? ", instantly" : " (still being prepared: takes a moment)"}: ${path}`
                }
              >
                <span className="version-dot" aria-hidden="true" />
                <span className="version-text">
                  <span className="version-label">
                    Version {i + 1}
                    {front && <span className="version-front">{p.loading ? "Loading…" : "In front"}</span>}
                  </span>
                  <span className="version-file">
                    {fileName(path)}
                    {front && track && ` · ${formatDuration(track.duration)}`}
                    {!front && !p.prepared.has(path) && <span className="version-preparing"> · preparing…</span>}
                  </span>
                </span>
              </button>
              <button
                className="version-remove"
                onClick={() => p.onRemove(i)}
                disabled={versions.versions.length < 2}
                title={versions.versions.length < 2 ? "The only version: close the lane to remove it" : "Remove this version from the lane (the file stays)"}
                aria-label={`Remove version ${i + 1}`}
              >
                −
              </button>
            </li>
          );
        })}
      </ol>

      <button className="versions-add" onClick={p.onAdd} title="Add one or more files as versions of this song">
        + Add Version
      </button>
      <p className="chart-note">Drop files here to add them as versions. Versions are prepared in the background, so switching is instant and keeps the playhead, selection and zoom. Each version keeps its own notes.</p>
    </aside>
  );
}
