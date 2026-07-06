import { NextResponse } from "next/server";
import { createTournament, CreateTournamentInput } from "@/lib/tournaments/run";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  try {
    const { id } = await createTournament((body ?? {}) as CreateTournamentInput);
    return NextResponse.json({ id }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create tournament";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function GET() {
  const tournaments = await store.listTournaments(50);
  return NextResponse.json({ tournaments });
}
