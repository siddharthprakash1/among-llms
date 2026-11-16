import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTS_PER_START,
  Bucket,
  MAX_BODY_BYTES,
  StartRequest,
  checkAct,
  checkStart,
  clientKey,
  commitRateLimit,
  denied,
  describeGuard,
  guardBuckets,
  hitRateLimit,
  inflightGames,
  isAdmin,
  peekRateLimit,
  readGuardConfig,
  readJsonBody,
  resetGuardState,
  startFailed,
  trackGame,
} from "./guard";

const TOKEN = "0123456789abcdef-token";
const isReal = (id: string) => id === "gpt-x";
const req = (headers: Record<string, string> = {}) => new Request("http://x/", { headers });
const admin = () => req({ authorization: `Bearer ${TOKEN}` });

const BOT: StartRequest = { kind: "game", seatModels: ["mock", "hunter-bot"] };
const MIXED: StartRequest = { kind: "game", seatModels: ["mock", "gpt-x"] };
const TOURNEY: StartRequest = { kind: "tournament" };
const IDLE = { games: 0, tournaments: 0 };

const start = (
  r: Request,
  s: StartRequest,
  env: Record<string, string | undefined>,
  now = 0,
  load = IDLE
) => checkStart(r, s, load, { env, now, isReal });

beforeEach(() => resetGuardState());

describe("readGuardConfig", () => {
  it("is fully open with an empty env", () => {
    const cfg = readGuardConfig({});
    expect(cfg).toEqual({
      mode: "open",
      adminTokenHash: null,
      rateLimit: null,
      dailyGames: null,
      maxGames: null,
      maxTournaments: null,
      ipHeader: null,
      warnings: [],
    });
    for (let i = 0; i < 100; i++) {
      expect(start(req(), MIXED, {})).toBeNull();
      expect(start(req(), TOURNEY, {})).toBeNull();
    }
    expect(guardBuckets().size).toBe(0);
  });

  it("defaults to bots once a token is set, and warns about bad values without echoing them", () => {
    const ok = readGuardConfig({ ARENA_ADMIN_TOKEN: TOKEN });
    expect(ok.mode).toBe("bots");
    expect(ok.adminTokenHash).not.toBeNull();
    expect(ok.warnings).toEqual([]);

    const short = readGuardConfig({ ARENA_ADMIN_TOKEN: "short-secret" });
    expect(short.adminTokenHash).toBeNull();
    expect(short.mode).toBe("bots");
    expect(short.warnings).toHaveLength(1);
    expect(short.warnings[0]).not.toContain("short-secret");

    const badMode = readGuardConfig({ ARENA_PUBLIC_MODE: "everyone" });
    expect(badMode.mode).toBe("bots");
    expect(badMode.warnings).toHaveLength(1);

    expect(readGuardConfig({ ARENA_PUBLIC_MODE: " OFF " }).mode).toBe("off");
    expect(readGuardConfig({ ARENA_ADMIN_TOKEN: TOKEN, ARENA_PUBLIC_MODE: "open" }).mode).toBe("open");

    for (const v of ["abc", "-1", "0", "1.5"]) {
      const cfg = readGuardConfig({ ARENA_RATE_LIMIT: v });
      expect(cfg.rateLimit, v).toBeNull();
      expect(cfg.warnings, v).toHaveLength(1);
    }
    expect(readGuardConfig({ ARENA_RATE_LIMIT: " 6 ", ARENA_MAX_GAMES: "" })).toMatchObject({
      rateLimit: 6,
      maxGames: null,
      warnings: [],
    });
    expect(readGuardConfig({ ARENA_IP_HEADER: " Fly-Client-IP " }).ipHeader).toBe("fly-client-ip");
  });
});

describe("isAdmin", () => {
  it("accepts only the exact Bearer token", () => {
    const cfg = readGuardConfig({ ARENA_ADMIN_TOKEN: TOKEN });
    expect(isAdmin(admin(), readGuardConfig({}))).toBe(false);
    expect(isAdmin(req(), cfg)).toBe(false);
    expect(isAdmin(req({ authorization: TOKEN }), cfg)).toBe(false);
    expect(isAdmin(req({ authorization: "Basic abc" }), cfg)).toBe(false);
    expect(isAdmin(req({ authorization: "Bearer " }), cfg)).toBe(false);
    expect(isAdmin(req({ authorization: `Bearer ${TOKEN}x` }), cfg)).toBe(false);
    expect(isAdmin(req({ authorization: "Bearer wrong-token-wrong-token" }), cfg)).toBe(false);
    expect(isAdmin(admin(), cfg)).toBe(true);
    expect(isAdmin(req({ authorization: `bEaReR ${TOKEN}` }), cfg)).toBe(true);
  });

  it("is never satisfied by a short (disabled) token", () => {
    const cfg = readGuardConfig({ ARENA_ADMIN_TOKEN: "short" });
    expect(isAdmin(req({ authorization: "Bearer short" }), cfg)).toBe(false);
  });
});

describe("checkStart policy", () => {
  it("open: everything passes for everyone", () => {
    for (const s of [BOT, MIXED, TOURNEY]) {
      expect(start(req(), s, { ARENA_PUBLIC_MODE: "open" })).toBeNull();
      expect(start(admin(), s, { ARENA_PUBLIC_MODE: "open", ARENA_ADMIN_TOKEN: TOKEN })).toBeNull();
    }
  });

  it("bots with a token: 401 for real models and tournaments, bots pass, admin passes all", () => {
    const env = { ARENA_ADMIN_TOKEN: TOKEN };
    expect(start(req(), BOT, env)).toBeNull();
    expect(start(req(), MIXED, env)).toMatchObject({ status: 401, code: "admin_required" });
    expect(start(req(), TOURNEY, env)).toMatchObject({ status: 401, code: "admin_required" });
    expect(start(req({ authorization: "Bearer nope-nope-nope-nope" }), MIXED, env)).toMatchObject({
      status: 401,
    });
    for (const s of [BOT, MIXED, TOURNEY]) expect(start(admin(), s, env)).toBeNull();
  });

  it("bots without a token: 403", () => {
    const env = { ARENA_PUBLIC_MODE: "bots" };
    expect(start(req(), BOT, env)).toBeNull();
    expect(start(req(), MIXED, env)).toMatchObject({
      status: 403,
      code: "disabled",
      error: "This arena only allows bot games.",
    });
    expect(start(req(), TOURNEY, env)).toMatchObject({ status: 403, code: "disabled" });
    // A token nobody configured grants nothing.
    expect(start(admin(), MIXED, env)).toMatchObject({ status: 403 });
  });

  it("off: denies every kind to non-admins, admin passes everything", () => {
    for (const s of [BOT, MIXED, TOURNEY]) {
      expect(start(req(), s, { ARENA_PUBLIC_MODE: "off" })).toMatchObject({
        status: 403,
        error: "This arena is view-only.",
      });
      const env = { ARENA_PUBLIC_MODE: "off", ARENA_ADMIN_TOKEN: TOKEN };
      expect(start(req(), s, env)).toMatchObject({ status: 401, code: "admin_required" });
      expect(start(admin(), s, env)).toBeNull();
    }
  });
});

describe("rate limiter", () => {
  it("allows `limit` hits per window, per key", () => {
    const b = new Map<string, Bucket>();
    for (let i = 0; i < 3; i++) expect(hitRateLimit(b, "a", 3, 1000 * i, 60_000).ok).toBe(true);
    const deniedHit = hitRateLimit(b, "a", 3, 5000, 60_000);
    expect(deniedHit.ok).toBe(false);
    expect(deniedHit.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(deniedHit.retryAfterSec).toBeLessThanOrEqual(60);
    expect(b.get("a")!.count).toBe(3);
    expect(hitRateLimit(b, "b", 3, 5000, 60_000).ok).toBe(true);
    expect(hitRateLimit(b, "a", 3, 60_000, 60_000).ok).toBe(true);
    expect(b.get("a")).toEqual({ start: 60_000, count: 1, expires: 120_000 });
  });

  it("prunes expired buckets once the map is large", () => {
    const b = new Map<string, Bucket>();
    for (let i = 0; i < 10_001; i++) commitRateLimit(b, `k${i}`, 0, 60_000);
    commitRateLimit(b, "live", 30_000, 60_000);
    expect(b.size).toBe(10_002); // nothing had expired yet
    commitRateLimit(b, "fresh", 70_000, 60_000);
    expect([...b.keys()].sort()).toEqual(["fresh", "live"]);
  });

  it("peek never mutates, even on a denial", () => {
    const b = new Map<string, Bucket>();
    hitRateLimit(b, "a", 1, 0, 60_000);
    const before = JSON.stringify([...b]);
    expect(peekRateLimit(b, "a", 1, 10).ok).toBe(false);
    expect(peekRateLimit(b, "zzz", 1, 10).ok).toBe(true);
    expect(peekRateLimit(b, "a", 1, 999_999).ok).toBe(true);
    expect(JSON.stringify([...b])).toBe(before);
  });

  it("pruning per-client buckets does not reset the daily budget", () => {
    const env = { ARENA_DAILY_GAMES: "1" };
    expect(start(req(), BOT, env, 0)).toBeNull();
    for (let i = 0; i < 10_001; i++) commitRateLimit(guardBuckets(), `ip:${i}`, 120_000, 60_000);
    expect(start(req(), BOT, env, 120_000)).toMatchObject({ status: 429, code: "budget_exhausted" });
  });

  it("limits per client IP and exempts the admin", () => {
    const env = {
      ARENA_RATE_LIMIT: "2",
      ARENA_IP_HEADER: "fly-client-ip",
      ARENA_ADMIN_TOKEN: TOKEN,
    };
    const from = (ip: string) => req({ "fly-client-ip": ip });
    expect(start(from("1.1.1.1"), BOT, env)).toBeNull();
    expect(start(from("1.1.1.1"), BOT, env)).toBeNull();
    const third = start(from("1.1.1.1"), BOT, env, 1000);
    expect(third).toMatchObject({ status: 429, code: "rate_limited", retryAfterSec: 59 });
    expect(third!.error).toContain("59s");
    expect(start(from("2.2.2.2"), BOT, env)).toBeNull();
    for (let i = 0; i < 10; i++) {
      expect(start(req({ "fly-client-ip": "1.1.1.1", authorization: `Bearer ${TOKEN}` }), MIXED, env)).toBeNull();
    }
    expect(start(from("1.1.1.1"), BOT, env, 60_000)).toBeNull();
  });
});

describe("clientKey", () => {
  it("ignores x-forwarded-for unless it is the configured header", () => {
    const xff = req({ "x-forwarded-for": "9.9.9.9" });
    expect(clientKey(xff, readGuardConfig({}))).toBe("shared");
    expect(clientKey(xff, readGuardConfig({ ARENA_IP_HEADER: "fly-client-ip" }))).toBe("shared");
    expect(clientKey(xff, readGuardConfig({ ARENA_IP_HEADER: "X-Forwarded-For" }))).toBe("9.9.9.9");
  });

  it("takes the last comma entry, trimmed", () => {
    const cfg = readGuardConfig({ ARENA_IP_HEADER: "fly-client-ip" });
    expect(clientKey(req({ "fly-client-ip": "5.5.5.5" }), cfg)).toBe("5.5.5.5");
    expect(clientKey(req({ "fly-client-ip": "6.6.6.6, 7.7.7.7 " }), cfg)).toBe("7.7.7.7");
    expect(clientKey(req({ "fly-client-ip": " " }), cfg)).toBe("shared");
  });
});

describe("daily budget", () => {
  it("counts games and tournaments alike, skips the admin, and resets after 24h", () => {
    const env = { ARENA_DAILY_GAMES: "2", ARENA_PUBLIC_MODE: "open", ARENA_ADMIN_TOKEN: TOKEN };
    expect(start(admin(), MIXED, env)).toBeNull();
    expect(start(req(), BOT, env, 0)).toBeNull();
    expect(start(req(), TOURNEY, env, 10)).toBeNull();
    expect(start(req(), BOT, env, 20)).toMatchObject({ status: 429, code: "budget_exhausted" });
    const t = start(req(), TOURNEY, env, 20);
    expect(t).toMatchObject({ status: 429, code: "budget_exhausted" });
    expect(t!.retryAfterSec).toBeGreaterThan(0);
    expect(start(admin(), TOURNEY, env, 30)).toBeNull();
    expect(start(req(), BOT, env, 86_400_000)).toBeNull();
  });
});

describe("caps", () => {
  it("deny at the cap for everyone, admin included", () => {
    const env = { ARENA_MAX_GAMES: "1", ARENA_MAX_TOURNAMENTS: "1", ARENA_PUBLIC_MODE: "open", ARENA_ADMIN_TOKEN: TOKEN };
    const busyGames = { games: 1, tournaments: 0 };
    const busyTourneys = { games: 0, tournaments: 1 };
    for (const r of [req(), admin()]) {
      expect(start(r, BOT, env, 0, busyGames)).toMatchObject({ status: 503, code: "busy", retryAfterSec: 30 });
      expect(start(r, BOT, env, 0, busyTourneys)).toBeNull();
      expect(start(r, TOURNEY, env, 0, busyTourneys)).toMatchObject({ status: 503, code: "busy" });
      expect(start(r, TOURNEY, env, 0, busyGames)).toBeNull();
      expect(start(r, BOT, env, 0, IDLE)).toBeNull();
    }
  });

  it("a denial consumes neither the rate limit nor the budget", () => {
    const env = { ARENA_MAX_GAMES: "1", ARENA_DAILY_GAMES: "1", ARENA_RATE_LIMIT: "1" };
    for (let i = 0; i < 3; i++) {
      expect(start(req(), BOT, env, 0, { games: 1, tournaments: 0 })).toMatchObject({ code: "busy" });
    }
    expect(guardBuckets().size).toBe(0);
    expect(start(req(), BOT, env, 0)).toBeNull();
    expect(start(req(), BOT, env, 0)).not.toBeNull();
  });

  it("a budget denial leaves the caller's rate bucket alone", () => {
    const env = { ARENA_DAILY_GAMES: "1", ARENA_RATE_LIMIT: "5" };
    expect(start(req(), BOT, env)).toBeNull();
    expect(start(req(), BOT, env)).toMatchObject({ code: "budget_exhausted" });
    expect(start(req(), BOT, env)).toMatchObject({ code: "budget_exhausted" });
    expect(guardBuckets().get("ip:shared")!.count).toBe(1);
  });

  it("a policy denial consumes nothing", () => {
    const env = { ARENA_PUBLIC_MODE: "bots", ARENA_RATE_LIMIT: "1", ARENA_DAILY_GAMES: "1" };
    for (let i = 0; i < 5; i++) expect(start(req(), MIXED, env)).toMatchObject({ status: 403 });
    expect(guardBuckets().size).toBe(0);
  });
});

describe("checkAct", () => {
  it("is a no-op with no rate limit, whatever the mode", () => {
    for (const env of [{}, { ARENA_PUBLIC_MODE: "off" }, { ARENA_ADMIN_TOKEN: TOKEN, ARENA_DAILY_GAMES: "1" }]) {
      for (let i = 0; i < 500; i++) expect(checkAct(req(), { env, now: 0 })).toBeNull();
    }
    expect(guardBuckets().size).toBe(0);
  });

  it("stops a flood from one client without touching the start buckets", () => {
    const env = { ARENA_RATE_LIMIT: "2", ARENA_IP_HEADER: "fly-client-ip", ARENA_ADMIN_TOKEN: TOKEN };
    const from = (ip: string) => req({ "fly-client-ip": ip });
    for (let i = 0; i < 2 * ACTS_PER_START; i++) expect(checkAct(from("1.1.1.1"), { env, now: 0 })).toBeNull();
    expect(checkAct(from("1.1.1.1"), { env, now: 0 })).toMatchObject({ status: 429, code: "rate_limited" });
    expect(checkAct(from("2.2.2.2"), { env, now: 0 })).toBeNull();
    expect(checkAct(req({ "fly-client-ip": "1.1.1.1", authorization: `Bearer ${TOKEN}` }), { env, now: 0 })).toBeNull();
    expect(checkAct(from("1.1.1.1"), { env, now: 60_000 })).toBeNull();
    // Acting never spends a start slot.
    expect(start(from("1.1.1.1"), BOT, env, 60_000)).toBeNull();
    expect(guardBuckets().get("ip:1.1.1.1")!.count).toBe(1);
  });
});

describe("trackGame", () => {
  it("counts a pending game and releases on resolve and on reject", async () => {
    let release!: () => void;
    const p = trackGame(new Promise<void>((r) => (release = r)));
    expect(inflightGames()).toBe(1);
    release();
    await p;
    expect(inflightGames()).toBe(0);
    await expect(trackGame(Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(inflightGames()).toBe(0);
  });
});

describe("describeGuard", () => {
  const ids = ["mock", "gpt-x", "hunter-bot"];
  it("open: nothing is locked", () => {
    expect(describeGuard(req(), ids, { env: {}, isReal })).toEqual({
      mode: "open",
      adminConfigured: false,
      authorized: false,
      canStartGames: true,
      canSeatRealModels: true,
      canStartTournaments: true,
      lockedModels: [],
      realModels: ["gpt-x"],
    });
  });

  it("bots: real models are locked until the token is presented", () => {
    const env = { ARENA_ADMIN_TOKEN: TOKEN };
    expect(describeGuard(req(), ids, { env, isReal })).toEqual({
      mode: "bots",
      adminConfigured: true,
      authorized: false,
      canStartGames: true,
      canSeatRealModels: false,
      canStartTournaments: false,
      lockedModels: ["gpt-x"],
      realModels: ["gpt-x"],
    });
    expect(describeGuard(admin(), ids, { env, isReal })).toMatchObject({
      authorized: true,
      canStartGames: true,
      canSeatRealModels: true,
      canStartTournaments: true,
      lockedModels: [],
      realModels: ["gpt-x"],
    });
  });

  it("off: a visitor can start nothing", () => {
    expect(describeGuard(req(), ids, { env: { ARENA_PUBLIC_MODE: "off" }, isReal })).toMatchObject({
      canStartGames: false,
      canSeatRealModels: false,
      canStartTournaments: false,
      adminConfigured: false,
    });
  });
});

describe("readJsonBody", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://x/", { method: "POST", body, headers });

  it("returns a JSON object", async () => {
    expect(await readJsonBody(post('{"a":1}'))).toEqual({ body: { a: 1 }, malformed: false });
  });

  it("turns malformed JSON and non-objects into {}", async () => {
    for (const raw of ["{nope", ""]) {
      expect(await readJsonBody(post(raw)), raw).toEqual({ body: {}, malformed: true, reason: "json" });
    }
    for (const raw of ["[1,2]", '"text"', "null", "7"]) {
      expect(await readJsonBody(post(raw)), raw).toEqual({ body: {}, malformed: true, reason: "shape" });
    }
  });

  const streamed = (chunks: Uint8Array[]) => {
    let i = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (i < chunks.length) c.enqueue(chunks[i++]);
          else c.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 }
    );
    const req = new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit);
    return { req, pulled: () => i, wasCancelled: () => cancelled };
  };

  it("413s a body with no declared length as soon as it passes the cap, and cancels the rest", async () => {
    const chunk = new Uint8Array(40_000).fill(120);
    const s = streamed(Array.from({ length: 500 }, () => chunk));
    expect(s.req.headers.get("content-length")).toBeNull();
    expect(await readJsonBody(s.req)).toEqual({
      denial: { status: 413, code: "body_too_large", error: "Request body too large." },
    });
    // 2 chunks cross 64 KB; the other 498 (20 MB) are never produced.
    expect(s.pulled()).toBeLessThanOrEqual(3);
    expect(s.wasCancelled()).toBe(true);
  });

  it("reads a streamed body whose multi-byte character is split across chunks", async () => {
    const text = "\u00e9\ud83d\udd12";
    // {"a":" is 6 bytes, so byte 7 splits the 2-byte \u00e9 and byte 9 splits the 4-byte emoji.
    const raw = new TextEncoder().encode(JSON.stringify({ a: text }));
    const s = streamed([raw.slice(0, 7), raw.slice(7, 9), raw.slice(9)]);
    expect(await readJsonBody(s.req)).toEqual({ body: { a: text }, malformed: false });
  });

  it("a body stream that errors is malformed, not a throw", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("socket reset"));
      },
    });
    const req = new Request("http://x/", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(await readJsonBody(req)).toEqual({ body: {}, malformed: true, reason: "json" });
  });

  it("413s a body over the cap", async () => {
    const r = await readJsonBody(post(JSON.stringify({ pad: "x".repeat(70_000) })));
    expect(r).toEqual({
      denial: { status: 413, code: "body_too_large", error: "Request body too large." },
    });
  });

  it("413s on the declared length without reading the body", async () => {
    const r = post("{}", { "content-length": String(MAX_BODY_BYTES + 1) });
    expect(await readJsonBody(r)).toHaveProperty("denial.status", 413);
    expect(r.bodyUsed).toBe(false);
  });

  it("honours a smaller per-route cap", async () => {
    expect(await readJsonBody(post(JSON.stringify({ pad: "x".repeat(200) })), 100)).toHaveProperty(
      "denial.code",
      "body_too_large"
    );
    expect(await readJsonBody(post('{"a":1}'), 100)).toEqual({ body: { a: 1 }, malformed: false });
  });
});

describe("denied", () => {
  it("builds the shared denial response", async () => {
    const res = denied({ status: 429, code: "rate_limited", error: "Slow down", retryAfterSec: 12 });
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("retry-after")).toBe("12");
    expect(await res.json()).toEqual({ error: "Slow down", code: "rate_limited" });
    expect(denied({ status: 403, code: "disabled", error: "no" }).headers.get("retry-after")).toBeNull();
  });
});

describe("startFailed", () => {
  it("hides a filesystem error behind a 503 with no path", async () => {
    const err = Object.assign(new Error("ENOTDIR: not a directory, mkdir '/secret/data'"), {
      code: "ENOTDIR",
      syscall: "mkdir",
    });
    const res = startFailed(err, "Failed");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("storage_unavailable");
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("keeps the 400 with the message for an input error", async () => {
    const res = startFailed(new Error("numPlayers must be 5-12"), "Failed");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "numPlayers must be 5-12" });
    expect(await startFailed("weird", "Failed").json()).toEqual({ error: "Failed" });
  });
});
