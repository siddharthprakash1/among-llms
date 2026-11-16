import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Nothing here may write to ./data.
vi.mock("@/lib/store", () => ({
  store: {
    saveTranscript: async () => {},
    updateLeaderboard: async () => ({}),
    getTranscript: async () => null,
    listSummaries: async () => [],
    getLeaderboard: async () => ({}),
  },
}));

import { POST } from "./route";
import { buildConfig } from "@/lib/games";
import { __resetLiveForTests, createLive, getLive } from "@/lib/live";
import { MAX_CREATE_BODY_BYTES, MAX_RUNNING_HUMAN_GAMES, newHumanSeat, runningHumanGames, seatCookieName, verifySeat } from "@/lib/human/seat";
import { buildPlayers } from "@/lib/engine/roles";
import { makeRng } from "@/lib/engine/rng";

const post = (body: unknown, init: { url?: string; headers?: Record<string, string> } = {}) =>
  POST(
    new Request(init.url ?? "http://localhost:3000/api/games/human", {
      method: "POST",
      headers: { "content-type": "application/json", ...init.headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );

describe("POST /api/games/human", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetLiveForTests();
  });
  afterEach(() => {
    __resetLiveForTests();
    vi.useRealTimers();
  });

  it("creates a game, returns only the id and sets the scoped seat cookie", async () => {
    const res = await post({ numPlayers: 7, seatModels: ["mock"], seed: 42, role: "seer" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["id"]);

    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${seatCookieName(body.id)}=`);
    expect(cookie).toContain(`Path=/api/games/${body.id}/seat`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");

    const game = getLive(body.id)!;
    expect(game.human).toBeDefined();
    expect(game.human!.role).toBe("seer");
    expect(game.config.seed).not.toBe(42);
    expect(game.players.filter((p) => p.model === "human")).toHaveLength(1);

    // The cookie that was set is the one the seat routes accept.
    expect(verifySeat(body.id, cookie.split(";")[0]).ok).toBe(true);
  });

  it("marks the cookie Secure behind an https proxy or on an https url", async () => {
    const proxied = await post({}, { headers: { "x-forwarded-proto": "https" } });
    expect(proxied.headers.get("set-cookie")).toContain("; Secure");
    const direct = await post({}, { url: "https://arena.example/api/games/human" });
    expect(direct.headers.get("set-cookie")).toContain("; Secure");
  });

  it("accepts a body that is not JSON", async () => {
    const res = await post("not json");
    expect(res.status).toBe(201);
  });

  it("415s a non-JSON content type, so a cross-site simple POST starts nothing", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
      const res = await post({ numPlayers: 7 }, { headers: { "content-type": type } });
      expect(res.status, type).toBe(415);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const bare = await POST(new Request("http://localhost:3000/api/games/human", { method: "POST" }));
    expect(bare.status).toBe(415);
    expect(runningHumanGames()).toBe(0);
  });

  it("413s an oversize body, by declared length or by actual size", async () => {
    const big = JSON.stringify({ pad: "x".repeat(MAX_CREATE_BODY_BYTES) });
    expect((await post(big)).status).toBe(413);
    const declared = await post({}, { headers: { "content-length": String(MAX_CREATE_BODY_BYTES + 1) } });
    expect(declared.status).toBe(413);
    expect(runningHumanGames()).toBe(0);
  });

  it("falls back to defaults for wrongly typed fields instead of throwing", async () => {
    const bodies = [
      { disabledRoles: "hunter" },
      { disabledRoles: { filter: 1 } },
      { disabledRoles: [1, null, "witch"], numPlayers: 8 },
      { seatModels: 5 },
      { seatModels: { length: 3 } },
      { numPlayers: "x", role: { a: 1 } },
      [1, 2],
      null,
    ];
    for (const b of bodies) {
      __resetLiveForTests();
      const res = await post(b);
      expect(res.status, JSON.stringify(b)).toBe(201);
      const game = getLive((await res.json()).id)!;
      expect(game.players.filter((p) => p.model === "human")).toHaveLength(1);
    }
    const res = await post({ disabledRoles: [1, null, "witch"], numPlayers: 8 });
    expect(getLive((await res.json()).id)!.config.disabledRoles).toEqual(["witch"]);
  });

  it("answers 429 with no cookie when too many human games are running", async () => {
    const config = buildConfig({ numPlayers: 7, seatModels: ["mock"] });
    const players = buildPlayers(config, makeRng(config.seed));
    for (let i = 0; i < MAX_RUNNING_HUMAN_GAMES; i++) {
      createLive(`cap${i}`, "2026-01-01T00:00:00.000Z", config, players, newHumanSeat(0, "villager", "good", "0".repeat(64)));
    }
    const res = await post({ numPlayers: 7 });
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await res.json()).error).toMatch(/Too many human games/);
  });
});
