import { NextResponse } from "next/server";
import { listModels } from "@/lib/agents/registry";
import { describeGuard } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const models = listModels();
  return NextResponse.json({ models, guard: describeGuard(req, models.map((m) => m.id)) });
}
