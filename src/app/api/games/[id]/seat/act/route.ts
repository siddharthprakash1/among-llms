import { checkAct, denied, readJsonBody } from "@/lib/guard";
import { MAX_ACT_BODY_BYTES, resumeSeat, submitAnswer, verifySeat } from "@/lib/human/seat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Submit the seat's decision for the pending prompt, or take the seat back from
// autopilot. SameSite=Strict on the cookie plus the JSON content-type requirement
// is the CSRF defence.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const v = verifySeat(id, req.headers.get("cookie"));
  if (!v.ok) {
    return Response.json(
      { error: v.status === 401 ? "This seat belongs to another browser." : "Game not found" },
      { status: v.status }
    );
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Expected application/json" }, { status: 415 });
  }
  // Only after the seat check, so the guard can add a refusal but never stand
  // in for the token. Flood limit only: this game was admitted when it started.
  const flood = checkAct(req);
  if (flood) return denied(flood);
  // Refused on the declared length first, and never buffered past the cap.
  const parsed = await readJsonBody(req, MAX_ACT_BODY_BYTES);
  if ("denial" in parsed) return denied(parsed.denial, "Body too large");
  if (parsed.malformed) {
    return Response.json(
      { error: parsed.reason === "json" ? "Malformed JSON" : "Body must be a JSON object" },
      { status: 400 }
    );
  }
  const body = parsed.body;
  if ((body as { resume?: unknown }).resume === true) {
    resumeSeat(id);
    return Response.json({ ok: true });
  }
  if (v.game.status !== "running") {
    return Response.json({ error: "The game is over" }, { status: 409 });
  }
  const result = submitAnswer(id, body);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ ok: true });
}
