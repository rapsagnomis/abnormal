import { useEffect, useRef, useState } from "react";
import type { Histogram } from "../lib/api";

export interface HistogramSeries {
  label: string;
  /** CSS colour for the mark (a validated chart token). */
  color: string;
  histogram: Histogram | null;
  /** Optional marker drawn as a dashed vertical line (e.g. the median). */
  marker: number | null;
}

interface Props {
  title: string;
  unit: string;
  series: HistogramSeries[];
  /** Fixed x range to show; trimmed further to where there is data. */
  domain: [number, number];
  /** Smallest span the x axis may shrink to when trimming. */
  minSpan: number;
  markerLabel: string;
}

const HEIGHT = 128;
const M = { top: 6, right: 8, bottom: 18, left: 30 };

/** Overlaid step-line histograms on one shared axis (fraction of time per bin). */
export function HistogramChart({ title, unit, series, domain, minSpan, markerLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverBin, setHoverBin] = useState<number | null>(null);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);

  const present = series.filter((s) => s.histogram);
  const ref0 = present[0]?.histogram;
  if (!ref0) {
    return (
      <div ref={ref} className="chart">
        <div className="chart-title">{title}</div>
        <div className="chart-empty">No data</div>
      </div>
    );
  }
  const { min, step } = ref0;

  // Trim the x range to the bins that hold data (with a little padding), within `domain`.
  let lo = domain[1];
  let hi = domain[0];
  for (const s of present) {
    s.histogram!.fractions.forEach((f, i) => {
      if (f > 0) {
        lo = Math.min(lo, min + i * step);
        hi = Math.max(hi, min + (i + 1) * step);
      }
    });
  }
  lo = Math.max(domain[0], Math.floor((lo - 2 * step) / step) * step);
  hi = Math.min(domain[1], Math.ceil((hi + 2 * step) / step) * step);
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = Math.max(domain[0], mid - minSpan / 2);
    hi = Math.min(domain[1], lo + minSpan);
  }

  const maxFrac = Math.max(...present.flatMap((s) => s.histogram!.fractions), 0.01);
  const yMax = niceCeil(maxFrac);
  const plotW = Math.max(width - M.left - M.right, 1);
  const plotH = HEIGHT - M.top - M.bottom;
  const x = (v: number) => M.left + ((v - lo) / (hi - lo)) * plotW;
  const y = (f: number) => M.top + plotH - (f / yMax) * plotH;

  const stepPath = (h: Histogram) => {
    let d = "";
    let started = false;
    h.fractions.forEach((f, i) => {
      const x0 = h.min + i * h.step;
      const x1 = x0 + h.step;
      if (x1 <= lo || x0 >= hi) return;
      const px0 = x(Math.max(x0, lo));
      const px1 = x(Math.min(x1, hi));
      d += started ? `L${px0},${y(f)}` : `M${px0},${y(0)}L${px0},${y(f)}`;
      d += `L${px1},${y(f)}`;
      started = true;
    });
    return started ? `${d}L${x(Math.min(hi, h.min + h.fractions.length * h.step))},${y(0)}` : "";
  };

  const xTicks = niceTicks(lo, hi, Math.max(2, Math.floor(plotW / 55)));
  const yTicks = [0, yMax / 2, yMax];
  const binAt = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const v = lo + ((clientX - rect.left - M.left) / plotW) * (hi - lo);
    if (v < lo || v >= hi) return null;
    return Math.floor((v - min) / step);
  };
  const hoverX0 = hoverBin !== null ? min + hoverBin * step : null;

  return (
    <div ref={ref} className="chart">
      <div className="chart-header">
        <span className="chart-title">{title}</span>
        <span className="legend">
          {series.map((s) => (
            <span key={s.label} className="legend-item">
              <i style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
          <span className="legend-item">
            <i className="dashed" /> {markerLabel}
          </span>
        </span>
      </div>
      <svg
        width={width}
        height={HEIGHT}
        onPointerMove={(e) => setHoverBin(binAt(e.clientX))}
        onPointerLeave={() => setHoverBin(null)}
        role="img"
        aria-label={title}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line className="grid" x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} />
            <text className="tick" x={M.left - 4} y={y(t)} textAnchor="end" dominantBaseline="middle">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} className="tick" x={x(t)} y={HEIGHT - 4} textAnchor="middle">
            {t}
          </text>
        ))}
        {hoverX0 !== null && (
          <rect
            className="hover-band"
            x={x(hoverX0)}
            width={Math.max(1, x(hoverX0 + step) - x(hoverX0))}
            y={M.top}
            height={plotH}
          />
        )}
        {series.map(
          (s) =>
            s.histogram && (
              <path key={s.label} d={stepPath(s.histogram)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
            ),
        )}
        {series.map(
          (s) =>
            s.marker !== null &&
            s.marker >= lo &&
            s.marker <= hi && (
              <line
                key={`m-${s.label}`}
                x1={x(s.marker)}
                x2={x(s.marker)}
                y1={M.top}
                y2={M.top + plotH}
                stroke={s.color}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            ),
        )}
      </svg>
      {hoverBin !== null && hoverX0 !== null && (
        <div
          className="chart-tooltip"
          // Sit on the side away from the cursor so the tooltip never hides the bins it describes.
          style={{ left: x(hoverX0 + step / 2) > width / 2 ? M.left + 70 : width - 70 }}
        >
          <div className="tooltip-range">
            {fmtNum(hoverX0)} to {fmtNum(hoverX0 + step)} {unit}
          </div>
          {series.map((s) => (
            <div key={s.label} className="tooltip-row">
              <i style={{ background: s.color }} />
              {s.label}
              <span>
                {s.histogram ? `${((s.histogram.fractions[hoverBin] ?? 0) * 100).toFixed(1)}%` : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtNum(v: number) {
  return Number.isInteger(v) ? `${v}` : v.toFixed(1);
}

function niceCeil(v: number) {
  // Maxima whose half is a whole percentage, so the mid tick reads cleanly.
  const steps = [0.02, 0.04, 0.06, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1];
  return steps.find((s) => s >= v) ?? 1;
}

function niceTicks(lo: number, hi: number, count: number) {
  const raw = (hi - lo) / count;
  const step = [1, 2, 5, 10, 20].find((s) => s >= raw) ?? 20;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);
  return ticks;
}
