import { NextResponse } from "next/server";
import { listModels } from "@/lib/agents/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ models: listModels() });
}
