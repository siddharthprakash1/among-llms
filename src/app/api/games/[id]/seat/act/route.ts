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
  // Refused on the declared length first, so an oversize body is never buffered.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_ACT_BODY_BYTES) {
    return Response.json({ error: "Body too large" }, { status: 413 });
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_ACT_BODY_BYTES) {
    return Response.json({ error: "Body too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Malformed JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
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
