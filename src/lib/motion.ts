import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** One-shot animations for state changes (Web Animations, so nothing re-renders or remounts). */

export const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Play `keyframes` on `el` once, unless the user asked for reduced motion. */
export function flash(el: Element | null, keyframes: Keyframe[], duration = 260) {
  if (!el || reduced()) return;
  el.animate(keyframes, { duration, easing: "ease-out" });
}

/** Content swapped under the same frame (e.g. the panel now shows another pair): fade it back in. */
export const FADE_IN: Keyframe[] = [{ opacity: 0.35 }, { opacity: 1 }];

/** A control whose value changed on its own: a brief ring. */
export const RING: Keyframe[] = [
  { boxShadow: "0 0 0 3px rgba(91, 141, 239, 0.6)" },
  { boxShadow: "0 0 0 0 rgba(91, 141, 239, 0)" },
];

/**
 * `target`, eased in over `duration` ms whenever its content changes (`mix` blends two values at
 * 0–1). Changes are detected by `key` (default: the JSON of `target`), so a value rebuilt on every
 * render doesn't restart the animation.
 */
export function useTween<T>(target: T, mix: (from: T, to: T, t: number) => T, duration = 240, key?: string): T {
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  const latest = useRef(target);
  latest.current = target;
  const signature = key ?? JSON.stringify(target);
  useEffect(() => {
    const to = latest.current;
    const from = current.current;
    if (reduced()) {
      current.current = to;
      setShown(to);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      const v = t >= 1 ? to : mix(from, to, eased);
      current.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return shown;
}

/** Blend two numbers; a missing end (no reading) switches at once. */
export const mixNumber = (a: number | null, b: number | null, t: number) => (a === null || b === null ? b : a + (b - a) * t);

/** Blend two curves point by point; a different length or a missing curve switches at once. */
export const mixCurve = (a: (number | null)[] | null, b: (number | null)[] | null, t: number) =>
  !a || !b || a.length !== b.length ? b : b.map((v, i) => mixNumber(a[i], v, t));

/** A row something was just loaded from: a brief tint. */
export const LOADED_ROW: Keyframe[] = [{ backgroundColor: "rgba(91, 141, 239, 0.2)" }, { backgroundColor: "rgba(91, 141, 239, 0)" }];

/**
 * Reordering without jumps (FLIP): after each change of `deps`, children of `container` that carry
 * a `data-key` and were already there glide from their old position to the new one. New children
 * are left to their own entrance animation.
 */
export function useFlip(container: RefObject<HTMLElement | null>, deps: unknown[]) {
  const last = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const next = new Map<string, number>();
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const key = child.dataset.key;
      if (!key) continue;
      const top = child.getBoundingClientRect().top;
      next.set(key, top);
      const before = last.current.get(key);
      if (before !== undefined && Math.abs(before - top) > 1 && !reduced()) {
        child.animate([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], {
          duration: 300,
          easing: "cubic-bezier(0.3, 0.7, 0.3, 1)",
        });
      }
    }
    last.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
