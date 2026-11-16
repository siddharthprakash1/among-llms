import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOPILOT_AFTER_MISSES,
  BUDGET_MS,
  DELIVERY_GRACE_MS,
  armPrompt,
  buildSeatCookie,
  closeSeat,
  makePromptPort,
  newHumanSeat,
  newSeatToken,
  resumeSeat,
  runningHumanGames,
  seatCookieName,
  seatMeta,
  seatStatus,
  submitAnswer,
  verifySeat,
} from "./seat";
import { buildPromptSpec } from "./legal";
import { makeView } from "./testUtil";
import { __resetLiveForTests, createLive, finishLive, getLive, pushLive } from "../live";
import { buildPlayers } from "../engine/roles";
import { makeRng } from "../engine/rng";
import type { GameConfig } from "../engine/types";
import type { SeatAnswer } from "./types";

const CONFIG: GameConfig = { numPlayers: 7, seatModels: Array(7).fill("mock"), seed: 31, dealSeed: 77 };

/** Registers a running human game and returns its seat and token. */
function register(id: string, pickRole?: string) {
  const config = { ...CONFIG, seatModels: [...CONFIG.seatModels] };
  const dealt = buildPlayers(config, makeRng(config.seed));
  const seatId = (pickRole ? dealt.find((p) => p.role === pickRole) : dealt[0])!.id;
  config.seatModels[seatId] = "human";
  const players = buildPlayers(config, makeRng(config.seed));
  const { token, hash } = newSeatToken();
  const seat = newHumanSeat(seatId, players[seatId].role, players[seatId].alignment, hash);
  const game = createLive(id, "2026-01-01T00:00:00.000Z", config, players, seat);
  return { game, seat, token, cookie: `${seatCookieName(id)}=${token}` };
}

const voteSpec = () => buildPromptSpec("vote", makeView("villager"));
/** Lets the microtasks of an already-settled promise run under fake timers. */
const flush = () => vi.advanceTimersByTimeAsync(0);

function track<T>(p: Promise<T>) {
  const box: { done: boolean; value?: T } = { done: false };
  void p.then((v) => {
    box.done = true;
    box.value = v;
  });
  return box;
}

beforeEach(() => {
  __resetLiveForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  __resetLiveForTests();
  vi.useRealTimers();
});

describe("makePromptPort.ask", () => {
  it("creates a pending prompt with increasing ids and afterSeq at the buffer length", () => {
    const { seat } = register("s1");
    const port = makePromptPort("s1");
    void port.ask(voteSpec());
    expect(seat.pending?.prompt).toMatchObject({ id: "1", kind: "vote", afterSeq: 0, budgetMs: BUDGET_MS.vote });
    expect(seat.pending?.deadlineAt).toBeNull();
    expect(submitAnswer("s1", { promptId: "1", kind: "target", targetId: null })).toEqual({ ok: true });

    pushLive("s1", { kind: "game_start", day: 0 }, 0);
    pushLive("s1", { kind: "phase", phase: "day", day: 1, label: "Day 1" }, 1);
    void port.ask(voteSpec());
    expect(seat.pending?.prompt).toMatchObject({ id: "2", afterSeq: 2 });
  });

  it("fires the state listeners when a prompt appears", () => {
    const { seat } = register("s1");
    const fired = vi.fn();
    seat.stateListeners.add(fired);
    void makePromptPort("s1").ask(voteSpec());
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("resolves null at once for an unknown, bot or finished game", async () => {
    expect(await makePromptPort("nope").ask(voteSpec())).toBeNull();
    createLive("bot", "2026-01-01T00:00:00.000Z", CONFIG, []);
    expect(await makePromptPort("bot").ask(voteSpec())).toBeNull();
    const { seat } = register("s1");
    finishLive("s1", "finished");
    expect(await makePromptPort("s1").ask(voteSpec())).toBeNull();
    expect(seat.pending).toBeNull();
  });
});

describe("the prompt clock", () => {
  it("arms itself after the delivery grace, then times out after the budget", async () => {
    const { seat } = register("s1");
    const answer = track(makePromptPort("s1").ask(voteSpec()));

    await vi.advanceTimersByTimeAsync(DELIVERY_GRACE_MS - 1);
    expect(seat.pending?.deadlineAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(seat.pending?.deadlineAt).toBe(Date.now() + BUDGET_MS.vote);

    await vi.advanceTimersByTimeAsync(BUDGET_MS.vote - 1);
    expect(answer.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ done: true, value: null });
    expect(seat.pending).toBeNull();
    expect(seat.lastResolved).toEqual({ id: "1", outcome: "timeout" });
    expect(seat.missed).toBe(1);
  });

  it("armPrompt starts the clock, is idempotent and returns the remaining time", async () => {
    const { seat } = register("s1");
    const answer = track(makePromptPort("s1").ask(voteSpec()));
    expect(armPrompt("s1", "1")).toBe(BUDGET_MS.vote);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(armPrompt("s1", "1")).toBe(BUDGET_MS.vote - 10_000);
    expect(armPrompt("s1", "2")).toBeNull();
    expect(armPrompt("missing", "1")).toBeNull();

    // The grace timer was replaced: nothing fires at the 30 s mark, only at the budget.
    await vi.advanceTimersByTimeAsync(BUDGET_MS.vote - 10_000 - 1);
    expect(answer.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(answer).toEqual({ done: true, value: null });
    expect(seat.missed).toBe(1);
  });
});

describe("submitAnswer", () => {
  it("rejects a stale id and an invalid answer, leaving the prompt open", async () => {
    const { seat } = register("s1");
    const answer = track(makePromptPort("s1").ask(voteSpec()));
    expect(submitAnswer("s1", { promptId: "9", kind: "target", targetId: null })).toMatchObject({ ok: false, status: 409 });
    expect(submitAnswer("s1", { kind: "target", targetId: null })).toMatchObject({ ok: false, status: 409 });
    expect(submitAnswer("s1", null)).toMatchObject({ ok: false, status: 409 });
    expect(submitAnswer("s1", { promptId: "1", kind: "target", targetId: 0 })).toMatchObject({ ok: false, status: 400 });
    expect(submitAnswer("s1", { promptId: "1", kind: "text", text: "x" })).toMatchObject({ ok: false, status: 400 });
    await flush();
    expect(answer.done).toBe(false);
    expect(seat.pending?.prompt.id).toBe("1");
  });

  it("resolves a valid answer exactly once", async () => {
    const { seat } = register("s1");
    const resolved = vi.fn();
    void makePromptPort("s1").ask(voteSpec()).then(resolved);
    expect(submitAnswer("s1", { promptId: "1", kind: "target", targetId: 3, extra: "x" })).toEqual({ ok: true });
    expect(submitAnswer("s1", { promptId: "1", kind: "target", targetId: 4 })).toMatchObject({ ok: false, status: 409 });
    await vi.advanceTimersByTimeAsync(DELIVERY_GRACE_MS + BUDGET_MS.vote + 1000);
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith({ kind: "target", targetId: 3 } satisfies SeatAnswer);
    expect(seat.lastResolved).toEqual({ id: "1", outcome: "submitted" });
    expect(seat.missed).toBe(0);
  });

  it("returns 409 when there is no prompt or no game", () => {
    register("s1");
    expect(submitAnswer("s1", { promptId: "1", kind: "target", targetId: null })).toMatchObject({ status: 409 });
    expect(submitAnswer("nope", { promptId: "1", kind: "target", targetId: null })).toMatchObject({ status: 409 });
  });
});

describe("autopilot", () => {
  const timeOut = async (id: string) => {
    const answer = track(makePromptPort(id).ask(voteSpec()));
    await vi.advanceTimersByTimeAsync(DELIVERY_GRACE_MS + BUDGET_MS.vote);
    expect(answer).toEqual({ done: true, value: null });
  };

  it("starts after two consecutive timeouts and answers null with no prompt", async () => {
    const { seat } = register("s1");
    expect(AUTOPILOT_AFTER_MISSES).toBe(2);
    await timeOut("s1");
    expect(seat.autopilot).toBe(false);
    await timeOut("s1");
    expect(seat.autopilot).toBe(true);

    const fired = vi.fn();
    seat.stateListeners.add(fired);
    expect(await makePromptPort("s1").ask(voteSpec())).toBeNull();
    expect(seat.pending).toBeNull();
    expect(seat.promptSeq).toBe(2);
    expect(fired).not.toHaveBeenCalled();
  });

  it("is put off by a successful submit between timeouts", async () => {
    const { seat } = register("s1");
    await timeOut("s1");
    void makePromptPort("s1").ask(voteSpec());
    expect(submitAnswer("s1", { promptId: "2", kind: "target", targetId: null })).toEqual({ ok: true });
    expect(seat.missed).toBe(0);
    await timeOut("s1");
    expect(seat.autopilot).toBe(false);
  });

  it("ends with resumeSeat", async () => {
    const { seat } = register("s1");
    await timeOut("s1");
    await timeOut("s1");
    const fired = vi.fn();
    seat.stateListeners.add(fired);
    resumeSeat("s1");
    expect(seat).toMatchObject({ autopilot: false, missed: 0 });
    expect(fired).toHaveBeenCalledTimes(1);
    void makePromptPort("s1").ask(voteSpec());
    expect(seat.pending?.prompt.id).toBe("3");
  });
});

describe("closeSeat", () => {
  it("resolves the pending prompt with null and clears its timer", async () => {
    const { seat } = register("s1");
    const answer = track(makePromptPort("s1").ask(voteSpec()));
    finishLive("s1", "abandoned");
    closeSeat("s1");
    await flush();
    expect(answer).toEqual({ done: true, value: null });
    expect(seat.pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(seat.missed).toBe(0);
  });

  it("fires the state listeners even with no prompt pending, after the status changed", () => {
    const { seat, game } = register("s1");
    const seen: string[] = [];
    seat.stateListeners.add(() => seen.push(game.status));
    finishLive("s1", "finished");
    closeSeat("s1");
    expect(seen).toEqual(["finished"]);
  });
});

describe("listener safety", () => {
  it("a throwing state listener is removed and never breaks the seat", async () => {
    const { seat } = register("s1");
    const bad = vi.fn(() => {
      throw new Error("listener down");
    });
    const good = vi.fn();
    seat.stateListeners.add(bad);
    seat.stateListeners.add(good);

    const answer = track(makePromptPort("s1").ask(voteSpec()));
    expect(bad).toHaveBeenCalledTimes(1);
    expect(seat.stateListeners.has(bad)).toBe(false);
    expect(good).toHaveBeenCalledTimes(1);

    seat.stateListeners.add(bad);
    expect(() => submitAnswer("s1", { promptId: "1", kind: "target", targetId: null })).not.toThrow();
    await flush();
    expect(answer.done).toBe(true);

    seat.stateListeners.add(bad);
    expect(() => resumeSeat("s1")).not.toThrow();

    seat.stateListeners.add(bad);
    const second = track(makePromptPort("s1").ask(voteSpec()));
    seat.stateListeners.add(bad);
    await vi.advanceTimersByTimeAsync(DELIVERY_GRACE_MS + BUDGET_MS.vote);
    expect(second).toEqual({ done: true, value: null });

    seat.stateListeners.add(bad);
    expect(() => closeSeat("s1")).not.toThrow();
    expect(seat.stateListeners.has(bad)).toBe(false);
    expect(good.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});

describe("verifySeat", () => {
  it("accepts the right cookie, also among other cookies", () => {
    const { cookie, seat } = register("s1");
    const v = verifySeat("s1", `theme=dark; ${cookie}; other=1`);
    expect(v.ok && v.seat).toBe(seat);
  });

  it("401s a missing, wrong, or other game's cookie", () => {
    const a = register("s1");
    const b = register("s2");
    expect(verifySeat("s1", null)).toEqual({ ok: false, status: 401 });
    expect(verifySeat("s1", "")).toEqual({ ok: false, status: 401 });
    expect(verifySeat("s1", `${seatCookieName("s1")}=wrong`)).toEqual({ ok: false, status: 401 });
    expect(verifySeat("s1", `${seatCookieName("s1")}=`)).toEqual({ ok: false, status: 401 });
    expect(verifySeat("s1", b.cookie)).toEqual({ ok: false, status: 401 });
    expect(verifySeat("s1", `${seatCookieName("s1")}=${b.token}`)).toEqual({ ok: false, status: 401 });
    expect(verifySeat("s2", a.cookie)).toEqual({ ok: false, status: 401 });
  });

  it("404s an unknown game, a bot game and a malformed id", () => {
    const { cookie } = register("s1");
    createLive("bot", "2026-01-01T00:00:00.000Z", CONFIG, []);
    expect(verifySeat("nope", cookie)).toEqual({ ok: false, status: 404 });
    expect(verifySeat("bot", cookie)).toEqual({ ok: false, status: 404 });
    for (const id of ["", "../s1", "s1/..", "a b", "x".repeat(65), "s1;"]) {
      expect(verifySeat(id, cookie)).toEqual({ ok: false, status: 404 });
    }
  });

  it("stores only a hash of the token", () => {
    const { seat, token } = register("s1");
    expect(seat.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(seat.tokenHash)).not.toContain(token);
    expect(Buffer.from(token, "base64url").length).toBe(32);
  });
});

describe("buildSeatCookie", () => {
  it("is HttpOnly, SameSite=Strict, scoped to the seat path, Secure only when asked", () => {
    const plain = buildSeatCookie("abc", "tok", false);
    expect(plain).toBe("al_seat_abc=tok; Path=/api/games/abc/seat; HttpOnly; SameSite=Strict; Max-Age=21600");
    expect(plain).not.toContain("Secure");
    expect(buildSeatCookie("abc", "tok", true).endsWith("; Secure")).toBe(true);
  });
});

describe("seatMeta", () => {
  it("carries no seed, no config and no role but the seat's own", () => {
    for (const role of ["werewolf", "villager", "seer"]) {
      __resetLiveForTests();
      const { game, seat } = register("s1", role);
      const meta = seatMeta(game);
      const json = JSON.stringify(meta);
      expect(json).not.toContain("seed");
      expect(json).not.toContain("config");
      expect(json).not.toContain("tokenHash");
      expect(meta.you).toMatchObject({ seatId: seat.seatId, role, name: game.players[seat.seatId].name });
      expect(Object.keys(meta).sort()).toEqual(
        ["createdAt", "id", "numPlayers", "packmates", "players", "roleCounts", "status", "you"].sort()
      );
      for (const p of meta.players) expect(Object.keys(p).sort()).toEqual(["avatar", "id", "model", "name"]);
      expect(meta.players[seat.seatId].model).toBe("human");
      const otherWolves = game.players.filter((p) => p.role === "werewolf" && p.id !== seat.seatId).map((p) => p.id);
      expect(meta.packmates).toEqual(role === "werewolf" ? otherWolves : []);
      if (role === "werewolf") expect(otherWolves.length).toBe(1);
      expect(meta.roleCounts).toMatchObject({ werewolf: 2, seer: 1, doctor: 1 });
    }
  });
});

describe("seatStatus", () => {
  it("hides a prompt the stream has not caught up to", () => {
    const { seat } = register("s1");
    pushLive("s1", { kind: "game_start", day: 0 }, 0);
    pushLive("s1", { kind: "phase", phase: "day", day: 1, label: "Day 1" }, 1);
    void makePromptPort("s1").ask(voteSpec());
    expect(seatStatus(seat, 1)).toEqual({ prompt: null, remainingMs: null, autopilot: false, lastResolved: null });
    armPrompt("s1", "1");
    vi.advanceTimersByTime(5000);
    const shown = seatStatus(seat, 2);
    expect(shown.prompt?.id).toBe("1");
    expect(shown.remainingMs).toBe(BUDGET_MS.vote - 5000);
  });
});

describe("runningHumanGames", () => {
  it("counts only running games with a human seat", () => {
    register("s1");
    register("s2");
    createLive("bot", "2026-01-01T00:00:00.000Z", CONFIG, []);
    expect(runningHumanGames()).toBe(2);
    finishLive("s1", "finished");
    expect(runningHumanGames()).toBe(1);
    expect(getLive("s1")?.status).toBe("finished");
  });
});
