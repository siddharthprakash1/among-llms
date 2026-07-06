import Link from "next/link";
import { notFound } from "next/navigation";
import { leaderboard, recentGames } from "@/lib/games";
import { winRate } from "@/lib/elo";
import { modelLabel, pct, relativeTime } from "@/lib/ui";

export const dynamic = "force-dynamic";

function Sparkline({ elos }: { elos: number[] }) {
  if (elos.length < 2) {
    return <div className="text-sm text-[var(--muted)]">Not enough games yet for a rating trend.</div>;
  }
  const W = 520;
  const H = 90;
  const min = Math.min(...elos);
  const max = Math.max(...elos);
  const span = max - min || 1;
  const pts = elos
    .map((e, i) => `${(i / (elos.length - 1)) * W},${H - ((e - min) / span) * H}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 90 }} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke="var(--gold)" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wider text-[var(--muted)] font-semibold">{label}</div>
      <div className="display text-3xl mt-1" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
    </div>
  );
}

export default async function ModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const model = decodeURIComponent(id);
  const board = await leaderboard();
  const r = board[model];
  if (!r) notFound();

  const games = (await recentGames(200)).filter((g) => g.models.includes(model)).slice(0, 12);
  const elos = [1000, ...(r.history ?? []).map((h) => h.elo)];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/leaderboard" className="link text-sm">
          ← Leaderboard
        </Link>
        <h1 className="display text-4xl sm:text-5xl mt-1">{modelLabel(model)}</h1>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Stat label="ELO" value={String(r.elo)} tone="var(--gold)" />
        <Stat label="Games" value={String(r.games)} />
        <Stat label="Win rate" value={pct(r.games ? r.wins / r.games : 0)} />
        <Stat label="🐺 Deception" value={pct(winRate(r.asWolf))} tone="var(--evil)" />
        <Stat label="🏡 Detection" value={pct(winRate(r.asVillage))} tone="var(--good)" />
      </div>

      <div className="card p-5">
        <div className="display text-xl mb-3">Rating history</div>
        <Sparkline elos={elos} />
        <div className="flex justify-between text-xs text-[var(--muted)] mt-1">
          <span>start 1000</span>
          <span>now {r.elo}</span>
        </div>
      </div>

      {r.asJester.games > 0 && (
        <div className="card p-4 text-sm">
          🃏 As the Jester: <span className="font-semibold">{r.asJester.wins}</span> /{" "}
          {r.asJester.games} games won by getting lynched ({pct(winRate(r.asJester))}).
        </div>
      )}

      <div>
        <h2 className="display text-2xl mb-3">Recent games</h2>
        {games.length === 0 ? (
          <div className="card p-8 text-center text-[var(--muted)]">No games recorded yet.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {games.map((g) => (
              <Link
                key={g.id}
                href={`/game/${g.id}`}
                className="card p-4 hover:border-[var(--gold)] transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="display text-lg">
                    {g.winner === "good" ? "🏡 Village" : g.winner === "evil" ? "🐺 Wolves" : "🃏 Jester"}
                  </span>
                  <span className="text-xs text-[var(--muted)]">{relativeTime(g.createdAt)}</span>
                </div>
                <div className="text-xs text-[var(--muted)] mt-2">
                  {g.numPlayers} players · {g.days} days
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
