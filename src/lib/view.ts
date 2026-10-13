/** Visible time window of a waveform, in seconds. */
export interface View {
  start: number;
  end: number;
}

/** Narrowest zoom: 20 ms across the lane, already well past one sample per pixel. */
export const MIN_SPAN = 0.02;

export const fullView = (duration: number): View => ({ start: 0, end: duration });

/** Keep the span within [MIN_SPAN, duration] and the window inside the track. */
export function clampView(v: View, duration: number): View {
  const span = Math.min(Math.max(v.end - v.start, MIN_SPAN), duration);
  const start = Math.min(Math.max(v.start, 0), Math.max(duration - span, 0));
  return { start, end: start + span };
}

/** Zoom by `factor` (<1 zooms in) keeping time `anchor` at the same place on screen. */
export function zoomView(v: View, factor: number, anchor: number, duration: number): View {
  const span = v.end - v.start;
  const frac = span > 0 ? (anchor - v.start) / span : 0.5;
  const next = Math.min(Math.max(span * factor, MIN_SPAN), duration);
  return clampView({ start: anchor - frac * next, end: anchor - frac * next + next }, duration);
}

export function panView(v: View, deltaSeconds: number, duration: number): View {
  return clampView({ start: v.start + deltaSeconds, end: v.end + deltaSeconds }, duration);
}

export const isFull = (v: View, duration: number) => v.end - v.start >= duration - 1e-9;
