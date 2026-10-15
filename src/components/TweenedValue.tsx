import { mixNumber, useTween } from "../lib/motion";

/** A value that counts to its new reading instead of jumping. */
export function TweenedValue({ value, show }: { value: number | null; show: (v: number | null) => string }) {
  const shown = useTween(value, mixNumber, 260, String(value));
  return <>{show(shown)}</>;
}
