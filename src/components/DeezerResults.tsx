import { useContext, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { SkeletonRows } from "./SkeletonRows";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import type { DeezerStatus, DeezerTrack, DownloadItem, DownloadKind } from "../lib/api";
import { formatTime } from "../lib/format";
import { LoadMenu, LoadTargetsContext } from "./LoadMenu";

const LIMIT = 25;
/** Deezer is a network round trip, so wait for a longer pause in typing than the local search. */
const SEARCH_DEBOUNCE_MS = 400;
const MIN_QUERY = 2;

interface Props {
  query: string;
}

/** Deezer search results with download buttons, through the headless Deemix server; once a
 *  track is downloaded its row loads it into any lane. */
export function DeezerResults({ query }: Props) {
  const [status, setStatus] = useState<DeezerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<DeezerTrack[] | null>(null);
  const [downloads, refreshDownloads] = useDownloads();
  /** `kind:id` of clicks Deemix hasn't accepted yet, shown as "Queuing…" meanwhile. */
  const [pending, setPending] = useState<string[]>([]);

  // Starts Deemix on first use (a second or two) and logs in with the saved ARL.
  useEffect(() => {
    api.deezerConnect().then(setStatus, (e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!status?.installed || query.length < MIN_QUERY) return;
    let cancelled = false;
    setTracks(null);
    const timer = setTimeout(() => {
      api.deezerSearch(query, LIMIT).then(
        (t) => {
          if (cancelled) return;
          setTracks(t);
          setError(null);
        },
        (e) => !cancelled && setError(String(e)),
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, status?.installed]);

  const download = (kind: DownloadKind, id: number) => {
    const key = `${kind}:${id}`;
    setPending((p) => [...p, key]);
    api
      .deezerDownload(kind, id)
      .then(refreshDownloads, (e) => setError(String(e)))
      .finally(() => setPending((p) => p.filter((k) => k !== key)));
  };

  return (
    <section className="deezer">
      <h3 className="results-heading">
        On Deezer
        {status?.loggedIn && (
          <span className="unit">
            {" "}
            · {status.user ?? "logged in"}
            {!status.lossless && " · this account can't download FLAC"}
          </span>
        )}
      </h3>
      {error && <p className="chart-note library-error">{error}</p>}
      {status === null ? (
        !error && <p className="chart-note">Starting Deemix…</p>
      ) : !status.installed ? (
        <p className="chart-note">Install Deemix in /Applications to search Deezer and download reference tracks.</p>
      ) : (
        <>
          {!status.loggedIn && <Login onStatus={setStatus} />}
          {query.length < MIN_QUERY ? null : tracks === null ? (
            !error && <SkeletonRows />
          ) : tracks.length === 0 ? (
            <p className="chart-note">Nothing on Deezer for “{query}”.</p>
          ) : (
            <ol className="matches">
              {tracks.map((t, i) => (
                <DeezerRow
                  key={t.id}
                  index={i}
                  track={t}
                  downloads={downloads}
                  pending={pending}
                  canDownload={status.loggedIn}
                  onDownload={download}
                />
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

/** The download queue, kept current by the backend's `deezer-queue` events while anything is
 *  pending; `refresh` fetches it at once. */
function useDownloads(): [DownloadItem[], () => void] {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const refresh = () => {
    api.deezerQueue().then(setItems, () => {});
  };
  useEffect(() => {
    const unlisten = listen<DownloadItem[]>("deezer-queue", (e) => setItems(e.payload));
    refresh();
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  return [items, refresh];
}

function Login({ onStatus }: { onStatus: (s: DeezerStatus) => void }) {
  const [arl, setArl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    setBusy(true);
    api
      .deezerLogin(arl)
      .then(onStatus, (e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="deezer-login"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="chart-note">
        Searching works as is. To download, paste your Deezer ARL once (the same one you gave Deemix); Deemix keeps it
        for next time.
      </p>
      <div className="row">
        <input
          type="password"
          className="library-search"
          placeholder="Deezer ARL"
          value={arl}
          autoComplete="off"
          onChange={(e) => setArl(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button type="submit" disabled={busy || arl.trim() === ""}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </div>
      {error && <p className="chart-note library-error">{error}</p>}
    </form>
  );
}

function DeezerRow({
  track: t,
  index,
  downloads,
  pending,
  canDownload,
  onDownload,
}: {
  track: DeezerTrack;
  /** Position in the list, for the staggered entrance. */
  index: number;
  downloads: DownloadItem[];
  pending: string[];
  canDownload: boolean;
  onDownload: (kind: DownloadKind, id: number) => void;
}) {
  // The latest queue entry for this track or its album, if it was downloaded this way.
  const latest = (kind: DownloadKind, id: number) => {
    const found = downloads.filter((d) => d.kind === kind && d.id === id);
    return found[found.length - 1];
  };
  // This track's file, whether it came alone or with its album.
  const file = downloads.flatMap((d) => d.files).find((f) => f.trackId === t.id)?.path;
  const targets = useContext(LoadTargetsContext);
  return (
    <li
      className={`match deezer-row${file ? " draggable" : ""}`}
      style={{ "--i": index } as CSSProperties}
      title={file ? "Drag onto a track to load it there" : undefined}
      onPointerDown={(e) => file && targets?.drag({ path: file, title: `${t.title} – ${t.artist}`, cover: t.cover || null }, e)}
    >
      {t.cover ? <img className="cover" src={t.cover} alt="" /> : <span className="cover" />}
      <div className="match-body">
        <div className="match-title">{t.title}</div>
        <div className="match-album">
          {t.artist} · {t.album} · {formatTime(t.duration, 0)}
        </div>
      </div>
      <div className="match-load">
        {file && <LoadMenu path={file} />}
        {(
          [
            ["track", t.id],
            ["album", t.albumId],
          ] as [DownloadKind, number][]
        )
          .filter(([kind]) => !(file && kind === "track"))
          .map(([kind, id]) => (
            <DownloadButton
              key={kind}
              kind={kind}
              item={latest(kind, id)}
              queuing={pending.includes(`${kind}:${id}`)}
              disabled={!canDownload}
              onClick={() => onDownload(kind, id)}
            />
          ))}
      </div>
    </li>
  );
}

const KIND_LABEL: Record<DownloadKind, string> = { track: "Track", album: "Album" };

function DownloadButton({
  kind,
  item,
  queuing,
  disabled,
  onClick,
}: {
  kind: DownloadKind;
  item?: DownloadItem;
  /** Clicked, waiting for Deemix to accept it. */
  queuing: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = KIND_LABEL[kind];
  const busy = queuing || item?.status === "inQueue" || item?.status === "downloading";
  if (busy) {
    const text =
      item?.status === "downloading"
        ? kind === "album" && item.size > 1
          ? `${item.downloaded}/${item.size}`
          : `${Math.round(item.progress)}%`
        : queuing && !item
          ? "Queuing…"
          : "Queued";
    // The button fills up as the download runs.
    const done =
      item?.status === "downloading" ? (kind === "album" && item.size > 1 ? (item.downloaded / item.size) * 100 : item.progress) : 0;
    return (
      <button
        className="download busy"
        disabled
        style={{ "--progress": `${done}%` } as CSSProperties}
        title={`Downloading the ${kind} as FLAC into the library`}
      >
        {text}
      </button>
    );
  }
  if (item?.status === "completed") {
    return (
      <button className="download done" disabled title={`Downloaded into the library (${item.size} track${item.size === 1 ? "" : "s"})`}>
        ✓ {label}
      </button>
    );
  }
  const failed = item?.status === "failed" || item?.status === "withErrors";
  const title = disabled
    ? "Log in to Deezer to download"
    : failed
      ? `${item!.failed} of ${item!.size} tracks failed. Click to retry.`
      : `Download the ${kind} as FLAC into the library`;
  return (
    <button className={`download${failed ? " failed" : ""}`} disabled={disabled} onClick={onClick} title={title}>
      {failed ? `! ${label}` : `↓ ${label}`}
    </button>
  );
}
