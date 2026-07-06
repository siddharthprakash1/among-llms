// Pure inline-SVG ELO trend line. No deps, no state — just maps a history of
// ELO snapshots onto a width-normalized polyline.

import { EloHistoryEntry } from "@/lib/elo";

const DEFAULT_WIDTH = 240;
const DEFAULT_HEIGHT = 48;

/**
 * Compute the SVG `points` attribute string for a polyline plotting
 * `history[i].elo` across `width` x `height`. Pure — exported so it can be
 * unit-tested without rendering.
 *
 * - 0 entries: empty string (nothing to plot).
 * - 1 entry: a single flat point in the vertical middle, at x=0 and x=width
 *   (a degenerate two-point line) so a single-game history still renders.
 * - 2+ entries: x is spread evenly from 0 to width; y is normalized against
 *   the min/max elo in the series (min -> bottom, max -> top), flipped
 *   because SVG y grows downward.
 */
export function sparklinePoints(history: EloHistoryEntry[], width: number, height: number): string {
  const n = history.length;
  if (n === 0) return "";
  if (n === 1) {
    const y = height / 2;
    return `0,${y} ${width},${y}`;
  }

  const elos = history.map((h) => h.elo);
  const min = Math.min(...elos);
  const max = Math.max(...elos);
  const span = max - min || 1;

  return elos
    .map((elo, i) => {
      const x = (i / (n - 1)) * width;
      const y = height - ((elo - min) / span) * height;
      return `${x},${y}`;
    })
    .join(" ");
}

export default function EloSparkline({
  history,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
}: {
  history: EloHistoryEntry[];
  width?: number;
  height?: number;
}) {
  if (history.length < 2) {
    return (
      <div className="text-xs text-[var(--muted)]" style={{ height }}>
        Not enough games yet for a rating trend.
      </div>
    );
  }

  const points = sparklinePoints(history, width, height);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ height }}
      preserveAspectRatio="none"
      role="img"
      aria-label="ELO rating trend"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--gold)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
