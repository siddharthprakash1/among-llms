import { buildConfig, createHumanGame, CreateHumanGameInput } from "@/lib/games";
import { checkStart, denied, inflightGames, readJsonBody, type Denial } from "@/lib/guard";
import {
  MAX_CREATE_BODY_BYTES,
  MAX_RUNNING_HUMAN_GAMES,
  buildSeatCookie,
  runningHumanGames,
} from "@/lib/human/seat";
import { listRunning } from "@/lib/live";
import { runningTournaments } from "@/lib/tournaments/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HUMAN_CAP: Denial = {
  status: 429,
  code: "busy",
  error: "Too many human games are running. Try again in a minute.",
  retryAfterSec: 30,
};

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
  const parsed = await readJsonBody(req, MAX_CREATE_BODY_BYTES);
  if ("denial" in parsed) return denied(parsed.denial, "Body too large");
  const input = readInput(parsed.body);
  let result: ReturnType<typeof createHumanGame>;
  try {
    // Before checkStart, which charges the rate limit and the daily budget: a
    // start refused by the human cap must cost nothing. Nothing awaits between
    // this, checkStart and createHumanGame, so the cap cannot be raced.
    if (runningHumanGames() >= MAX_RUNNING_HUMAN_GAMES) return denied(HUMAN_CAP);
    // The same guard as every other start. The bot seats are classified, so a
    // human game cannot be a way to seat real models without the admin token.
    const d = checkStart(
      req,
      {
        kind: "game",
        seatModels: buildConfig({
          numPlayers: input.numPlayers,
          seatModels: input.seatModels,
          disabledRoles: input.disabledRoles,
        }).seatModels,
      },
      { games: listRunning().length + inflightGames(), tournaments: runningTournaments() }
    );
    if (d) return denied(d);
    result = createHumanGame(input);
  } catch {
    return Response.json({ error: "Those game settings are not valid." }, { status: 400 });
  }
  if ("error" in result) return denied(HUMAN_CAP);
  const secure =
    new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return Response.json(
    { id: result.id },
    { status: 201, headers: { "set-cookie": buildSeatCookie(result.id, result.token, secure) } }
  );
}
