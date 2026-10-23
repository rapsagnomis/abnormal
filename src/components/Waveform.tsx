import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { flash, reduced } from "../lib/motion";
import { api } from "../lib/api";
import type { Curve, Marker, Peaks, Region, Slot } from "../lib/api";
import { MarkerLayer } from "./Markers";
import { formatTime, minorTickStep, tickStep } from "../lib/format";
import type { Overlay } from "../lib/overlay";
import { ceilingOf, freqToY, renderSpectrogram } from "../lib/spectrogram";
import type { View } from "../lib/view";
import { isFull, panView, zoomView } from "../lib/view";

interface Props {
  slot: Slot;
  peaks: Peaks;
  /** Changes with each new song in the lane; new peaks for the same song are another version of
   *  it, whose bars reshape in place rather than the waveform sweeping in. */
  song: number;
  duration: number;
  view: View;
  position: number;
  region: Region | null;
  /** Curve drawn over the waveform (loudness, PSR), or null for none. */
  overlay: Overlay | null;
  /** Playback gain shown on the bars, dB (normalizing): they grow by it. */
  gainDb: number;
  /** Momentary loudness over the whole track (with `gainDb` applied), for the wave display's
   *  bodies; null until measured. */
  loudness: Curve | null;
  display: Display;
  onSeek: (seconds: number) => void;
  markers: Marker[];
  /** Time of the marker whose note is being edited, or null. */
  editingMarker: number | null;
  onMarkers: (markers: Marker[]) => void;
  onEditMarker: (time: number | null) => void;
  onRegion: (region: Region | null) => void;
  /** This track loops its selection; the loop button on the selection toggles it. */
  looping: boolean;
  onToggleLoop: () => void;
  onView: (view: View) => void;
}

/** Wave: loudness bodies under faint peak caps, on a dB scale. Peak: peak bars, linear. */
export type Display = "wave" | "peak" | "spectrogram";

/** Pointer movement (px) before a press becomes a region drag instead of a click-to-seek. */
const DRAG_THRESHOLD = 4;
const MIN_REGION_SECONDS = 0.01;

/** Peaks covering [start, end] seconds. The overview spans the whole track. */
interface PeakSource {
  start: number;
  end: number;
  peaks: Peaks;
}

/** A rendered spectrogram covering [start, end] seconds. */
interface SpecImage {
  start: number;
  end: number;
  image: HTMLCanvasElement;
  /** The audio it was made from (its peaks), so another version's replaces it once ready. */
  of?: Peaks;
}

/** A curve overlay changing into another: `from` (null = none) fades and bends into the new one. */
interface Morph {
  from: Overlay | null;
  /** 0 = `from`, 1 = the new overlay. */
  t: number;
}
const MORPH_MS = 380;
const DISPLAY_FADE_MS = 320;
/** With a curve shown, this strip at the right (CSS px) holds its scale labels alone: the time
 *  axis (bars, curve, selection, strips, ruler) is squeezed to end before it, so nothing ever
 *  covers a label and the end of the track stays visible. */
const LABEL_GUTTER = 34;
/** A playhead move larger than this in one frame (s) is a jump, drawn as a glide of this long (ms). */
const PLAYHEAD_JUMP_SEC = 0.2;
const PLAYHEAD_GLIDE_MS = 260;
/** Waveform bars, CSS pixels: width and gap. Bars sit on this fixed screen grid at every zoom. */
const BAR_WIDTH = 3;
const BAR_GAP = 2;
/** Playhead light: falloff width in bars (Gaussian σ), and how many bars either side it reaches. */
const PLAYHEAD_SIGMA = 0.45;
const PLAYHEAD_SPREAD = 3;
/**
 * How far the reshaping towards the playhead's height reaches, in bars: ahead of the playhead a
 * narrow, steep falloff (bars snap into shape only as it arrives, a fast attack, no slow wave
 * front), behind it a wider one (they relax back gently). `exp(-½ (|d| / σ)^p)`.
 */
const PLAYHEAD_ATTACK = { sigma: 0.55, power: 3 };
const PLAYHEAD_RELEASE = { sigma: 1.1, power: 2 };
/** The playhead's bar has a fixed height, whatever the waveform there: this share of the lane. */
const PLAYHEAD_HEIGHT = 0.8;
/** Bars outside a selection keep this much of their opacity. */
const SELECTION_DIM = 0.5;
/** Time subdivisions appear once this far apart, CSS px, and are fully shown this much further. */
const GRID_MIN_PX = 6;
const GRID_FADE_PX = 18;
/** How long bars take to settle on their new heights after a zoom, pan or new data, ms. */
const BAR_EASE_MS = 160;
/** …and to grow or shrink when the track's gain changes (normalizing), slower so it reads. */
const GAIN_EASE_MS = 420;
/** …and to reshape into another version of the song. Bars arriving in steps (overview, then
 *  finer peaks, then loudness) within `VERSION_WINDOW_MS` of the switch all take this long. */
const VERSION_EASE_MS = 450;
const VERSION_WINDOW_MS = 1500;
/** Wave display: bottom of its dB scale (peak dBFS and loudness LUFS share it), the same for every
 *  lane so tracks compare at a glance. A loud master's sections still differ by several LU here,
 *  where its peaks barely move. */
const WAVE_FLOOR_DB = -30;
const SWEEP_IN: Keyframe[] = [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }];

/** Whole-track spectrogram resolution: shown while a view's detail image loads. */
const SPEC_OVERVIEW = { columns: 1024, rows: 128 };
const SPEC_MAX = { columns: 2048, rows: 256 };
const SPEC_LABELS = [100, 1000, 10000];

export function Waveform(props: Props) {
  const { slot, peaks, duration, view, region, overlay, display } = props;

  // The playhead as drawn: when it jumps (a seek, ±5 s, back to start, a loop restarting) it
  // glides from where it was to the live position instead of jumping (display only; playback
  // moves at once). Recomputed every render, which the transport poll triggers every frame.
  const glide = useRef({ from: props.position, at: -Infinity, last: props.position });
  const now = performance.now();
  const g = glide.current;
  const shownFor = (target: number) => {
    const t = Math.min(1, (now - g.at) / PLAYHEAD_GLIDE_MS);
    return t >= 1 ? target : g.from + (target - g.from) * (1 - (1 - t) ** 3);
  };
  if (Math.abs(props.position - g.last) > PLAYHEAD_JUMP_SEC && !reduced()) {
    g.from = shownFor(g.last);
    g.at = now;
  }
  g.last = props.position;
  const position = shownFor(props.position);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fadeRef = useRef<HTMLCanvasElement>(null);
  const shownDisplay = useRef(display);
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** The labels' strip at the right, and the width left for the time axis (CSS px). */
  const gutter = overlay ? LABEL_GUTTER : 0;
  const plotWidth = Math.max(0, size.width - gutter);
  const [draft, setDraft] = useState<Region | null>(null);
  /** Pointer position over the lane, CSS px from its left edge (null when outside). */
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [detail, setDetail] = useState<PeakSource | null>(null);
  const press = useRef<{ x: number; t: number; dragging: boolean } | null>(null);
  const [specOverview, setSpecOverview] = useState<SpecImage | null>(null);
  const [specDetail, setSpecDetail] = useState<SpecImage | null>(null);
  /** Display ceiling (byte level) for this track, from the overview, so zooming keeps the scale. */
  const [specCeiling, setSpecCeiling] = useState<number | null>(null);

  /** The overlay last drawn, and the frame of a morph in progress. */
  const shownOverlay = useRef<Overlay | null>(null);
  /** Bar heights on screen (0–1 of full scale), eased towards new ones. */
  const shownBars = useRef<Float32Array | null>(null);
  /** The gain the bars were last drawn at, dB. */
  const shownGain = useRef(props.gainDb);
  /** The peaks and song last drawn, and when another version of the song last came in. */
  const shownPeaks = useRef<Peaks | null>(null);
  const shownSong = useRef(props.song);
  const versionAt = useRef(-Infinity);
  /** Bumped when bars settle, so the playhead/hover marks (read from `shownBars`) catch up. */
  const [, setBarsSettled] = useState(0);
  const morphFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(morphFrame.current), []);

  // Handlers attached natively (wheel must be non-passive) read the latest props from here.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const el = containerRef.current!;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fetch finer peaks once the overview no longer has a bucket per device pixel.
  useEffect(() => {
    const px = Math.round(plotWidth * (window.devicePixelRatio || 1));
    const end = Math.min(view.end, duration);
    const overviewBuckets = (peaks.buckets * (end - view.start)) / duration;
    if (!px || end <= view.start || overviewBuckets >= px) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const buckets = Math.max(1, Math.round((px * (end - view.start)) / (view.end - view.start)));
    const timer = setTimeout(async () => {
      try {
        const p = await api.rangePeaks(slot, view.start, end, buckets);
        if (!cancelled) setDetail({ start: view.start, end, peaks: p });
      } catch {
        // Track was unloaded mid-request; the overview keeps drawing.
      }
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [slot, peaks, duration, view.start, view.end, plotWidth]);

  // A new song starts with no spectrogram; another version keeps the old one until its own is ready.
  const specSong = useRef(props.song);
  useEffect(() => {
    if (specSong.current === props.song) return;
    specSong.current = props.song;
    setSpecOverview(null);
    setSpecDetail(null);
    setSpecCeiling(null);
  }, [slot, props.song]);

  useEffect(() => {
    if (display !== "spectrogram" || specOverview?.of === peaks) return;
    let cancelled = false;
    const { columns, rows } = SPEC_OVERVIEW;
    api
      .spectrogram(slot, 0, duration, columns, rows)
      .then((data) => {
        if (cancelled) return;
        const ceiling = ceilingOf(data);
        setSpecCeiling(ceiling);
        setSpecOverview({ start: 0, end: duration, image: renderSpectrogram(data, columns, rows, ceiling), of: peaks });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [display, specOverview, slot, duration, peaks]);

  // Detail at screen resolution for the visible window.
  useEffect(() => {
    if (display !== "spectrogram" || specCeiling === null) return;
    const dpr = window.devicePixelRatio || 1;
    const end = Math.min(view.end, duration);
    const columns = Math.min(SPEC_MAX.columns, Math.round(plotWidth * dpr * ((end - view.start) / (view.end - view.start))));
    const rows = Math.min(SPEC_MAX.rows, Math.round(size.height * dpr));
    if (columns < 1 || rows < 1 || end <= view.start) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await api.spectrogram(slot, view.start, end, columns, rows);
        if (!cancelled) setSpecDetail({ start: view.start, end, image: renderSpectrogram(data, columns, rows, specCeiling) });
      } catch {
        // Track was unloaded mid-request.
      }
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [display, specCeiling, slot, duration, view.start, view.end, plotWidth, size.height]);

  // The selection (or the one being dragged): bars inside it are lit, see `draw`.
  const selection = draft ?? region;

  // The playhead's bar on the CSS-pixel grid (bar displays only). The bars around it are drawn as
  // live elements (squeezed or dilated towards the playhead), so the canvas leaves them out.
  const playheadBar =
    display !== "spectrogram" && position >= view.start && position <= view.end && plotWidth > 0
      ? Math.floor((((position - view.start) / (view.end - view.start)) * plotWidth) / (BAR_WIDTH + BAR_GAP))
      : null;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(size.width * dpr);
    const h = Math.round(size.height * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    // Switching between waveform and spectrogram: keep a copy of what was on screen and fade it out.
    if (shownDisplay.current !== display) {
      shownDisplay.current = display;
      const fade = fadeRef.current!;
      fade.width = w;
      fade.height = h;
      fade.getAnimations().forEach((a) => a.cancel());
      fade.getContext("2d")!.drawImage(canvas, 0, 0);
      if (!reduced()) fade.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DISPLAY_FADE_MS, easing: "ease-in-out", fill: "forwards" });
    }
    const overview = { start: 0, end: duration, peaks };
    const spec = display === "spectrogram" ? [specOverview, specDetail] : null;
    const skip: [number, number] | null =
      playheadBar === null ? null : [playheadBar - PLAYHEAD_SPREAD, playheadBar + PLAYHEAD_SPREAD];
    const render = (morph: Morph | null, bars: Float32Array) =>
      draw(canvas, view, duration, overlay, dpr, gutter, spec, morph, bars, display === "wave", skip, selection);

    // Bars ease from the heights on screen to the new ones (zoom, pan, finer data arriving)…
    const peakBars = barPeaks(view, duration, overview, detail, Math.round(plotWidth * dpr), dpr);
    if (props.gainDb) {
      const g = 10 ** (props.gainDb / 20);
      for (let i = 0; i < peakBars.length; i++) peakBars[i] *= g;
    }
    const targets = display === "wave" ? waveBars(peakBars, props.loudness, view, plotWidth) : peakBars;
    const fromBars = shownBars.current?.length === targets.length ? shownBars.current : targets;
    const gainMoved = shownGain.current !== props.gainDb;
    shownGain.current = props.gainDb;
    // New peaks for the same song: another version came in front.
    if (shownPeaks.current && shownPeaks.current !== peaks && shownSong.current === props.song) versionAt.current = performance.now();
    shownPeaks.current = peaks;
    shownSong.current = props.song;
    const versionEase = performance.now() - versionAt.current < VERSION_WINDOW_MS;
    const easeMs = gainMoved ? GAIN_EASE_MS : versionEase ? VERSION_EASE_MS : BAR_EASE_MS;
    // (Unchanged heights, e.g. only the playhead moved on a bar: nothing to ease.)
    const barsMove = fromBars !== targets && !reduced() && fromBars.some((v, i) => v !== targets[i] && !(Number.isNaN(v) && Number.isNaN(targets[i])));
    // …and a different curve (another mode, a curve switched on or off, a new track) morphs from
    // the one on screen instead of jumping.
    const previous = shownOverlay.current;
    shownOverlay.current = overlay;
    const curveMoves = (previous?.curve ?? null) !== (overlay?.curve ?? null) && !reduced();
    cancelAnimationFrame(morphFrame.current);
    if (!barsMove && !curveMoves) {
      shownBars.current = targets;
      render(null, targets);
      setBarsSettled((n) => n + 1);
      return;
    }
    const start = performance.now();
    const ease = (t: number) => 1 - (1 - t) ** 3;
    const step = (now: number) => {
      const tc = curveMoves ? Math.min(1, (now - start) / MORPH_MS) : 1;
      const tb = barsMove ? Math.min(1, (now - start) / easeMs) : 1;
      const k = ease(tb);
      const bars = tb < 1 ? targets.map((v, i) => fromBars[i] + (v - fromBars[i]) * k) : targets;
      shownBars.current = bars;
      render(tc < 1 ? { from: previous, t: ease(tc) } : null, bars);
      if (tc < 1 || tb < 1) morphFrame.current = requestAnimationFrame(step);
      else setBarsSettled((n) => n + 1);
    };
    step(start);
    // view.start/end rather than view: callers may pass a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, duration, view.start, view.end, detail, overlay, size, display, specOverview, specDetail, playheadBar, selection?.start, selection?.end, props.gainDb, props.loudness]);

  // A new song sweeps in from the left (another version of it reshapes its bars instead).
  const sweptSong = useRef<number | null>(null);
  useEffect(() => {
    if (sweptSong.current === props.song) return;
    sweptSong.current = props.song;
    flash(canvasRef.current, SWEEP_IN, 650);
  }, [props.song]);

  // Wheel: ⌘+wheel or a pinch (arrives as ctrl+wheel) zooms around the cursor, a sideways swipe
  // (or Shift+wheel) pans; a plain vertical scroll is left alone, so it scrolls the lanes.
  useEffect(() => {
    const el = containerRef.current!;
    const onWheel = (e: WheelEvent) => {
      const zoom = e.ctrlKey || e.metaKey;
      const horizontal = !zoom && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY));
      if (!zoom && !horizontal) return;
      e.preventDefault();
      const { view: v, duration: d, onView, overlay: o } = latest.current;
      const rect = el.getBoundingClientRect();
      const width = rect.width - (o ? LABEL_GUTTER : 0);
      const span = v.end - v.start;
      if (horizontal) {
        const delta = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
        onView(panView(v, (delta / width) * span, d));
      } else {
        const anchor = v.start + Math.min(1, (e.clientX - rect.left) / width) * span;
        const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
        onView(zoomView(v, factor, anchor, d));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const span = view.end - view.start;

  const timeAt = (clientX: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / (rect.width - gutter)));
    return Math.min(view.start + frac * span, duration);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { x: e.clientX, t: timeAt(e.clientX), dragging: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    setHoverX(e.clientX - containerRef.current!.getBoundingClientRect().left);
    const p = press.current;
    if (!p) return;
    if (!p.dragging && Math.abs(e.clientX - p.x) < DRAG_THRESHOLD) return;
    p.dragging = true;
    const t = timeAt(e.clientX);
    setDraft({ start: Math.min(p.t, t), end: Math.max(p.t, t) });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    const t = timeAt(e.clientX);
    if (!p.dragging) {
      props.onSeek(t);
    } else if (Math.abs(t - p.t) >= MIN_REGION_SECONDS) {
      props.onRegion({ start: Math.min(p.t, t), end: Math.max(p.t, t) });
    }
    setDraft(null);
  };

  const shown = selection;
  const pct = (t: number) => `${((t - view.start) / span) * 100}%`;
  const step = tickStep(span, plotWidth);
  const firstTick = Math.ceil(view.start / step) * step;
  const ticks: number[] = [];
  for (let t = firstTick; t <= Math.min(view.end, duration) + 1e-9; t += step) ticks.push(t);
  const tickDecimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const playheadVisible = position >= view.start && position <= view.end;

  // Time guidelines: one per ruler tick, and fainter subdivisions that fade in as zooming in
  // gives them room, so the time scale stays readable while bars change under it.
  const minor = minorTickStep(step);
  const minorPx = (minor / span) * plotWidth;
  const minorAlpha = Math.min(1, Math.max(0, (minorPx - GRID_MIN_PX) / GRID_FADE_PX));
  const minorLines: number[] = [];
  if (minorAlpha > 0) {
    const end = Math.min(view.end, duration);
    for (let k = Math.ceil(view.start / minor); k * minor <= end + 1e-9; k++) {
      const t = k * minor;
      if (Math.abs(t / step - Math.round(t / step)) > 1e-6) minorLines.push(t);
    }
  }

  // Bars on the CSS-pixel grid: which one is under the playhead or the pointer, and how tall it
  // is on screen right now (heights may be mid-ease).
  const pitch = BAR_WIDTH + BAR_GAP;
  // Bars that fit before the labels' strip (when a curve is shown).
  const barCount = Math.floor((plotWidth - BAR_WIDTH) / pitch) + 1;
  const barAt = (x: number) => Math.floor(x / pitch);
  // (In the wave display, the bodies: what the playhead and the pointer reshape.)
  const barHeight = (i: number) => {
    const v = shownBars.current?.[i];
    if (v === undefined || Number.isNaN(v)) return null;
    return 2 * Math.max(BAR_WIDTH / 2, Math.min(1, v) * (size.height / 2) * 0.95);
  };
  const bars = display !== "spectrogram";
  const playX = ((position - view.start) / span) * plotWidth;
  const hoverBar = bars && hoverX !== null && hoverX >= 0 && hoverX < plotWidth ? barAt(hoverX) : null;

  // The playhead as light sliding along the bars. Around it, bars are reshaped: dilated or
  // squeezed towards the playhead's fixed height, more the closer they are (a Gaussian of the
  // distance between their centre and the exact playhead position), and lit (lighter, wider, a
  // glow) by a tighter Gaussian. Recomputed every frame, so it moves continuously, never by jumps.
  const fixedHeight = size.height * PLAYHEAD_HEIGHT;
  const playheadMarks: { i: number; height: number; light: number; inside: number }[] = [];
  if (playheadBar !== null) {
    for (let i = playheadBar - PLAYHEAD_SPREAD; i <= playheadBar + PLAYHEAD_SPREAD; i++) {
      const own = i >= 0 && i < barCount ? barHeight(i) : null;
      if (own === null) continue;
      const d = (playX - (i * pitch + BAR_WIDTH / 2)) / pitch;
      // d < 0: the bar is still ahead of the playhead.
      const { sigma, power } = d < 0 ? PLAYHEAD_ATTACK : PLAYHEAD_RELEASE;
      const shape = Math.exp(-0.5 * (Math.abs(d) / sigma) ** power);
      const light = Math.exp(-0.5 * (d / PLAYHEAD_SIGMA) ** 2);
      const inside = selection ? barCoverage(view.start + ((i * pitch) / plotWidth) * span, (BAR_WIDTH / plotWidth) * span, selection) : 0;
      playheadMarks.push({ i, height: own + (fixedHeight - own) * shape, light, inside });
    }
  }

  const barMark = (i: number | null, kind: "hover-bar", grow: number, extra: number, wider: number) => {
    if (i === null || i < 0 || i >= barCount) return null;
    const height = barHeight(i);
    if (height === null) return null;
    return (
      <div
        key={`${kind}${i}`}
        className={`bar-mark ${kind}`}
        style={{ left: i * pitch - wider / 2, width: BAR_WIDTH + wider, height: height * grow + extra }}
      />
    );
  };

  return (
    <div className="waveform" style={{ "--gutter": `${gutter}px` } as CSSProperties}>
      <div
        ref={containerRef}
        className="waveform-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverX(null)}
        onDoubleClick={() => props.onRegion(null)}
      >
        <div className="time-grid" aria-hidden="true">
          {ticks.map((t) => (
            <span key={`M${t}`} className="major" style={{ left: pct(t) }} />
          ))}
          {minorLines.map((t) => (
            <span key={`m${t}`} style={{ left: pct(t), opacity: minorAlpha }} />
          ))}
        </div>
        <canvas ref={canvasRef} />
        {/* The previous display (waveform or spectrogram), fading out over the new one. */}
        <canvas ref={fadeRef} className="display-fade" />
        {/* Everything placed in time, over the canvas's plot area (left of the labels' strip). */}
        <div className="plot">
          {shown && shown.end > view.start && shown.start < view.end && (
            <div
              className={`region${draft ? " draft" : ""}${display === "spectrogram" ? " on-spec" : ""}${props.looping && !draft ? " looping" : ""}`}
              style={{ left: pct(shown.start), width: `${((shown.end - shown.start) / span) * 100}%` }}
            />
          )}
          {/* Loop this track's selection: a small button on top of it, at the middle of its visible part. */}
          {region && !draft && region.end > view.start && region.start < view.end && (
            <button
              className={`loop-button${props.looping ? " on" : ""}`}
              style={{ left: pct((Math.max(region.start, view.start) + Math.min(region.end, view.end)) / 2) }}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={props.onToggleLoop}
              title={props.looping ? "Looping this selection: click to stop (L)" : "Loop this selection (L)"}
              aria-label={props.looping ? "Stop looping the selection" : "Loop the selection"}
              aria-pressed={props.looping}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M17 2l3 3-3 3" />
                <path d="M4 11V9a4 4 0 0 1 4-4h12" />
                <path d="M7 22l-3-3 3-3" />
                <path d="M20 13v2a4 4 0 0 1-4 4H4" />
              </svg>
            </button>
          )}
          {/* On the bars: the hovered bar lifts a little, the playhead's bar is lighter, wider and
              taller. On the spectrogram, the playhead stays a line. */}
          {/* Not inside the playhead's zone, where bars are already reshaped. */}
          {(playheadBar === null || hoverBar === null || Math.abs(hoverBar - playheadBar) > PLAYHEAD_SPREAD) &&
            barMark(hoverBar, "hover-bar", 1.06, 4, 0)}
          {playheadMarks.map(({ i, height, light, inside }) => (
            <div
              key={`p${i}`}
              className="bar-mark playhead-bar"
              style={
                {
                  left: i * pitch - light,
                  width: BAR_WIDTH + 2 * light,
                  height,
                  "--light": `${Math.round(light * 100)}%`,
                  "--inside": `${Math.round(inside * 100)}%`,
                  // Dimmed outside a selection like the canvas bars, but never the lit playhead.
                  opacity: selection ? SELECTION_DIM + (1 - SELECTION_DIM) * Math.max(inside, light) : 1,
                } as CSSProperties
              }
            />
          ))}
          {playheadVisible && !bars && <div className="playhead" style={{ left: pct(position) }} />}
          <MarkerLayer
            markers={props.markers}
            view={view}
            editing={props.editingMarker}
            onChange={props.onMarkers}
            onEdit={props.onEditMarker}
          />
        </div>
      </div>
      <div className="ruler">
        {ticks.map((t) => (
          <span key={t.toFixed(3)} style={{ left: pct(t) }}>
            {formatTime(t, tickDecimals)}
          </span>
        ))}
      </div>
      {!isFull(view, duration) && (
        <Scrollbar view={view} duration={duration} onView={props.onView} />
      )}
    </div>
  );
}

/** Thin overview of where the zoomed window sits; drag the thumb (or click the track) to pan. */
function Scrollbar({ view, duration, onView }: { view: View; duration: number; onView: (v: View) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; start: number } | null>(null);
  const span = view.end - view.start;

  const toSeconds = (px: number) => (px / ref.current!.getBoundingClientRect().width) * duration;

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = ref.current!.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * duration;
    let start = view.start;
    // Clicking outside the thumb centres the view there.
    if (t < view.start || t > view.end) {
      start = t - span / 2;
      onView(panView(view, start - view.start, duration));
    }
    drag.current = { x: e.clientX, start };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const start = d.start + toSeconds(e.clientX - d.x);
    onView(panView(view, start - view.start, duration));
  };

  return (
    <div
      ref={ref}
      className="scrollbar"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
    >
      <div
        className="scrollbar-thumb"
        style={{
          left: `${(view.start / duration) * 100}%`,
          width: `${Math.max((span / duration) * 100, 0.5)}%`,
        }}
      />
    </div>
  );
}

function draw(
  canvas: HTMLCanvasElement,
  view: View,
  duration: number,
  overlay: Overlay | null,
  dpr: number,
  /** The labels' strip at the right, CSS px: time runs across the rest. */
  gutter: number,
  spec: (SpecImage | null)[] | null,
  morph: Morph | null,
  bars: Float32Array,
  /** `bars` holds bodies then caps (see `waveBars`), rather than peaks alone. */
  layered: boolean,
  /** Bars drawn elsewhere (around the playhead), left out here. */
  skip: [number, number] | null,
  /** Selected range: its bars are lit, the others dimmed. */
  selection: Region | null,
) {
  const ctx = canvas.getContext("2d")!;
  const { width: w, height: h } = canvas;
  const style = getComputedStyle(canvas);
  const color = (name: string) => style.getPropertyValue(name).trim();

  ctx.clearRect(0, 0, w, h);
  const mid = h / 2;
  const scale = mid * 0.95;

  const plot = w - gutter * dpr;
  if (spec) {
    drawSpectrogram(ctx, spec, view, w, h, dpr, color, plot);
    if (plot < w) {
      ctx.fillStyle = "rgba(14, 16, 19, 0.85)";
      ctx.fillRect(plot, 0, w - plot, h);
    }
    drawOverlays(ctx, overlay, morph, view, duration, w, h, dpr, color, plot, true);
    return;
  }

  ctx.fillStyle = color("--wave-axis");
  ctx.fillRect(0, Math.floor(mid), w, 1);

  // Rounded bars on a fixed grid, mirrored about the centre line, one colour (the lane's): as tall
  // as the peak level of the time each covers, or (layered) a loudness body under a faint peak
  // cap. `bars` may be mid-ease to new heights.
  const pitch = (BAR_WIDTH + BAR_GAP) * dpr;
  const barW = BAR_WIDTH * dpr;
  const radius = barW / 2;
  const secPerPx = (view.end - view.start) / plot;
  const wave = color("--wave");
  const lit = color("--wave-selected");
  const count = layered ? bars.length / 2 : bars.length;
  const bar = (i: number, v: number, alpha: number) => {
    // Never shorter than a round dot, so quiet passages keep a visible line of beads.
    const half = Math.max(radius, Math.min(1, v) * scale);
    // With a selection, like the playhead: bars inside it lit, edge bars by how much of them is
    // inside (so the boundary moves smoothly while dragging), the rest a step back.
    const inside = selection ? barCoverage(view.start + i * pitch * secPerPx, barW * secPerPx, selection) : 0;
    ctx.globalAlpha = alpha * (selection ? SELECTION_DIM + (1 - SELECTION_DIM) * inside : 1);
    ctx.fillStyle = wave;
    ctx.beginPath();
    ctx.roundRect(i * pitch, mid - half, barW, 2 * half, radius);
    ctx.fill();
    if (inside > 0) {
      ctx.globalAlpha = alpha * inside;
      ctx.fillStyle = lit;
      ctx.fill();
    }
  };
  for (let i = 0; i < count; i++) {
    if (i * pitch + barW > plot) break;
    // Caps everywhere, the playhead's zone included: its live bars reshape the bodies only.
    if (layered && !Number.isNaN(bars[count + i])) bar(i, bars[count + i], WAVE_CAP_ALPHA);
    if (!Number.isNaN(bars[i]) && !(skip && i >= skip[0] && i <= skip[1])) bar(i, bars[i], 1);
  }
  ctx.globalAlpha = 1;
  drawOverlays(ctx, overlay, morph, view, duration, w, h, dpr, color, plot);
}

/** Opacity of the wave display's peak caps, over the solid loudness bodies. */
const WAVE_CAP_ALPHA = 0.32;

/** A level in dB as a share of the wave display's height. */
const waveHeight = (db: number) => Math.min(1, Math.max(0, (db - WAVE_FLOOR_DB) / -WAVE_FLOOR_DB));

/**
 * The wave display's bars from the peak bars (linear 0–1, NaN past the end): bodies (the loudest
 * momentary loudness in each bar's time, or at its middle when it's shorter than the curve's hop),
 * then caps (the peaks), both on the dB scale; `[bodies…, caps…]`. Bodies are 0 until the
 * loudness is measured, so they grow in when it arrives.
 */
function waveBars(peakBars: Float32Array, loudness: Curve | null, view: View, plotWidth: number): Float32Array {
  const n = peakBars.length;
  const out = new Float32Array(2 * n);
  const secPerBar = ((view.end - view.start) / plotWidth) * (BAR_WIDTH + BAR_GAP);
  for (let i = 0; i < n; i++) {
    const peak = peakBars[i];
    if (Number.isNaN(peak)) {
      out[i] = NaN;
      out[n + i] = NaN;
      continue;
    }
    const cap = peak > 0 ? waveHeight(20 * Math.log10(peak)) : 0;
    out[n + i] = cap;
    const db = loudness ? loudestIn(loudness, view.start + i * secPerBar, view.start + (i + 1) * secPerBar) : null;
    // Loudness never reads above the peaks on screen (it can't, short of rounding).
    out[i] = db === null ? 0 : Math.min(cap, waveHeight(db));
  }
  return out;
}

/** The highest reading of `curve` in [t0, t1), or its value at the middle when no point falls inside. */
function loudestIn(curve: Curve, t0: number, t1: number): number | null {
  const { values, hop } = curve;
  const first = Math.max(0, Math.ceil((t0 - curve.t0) / hop));
  const last = Math.min(values.length - 1, Math.ceil((t1 - curve.t0) / hop) - 1);
  if (last >= first) {
    let max: number | null = null;
    for (let k = first; k <= last; k++) {
      const v = values[k];
      if (v !== null && (max === null || v > max)) max = v;
    }
    return max;
  }
  const pos = ((t0 + t1) / 2 - curve.t0) / hop;
  const k = Math.floor(pos);
  const a = values[k];
  const b = values[k + 1];
  if (a == null || b == null) return a ?? b ?? null;
  return a + (b - a) * (pos - k);
}

/** How much of a bar (starting at `t0`, `dt` long) lies in `region`, 0–1, eased at the ends. */
function barCoverage(t0: number, dt: number, region: Region): number {
  const covered = Math.min(t0 + dt, region.end) - Math.max(t0, region.start);
  const c = Math.min(1, Math.max(0, covered / dt));
  return c * c * (3 - 2 * c);
}

/**
 * Peak level (0–1, the larger of |max| and |min|) of the time each bar covers, for bars on the
 * fixed grid across the view; NaN past the end of the track. Takes every bucket a bar touches,
 * partial ones included, so peaks don't flicker in and out as the zoom changes, preferring detail
 * peaks where they cover the bar.
 */
function barPeaks(view: View, duration: number, overview: PeakSource, detail: PeakSource | null, w: number, dpr: number): Float32Array {
  const pitch = (BAR_WIDTH + BAR_GAP) * dpr;
  const count = Math.max(0, Math.floor((w + BAR_GAP * dpr) / pitch));
  const secPerBar = ((view.end - view.start) / w) * pitch;
  const bars = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t0 = view.start + i * secPerBar;
    const t1 = t0 + secPerBar;
    if (t0 >= duration) {
      bars[i] = NaN;
      continue;
    }
    const src = detail && t0 >= detail.start && t1 <= detail.end + secPerBar ? detail : overview;
    const { peaks } = src;
    const n = peaks.buckets;
    const toBucket = (t: number) => ((t - src.start) / (src.end - src.start)) * n;
    const b0 = Math.min(n - 1, Math.max(0, Math.floor(toBucket(t0))));
    const b1 = Math.min(n, Math.max(b0 + 1, Math.ceil(toBucket(Math.min(t1, duration)))));
    let peak = 0;
    for (let b = b0; b < b1; b++) peak = Math.max(peak, peaks.max[b], -peaks.min[b]);
    bars[i] = peak;
  }
  return bars;
}

/** The overlay, or a morph between two: grids and labels cross-fade, the curve bends from one
 *  shape into the other (rising from the bottom when there was none, sinking away when removed). */
function drawOverlays(
  ctx: CanvasRenderingContext2D,
  overlay: Overlay | null,
  morph: Morph | null,
  view: View,
  duration: number,
  w: number,
  h: number,
  dpr: number,
  color: (name: string) => string,
  /** Where the plot ends (device px): the labels' strip is to its right. */
  plot: number,
  cased = false,
) {
  if (!morph) {
    if (overlay) {
      drawGuides(ctx, overlay, view, duration, w, h, dpr, color, 1, plot);
      strokeCurve(ctx, curvePoints(overlay, view, h, plot), dpr, color, cased, 1);
    }
    return;
  }
  const { from, t } = morph;
  if (from) drawGuides(ctx, from, view, duration, w, h, dpr, color, 1 - t, plot);
  if (overlay) drawGuides(ctx, overlay, view, duration, w, h, dpr, color, t, plot);
  const a = from ? curvePoints(from, view, h, plot) : null;
  const b = overlay ? curvePoints(overlay, view, h, plot) : null;
  const points = (a ?? b)!.map((_, i) => {
    const ya = a ? a[i] : h;
    const yb = b ? b[i] : h;
    if (Number.isNaN(ya)) return yb;
    if (Number.isNaN(yb)) return ya;
    return ya + (yb - ya) * t;
  });
  // Appearing or going away: fade as well as move.
  strokeCurve(ctx, points, dpr, color, cased, a && b ? 1 : a ? 1 - t : t);
}

/** Images in order (overview first, then detail on top), each placed at its time range. */
function drawSpectrogram(
  ctx: CanvasRenderingContext2D,
  images: (SpecImage | null)[],
  view: View,
  w: number,
  h: number,
  dpr: number,
  color: (name: string) => string,
  /** Where the time axis ends (device px). */
  plot: number,
) {
  const span = view.end - view.start;
  const xAt = (t: number) => ((t - view.start) / span) * plot;
  ctx.imageSmoothingEnabled = true;
  for (const img of images) {
    if (!img) continue;
    const x0 = xAt(img.start);
    ctx.drawImage(img.image, x0, 0, xAt(img.end) - x0, h);
  }
  for (const f of SPEC_LABELS) {
    const y = Math.round(freqToY(f) * h) + 0.5;
    ctx.fillStyle = color("--curve-grid");
    ctx.fillRect(0, y, w, dpr);
    drawLabel(ctx, f >= 1000 ? `${f / 1000}k` : `${f}`, 8 * dpr, y, "left", dpr, color);
  }
}

/** Pixel columns sampled for a curve; finer is slower and not visibly smoother. */
const CURVE_STEP_PX = 2;

/** Value-to-height mapping for an overlay's axis. */
function overlayY(overlay: Overlay, h: number) {
  const { top, bottom } = overlay;
  const lo = Math.min(top, bottom);
  const hi = Math.max(top, bottom);
  return (v: number) => ((top - Math.min(hi, Math.max(lo, v))) / (top - bottom)) * h;
}

/** Grid lines, their labels and the dashed reference line, at `alpha`. */
function drawGuides(
  ctx: CanvasRenderingContext2D,
  overlay: Overlay,
  view: View,
  duration: number,
  w: number,
  h: number,
  dpr: number,
  color: (name: string) => string,
  alpha: number,
  plot: number,
) {
  if (alpha <= 0) return;
  const span = view.end - view.start;
  const xEnd = Math.min(plot, ((duration - view.start) / span) * plot);
  const yAt = overlayY(overlay, h);
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const g of overlay.grid) {
    const y = Math.round(yAt(g)) + 0.5;
    ctx.fillStyle = color("--curve-grid");
    ctx.fillRect(0, y, xEnd, dpr);
  }
  if (overlay.reference !== null) {
    const y = yAt(overlay.reference);
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.strokeStyle = color("--curve-integrated");
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(xEnd, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Labels in their own strip at the right, clear of the waveform and the curve.
  for (const g of overlay.grid) drawLabel(ctx, `${g}`, w - 4 * dpr, Math.round(yAt(g)) + 0.5, "right", dpr, color, false);
  ctx.restore();
}

/** A scale label; on a dark chip when drawn over an image (the spectrogram). */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  align: "left" | "right",
  dpr: number,
  color: (name: string) => string,
  /** A dark chip behind it, for labels drawn over an image (the spectrogram). */
  chip = true,
) {
  ctx.font = `600 ${11 * dpr}px ui-rounded, -apple-system, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  if (chip) {
    const width = ctx.measureText(text).width;
    const padX = 4 * dpr;
    const boxH = 15 * dpr;
    const left = align === "right" ? x - width - padX : x - padX;
    ctx.fillStyle = "rgba(14, 16, 19, 0.82)";
    ctx.beginPath();
    ctx.roundRect(left, y - boxH / 2, width + 2 * padX, boxH, 4 * dpr);
    ctx.fill();
  }
  ctx.fillStyle = color("--curve-label");
  ctx.fillText(text, x, y + 0.5 * dpr);
}

/** The curve's height at every `CURVE_STEP_PX` column across the view (NaN where it has no reading). */
function curvePoints(overlay: Overlay, view: View, h: number, plot: number): number[] {
  const span = view.end - view.start;
  const yAt = overlayY(overlay, h);
  const { t0, hop, values } = overlay.curve;
  const points: number[] = [];
  for (let x = 0; x <= plot; x += CURVE_STEP_PX) {
    const pos = (view.start + (x / plot) * span - t0) / hop;
    const i = Math.floor(pos);
    const a = values[i];
    const b = values[i + 1];
    if (a == null || b == null || i < 0) {
      points.push(a != null && i >= 0 ? yAt(a) : NaN);
      continue;
    }
    points.push(yAt(a + (b - a) * (pos - i)));
  }
  return points;
}

function strokeCurve(
  ctx: CanvasRenderingContext2D,
  points: number[],
  dpr: number,
  color: (name: string) => string,
  /** Draw a dark casing under the curve so it stays visible on bright backgrounds. */
  cased: boolean,
  alpha: number,
) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = "round";
  ctx.beginPath();
  // Missing points (no reading) break the line into separate runs.
  let penDown = false;
  points.forEach((y, k) => {
    if (Number.isNaN(y)) {
      penDown = false;
      return;
    }
    const x = k * CURVE_STEP_PX;
    if (penDown) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    penDown = true;
  });
  if (cased) {
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.lineWidth = 3.5 * dpr;
    ctx.stroke();
  }
  ctx.strokeStyle = color("--curve");
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
  ctx.restore();
}





