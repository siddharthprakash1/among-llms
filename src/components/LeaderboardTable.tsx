import Link from "next/link";
import { ModelRating, winRate } from "@/lib/elo";
import { cn, modelLabel, pct } from "@/lib/ui";

const MEDALS = ["🥇", "🥈", "🥉"];

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-[var(--panel-2)] overflow-hidden min-w-[40px]">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.round(value * 100)}%`, background: color }}
        />
      </div>
      <span className="text-[11px] text-[var(--muted)] tabular-nums w-9 text-right">
        {pct(value)}
      </span>
    </div>
  );
}

export default function LeaderboardTable({ models }: { models: ModelRating[] }) {
  if (models.length === 0) {
    return (
      <div className="card p-8 text-center text-[var(--muted)]">
        No games played yet. Run a match to put models on the board.
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-[28px_1fr_64px_56px_1fr_1fr] gap-3 px-4 py-3 border-b border-[var(--border)] text-[11px] uppercase tracking-wider text-[var(--muted)] font-semibold">
        <span>#</span>
        <span>Model</span>
        <span className="text-right">ELO</span>
        <span className="text-right">Games</span>
        <span>🐺 Deception</span>
        <span>🏡 Detection</span>
      </div>
      {models.map((m, i) => (
        <div
          key={m.model}
          className={cn(
            "grid grid-cols-[28px_1fr_64px_56px_1fr_1fr] gap-3 px-4 py-3 items-center border-b border-[var(--border)] last:border-0",
            i % 2 ? "bg-[color-mix(in_srgb,var(--panel-2)_40%,transparent)]" : ""
          )}
        >
          <span className="text-sm">{MEDALS[i] ?? i + 1}</span>
          <Link
            href={`/models/${encodeURIComponent(m.model)}`}
            className="font-semibold text-sm truncate link !text-[var(--text)] hover:!text-[var(--gold)]"
          >
            {modelLabel(m.model)}
          </Link>
          <span className="text-right font-bold text-[var(--gold)] tabular-nums">{m.elo}</span>
          <span className="text-right text-sm text-[var(--muted)] tabular-nums">{m.games}</span>
          <Bar value={winRate(m.asWolf)} color="var(--evil)" />
          <Bar value={winRate(m.asVillage)} color="var(--good)" />
        </div>
      ))}
    </div>
  );
}
