import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Peaks, Region, Slot } from "../lib/api";
import { formatTime, tickStep } from "../lib/format";
import type { Overlay } from "../lib/overlay";
import type { View } from "../lib/view";
import { isFull, panView, zoomView } from "../lib/view";

interface Props {
  slot: Slot;
  peaks: Peaks;
  duration: number;
  view: View;
  position: number;
  region: Region | null;
  /** Curve drawn over the waveform (loudness, PSR), or null for none. */
  overlay: Overlay | null;
  onSeek: (seconds: number) => void;
  onRegion: (region: Region | null) => void;
  onView: (view: View) => void;
}

/** Pointer movement (px) before a press becomes a region drag instead of a click-to-seek. */
const DRAG_THRESHOLD = 4;
const MIN_REGION_SECONDS = 0.01;

/** Peaks covering [start, end] seconds. The overview spans the whole track. */
interface PeakSource {
  start: number;
  end: number;
  peaks: Peaks;
}

export function Waveform(props: Props) {
  const { slot, peaks, duration, view, position, region, overlay } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Region | null>(null);
  const [detail, setDetail] = useState<PeakSource | null>(null);
  const press = useRef<{ x: number; t: number; dragging: boolean } | null>(null);

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
    const px = Math.round(size.width * (window.devicePixelRatio || 1));
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
  }, [slot, peaks, duration, view.start, view.end, size.width]);

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
    const overview = { start: 0, end: duration, peaks };
    draw(canvas, view, duration, overview, detail, overlay, dpr);
    // view.start/end rather than view: callers may pass a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, duration, view.start, view.end, detail, overlay, size]);

  // Wheel: vertical zooms around the cursor (pinch arrives as ctrl+wheel), horizontal pans.
  useEffect(() => {
    const el = containerRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view: v, duration: d, onView } = latest.current;
      const rect = el.getBoundingClientRect();
      const span = v.end - v.start;
      const horizontal = !e.ctrlKey && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY));
      if (horizontal) {
        const delta = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
        onView(panView(v, (delta / rect.width) * span, d));
      } else {
        const anchor = v.start + ((e.clientX - rect.left) / rect.width) * span;
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
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(view.start + frac * span, duration);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { x: e.clientX, t: timeAt(e.clientX), dragging: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
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

  const shown = draft ?? region;
  const pct = (t: number) => `${((t - view.start) / span) * 100}%`;
  const step = tickStep(span, size.width);
  const firstTick = Math.ceil(view.start / step) * step;
  const ticks: number[] = [];
  for (let t = firstTick; t <= Math.min(view.end, duration) + 1e-9; t += step) ticks.push(t);
  const tickDecimals = step < 1 ? 1 : 0;
  const playheadVisible = position >= view.start && position <= view.end;

  return (
    <div className="waveform">
      <div
        ref={containerRef}
        className="waveform-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => props.onRegion(null)}
      >
        <canvas ref={canvasRef} />
        {shown && shown.end > view.start && shown.start < view.end && (
          <div
            className={`region${draft ? " draft" : ""}`}
            style={{ left: pct(shown.start), width: `${((shown.end - shown.start) / span) * 100}%` }}
          />
        )}
        {playheadVisible && <div className="playhead" style={{ left: pct(position) }} />}
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
  overview: PeakSource,
  detail: PeakSource | null,
  overlay: Overlay | null,
  dpr: number,
) {
  const ctx = canvas.getContext("2d")!;
  const { width: w, height: h } = canvas;
  const style = getComputedStyle(canvas);
  const color = (name: string) => style.getPropertyValue(name).trim();

  ctx.clearRect(0, 0, w, h);
  const mid = h / 2;
  const scale = mid * 0.95;
  const span = view.end - view.start;
  const secPerPx = span / w;

  ctx.fillStyle = color("--wave-axis");
  ctx.fillRect(0, Math.floor(mid), w, 1);

  // A single min/max waveform in one colour: easier to read than layered peak + RMS bodies.
  ctx.fillStyle = color("--wave");
  for (let x = 0; x < w; x++) {
    const t0 = view.start + x * secPerPx;
    const t1 = t0 + secPerPx;
    if (t0 >= duration) break;
    // Prefer detail peaks where they cover this pixel; the overview fills in while they load.
    const src = detail && t0 >= detail.start && t1 <= detail.end + secPerPx ? detail : overview;
    const { peaks } = src;
    const n = peaks.buckets;
    const toBucket = (t: number) => ((t - src.start) / (src.end - src.start)) * n;
    const b0 = Math.max(0, Math.floor(toBucket(t0)));
    const b1 = Math.min(n, Math.max(b0 + 1, Math.floor(toBucket(t1))));
    let lo = 1;
    let hi = -1;
    for (let b = b0; b < b1; b++) {
      if (peaks.min[b] < lo) lo = peaks.min[b];
      if (peaks.max[b] > hi) hi = peaks.max[b];
    }
    if (hi < lo) continue;
    ctx.fillRect(x, mid - hi * scale, 1, Math.max(1, (hi - lo) * scale));
  }

  if (overlay) drawOverlay(ctx, overlay, view, duration, w, h, dpr, color);
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: Overlay,
  view: View,
  duration: number,
  w: number,
  h: number,
  dpr: number,
  color: (name: string) => string,
) {
  const span = view.end - view.start;
  const xAt = (t: number) => ((t - view.start) / span) * w;
  const { top, bottom } = overlay;
  const lo = Math.min(top, bottom);
  const hi = Math.max(top, bottom);
  const yAt = (v: number) => ((top - Math.min(hi, Math.max(lo, v))) / (top - bottom)) * h;
  const xEnd = Math.min(w, xAt(duration));

  ctx.font = `${10 * dpr}px -apple-system, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const g of overlay.grid) {
    const y = Math.round(yAt(g)) + 0.5;
    ctx.fillStyle = color("--curve-grid");
    ctx.fillRect(0, y, xEnd, dpr);
    ctx.fillStyle = color("--curve-label");
    ctx.fillText(`${g}`, w - 4 * dpr, y - 6 * dpr);
  }

  if (overlay.reference !== null) {
    const y = yAt(overlay.reference);
    ctx.save();
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.strokeStyle = color("--curve-integrated");
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(xEnd, y);
    ctx.stroke();
    ctx.restore();
  }

  // Only the points in view (plus one either side so the line reaches the edges).
  const { t0, hop, values } = overlay.curve;
  const i0 = Math.max(0, Math.floor((view.start - t0) / hop) - 1);
  const i1 = Math.min(values.length - 1, Math.ceil((view.end - t0) / hop) + 1);
  if (i1 < i0) return;
  ctx.strokeStyle = color("--curve");
  ctx.lineWidth = 1.5 * dpr;
  ctx.lineJoin = "round";
  ctx.beginPath();
  // Null points (no reading) break the line into separate runs.
  let penDown = false;
  for (let i = i0; i <= i1; i++) {
    const v = values[i];
    if (v === null) {
      penDown = false;
      continue;
    }
    const x = xAt(t0 + i * hop);
    if (penDown) ctx.lineTo(x, yAt(v));
    else ctx.moveTo(x, yAt(v));
    penDown = true;
  }
  ctx.stroke();
}
