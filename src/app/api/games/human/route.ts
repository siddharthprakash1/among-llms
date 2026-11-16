import { createHumanGame, CreateHumanGameInput } from "@/lib/games";
import { MAX_CREATE_BODY_BYTES, buildSeatCookie } from "@/lib/human/seat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only well-typed fields survive: buildConfig assumes arrays where it expects them. */
function readInput(body: unknown): CreateHumanGameInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const b = body as Record<string, unknown>;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  return {
    numPlayers: typeof b.numPlayers === "number" ? b.numPlayers : undefined,
    seatModels: strings(b.seatModels),
    disabledRoles: strings(b.disabledRoles),
    role: typeof b.role === "string" ? b.role : undefined,
  };
}

// Start a live game with one human seat. The seat token travels only in an
// HttpOnly cookie scoped to this game's seat routes: no seed, role or token in the body.
export async function POST(req: Request) {
  // A JSON content type forces a CORS preflight, so another site cannot start
  // games here and use up the running-games cap.
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Expected application/json" }, { status: 415 });
  }
  if (Number(req.headers.get("content-length") ?? 0) > MAX_CREATE_BODY_BYTES) {
    return Response.json({ error: "Body too large" }, { status: 413 });
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_CREATE_BODY_BYTES) {
    return Response.json({ error: "Body too large" }, { status: 413 });
  }
  let body: unknown = {};
  try {
    body = JSON.parse(raw);
  } catch {
    body = {};
  }
  let result: ReturnType<typeof createHumanGame>;
  try {
    result = createHumanGame(readInput(body));
  } catch {
    return Response.json({ error: "Those game settings are not valid." }, { status: 400 });
  }
  if ("error" in result) {
    return Response.json(
      { error: "Too many human games are running. Try again in a minute." },
      { status: 429 }
    );
  }
  const secure =
    new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return Response.json(
    { id: result.id },
    { status: 201, headers: { "set-cookie": buildSeatCookie(result.id, result.token, secure) } }
  );
}
