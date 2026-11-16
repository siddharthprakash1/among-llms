import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route";
import { __resetLiveForTests, createLive, finishLive } from "@/lib/live";
import { MAX_ACT_BODY_BYTES, makePromptPort, newHumanSeat, newSeatToken, seatCookieName } from "@/lib/human/seat";
import { buildPromptSpec } from "@/lib/human/legal";
import { makeView } from "@/lib/human/testUtil";
import { ALIGNMENT_OF, type GameConfig, type Player, type Role } from "@/lib/engine/types";

const ROLES: Role[] = ["villager", "werewolf", "seer", "doctor", "villager"];
const PLAYERS: Player[] = ROLES.map((role, id) => ({
  id, name: `P${id}`, avatar: "x", model: id === 0 ? "human" : "mock", role, alignment: ALIGNMENT_OF[role], alive: true,
}));
const CONFIG: GameConfig = { numPlayers: 5, seatModels: PLAYERS.map((p) => p.model), seed: 1, dealSeed: 2 };
const AT = "2026-01-01T00:00:00.000Z";

function register(id: string) {
  const { token, hash } = newSeatToken();
  const seat = newHumanSeat(0, "villager", "good", hash);
  createLive(id, AT, CONFIG, PLAYERS, seat);
  return { seat, cookie: `${seatCookieName(id)}=${token}` };
}

function act(id: string, body: unknown, opts: { cookie?: string; type?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.type !== null) headers["content-type"] = opts.type ?? "application/json";
  const req = new Request(`http://test.invalid/api/games/${id}/seat/act`, {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id }) });
}

const vote = { promptId: "1", kind: "target", targetId: 3 };
const ask = (id: string) => makePromptPort(id).ask(buildPromptSpec("vote", makeView("villager")));

beforeEach(() => __resetLiveForTests());

describe("POST /api/games/[id]/seat/act", () => {
  it("404s an unknown game and a bot game", async () => {
    const { cookie } = register("g");
    createLive("bot", AT, CONFIG, PLAYERS);
    expect((await act("nope", vote, { cookie })).status).toBe(404);
    expect((await act("bot", vote, { cookie })).status).toBe(404);
  });

  it("401s a missing or wrong cookie and leaves the prompt open", async () => {
    const { seat } = register("g");
    void ask("g");
    expect((await act("g", vote)).status).toBe(401);
    expect((await act("g", vote, { cookie: `${seatCookieName("g")}=forged` })).status).toBe(401);
    expect(seat.pending?.prompt.id).toBe("1");
  });

  it("415s a non-JSON content type", async () => {
    const { cookie, seat } = register("g");
    void ask("g");
    expect((await act("g", vote, { cookie, type: "text/plain" })).status).toBe(415);
    expect((await act("g", vote, { cookie, type: "application/x-www-form-urlencoded" })).status).toBe(415);
    expect(seat.pending).not.toBeNull();
  });

  it("413s an oversize body", async () => {
    const { cookie } = register("g");
    void ask("g");
    const raw = JSON.stringify({ ...vote, pad: "x".repeat(MAX_ACT_BODY_BYTES) });
    expect((await act("g", null, { cookie, raw })).status).toBe(413);
  });

  it("413s on the declared length before reading the body", async () => {
    const { cookie, seat } = register("g");
    void ask("g");
    const req = new Request("http://test.invalid/api/games/g/seat/act", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "content-length": String(MAX_ACT_BODY_BYTES + 1) },
      body: JSON.stringify(vote),
    });
    expect((await POST(req, { params: Promise.resolve({ id: "g" }) })).status).toBe(413);
    expect(req.bodyUsed).toBe(false);
    expect(seat.pending).not.toBeNull();
  });

  it("400s malformed JSON, a non-object body and an invalid answer", async () => {
    const { cookie, seat } = register("g");
    void ask("g");
    expect((await act("g", null, { cookie, raw: "{not json" })).status).toBe(400);
    expect((await act("g", null, { cookie, raw: "[1,2]" })).status).toBe(400);
    expect((await act("g", null, { cookie, raw: '"text"' })).status).toBe(400);
    const bad = await act("g", { promptId: "1", kind: "target", targetId: 0 }, { cookie });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toHaveProperty("error");
    expect(seat.pending?.prompt.id).toBe("1");
  });

  it("409s a stale prompt, no prompt, and a finished game", async () => {
    const { cookie } = register("g");
    expect((await act("g", vote, { cookie })).status).toBe(409);
    void ask("g");
    expect((await act("g", { ...vote, promptId: "7" }, { cookie })).status).toBe(409);
    finishLive("g", "finished");
    expect((await act("g", vote, { cookie })).status).toBe(409);
  });

  it("accepts a valid answer once and resolves the brain's promise", async () => {
    const { cookie } = register("g");
    const answer = ask("g");
    const res = await act("g", { ...vote, admin: true }, { cookie, type: "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await answer).toEqual({ kind: "target", targetId: 3 });
    expect((await act("g", vote, { cookie })).status).toBe(409);
  });

  it("resumes from autopilot", async () => {
    const { cookie, seat } = register("g");
    seat.autopilot = true;
    seat.missed = 2;
    const res = await act("g", { resume: true }, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seat).toMatchObject({ autopilot: false, missed: 0 });
    expect((await act("g", { resume: true })).status).toBe(401);
  });
});
