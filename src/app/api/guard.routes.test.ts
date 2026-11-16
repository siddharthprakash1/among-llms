import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Nothing here may write to ./data.
vi.mock("@/lib/store", () => ({
  store: {
    saveTranscript: async () => {},
    updateLeaderboard: async () => ({}),
    getTranscript: async () => null,
    listSummaries: async () => [],
    getLeaderboard: async () => ({}),
    saveTournament: async () => {},
    getTournament: async () => null,
    listTournaments: async () => [],
  },
}));
// One configured "real" model, without touching process.env provider keys.
vi.mock("@/lib/agents/registry", async (original) => {
  const real = await original<typeof import("@/lib/agents/registry")>();
  return {
    ...real,
    listModels: () => [...real.listModels(), { id: "gpt-x", label: "gpt-x", provider: "OpenAI", available: true }],
    getProviderConfig: (id: string) =>
      id === "gpt-x" ? { kind: "openai", baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "gpt-x" } : null,
  };
});

import { POST as startGame } from "./games/route";
import { POST as startLive } from "./games/live/route";
import { POST as startHuman } from "./games/human/route";
import { POST as startTournament } from "./tournaments/route";
import { POST as act } from "./games/[id]/seat/act/route";
import { GET as spectate } from "./games/[id]/stream/route";
import { GET as models } from "./models/route";
import { ACTS_PER_START, MAX_BODY_BYTES, guardBuckets, resetGuardState } from "@/lib/guard";
import { __resetLiveForTests, createLive, getLive, listRunning } from "@/lib/live";
import {
  MAX_ACT_BODY_BYTES,
  MAX_CREATE_BODY_BYTES,
  MAX_RUNNING_HUMAN_GAMES,
  makePromptPort,
  newHumanSeat,
  newSeatToken,
  runningHumanGames,
  seatCookieName,
} from "@/lib/human/seat";
import { ALIGNMENT_OF, type GameConfig, type Player, type Role } from "@/lib/engine/types";
import { buildPromptSpec } from "@/lib/human/legal";
import { makeView } from "@/lib/human/testUtil";

const TOKEN = "0123456789abcdef-token";
const BEARER = { authorization: `Bearer ${TOKEN}` };
const ARENA = [
  "ARENA_ADMIN_TOKEN", "ARENA_PUBLIC_MODE", "ARENA_RATE_LIMIT", "ARENA_DAILY_GAMES",
  "ARENA_MAX_GAMES", "ARENA_MAX_TOURNAMENTS", "ARENA_IP_HEADER",
];
let saved: Record<string, string | undefined>;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// The real model sits in a seat the human can never be dealt out of: with five
// seats cycling [mock, gpt-x], two seats are gpt-x.
const BOTS = { numPlayers: 5, seatModels: ["mock"] };
const REAL = { numPlayers: 5, seatModels: ["mock", "gpt-x"] };

// A human game that no simulation drives: the test alone decides when the
// seat is prompted, so nothing depends on how a random deal plays out.
const ROLES: Role[] = ["villager", "werewolf", "seer", "doctor", "villager"];
const PLAYERS: Player[] = ROLES.map((role, id) => ({
  id, name: `P${id}`, avatar: "x", model: id === 0 ? "human" : "mock", role, alignment: ALIGNMENT_OF[role], alive: true,
}));
const CONFIG: GameConfig = { numPlayers: 5, seatModels: PLAYERS.map((p) => p.model), seed: 1, dealSeed: 2 };
function parkedHumanGame(id: string) {
  const { token, hash } = newSeatToken();
  const seat = newHumanSeat(0, "villager", "good", hash);
  createLive(id, "2026-01-01T00:00:00.000Z", CONFIG, PLAYERS, seat);
  const cookie = `${seatCookieName(id)}=${token}`;
  const send = (body: unknown, headers: Record<string, string> = { cookie }) =>
    act(post(`/api/games/${id}/seat/act`, body, headers), { params: Promise.resolve({ id }) });
  return { seat, cookie, send };
}

beforeEach(() => {
  saved = Object.fromEntries(ARENA.map((k) => [k, process.env[k]]));
  for (const k of ARENA) delete process.env[k];
  vi.useFakeTimers(); // background simulations stay parked on their timers
  __resetLiveForTests();
  resetGuardState();
});
afterEach(() => {
  __resetLiveForTests();
  resetGuardState();
  vi.useRealTimers();
  for (const k of ARENA) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("no ARENA_* env: behaviour is unchanged", () => {
  it("starts real-model live games, human games and tournaments for anyone", async () => {
    expect((await startLive(post("/api/games/live", REAL))).status).toBe(202);
    expect((await startHuman(post("/api/games/human", REAL))).status).toBe(201);
    expect((await startTournament(post("/api/tournaments", { roster: ["mock", "hunter-bot"] }))).status).toBe(201);
    const info = await (await models(new Request("http://localhost:3000/api/models"))).json();
    expect(info.guard).toMatchObject({ mode: "open", adminConfigured: false, lockedModels: [], realModels: ["gpt-x"] });
    expect(info.models.map((m: { id: string }) => m.id)).toContain("mock");
  });
});

describe("no ARENA_* env: the human routes keep their own refusal wording", () => {
  it("oversize bodies say what they said before the guard", async () => {
    const res = await startHuman(post("/api/games/human", JSON.stringify({ pad: "x".repeat(MAX_CREATE_BODY_BYTES) })));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "Body too large" });
    const { send } = parkedHumanGame("wording");
    const big = await send(JSON.stringify({ pad: "x".repeat(MAX_ACT_BODY_BYTES) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: "Body too large" });
  });

  it("the seat route tells unparseable JSON from a non-object", async () => {
    const { send } = parkedHumanGame("wording");
    const bad = await send("{nope");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Malformed JSON" });
    const arr = await send("[1,2]");
    expect(arr.status).toBe(400);
    expect(await arr.json()).toEqual({ error: "Body must be a JSON object" });
  });
});

describe("always-on protections", () => {
  it("413s a chunked body with no declared length without draining it", async () => {
    const chunk = new TextEncoder().encode("x".repeat(16_384));
    const routes = [
      ["/api/games", startGame],
      ["/api/games/live", startLive],
      ["/api/games/human", startHuman],
      ["/api/tournaments", startTournament],
    ] as const;
    for (const [path, route] of routes) {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            pulled++;
            if (pulled > 1000) c.close();
            else c.enqueue(chunk);
          },
        },
        { highWaterMark: 0 }
      );
      const req = new Request(`http://localhost:3000${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit);
      expect(req.headers.get("content-length")).toBeNull();
      const res = await route(req);
      expect(res.status, path).toBe(413);
      expect(pulled, path).toBeLessThan(10);
    }
    expect(listRunning()).toHaveLength(0);
  });

  it("413s a body over 64 KB on every start route", async () => {
    const big = JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) });
    for (const res of [
      await startGame(post("/api/games", big)),
      await startLive(post("/api/games/live", big)),
      await startTournament(post("/api/tournaments", big)),
    ]) {
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "Request body too large.", code: "body_too_large" });
    }
    expect(listRunning()).toHaveLength(0);
  });

  it("a live start with a malformed or wrongly typed body is never a 500", async () => {
    expect((await startLive(post("/api/games/live", "not json"))).status).toBe(202);
    const res = await startLive(post("/api/games/live", { seatModels: 5, disabledRoles: "x" }));
    expect([202, 400]).toContain(res.status);
  });
});

describe("bots mode with an admin token", () => {
  beforeEach(() => {
    process.env.ARENA_ADMIN_TOKEN = TOKEN;
  });

  it("locks real models and tournaments behind the token on every start route", async () => {
    for (const res of [
      await startGame(post("/api/games", REAL)),
      await startLive(post("/api/games/live", REAL)),
      await startHuman(post("/api/games/human", REAL)),
      await startTournament(post("/api/tournaments", { roster: ["mock", "hunter-bot"] })),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "admin_required" });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(listRunning()).toHaveLength(0);
    expect(runningHumanGames()).toBe(0);
  });

  it("an id the registry does not know is coerced to a bot, so it is not locked", async () => {
    const res = await startLive(post("/api/games/live", { numPlayers: 5, seatModels: ["made-up"] }));
    expect(res.status).toBe(202);
    expect(getLive((await res.json()).id)!.config.seatModels).toEqual(Array(5).fill("mock"));
  });

  it("lets anyone start bot games, and the admin start anything", async () => {
    expect((await startLive(post("/api/games/live", BOTS))).status).toBe(202);
    expect((await startHuman(post("/api/games/human", BOTS))).status).toBe(201);
    expect((await startLive(post("/api/games/live", REAL, BEARER))).status).toBe(202);
    const human = await startHuman(post("/api/games/human", REAL, BEARER));
    expect(human.status).toBe(201);
    expect(human.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await startTournament(post("/api/tournaments", { roster: ["mock", "hunter-bot"] }, BEARER))).status).toBe(201);
  });

  it("the guard never rewrites the request it admits", async () => {
    const res = await startLive(post("/api/games/live", { numPlayers: 6, seatModels: ["hunter-bot"], seed: 99 }));
    const game = getLive((await res.json()).id)!;
    expect(game.config).toMatchObject({ numPlayers: 6, seed: 99, seatModels: Array(6).fill("hunter-bot") });
  });

  it("reports locked chips to a visitor and none to the admin", async () => {
    const visitor = await (await models(new Request("http://localhost:3000/api/models"))).json();
    expect(visitor.guard).toMatchObject({
      mode: "bots", adminConfigured: true, authorized: false,
      canStartGames: true, canSeatRealModels: false, canStartTournaments: false, lockedModels: ["gpt-x"],
    });
    const op = await (await models(new Request("http://localhost:3000/api/models", { headers: BEARER }))).json();
    expect(op.guard).toMatchObject({ authorized: true, lockedModels: [] });
    expect(JSON.stringify(visitor)).not.toContain(TOKEN);
  });

  it("the admin token does not unseal a running human game or stand in for the seat cookie", async () => {
    const started = await startHuman(post("/api/games/human", BOTS));
    const { id } = await started.json();
    const stream = await spectate(
      new Request(`http://localhost:3000/api/games/${id}/stream`, { headers: BEARER }),
      { params: Promise.resolve({ id }) }
    );
    expect(await stream.text()).toBe(
      `event: meta\ndata: ${JSON.stringify({ id, status: "running", sealed: true })}\n\n`
    );
    const res = await act(post(`/api/games/${id}/seat/act`, { resume: true }, BEARER), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(401);
  });
});

describe("off mode", () => {
  it("denies every start to a visitor: 403 with no token configured, 401 with one", async () => {
    process.env.ARENA_PUBLIC_MODE = "off";
    for (const res of [
      await startGame(post("/api/games", BOTS)),
      await startLive(post("/api/games/live", BOTS)),
      await startHuman(post("/api/games/human", BOTS)),
      await startTournament(post("/api/tournaments", {})),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "This arena is view-only.", code: "disabled" });
    }
    process.env.ARENA_ADMIN_TOKEN = TOKEN;
    expect((await startHuman(post("/api/games/human", BOTS))).status).toBe(401);
    expect((await startHuman(post("/api/games/human", BOTS, BEARER))).status).toBe(201);
    expect(listRunning()).toHaveLength(1);
  });
});

describe("limits", () => {
  it("one rate limit covers all start routes, human games included", async () => {
    process.env.ARENA_RATE_LIMIT = "2";
    expect((await startLive(post("/api/games/live", BOTS))).status).toBe(202);
    expect((await startHuman(post("/api/games/human", BOTS))).status).toBe(201);
    const third = await startHuman(post("/api/games/human", BOTS));
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(third.headers.get("set-cookie")).toBeNull();
    expect(await third.json()).toMatchObject({ code: "rate_limited" });
    expect((await startLive(post("/api/games/live", BOTS))).status).toBe(429);
    expect(runningHumanGames()).toBe(1);
  });

  it("ARENA_MAX_GAMES counts human games and applies to them", async () => {
    process.env.ARENA_MAX_GAMES = "1";
    expect((await startHuman(post("/api/games/human", BOTS))).status).toBe(201);
    const live = await startLive(post("/api/games/live", BOTS));
    expect(live.status).toBe(503);
    expect(live.headers.get("retry-after")).toBe("30");
    expect((await startHuman(post("/api/games/human", BOTS))).status).toBe(503);
    expect(listRunning()).toHaveLength(1);
  });

  it("ARENA_MAX_TOURNAMENTS holds for two requests fired together", async () => {
    process.env.ARENA_MAX_TOURNAMENTS = "1";
    const body = { roster: ["mock", "hunter-bot"], gamesPerRound: 1, numPlayers: 5 };
    const [a, b] = await Promise.all([
      startTournament(post("/api/tournaments", body)),
      startTournament(post("/api/tournaments", body)),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 503]);
  });

  it("a start refused by the human-games cap consumes no rate slot and no daily budget", async () => {
    process.env.ARENA_RATE_LIMIT = "5";
    process.env.ARENA_DAILY_GAMES = "5";
    for (let i = 0; i < MAX_RUNNING_HUMAN_GAMES; i++) parkedHumanGame(`cap${i}`);
    for (let i = 0; i < 8; i++) {
      const res = await startHuman(post("/api/games/human", BOTS));
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("30");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.json()).toEqual({
        error: "Too many human games are running. Try again in a minute.",
        code: "busy",
      });
    }
    expect(guardBuckets().size).toBe(0);
    expect(runningHumanGames()).toBe(MAX_RUNNING_HUMAN_GAMES);
    // The budget is intact: other starts are still admitted.
    expect((await startLive(post("/api/games/live", BOTS))).status).toBe(202);
  });

  it("the daily budget is shared by every start route", async () => {
    process.env.ARENA_DAILY_GAMES = "1";
    expect((await startHuman(post("/api/games/human", BOTS))).status).toBe(201);
    const res = await startLive(post("/api/games/live", BOTS));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "budget_exhausted" });
  });
});

describe("seat actions under the guard", () => {
  async function seated() {
    const res = await startHuman(post("/api/games/human", BOTS));
    const { id } = await res.json();
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    expect(cookie.startsWith(`${seatCookieName(id)}=`)).toBe(true);
    const send = (body: unknown, headers: Record<string, string> = { cookie }) =>
      act(post(`/api/games/${id}/seat/act`, body, headers), { params: Promise.resolve({ id }) });
    return { id, cookie, send };
  }

  it("a seated player can still act in off mode and after the budget is spent", async () => {
    process.env.ARENA_ADMIN_TOKEN = TOKEN;
    process.env.ARENA_DAILY_GAMES = "1";
    const { send } = await seated();
    process.env.ARENA_PUBLIC_MODE = "off";
    expect((await send({ resume: true })).status).toBe(200);
  });

  it("floods are cut off per client, but only for requests that hold the seat", async () => {
    process.env.ARENA_RATE_LIMIT = "1";
    const { seat, send } = parkedHumanGame("flood");
    // Requests without the cookie are refused by the seat check and never reach the limiter.
    for (let i = 0; i < ACTS_PER_START + 5; i++) expect((await send({ resume: true }, {})).status).toBe(401);
    for (let i = 0; i < ACTS_PER_START; i++) expect((await send({ resume: true })).status).toBe(200);
    const over = await send({ resume: true });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toMatch(/^\d+$/);
    // A refused answer leaves the pending prompt open rather than resolving it.
    void makePromptPort("flood").ask(buildPromptSpec("vote", makeView("villager")));
    const pending = seat.pending?.prompt.id;
    expect(pending).toBe("1");
    expect((await send({ promptId: pending, kind: "target", targetId: 3 })).status).toBe(429);
    expect(seat.pending?.prompt.id).toBe(pending);
    // Once the window has passed the same answer goes through.
    vi.setSystemTime(Date.now() + 61_000);
    expect((await send({ promptId: pending, kind: "target", targetId: 3 })).status).toBe(200);
    expect(seat.pending).toBeNull();
  });
});
