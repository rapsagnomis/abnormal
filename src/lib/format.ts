/** 83.456 → "1:23.4" */
export function formatTime(seconds: number, decimals = 1): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0");
  return `${m}:${rest}`;
}

export function formatRate(hz: number): string {
  return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`;
}

export function formatChannels(n: number): string {
  return n === 1 ? "mono" : n === 2 ? "stereo" : `${n} ch`;
}

/** Pick a "nice" ruler tick spacing so labels are at least `minPx` apart. */
/** Ruler steps, seconds, from 10 ms (zoomed right in) to 10 min. */
const TICK_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
/** Subdivision of each ruler step, for the fainter guidelines between ticks. */
const MINOR_OF: Record<number, number> = {
  0.01: 0.002, 0.02: 0.005, 0.05: 0.01, 0.1: 0.02, 0.2: 0.05, 0.5: 0.1, 1: 0.2, 2: 0.5, 5: 1,
  10: 2, 15: 5, 30: 10, 60: 15, 120: 30, 300: 60, 600: 120,
};
export const minorTickStep = (step: number) => MINOR_OF[step] ?? step / 5;

export function tickStep(duration: number, widthPx: number, minPx = 70): number {
  const steps = TICK_STEPS;
  const secPerPx = duration / Math.max(widthPx, 1);
  return steps.find((s) => s / secPerPx >= minPx) ?? steps[steps.length - 1];
}
