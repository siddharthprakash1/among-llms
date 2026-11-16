import { NextResponse } from "next/server";
import { buildConfig, createGame, recentGames, CreateGameInput } from "@/lib/games";
import { checkStart, denied, inflightGames, readJsonBody, startFailed, trackGame } from "@/lib/guard";
import { listRunning } from "@/lib/live";
import { runningTournaments } from "@/lib/tournaments/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get("limit") ?? 24);
  const summaries = await recentGames(Number.isFinite(limit) ? limit : 24);
  return NextResponse.json({ games: summaries });
}

export async function POST(req: Request) {
  const parsed = await readJsonBody(req);
  if ("denial" in parsed) return denied(parsed.denial);
  const input = parsed.body as CreateGameInput;
  try {
    // Classified on the normalized config: exactly the seats the brain factory will see.
    const d = checkStart(
      req,
      { kind: "game", seatModels: buildConfig(input).seatModels },
      { games: listRunning().length + inflightGames(), tournaments: runningTournaments() }
    );
    if (d) return denied(d);
    const transcript = await trackGame(createGame(input));
    return NextResponse.json({ id: transcript.id, transcript }, { status: 201 });
  } catch (err) {
    return startFailed(err, "Failed to create game");
  }
}
