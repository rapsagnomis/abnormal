import type { CSSProperties } from "react";
/** Placeholder rows while a search or match runs: a shimmer where results will appear. */
export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <ol className="matches skeleton" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="skeleton-row" style={{ "--i": i } as CSSProperties} />
      ))}
    </ol>
  );
}
