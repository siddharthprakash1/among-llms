import { describe, expect, it } from "vitest";
import { simulate, winnerFor, tallyVotes, pluralityPick } from "./werewolf";
import { buildPlayers, defaultRoleCounts } from "./roles";
import { makeRng } from "./rng";
import { BrainFactory, GameConfig, Transcript } from "./types";
import { buildBrainFactory } from "../agents/brains";

const OPTS = { id: "test", createdAt: "2026-01-01T00:00:00.000Z" };

function makeConfig(numPlayers = 7, seed = 1): GameConfig {
  return { numPlayers, seatModels: Array(numPlayers).fill("mock"), seed };
}

function mockGame(numPlayers = 7, seed = 1): Promise<Transcript> {
  return simulate(makeConfig(numPlayers, seed), buildBrainFactory(seed), OPTS);
}

describe("role setup", () => {
  it("derives the canonical 7-player distribution", () => {
    expect(defaultRoleCounts(7)).toEqual({ werewolf: 2, seer: 1, doctor: 1, villager: 3 });
  });

  it("always has exactly one seer and one doctor and at least one wolf", () => {
    for (let n = 5; n <= 12; n++) {
      const c = defaultRoleCounts(n);
      expect(c.seer).toBe(1);
      expect(c.doctor).toBe(1);
      expect(c.werewolf).toBeGreaterThanOrEqual(1);
      expect(c.werewolf + c.seer + c.doctor + c.villager).toBe(n);
    }
  });

  it("deals every seat exactly one role", () => {
    const players = buildPlayers(makeConfig(8, 3), makeRng(3));
    expect(players).toHaveLength(8);
    expect(players.filter((p) => p.role === "werewolf").length).toBe(2);
    expect(new Set(players.map((p) => p.id)).size).toBe(8);
  });
});

describe("determinism", () => {
  it("produces identical transcripts for the same seed + brains", async () => {
    const a = await mockGame(7, 12345);
    const b = await mockGame(7, 12345);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("produces different games for different seeds", async () => {
    const a = await mockGame(7, 1);
    const b = await mockGame(7, 2);
    expect(JSON.stringify(a.events)).not.toEqual(JSON.stringify(b.events));
  });
});

describe("full games", () => {
  it("always terminate with a valid, consistent winner", async () => {
    for (let seed = 0; seed < 40; seed++) {
      const n = 5 + (seed % 8); // 5..12
      const t = await mockGame(n, seed * 7 + 1);
      expect(["good", "evil"]).toContain(t.result.winner);
      // ends with a game_over event
      expect(t.events.at(-1)?.kind).toBe("game_over");
      // survivors are exactly the alive players
      const alive = t.players.filter((p) => p.alive).map((p) => p.id).sort();
      expect(t.result.survivorIds.slice().sort()).toEqual(alive);
      // outcomes are consistent with the declared winner
      for (const o of t.outcomes) {
        expect(o.won).toBe(o.alignment === t.result.winner);
      }
    }
  });

  it("only ever records legal actions", async () => {
    const t = await mockGame(9, 777);
    const roleOf = new Map(t.players.map((p) => [p.id, p.role]));
    for (const e of t.events) {
      if (e.kind === "wolf_kill") {
        expect(roleOf.get(e.targetId)).not.toBe("werewolf");
      }
      if (e.kind === "vote" && e.targetId !== null) {
        expect(e.targetId).not.toBe(e.voterId);
      }
      if (e.kind === "seer_check") {
        expect(roleOf.get(e.targetId)).toBe(e.result === "evil" ? "werewolf" : roleOf.get(e.targetId));
      }
    }
  });
});

describe("night resolution (scripted brains)", () => {
  function scriptedFactory(seed: number, doctorTargetsVictim: boolean): {
    factory: BrainFactory;
    victim: number;
    wolfId: number;
  } {
    const players = buildPlayers(makeConfig(5, seed), makeRng(seed));
    const wolfId = players.find((p) => p.role === "werewolf")!.id;
    const victim = players.find((p) => p.role === "villager")!.id;
    const factory: BrainFactory = (modelId, seatId) => {
      const role = players[seatId].role;
      return {
        id: modelId,
        async nightAction() {
          if (role === "werewolf") return { targetId: victim };
          if (role === "doctor") return { targetId: doctorTargetsVictim ? victim : seatId };
          if (role === "seer") return { targetId: wolfId };
          return { targetId: null };
        },
        async dayStatement() {
          return "…";
        },
        async dayVote() {
          return { targetId: null }; // everyone abstains → no day elimination
        },
      };
    };
    return { factory, victim, wolfId };
  }

  it("the doctor's protection cancels the wolves' kill", async () => {
    const { factory, victim } = scriptedFactory(5, true);
    const t = await simulate(makeConfig(5, 5), factory, OPTS);
    const day1 = t.events.filter((e) => "day" in e && e.day === 1);
    expect(day1.some((e) => e.kind === "saved" && e.targetId === victim)).toBe(true);
    expect(day1.some((e) => e.kind === "death" && e.cause === "wolves" && e.day === 1)).toBe(false);
  });

  it("an unprotected target dies, and the seer learns the true alignment", async () => {
    const { factory, victim } = scriptedFactory(5, false);
    const t = await simulate(makeConfig(5, 5), factory, OPTS);
    expect(
      t.events.some(
        (e) => e.kind === "death" && e.cause === "wolves" && e.day === 1 && e.playerId === victim
      )
    ).toBe(true);
    expect(t.events.some((e) => e.kind === "seer_check" && e.day === 1 && e.result === "evil")).toBe(
      true
    );
  });
});

describe("pure helpers", () => {
  it("winnerFor encodes the win conditions", () => {
    expect(winnerFor(0, 3)?.winner).toBe("good");
    expect(winnerFor(2, 2)?.winner).toBe("evil");
    expect(winnerFor(3, 1)?.winner).toBe("evil");
    expect(winnerFor(1, 3)).toBeNull();
  });

  it("tallyVotes eliminates a clear plurality and no one on a tie", () => {
    const rng = makeRng(1);
    const clear = tallyVotes(
      [{ targetId: 2 }, { targetId: 2 }, { targetId: 3 }],
      rng
    );
    expect(clear.eliminatedId).toBe(2);
    expect(clear.tie).toBe(false);

    const tie = tallyVotes([{ targetId: 2 }, { targetId: 3 }], rng);
    expect(tie.eliminatedId).toBeNull();
    expect(tie.tie).toBe(true);

    const allAbstain = tallyVotes([{ targetId: null }, { targetId: null }], rng);
    expect(allAbstain.eliminatedId).toBeNull();
    expect(allAbstain.tie).toBe(false);
  });

  it("pluralityPick returns the most common preference", () => {
    const rng = makeRng(1);
    expect(pluralityPick([4, 4, 1], rng)).toBe(4);
    expect(pluralityPick([], rng)).toBeNull();
  });
});
