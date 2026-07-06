import Link from "next/link";
import NewTournamentForm from "@/components/NewTournamentForm";
import { store } from "@/lib/store";
import { cn } from "@/lib/ui";

export const dynamic = "force-dynamic";

export default async function TournamentsPage() {
  const tournaments = await store.listTournaments(30);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="display text-4xl sm:text-5xl">Tournaments</h1>
        <p className="text-[var(--muted)] mt-2 max-w-2xl leading-relaxed">
          Pit a roster of models against each other in a round-robin season or a knockout bracket.
          Every game counts toward the global leaderboard.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6 items-start">
        <div>
          <h2 className="display text-2xl mb-3">New tournament</h2>
          <NewTournamentForm />
        </div>
        <div>
          <h2 className="display text-2xl mb-3">Recent</h2>
          {tournaments.length === 0 ? (
            <div className="card p-8 text-center text-[var(--muted)]">
              No tournaments yet — start one.
            </div>
          ) : (
            <div className="space-y-2">
              {tournaments.map((t) => (
                <Link
                  key={t.id}
                  href={`/tournaments/${t.id}`}
                  className="card p-4 flex items-center justify-between hover:border-[var(--gold)] transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{t.name}</div>
                    <div className="text-xs text-[var(--muted)] mt-0.5">
                      {t.format === "round_robin" ? "Round robin" : "Knockout"} · {t.roster.length} models
                    </div>
                  </div>
                  <span
                    className={cn(
                      "chip",
                      t.status === "running" && "tag-evil",
                      t.status === "finished" && "tag-good"
                    )}
                  >
                    {t.status}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
