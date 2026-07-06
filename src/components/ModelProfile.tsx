// Server component: renders a model's full profile (header, stat tiles,
// per-role table, head-to-head table, recent games). Pure presentation over
// a `ModelProfile` assembled by `assembleProfile` (src/lib/stats.ts).

import Link from "next/link";
import { ModelProfile as ModelProfileData } from "@/lib/stats";
import { winRate } from "@/lib/elo";
import { cn, modelLabel, pct, relativeTime, ROLE_META } from "@/lib/ui";
import EloSparkline from "./EloSparkline";

/** Percentage, or an em dash when there's nothing to divide (denominator 0). */
function safePct(numerator: number, denominator: number): string {
  return denominator === 0 ? "—" : pct(numerator / denominator);
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wider text-[var(--muted)] font-semibold">{label}</div>
      <div className="display text-3xl mt-1" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
    </div>
  );
}

export default function ModelProfile({ profile }: { profile: ModelProfileData }) {
  const { model, rating, perRole, voteAccuracy, survivalRate, headToHead, recentGames } = profile;

  const roleRows = Object.entries(perRole).sort((a, b) => b[1].games - a[1].games);

  return (
    <div className="space-y-6">
      {/* header */}
      <div>
        <Link href="/leaderboard" className="link text-sm">
          ← Leaderboard
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4 mt-1">
          <div>
            <h1 className="display text-4xl sm:text-5xl">{modelLabel(model)}</h1>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-[var(--muted)] font-semibold">Elo</div>
            <div className="display text-4xl text-[var(--gold)]">{rating.elo}</div>
          </div>
        </div>
        <div className="card p-4 mt-4">
          <EloSparkline history={rating.history} />
        </div>
      </div>

      {/* stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatTile label="Games" value={String(rating.games)} />
        <StatTile label="🐺 Deception" value={safePct(rating.asWolf.wins, rating.asWolf.games)} tone="var(--evil)" />
        <StatTile label="🏡 Detection" value={safePct(rating.asVillage.wins, rating.asVillage.games)} tone="var(--good)" />
        <StatTile label="Vote accuracy" value={safePct(voteAccuracy.hits, voteAccuracy.total)} />
        <StatTile label="Survival" value={safePct(survivalRate.survived, survivalRate.games)} />
      </div>

      {rating.asJester.games > 0 && (
        <div className="card p-4 text-sm">
          🃏 As the Jester: <span className="font-semibold">{rating.asJester.wins}</span> /{" "}
          {rating.asJester.games} games won by getting lynched ({safePct(rating.asJester.wins, rating.asJester.games)}).
        </div>
      )}

      {/* per-role table */}
      <div>
        <h2 className="display text-2xl mb-3">By role</h2>
        {roleRows.length === 0 ? (
          <div className="card p-8 text-center text-[var(--muted)]">No role data yet.</div>
        ) : (
          <div className="card overflow-hidden">
            <div className="grid grid-cols-[1fr_64px_64px_64px] gap-3 px-4 py-3 border-b border-[var(--border)] text-[11px] uppercase tracking-wider text-[var(--muted)] font-semibold">
              <span>Role</span>
              <span className="text-right">Games</span>
              <span className="text-right">Wins</span>
              <span className="text-right">Win %</span>
            </div>
            {roleRows.map(([role, stats], i) => {
              const meta = ROLE_META[role as keyof typeof ROLE_META];
              return (
                <div
                  key={role}
                  className={cn(
                    "grid grid-cols-[1fr_64px_64px_64px] gap-3 px-4 py-3 items-center border-b border-[var(--border)] last:border-0",
                    i % 2 ? "bg-[color-mix(in_srgb,var(--panel-2)_40%,transparent)]" : ""
                  )}
                >
                  <span className="text-sm">
                    {meta ? `${meta.emoji} ${meta.label}` : role}
                  </span>
                  <span className="text-right text-sm tabular-nums">{stats.games}</span>
                  <span className="text-right text-sm tabular-nums">{stats.wins}</span>
                  <span className="text-right text-sm tabular-nums text-[var(--muted)]">
                    {safePct(stats.wins, stats.games)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* head-to-head table */}
      <div>
        <h2 className="display text-2xl mb-3">Head-to-head</h2>
        {headToHead.length === 0 ? (
          <div className="card p-8 text-center text-[var(--muted)]">No opposing matchups recorded yet.</div>
        ) : (
          <div className="card overflow-hidden">
            <div className="grid grid-cols-[1fr_64px_64px_64px] gap-3 px-4 py-3 border-b border-[var(--border)] text-[11px] uppercase tracking-wider text-[var(--muted)] font-semibold">
              <span>Opponent</span>
              <span className="text-right">W</span>
              <span className="text-right">L</span>
              <span className="text-right">Games</span>
            </div>
            {headToHead.map((h, i) => (
              <div
                key={h.opponent}
                className={cn(
                  "grid grid-cols-[1fr_64px_64px_64px] gap-3 px-4 py-3 items-center border-b border-[var(--border)] last:border-0",
                  i % 2 ? "bg-[color-mix(in_srgb,var(--panel-2)_40%,transparent)]" : ""
                )}
              >
                <Link
                  href={`/models/${encodeURIComponent(h.opponent)}`}
                  className="text-sm truncate link !text-[var(--text)] hover:!text-[var(--gold)]"
                >
                  {modelLabel(h.opponent)}
                </Link>
                <span className="text-right text-sm tabular-nums text-[var(--good)]">{h.wins}</span>
                <span className="text-right text-sm tabular-nums text-[var(--evil)]">{h.losses}</span>
                <span className="text-right text-sm tabular-nums text-[var(--muted)]">{h.games}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* recent games */}
      <div>
        <h2 className="display text-2xl mb-3">Recent games</h2>
        {recentGames.length === 0 ? (
          <div className="card p-8 text-center text-[var(--muted)]">No games recorded yet.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {recentGames.map((g) => {
              const meta = ROLE_META[g.role as keyof typeof ROLE_META];
              return (
                <Link
                  key={g.id}
                  href={`/game/${g.id}`}
                  className={cn(
                    "card p-4 hover:border-[var(--gold)] transition-colors",
                    g.won ? "border-l-2 border-l-[var(--good)]" : "border-l-2 border-l-[var(--evil)]"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm">
                      {meta ? `${meta.emoji} ${meta.label}` : g.role} seat
                    </span>
                    <span
                      className={cn("text-sm font-semibold", g.won ? "text-[var(--good)]" : "text-[var(--evil)]")}
                    >
                      {g.won ? "Won" : "Lost"}
                    </span>
                  </div>
                  <div className="text-xs text-[var(--muted)] mt-2">{relativeTime(g.createdAt)}</div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
