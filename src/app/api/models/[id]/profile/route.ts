import { NextResponse } from "next/server";
import { assembleProfile } from "@/lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const model = decodeURIComponent(id);
  const profile = await assembleProfile(model);
  if (!profile) {
    return NextResponse.json({ error: "Model not found" }, { status: 404 });
  }
  return NextResponse.json({ profile });
}
