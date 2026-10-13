import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, SLOT_LABELS, SLOTS } from "../lib/api";
import type { AnalysisReport, LibraryMatch, LibraryStatus, LibraryTrack, MatchWeights, Slot } from "../lib/api";
import { formatTime } from "../lib/format";
import { DeezerResults } from "./DeezerResults";
import { LoadButtons } from "./LoadButtons";
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
  onLoad: (slot: Slot, path: string) => void;
  onRescan: () => void;
}

export function LibraryView({ reports, paths, status, onLoad, onRescan }: Props) {
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
        onChange={(e) => setQuery(e.target.value)}
        // Keep typing out of the global shortcuts (space, 1/2, L, M…).
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") setQuery("");
        }}
      />
      {searching ? (
        <>
          <SearchResults query={query.trim()} paths={paths} status={status} onLoad={onLoad} />
          <DeezerResults query={query.trim()} paths={paths} onLoad={onLoad} />
        </>
      ) : (
        <Matches reports={reports} paths={paths} status={status} onLoad={onLoad} />
      )}
    </>
  );
}

function SearchResults({ query, paths, status, onLoad }: { query: string; paths: Props["paths"]; status: LibraryStatus | null; onLoad: Props["onLoad"] }) {
  const [tracks, setTracks] = useState<LibraryTrack[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [query]);

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
  if (tracks === null) return <>{heading}<p className="chart-note">Searching…</p></>;
  if (tracks.length === 0) return <>{heading}<p className="chart-note">No library track matches “{query}”.</p></>;
  return (
    <>
      {heading}
      <ol className="matches">
        {(showAll ? tracks : tracks.slice(0, SEARCH_PREVIEW)).map((t) => (
          <TrackRow key={t.path} track={t} paths={paths} onLoad={onLoad} />
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

function Matches({ reports, paths, status, onLoad }: Omit<Props, "onRescan">) {
  const [source, setSource] = useState<Slot>(0);
  const [focus, setFocus] = useState<Focus>("all");
  const [matches, setMatches] = useState<LibraryMatch[] | null>(null);

  // Match the chosen track, or the other one if only that is loaded.
  const slot: Slot | null = reports[source] ? source : reports[1 - source] ? ((1 - source) as Slot) : null;
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
          {SLOTS.map((s) => (
            <button
              key={s}
              className={slot === s ? "on" : ""}
              disabled={!reports[s]}
              onClick={() => setSource(s)}
              title={`Find library tracks that sound like ${SLOT_LABELS[s]}`}
            >
              Like {SLOT_LABELS[s]}
            </button>
          ))}
        </div>
        <div className="segmented" role="radiogroup" aria-label="Compare on">
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
        <p className="chart-note">Searching…</p>
      ) : matches.length === 0 ? (
        <p className="chart-note">No analysed library tracks yet.</p>
      ) : (
        <>
          <ol className="matches">
            {matches.map((m) => (
              <TrackRow key={m.path} track={m} match={m} paths={paths} onLoad={onLoad} />
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
        <progress className="library-progress" max={status.queued} value={status.done} />
      )}
    </div>
  );
}

/** A library track with load buttons; with `match`, also its similarity scores. */
function TrackRow({ track: t, match: m, paths, onLoad }: { track: LibraryTrack; match?: LibraryMatch; paths: Props["paths"]; onLoad: Props["onLoad"] }) {
  // Tags when the file has them, else the file name and its folder.
  const parts = t.relPath.split("/");
  const fileName = parts[parts.length - 1].replace(/\.[^.]+$/, "");
  const name = t.title ? (t.artist ? `${t.title} – ${t.artist}` : t.title) : fileName;
  const album = t.title ? (t.album ?? "") : parts.slice(0, -1).join(" / ");
  const s = t.summary;
  const copies = t.copies.length;
  const aspects: [string, number | null][] = m
    ? [
        ["tonal", m.tonal],
        ["dyn", m.dynamics],
        ["stereo", m.stereo],
      ]
    : [];
  return (
    <li className={`match${m ? " scored" : ""}`} title={[t.path, ...t.copies].join("\n")}>
      {m && <span className="match-score">{Math.round(m.score)}</span>}
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
        <LoadButtons path={t.path} copies={t.copies} paths={paths} onLoad={onLoad} />
      </div>
    </li>
  );
}
