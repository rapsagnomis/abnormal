import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, AUDIO_EXTENSIONS, isAudioFile, SLOTS } from "./lib/api";
import type {
  AnalysisReport,
  AudioStatus,
  BandActivity,
  EqFilter,
  EqReport,
  LibraryStatus,
  Region,
  Section,
  Slot,
  TrackInfo,
  Transport,
} from "./lib/api";
import { formatRate } from "./lib/format";
import type { View } from "./lib/view";
import { clampView, fullView, isFull, zoomView } from "./lib/view";
import { TrackLane } from "./components/TrackLane";
import type { Display } from "./components/Waveform";
import { loudnessChange } from "./lib/eq";
import { passageFor } from "./lib/passages";
import { TransportBar } from "./components/TransportBar";
import { AnalysisPanel } from "./components/AnalysisPanel";
import type { Scope, Tab } from "./components/AnalysisPanel";
import { overlayFor } from "./lib/overlay";
import type { CurveMode } from "./lib/overlay";
import { reportJson, reportMarkdown } from "./lib/report";
import "./App.css";

type Pair<T> = [T, T];
const pair = <T,>(v: T): Pair<T> => [v, v];
const setAt = <T,>(p: Pair<T>, slot: Slot, v: T): Pair<T> =>
  slot === 0 ? [v, p[1]] : [p[0], v];

const INITIAL_TRANSPORT: Transport = {
  playing: false,
  active: 0,
  loopEnabled: false,
  positions: [0, 0],
};

/** Wait this long after a selection changes before measuring it. */
const SELECTION_DEBOUNCE_MS = 150;
const ZOOM_STEP = 2;
const CURVE_CYCLE: CurveMode[] = ["off", "momentary", "shortTerm", "psr", "correlation"];

export default function App() {
  const [tracks, setTracks] = useState<Pair<TrackInfo | null>>(pair(null));
  const [loading, setLoading] = useState<Pair<boolean>>(pair(false));
  const [errors, setErrors] = useState<Pair<string | null>>(pair(null));
  const [regions, setRegions] = useState<Pair<Region | null>>(pair(null));
  const [views, setViews] = useState<Pair<View | null>>(pair(null));
  const [transport, setTransport] = useState<Transport>(INITIAL_TRANSPORT);
  const [linked, setLinked] = useState(false);
  const [dropSlot, setDropSlot] = useState<Slot | null>(null);
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);

  const [reports, setReports] = useState<Pair<AnalysisReport | null>>(pair(null));
  const [selectionReports, setSelectionReports] = useState<Pair<AnalysisReport | null>>(pair(null));
  const [measuringFull, setMeasuringFull] = useState<Pair<boolean>>(pair(false));
  const [measuringSel, setMeasuringSel] = useState<Pair<boolean>>(pair(false));
  const [scope, setScope] = useState<Scope>("full");
  const [curveMode, setCurveMode] = useState<CurveMode>("shortTerm");
  const [matchEnabled, setMatchEnabled] = useState(false);
  const [tab, setTab] = useState<Tab>("loudness");
  const [eq, setEq] = useState<EqReport | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryStatus | null>(null);
  const [display, setDisplay] = useState<Display>("wave");
  const [sections, setSections] = useState<Pair<Section[] | null>>(pair(null));
  /** Audition the suggested EQ on A's playback. */
  const [eqAudition, setEqAudition] = useState(false);
  const [eqActive, setEqActive] = useState<boolean[]>([]);
  const [activity, setActivity] = useState<Pair<BandActivity | null>>(pair(null));

  // Latest state for event handlers registered once (keyboard, drag & drop).
  const latest = useRef({ tracks, regions, views, transport, linked });
  latest.current = { tracks, regions, views, transport, linked };
  /** Incremented per load so results for a replaced track are discarded. */
  const loadSeq = useRef<Pair<number>>([0, 0]);

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
  };

  const loadFile = useCallback(async (slot: Slot, path: string) => {
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
      // First track loaded: make sure we're listening to something.
      const { tracks: current, transport: tr } = latest.current;
      if (!current[tr.active]) await api.setActive(slot);
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
    (paths: string[], target: Slot | null) => {
      const audio = paths.filter(isAudioFile);
      if (audio.length === 0) {
        if (paths.length) {
          setErrors((e) => setAt(e, target ?? 0, "Only mp3, flac and wav files are supported"));
        }
        return;
      }
      if (audio.length >= 2) {
        loadFile(0, audio[0]);
        loadFile(1, audio[1]);
        return;
      }
      const { tracks: current } = latest.current;
      const slot = target ?? (current[0] ? (current[1] ? 0 : 1) : 0);
      loadFile(slot, audio[0]);
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

  // Measure the selected sections whenever they change.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      for (const slot of SLOTS) {
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

  const hasSelection = !!(regions[0] || regions[1]);
  const effectiveScope: Scope = hasSelection ? scope : "full";
  // In selection mode, a track without a selection is measured as a whole, so you can compare
  // e.g. your chorus against the full reference without selecting in both lanes.
  const useSelection = (slot: Slot) => effectiveScope === "selection" && !!regions[slot];
  const shown = useMemo<Pair<AnalysisReport | null>>(
    () => [0, 1].map((s) => (useSelection(s as Slot) ? selectionReports[s] : reports[s])) as Pair<AnalysisReport | null>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveScope, regions, selectionReports, reports],
  );

  // A fresh set of suggestions starts with every move switched on.
  useEffect(() => {
    setEqActive(eq ? eq.suggestions.map(() => true) : []);
  }, [eq]);

  const chosenEq = useMemo<EqFilter[]>(
    () => (eq ? eq.suggestions.filter((_, i) => eqActive[i] ?? true) : []),
    [eq, eqActive],
  );
  const eqOn = eqAudition && chosenEq.length > 0 && !!tracks[0];

  // Compensate the EQ's loudness change, so switching it on doesn't just sound louder.
  const eqCompensation = useMemo(() => {
    const a = shown[0];
    return eqOn && a ? -loudnessChange(a.spectrum.freqs, a.spectrum.level, chosenEq) : 0;
  }, [eqOn, shown[0], chosenEq]);

  useEffect(() => {
    if (tracks[0]) api.setEq(0, chosenEq, eqOn);
  }, [chosenEq, eqOn, tracks[0]]);

  // Loudness matching turns the louder track down to the quieter one; EQ compensation is added on
  // top. Never boost (if a trim would be positive, both come down instead), so playback can't
  // be pushed into clipping.
  const trims = useMemo<Pair<number>>(() => {
    const [a, b] = shown.map((r) => r?.loudness.stats.integrated ?? null);
    const raw: Pair<number> = [eqCompensation, 0];
    if (matchEnabled && a !== null && b !== null) {
      const target = Math.min(a, b);
      raw[0] += target - a;
      raw[1] += target - b;
    }
    const lift = Math.max(0, raw[0], raw[1]);
    return [raw[0] - lift, raw[1] - lift];
  }, [matchEnabled, shown[0]?.loudness.stats.integrated, shown[1]?.loudness.stats.integrated, eqCompensation]);

  // Band levels over time, for whatever is being measured: used to find where each EQ move matters.
  const activityKey = SLOTS.map((s) => `${tracks[s]?.path ?? ""}@${useSelection(s) ? `${regions[s]!.start}-${regions[s]!.end}` : "full"}`).join("|");
  useEffect(() => {
    if (tab !== "tonal") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all(
        SLOTS.map((s) => (tracks[s] ? api.bandActivity(s, useSelection(s) ? regions[s] : null).catch(() => null) : null)),
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
    return eq?.suggestions.map((f) => (a && b ? passageFor(f, a, b) : null)) ?? [];
  }, [eq, activity]);

  // EQ match: moves on A towards B, for whatever is being measured (full tracks or selections).
  useEffect(() => {
    const [a, b] = shown;
    if (!a || !b) {
      setEq(null);
      return;
    }
    let cancelled = false;
    api
      .suggestEq(a.spectrum.level, b.spectrum.level)
      .then((r) => !cancelled && setEq(r))
      .catch(() => !cancelled && setEq(null));
    return () => {
      cancelled = true;
    };
  }, [shown[0], shown[1]]);

  const exportReport = async () => {
    const path = await save({
      defaultPath: "abnormal report.md",
      filters: [
        { name: "Markdown report", extensions: ["md"] },
        { name: "JSON summary", extensions: ["json"] },
      ],
    });
    if (!path) return;
    const input = { tracks, reports: shown, scope: effectiveScope, regions, eq };
    const contents = path.toLowerCase().endsWith(".json") ? reportJson(input) : reportMarkdown(input);
    try {
      await api.writeTextFile(path, contents);
      setExportStatus(`Saved ${path.split("/").pop()}`);
    } catch (err) {
      setExportStatus(String(err));
    }
    setTimeout(() => setExportStatus(null), 4000);
  };

  const overlays = useMemo<Pair<ReturnType<typeof overlayFor>>>(
    () => [overlayFor(curveMode, reports[0], shown[0]), overlayFor(curveMode, reports[1], shown[1])],
    [curveMode, reports, shown[0], shown[1]],
  );

  useEffect(() => {
    api.setTrims(trims);
  }, [trims[0], trims[1]]);

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
    const other = (1 - slot) as Slot;
    if (latest.current.transport.active === slot && latest.current.tracks[other]) {
      await api.setActive(other);
    }
  };

  const loadedSlots = () => SLOTS.filter((s) => latest.current.tracks[s]);

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
      api.seek(s, tr.loopEnabled && r[s] ? r[s]!.start : 0);
    }
  }, []);

  /** In linked mode a selection applies to both tracks, so their loops stay in sync. */
  const setRegion = useCallback((slot: Slot, region: Region | null) => {
    const { linked: isLinked, tracks: current, regions: prev } = latest.current;
    const targets = isLinked ? loadedSlots() : [slot];
    let next = prev;
    for (const s of targets) {
      const duration = current[s]!.duration;
      const clamped =
        region && region.start < duration
          ? { start: region.start, end: Math.min(region.end, duration) }
          : null;
      next = setAt(next, s, clamped);
      api.setLoop(s, clamped);
      if (clamped) api.seek(s, clamped.start);
    }
    setRegions(next);
    // A fresh selection is what you want to read numbers for.
    if (region) setScope("selection");
  }, []);

  const clearRegions = useCallback(() => {
    for (const s of SLOTS) api.setLoop(s, null);
    setRegions(pair(null));
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

  const toggleLoop = useCallback(() => {
    api.setLoopEnabled(!latest.current.transport.loopEnabled);
  }, []);

  /** Select and loop a passage of A, listening to A. */
  const listenTo = useCallback(
    (region: Region) => {
      if (!latest.current.tracks[0]) return;
      setRegion(0, region);
      api.setLoopEnabled(true);
      selectSlot(0);
    },
    [setRegion, selectSlot],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const handled = () => e.preventDefault();
      switch (e.key) {
        case " ":
          handled();
          togglePlay();
          break;
        case "Tab":
          handled();
          selectSlot((1 - latest.current.transport.active) as Slot);
          break;
        case "1":
        case "2":
          selectSlot((Number(e.key) - 1) as Slot);
          break;
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
        case "0":
          setViews(pair(null));
          break;
        case "l":
        case "L":
          toggleLoop();
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
    <div className="app">
      <header className="app-header">
        <h1>(a/b)normal</h1>
        <div className="header-actions">
          {exportStatus && <span className="audio-status">{exportStatus}</span>}
          <button onClick={exportReport} disabled={!shown[0] && !shown[1]} title="Save the current comparison as a Markdown report or JSON summary">
            Export report
          </button>
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
        <main className="lanes">
          {SLOTS.map((slot) => (
            <TrackLane
              key={slot}
              slot={slot}
              track={tracks[slot]}
              loading={loading[slot]}
              error={errors[slot]}
              position={transport.positions[slot]}
              region={regions[slot]}
              view={views[slot]}
              overlay={overlays[slot]}
              display={display}
              sections={tracks[slot] ? sections[slot] : null}
              eqOn={slot === 0 && eqOn}
              trimDb={trims[slot]}
              active={transport.active === slot && !!tracks[slot]}
              dropTarget={dropSlot === slot}
              onActivate={() => selectSlot(slot)}
              onOpen={() => openDialog(slot)}
              onClear={() => clearTrack(slot)}
              onSeek={(t) => seek(slot, t)}
              onRegion={(r) => setRegion(slot, r)}
              onView={(v) => setView(slot, v)}
            />
          ))}
        </main>

        <AnalysisPanel
          tab={tab}
          onTab={setTab}
          reports={shown}
          pending={[0, 1].map((s) => (useSelection(s as Slot) ? measuringSel[s] : measuringFull[s])) as Pair<boolean>}
          loaded={[!!tracks[0], !!tracks[1]]}
          scope={effectiveScope}
          hasSelection={hasSelection}
          regions={regions}
          eq={eq}
          paths={[tracks[0]?.path ?? null, tracks[1]?.path ?? null]}
          library={library}
          eqActive={eqActive}
          eqAudition={eqOn}
          eqCompensation={eqCompensation}
          eqPassages={eqPassages}
          onEqActive={(i, on) => setEqActive((v) => v.map((x, k) => (k === i ? on : x)))}
          onEqAudition={setEqAudition}
          onListen={listenTo}
          onScope={setScope}
          onLoad={loadFile}
          onRescan={() => api.rescanLibrary()}
        />
      </div>

      <TransportBar
        playing={transport.playing}
        active={transport.active}
        loopEnabled={transport.loopEnabled}
        linked={linked}
        hasTracks={[!!tracks[0], !!tracks[1]]}
        onTogglePlay={togglePlay}
        onToStart={toStart}
        onSkip={skip}
        onSelect={selectSlot}
        onToggleLoop={toggleLoop}
        onToggleLinked={() => setLinked((v) => !v)}
        curveMode={curveMode}
        onCurveMode={setCurveMode}
        matchEnabled={matchEnabled}
        matchBasis={effectiveScope === "selection" ? "the selections" : "the full tracks"}
        onToggleMatch={() => setMatchEnabled((v) => !v)}
        display={display}
        onDisplay={setDisplay}
        eqOn={eqOn}
        eqAvailable={chosenEq.length > 0 && !!tracks[0]}
        onToggleEq={() => setEqAudition((v) => !v)}
      />

      <p className="hints">
        Space play · Tab or 1/2 A/B · ←/→ ±5 s · drag to select, double-click/Esc clears · wheel or
        pinch to zoom, Shift+wheel to pan · +/− zoom · 0 fit · L loop · K link · M match · E EQ · C curve · S
        spectrogram · click a section to select it, Shift+click to extend
      </p>
    </div>
  );
}
