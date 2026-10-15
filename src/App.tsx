import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ALL_SLOTS, api, AUDIO_EXTENSIONS, EXTRA_SLOTS, isAudioFile, SLOT_LABELS } from "./lib/api";
import type {
  AnalysisReport,
  AudioStatus,
  BandActivity,
  EqFilter,
  ExportEq,
  LibraryStatus,
  MatchReport,
  Region,
  Section,
  Slot,
  SongStructure,
  StructureOutcome,
  StructureSegment,
  StructureSetup,
  TrackInfo,
  Transport,
} from "./lib/api";
import { formatRate } from "./lib/format";
import type { View } from "./lib/view";
import { clampView, fullView, isFull, zoomView } from "./lib/view";
import { TrackLane } from "./components/TrackLane";
import type { Display } from "./components/Waveform";
import { isWidth, loudnessChange, midSideCurves, movesOf } from "./lib/eq";
import { passageFor } from "./lib/passages";
import { TransportBar, VOLUME_MIN_DB } from "./components/TransportBar";
import { ExportMenu } from "./components/ExportMenu";
import { MatchControls } from "./components/MatchControls";
import type { ExportOptions, ExportResult } from "./components/ExportMenu";
import { AnalysisPanel } from "./components/AnalysisPanel";
import type { AuditionKind, Scope, Tab } from "./components/AnalysisPanel";
import { overlayFor } from "./lib/overlay";
import type { CurveMode } from "./lib/overlay";
import { matchingPart } from "./lib/structure";
import type { Part } from "./lib/structure";
import { pairColors } from "./lib/pair";
import type { ComparedPair } from "./lib/pair";
import { PairPicker } from "./components/PairPicker";
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

/** Lanes shrink to share the height down to this, then the lane list scrolls. */
const MIN_LANE_PX = 150;
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
  /** Extra lanes in display order (C, D, …), as engine slots; removing C makes D the new C. */
  const [extras, setExtras] = useState<Slot[]>([]);
  /** An extra lane opening (drawn collapsed for a frame so it can grow) or closing. */
  const [entering, setEntering] = useState<Slot | null>(null);
  /** The extra lane that just opened, while its row is still growing. */
  const [opening, setOpening] = useState<Slot | null>(null);
  const [leaving, setLeaving] = useState<Slot[]>([]);
  /** The compared pair: the track (always the one listened to, unless that's the reference) and the pinned reference. */
  const [subject, setSubject] = useState<Slot>(0);
  const [reference, setReference] = useState<Slot>(1);
  const [transport, setTransport] = useState<Transport>(INITIAL_TRANSPORT);
  const [linked, setLinked] = useState(false);
  const [dropSlot, setDropSlot] = useState<Slot | null>(null);
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);

  const [reports, setReports] = useState<PerSlot<AnalysisReport | null>>(perSlot(null));
  const [selectionReports, setSelectionReports] = useState<PerSlot<AnalysisReport | null>>(perSlot(null));
  const [measuringFull, setMeasuringFull] = useState<PerSlot<boolean>>(perSlot(false));
  const [measuringSel, setMeasuringSel] = useState<PerSlot<boolean>>(perSlot(false));
  const [scope, setScope] = useState<Scope>("full");
  const [curveMode, setCurveMode] = useState<CurveMode>("shortTerm");
  const [matchEnabled, setMatchEnabled] = useState(false);
  const [tab, setTab] = useState<Tab>("loudness");
  const [eq, setEq] = useState<MatchReport | null>(null);
  /** Measure the EQ match over the loudest parts only (Matchering's gating). */
  const [eqLoudest, setEqLoudest] = useState(false);
  const [library, setLibrary] = useState<LibraryStatus | null>(null);
  const [display, setDisplay] = useState<Display>("wave");
  const [sections, setSections] = useState<PerSlot<Section[] | null>>(perSlot(null));
  /** Audition the suggested EQ on A's playback: the chosen moves, or the full match. */
  const [eqAudition, setEqAudition] = useState(false);
  const [auditionKind, setAuditionKind] = useState<AuditionKind>("moves");
  /** The match the compared track's full-match rendering was made for (rendering takes a moment). */
  const [fullRendered, setFullRendered] = useState<MatchReport | null>(null);
  const [volumeDb, setVolumeDb] = useState(loadVolume);
  const [eqActive, setEqActive] = useState<boolean[]>([]);
  const [activity, setActivity] = useState<Pair<BandActivity | null>>([null, null]);
  /** Song parts, tempo and bars from the structure model (null until analysed). */
  const [structures, setStructures] = useState<PerSlot<SongStructure | null>>(perSlot(null));
  const [structurePending, setStructurePending] = useState<PerSlot<boolean>>(perSlot(false));
  const [structureSetup, setStructureSetup] = useState<StructureSetup | null>(null);
  /** Live analyser: the spectrum of what's playing now, while playing with the Tonal tab open. */
  const [live, setLive] = useState<{ slot: Slot; values: number[] } | null>(null);

  // Latest state for event handlers registered once (keyboard, drag & drop).
  /** Lanes in display order: A, B, then the extra tracks. */
  const order = useMemo<Slot[]>(() => [0, 1, ...extras], [extras]);
  const labelOf = (slot: Slot) => SLOT_LABELS[Math.max(0, order.indexOf(slot))];
  const latest = useRef({ tracks, regions, views, transport, linked, structures, structureSetup, order, reports, pair: [0, 1] as Pair<Slot> });
  latest.current = { tracks, regions, views, transport, linked, structures, structureSetup, order, reports, pair: [subject, reference] };
  /** Incremented per load so results for a replaced track are discarded. */
  const loadSeq = useRef<PerSlot<number>>(perSlot(0));

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

  /** Ask for a loaded track's structure: cached ones come back at once, others are queued. */
  const requestStructure = useCallback(async (slot: Slot, path: string) => {
    const seq = loadSeq.current[slot];
    const found = await api.songStructure(path).catch(() => null);
    if (seq !== loadSeq.current[slot]) return;
    setStructures((s) => setAt(s, slot, found));
    setStructurePending((p) => setAt(p, slot, !found && !!latest.current.structureSetup?.installed));
  }, []);

  // Structure results arrive as events; the model may also get set up while tracks are loaded.
  useEffect(() => {
    const done = listen<StructureOutcome>("structure", ({ payload }) => {
      for (const slot of ALL_SLOTS) {
        if (latest.current.tracks[slot]?.path !== payload.path) continue;
        setStructures((s) => setAt(s, slot, payload.structure));
        setStructurePending((p) => setAt(p, slot, false));
        if (payload.error) console.warn(`structure: ${payload.error}`);
      }
    });
    const setup = listen<StructureSetup>("structure-setup", ({ payload }) => {
      const wasInstalled = latest.current.structureSetup?.installed;
      setStructureSetup(payload);
      if (payload.installed && !wasInstalled) {
        latest.current.structureSetup = payload;
        for (const slot of ALL_SLOTS) {
          const track = latest.current.tracks[slot];
          if (track) requestStructure(slot, track.path);
        }
      }
    });
    api.structureStatus().then(setStructureSetup);
    return () => {
      done.then((fn) => fn());
      setup.then((fn) => fn());
    };
  }, [requestStructure]);

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

  const resetSlot = (slot: Slot) => {
    setRegions((r) => setAt(r, slot, null));
    setViews((v) => setAt(v, slot, null));
    setReports((r) => setAt(r, slot, null));
    setSelectionReports((s) => setAt(s, slot, null));
    setSections((s) => setAt(s, slot, null));
    setStructures((s) => setAt(s, slot, null));
    setStructurePending((p) => setAt(p, slot, false));
  };

  const loadFile = useCallback(async (slot: Slot, path: string, play = false) => {
    if (!isAudioFile(path)) {
      setErrors((e) => setAt(e, slot, `Unsupported file type: ${path.split("/").pop()}`));
      return;
    }
    const seq = ++loadSeq.current[slot];
    setLoading((l) => setAt(l, slot, true));
    setErrors((e) => setAt(e, slot, null));
    try {
      const info = await api.loadTrack(slot, path);
      if (seq !== loadSeq.current[slot]) return;
      setTracks((t) => setAt(t, slot, info));
      resetSlot(slot);
      requestStructure(slot, info.path);
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

    try {
      const found = await api.sections(slot);
      if (seq === loadSeq.current[slot]) setSections((s) => setAt(s, slot, found));
    } catch {
      // Sections are optional: the strip just stays empty.
      if (seq === loadSeq.current[slot]) setSections((s) => setAt(s, slot, []));
    }
  }, []);

  const loadPaths = useCallback(
    (paths: string[], target: Slot | null, play = false) => {
      const audio = paths.filter(isAudioFile);
      if (audio.length === 0) {
        if (paths.length) {
          setErrors((e) => setAt(e, target ?? 0, "Only mp3, flac and wav files are supported"));
        }
        return;
      }
      if (audio.length >= 2) {
        loadFile(0, audio[0], play);
        loadFile(1, audio[1]);
        return;
      }
      const { tracks: current } = latest.current;
      const slot = target ?? (current[0] ? (current[1] ? 0 : 1) : 0);
      loadFile(slot, audio[0], play);
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
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") {
        setDropSlot(slotAt(payload.position));
      } else if (payload.type === "drop") {
        setDropSlot(null);
        loadPaths(payload.paths, slotAt(payload.position));
      } else {
        setDropSlot(null);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadPaths]);

  // Files opened from Finder (double-click / Open With), including the ones that launched us.
  useEffect(() => {
    const take = () =>
      api.takeOpenedFiles().then((paths) => paths.length && loadPaths(paths, null, true));
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

  // Loudness matching turns the louder track down to the quieter one; EQ compensation is added on
  // top. Never boost (if a trim would be positive, both come down instead), so playback can't
  // be pushed into clipping.
  const levels = ALL_SLOTS.map((s) => (tracks[s] ? (shownAll[s]?.loudness.stats.integrated ?? null) : null));
  const trims = useMemo<PerSlot<number>>(() => {
    const raw: PerSlot<number> = ALL_SLOTS.map((s) => (s === subject ? eqCompensation : 0));
    const known = levels.filter((v): v is number => v !== null);
    if (matchEnabled && known.length >= 2) {
      const target = Math.min(...known);
      levels.forEach((v, s) => {
        if (v !== null) raw[s] += target - v;
      });
    }
    const lift = Math.max(0, ...raw);
    return raw.map((t) => t - lift) as PerSlot<number>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchEnabled, levels.join(), eqCompensation, subject]);

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
    () => ALL_SLOTS.map((s) => overlayFor(curveMode, reports[s], shownAll[s])),
    [curveMode, reports, shownAll],
  );

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

  const openDialog = async (slot: Slot) => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });
    if (typeof path === "string") loadFile(slot, path);
  };

  const clearTrack = async (slot: Slot) => {
    loadSeq.current[slot]++;
    await api.unloadTrack(slot);
    setTracks((t) => setAt(t, slot, null));
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

  /** Add an empty lane for another track (C, then D), to drop or open a file into; its slot. */
  const addExtra = (): Slot | undefined => {
    const free = EXTRA_SLOTS.find((s) => !extras.includes(s) && !leaving.includes(s));
    if (free === undefined) return undefined;
    setExtras((x) => [...x, free]);
    setEntering(free);
    setOpening(free);
    // Drawn collapsed first, then grown, so the lane opens smoothly.
    requestAnimationFrame(() => requestAnimationFrame(() => setEntering(null)));
    setTimeout(() => setOpening((o) => (o === free ? null : o)), LANE_ANIMATION_MS + 50);
    return free;
  };

  /** Where "+ New" in the library loads: the first empty lane, else a new one (while under eight). */
  const emptyLane = order.find((s) => !tracks[s] && !loading[s] && !leaving.includes(s));
  const loadNew = {
    label: emptyLane !== undefined ? labelOf(emptyLane) : extras.length < EXTRA_SLOTS.length ? SLOT_LABELS[order.length] : null,
    load: (path: string) => {
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
      setErrors((e) => setAt(e, slot, null));
      setLoading((l) => setAt(l, slot, false));
      resetSlot(slot);
      setExtras((x) => x.filter((s) => s !== slot));
      setLeaving((l) => l.filter((s) => s !== slot));
    }, LANE_ANIMATION_MS);
  };

  const loadedSlots = () => ALL_SLOTS.filter((s) => latest.current.tracks[s]);

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

  /** The user corrected a track's parts: show it at once, then keep it. */
  const editParts = useCallback((slot: Slot, segments: StructureSegment[]) => {
    const track = latest.current.tracks[slot];
    const current = latest.current.structures[slot];
    if (!track || !current) return;
    setStructures((s) => setAt(s, slot, { ...current, segments, edited: true }));
    api.saveStructureEdit(track.path, segments).catch((e) => console.warn(`saving parts: ${e}`));
  }, []);

  const resetParts = useCallback(async (slot: Slot) => {
    const track = latest.current.tracks[slot];
    if (!track) return;
    const detected = await api.resetStructureEdit(track.path).catch(() => null);
    if (latest.current.tracks[slot]?.path === track.path && detected) setStructures((s) => setAt(s, slot, detected));
  }, []);

  /** A song part was clicked: select it, and the same part in the other tracks (2nd chorus ↔
   *  2nd chorus) so every tab compares like with like. Without a match there, linked mode
   *  falls back to the same times. */
  const selectPart = useCallback(
    (slot: Slot, part: Part) => {
      const { tracks: current, structures: found, linked: isLinked } = latest.current;
      const region = { start: part.start, end: part.end };
      const updates: [Slot, Region | null][] = [[slot, region]];
      for (const other of ALL_SLOTS) {
        if (other === slot || !current[other]) continue;
        const counterpart = found[other] ? matchingPart(part, found[other]!) : null;
        if (counterpart) updates.push([other, counterpart]);
        else if (isLinked) updates.push([other, region]);
      }
      applyRegions(updates);
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
        case "e":
        case "E":
          setEqAudition((v) => !v);
          break;
        case "s":
        case "S":
          setDisplay((d) => (d === "wave" ? "spectrogram" : "wave"));
          break;
        case "c":
        case "C":
          setCurveMode((m) => CURVE_CYCLE[(CURVE_CYCLE.indexOf(m) + 1) % CURVE_CYCLE.length]);
          break;
        case "Escape":
          clearRegions();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, selectSlot, skip, toStart, toggleLoop, zoomActive, clearRegions]);

  return (
    <div className="app" style={laneColors}>
      <header className="app-header">
        <h1>(a/b)normal</h1>
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
          <span className={`audio-status${audioStatus?.error ? " error" : ""}`}>
            {audioStatus?.error
              ? `Audio output unavailable: ${audioStatus.error}`
              : audioStatus?.deviceRate
                ? `Output ${formatRate(audioStatus.deviceRate)}`
                : ""}
          </span>
        </div>
      </header>

      <div className="workspace">
        <main
          className="lanes"
          style={{
            gridTemplateRows: order
              .map((s) => (s === entering || leaving.includes(s) ? "minmax(0px, 0fr)" : `minmax(${MIN_LANE_PX}px, 1fr)`))
              .join(" "),
          }}
        >
          {order.map((slot) => (
            <TrackLane
              key={slot}
              slot={slot}
              label={labelOf(slot)}
              index={order.indexOf(slot)}
              closing={slot === entering || leaving.includes(slot)}
              resizing={slot === opening || leaving.includes(slot)}
              busy={loading[slot] || measuringFull[slot]}
              track={tracks[slot]}
              loading={loading[slot]}
              error={errors[slot]}
              position={transport.positions[slot]}
              region={regions[slot]}
              view={views[slot]}
              overlay={overlays[slot]}
              display={display}
              sections={tracks[slot] ? sections[slot] : null}
              structure={tracks[slot] ? structures[slot] : null}
              structurePending={structurePending[slot]}
              onPart={(p) => selectPart(slot, p)}
              onPartsEdit={(segments) => editParts(slot, segments)}
              onPartsReset={() => resetParts(slot)}
              eqOn={slot === subject && eqOn}
              role={roleOf(slot)}
              outsidePair={loadedCount > 2 && slot !== subject && slot !== reference}
              onPinReference={() => setPairReference(slot)}
              trimDb={trims[slot]}
              active={transport.active === slot && !!tracks[slot]}
              dropTarget={dropSlot === slot}
              onActivate={() => selectSlot(slot)}
              onOpen={() => openDialog(slot)}
              onClear={() => clearTrack(slot)}
              onSeek={(t) => seek(slot, t)}
              onRegion={(r) => setRegion(slot, r)}
              looping={transport.loopEnabled[slot] ?? false}
              onToggleLoop={() => toggleLoop(slot)}
              onView={(v) => setView(slot, v)}
            />
          ))}
        </main>

        <AnalysisPanel
          tab={tab}
          onTab={setTab}
          pair={pair}
          reports={shown}
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
          library={library}
          eqActive={eqActive}
          eqAudition={eqOn}
          eqCompensation={eqCompensation}
          eqPassages={eqPassages}
          onEqActive={(i, on) => setEqActive((v) => v.map((x, k) => (k === i ? on : x)))}
          onEqAudition={setEqAudition}
          onListen={listenTo}
          onScope={setScope}
          onLoad={(side, path) => loadFile(pairSlots[side], path)}
          onRescan={() => api.rescanLibrary()}
          fullReports={pairOf(reports)}
          structures={pairOf(structures)}
          structurePending={pairOf(structurePending)}
          structureSetup={structureSetup}
          onStructureInstall={() => api.structureInstall()}
          loadNew={loadNew}
          live={live && tracks[live.slot] ? { label: labelOf(live.slot), values: live.values } : null}
        />
      </div>

      <TransportBar
        playing={transport.playing}
        active={transport.active}
        levels={transport.levels}
        linked={linked}
        lanes={order.map((slot) => ({ slot, label: labelOf(slot), loaded: !!tracks[slot], leaving: leaving.includes(slot), role: roleOf(slot) }))}
        canAdd={extras.length < EXTRA_SLOTS.length}
        onAdd={addExtra}
        onRemove={removeExtra}
        onRemoveLast={() => extras.length && removeExtra(extras[extras.length - 1])}
        onTogglePlay={togglePlay}
        onToStart={toStart}
        onSkip={skip}
        onSelect={selectSlot}
        onToggleLinked={() => setLinked((v) => !v)}
        curveMode={curveMode}
        onCurveMode={setCurveMode}
        display={display}
        onDisplay={setDisplay}
        volumeDb={volumeDb}
        onVolume={setVolumeDb}
      />

      <p className="hints">
        Space play · Tab track ⇄ reference · number row (&é"'… / 1 2 3…) pick a track · ←/→ ±5 s · drag to select (⟳ on it loops), double-click/Esc clears · wheel or
        pinch to zoom, Shift+wheel to pan · +/− zoom · 0 (à) fit · L loop selection · K link · M loudness match · E EQ · C curve · S
        spectrogram · click a section to select it, Shift+click to extend
      </p>
    </div>
  );
}
