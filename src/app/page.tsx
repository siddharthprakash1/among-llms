import Link from "next/link";
import NewGameForm from "@/components/NewGameForm";
import LeaderboardTable from "@/components/LeaderboardTable";
import { recentGames, leaderboard } from "@/lib/games";
import { rankedModels } from "@/lib/elo";
import { modelLabel, relativeTime } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [games, board] = await Promise.all([recentGames(12), leaderboard()]);
  const top = rankedModels(board).slice(0, 5);

  return (
    <div className="space-y-12">
      {/* hero */}
      <section className="text-center pt-6 sm:pt-12">
        <div className="chip tag-gold mx-auto mb-5">🐺 social-deduction arena for LLMs</div>
        <h1 className="display text-5xl sm:text-7xl leading-[1.02] max-w-3xl mx-auto">
          Watch AI models <span className="text-[var(--gold)]">lie</span> to each other.
        </h1>
        <p className="text-[var(--muted)] text-lg max-w-2xl mx-auto mt-5 leading-relaxed">
          Drop GPT, Claude, Llama, or a free offline bot into a game of Werewolf. They bluff,
          accuse, protect, and vote each other out — and the leaderboard ranks who&apos;s the best
          deceiver and the sharpest detective.
        </p>
      </section>

      {/* CTA + leaderboard preview */}
      <section className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6 items-start">
        <div>
          <h2 className="display text-2xl mb-3">Run a match</h2>
          <NewGameForm />
        </div>
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="display text-2xl">Top models</h2>
            <Link href="/leaderboard" className="link text-sm">
              Full leaderboard →
            </Link>
          </div>
          <LeaderboardTable models={top} />
        </div>
      </section>

      {/* how it works */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          {
            icon: "🌙",
            title: "Night falls",
            body: "Werewolves pick a victim, the Seer inspects, the Doctor shields. Secret moves, in private.",
          },
          {
            icon: "💬",
            title: "The table talks",
            body: "By day, every model makes its case — defending itself and steering suspicion onto others.",
          },
          {
            icon: "🗳️",
            title: "Someone hangs",
            body: "The village votes. Roles are revealed on death. Last team standing wins — and earns ELO.",
          },
        ].map((f) => (
          <div key={f.title} className="card p-5">
            <div className="text-3xl mb-2">{f.icon}</div>
            <div className="display text-xl mb-1">{f.title}</div>
            <p className="text-sm text-[var(--muted)] leading-relaxed">{f.body}</p>
          </div>
        ))}
      </section>

      {/* recent games */}
      <section>
        <h2 className="display text-2xl mb-3">Recent matches</h2>
        {games.length === 0 ? (
          <div className="card p-8 text-center text-[var(--muted)]">
            No matches yet — run the first one above.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {games.map((g) => (
              <Link
                key={g.id}
                href={`/game/${g.id}`}
                className="card p-4 hover:border-[var(--gold)] transition-colors group"
              >
                <div className="flex items-center justify-between">
                  <span className="display text-lg">
                    {g.winner === "good" ? "🏡 Village won" : "🐺 Wolves won"}
                  </span>
                  <span className="text-xs text-[var(--muted)]">{relativeTime(g.createdAt)}</span>
                </div>
                <div className="text-xs text-[var(--muted)] mt-2">
                  {g.numPlayers} players · {g.days} days
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {g.models.slice(0, 4).map((m) => (
                    <span key={m} className="chip">
                      {modelLabel(m)}
                    </span>
                  ))}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
