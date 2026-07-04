import { NextResponse } from "next/server";
import { leaderboard } from "@/lib/games";
import { rankedModels } from "@/lib/elo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const board = await leaderboard();
  return NextResponse.json({ models: rankedModels(board) });
}
