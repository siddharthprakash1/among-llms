import { NextResponse } from "next/server";
import { createLiveGame, CreateGameInput } from "@/lib/games";
import { listRunning } from "@/lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Start a live game — returns immediately with the id; simulation runs in the
// background and streams over /api/games/[id]/stream.
export async function POST(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const { id } = createLiveGame((body ?? {}) as CreateGameInput);
  return NextResponse.json({ id, live: true }, { status: 202 });
}

// List currently-running live games (for the home page's live rail).
export async function GET() {
  const games = listRunning().map((g) => ({
    id: g.id,
    createdAt: g.createdAt,
    numPlayers: g.config.numPlayers,
    models: Array.from(new Set(g.players.map((p) => p.model))),
    day: g.events.filter((e) => e.kind === "phase").at(-1)?.day ?? 0,
  }));
  return NextResponse.json({ games });
}
