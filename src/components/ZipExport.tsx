import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import type { CoverPreview, ZipFormat, ZipItem } from "../lib/api";
import { basename } from "../lib/paths";
import { isMac } from "../lib/platform";
import { Glide } from "./Glide";

/** A lane that can go into the zip: its song's version in front. */
export interface ZipTrack {
  /** The lane's number (1–50). */
  label: string;
  /** The song's name (given, else the front version's title). */
  title: string;
  /** The front version's file. */
  path: string;
  /** The front version's artist tag, if any. */
  artist: string | null;
  /** Its cover's thumbnail (in the app's covers folder), if it has one. */
  cover: string | null;
  /** "2 of 3" when the song has several versions. */
  version: string | null;
}

/** Fill a track-name pattern: `{n}` (01, 02, … over the exported tracks), `{title}`, `{artist}`,
 *  `{file}` (the file's own name). An empty value takes its separator (" - ", ". ") with it. */
export function trackFileName(pattern: string, values: { n: string; title: string; artist: string; file: string }): string {
  let name = pattern;
  for (const [key, value] of Object.entries(values)) {
    const token = `\\{${key}\\}`;
    if (!value.trim()) name = name.replace(new RegExp(`${token}\\s*[-–.]?\\s*|\\s*[-–]\\s*${token}`, "g"), "");
    name = name.split(`{${key}}`).join(value.trim());
  }
  return name.trim();
}

const PATTERNS = ["{n} - {title}", "{n}. {artist} - {title}", "{artist} - {title}", "{title}"];
const FORMATS: { id: ZipFormat; label: string; detail: string }[] = [
  { id: "wav", label: "WAV", detail: "24-bit" },
  { id: "flac", label: "FLAC", detail: "24-bit, lossless" },
  { id: "mp3", label: "MP3", detail: "320 kb/s (MP3 files are copied as they are, retagged)" },
];
/** Choices remembered between exports. */
const SETTINGS_KEY = "zip-export";

interface Settings {
  artist: string;
  pattern: string;
  format: ZipFormat;
}

const loadSettings = (): Settings => {
  const fallback: Settings = { artist: "", pattern: PATTERNS[0], format: "wav" };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return fallback;
  }
};

/** Typing in a field: no app shortcuts (Space plays, digits pick lanes); Enter is done. */
const fieldKeys = (e: ReactKeyboardEvent<HTMLInputElement>) => {
  if (e.key === "Escape") return;
  e.stopPropagation();
  if (e.key === "Enter") e.currentTarget.blur();
};

const stem = (path: string) => basename(path).replace(/\.[^.]+$/, "");

interface Props {
  /** The panel is shown (opened from the app menu). */
  open: boolean;
  onClose: () => void;
  /** Loaded lanes, in lane order. */
  tracks: ZipTrack[];
  /** Ask where to save and write the zip (calling `started` once it's chosen); resolves to its
   *  path, or null if cancelled. */
  onExport: (items: ZipItem[], format: ZipFormat, artist: string, cover: string | null, started: () => void) => Promise<string | null>;
}

/** Export as Zip (from the app menu): every lane's version in front, named and tagged, encoded
 *  into one zip. */
export function ZipExport({ open, onClose, tracks, onExport }: Props) {
  const [settings, setSettings] = useState(loadSettings);
  /** Lanes left out, by file. */
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean; saved?: string } | null>(null);
  /** The cover: an image file, or a track whose own cover is used (its file); kept while the app runs. */
  const [cover, setCover] = useState<{ path: string; preview: CoverPreview } | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const { artist, pattern, format } = settings;
  const custom = !PATTERNS.includes(pattern);
  const chosen = tracks.filter((t) => !skipped.has(t.path));
  const digits = Math.max(2, String(chosen.length).length);
  const items: ZipItem[] = chosen.map((t, i) => ({
    source: t.path,
    title: t.title,
    name: trackFileName(pattern, { n: String(i + 1).padStart(digits, "0"), title: t.title, artist, file: stem(t.path) }),
  }));

  const update = (change: Partial<Settings>) => {
    const next = { ...settings, ...change };
    setSettings(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Not remembered: fine.
    }
  };

  // Close on Escape or a click elsewhere (not while writing, so the result stays visible).
  useEffect(() => {
    if (!open || busy) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      if (e instanceof KeyboardEvent) e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", close, true);
    window.addEventListener("mousedown", close, true);
    return () => {
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("mousedown", close, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, busy]);

  // Each time it opens: a fresh status, and with no artist yet, the one the tracks are tagged with.
  useEffect(() => {
    if (!open) return;
    setStatus(null);
    if (!artist) update({ artist: tracks.find((t) => t.artist)?.artist ?? "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const run = async () => {
    setBusy(true);
    setStatus(null);
    const total = items.length;
    const unlisten = await listen<number>("zip-progress", (e) => setStatus({ text: `Encoding… ${e.payload} of ${total} done` }));
    try {
      const saved = await onExport(items, format, artist.trim(), cover?.path ?? null, () => setStatus({ text: `Encoding… 0 of ${total} done` }));
      setStatus(saved ? { text: `${total} track${total === 1 ? "" : "s"}, ${format.toUpperCase()}`, saved } : null);
    } catch (err) {
      setStatus({ text: String(err), error: true });
    } finally {
      unlisten();
      setBusy(false);
    }
  };

  const pickCover = async (path: string) => {
    setCoverError(null);
    try {
      setCover({ path, preview: await api.coverPreview(path) });
    } catch (err) {
      setCoverError(String(err));
    }
  };
  const chooseCover = async () => {
    const picked = await openDialog({ filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png"] }] });
    if (typeof picked === "string") await pickCover(picked);
  };
  // The tracks' own covers, one per image (an album's tracks share one).
  const trackCovers = tracks.filter((t, i) => t.cover && tracks.findIndex((u) => u.cover === t.cover) === i);

  const toggleTrack = (path: string) =>
    setSkipped((s) => {
      const next = new Set(s);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <div className="export zip-export" ref={ref}>
      {open && (
        <div className="export-menu zip-menu" role="dialog" aria-label="Export as Zip">
          <div className="zip-head">
            <div className="export-title">Export as Zip</div>
            <button className="library-drawer-close" onClick={onClose} disabled={busy} title="Close (Esc)" aria-label="Close">
              ✕
            </button>
          </div>

          <div className="zip-tracks">
            {tracks.map((t) => {
              const i = chosen.indexOf(t);
              return (
                <label key={t.path} title={t.path}>
                  <input type="checkbox" checked={i >= 0} disabled={busy} onChange={() => toggleTrack(t.path)} />
                  <span className="zip-lane" style={{ background: `var(--lane-${t.label})` }}>
                    {t.label}
                  </span>
                  <span className="zip-name">{i >= 0 ? items[i].name : t.title}</span>
                  {t.version && <span className="chart-note">v{t.version}</span>}
                </label>
              );
            })}
          </div>

          <label className="zip-field">
            <span>Artist</span>
            <input type="text" value={artist} placeholder="Artist name" disabled={busy} onKeyDown={fieldKeys} onChange={(e) => update({ artist: e.target.value })} />
          </label>

          <div className="zip-field zip-cover-field">
            <span>Cover</span>
            <div className="zip-cover">
              {cover ? (
                <img className="zip-cover-art" src={cover.preview.url} alt="The cover" />
              ) : (
                <span className="zip-cover-art" aria-hidden="true">
                  ♪
                </span>
              )}
              <div className="zip-cover-side">
                <div className="zip-cover-actions">
                  <button disabled={busy} onClick={chooseCover} title="A JPEG or PNG image">
                    Choose image…
                  </button>
                  {cover && (
                    <button disabled={busy} onClick={() => setCover(null)} title="Export without a cover">
                      None
                    </button>
                  )}
                </div>
                {trackCovers.length > 0 && (
                  <div className="zip-cover-tracks">
                    {trackCovers.map((t) => (
                      <button
                        key={t.path}
                        className={`zip-cover-pick${cover?.path === t.path ? " on" : ""}`}
                        disabled={busy}
                        onClick={() => pickCover(t.path)}
                        title={`Track ${t.label}'s cover: ${t.title}`}
                      >
                        <img src={convertFileSrc(t.cover!)} alt="" />
                      </button>
                    ))}
                  </div>
                )}
                <span className={`chart-note${coverError ? " error" : ""}`}>
                  {coverError ??
                    (cover
                      ? `${cover.preview.width} × ${cover.preview.height} · ${format === "wav" ? "WAV can't carry a cover: added to the zip beside the files" : "embedded in every file, and added to the zip"}`
                      : "None: pick an image, or a track's cover")}
                </span>
              </div>
            </div>
          </div>

          <label className="zip-field">
            <span>Track names</span>
            <select value={custom ? "custom" : pattern} disabled={busy} onChange={(e) => update({ pattern: e.target.value === "custom" ? `${pattern} ` : e.target.value })}>
              {PATTERNS.map((p) => (
                <option key={p} value={p}>
                  {trackFileName(p, { n: "01", title: "Title", artist: "Artist", file: "file" })}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </label>
          {custom && (
            <label className="zip-field" title="{n} track number, {title} song name, {artist} artist, {file} the file's own name">
              <span>Pattern</span>
              <input type="text" value={pattern} spellCheck={false} disabled={busy} onKeyDown={fieldKeys} onChange={(e) => update({ pattern: e.target.value })} />
            </label>
          )}

          <div className="zip-field">
            <span>Format</span>
            <div className="segmented" role="radiogroup" aria-label="Format">
              <Glide />
              {FORMATS.map((f) => (
                <button key={f.id} className={format === f.id ? "on" : ""} disabled={busy} title={f.detail} onClick={() => update({ format: f.id })}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="chart-note">{FORMATS.find((f) => f.id === format)!.detail}</div>

          <button onClick={run} disabled={busy || items.length === 0}>
            Export Zip…
          </button>
          {status?.saved ? (
            <div className="export-status export-saved">
              <span>
                <span className="export-check">✓</span>Saved {basename(status.saved)}
              </span>
              <span className="chart-note">{status.text}</span>
              <button onClick={() => revealItemInDir(status.saved!).catch(() => {})}>{isMac ? "Reveal in Finder" : "Show in folder"}</button>
            </div>
          ) : (
            status && <div className={`export-status${status.error ? " error" : ""}`}>{status.text}</div>
          )}
        </div>
      )}
    </div>
  );
}
