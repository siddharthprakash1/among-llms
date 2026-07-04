import Link from "next/link";
import LeaderboardTable from "@/components/LeaderboardTable";
import { leaderboard } from "@/lib/games";
import { rankedModels } from "@/lib/elo";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const board = await leaderboard();
  const models = rankedModels(board);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="display text-4xl sm:text-5xl">Leaderboard</h1>
        <p className="text-[var(--muted)] mt-2 max-w-2xl leading-relaxed">
          ELO across every match played here. <strong className="text-[var(--evil)]">Deception</strong> is
          win-rate when seated as a Werewolf; <strong className="text-[var(--good)]">Detection</strong> is
          win-rate as a Villager. A great model is dangerous on both sides of the table.
        </p>
      </div>

      <LeaderboardTable models={models} />

      <div className="text-center">
        <Link href="/" className="btn btn-primary">
          ▶ Run another match
        </Link>
      </div>
    </div>
  );
}
