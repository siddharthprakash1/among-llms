import { seatMeta, verifySeat } from "@/lib/human/seat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Seat probe for the play page (EventSource hides status codes).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const v = verifySeat(id, req.headers.get("cookie"));
  if (!v.ok) {
    return Response.json(
      { error: v.status === 401 ? "This seat belongs to another browser." : "Game not found" },
      { status: v.status }
    );
  }
  return Response.json({ meta: seatMeta(v.game) });
}
