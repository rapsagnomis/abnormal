import { useContext, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Glide } from "./Glide";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, SLOTS } from "../lib/api";
import { useFlip } from "../lib/motion";
import { usePair } from "../lib/pair";
import { SkeletonRows } from "./SkeletonRows";
import { TweenedValue } from "./TweenedValue";
import type { ABSlot, AnalysisReport, LibraryMatch, LibraryStatus, LibraryTrack, MatchWeights } from "../lib/api";
import { formatTime } from "../lib/format";
import { DeezerResults } from "./DeezerResults";
import { LoadMenu, LoadTargetsContext } from "./LoadMenu";
import { LibraryStanding } from "./LibraryStanding";
import { fmt } from "../lib/metrics";

type Focus = "all" | "tonal" | "dynamics" | "stereo";

const FOCUS: [Focus, string, MatchWeights][] = [
  ["all", "All", [0.5, 0.3, 0.2]],
  ["tonal", "Tonal", [1, 0, 0]],
  ["dynamics", "Dynamics", [0, 1, 0]],
  ["stereo", "Stereo", [0, 0, 1]],
];
const LIMIT = 30;
const SEARCH_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 150;
/** Library hits shown before "Show all", so the Deezer results stay in view. */
const SEARCH_PREVIEW = 8;
/** While indexing, refresh matches every this many newly indexed tracks. */
const REFRESH_EVERY = 100;

interface Props {
  reports: [AnalysisReport | null, AnalysisReport | null];
  /** Paths of the tracks loaded in A and B. */
  paths: [string | null, string | null];
  status: LibraryStatus | null;
  onRescan: () => void;
  /** Close the drawer it's shown in (Escape on an empty search, ⌘K). */
  onClose: () => void;
}

export function LibraryView({ reports, paths, status, onRescan, onClose }: Props) {
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";

  return (
    <>
      <LibraryLine status={status} onRescan={onRescan} />
      <input
        type="search"
        className="library-search"
        placeholder="Search your library and Deezer by artist, album or title"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        // Keep typing out of the global shortcuts (space, 1/2, L, M…).
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            if (query) setQuery("");
            else onClose();
          }
          if (e.metaKey && e.key.toLowerCase() === "k") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      {/* Search results and matches fade in when switching between them. */}
      {searching ? (
        <div key="search" className="fade-in library-results">
          <SearchResults query={query.trim()} status={status} />
          <DeezerResults query={query.trim()} />
        </div>
      ) : (
        <div key="matches" className="fade-in library-results">
          <LibraryStanding reports={reports} status={status} />
          <Matches reports={reports} paths={paths} status={status} />
        </div>
      )}
    </>
  );
}

function SearchResults({ query, status }: { query: string; status: LibraryStatus | null }) {
  const [tracks, setTracks] = useState<LibraryTrack[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [query]);
  const list = useRef<HTMLOListElement>(null);
  useFlip(list, [tracks, showAll]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .searchLibrary(query, SEARCH_LIMIT)
        .then((t) => !cancelled && setTracks(t))
        .catch(() => !cancelled && setTracks([]));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Also refresh when a scan ends, so a track that was just downloaded shows up.
  }, [query, Math.floor((status?.indexed ?? 0) / REFRESH_EVERY), status?.scanning]);

  const heading = <h3 className="results-heading">In your library</h3>;
  if (tracks === null) return <>{heading}<SkeletonRows /></>;
  if (tracks.length === 0) return <>{heading}<p className="chart-note">No library track matches “{query}”.</p></>;
  return (
    <>
      {heading}
      <ol className="matches" ref={list}>
        {(showAll ? tracks : tracks.slice(0, SEARCH_PREVIEW)).map((t, i) => (
          <TrackRow key={t.path} index={i} track={t} />
        ))}
      </ol>
      {!showAll && tracks.length > SEARCH_PREVIEW ? (
        <button className="show-all" onClick={() => setShowAll(true)}>
          Show all {tracks.length}
          {tracks.length === SEARCH_LIMIT && "+"}
        </button>
      ) : (
        tracks.length === SEARCH_LIMIT && <p className="chart-note">Showing the first {SEARCH_LIMIT}: add words to narrow down.</p>
      )}
    </>
  );
}

function Matches({ reports, paths, status }: Omit<Props, "onRescan" | "onClose">) {
  const [source, setSource] = useState<ABSlot>(0);
  const [focus, setFocus] = useState<Focus>("all");
  const [matches, setMatches] = useState<LibraryMatch[] | null>(null);
  const { labels } = usePair();
  const list = useRef<HTMLOListElement>(null);
  // Re-ranked (another focus, track or selection): rows glide to their new places.
  useFlip(list, [matches]);

  // Match the chosen track, or the other one if only that is loaded.
  const slot: ABSlot | null = reports[source] ? source : reports[1 - source] ? ((1 - source) as ABSlot) : null;
  const features = slot === null ? null : reports[slot]!.features;
  const exclude = slot === null ? null : paths[slot];
  const weights = FOCUS.find(([f]) => f === focus)![2];
  const indexedStep = Math.floor((status?.indexed ?? 0) / REFRESH_EVERY);

  useEffect(() => {
    if (!features) {
      setMatches(null);
      return;
    }
    let cancelled = false;
    api
      .similarTracks(features, exclude ? [exclude] : [], weights, LIMIT)
      .then((m) => !cancelled && setMatches(m))
      .catch(() => !cancelled && setMatches([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features, exclude, focus, indexedStep, status?.scanning]);

  return (
    <>
      <div className="similar-controls">
        <div className="segmented" role="radiogroup" aria-label="Track to match">
          <Glide />
          {SLOTS.map((s) => (
            <button
              key={s}
              className={slot === s ? "on" : ""}
              disabled={!reports[s]}
              onClick={() => setSource(s)}
              title={`Find library tracks that sound like ${labels[s]}`}
            >
              Like {labels[s]}
            </button>
          ))}
        </div>
        <div className="segmented" role="radiogroup" aria-label="Compare on">
          <Glide />
          {FOCUS.map(([f, name]) => (
            <button key={f} className={focus === f ? "on" : ""} onClick={() => setFocus(f)}>
              {name}
            </button>
          ))}
        </div>
      </div>

      {slot === null ? (
        <p className="chart-note">Search above to load a library track, or load a track to find songs with a similar sound.</p>
      ) : matches === null ? (
        <SkeletonRows />
      ) : matches.length === 0 ? (
        <p className="chart-note">No analysed library tracks yet.</p>
      ) : (
        <>
          <ol className="matches" ref={list}>
            {matches.map((m, i) => (
              <TrackRow key={m.path} index={i} track={m} match={m} />
            ))}
          </ol>
          <p className="chart-note">
            Similarity of tonal balance (spectrum shape at equal loudness), dynamics (LRA, PLR, PSR, crest, DR, onsets) and
            stereo image (correlation, width per band), each judged against how much tracks in the library vary.
          </p>
        </>
      )}
    </>
  );
}

function LibraryLine({ status, onRescan }: { status: LibraryStatus | null; onRescan: () => void }) {
  if (!status) return null;
  const progress = status.scanning && status.queued > 0 ? ` · analysing ${status.done} / ${status.queued}` : status.scanning ? " · scanning…" : "";
  return (
    <div className="library-line">
      <span title={status.root}>
        Library: {status.indexed.toLocaleString()} tracks{progress}
        {status.failed > 0 && <span className="unit"> · {status.failed} unreadable</span>}
        {status.error && <span className="library-error"> · {status.error}</span>}
      </span>
      <button onClick={onRescan} disabled={status.scanning} title={`Look for new or changed files in ${status.root}`}>
        Rescan
      </button>
      {status.scanning && status.queued > 0 && (
        <div className="library-progress" role="progressbar" aria-valuemax={status.queued} aria-valuenow={status.done}>
          <span style={{ width: `${(status.done / status.queued) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/** A library track with a Load menu; with `match`, also its similarity scores. */
function TrackRow({
  track: t,
  match: m,
  index,
}: {
  track: LibraryTrack;
  match?: LibraryMatch;
  /** Position in the list, for the staggered entrance. */
  index: number;
}) {
  // Tags when the file has them, else the file name and its folder.
  const parts = t.relPath.split("/");
  const fileName = parts[parts.length - 1].replace(/\.[^.]+$/, "");
  const name = t.title ? (t.artist ? `${t.title} – ${t.artist}` : t.title) : fileName;
  const album = t.title ? (t.album ?? "") : parts.slice(0, -1).join(" / ");
  const s = t.summary;
  const copies = t.copies.length;
  const targets = useContext(LoadTargetsContext);
  const aspects: [string, number | null][] = m
    ? [
        ["tonal", m.tonal],
        ["dyn", m.dynamics],
        ["stereo", m.stereo],
      ]
    : [];
  return (
    <li
      className={`match draggable${m ? " scored" : ""}`}
      data-key={t.path}
      style={{ "--i": index } as CSSProperties}
      title={`${[t.path, ...t.copies].join("\n")}\nDrag onto a track to load it there`}
      onPointerDown={(e) => targets?.drag({ path: t.path, title: name, cover: t.cover ? convertFileSrc(t.cover) : null }, e)}
    >
      {m && (
        <span className="match-score">
          <TweenedValue value={m.score} show={(x) => (x === null ? "—" : String(Math.round(x)))} />
        </span>
      )}
      {t.cover ? <img className="cover" src={convertFileSrc(t.cover)} alt="" loading="lazy" /> : <span className="cover" aria-hidden="true">♪</span>}
      <div className="match-body">
        <div className="match-title">{name}</div>
        <div className="match-album">
          {album}
          {album && " · "}
          {formatTime(t.duration, 0)}
          {copies > 0 && ` · ${copies + 1} copies`}
        </div>
        <div className="match-detail">
          {aspects.map(([name, v]) => (
            <span key={name}>
              {name} {v === null ? "—" : Math.round(v)}
            </span>
          ))}
          {s && (
            <span className="unit">
              {fmt(s.integrated)} LUFS · DR{fmt(s.dr, 0)} · {fmt(s.tilt, 1, true)} dB/oct
            </span>
          )}
        </div>
      </div>
      <div className="match-load">
        <LoadMenu path={t.path} copies={t.copies} />
      </div>
    </li>
  );
}

