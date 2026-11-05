import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ALL_SLOTS, api, AUDIO_EXTENSIONS, EXTRA_SLOTS, isAudioFile, isSessionFile, SESSION_EXTENSION, SLOT_COUNT, SLOT_LABELS } from "./lib/api";
import type {
  AnalysisReport,
  ZipFormat,
  ZipItem,
  AudioStatus,
  BandActivity,
  LaneVersions,
  EqFilter,
  LibraryStatus,
  MatchReport,
  Region,
  Session,
  Slot,
  Marker,
  TrackInfo,
  Transport,
} from "./lib/api";
import type { View } from "./lib/view";
import { clampView, fullView, isFull, zoomView } from "./lib/view";
import { TrackLane } from "./components/TrackLane";
import type { Display } from "./components/Waveform";
import { isWidth, loudnessChange, midSideCurves, movesOf } from "./lib/eq";
import { passageFor } from "./lib/passages";
import { TransportBar, VOLUME_MIN_DB } from "./components/TransportBar";
import { VolumeControl } from "./components/VolumeControl";
import { MatchControls } from "./components/MatchControls";
import { AnalysisPanel } from "./components/AnalysisPanel";
import type { AuditionKind, Scope, Tab } from "./components/AnalysisPanel";
import { overlayFor } from "./lib/overlay";
import type { CurveMode } from "./lib/overlay";
import { pairColors } from "./lib/pair";
import type { ComparedPair } from "./lib/pair";
import { ComparedWith } from "./components/ComparedWith";
import type { CompareChoice } from "./components/ComparedWith";
import { withGain } from "./lib/gain";
import type { DragItem, LoadTargets } from "./components/LoadMenu";
import { LibraryDrawer } from "./components/LibraryDrawer";
import { AppMenu } from "./components/AppMenu";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { SourceMenu } from "./components/SourceMenu";
import { ZipExport } from "./components/ZipExport";
import type { ZipTrack } from "./components/ZipExport";
import { defaultName, VersionsDrawer } from "./components/VersionsDrawer";
import { notesMarkdown } from "./lib/notes";
import "./App.css";

type Pair<T> = [T, T];
/** Per-slot state for every lane: A, B and the extra slots, indexed by engine slot. */
type PerSlot<T> = T[];
const perSlot = <T,>(v: T): PerSlot<T> => ALL_SLOTS.map(() => v);
/** A song's versions and references can be loudness-matched once there are two files in all. */
const canMatchSong = (song: LaneVersions | null | undefined) => !!song && song.versions.length + (song.references?.length ?? 0) > 1;
/** A song as a session saves it, in a fixed shape, to tell whether the lanes changed since. */
const songKey = (l: LaneVersions) => [
  l.name,
  l.versions,
  l.front,
  !!l.matchLoudness,
  l.references ?? [],
  l.references?.length ? (l.referenceFront ?? 0) : 0,
  l.compareLane ?? null,
  !!l.compareDefault,
  l.color ?? null,
];
const setAt = <P extends unknown[]>(p: P, slot: Slot, v: P[number]): P => {
  const next = [...p] as P;
  next[slot] = v;
  return next;
};

/** Lanes shrink to share the height down to this (a quarter of the area, less the 10 px gaps: their
 *  height with four tracks), then the lane list scrolls. */
const MIN_LANE = "calc((100% - 3 * 10px) / 4)";
/** Normalizing a track raises its true peak to this, dBTP: as loud as it can play without clipping. */
const NORMALIZE_PEAK_DBTP = -1;
/** How long "Relinked N files" shows after opening a session. */
const RELINKED_NOTE_MS = 12000;
/** The compared song has no reference (`subject`'s pair half when nothing is loaded for it). */
const NO_REFERENCE = -1;
/** Files dropped or loaded as the session's default reference (the strip above the lanes). */
const DEFAULT_TARGET = -2;
/** Colour of a reference without a colourful cover. */
const REFERENCE_COLOR = "#c8bfa8";
/** How long the analysis panel takes to slide in or out (as in the CSS). */
const PANEL_SLIDE_MS = 260;
/** How long an extra lane takes to open or close. */
const LANE_ANIMATION_MS = 220;

const INITIAL_TRANSPORT: Transport = {
  playing: false,
  active: 0,
  loopEnabled: ALL_SLOTS.map(() => false),
  positions: ALL_SLOTS.map(() => 0),
  levels: ALL_SLOTS.map(() => 0),
};

/** Wait this long after a selection changes before measuring it. */
const SELECTION_DEBOUNCE_MS = 150;
const ZOOM_STEP = 2;
/** Output volume, dB; the bottom of the slider mutes. Remembered across launches. */
const VOLUME_KEY = "volumeDb";
const loadVolume = () => {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && v <= 0 && v >= VOLUME_MIN_DB ? v : 0;
  } catch {
    return 0;
  }
};
const PANEL_KEY = "analysisPanelOpen";
/** The analysis panel was left open (it's closed by default). */
const loadPanelOpen = () => {
  try {
    return localStorage.getItem(PANEL_KEY) === "1";
  } catch {
    return false;
  }
};
const CURVE_CYCLE: CurveMode[] = ["off", "momentary", "shortTerm", "psr", "correlation"];

export default function App() {
  const [tracks, setTracks] = useState<PerSlot<TrackInfo | null>>(perSlot(null));
  const [loading, setLoading] = useState<PerSlot<boolean>>(perSlot(false));
  const [errors, setErrors] = useState<PerSlot<string | null>>(perSlot(null));
  const [regions, setRegions] = useState<PerSlot<Region | null>>(perSlot(null));
  const [views, setViews] = useState<PerSlot<View | null>>(perSlot(null));
  /** Lanes in display order, as engine slots: numbers follow position, so removing 3 makes 4 the
   *  new 3 and dragging a lane to the top makes it 1. Slots 0 and 1 always have a lane. */
  const [order, setOrder] = useState<Slot[]>([0, 1]);
  /** Lanes that can be closed (beyond the first two slots). */
  const extras = order.filter((s) => s > 1);
  /** Extra lanes opening (drawn collapsed for a frame so they can grow) or closing. */
  const [entering, setEntering] = useState<Slot[]>([]);
  /** Extra lanes that just opened, while their rows are still growing. */
  const [opening, setOpening] = useState<Slot[]>([]);
  const [leaving, setLeaving] = useState<Slot[]>([]);
  /** The compared pair: the song listened to (`subject`; listening to a reference keeps its song)
   *  and that song's reference. A reference belongs to the song: its own, else the session's
   *  default, unless it's set to compare with another lane or the default (`compareWith`). */
  const [subject, setSubject] = useState<Slot>(0);
  /** Each lane's own reference track, loaded in a hidden engine slot (not a lane of its own),
   *  indexed by the lane's slot. */
  const [companions, setCompanions] = useState<PerSlot<Slot | null>>(perSlot(null));
  /** The session's default reference (a file), for songs without their own, and its hidden slot. */
  const [defaultRef, setDefaultRef] = useState<string | null>(null);
  const [defaultSlot, setDefaultSlot] = useState<Slot | null>(null);
  /** What each song is compared with when not its own reference: another lane, or the default. */
  const [compareWith, setCompareWith] = useState<PerSlot<Slot | "default" | null>>(perSlot(null));
  /** The lane a hidden reference slot belongs to, else null (the default reference has none). */
  const ownerOf = (slot: Slot): Slot | null => {
    const i = companions.indexOf(slot);
    return i < 0 ? null : i;
  };
  /** A song's reference: the lane or default it's set to compare with, else its own, else the
   *  default; `NO_REFERENCE` when none is loaded. */
  const referenceOf = (slot: Slot): Slot => {
    const own = companions[slot];
    const choice = compareWith[slot];
    const loaded = (s: Slot | null | undefined): s is Slot => s !== null && s !== undefined && !!tracks[s];
    if (typeof choice === "number" && choice !== slot && loaded(choice)) return choice;
    if (choice === "default" && loaded(defaultSlot)) return defaultSlot;
    if (loaded(own)) return own;
    if (loaded(defaultSlot)) return defaultSlot;
    return NO_REFERENCE;
  };
  const [transport, setTransport] = useState<Transport>(INITIAL_TRANSPORT);
  const [linked, setLinked] = useState(false);
  const [dropSlot, setDropSlot] = useState<Slot | null>(null);
  /** A library row being dragged towards a lane, drawn under the pointer. */
  const [dragging, setDragging] = useState<(DragItem & { x: number; y: number }) | null>(null);
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);

  const [reports, setReports] = useState<PerSlot<AnalysisReport | null>>(perSlot(null));
  /** Tracks played peak-normalized (raised to `NORMALIZE_PEAK_DBTP`). */
  const [normalized, setNormalized] = useState<PerSlot<boolean>>(perSlot(false));
  const [selectionReports, setSelectionReports] = useState<PerSlot<AnalysisReport | null>>(perSlot(null));
  const [measuringFull, setMeasuringFull] = useState<PerSlot<boolean>>(perSlot(false));
  const [measuringSel, setMeasuringSel] = useState<PerSlot<boolean>>(perSlot(false));
  const [scope, setScope] = useState<Scope>("full");
  const [curveMode, setCurveMode] = useState<CurveMode>("off");
  const [matchEnabled, setMatchEnabled] = useState(false);
  /** Tracks play one after another (lane order) instead of all together. */
  const [playerMode, setPlayerMode] = useState(false);
  const [tab, setTab] = useState<Tab>("loudness");
  const [eq, setEq] = useState<MatchReport | null>(null);
  /** Measure the EQ match over the loudest parts only (Matchering's gating). */
  const [eqLoudest, setEqLoudest] = useState(false);
  const [library, setLibrary] = useState<LibraryStatus | null>(null);
  /** The library drawer is open over the lanes. */
  const [libraryOpen, setLibraryOpen] = useState(false);
  /** What the library was opened for from a lane's Open / Add / Replace menu: offered first in its
   *  Load menus until it closes. */
  const [libraryFor, setLibraryFor] = useState<{ kind: "lane"; slot: Slot } | { kind: "ref"; owner: Slot } | { kind: "default" } | null>(null);
  useEffect(() => {
    if (!libraryOpen) setLibraryFor(null);
  }, [libraryOpen]);
  const [display, setDisplay] = useState<Display>("peak");
  /** The bar display S switches back to from the spectrogram. */
  const lastBars = useRef<Display>("peak");
  if (display !== "spectrogram") lastBars.current = display;
  /** Audition the suggested EQ on A's playback: the chosen moves, or the full match. */
  const [eqAudition, setEqAudition] = useState(false);
  const [auditionKind, setAuditionKind] = useState<AuditionKind>("moves");
  /** The match the compared track's full-match rendering was made for (rendering takes a moment). */
  const [fullRendered, setFullRendered] = useState<MatchReport | null>(null);
  const [volumeDb, setVolumeDb] = useState(loadVolume);
  /** The analysis panel is shown beside the lanes (a drawer that closes to give them the width). */
  const [panelOpen, setPanelOpen] = useState(loadPanelOpen);
  const [eqActive, setEqActive] = useState<boolean[]>([]);
  const [activity, setActivity] = useState<Pair<BandActivity | null>>([null, null]);
  /** Timestamped notes per lane, saved per file. */
  const [markers, setMarkers] = useState<PerSlot<Marker[]>>(perSlot([]));
  /** The marker whose note is being written. */
  const [editingMarker, setEditingMarker] = useState<{ slot: Slot; time: number } | null>(null);
  /** The session the lanes were opened from or saved as, with its tracks as saved. */
  const [session, setSession] = useState<{ path: string; name: string; lanes: LaneVersions[]; defaultReference: string | null } | null>(null);
  /** Each lane's song: its versions and the one in front (the one loaded). */
  const [versions, setVersions] = useState<PerSlot<LaneVersions | null>>(perSlot(null));
  /** The lane whose versions drawer is open. */
  const [versionsOpen, setVersionsOpen] = useState<Slot | null>(null);
  /** Files are dragged over the versions drawer, or its references. */
  const [versionsDrop, setVersionsDrop] = useState(false);
  const [referencesDrop, setReferencesDrop] = useState(false);
  /** Versions prepared in the background (decoded and analysed), so switching to them is instant. */
  const [prepared, setPrepared] = useState<Set<string>>(new Set());
  /** Integrated loudness (LUFS) of the prepared versions of songs matching their versions, by path. */
  const [versionLoudness, setVersionLoudness] = useState<Map<string, number | null>>(new Map());
  /** Notes export feedback in the header ("Exported", or the error). */
  const [notesStatus, setNotesStatus] = useState<string | null>(null);
  /** Files an opened session found renamed or moved, shown for a while after opening it. */
  const [relinked, setRelinked] = useState<Session["relinked"]>([]);
  useEffect(() => {
    if (!relinked.length) return;
    const timer = setTimeout(() => setRelinked([]), RELINKED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [relinked]);
  /** The Export as Zip panel and the keyboard shortcuts pop-up are open (from the app menu). */
  const [zipOpen, setZipOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Counts session saves, for the Session button's "Saved" feedback. */
  const [sessionSaves, setSessionSaves] = useState(0);
  /** Live analyser: the spectrum of what's playing now, while playing with the Tonal tab open. */
  const [live, setLive] = useState<{ slot: Slot; values: number[] } | null>(null);

  // Latest state for event handlers registered once (keyboard, drag & drop).
  /** A lane's number; a song's own reference reads "R" and its song's number, the default "R". */
  const labelOf = (slot: Slot): string => {
    if (slot === NO_REFERENCE) return "–";
    if (slot === defaultSlot) return "R";
    const owner = ownerOf(slot);
    return owner !== null ? `R${labelOf(owner)}` : SLOT_LABELS[Math.max(0, order.indexOf(slot))];
  };
  /** What a lane's song is called: the name given to it, else its front version's title. (Used
   *  while rendering, so declared before anything rendered with it.) */
  const songName = (slot: Slot) => {
    const song = versions[slot];
    return song?.name.trim() || defaultName(tracks[slot], song?.versions[song.front] ?? tracks[slot]?.path);
  };
  const reference = referenceOf(subject);
  const latest = useRef({ tracks, regions, views, transport, linked, order, reports, markers, libraryOpen, leaving, loading, versions, versionsOpen, companions, defaultSlot, defaultRef, compareWith, pair: [0, 1] as Pair<Slot> });
  latest.current = { tracks, regions, views, transport, linked, order, reports, markers, libraryOpen, leaving, loading, versions, versionsOpen, companions, defaultSlot, defaultRef, compareWith, pair: [subject, reference] };
  /** Where Tab last went: listening to the song's reference, even a lane, keeps the song current. */
  const tabbedTo = useRef<Slot | null>(null);
  /** The path last asked for in each hidden reference slot, so it's loaded once. */
  const companionPaths = useRef<PerSlot<string | null>>(perSlot(null));
  /** Add files as references of a lane's song (set once it's declared, used by drop handlers). */
  const addReferencesRef = useRef<(slot: Slot, paths: string[]) => void>(() => {});
  /** Incremented per load so results for a replaced track are discarded. */
  const loadSeq = useRef<PerSlot<number>>(perSlot(0));
  /** Incremented per new song in a lane (not when another version comes in front), so the
   *  waveform sweeps in for a new song and only reshapes its bars for a version. */
  const songSeq = useRef<PerSlot<number>>(perSlot(0));

  useEffect(() => {
    api.audioStatus().then(setAudioStatus);
  }, []);

  // The library is indexed in the background from startup; follow its progress.
  useEffect(() => {
    const unlisten = listen<LibraryStatus>("library-status", (e) => setLibrary(e.payload));
    api.libraryStatus().then(setLibrary);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  /** Change a lane's markers and save them with its audio (also in any other lane playing that audio). */
  const changeMarkers = useCallback((slot: Slot, list: Marker[]) => {
    const track = latest.current.tracks[slot];
    if (!track) return;
    const sorted = [...list].sort((a, b) => a.time - b.time);
    setMarkers((m) => ALL_SLOTS.map((s) => (latest.current.tracks[s]?.audioId === track.audioId ? sorted : m[s])) as PerSlot<Marker[]>);
    api.saveMarkers(track.audioId, track.path, sorted).catch((e) => console.warn(`saving markers: ${e}`));
  }, []);

  /** Drop a marker at a lane's playhead and start writing its note. */
  const addMarker = useCallback(
    (slot: Slot) => {
      if (!latest.current.tracks[slot]) return;
      const time = Math.round(latest.current.transport.positions[slot] * 100) / 100;
      const current = latest.current.markers[slot];
      if (!current.some((m) => m.time === time)) changeMarkers(slot, [...current, { time, note: "" }]);
      setEditingMarker({ slot, time });
    },
    [changeMarkers],
  );

  // Keep every version of the songs with several prepared for switching: the ones not in front
  // first, then the front ones (so switching back is instant too). Same for songs' references.
  const wantedVersions = order.flatMap((s) => {
    const song = versions[s];
    const refs = song?.references ?? [];
    return [
      ...(song && song.versions.length > 1 ? song.versions.filter((_, i) => i !== song.front) : []),
      ...(refs.length > 1 ? refs.filter((_, i) => i !== (song!.referenceFront ?? 0)) : []),
    ];
  });
  const frontVersions = order.flatMap((s) => {
    const song = versions[s];
    const refs = song?.references ?? [];
    return [...(song && song.versions.length > 1 ? [song.versions[song.front]] : []), ...(refs.length > 1 ? [refs[song!.referenceFront ?? 0]] : [])];
  });
  const wantedKey = JSON.stringify([...wantedVersions, ...frontVersions]);
  useEffect(() => {
    const paths: string[] = JSON.parse(wantedKey);
    api
      .prepareVersions([...new Set(paths)])
      .then((ready) => setPrepared(new Set(ready)))
      .catch(() => {});
  }, [wantedKey]);
  useEffect(() => {
    const unlisten = listen<string>("version-prepared", ({ payload }) => setPrepared((p) => new Set(p).add(payload)));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Loudness of every version of the songs played loudness-matched, as each is measured (in the
  // background, or when it's analysed in its lane).
  const matchedVersions = order.flatMap((s) => (canMatchSong(versions[s]) && versions[s]!.matchLoudness ? [...versions[s]!.versions, ...(versions[s]!.references ?? [])] : []));
  const matchedKey = JSON.stringify(matchedVersions);
  useEffect(() => {
    const paths: string[] = JSON.parse(matchedKey);
    if (!paths.length) return setVersionLoudness(new Map());
    let cancelled = false;
    api
      .versionLoudness(paths)
      .then((found) => !cancelled && setVersionLoudness(new Map(paths.map((p, i) => [p, found[i]]))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [matchedKey, prepared, reports]);

  // Poll the engine's playheads once per animation frame.
  useEffect(() => {
    let raf = 0;
    let alive = true;
    const tick = async () => {
      try {
        const t = await api.transport();
        if (alive) setTransport(t);
      } finally {
        if (alive) raf = requestAnimationFrame(tick);
      }
    };
    tick();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  /** Forget what was shown for a lane's track. Switching versions (`version`) keeps the
   *  selection, zoom, normalizing and the old numbers until the new ones arrive, so the switch is
   *  seamless. */
  const resetSlot = (slot: Slot, version = false) => {
    if (!version) {
      setRegions((r) => setAt(r, slot, null));
      setViews((v) => setAt(v, slot, null));
      setReports((r) => setAt(r, slot, null));
      setNormalized((n) => setAt(n, slot, false));
    }
    setSelectionReports((s) => setAt(s, slot, null));
    setMarkers((m) => setAt(m, slot, []));
    setEditingMarker((e) => (e?.slot === slot ? null : e));
  };

  /** Load a file into a lane. As a new song (one version) unless `keepVersions`; `switching`
   *  puts another version in front, at the same playhead time (`at`), keeping the selection,
   *  loop and zoom. */
  const loadFile = useCallback(async (slot: Slot, path: string, play = false, opts: { keepVersions?: boolean; switching?: boolean; at?: number } = {}) => {
    if (!isAudioFile(path)) {
      setErrors((e) => setAt(e, slot, `Unsupported file type: ${path.split("/").pop()}`));
      return;
    }
    if (!opts.keepVersions) {
      const song = { name: "", versions: [path], front: 0 };
      latest.current.versions = setAt(latest.current.versions, slot, song);
      setVersions((v) => setAt(v, slot, song));
    }
    const seq = ++loadSeq.current[slot];
    setLoading((l) => setAt(l, slot, true));
    setErrors((e) => setAt(e, slot, null));
    try {
      const info = await api.loadTrack(slot, path, opts.at ?? null);
      if (seq !== loadSeq.current[slot]) return;
      // A new song (not another version) only once its waveform is there to sweep in.
      if (!opts.switching) songSeq.current[slot]++;
      setTracks((t) => setAt(t, slot, info));
      resetSlot(slot, !!opts.switching);
      if (opts.switching) {
        // The engine forgets the loop with the old buffer: set it again, within the new length.
        const region = latest.current.regions[slot];
        const kept = region && region.start < info.duration ? { start: region.start, end: Math.min(region.end, info.duration) } : null;
        if (kept) api.setLoop(slot, kept);
        else if (region) {
          setRegions((r) => setAt(r, slot, null));
          api.setLoopEnabled(slot, false);
        }
        const view = latest.current.views[slot];
        if (view && view.start >= info.duration) setViews((v) => setAt(v, slot, null));
      }
      api
        .markers(info.audioId, info.path)
        .then((found) => seq === loadSeq.current[slot] && setMarkers((m) => setAt(m, slot, found)))
        .catch(() => {});
      // First track loaded: make sure we're listening to something.
      const { tracks: current, transport: tr } = latest.current;
      if (!current[tr.active]) await api.setActive(slot);
      // Opened from Finder while idle: listen to it straight away.
      if (play && !latest.current.transport.playing) {
        await api.setActive(slot);
        await api.setPlaying(true);
      }
    } catch (err) {
      setErrors((e) => setAt(e, slot, String(err)));
      return;
    } finally {
      setLoading((l) => setAt(l, slot, false));
    }

    setMeasuringFull((m) => setAt(m, slot, true));
    try {
      const report = await api.analyze(slot, null, true);
      if (seq === loadSeq.current[slot]) setReports((r) => setAt(r, slot, report));
    } catch (err) {
      if (seq === loadSeq.current[slot]) setErrors((e) => setAt(e, slot, `Analysis: ${err}`));
    } finally {
      if (seq === loadSeq.current[slot]) setMeasuringFull((m) => setAt(m, slot, false));
    }
  }, []);

  /** Load dropped or opened files. One file goes into the lane it was dropped on (else the first
   *  empty one, else a new lane, else A). Several fill the lane they were dropped on, then the empty
   *  lanes after it (then before it), then new lanes, up to 50 tracks; `play` starts the first. */
  const loadPaths = useCallback(
    (paths: string[], target: Slot | null, play = false) => {
      const audio = paths.filter(isAudioFile);
      if (audio.length === 0) {
        if (paths.length) {
          setErrors((e) => setAt(e, target ?? 0, "Only mp3, flac, wav, aiff and m4a/aac files are supported"));
        }
        return;
      }
      // Dropped on the default reference strip: the new default (the last file).
      if (target === DEFAULT_TARGET || (target !== null && target === latest.current.defaultSlot)) {
        latest.current.defaultRef = audio[audio.length - 1];
        return setDefaultRef(audio[audio.length - 1]);
      }
      // Dropped on a song's reference: more references of that song.
      const owner = target === null ? -1 : latest.current.companions.indexOf(target);
      if (owner >= 0) return addReferencesRef.current(owner, audio);
      const { order: lanes, tracks: current, loading: busy, leaving: closing } = latest.current;
      const usable = lanes.filter((s) => !closing.includes(s));
      const empty = usable.filter((s) => !current[s] && !busy[s] && s !== target);
      const from = target === null ? 0 : usable.indexOf(target) + 1;
      const slots = [...(target === null ? [] : [target]), ...empty.filter((s) => usable.indexOf(s) >= from), ...empty.filter((s) => usable.indexOf(s) < from)];
      if (slots.length < audio.length) slots.push(...addExtrasRef.current(audio.length - slots.length));
      if (slots.length === 0) slots.push(0);
      audio.slice(0, slots.length).forEach((path, i) => loadFile(slots[i], path, play && i === 0));
      const left = audio.length - slots.length;
      if (left > 0) setErrors((e) => setAt(e, slots[slots.length - 1], `${left} more file${left === 1 ? "" : "s"} not loaded: all ${SLOT_COUNT} tracks are in use`));
    },
    [loadFile],
  );

  // Native drag & drop (gives real file paths, unlike HTML5 drop events).
  useEffect(() => {
    const slotAt = (pos: { x: number; y: number }): Slot | null => {
      const dpr = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr);
      if (el?.closest("[data-default-ref]")) return DEFAULT_TARGET;
      const slot = el?.closest<HTMLElement>("[data-slot]")?.dataset.slot;
      return slot === undefined ? null : (Number(slot) as Slot);
    };
    /** Over the versions drawer: dropped files become versions of its lane (or, over its
     *  references, references of its song). */
    const over = (pos: { x: number; y: number }, selector: string) => {
      const dpr = window.devicePixelRatio || 1;
      return !!document.elementFromPoint(pos.x / dpr, pos.y / dpr)?.closest(selector);
    };
    const onDrawer = (pos: { x: number; y: number }) => over(pos, "[data-versions-drop]");
    const onReferences = (pos: { x: number; y: number }) => over(pos, "[data-references-drop]");
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") {
        const drawer = onDrawer(payload.position);
        const refs = onReferences(payload.position);
        setVersionsDrop(drawer && !refs);
        setReferencesDrop(refs);
        setDropSlot(drawer ? null : slotAt(payload.position));
      } else if (payload.type === "drop") {
        setDropSlot(null);
        setVersionsDrop(false);
        setReferencesDrop(false);
        const open = latest.current.versionsOpen;
        if (open !== null && onReferences(payload.position)) addReferencesRef.current(open, payload.paths);
        else if (open !== null && onDrawer(payload.position)) addVersionsRef.current(open, payload.paths);
        else loadPaths(payload.paths, slotAt(payload.position));
      } else {
        setDropSlot(null);
        setVersionsDrop(false);
        setReferencesDrop(false);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadPaths]);

  // Files opened from Finder (double-click / Open With), including the ones that launched us.
  useEffect(() => {
    const take = () =>
      api.takeOpenedFiles().then((paths) => {
        const sessionFile = paths.find(isSessionFile);
        if (sessionFile) openSessionRef.current(sessionFile);
        else if (paths.length) loadPaths(paths, null, true);
      });
    const unlisten = listen("open-files", take);
    take();
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadPaths]);

  // Measure the selected sections whenever they change.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      for (const slot of ALL_SLOTS) {
        const region = regions[slot];
        if (!tracks[slot] || !region) {
          setSelectionReports((s) => setAt(s, slot, null));
          continue;
        }
        setMeasuringSel((m) => setAt(m, slot, true));
        api
          .analyze(slot, region, false)
          .then((r) => !cancelled && setSelectionReports((s) => setAt(s, slot, r)))
          .catch(() => !cancelled && setSelectionReports((s) => setAt(s, slot, null)))
          .finally(() => !cancelled && setMeasuringSel((m) => setAt(m, slot, false)));
      }
    }, SELECTION_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [regions, tracks]);

  const hasSelection = regions.some(Boolean);
  const effectiveScope: Scope = hasSelection ? scope : "full";
  // In selection mode, a track without a selection is measured as a whole, so you can compare
  // e.g. your chorus against the full reference without selecting in both lanes.
  const useSelection = (slot: Slot) => effectiveScope === "selection" && !!regions[slot];
  const shownAll = useMemo<PerSlot<AnalysisReport | null>>(
    () => ALL_SLOTS.map((s) => (useSelection(s) ? selectionReports[s] : reports[s])) as PerSlot<AnalysisReport | null>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveScope, regions, selectionReports, reports],
  );
  // Headroom of each track: the gain that brings its true peak (whole track, as it plays) up to
  // `NORMALIZE_PEAK_DBTP`; 0 when it's already there or not measured yet.
  const headroom = ALL_SLOTS.map((s) => {
    const peak = tracks[s] ? reports[s]?.loudness.stats.truePeak : null;
    return peak == null ? 0 : Math.max(0, NORMALIZE_PEAK_DBTP - peak);
  });
  /** Lanes whose versions (and references) play loudness-matched: each turned down to the quietest
   *  one. A song's reference in use is matched with its song. */
  const songMatched = (s: Slot) => !!versions[s]?.matchLoudness && canMatchSong(versions[s]);
  const versionsMatched = ALL_SLOTS.map((s) => !!tracks[s] && songMatched(ownerOf(s) ?? s));
  // Matching versions sets normalizing aside too (it would raise each version to its own peak).
  const normGain = ALL_SLOTS.map((s) => (normalized[s] && !versionsMatched[s] ? headroom[s] : 0));
  /** Each version's loudness (null: not measured yet), and the gain matching them gives the one in
   *  front; 0 until it and at least one other are measured. Loudness matching across the lanes sets
   *  the levels itself, so it's only used without it. */
  // Prepared files are measured in the background; the ones loaded are measured in their slot.
  const levelOf = (path: string) =>
    versionLoudness.get(path) ?? reports[ALL_SLOTS.find((s) => tracks[s]?.path === path) ?? -1]?.loudness.stats.integrated ?? null;
  const versionLevels = ALL_SLOTS.map((s) => (songMatched(s) ? versions[s]!.versions.map(levelOf) : []));
  const referenceLevels = ALL_SLOTS.map((s) => (songMatched(s) ? (versions[s]!.references ?? []).map(levelOf) : []));
  const versionGain = ALL_SLOTS.map((s) => {
    if (!versionsMatched[s]) return 0;
    const owner = ownerOf(s);
    const lane = owner ?? s;
    const song = versions[lane]!;
    const own = owner !== null ? referenceLevels[lane][song.referenceFront ?? 0] : versionLevels[lane][song.front];
    const known = [...versionLevels[lane], ...referenceLevels[lane]].filter((v): v is number => v != null);
    return own == null || known.length < 2 ? 0 : Math.min(...known) - own;
  });
  const versionGainUsed = ALL_SLOTS.map((s) => (matchEnabled ? 0 : versionGain[s]));

  // What the panel and the curves show: each track as it plays, normalized ones raised by their
  // gain. Matching, EQ and the trims work from the reports as measured.
  const gainedAll = useMemo(
    () => ALL_SLOTS.map((s) => withGain(shownAll[s], normGain[s])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownAll, normGain.join()],
  );
  const gainedFull = useMemo(
    () => ALL_SLOTS.map((s) => withGain(reports[s], normGain[s])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reports, normGain.join()],
  );
  /** Per-slot state for the compared pair: [track, reference]. */
  const pairOf = <T,>(q: PerSlot<T>): Pair<T> => [q[subject], q[reference]];
  const pairSlots: Pair<Slot> = [subject, reference];
  const shown = useMemo(() => pairOf(shownAll), [shownAll, subject, reference]);
  /** Selected ranges of the pair, when measuring selections (null = whole track). */
  const pairRanges = () => pairSlots.map((s) => (useSelection(s) ? regions[s] : null)) as Pair<Region | null>;

  // Stereo moves, then the width change and side moves; a fresh set starts with all switched on.
  const eqMoves = useMemo(() => movesOf(eq), [eq]);
  useEffect(() => {
    setEqActive(eqMoves.map(() => true));
  }, [eqMoves]);

  const chosenEq = useMemo<EqFilter[]>(() => eqMoves.filter((_, i) => eqActive[i] ?? true), [eqMoves, eqActive]);
  const eqAvailable = !!tracks[subject] && (auditionKind === "moves" ? chosenEq.length > 0 : !!eq);
  const eqOn = eqAudition && eqAvailable;
  const movesOn = eqOn && auditionKind === "moves";
  const fullWanted = eqOn && auditionKind === "full";
  const fullOn = fullWanted && !!eq && fullRendered === eq;

  // Compensate the EQ's loudness change, so switching it on doesn't just sound louder.
  const eqCompensation = useMemo(() => {
    const a = shown[0];
    if (!a) return 0;
    if (movesOn) {
      const { mid, side } = midSideCurves(chosenEq, a.spectrum.freqs);
      return -loudnessChange(a.spectrum, mid, side);
    }
    return fullOn && eq ? -loudnessChange(a.spectrum, eq.full.mid, eq.full.side) : 0;
  }, [movesOn, fullOn, shown[0], chosenEq, eq]);

  // The EQ is auditioned on the compared track; when that changes, the previous one is left dry.
  useEffect(() => {
    if (tracks[subject]) api.setEq(subject, chosenEq, movesOn);
  }, [chosenEq, movesOn, tracks[subject], subject]);
  useEffect(
    () => () => {
      api.setEq(subject, [], false);
      api.setFullMatch(subject, false);
      api.renderFullMatch(subject, null).catch(() => {});
      setFullRendered(null);
    },
    [subject],
  );

  // The full match plays from a rendering of the track through its curves, made when first asked
  // for and again whenever the match changes while it's wanted; until then it plays as it is.
  useEffect(() => {
    if (!fullWanted || !eq || fullRendered === eq) return;
    let cancelled = false;
    api
      .renderFullMatch(subject, { mid: eq.full.mid, side: eq.full.side })
      .then((done) => !cancelled && done && setFullRendered(eq))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [fullWanted, eq, fullRendered, subject]);

  useEffect(() => {
    if (tracks[subject]) api.setFullMatch(subject, fullOn);
  }, [fullOn, tracks[subject], subject]);

  // Normalizing raises a track by its headroom. Loudness matching then turns the louder tracks
  // down to the quietest (as normalized, so one quiet track no longer drags everything down); EQ
  // compensation is added on top. Never boost past a track's headroom (if a trim would, all come
  // down instead), so playback can't be pushed into clipping.
  const levels = ALL_SLOTS.map((s) => (tracks[s] ? (shownAll[s]?.loudness.stats.integrated ?? null) : null));
  const trims = useMemo<PerSlot<number>>(() => {
    const raw: PerSlot<number> = ALL_SLOTS.map((s) => normGain[s] + versionGainUsed[s] + (s === subject ? eqCompensation : 0));
    const known = levels.flatMap((v, s) => (v === null ? [] : [v + normGain[s]]));
    if (matchEnabled && known.length >= 2) {
      const target = Math.min(...known);
      levels.forEach((v, s) => {
        if (v !== null) raw[s] += target - (v + normGain[s]);
      });
    }
    const lift = Math.max(0, ...raw.map((t, s) => t - normGain[s]));
    return raw.map((t) => t - lift) as PerSlot<number>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchEnabled, levels.join(), normGain.join(), versionGainUsed.join(), eqCompensation, subject]);

  // Band levels over time, for whatever is being measured: used to find where each EQ move matters.
  const activityKey = pairSlots.map((s) => `${s}:${tracks[s]?.path ?? ""}@${useSelection(s) ? `${regions[s]!.start}-${regions[s]!.end}` : "full"}`).join("|");
  useEffect(() => {
    if (tab !== "tonal") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all(
        pairSlots.map((s) => (tracks[s] ? api.bandActivity(s, useSelection(s) ? regions[s] : null).catch(() => null) : null)),
      ).then(([a, b]) => {
        if (cancelled) return;
        setActivity([a, b]);
      });
    }, SELECTION_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activityKey]);

  const eqPassages = useMemo(() => {
    const [a, b] = activity;
    return eqMoves.map((f) => (a && b && !isWidth(f) ? passageFor(f, a, b) : null));
  }, [eqMoves, activity]);

  // EQ match: moves on the track towards the reference, for whatever is being measured (full
  // tracks or selections). Runs once both are measured, so it follows the same ranges as the
  // tables. A new pair drops the old match at once, so it's never auditioned on the wrong track.
  const matchedPair = useRef("");
  useEffect(() => {
    const [a, b] = shown;
    const key = pairSlots.join();
    if (!a || !b || key !== matchedPair.current) setEq(null);
    matchedPair.current = key;
    if (!a || !b) return;
    let cancelled = false;
    api
      .matchEq(pairSlots, pairRanges(), eqLoudest)
      .then((r) => !cancelled && setEq(r))
      .catch(() => !cancelled && setEq(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown[0], shown[1], eqLoudest, subject, reference]);

  // Live analyser: poll the spectrum at the playhead of the track being heard, ~15 times a second.
  const analysing = transport.playing && tab === "tonal" && panelOpen;
  useEffect(() => {
    if (!analysing) {
      setLive(null);
      return;
    }
    let busy = false;
    let alive = true;
    const timer = setInterval(() => {
      if (busy) return;
      const { transport: tr, tracks: current, reports: full } = latest.current;
      const slot = tr.active;
      if (!current[slot]) return;
      busy = true;
      api
        .liveSpectrum(slot, tr.positions[slot], full[slot]?.loudness.stats.integrated ?? null)
        .then((values) => alive && setLive(values ? { slot, values } : null))
        .catch(() => {})
        .finally(() => (busy = false));
    }, 66);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [analysing]);

  const overlays = useMemo(
    () => ALL_SLOTS.map((s) => overlayFor(curveMode, gainedFull[s], gainedAll[s])),
    [curveMode, gainedFull, gainedAll],
  );

  useEffect(() => {
    api.setPlayerMode(playerMode, order);
  }, [playerMode, order]);

  useEffect(() => {
    api.setTrims(trims);
  }, [trims.join()]);

  useEffect(() => {
    api.setVolume(volumeDb <= VOLUME_MIN_DB ? 0 : 10 ** (volumeDb / 20));
    try {
      localStorage.setItem(VOLUME_KEY, String(volumeDb));
    } catch {
      // Not remembered; playback is unaffected.
    }
  }, [volumeDb]);

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, panelOpen ? "1" : "0");
    } catch {
      // Not remembered.
    }
  }, [panelOpen]);

  // The panel slides over the lanes (a transform, no layout), and their column changes width once:
  // after it has slid in, or as soon as it starts sliding out (widening under it). So the
  // waveforms are redrawn once per open or close, not on every frame of the slide.
  const [panelDocked, setPanelDocked] = useState(panelOpen);
  useEffect(() => {
    if (!panelOpen) return setPanelDocked(false);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = setTimeout(() => setPanelDocked(true), reduce ? 0 : PANEL_SLIDE_MS);
    return () => clearTimeout(timer);
  }, [panelOpen]);

  /** Open… on a lane: one file loads there; several start there and fill more lanes. */
  const openDialog = async (slot: Slot) => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });
    if (picked?.length) loadPaths(picked, slot);
  };

  const clearTrack = async (slot: Slot) => {
    loadSeq.current[slot]++;
    await api.unloadTrack(slot);
    setTracks((t) => setAt(t, slot, null));
    setVersions((v) => setAt(v, slot, null));
    setVersionsOpen((o) => (o === slot ? null : o));
    setErrors((e) => setAt(e, slot, null));
    resetSlot(slot);
    if (latest.current.transport.active === slot) await listenElsewhere(slot);
  };

  /** Switch away from `slot` to the nearest loaded track before it, else after it. */
  const listenElsewhere = async (slot: Slot) => {
    const { order: lanes, tracks: current } = latest.current;
    const i = lanes.indexOf(slot);
    const others = [...lanes.slice(0, i).reverse(), ...lanes.slice(i + 1)];
    const next = others.find((s) => current[s]);
    if (next !== undefined) await api.setActive(next);
  };

  /** Add up to `n` empty lanes at the end, to drop or open files into; their slots (fewer when
   *  the 50 run out). Works from the latest order, so several calls in one event don't collide. */
  const addExtras = (n: number): Slot[] => {
    const { companions: refs, defaultSlot: def } = latest.current;
    const taken = new Set<Slot>([...latest.current.order, ...latest.current.leaving, ...refs.filter((c): c is Slot => c !== null), ...(def === null ? [] : [def])]);
    const free = EXTRA_SLOTS.filter((s) => !taken.has(s)).slice(0, Math.max(0, n));
    if (!free.length) return [];
    latest.current.order = [...latest.current.order, ...free];
    setOrder((o) => [...o, ...free]);
    setEntering((e) => [...e, ...free]);
    setOpening((o) => [...o, ...free]);
    // Drawn collapsed first, then grown, so the lanes open smoothly.
    requestAnimationFrame(() => requestAnimationFrame(() => setEntering((e) => e.filter((s) => !free.includes(s)))));
    setTimeout(() => setOpening((o) => o.filter((s) => !free.includes(s))), LANE_ANIMATION_MS + 50);
    return free;
  };
  const addExtra = (): Slot | undefined => addExtras(1)[0];

  /** A lane being dragged to a new place: `index` is where it would go, in the current order. */
  const [laneDrag, setLaneDrag] = useState<{ slot: Slot; index: number } | null>(null);
  const lanesRef = useRef<HTMLElement>(null);
  /** Lane tops just before a reorder, so the lanes can glide to their new places (FLIP). */
  const flipFrom = useRef<Map<string, number> | null>(null);
  const laneTops = () =>
    new Map(
      Array.from(lanesRef.current?.querySelectorAll<HTMLElement>(":scope > .lane") ?? []).map((el) => [el.dataset.slot!, el.getBoundingClientRect().top]),
    );
  useLayoutEffect(() => {
    const before = flipFrom.current;
    flipFrom.current = null;
    if (!before || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [slot, top] of laneTops()) {
      const from = before.get(slot);
      if (from === undefined || Math.abs(from - top) < 1) continue;
      lanesRef.current
        ?.querySelector<HTMLElement>(`:scope > .lane[data-slot="${slot}"]`)
        ?.animate([{ transform: `translateY(${from - top}px)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(0.3, 0.7, 0.3, 1)" });
    }
  }, [order]);

  /** Drag a lane by its header to reorder: a press becomes a drag after a few pixels; a line shows
   *  where it would land; numbers (and colours) follow the new positions. Esc cancels. */
  const dragLane = (slot: Slot, down: ReactPointerEvent) => {
    if (down.button !== 0 || (down.target as HTMLElement).closest(".lane-actions, input, a")) return;
    const startY = down.clientY;
    let active = false;
    let index = -1;
    const container = lanesRef.current;
    /** Insertion index for a pointer height: before the first lane whose middle is below it. */
    const indexAt = (y: number) => {
      const lanes = latest.current.order;
      for (let i = 0; i < lanes.length; i++) {
        const el = container?.querySelector<HTMLElement>(`:scope > .lane[data-slot="${lanes[i]}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (y < r.top + r.height / 2) return i;
      }
      return lanes.length;
    };
    const move = (e: PointerEvent) => {
      if (!active && Math.abs(e.clientY - startY) < 6) return;
      if (!active) document.body.classList.add("dragging-lane");
      active = true;
      // Near the top or bottom of the lane list, scroll it.
      if (container) {
        const r = container.getBoundingClientRect();
        if (e.clientY < r.top + 40) container.scrollBy(0, -12);
        else if (e.clientY > r.bottom - 40) container.scrollBy(0, 12);
      }
      index = indexAt(e.clientY);
      setLaneDrag({ slot, index });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("keydown", escape, true);
      if (!active) return;
      document.body.classList.remove("dragging-lane");
      setLaneDrag(null);
      // The press ended a drag, not a click: don't let it switch tracks on the way out.
      window.addEventListener("click", stop, true);
      setTimeout(() => window.removeEventListener("click", stop, true), 0);
      if (!commit || index < 0) return;
      const lanes = latest.current.order;
      const from = lanes.indexOf(slot);
      const to = index > from ? index - 1 : index;
      if (to === from) return;
      const next = lanes.filter((s) => s !== slot);
      next.splice(to, 0, slot);
      flipFrom.current = laneTops();
      setOrder(next);
    };
    const stop = (e: Event) => e.stopPropagation();
    const up = () => finish(true);
    const cancelPointer = () => finish(false);
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("keydown", escape, true);
  };
  /** Where the dragged lane would land, for the insertion line (none when it wouldn't move). */
  const reorderMark = (slot: Slot): "source" | "before" | "after" | null => {
    if (!laneDrag) return null;
    if (slot === laneDrag.slot) return "source";
    const from = order.indexOf(laneDrag.slot);
    const { index } = laneDrag;
    if (index === from || index === from + 1) return null;
    if (index < order.length) return order[index] === slot ? "before" : null;
    return order[order.length - 1] === slot ? "after" : null;
  };
  const addExtrasRef = useRef(addExtras);
  addExtrasRef.current = addExtras;

  /** Where the library's Load menu can put a file: any lane, or "New track" — the first empty
   *  lane, else a new one (while under 50). */
  const emptyLane = order.find((s) => !tracks[s] && !loading[s] && !leaving.includes(s));
  /** Drag a library row onto a lane (pointer events: Tauri's native file drop swallows HTML5
   *  drag and drop). A press becomes a drag after a few pixels; buttons in the row keep their clicks. */
  const dragFromLibrary = (item: DragItem, down: ReactPointerEvent) => {
    if (down.button !== 0 || (down.target as HTMLElement).closest("button, a, input")) return;
    down.preventDefault(); // no text selection while dragging
    const start = { x: down.clientX, y: down.clientY };
    let active = false;
    const laneAt = (x: number, y: number): Slot | null => {
      if (document.elementFromPoint(x, y)?.closest("[data-default-ref]")) return DEFAULT_TARGET;
      const slot = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-slot]")?.dataset.slot;
      if (slot === undefined) return null;
      const s = Number(slot) as Slot;
      return latest.current.leaving.includes(s) ? null : s;
    };
    const move = (e: PointerEvent) => {
      if (!active && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
      active = true;
      document.body.classList.add("dragging-track");
      setDragging({ ...item, x: e.clientX, y: e.clientY });
      setDropSlot(laneAt(e.clientX, e.clientY));
    };
    const end = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", cancel, true);
      if (!active) return;
      document.body.classList.remove("dragging-track");
      const slot = e.type === "pointerup" ? laneAt(e.clientX, e.clientY) : null;
      setDragging(null);
      setDropSlot(null);
      if (slot !== null) loadPaths([item.path], slot);
    };
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      end(new PointerEvent("pointercancel"));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("keydown", cancel, true);
  };

  const targetsDefault = (path: string) => {
    latest.current.defaultRef = path;
    setDefaultRef(path);
  };
  /** Open the library to load into a lane, add to a song's references, or set the default. */
  const openLibraryFor = (target: NonNullable<typeof libraryFor>) => {
    setLibraryFor(target);
    setVersionsOpen(null);
    setLibraryOpen(true);
  };

  const loadTargets: LoadTargets = {
    lanes: order
      .filter((s) => !leaving.includes(s))
      .map((s) => {
        const t = tracks[s];
        return { slot: s, label: labelOf(s), path: t?.path ?? null, name: t ? songName(s) : null };
      }),
    into: (slot, path) => loadFile(slot, path),
    target: !libraryFor
      ? null
      : libraryFor.kind === "default"
        ? { label: "R", text: "Default reference", load: (path) => targetsDefault(path) }
        : libraryFor.kind === "ref"
          ? { label: `R${labelOf(libraryFor.owner)}`, text: `Reference of ${labelOf(libraryFor.owner)}`, load: (path) => addReferences(libraryFor.owner, [path]) }
          : {
              label: labelOf(libraryFor.slot),
              text: tracks[libraryFor.slot] ? `Replace ${songName(libraryFor.slot)}` : `Into track ${labelOf(libraryFor.slot)}`,
              load: (path) => loadFile(libraryFor.slot, path),
            },
    asDefault: targetsDefault,
    asReference: tracks[subject] ? { label: labelOf(subject), name: songName(subject), add: (path) => addReferences(subject, [path]) } : null,
    newLabel: emptyLane !== undefined ? labelOf(emptyLane) : extras.length < EXTRA_SLOTS.length ? SLOT_LABELS[order.length] : null,
    drag: dragFromLibrary,
    loadNew: (path) => {
      const slot = emptyLane ?? addExtra();
      if (slot !== undefined) loadFile(slot, path);
    },
  };

  /** Close an extra lane: the track after it moves up (D becomes C). One at a time: clicks while a
   *  lane is still closing are ignored, so a double-click removes one track, not two. */
  const removeExtra = async (slot: Slot) => {
    if (leaving.length) return;
    setLeaving((l) => [...l, slot]);
    if (latest.current.transport.active === slot) await listenElsewhere(slot);
    loadSeq.current[slot]++;
    setTimeout(async () => {
      await api.unloadTrack(slot);
      setTracks((t) => setAt(t, slot, null));
      setVersions((v) => setAt(v, slot, null));
      setVersionsOpen((o) => (o === slot ? null : o));
      setErrors((e) => setAt(e, slot, null));
      setLoading((l) => setAt(l, slot, false));
      resetSlot(slot);
      setOrder((o) => o.filter((s) => s !== slot));
      setLeaving((l) => l.filter((s) => s !== slot));
    }, LANE_ANIMATION_MS);
  };

  const loadedSlots = () => ALL_SLOTS.filter((s) => latest.current.tracks[s]);

  /** Every lane's song (versions, the one in front, its name, references, what it's compared
   *  with: another lane by its index here), in lane order: what a session saves. */
  const laneSongs = (): LaneVersions[] => {
    const { order: lanes, versions: songs } = latest.current;
    const kept = lanes.filter((s) => songs[s]?.versions.length);
    return kept.map((s) => {
      const choice = latest.current.compareWith[s];
      const lane = typeof choice === "number" ? kept.indexOf(choice) : -1;
      return { ...songs[s]!, ...(lane >= 0 ? { compareLane: lane } : {}), ...(choice === "default" ? { compareDefault: true } : {}) };
    });
  };


  /** Empty a hidden reference slot (its song has no reference left, or is gone; or the default
   *  reference was removed). Listening to it moves to `back`. */
  const unloadCompanion = (slot: Slot, back: Slot | null) => {
    loadSeq.current[slot]++;
    companionPaths.current[slot] = null;
    api.unloadTrack(slot).catch(() => {});
    setTracks((t) => setAt(t, slot, null));
    setErrors((e) => setAt(e, slot, null));
    setLoading((l) => setAt(l, slot, false));
    resetSlot(slot);
    if (latest.current.transport.active === slot) {
      if (back !== null && latest.current.tracks[back]) api.setActive(back);
      else listenElsewhere(back ?? latest.current.order[0]);
    }
  };

  /** Load `want` into a hidden reference slot unless it's already there; another file switches
   *  in place at the same time. */
  const fillCompanion = (slot: Slot, want: string) => {
    if (companionPaths.current[slot] === want) return;
    const switching = companionPaths.current[slot] !== null && !!latest.current.tracks[slot];
    companionPaths.current[slot] = want;
    loadFile(slot, want, false, { keepVersions: true, switching, at: switching ? latest.current.transport.positions[slot] : undefined });
  };

  /** A free engine slot for a reference: taken from the end, as lanes are added from the start. */
  const freeReferenceSlot = (taken: Slot[]): Slot | null => {
    const used = new Set<Slot>([...latest.current.order, ...latest.current.leaving, ...taken]);
    return [...EXTRA_SLOTS].reverse().find((s) => !used.has(s)) ?? null;
  };

  // Keep each song's reference in use loaded in a hidden slot of its own: given one when its first
  // reference is added, switched in place at the same time when another reference is put in use,
  // and freed with the last one. The session's default reference likewise.
  useEffect(() => {
    const { order: lanes, versions: songs, companions: had, defaultSlot: hadDefault } = latest.current;
    let next = had;
    had.forEach((c, owner) => {
      if (c === null) return;
      const song = lanes.includes(owner) ? songs[owner] : null;
      if (song?.references?.length) return;
      unloadCompanion(c, owner);
      next = setAt(next, owner, null);
    });
    let def = hadDefault;
    if (def !== null && !defaultRef) {
      unloadCompanion(def, latest.current.pair[0]);
      def = null;
    }
    const taken = () => [...next.filter((x): x is Slot => x !== null), ...(def === null ? [] : [def])];
    if (defaultRef) {
      def ??= freeReferenceSlot(taken());
      if (def === null) setErrors((e) => setAt(e, lanes[0], `No room for the default reference: all ${SLOT_COUNT} tracks are in use`));
      else fillCompanion(def, defaultRef);
    }
    for (const owner of lanes) {
      const song = songs[owner];
      const want = song?.references?.[song.referenceFront ?? 0];
      if (!want) continue;
      let c = next[owner];
      if (c === null) {
        c = freeReferenceSlot(taken());
        if (c === null) {
          setErrors((e) => setAt(e, owner, `No room for this song's reference: all ${SLOT_COUNT} tracks are in use`));
          continue;
        }
        next = setAt(next, owner, c);
      }
      fillCompanion(c, want);
    }
    if (next !== had) {
      latest.current.companions = next;
      setCompanions(next);
    }
    if (def !== hadDefault) {
      latest.current.defaultSlot = def;
      setDefaultSlot(def);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions, order, defaultRef]);

  const setSong = (slot: Slot, song: LaneVersions) => {
    latest.current.versions = setAt(latest.current.versions, slot, song);
    setVersions((v) => setAt(v, slot, song));
  };

  /** Add files as references of a lane's song; the last one added is put in use. */
  const addReferences = (slot: Slot, paths: string[]) => {
    const audio = paths.filter(isAudioFile);
    const song = latest.current.versions[slot];
    if (!audio.length) {
      if (paths.length) setErrors((e) => setAt(e, slot, "Only mp3, flac, wav, aiff and m4a/aac files are supported"));
      return;
    }
    if (!song) return;
    const list = [...(song.references ?? []), ...audio.filter((p) => !song.references?.includes(p))];
    setSong(slot, { ...song, references: list, referenceFront: list.indexOf(audio[audio.length - 1]) });
    setCompareWith((c) => setAt(c, slot, null));
  };
  addReferencesRef.current = addReferences;

  const addReferenceDialog = async (slot: Slot) => {
    const picked = await open({ multiple: true, filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
    if (picked?.length) addReferences(slot, picked);
  };

  /** Put another of a song's references in use: it loads in place, at the same playhead time. */
  const showReference = (slot: Slot, index: number) => {
    const song = latest.current.versions[slot];
    if (!song?.references?.[index]) return;
    setSong(slot, { ...song, referenceFront: index });
    setCompareWith((c) => setAt(c, slot, null));
  };

  /** Take a reference out of a song (the file stays); the one in use hands over to a neighbour. */
  const removeReference = (slot: Slot, index: number) => {
    const song = latest.current.versions[slot];
    if (!song?.references) return;
    const list = song.references.filter((_, i) => i !== index);
    const front = song.referenceFront ?? 0;
    const { references: _, referenceFront: __, ...rest } = song;
    if (!list.length) return setSong(slot, rest);
    setSong(slot, { ...rest, references: list, referenceFront: front > index ? front - 1 : Math.min(front, list.length - 1) });
  };

  /** Put another version of a lane's song in front: it loads in place, at the same playhead time. */
  const showVersion = (slot: Slot, index: number) => {
    const song = latest.current.versions[slot];
    if (!song || index === song.front || !song.versions[index]) return;
    const next = { ...song, front: index };
    latest.current.versions = setAt(latest.current.versions, slot, next);
    setVersions((v) => setAt(v, slot, next));
    loadFile(slot, song.versions[index], false, { keepVersions: true, switching: true, at: latest.current.transport.positions[slot] });
  };

  /** Add files as versions of a lane's song; the last one added comes in front. */
  const addVersions = (slot: Slot, paths: string[]) => {
    const audio = paths.filter(isAudioFile);
    const current = latest.current.tracks[slot];
    const song = latest.current.versions[slot] ?? (current ? { name: "", versions: [current.path], front: 0 } : null);
    if (!audio.length) {
      if (paths.length) setErrors((e) => setAt(e, slot, "Only mp3, flac, wav, aiff and m4a/aac files are supported"));
      return;
    }
    if (!song) return loadPaths(audio, slot);
    const added = audio.filter((p) => !song.versions.includes(p));
    const list = [...song.versions, ...added];
    const front = list.indexOf(audio[audio.length - 1]);
    const next = { ...song, versions: list, front: song.front };
    latest.current.versions = setAt(latest.current.versions, slot, next);
    setVersions((v) => setAt(v, slot, next));
    showVersion(slot, front);
  };
  const addVersionsRef = useRef(addVersions);
  addVersionsRef.current = addVersions;

  const addVersionDialog = async (slot: Slot) => {
    const picked = await open({ multiple: true, filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
    if (picked?.length) addVersions(slot, picked);
  };

  /** Take a version out of a lane's song (the file stays); the one in front hands over to a neighbour. */
  const removeVersion = (slot: Slot, index: number) => {
    const song = latest.current.versions[slot];
    if (!song || song.versions.length < 2) return;
    const list = song.versions.filter((_, i) => i !== index);
    if (index === song.front) {
      const front = Math.min(index, list.length - 1);
      const next = { ...song, versions: list, front: -1 };
      latest.current.versions = setAt(latest.current.versions, slot, next);
      setVersions((v) => setAt(v, slot, next));
      showVersion(slot, front);
    } else {
      const next = { ...song, versions: list, front: song.front > index ? song.front - 1 : song.front };
      latest.current.versions = setAt(latest.current.versions, slot, next);
      setVersions((v) => setAt(v, slot, next));
    }
  };

  /** Play a lane's versions loudness-matched, or as they are. */
  const toggleVersionMatch = (slot: Slot) =>
    setVersions((v) => (v[slot] ? setAt(v, slot, { ...v[slot]!, matchLoudness: !v[slot]!.matchLoudness || undefined }) : v));
  const renameSong = (slot: Slot, name: string) => setVersions((v) => (v[slot] ? setAt(v, slot, { ...v[slot]!, name }) : v));
  /** Give a song a colour of its own, or (null) back its automatic one. */
  const recolorSong = (slot: Slot, color: string | null) =>
    setVersions((v) => {
      if (!v[slot]) return v;
      const { color: _, ...song } = v[slot]!;
      return setAt(v, slot, color ? { ...song, color } : song);
    });
  const folderOf = (path: string) => path.replace(/\/[^/]*$/, "");

  /** Replace every lane with these songs, in order (1, 2, then new lanes), stopped at the start,
   *  and the default reference with `defaultReference`. */
  const replaceTracks = async (songs: LaneVersions[], defaultReference: string | null = null) => {
    await api.setPlaying(false);
    const unloads: Promise<void>[] = [];
    for (const s of ALL_SLOTS) {
      loadSeq.current[s]++;
      if (latest.current.tracks[s] || latest.current.loading[s]) unloads.push(api.unloadTrack(s));
      resetSlot(s);
    }
    await Promise.all(unloads);
    clearRegions();
    setTracks(perSlot(null));
    setErrors(perSlot(null));
    setLoading(perSlot(false));
    setEntering([]);
    setOpening([]);
    setLeaving([]);
    setVersionsOpen(null);
    const count = Math.min(ALL_SLOTS.length, Math.max(2, songs.length));
    const lanes: Slot[] = [0, 1, ...EXTRA_SLOTS.slice(0, count - 2)];
    latest.current.order = lanes;
    latest.current.tracks = perSlot(null);
    setOrder(lanes);
    setSubject(0);
    latest.current.companions = perSlot(null);
    setCompanions(perSlot(null));
    latest.current.defaultSlot = null;
    setDefaultSlot(null);
    companionPaths.current = perSlot(null);
    latest.current.defaultRef = defaultReference;
    setDefaultRef(defaultReference);
    // Saved links to lanes are by index: back to the slots the lanes get now.
    setCompareWith(
      lanes.reduce(
        (c, s, i) => setAt(c, s, songs[i]?.compareDefault ? "default" : songs[i]?.compareLane != null ? (lanes[songs[i].compareLane!] ?? null) : null),
        perSlot<Slot | "default" | null>(null),
      ),
    );
    await api.setActive(0);
    const placed = perSlot<LaneVersions | null>(null);
    songs.slice(0, lanes.length).forEach(({ compareLane: _, compareDefault: __, ...song }, i) => (placed[lanes[i]] = { ...song, front: Math.min(Math.max(0, song.front), song.versions.length - 1) }));
    latest.current.versions = placed;
    setVersions(placed);
    for (const s of lanes) if (placed[s]) loadFile(s, placed[s]!.versions[placed[s]!.front], false, { keepVersions: true });
  };

  const openSessionPath = async (path: string) => {
    try {
      const opened = await api.openSession(path);
      setSession(opened);
      setRelinked(opened.relinked);
      await replaceTracks(opened.lanes, opened.defaultReference);
    } catch (e) {
      setErrors((err) => setAt(err, 0, String(e)));
    }
  };
  const openSessionRef = useRef(openSessionPath);
  openSessionRef.current = openSessionPath;

  const openSessionDialog = async () => {
    const picked = await open({ filters: [{ name: "(a/b)normal session", extensions: [SESSION_EXTENSION] }] });
    if (typeof picked === "string") openSessionPath(picked);
  };

  /** Save the lanes as a session: over the open one, or (`as`, or none open) to a new file. */
  const saveSession = async (as = false) => {
    const songs = laneSongs();
    if (!songs.length) return;
    let path = as ? null : (session?.path ?? null);
    if (!path) {
      const folder = folderOf(session?.path ?? songs[0].versions[songs[0].front]);
      const name = session?.name ?? folder.split("/").pop() ?? "Session";
      path = await save({ defaultPath: `${folder}/${name}.${SESSION_EXTENSION}`, filters: [{ name: "(a/b)normal session", extensions: [SESSION_EXTENSION] }] });
      if (!path) return;
      if (!isSessionFile(path)) path += `.${SESSION_EXTENSION}`;
    }
    try {
      setSession(await api.saveSession(path, songs, latest.current.defaultRef));
      setSessionSaves((n) => n + 1);
    } catch (e) {
      setErrors((err) => setAt(err, latest.current.order[0], `Saving the session: ${e}`));
    }
  };
  /** Start a clean session: the open one is saved first, then every lane is emptied. */
  const newSession = async () => {
    if (session && laneSongs().length) await saveSession();
    setSession(null);
    await replaceTracks([]);
  };
  const sessionKeys = useRef({ open: openSessionDialog, save: saveSession, fresh: newSession });
  sessionKeys.current = { open: openSessionDialog, save: saveSession, fresh: newSession };

  /** Write every track's notes, song by song in lane order, to a Markdown file. */
  const exportNotes = async () => {
    const { order: lanes, tracks: current, markers: notes, versions: songs } = latest.current;
    const list = lanes.flatMap((s) => {
      const song = songs[s];
      const version = song && song.versions.length > 1 ? { index: song.front, count: song.versions.length } : null;
      return current[s] ? [{ name: songName(s), version, track: current[s]!, markers: notes[s] }] : [];
    });
    if (!list.length) return;
    const folder = folderOf(session?.path ?? list[0].track.path);
    const title = session?.name ?? (list.length === 1 ? list[0].name : (folder.split("/").pop() ?? "Notes"));
    let path = await save({ defaultPath: `${folder}/${title} notes.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!path) return;
    if (!/\.md$/i.test(path)) path += ".md";
    try {
      await api.writeNotes(path, notesMarkdown(`${title} — notes`, list));
      setNotesStatus("Exported");
    } catch (e) {
      setNotesStatus(`Not exported: ${e}`);
    }
    setTimeout(() => setNotesStatus(null), 2500);
  };

  /** Export as Zip: ask where (beside the session, named after it), then write the zip. Its name
   *  is the album tag. */
  const exportZip = async (items: ZipItem[], format: ZipFormat, artist: string, started: () => void): Promise<string | null> => {
    const folder = folderOf(session?.path ?? items[0].source);
    const name = session?.name ?? folder.split("/").pop() ?? "Tracks";
    let path = await save({ defaultPath: `${folder}/${name}.zip`, filters: [{ name: "Zip archive", extensions: ["zip"] }] });
    if (!path) return null;
    if (!/\.zip$/i.test(path)) path += ".zip";
    started();
    await api.exportZip(path, items, format, artist, path.split("/").pop()!.replace(/\.zip$/i, ""));
    return path;
  };
  /** What Export as Zip offers: each loaded lane's version in front, in lane order. */
  const zipTracks: ZipTrack[] = order.flatMap((s) => {
    const track = tracks[s];
    const song = versions[s];
    if (!track) return [];
    const version = song && song.versions.length > 1 ? `${song.front + 1} of ${song.versions.length}` : null;
    return [{ label: labelOf(s), title: songName(s), path: track.path, artist: track.artist, version }];
  });

  /** Seek one track, or every loaded track to the same time when playheads are linked. */
  const seek = useCallback((slot: Slot, seconds: number) => {
    const targets = latest.current.linked ? loadedSlots() : [slot];
    for (const s of targets) {
      const duration = latest.current.tracks[s]!.duration;
      api.seek(s, Math.min(Math.max(0, seconds), duration));
    }
  }, []);

  /** Move every loaded playhead by the same amount, preserving any offset between them. */
  const skip = useCallback((delta: number) => {
    const { tracks: current, transport: tr } = latest.current;
    for (const s of loadedSlots()) {
      api.seek(s, Math.min(Math.max(0, tr.positions[s] + delta), current[s]!.duration));
    }
  }, []);

  const toStart = useCallback(() => {
    const { regions: r, transport: tr } = latest.current;
    for (const s of loadedSlots()) {
      api.seek(s, tr.loopEnabled[s] && r[s] ? r[s]!.start : 0);
    }
  }, []);

  /** Set (or clear) the selection and loop of each listed track. */
  const applyRegions = useCallback((updates: [Slot, Region | null][]) => {
    const { tracks: current, regions: prev } = latest.current;
    let next = prev;
    for (const [s, region] of updates) {
      const duration = current[s]!.duration;
      const clamped =
        region && region.start < duration
          ? { start: region.start, end: Math.min(region.end, duration) }
          : null;
      next = setAt(next, s, clamped);
      api.setLoop(s, clamped);
      if (clamped) api.seek(s, clamped.start);
      // No selection, nothing to loop: a later selection starts unlooped.
      else api.setLoopEnabled(s, false);
    }
    setRegions(next);
    // A fresh selection is what you want to read numbers for.
    if (updates.some(([, r]) => r)) setScope("selection");
  }, []);

  /** In linked mode a selection applies to both tracks, so their loops stay in sync. */
  const setRegion = useCallback(
    (slot: Slot, region: Region | null) => {
      const targets = latest.current.linked ? loadedSlots() : [slot];
      applyRegions(targets.map((s) => [s, region]));
    },
    [applyRegions],
  );

  const clearRegions = useCallback(() => {
    for (const s of ALL_SLOTS) {
      api.setLoop(s, null);
      api.setLoopEnabled(s, false);
    }
    setRegions(perSlot(null));
  }, []);

  /**
   * Set a lane's visible window. When linked, both lanes show the same time window so the same
   * moment lines up vertically; a window covering the whole track is stored as "fit" (null).
   */
  const setView = useCallback((slot: Slot, view: View) => {
    const { linked: isLinked, tracks: current, views: prev } = latest.current;
    const targets = isLinked ? loadedSlots() : [slot];
    let next = prev;
    for (const s of targets) {
      const duration = current[s]!.duration;
      const fits = s === slot ? isFull(view, duration) : view.start <= 0 && view.end >= duration;
      next = setAt(next, s, fits ? null : view);
    }
    setViews(next);
  }, []);

  const zoomActive = useCallback((factor: number) => {
    const { tracks: current, views: v, transport: tr } = latest.current;
    const slot = current[tr.active] ? tr.active : loadedSlots()[0];
    if (slot === undefined) return;
    const duration = current[slot]!.duration;
    const view = v[slot] ?? fullView(duration);
    const pos = tr.positions[slot];
    const anchor = pos >= view.start && pos <= view.end ? pos : (view.start + view.end) / 2;
    setView(slot, zoomView(view, factor, anchor, duration));
  }, [setView]);

  // While playing, page the view forward so the playhead stays visible.
  useEffect(() => {
    if (!transport.playing) return;
    const slot = transport.active;
    const view = views[slot];
    const track = tracks[slot];
    if (!view || !track) return;
    const pos = transport.positions[slot];
    if (pos >= view.start && pos <= view.end) return;
    const span = view.end - view.start;
    const start = pos - span * 0.05;
    setView(slot, clampView({ start, end: start + span }, track.duration));
  }, [transport, views, tracks, setView]);

  const togglePlay = useCallback(() => {
    api.setPlaying(!latest.current.transport.playing);
  }, []);

  const selectSlot = useCallback((slot: Slot) => {
    if (latest.current.tracks[slot]) api.setActive(slot);
  }, []);

  /** Loop a track's selection, or stop: with linked selections, every loaded track's together. */
  const toggleLoop = useCallback((slot: Slot) => {
    const { transport: tr, linked: isLinked, regions: r } = latest.current;
    const on = !tr.loopEnabled[slot];
    for (const s of isLinked ? loadedSlots() : [slot]) if (!on || r[s]) api.setLoopEnabled(s, on);
  }, []);

  /** Select and loop a passage of the compared track, listening to it. */
  const listenTo = useCallback(
    (region: Region) => {
      if (!latest.current.tracks[subject]) return;
      setRegion(subject, region);
      api.setLoopEnabled(subject, true);
      selectSlot(subject);
    },
    [setRegion, selectSlot, subject],
  );

  // The compared song is the one listened to. Listening to a reference keeps its song: a song's
  // own, the default, or a lane it's compared with when reached with Tab.
  useEffect(() => {
    const active = transport.active;
    if (active === tabbedTo.current || active === defaultSlot) return;
    // Moved on from where Tab went: picking that track again later makes it the current song.
    tabbedTo.current = null;
    const owner = ownerOf(active);
    if (owner !== null) {
      if (tracks[owner]) setSubject(owner);
    } else if (tracks[active]) setSubject(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport.active, tracks, companions, defaultSlot]);

  // A closed lane leaves the pair, and links to it go.
  useEffect(() => {
    if (!order.includes(subject)) setSubject(order[0]);
    setCompareWith((c) => {
      const next = c.map((v, s) => (!order.includes(s) || (typeof v === "number" && !order.includes(v)) ? null : v));
      return next.some((v, s) => v !== c[s]) ? next : c;
    });
  }, [order, subject]);

  /** Compare `slot`: the compared song is the one listened to, so this switches to it. */
  const setPairTrack = (slot: Slot) => {
    setSubject(slot);
    selectSlot(slot);
  };

  /** A song's own reference picked on its strip: the song is compared with it again (and listened to). */
  const backToOwnReference = (owner: Slot) => {
    setCompareWith((c) => setAt(c, owner, null));
    if (owner !== subject) setPairTrack(owner);
  };

  /** What the current song is compared with: one of its own references, the default, or a lane. */
  const compareSubjectWith = (choice: CompareChoice) => {
    if (choice.kind === "own") return showReference(subject, choice.index);
    setCompareWith((c) => setAt(c, subject, choice.kind === "default" ? "default" : choice.slot));
  };

  /** The current song's reference becomes the session's default, for every song without its own. */
  const useForAllSongs = () => {
    const path = tracks[reference]?.path;
    if (!path || reference === defaultSlot) return;
    latest.current.defaultRef = path;
    setDefaultRef(path);
    if (typeof compareWith[subject] === "number") setCompareWith((c) => setAt(c, subject, "default"));
  };

  /** Make a lane's track the default reference: it leaves the lanes (sessions from before default
   *  references kept their reference in track 2). */
  const moveToDefault = (slot: Slot) => {
    const path = tracks[slot]?.path;
    if (!path) return;
    latest.current.defaultRef = path;
    setDefaultRef(path);
    if (slot > 1) removeExtra(slot);
    else clearTrack(slot);
  };

  const removeDefault = () => {
    latest.current.defaultRef = null;
    setDefaultRef(null);
  };

  /** Open a file as the default reference. */
  const defaultReferenceDialog = async () => {
    const picked = await open({ filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
    if (typeof picked === "string") {
      latest.current.defaultRef = picked;
      setDefaultRef(picked);
    }
  };

  // Colours go with the track, not its position: a lane's number (`--lane-N`, and the darker chart
  // variant) is pointed at its song's colour, so the lane, its button, meter and its columns/curves
  // all follow it when it's moved. That's the colour picked for the song, else its cover's when
  // colourful, else its engine slot's hue (slots don't move with the lanes).
  // A song's own reference ("R3") takes its cover's colour too, else a neutral reference colour.
  const hidden = [...companions.filter((c): c is Slot => c !== null), ...(defaultSlot === null ? [] : [defaultSlot])];
  const colorOf = (slot: Slot): { lane: string; series: string } => {
    const own = (hidden.includes(slot) ? null : versions[slot]?.color) ?? tracks[slot]?.accent ?? (hidden.includes(slot) ? REFERENCE_COLOR : null);
    return own
      ? { lane: own, series: `color-mix(in srgb, ${own} 78%, #101216)` }
      : { lane: `var(--hue-${slot + 1})`, series: `var(--series-hue-${slot + 1})` };
  };
  const laneColors = Object.fromEntries(
    [...order, ...hidden].flatMap((slot) => {
      const n = labelOf(slot).toLowerCase();
      const { lane, series } = colorOf(slot);
      return [
        [`--lane-${n}`, lane],
        [`--series-lane-${n}`, series],
      ];
    }),
  ) as CSSProperties;

  const pair: ComparedPair = {
    slots: pairSlots,
    labels: [labelOf(subject), labelOf(reference)],
    colors: [colorOf(subject).lane, reference === NO_REFERENCE ? "" : colorOf(reference).lane],
  };
  const loadedCount = order.filter((s) => tracks[s]).length;
  /** Sessions from before default references kept the reference in track 2: offered as the default
   *  while there's none and no song has references of its own. */
  const migrateLane =
    !defaultRef && order.length >= 2 && tracks[order[1]] && !order.some((s) => versions[s]?.references?.length || compareWith[s] !== null)
      ? order[1]
      : null;
  /** The pair is marked on the lanes (the song's tint, its reference's chip) once it has a reference. */
  const roleOf = (slot: Slot) =>
    reference === NO_REFERENCE || !tracks[slot] ? null : slot === reference ? ("reference" as const) : slot === subject ? ("track" as const) : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K opens and closes the library.
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLibraryOpen((v) => !v);
        setVersionsOpen(null);
        return;
      }
      // ⌘N a new session, ⌘O open one, ⌘S save it, ⇧⌘S save it as.
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        sessionKeys.current.fresh();
        return;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        sessionKeys.current.open();
        return;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        sessionKeys.current.save(e.shiftKey);
        return;
      }
      // ⌘← back to the start of the song, like Home.
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        toStart();
        return;
      }
      // ⌘↑ / ⌘↓ listen to the loaded track above / below, in lane order (brought into view).
      if (e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const { order: lanes, tracks: current, transport: tr } = latest.current;
        const loaded = lanes.filter((s) => current[s]);
        const song = latest.current.companions.indexOf(tr.active);
        const next = loaded[loaded.indexOf(song >= 0 ? song : tr.active) + (e.key === "ArrowUp" ? -1 : 1)];
        if (next !== undefined) {
          selectSlot(next);
          document.querySelector(`.lane[data-slot="${next}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const handled = () => e.preventDefault();
      if (e.key === "?") {
        handled();
        setShortcutsOpen(true);
        return;
      }
      // Number-row keys by position, whatever the layout: 1–8 on QWERTY, & é " ' ( § è ! on AZERTY.
      const digit = /^Digit([0-8])$/.exec(e.code);
      if (digit) {
        const n = Number(digit[1]);
        if (n === 0) setViews(perSlot(null));
        else {
          const slot = latest.current.order[n - 1];
          if (slot !== undefined) selectSlot(slot);
        }
        return;
      }
      switch (e.key) {
        case " ":
          handled();
          togglePlay();
          break;
        case "Tab": {
          // Switch between the compared song and its reference (which keeps the song current).
          handled();
          const { transport: tr, pair: [track, ref], tracks: current } = latest.current;
          const to = tr.active === ref ? track : ref;
          if (!current[to]) break;
          tabbedTo.current = to;
          selectSlot(to);
          break;
        }
        case "ArrowLeft":
          handled();
          skip(e.shiftKey ? -1 : -5);
          break;
        case "ArrowRight":
          handled();
          skip(e.shiftKey ? 1 : 5);
          break;
        case "Home":
          handled();
          toStart();
          break;
        case "=":
        case "+":
          zoomActive(1 / ZOOM_STEP);
          break;
        case "-":
        case "_":
          zoomActive(ZOOM_STEP);
          break;
        case "l":
        case "L":
          toggleLoop(latest.current.transport.active);
          break;
        case "k":
        case "K":
          setLinked((v) => !v);
          break;
        case "m":
        case "M":
          setMatchEnabled((v) => !v);
          break;
        case "n":
        case "N":
          handled();
          addMarker(latest.current.transport.active);
          break;
        case "p":
        case "P":
          setPlayerMode((v) => !v);
          break;
        case "e":
        case "E":
          setEqAudition((v) => !v);
          break;
        case "s":
        case "S":
          setDisplay((d) => (d === "spectrogram" ? lastBars.current : "spectrogram"));
          break;
        case "c":
        case "C":
          setCurveMode((m) => CURVE_CYCLE[(CURVE_CYCLE.indexOf(m) + 1) % CURVE_CYCLE.length]);
          break;
        case "a":
        case "A":
          setPanelOpen((v) => !v);
          break;
        case "Escape":
          if (latest.current.versionsOpen !== null) setVersionsOpen(null);
          else if (latest.current.libraryOpen) setLibraryOpen(false);
          else clearRegions();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, selectSlot, skip, toStart, toggleLoop, zoomActive, clearRegions, addMarker]);

  /** A lane; or (with `songOf`) a song's own reference nested at the bottom of its lane; or
   *  (`isDefault`) the session's default reference, in the strip above the lanes. */
  const renderLane = (slot: Slot, attached: ReactNode, songOf: Slot | null = null, isDefault = false) => {
    const song = songOf === null ? null : versions[songOf];
    const refs = song?.references ?? [];
    const lane = songOf ?? slot;
    /** Not a lane of its own: no reordering, opening or closing. */
    const fixed = song !== null || isDefault;
    return (
    <TrackLane
      key={slot}
      variant={isDefault ? "default" : songOf === null ? undefined : "reference"}
      songLabel={songOf === null ? undefined : labelOf(songOf)}
      slot={slot}
      label={labelOf(slot)}
      color={colorOf(slot).lane}
      index={order.indexOf(lane)}
      closing={fixed ? false : entering.includes(slot) || leaving.includes(slot)}
      reorder={fixed ? null : reorderMark(slot)}
      onReorderStart={(e) => dragLane(slot, e)}
      resizing={fixed ? false : opening.includes(slot) || leaving.includes(slot)}
      busy={loading[slot] || measuringFull[slot]}
      track={tracks[slot]}
      loading={loading[slot]}
      error={errors[slot]}
      position={transport.positions[slot]}
      region={regions[slot]}
      view={views[slot]}
      overlay={overlays[slot]}
      loudness={gainedFull[slot]?.loudness.curves?.momentary ?? null}
      display={display}
      eqOn={slot === subject && eqOn}
      role={roleOf(slot)}
      outsidePair={(fixed || loadedCount > 2) && slot !== subject && slot !== reference}
      onPinReference={isDefault ? () => compareSubjectWith({ kind: "default" }) : songOf !== null ? () => backToOwnReference(songOf) : undefined}
      trimDb={trims[slot]}
      normalized={normalized[slot] && !versionsMatched[slot]}
      headroomDb={reports[slot] ? headroom[slot] : null}
      versionsMatched={versionsMatched[slot]}
      onToggleNormalize={() => setNormalized((n) => setAt(n, slot, !n[slot]))}
      active={transport.active === slot && !!tracks[slot]}
      dropTarget={dropSlot === slot}
      songName={!tracks[slot] ? null : fixed ? defaultName(tracks[slot], tracks[slot]!.path) : songName(slot)}
      song={songSeq.current[slot]}
      version={
        song
          ? refs.length > 1
            ? { index: song.referenceFront ?? 0, count: refs.length }
            : null
          : versions[slot] && versions[slot]!.versions.length > 1
            ? { index: versions[slot]!.front, count: versions[slot]!.versions.length }
            : null
      }
      versionsOpen={versionsOpen === lane && !fixed}
      onOpenVersions={() => {
        if (isDefault) return defaultReferenceDialog();
        setVersionsOpen((o) => (o === lane ? null : lane));
        setLibraryOpen(false);
      }}
      onActivate={() => selectSlot(slot)}
      onOpen={() => (isDefault ? defaultReferenceDialog() : songOf !== null ? addReferenceDialog(songOf) : openDialog(slot))}
      onOpenLibrary={() => openLibraryFor(isDefault ? { kind: "default" } : songOf !== null ? { kind: "ref", owner: songOf } : { kind: "lane", slot })}
      onClear={() => (isDefault ? removeDefault() : songOf !== null ? removeReference(songOf, song?.referenceFront ?? 0) : clearTrack(slot))}
      onSeek={(t) => seek(slot, t)}
      markers={tracks[slot] ? markers[slot] : []}
      editingMarker={editingMarker?.slot === slot ? editingMarker.time : null}
      onMarkers={(list) => changeMarkers(slot, list)}
      onEditMarker={(time) => setEditingMarker(time === null ? null : { slot, time })}
      onAddMarker={() => addMarker(slot)}
      onRegion={(r) => setRegion(slot, r)}
      looping={transport.loopEnabled[slot] ?? false}
      onToggleLoop={() => toggleLoop(slot)}
      onView={(v) => setView(slot, v)}
    >
      {attached}
    </TrackLane>
    );
  };

  return (
    <div
      className={`app${transport.playing ? " playing" : ""}`}
      // The heard track's colour washes faintly over the background (and crossfades on a switch).
      style={{ ...laneColors, "--ambient": tracks[transport.active] ? `var(--lane-${labelOf(transport.active)})` : "transparent" } as CSSProperties}
    >
      <header className="app-header">
        <div className="header-session">
          <AppMenu
            name={session?.name ?? null}
            modified={!!session && (JSON.stringify(session.lanes.map(songKey)) !== JSON.stringify(laneSongs().map(songKey)) || session.defaultReference !== defaultRef)}
            canSave={order.some((s) => versions[s]?.versions.length)}
            saves={sessionSaves}
            onOpen={openSessionDialog}
            onNew={newSession}
            onOpenPath={openSessionPath}
            onSave={() => saveSession()}
            onSaveAs={() => saveSession(true)}
            onExportNotes={exportNotes}
            notesStatus={notesStatus}
            onExportZip={() => setZipOpen(true)}
            onShortcuts={() => setShortcutsOpen(true)}
          />
          <ZipExport open={zipOpen} onClose={() => setZipOpen(false)} tracks={zipTracks} onExport={exportZip} />
          {relinked.length > 0 && (
            <button
              className="session-relinked"
              onClick={() => setRelinked([])}
              title={`Found again (renamed or moved since the session was saved), and saved where they are now:\n${relinked
                .map((r) => `${r.from.split("/").pop()} → ${r.to}`)
                .join("\n")}\nClick to dismiss`}
            >
              ✓ Relinked {relinked.length} file{relinked.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
        {/* Everything that acts on the compared pair: who, how it's heard, what's written out. */}
        <div className="compare-bar" style={pairColors(pair.labels)}>
          <ComparedWith
            pair={pair}
            songName={tracks[subject] ? songName(subject) : null}
            own={(versions[subject]?.references ?? []).map((path, index) => {
              const c = companions[subject];
              const inUse = index === (versions[subject]?.referenceFront ?? 0) && c !== null && tracks[c];
              return { index, label: `R${labelOf(subject)}`, title: inUse ? defaultName(tracks[c!], path) : defaultName(null, path) };
            })}
            defaultReference={defaultSlot !== null && tracks[defaultSlot] ? { label: "R", title: defaultName(tracks[defaultSlot], tracks[defaultSlot]!.path) } : null}
            lanes={order.filter((s) => s !== subject && tracks[s]).map((s) => ({ slot: s, label: labelOf(s), title: songName(s) }))}
            current={
              reference === NO_REFERENCE
                ? null
                : reference === defaultSlot
                  ? { kind: "default" }
                  : ownerOf(reference) !== null
                    ? { kind: "own", index: versions[subject]?.referenceFront ?? 0 }
                    : { kind: "lane", slot: reference }
            }
            onChoose={compareSubjectWith}
            onAddReference={() => addReferenceDialog(subject)}
            onUseForAll={tracks[reference] && reference !== defaultSlot ? useForAllSongs : null}
          />
          <span className="bar-divider" aria-hidden="true" />
          <MatchControls
            matchEnabled={matchEnabled}
            matchBasis={effectiveScope === "selection" ? "the selections" : "the full tracks"}
            onToggleMatch={() => setMatchEnabled((v) => !v)}
            eqOn={eqOn}
            eqAvailable={eqAvailable}
            onToggleEq={() => setEqAudition((v) => !v)}
            eqBusy={eqAudition && ((fullWanted && !fullOn) || (!eq && !!shown[0] && !!shown[1]))}
            trackLabel={pair.labels[0]}
          />
        </div>
        <div className="header-status">
          <VolumeControl volumeDb={volumeDb} onVolume={setVolumeDb} />
          <button
            className={`toggle header-toggle library-toggle${libraryOpen ? " on" : ""}`}
            onClick={() => {
              setLibraryOpen((v) => !v);
              setVersionsOpen(null);
            }}
            aria-expanded={libraryOpen}
            title="Library: search your music and Deezer, find similar tracks (⌘K)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 19V5M8.5 19V5M13 19 11.5 5.5M16 19.5l3.5-13.5" />
              <path d="M3 20h18" />
            </svg>
            Library
          </button>
          <button
            className={`toggle header-toggle analysis-toggle${panelOpen ? " on" : ""}`}
            onClick={() => setPanelOpen((v) => !v)}
            aria-expanded={panelOpen}
            title={`${panelOpen ? "Hide" : "Show"} the analysis: loudness, dynamics, tonal balance, stereo, EQ match (A)`}
          >
            {/* A waveform under a magnifying glass. */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m15.5 15.5 5 5" />
              <path d="M6.5 10.5h1.5l1.2-2.7 2 5.4 1.2-2.7h1.6" />
            </svg>
            Analysis
          </button>
          {audioStatus?.error && <span className="audio-status error">Audio output unavailable: {audioStatus.error}</span>}
        </div>
      </header>

      <div className={`workspace${panelDocked ? "" : " panel-closed"}${panelOpen ? "" : " panel-hidden"}`}>
        <main
          ref={lanesRef}
          className="lanes"
          style={{
            gridTemplateRows: [
              // The default reference strip first: slim while empty.
              defaultSlot !== null ? "minmax(110px, 0.55fr)" : "auto",
              ...order
                // A lane with its song's reference under it gets more room.
                .map((s) =>
                  entering.includes(s) || leaving.includes(s)
                    ? "minmax(0px, 0fr)"
                    : companions[s] !== null
                      ? `minmax(calc(${MIN_LANE} * 1.7), 1.7fr)`
                      : `minmax(${MIN_LANE}, 1fr)`,
                ),
            ].join(" "),
          }}
        >
          <div className={`default-ref${dropSlot === DEFAULT_TARGET ? " drop-target" : ""}`} data-default-ref>
            {defaultSlot !== null ? (
              renderLane(defaultSlot, null, null, true)
            ) : (
              <div className="default-ref-empty">
                <span className="default-ref-badge">R</span>
                <span className="default-ref-text">
                  <strong>Default reference</strong> · every song without its own is compared with it. Drop a file here, or
                </span>
                <SourceMenu label="Add" title="Add the default reference: from a file or the Library" onFile={defaultReferenceDialog} onLibrary={() => openLibraryFor({ kind: "default" })} />
                {migrateLane !== null && (
                  <button
                    className="default-ref-move"
                    onClick={() => moveToDefault(migrateLane)}
                    title={`Track ${labelOf(migrateLane)} becomes the default reference and leaves the lanes`}
                  >
                    Use track {labelOf(migrateLane)} as the default reference
                  </button>
                )}
              </div>
            )}
          </div>
          {order.map((slot) => {
            const ref = companions[slot];
            return renderLane(slot, ref === null ? null : renderLane(ref, null, slot));
          })}
        </main>

        {versionsOpen !== null && versions[versionsOpen] && (
          <VersionsDrawer
            key={versionsOpen}
            slot={versionsOpen}
            label={labelOf(versionsOpen)}
            versions={versions[versionsOpen]!}
            track={tracks[versionsOpen]}
            loading={loading[versionsOpen]}
            dropTarget={versionsDrop}
            prepared={prepared}
            loudness={versionLevels[versionsOpen]}
            referenceLoudness={referenceLevels[versionsOpen]}
            matchSetAside={matchEnabled ? "Loudness Match levels every lane" : null}
            onToggleMatch={() => toggleVersionMatch(versionsOpen)}
            onFront={(i) => showVersion(versionsOpen, i)}
            onAdd={() => addVersionDialog(versionsOpen)}
            onRemove={(i) => removeVersion(versionsOpen, i)}
            onRename={(name) => renameSong(versionsOpen, name)}
            color={colorOf(versionsOpen).lane}
            autoColor={tracks[versionsOpen]?.accent ?? `var(--hue-${versionsOpen + 1})`}
            onColor={(color) => recolorSong(versionsOpen, color)}
            reference={companions[versionsOpen] !== null ? tracks[companions[versionsOpen]!] : null}
            referenceLoading={companions[versionsOpen] !== null && loading[companions[versionsOpen]!]}
            referenceDrop={referencesDrop}
            referenceSetAside={compareWith[versionsOpen] !== null}
            onReference={(i) => showReference(versionsOpen, i)}
            onAddReference={() => addReferenceDialog(versionsOpen)}
            onLibraryReference={() => openLibraryFor({ kind: "ref", owner: versionsOpen })}
            onRemoveReference={(i) => removeReference(versionsOpen, i)}
            onClose={() => setVersionsOpen(null)}
          />
        )}

        {libraryOpen && versionsOpen === null && (
          <LibraryDrawer
            pair={pair}
            reports={pairOf(gainedAll) as Pair<AnalysisReport | null>}
            paths={pairOf(tracks).map((t) => t?.path ?? null) as Pair<string | null>}
            status={library}
            loadTargets={loadTargets}
            onRescan={() => api.rescanLibrary()}
            onClose={() => setLibraryOpen(false)}
            dragging={!!dragging}
          />
        )}

        <div className="panel-slot" inert={!panelOpen}>
        <AnalysisPanel
          onClose={() => setPanelOpen(false)}
          tab={tab}
          onTab={setTab}
          pair={pair}
          reports={pairOf(gainedAll) as Pair<AnalysisReport | null>}
          pending={pairSlots.map((s) => (useSelection(s) ? measuringSel[s] : measuringFull[s])) as Pair<boolean>}
          loaded={[!!tracks[subject], !!tracks[reference]]}
          scope={effectiveScope}
          hasSelection={hasSelection}
          regions={pairOf(regions)}
          eq={eq}
          eqMoves={eqMoves}
          eqLoudest={eqLoudest}
          onEqLoudest={setEqLoudest}
          auditionKind={auditionKind}
          onAuditionKind={setAuditionKind}
          fullRendering={fullWanted && !fullOn}
          paths={pairOf(tracks).map((t) => t?.path ?? null) as Pair<string | null>}
          eqActive={eqActive}
          eqAudition={eqOn}
          eqCompensation={eqCompensation}
          eqPassages={eqPassages}
          onEqActive={(i, on) => setEqActive((v) => v.map((x, k) => (k === i ? on : x)))}
          onEqAudition={setEqAudition}
          onListen={listenTo}
          onScope={setScope}
          live={live && tracks[live.slot] ? { label: labelOf(live.slot), values: live.values } : null}
        />
        </div>
      </div>

      <TransportBar
        playing={transport.playing}
        active={transport.active}
        levels={transport.levels}
        linked={linked}
        lanes={order.map((slot) => ({ slot, label: labelOf(slot), loaded: !!tracks[slot], leaving: leaving.includes(slot), role: roleOf(slot) }))}
        totalDuration={loadedCount > 1 ? order.reduce((sum, s) => sum + (tracks[s]?.duration ?? 0), 0) : null}
        loadedCount={loadedCount}
        canAdd={extras.length < EXTRA_SLOTS.length}
        onAdd={addExtra}
        onRemove={removeExtra}
        onRemoveLast={() => extras.length && removeExtra(extras[extras.length - 1])}
        onTogglePlay={togglePlay}
        onToStart={toStart}
        onSelect={selectSlot}
        onToggleLinked={() => setLinked((v) => !v)}
        playerMode={playerMode}
        onPlayerMode={setPlayerMode}
        curveMode={curveMode}
        onCurveMode={setCurveMode}
        display={display}
        onDisplay={setDisplay}
      />

      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}

      {dragging && (
        <div className="drag-ghost" style={{ left: dragging.x + 14, top: dragging.y + 10 }} aria-hidden="true">
          {dragging.cover ? <img src={dragging.cover} alt="" /> : <span className="drag-ghost-cover">♪</span>}
          <span className="drag-ghost-text">
            <span className="drag-ghost-title">{dragging.title}</span>
            <span className="drag-ghost-hint">{dropSlot === DEFAULT_TARGET
                ? "Use as the default reference"
                : dropSlot !== null && ownerOf(dropSlot) !== null
                  ? `Add as a reference of ${labelOf(ownerOf(dropSlot)!)}`
                  : dropSlot !== null
                    ? `Load into ${labelOf(dropSlot)}`
                    : "Drop on a track"}</span>
          </span>
        </div>
      )}
    </div>
  );
}
