import { NextResponse } from "next/server";
import { buildConfig, createLiveGame, CreateGameInput } from "@/lib/games";
import { checkStart, denied, inflightGames, readJsonBody, startFailed } from "@/lib/guard";
import { listRunning } from "@/lib/live";
import { runningTournaments } from "@/lib/tournaments/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start a live game — returns immediately with the id; simulation runs in the
// background and streams over /api/games/[id]/stream.
export async function POST(req: Request) {
  const parsed = await readJsonBody(req);
  if ("denial" in parsed) return denied(parsed.denial);
  const input = parsed.body as CreateGameInput;
  try {
    const d = checkStart(
      req,
      { kind: "game", seatModels: buildConfig(input).seatModels },
      { games: listRunning().length + inflightGames(), tournaments: runningTournaments() }
    );
    if (d) return denied(d);
    // No trackGame: the live registry already counts this game.
    const { id } = createLiveGame(input);
    return NextResponse.json({ id, live: true }, { status: 202 });
  } catch (err) {
    return startFailed(err, "Failed to create game");
  }
}

// List currently-running live games (for the home page's live rail).
export async function GET() {
  const games = listRunning().map((g) => ({
    id: g.id,
    createdAt: g.createdAt,
    numPlayers: g.config.numPlayers,
    models: Array.from(new Set(g.players.map((p) => p.model))),
    day: g.events.filter((e) => e.kind === "phase").at(-1)?.day ?? 0,
    human: Boolean(g.human),
  }));
  return NextResponse.json({ games });
}
