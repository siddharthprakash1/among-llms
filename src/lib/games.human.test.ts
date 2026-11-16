import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  saveTranscript: vi.fn(async (_t: unknown) => {}),
  updateLeaderboard: vi.fn(async () => ({})),
  brainsFail: false,
}));

// Nothing here may write to ./data.
vi.mock("./store", () => ({
  store: {
    saveTranscript: fake.saveTranscript,
    updateLeaderboard: fake.updateLeaderboard,
    getTranscript: async () => null,
    listSummaries: async () => [],
    getLeaderboard: async () => ({}),
  },
}));

vi.mock("./agents/brains", async (orig) => {
  const real = await orig<typeof import("./agents/brains")>();
  return {
    buildBrainFactory: (seed: number) =>
      fake.brainsFail
        ? () => {
            throw new Error("no brains");
          }
        : real.buildBrainFactory(seed),
  };
});

import { buildConfig, createHumanGame, CreateHumanGameInput, HumanGameDeps } from "./games";
import { __resetLiveForTests, createLive, finishLive, getLive } from "./live";
import { BUDGET_MS, DELIVERY_GRACE_MS, MAX_RUNNING_HUMAN_GAMES, newHumanSeat } from "./human/seat";
import { buildPlayers } from "./engine/roles";
import { makeRng } from "./engine/rng";
import type { Transcript } from "./engine/types";

const DEPS: Required<HumanGameDeps> = { seed: 1234, dealSeed: 98765, botSeed: 555, pickIndex: () => 0 };
const INPUT: CreateHumanGameInput = { numPlayers: 7, seatModels: ["mock"] };

function create(input: CreateHumanGameInput = INPUT, deps = DEPS) {
  const result = createHumanGame(input, deps);
  if ("error" in result) throw new Error("busy");
  return { ...result, game: getLive(result.id)! };
}

/** Advances fake time until the game leaves "running" (the seat never answers). */
async function runOut(id: string) {
  for (let i = 0; i < 400 && getLive(id)?.status === "running"; i++) {
    await vi.advanceTimersByTimeAsync(DELIVERY_GRACE_MS + BUDGET_MS.statement);
  }
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  __resetLiveForTests();
  fake.saveTranscript.mockReset().mockResolvedValue(undefined);
  fake.updateLeaderboard.mockReset().mockResolvedValue({});
  fake.brainsFail = false;
  vi.useFakeTimers();
});
afterEach(async () => {
  // A game still simulating in the background finds its registry entry gone,
  // gets null from its port and runs to the end: let it, before the next test.
  __resetLiveForTests();
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  vi.restoreAllMocks();
});

describe("buildConfig", () => {
  it("never seats the reserved human id", () => {
    expect(buildConfig({ seatModels: ["human"] }).seatModels.every((m) => m === "mock")).toBe(true);
  });
});

describe("createHumanGame", () => {
  it("ignores a supplied seed and roleCounts, and seats exactly one human", () => {
    const hostile = { ...INPUT, seed: 42, roleCounts: { werewolf: 5 }, dealSeed: 1 } as CreateHumanGameInput;
    const { game, id, token, ...rest } = create(hostile);
    expect(rest).toEqual({});
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(token.length).toBeGreaterThan(40);
    expect(game.config.seed).toBe(DEPS.seed);
    expect(game.config.dealSeed).toBe(DEPS.dealSeed);
    expect(game.config.dealSeed).not.toBe(game.config.seed);
    expect(game.config).not.toHaveProperty("roleCounts");
    expect(game.config.seatModels.filter((m) => m === "human").length).toBe(1);
    expect(game.players.filter((p) => p.model === "human").map((p) => p.id)).toEqual([game.human!.seatId]);
    expect(game.players.filter((p) => p.role === "werewolf").length).toBe(2);
    expect(game.human!.tokenHash).not.toContain(token);
  });

  it("returns only an id and a token", () => {
    const result = createHumanGame(INPUT, DEPS);
    expect(Object.keys(result).sort()).toEqual(["id", "token"]);
    expect(JSON.stringify(result)).not.toContain(String(DEPS.seed));
  });

  it("honours a role preference when that role is dealt", () => {
    for (const role of ["werewolf", "seer", "doctor", "hunter", "villager"]) {
      __resetLiveForTests();
      const { game } = create({ ...INPUT, role });
      expect(game.human!.role).toBe(role);
      expect(game.players[game.human!.seatId].role).toBe(role);
    }
  });

  it("picks any seat when the role is unknown or not dealt", () => {
    const { game } = create({ ...INPUT, role: "witch" }); // no witch at 7 seats
    expect(game.human!.seatId).toBe(0);
    __resetLiveForTests();
    const last = create({ ...INPUT, role: "nonsense" }, { ...DEPS, pickIndex: (n) => n - 1 });
    expect(last.game.human!.seatId).toBe(6);
  });

  it("deals from dealSeed while names come from seed alone", () => {
    const { game } = create();
    const base = { numPlayers: 7, seatModels: game.config.seatModels, seed: DEPS.seed };
    const withDeal = buildPlayers({ ...base, dealSeed: DEPS.dealSeed }, makeRng(DEPS.seed));
    const otherDeal = buildPlayers({ ...base, dealSeed: DEPS.dealSeed + 1 }, makeRng(DEPS.seed));
    const without = buildPlayers(base, makeRng(DEPS.seed));
    expect(game.players).toEqual(withDeal);
    // The identity stream never sees dealSeed: another deal keeps every name and avatar.
    expect(game.players.map((p) => p.name + p.avatar)).toEqual(otherDeal.map((p) => p.name + p.avatar));
    expect(game.players.map((p) => p.role)).not.toEqual(otherDeal.map((p) => p.role));
    expect(game.players.map((p) => p.role)).not.toEqual(without.map((p) => p.role));
  });

  it("finishes on autopilot when nobody answers, saved once and never rated", async () => {
    const { id, game } = create({ ...INPUT, role: "werewolf" });
    const seat = game.human!;
    await runOut(id);
    expect(game.status).toBe("finished");
    expect(seat.promptSeq).toBe(2);
    expect(seat.autopilot).toBe(true);
    expect(fake.saveTranscript).toHaveBeenCalledTimes(1);
    expect(fake.updateLeaderboard).not.toHaveBeenCalled();
    const saved = fake.saveTranscript.mock.calls[0][0] as Transcript;
    expect(saved.decisions?.some((d) => d.playerId === seat.seatId && d.source === "bot")).toBe(true);
    expect(saved.id).toBe(id);
    expect(saved.events.at(-1)?.kind).toBe("game_over");
    expect(saved.config.dealSeed).toBe(DEPS.dealSeed);
    expect(saved.outcomes.filter((o) => o.model === "human").length).toBe(1);
    expect(JSON.stringify(saved)).not.toContain(String(DEPS.botSeed));
    expect(seat.events.at(-1)?.kind).toBe("game_over");
    expect(seat.pending).toBeNull();
  });

  it("stays finished when the save fails after game_over, and tells the seat", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.saveTranscript.mockRejectedValue(new Error("disk full"));
    const { id, game } = create({ ...INPUT, role: "werewolf" });
    const seen: string[] = [];
    game.human!.stateListeners.add(() => seen.push(game.status));
    await runOut(id);
    expect(game.status).toBe("finished");
    expect(seen.at(-1)).toBe("finished");
    expect(err).toHaveBeenCalledTimes(1);
    expect(fake.updateLeaderboard).not.toHaveBeenCalled();
  });

  it("marks the game abandoned when the simulation fails, and tells an idle seat", async () => {
    fake.brainsFail = true;
    const { game } = create();
    const seen: string[] = [];
    game.human!.stateListeners.add(() => seen.push(game.status));
    await vi.advanceTimersByTimeAsync(0);
    expect(game.status).toBe("abandoned");
    expect(seen).toEqual(["abandoned"]);
    expect(fake.saveTranscript).not.toHaveBeenCalled();
  });

  it("refuses a fourth running human game until one ends", () => {
    const config = buildConfig({ numPlayers: 7 });
    const players = buildPlayers(config, makeRng(config.seed));
    for (let i = 0; i < MAX_RUNNING_HUMAN_GAMES; i++) {
      createLive(`cap${i}`, "2026-01-01T00:00:00.000Z", config, players, newHumanSeat(0, "villager", "good", "0".repeat(64)));
    }
    createLive("bot", "2026-01-01T00:00:00.000Z", config, players);
    expect(createHumanGame(INPUT, DEPS)).toEqual({ error: "busy" });
    finishLive("cap1", "finished");
    expect(createHumanGame(INPUT, DEPS)).toHaveProperty("id");
    expect(createHumanGame(INPUT, DEPS)).toEqual({ error: "busy" });
  });
});
