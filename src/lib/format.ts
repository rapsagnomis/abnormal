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
export function tickStep(duration: number, widthPx: number, minPx = 70): number {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const secPerPx = duration / Math.max(widthPx, 1);
  return steps.find((s) => s / secPerPx >= minPx) ?? steps[steps.length - 1];
}
