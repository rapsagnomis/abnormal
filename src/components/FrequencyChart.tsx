import { useEffect, useRef, useState } from "react";
import { mixCurve, useTween } from "../lib/motion";

export interface FrequencySeries {
  label: string;
  color: string;
  /** One value per entry of `freqs`; null = no reading (gap). */
  values: (number | null)[] | null;
  /** Dashed line: a second cue besides colour. */
  dashed?: boolean;
  /** Changes constantly (the live analyser): drawn lighter and kept out of the y range, so the
   *  axes stay put while it moves. */
  live?: boolean;
}

interface Props {
  title: string;
  unit: string;
  freqs: number[];
  series: FrequencySeries[];
  /** Draw a solid line at 0 (difference / ratio charts). */
  zeroLine?: boolean;
  /** Keep the y range symmetric around 0. */
  symmetric?: boolean;
  /** Smallest y span, so near-flat data isn't blown up to fill the chart. */
  minSpan: number;
  height?: number;
}

const M = { top: 6, right: 8, bottom: 18, left: 30 };
const F_MIN = 20;
const F_MAX = 20000;
const F_TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];

const fmtHz = (f: number) => (f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`);

/** Lines over a log-frequency axis, sharing one y axis. */
export function FrequencyChart({ title, unit, freqs, series, zeroLine, symmetric, minSpan, height = 140 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, []);

  // Curves (and with them the y range) glide to new data: another pair, selection or EQ choice.
  const curves = useTween(
    series.map((s) => s.values),
    (from, to, t) => to.map((v, i) => mixCurve(from[i] ?? null, v, t)),
    280,
  );
  const present = series.map((s, i) => ({ ...s, values: curves[i] ?? s.values })).filter((s) => s.values);
  const all = present.filter((s) => !s.live).flatMap((s) => s.values!.filter((v, i): v is number => v !== null && freqs[i] >= 30 && freqs[i] <= 18000));

  const header = (
    <div className="chart-header">
      <span className="chart-title">{title}</span>
      {series.length > 1 && (
        <span className="legend">
          {series.map((s) => (
            <span key={s.label} className="legend-item">
              <i className={s.dashed ? "dashed-swatch" : undefined} style={{ background: s.dashed ? undefined : s.color, color: s.color }} />
              {s.label}
            </span>
          ))}
        </span>
      )}
    </div>
  );
  if (all.length === 0) {
    return (
      <div ref={ref} className="chart">
        {header}
        <div className="chart-empty">No data</div>
      </div>
    );
  }

  // y range: data extent rounded out to 3 dB, at least `minSpan` tall.
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (symmetric) {
    const m = Math.max(Math.abs(lo), Math.abs(hi), minSpan / 2);
    [lo, hi] = [-m, m];
  } else if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    [lo, hi] = [mid - minSpan / 2, mid + minSpan / 2];
  }
  const yStep = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / yStep) * yStep;
  hi = Math.ceil(hi / yStep) * yStep;

  const plotW = Math.max(width - M.left - M.right, 1);
  const plotH = height - M.top - M.bottom;
  const x = (f: number) => M.left + (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * plotW;
  const y = (v: number) => M.top + ((hi - Math.min(hi, Math.max(lo, v))) / (hi - lo)) * plotH;

  const path = (values: (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null || freqs[i] < F_MIN || freqs[i] > F_MAX) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(freqs[i]).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const yTicks: number[] = [];
  for (let t = lo; t <= hi + 1e-9; t += yStep) yTicks.push(+t.toFixed(6));

  const onMove = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < M.left || px > M.left + plotW) return setHover(null);
    const f = F_MIN * Math.pow(F_MAX / F_MIN, (px - M.left) / plotW);
    let best = 0;
    freqs.forEach((g, i) => {
      if (Math.abs(Math.log(g / f)) < Math.abs(Math.log(freqs[best] / f))) best = i;
    });
    setHover(best);
  };

  return (
    <div ref={ref} className="chart">
      {header}
      <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={title}>
        {yTicks.map((t) => (
          <g key={t}>
            <line className={zeroLine && t === 0 ? "zero" : "grid"} x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} />
            <text className="tick" x={M.left - 4} y={y(t)} textAnchor="end" dominantBaseline="middle">
              {t > 0 && symmetric ? `+${t}` : t}
            </text>
          </g>
        ))}
        {F_TICKS.map((f) => (
          <g key={f}>
            <line className="grid" x1={x(f)} x2={x(f)} y1={M.top} y2={M.top + plotH} />
            <text className="tick" x={x(f)} y={height - 4} textAnchor="middle">
              {fmtHz(f)}
            </text>
          </g>
        ))}
        {present.map((s) => (
          <path
            key={s.label}
            d={path(s.values!)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.live ? 1.5 : 2}
            strokeOpacity={s.live ? 0.8 : 1}
            strokeDasharray={s.dashed ? "5 4" : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {hover !== null && (
          <>
            <line className="crosshair" x1={x(freqs[hover])} x2={x(freqs[hover])} y1={M.top} y2={M.top + plotH} />
            {present.map((s) => {
              const v = s.values![hover];
              return v === null ? null : (
                <circle key={s.label} cx={x(freqs[hover])} cy={y(v)} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />
              );
            })}
          </>
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tooltip" style={{ left: x(freqs[hover]) > width / 2 ? M.left + 70 : width - 70 }}>
          <div className="tooltip-range">{fmtHz(freqs[hover])} Hz</div>
          {series.map((s) => {
            const v = s.values?.[hover] ?? null;
            return (
              <div key={s.label} className="tooltip-row">
                <i style={{ background: s.color }} />
                {s.label}
                <span>{v === null ? "—" : `${v > 0 && symmetric ? "+" : ""}${v.toFixed(1)} ${unit}`}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function niceStep(raw: number) {
  return [1, 2, 3, 5, 6, 10, 12, 20, 30].find((s) => s >= raw) ?? 30;
}
