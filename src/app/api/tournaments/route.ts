import { NextResponse } from "next/server";
import { createTournament, CreateTournamentInput, runningTournaments } from "@/lib/tournaments/run";
import { checkStart, denied, inflightGames, readJsonBody, startFailed } from "@/lib/guard";
import { listRunning } from "@/lib/live";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const parsed = await readJsonBody(req);
  if ("denial" in parsed) return denied(parsed.denial);
  try {
    const d = checkStart(
      req,
      { kind: "tournament" },
      { games: listRunning().length + inflightGames(), tournaments: runningTournaments() }
    );
    if (d) return denied(d);
    // No await between the check and createTournament's synchronous slot
    // reservation, so the tournament cap holds under concurrent requests.
    const { id } = await createTournament(parsed.body as CreateTournamentInput);
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    return startFailed(err, "Failed to create tournament");
  }
}

export async function GET() {
  const tournaments = await store.listTournaments(50);
  return NextResponse.json({ tournaments });
}
