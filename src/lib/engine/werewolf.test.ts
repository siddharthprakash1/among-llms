import { describe, expect, it } from "vitest";
import { simulate, winnerFor, tallyVotes, pluralityPick } from "./werewolf";
import { buildPlayers, defaultRoleCounts } from "./roles";
import { makeRng } from "./rng";
import { BrainFactory, GameConfig, Player, PlayerView, Role, Transcript, WitchDecision } from "./types";
import { buildBrainFactory } from "../agents/brains";

const OPTS = { id: "test", createdAt: "2026-01-01T00:00:00.000Z" };

function makeConfig(numPlayers = 7, seed = 1): GameConfig {
  return { numPlayers, seatModels: Array(numPlayers).fill("mock"), seed };
}

function mockGame(numPlayers = 7, seed = 1): Promise<Transcript> {
  return simulate(makeConfig(numPlayers, seed), buildBrainFactory(seed), OPTS);
}

describe("role setup", () => {
  it("derives the spec's 7-player distribution", () => {
    expect(defaultRoleCounts(7)).toEqual({
      werewolf: 2, seer: 1, doctor: 1, hunter: 1, witch: 0, jester: 0, villager: 2,
    });
  });

  it("matches the spec table for every size", () => {
    const wolves = { 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 3, 11: 3, 12: 4 } as Record<number, number>;
    for (let n = 5; n <= 12; n++) {
      const c = defaultRoleCounts(n);
      expect(c.werewolf).toBe(wolves[n]);
      expect(c.seer).toBe(1);
      expect(c.doctor).toBe(1);
      expect(c.hunter).toBe(n >= 6 ? 1 : 0);
      expect(c.witch).toBe(n >= 8 ? 1 : 0);
      expect(c.jester).toBe(n >= 9 ? 1 : 0);
      expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(n);
    }
  });

  it("replaces disabled specials with villagers", () => {
    const c = defaultRoleCounts(9, ["jester", "witch"]);
    expect(c.jester).toBe(0);
    expect(c.witch).toBe(0);
    expect(c.villager).toBe(4);
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(9);
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
      expect(["good", "evil", "jester"]).toContain(t.result.winner);
      // ends with a game_over event
      expect(t.events.at(-1)?.kind).toBe("game_over");
      // survivors are exactly the alive players
      const alive = t.players.filter((p) => p.alive).map((p) => p.id).sort();
      expect(t.result.survivorIds.slice().sort()).toEqual(alive);
      // outcomes are consistent with the declared winner
      for (const o of t.outcomes) {
        const expected = t.result.winner === "jester" ? o.role === "jester" : o.alignment === t.result.winner;
        expect(o.won).toBe(expected);
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

  it("mock games at 9+ players produce wolf chat, accusations, and defenses", async () => {
    let chats = 0, accusations = 0, defenses = 0;
    for (const seed of [3, 11, 29]) {
      const t = await mockGame(9, seed);
      chats += t.events.filter((e) => e.kind === "wolf_chat").length;
      accusations += t.events.filter((e) => e.kind === "accusation").length;
      defenses += t.events.filter((e) => e.kind === "defense").length;
    }
    expect(chats).toBeGreaterThan(0);
    expect(accusations).toBeGreaterThan(0);
    expect(defenses).toBeGreaterThan(0);
  });

  it("witch and hunter mock heuristics only ever act legally", async () => {
    for (let seed = 100; seed < 120; seed++) {
      const t = await mockGame(10, seed);
      const witchActs = t.events.filter((e) => e.kind === "witch_action");
      expect(witchActs.filter((e) => e.action === "heal").length).toBeLessThanOrEqual(1);
      expect(witchActs.filter((e) => e.action === "poison").length).toBeLessThanOrEqual(1);
      for (const e of t.events) {
        if (e.kind === "hunter_shot") expect(e.hunterId).not.toBe(e.targetId);
      }
    }
  });
});

describe("three-beat day + wolf chat", () => {
  it("orders day events statements → accusations → defenses → votes", async () => {
    const t = await mockGame(9, 42);
    const day1 = t.events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => "day" in e && e.day === 1 && ["statement", "accusation", "defense", "vote"].includes(e.kind));
    const rank = { statement: 0, accusation: 1, defense: 2, vote: 3 } as Record<string, number>;
    for (let j = 1; j < day1.length; j++) {
      expect(rank[day1[j].e.kind]).toBeGreaterThanOrEqual(rank[day1[j - 1].e.kind]);
    }
  });

  it("wolf chat only happens with 2+ wolves and only wolves speak in it", async () => {
    const t9 = await mockGame(9, 7); // 2 wolves
    const wolfIds = new Set(t9.players.filter((p) => p.role === "werewolf").map((p) => p.id));
    const chats = t9.events.filter((e) => e.kind === "wolf_chat");
    expect(chats.length).toBeGreaterThan(0);
    for (const c of chats) expect(wolfIds.has(c.wolfId)).toBe(true);

    const t5 = await mockGame(5, 7); // 1 wolf → no chat
    expect(t5.events.some((e) => e.kind === "wolf_chat")).toBe(false);
  });

  it("accusations target living non-self players; defenses come from the accused", async () => {
    const t = await mockGame(9, 99);
    const aliveAt = new Set(t.players.map((p) => p.id));
    for (const e of t.events) {
      if (e.kind === "death") aliveAt.delete(e.playerId);
      if (e.kind === "accusation") {
        expect(e.from).not.toBe(e.target);
        expect(aliveAt.has(e.target)).toBe(true);
        expect(aliveAt.has(e.from)).toBe(true);
      }
    }
    const accusedByDay = new Map<number, Set<number>>();
    for (const e of t.events) {
      if (e.kind === "accusation") {
        if (!accusedByDay.has(e.day)) accusedByDay.set(e.day, new Set());
        accusedByDay.get(e.day)!.add(e.target);
      }
      if (e.kind === "defense") expect(accusedByDay.get(e.day)?.has(e.playerId)).toBe(true);
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

describe("witch, hunter, jester (scripted)", () => {
  const CFG = (seed: number, roleCounts: Partial<Record<Role, number>>, n = 7): GameConfig => ({
    numPlayers: n, seatModels: Array(n).fill("mock"), seed, roleCounts,
  });

  function brainsFor(
    players: Player[],
    script: {
      wolfTarget?: (p: Player[]) => number;
      witch?: (view: PlayerView, wolfTarget: number | null) => WitchDecision;
      hunterTarget?: (p: Player[]) => number;
      votes?: (self: Player, p: Player[]) => number | null;
    }
  ): BrainFactory {
    return (modelId, seatId) => ({
      id: modelId,
      async nightAction() {
        const role = players[seatId].role;
        if (role === "werewolf" && script.wolfTarget) return { targetId: script.wolfTarget(players) };
        return { targetId: null };
      },
      async dayStatement() { return "…"; },
      async dayVote() { return { targetId: script.votes ? script.votes(players[seatId], players) : null }; },
      async witchAction(view, wolfTargetId) {
        return script.witch ? script.witch(view, wolfTargetId) : { heal: false, poisonTargetId: null };
      },
      async hunterShot() {
        return { targetId: script.hunterTarget ? script.hunterTarget(players) : null };
      },
    });
  }

  it("witch heal cancels the wolf kill and is single-use; poison is unblockable", async () => {
    const config = CFG(11, { werewolf: 1, seer: 0, doctor: 0, witch: 1, hunter: 0, jester: 0, villager: 5 });
    const players = buildPlayers(config, makeRng(11));
    const victim = players.find((p) => p.role === "villager")!.id;
    const factory = brainsFor(players, {
      wolfTarget: () => victim,
      witch: (view, wolfTarget) =>
        view.potions?.heal && wolfTarget !== null
          ? { heal: true, poisonTargetId: null }
          : { heal: false, poisonTargetId: null },
    });
    const t = await simulate(config, factory, OPTS);
    const saves = t.events.filter((e) => e.kind === "saved" && e.by === "witch");
    expect(saves.length).toBe(1); // heal potion spent on night 1, never again
    expect(t.events.some((e) => e.kind === "death" && e.day === 1)).toBe(false);
  });

  it("witch poison kills even a doctor-protected player", async () => {
    const config = CFG(13, { werewolf: 1, seer: 0, doctor: 1, witch: 1, hunter: 0, jester: 0, villager: 4 });
    const players = buildPlayers(config, makeRng(13));
    const mark = players.find((p) => p.role === "villager")!.id;
    const factory: BrainFactory = (modelId, seatId) => ({
      id: modelId,
      async nightAction() {
        if (players[seatId].role === "doctor") return { targetId: mark }; // protects the poison target
        return { targetId: null }; // wolf abstains (engine will re-roll: pass legal null through validate → random) — so instead wolf targets the witch's mark too
      },
      async dayStatement() { return "…"; },
      async dayVote() { return { targetId: null }; },
      async witchAction() { return { heal: false, poisonTargetId: mark }; },
    });
    const t = await simulate(config, factory, OPTS);
    const poisonDeath = t.events.find((e) => e.kind === "death" && e.cause === "poison") as
      | { kind: "death"; playerId: number }
      | undefined;
    expect(poisonDeath && poisonDeath.playerId === mark).toBe(true);
  });

  it("a hunter voted out drags a target down before the win check", async () => {
    const config = CFG(17, { werewolf: 2, seer: 0, doctor: 0, witch: 0, hunter: 1, jester: 0, villager: 4 });
    const players = buildPlayers(config, makeRng(17));
    const hunter = players.find((p) => p.role === "hunter")!.id;
    const wolf = players.find((p) => p.role === "werewolf")!.id;
    const factory = brainsFor(players, {
      hunterTarget: () => wolf,
      votes: () => hunter, // everyone votes the hunter out on day 1
    });
    const t = await simulate(config, factory, OPTS);
    const shot = t.events.find((e) => e.kind === "hunter_shot");
    expect(shot).toBeTruthy();
    expect(shot!.hunterId).toBe(hunter);
    expect(shot!.targetId).toBe(wolf);
    expect(t.events.some((e) => e.kind === "death" && e.cause === "hunter" && e.playerId === wolf)).toBe(true);
  });

  it("voting out the jester ends the game immediately with a jester win", async () => {
    const config = CFG(23, { werewolf: 2, seer: 0, doctor: 0, witch: 0, hunter: 0, jester: 1, villager: 4 });
    const players = buildPlayers(config, makeRng(23));
    const jester = players.find((p) => p.role === "jester")!.id;
    const factory = brainsFor(players, { votes: () => jester });
    const t = await simulate(config, factory, OPTS);
    expect(t.result.winner).toBe("jester");
    expect(t.events.at(-1)?.kind).toBe("game_over");
    for (const o of t.outcomes) expect(o.won).toBe(o.role === "jester");
  });
});
