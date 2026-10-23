import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ALL_SLOTS, api, AUDIO_EXTENSIONS, EXTRA_SLOTS, isAudioFile, isSessionFile, SESSION_EXTENSION, SLOT_LABELS } from "./lib/api";
import type {
  AnalysisReport,
  AudioStatus,
  BandActivity,
  LaneVersions,
  EqFilter,
  ExportEq,
  LibraryStatus,
  MatchReport,
  Region,
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
import { ExportMenu } from "./components/ExportMenu";
import { MatchControls } from "./components/MatchControls";
import type { ExportOptions, ExportResult } from "./components/ExportMenu";
import { AnalysisPanel } from "./components/AnalysisPanel";
import type { AuditionKind, Scope, Tab } from "./components/AnalysisPanel";
import { overlayFor } from "./lib/overlay";
import type { CurveMode } from "./lib/overlay";
import { pairColors } from "./lib/pair";
import type { ComparedPair } from "./lib/pair";
import { PairPicker } from "./components/PairPicker";
import { withGain } from "./lib/gain";
import type { DragItem, LoadTargets } from "./components/LoadMenu";
import { LibraryDrawer } from "./components/LibraryDrawer";
import { platformById, platformGain } from "./lib/streaming";
import type { PlatformId } from "./lib/streaming";
import { SessionMenu } from "./components/SessionMenu";
import { defaultName, VersionsDrawer } from "./components/VersionsDrawer";
import { notesMarkdown } from "./lib/notes";
import "./App.css";

type Pair<T> = [T, T];
/** Per-slot state for every lane: A, B and the extra slots, indexed by engine slot. */
type PerSlot<T> = T[];
const perSlot = <T,>(v: T): PerSlot<T> => ALL_SLOTS.map(() => v);
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
const CURVE_CYCLE: CurveMode[] = ["off", "momentary", "shortTerm", "psr", "correlation"];

export default function App() {
  const [tracks, setTracks] = useState<PerSlot<TrackInfo | null>>(perSlot(null));
  const [loading, setLoading] = useState<PerSlot<boolean>>(perSlot(false));
  const [errors, setErrors] = useState<PerSlot<string | null>>(perSlot(null));
  const [regions, setRegions] = useState<PerSlot<Region | null>>(perSlot(null));
  const [views, setViews] = useState<PerSlot<View | null>>(perSlot(null));
  /** Lanes in display order, as engine slots: letters follow position, so removing C makes D the
   *  new C and dragging a lane to the top makes it A. Slots 0 and 1 always have a lane. */
  const [order, setOrder] = useState<Slot[]>([0, 1]);
  /** Lanes that can be closed (beyond the first two slots). */
  const extras = order.filter((s) => s > 1);
  /** Extra lanes opening (drawn collapsed for a frame so they can grow) or closing. */
  const [entering, setEntering] = useState<Slot[]>([]);
  /** Extra lanes that just opened, while their rows are still growing. */
  const [opening, setOpening] = useState<Slot[]>([]);
  const [leaving, setLeaving] = useState<Slot[]>([]);
  /** The compared pair: the track (always the one listened to, unless that's the reference) and the pinned reference. */
  const [subject, setSubject] = useState<Slot>(0);
  const [reference, setReference] = useState<Slot>(1);
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
  /** Hear every track as a streaming platform would play it (replaces loudness matching). */
  const [platform, setPlatform] = useState<PlatformId | null>(null);
  /** Tracks play one after another (lane order) instead of all together. */
  const [playerMode, setPlayerMode] = useState(false);
  const [tab, setTab] = useState<Tab>("loudness");
  const [eq, setEq] = useState<MatchReport | null>(null);
  /** Measure the EQ match over the loudest parts only (Matchering's gating). */
  const [eqLoudest, setEqLoudest] = useState(false);
  const [library, setLibrary] = useState<LibraryStatus | null>(null);
  /** The library drawer is open over the lanes. */
  const [libraryOpen, setLibraryOpen] = useState(false);
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
  const [eqActive, setEqActive] = useState<boolean[]>([]);
  const [activity, setActivity] = useState<Pair<BandActivity | null>>([null, null]);
  /** Timestamped notes per lane, saved per file. */
  const [markers, setMarkers] = useState<PerSlot<Marker[]>>(perSlot([]));
  /** The marker whose note is being written. */
  const [editingMarker, setEditingMarker] = useState<{ slot: Slot; time: number } | null>(null);
  /** The session the lanes were opened from or saved as, with its tracks as saved. */
  const [session, setSession] = useState<{ path: string; name: string; lanes: LaneVersions[] } | null>(null);
  /** Each lane's song: its versions and the one in front (the one loaded). */
  const [versions, setVersions] = useState<PerSlot<LaneVersions | null>>(perSlot(null));
  /** The lane whose versions drawer is open. */
  const [versionsOpen, setVersionsOpen] = useState<Slot | null>(null);
  /** Files are dragged over the versions drawer. */
  const [versionsDrop, setVersionsDrop] = useState(false);
  /** Versions prepared in the background (decoded and analysed), so switching to them is instant. */
  const [prepared, setPrepared] = useState<Set<string>>(new Set());
  /** Notes export feedback in the header ("Exported", or the error). */
  const [notesStatus, setNotesStatus] = useState<string | null>(null);
  /** Counts session saves, for the Session button's "Saved" feedback. */
  const [sessionSaves, setSessionSaves] = useState(0);
  /** Live analyser: the spectrum of what's playing now, while playing with the Tonal tab open. */
  const [live, setLive] = useState<{ slot: Slot; values: number[] } | null>(null);

  // Latest state for event handlers registered once (keyboard, drag & drop).
  const labelOf = (slot: Slot) => SLOT_LABELS[Math.max(0, order.indexOf(slot))];
  /** What a lane's song is called: the name given to it, else its front version's title. (Used
   *  while rendering, so declared before anything rendered with it.) */
  const songName = (slot: Slot) => {
    const song = versions[slot];
    return song?.name.trim() || defaultName(tracks[slot], song?.versions[song.front] ?? tracks[slot]?.path);
  };
  const latest = useRef({ tracks, regions, views, transport, linked, order, reports, markers, libraryOpen, leaving, loading, versions, versionsOpen, pair: [0, 1] as Pair<Slot> });
  latest.current = { tracks, regions, views, transport, linked, order, reports, markers, libraryOpen, leaving, loading, versions, versionsOpen, pair: [subject, reference] };
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
  // first, then the front ones (so switching back is instant too).
  const wantedVersions = order.flatMap((s) => {
    const song = versions[s];
    return song && song.versions.length > 1 ? song.versions.filter((_, i) => i !== song.front) : [];
  });
  const frontVersions = order.flatMap((s) => {
    const song = versions[s];
    return song && song.versions.length > 1 ? [song.versions[song.front]] : [];
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
   *  lanes after it (then before it), then new lanes, up to 26 tracks; `play` starts the first. */
  const loadPaths = useCallback(
    (paths: string[], target: Slot | null, play = false) => {
      const audio = paths.filter(isAudioFile);
      if (audio.length === 0) {
        if (paths.length) {
          setErrors((e) => setAt(e, target ?? 0, "Only mp3, flac, wav, aiff and m4a/aac files are supported"));
        }
        return;
      }
      const { order: lanes, tracks: current, loading: busy, leaving: closing } = latest.current;
      const usable = lanes.filter((s) => !closing.includes(s));
      const empty = usable.filter((s) => !current[s] && !busy[s] && s !== target);
      const from = target === null ? 0 : usable.indexOf(target) + 1;
      const slots = [...(target === null ? [] : [target]), ...empty.filter((s) => usable.indexOf(s) >= from), ...empty.filter((s) => usable.indexOf(s) < from)];
      if (slots.length < audio.length) slots.push(...addExtrasRef.current(audio.length - slots.length));
      if (slots.length === 0) slots.push(0);
      audio.slice(0, slots.length).forEach((path, i) => loadFile(slots[i], path, play && i === 0));
      const left = audio.length - slots.length;
      if (left > 0) setErrors((e) => setAt(e, slots[slots.length - 1], `${left} more file${left === 1 ? "" : "s"} not loaded: all 26 tracks are in use`));
    },
    [loadFile],
  );

  // Native drag & drop (gives real file paths, unlike HTML5 drop events).
  useEffect(() => {
    const slotAt = (pos: { x: number; y: number }): Slot | null => {
      const dpr = window.devicePixelRatio || 1;
      const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr);
      const slot = el?.closest<HTMLElement>("[data-slot]")?.dataset.slot;
      return slot === undefined ? null : (Number(slot) as Slot);
    };
    /** Over the versions drawer: dropped files become versions of its lane. */
    const onDrawer = (pos: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1;
      return !!document.elementFromPoint(pos.x / dpr, pos.y / dpr)?.closest("[data-versions-drop]");
    };
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") {
        const drawer = onDrawer(payload.position);
        setVersionsDrop(drawer);
        setDropSlot(drawer ? null : slotAt(payload.position));
      } else if (payload.type === "drop") {
        setDropSlot(null);
        setVersionsDrop(false);
        const open = latest.current.versionsOpen;
        if (open !== null && onDrawer(payload.position)) addVersionsRef.current(open, payload.paths);
        else loadPaths(payload.paths, slotAt(payload.position));
      } else {
        setDropSlot(null);
        setVersionsDrop(false);
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
  // A streaming preview plays each file as uploaded, so normalizing is set aside meanwhile.
  const streaming = platformById(platform);
  const normGain = ALL_SLOTS.map((s) => (normalized[s] && !streaming ? headroom[s] : 0));
  /** Gain the previewed platform applies to each track (whole file, as measured). */
  const platformGains = ALL_SLOTS.map((s) => {
    const l = tracks[s] ? reports[s]?.loudness.stats : null;
    return streaming && l ? platformGain(streaming, l.integrated, l.truePeak) : null;
  });

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
    // Streaming preview: each track at exactly the platform's gain. EQ compensation is added on
    // top but may not take a track's true peak past 0 dBTP (Spotify Loud has its limiter).
    if (streaming) {
      return ALL_SLOTS.map((s) => {
        const gain = platformGains[s] ?? 0;
        const trim = gain + (s === subject ? eqCompensation : 0);
        const peak = reports[s]?.loudness.stats.truePeak;
        if (streaming.boost === "limiter" || peak == null) return trim;
        return Math.min(trim, Math.max(gain, -peak));
      }) as PerSlot<number>;
    }
    const raw: PerSlot<number> = ALL_SLOTS.map((s) => normGain[s] + (s === subject ? eqCompensation : 0));
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
  }, [matchEnabled, levels.join(), normGain.join(), eqCompensation, subject, streaming, platformGains.join()]);

  // Loudness matching and a streaming preview each set the levels: switching one on ends the other.
  useEffect(() => {
    if (platform) setMatchEnabled(false);
  }, [platform]);
  useEffect(() => {
    if (matchEnabled) setPlatform(null);
  }, [matchEnabled]);
  useEffect(() => {
    api.setLimiters(ALL_SLOTS.map((s) => streaming?.boost === "limiter" && !!tracks[s]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, tracks.map((t) => !!t).join()]);

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

  /** Write the track with what's chosen, over the same ranges as the match; what was written, or null if cancelled. */
  const exportTrack = async ({ eq: withEq, loudness, float }: ExportOptions): Promise<ExportResult | null> => {
    const a = tracks[subject];
    if (!a) return null;
    const stem = a.path.replace(/\.[^./]+$/, "");
    const tags = [withEq && "EQ", loudness && "loudness"].filter(Boolean).join(" + ");
    let path = await save({ defaultPath: `${stem} (${tags} matched).wav`, filters: [{ name: "WAV", extensions: ["wav"] }] });
    if (!path) return null;
    if (!/\.wav$/i.test(path)) path += ".wav";
    const exportEq: ExportEq | null = !withEq || !eq
      ? null
      : auditionKind === "moves"
        ? { kind: "moves", filters: chosenEq }
        : { kind: "full", mid: eq.full.mid, side: eq.full.side };
    const r = await api.exportTrack(path, pairSlots, exportEq, loudness, pairRanges(), float);
    const sign = (v: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}`;
    const peak = r.peakDb > 0 ? `peak ${sign(r.peakDb)} dBFS${float ? "" : ", clipped"}` : `peak ${sign(r.peakDb)} dBFS`;
    return { path, details: `Gain ${sign(r.gainDb)} dB · ${r.loudness.toFixed(1)} LUFS · ${peak}` };
  };

  // Live analyser: poll the spectrum at the playhead of the track being heard, ~15 times a second.
  const analysing = transport.playing && tab === "tonal";
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
   *  the 26 run out). Works from the latest order, so several calls in one event don't collide. */
  const addExtras = (n: number): Slot[] => {
    const taken = new Set([...latest.current.order, ...latest.current.leaving]);
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
   *  where it would land; letters (and colours) follow the new positions. Esc cancels. */
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
   *  lane, else a new one (while under 26). */
  const emptyLane = order.find((s) => !tracks[s] && !loading[s] && !leaving.includes(s));
  /** Drag a library row onto a lane (pointer events: Tauri's native file drop swallows HTML5
   *  drag and drop). A press becomes a drag after a few pixels; buttons in the row keep their clicks. */
  const dragFromLibrary = (item: DragItem, down: ReactPointerEvent) => {
    if (down.button !== 0 || (down.target as HTMLElement).closest("button, a, input")) return;
    down.preventDefault(); // no text selection while dragging
    const start = { x: down.clientX, y: down.clientY };
    let active = false;
    const laneAt = (x: number, y: number): Slot | null => {
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
      if (slot !== null) loadFile(slot, item.path);
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

  const loadTargets: LoadTargets = {
    lanes: order
      .filter((s) => !leaving.includes(s))
      .map((s) => {
        const t = tracks[s];
        return { slot: s, label: labelOf(s), path: t?.path ?? null, name: t ? songName(s) : null };
      }),
    into: (slot, path) => loadFile(slot, path),
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

  /** Every lane's song (versions, the one in front, its name), in lane order: what a session saves. */
  const laneSongs = (): LaneVersions[] => {
    const { order: lanes, versions: songs } = latest.current;
    return lanes.flatMap((s) => (songs[s]?.versions.length ? [songs[s]!] : []));
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

  const renameSong = (slot: Slot, name: string) => setVersions((v) => (v[slot] ? setAt(v, slot, { ...v[slot]!, name }) : v));
  const folderOf = (path: string) => path.replace(/\/[^/]*$/, "");

  /** Replace every lane with these songs, in order (A, B, then new lanes), stopped at the start. */
  const replaceTracks = async (songs: LaneVersions[]) => {
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
    setReference(1);
    await api.setActive(0);
    const placed = perSlot<LaneVersions | null>(null);
    songs.slice(0, lanes.length).forEach((song, i) => (placed[lanes[i]] = { ...song, front: Math.min(Math.max(0, song.front), song.versions.length - 1) }));
    latest.current.versions = placed;
    setVersions(placed);
    for (const s of lanes) if (placed[s]) loadFile(s, placed[s]!.versions[placed[s]!.front], false, { keepVersions: true });
  };

  const openSessionPath = async (path: string) => {
    try {
      const opened = await api.openSession(path);
      setSession(opened);
      await replaceTracks(opened.lanes);
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
      setSession(await api.saveSession(path, songs));
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

  // The compared track follows the one being listened to (never the reference itself).
  useEffect(() => {
    const active = transport.active;
    if (active !== reference && tracks[active]) setSubject(active);
  }, [transport.active, reference, tracks]);

  // A closed lane leaves the pair: fall back to A and B.
  useEffect(() => {
    if (!order.includes(reference)) setReference(subject === 1 ? 0 : 1);
    if (!order.includes(subject)) setSubject(reference === 0 ? 1 : 0);
  }, [order, subject, reference]);

  /** Compare `slot`: the compared track is the one listened to, so this switches to it. */
  const setPairTrack = (slot: Slot) => {
    setSubject(slot);
    selectSlot(slot);
  };

  /** Pin `slot` as the reference; if it was the compared track, the old reference takes its place. */
  const setPairReference = (slot: Slot) => {
    if (slot === reference) return;
    if (slot === subject) setSubject(reference);
    setReference(slot);
  };

  // A track with a colourful cover takes its colour: its letter's lane colour (and the darker chart
  // variant) is repointed, so the lane, its button, meter and its columns/curves all follow.
  const laneColors = Object.fromEntries(
    order.flatMap((slot) => {
      const accent = tracks[slot]?.accent;
      if (!accent) return [];
      const letter = labelOf(slot).toLowerCase();
      return [
        [`--lane-${letter}`, accent],
        [`--series-lane-${letter}`, `color-mix(in srgb, ${accent} 78%, #101216)`],
      ];
    }),
  ) as CSSProperties;

  const pair: ComparedPair = { slots: pairSlots, labels: [labelOf(subject), labelOf(reference)] };
  const loadedCount = order.filter((s) => tracks[s]).length;
  /** Lane roles are worth marking once the pair isn't simply A vs B. */
  const showRoles = loadedCount > 2 || subject !== 0 || reference !== 1;
  const roleOf = (slot: Slot) =>
    !showRoles || !tracks[slot] ? null : slot === reference ? ("reference" as const) : slot === subject ? ("track" as const) : null;

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
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const handled = () => e.preventDefault();
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
          // Switch between the compared pair: the analysed track and the reference.
          handled();
          const { transport: tr, pair: [track, ref] } = latest.current;
          selectSlot(tr.active === ref ? track : ref);
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

  return (
    <div className="app" style={laneColors}>
      <header className="app-header">
        <div className="header-session">
          <h1>(a/b)normal</h1>
          <SessionMenu
            name={session?.name ?? null}
            modified={!!session && JSON.stringify(session.lanes) !== JSON.stringify(order.flatMap((s) => (versions[s]?.versions.length ? [versions[s]] : [])))}
            canSave={order.some((s) => versions[s]?.versions.length)}
            saves={sessionSaves}
            onOpen={openSessionDialog}
            onNew={newSession}
            onOpenPath={openSessionPath}
            onSave={() => saveSession()}
            onSaveAs={() => saveSession(true)}
          />
          <button
            className="notes-export"
            disabled={loadedCount === 0}
            onClick={exportNotes}
            title="Export Notes: every track's markers, song by song, as a Markdown (.md) file"
          >
            {notesStatus ?? "Export Notes"}
          </button>
        </div>
        {/* Everything that acts on the compared pair: who, how it's heard, what's written out. */}
        <div className="compare-bar" style={pairColors(pair.labels)}>
          <PairPicker
            pair={pair}
            lanes={order.map((slot) => ({ slot, label: labelOf(slot), loaded: !!tracks[slot] }))}
            onPairTrack={setPairTrack}
            onPairReference={setPairReference}
          />
          <span className="bar-divider" aria-hidden="true" />
          <MatchControls
            platform={platform}
            onPlatform={setPlatform}
            platformGains={order.flatMap((s) => (tracks[s] ? [{ label: labelOf(s), gain: platformGains[s] }] : []))}
            matchEnabled={matchEnabled}
            matchBasis={effectiveScope === "selection" ? "the selections" : "the full tracks"}
            onToggleMatch={() => setMatchEnabled((v) => !v)}
            eqOn={eqOn}
            eqAvailable={eqAvailable}
            onToggleEq={() => setEqAudition((v) => !v)}
            eqBusy={eqAudition && ((fullWanted && !fullOn) || (!eq && !!shown[0] && !!shown[1]))}
            trackLabel={pair.labels[0]}
          >
            <ExportMenu
              labels={pair.labels}
              available={!!tracks[subject] && !!shown[0]}
              eqLabel={!eq ? null : auditionKind === "moves" ? (chosenEq.length ? "chosen moves" : null) : "full match"}
              canMatchLoudness={shown[1]?.loudness.stats.integrated != null}
              eqOn={eqOn}
              matchOn={matchEnabled}
              onExport={exportTrack}
            />
          </MatchControls>
        </div>
        <div className="header-status">
          <VolumeControl volumeDb={volumeDb} onVolume={setVolumeDb} />
          <button
            className={`toggle library-toggle${libraryOpen ? " on" : ""}`}
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
            <kbd>⌘K</kbd>
          </button>
          {audioStatus?.error && <span className="audio-status error">Audio output unavailable: {audioStatus.error}</span>}
        </div>
      </header>

      <div className="workspace">
        <main
          ref={lanesRef}
          className="lanes"
          style={{
            gridTemplateRows: order
              .map((s) => (entering.includes(s) || leaving.includes(s) ? "minmax(0px, 0fr)" : `minmax(${MIN_LANE}, 1fr)`))
              .join(" "),
          }}
        >
          {order.map((slot) => (
            <TrackLane
              key={slot}
              slot={slot}
              label={labelOf(slot)}
              index={order.indexOf(slot)}
              closing={entering.includes(slot) || leaving.includes(slot)}
              reorder={reorderMark(slot)}
              onReorderStart={(e) => dragLane(slot, e)}
              resizing={opening.includes(slot) || leaving.includes(slot)}
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
              outsidePair={loadedCount > 2 && slot !== subject && slot !== reference}
              onPinReference={() => setPairReference(slot)}
              trimDb={trims[slot]}
              normalized={normalized[slot] && !streaming}
              streaming={streaming?.name ?? null}
              headroomDb={reports[slot] ? headroom[slot] : null}
              onToggleNormalize={() => setNormalized((n) => setAt(n, slot, !n[slot]))}
              active={transport.active === slot && !!tracks[slot]}
              dropTarget={dropSlot === slot}
              songName={tracks[slot] ? songName(slot) : null}
              song={songSeq.current[slot]}
              version={versions[slot] && versions[slot]!.versions.length > 1 ? { index: versions[slot]!.front, count: versions[slot]!.versions.length } : null}
              versionsOpen={versionsOpen === slot}
              onOpenVersions={() => {
                setVersionsOpen((o) => (o === slot ? null : slot));
                setLibraryOpen(false);
              }}
              onActivate={() => selectSlot(slot)}
              onOpen={() => openDialog(slot)}
              onClear={() => clearTrack(slot)}
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
            />
          ))}
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
            onFront={(i) => showVersion(versionsOpen, i)}
            onAdd={() => addVersionDialog(versionsOpen)}
            onRemove={(i) => removeVersion(versionsOpen, i)}
            onRename={(name) => renameSong(versionsOpen, name)}
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

        <AnalysisPanel
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
        onSkip={skip}
        onSelect={selectSlot}
        onToggleLinked={() => setLinked((v) => !v)}
        playerMode={playerMode}
        onTogglePlayerMode={() => setPlayerMode((v) => !v)}
        curveMode={curveMode}
        onCurveMode={setCurveMode}
        display={display}
        onDisplay={setDisplay}
      />

      <p className="hints">
        Space play · Tab track ⇄ reference · number row (&é"'… / 1 2 3…) pick a track · ←/→ ±5 s · ⌘← start · drag to select (⟳ on it loops), double-click/Esc clears · ⌘+wheel or
        pinch to zoom, Shift+wheel or swipe sideways to pan · +/− zoom · 0 (à) fit · L loop selection · K link · M loudness match · E EQ · C curve · S
        spectrogram · P player mode · N marker · ⌘K library · ⌘N / ⌘O / ⌘S new / open / save session · click a song's title for its versions
      </p>

      {dragging && (
        <div className="drag-ghost" style={{ left: dragging.x + 14, top: dragging.y + 10 }} aria-hidden="true">
          {dragging.cover ? <img src={dragging.cover} alt="" /> : <span className="drag-ghost-cover">♪</span>}
          <span className="drag-ghost-text">
            <span className="drag-ghost-title">{dragging.title}</span>
            <span className="drag-ghost-hint">{dropSlot !== null ? `Load into ${labelOf(dropSlot)}` : "Drop on a track"}</span>
          </span>
        </div>
      )}
    </div>
  );
}
