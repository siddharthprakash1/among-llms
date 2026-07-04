import { NextResponse } from "next/server";
import { createGame, recentGames } from "@/lib/games";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get("limit") ?? 24);
  const summaries = await recentGames(Number.isFinite(limit) ? limit : 24);
  return NextResponse.json({ games: summaries });
}

export async function POST(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const input = (body ?? {}) as {
    numPlayers?: number;
    seatModels?: string[];
    seed?: number;
  };
  try {
    const transcript = await createGame(input);
    return NextResponse.json({ id: transcript.id, transcript }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create game";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
