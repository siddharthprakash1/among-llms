import { describe, expect, it } from "vitest";
import { simulate } from "./werewolf";
import { buildPlayers } from "./roles";
import { makeRng } from "./rng";
import {
  AccuseDecision,
  Brain,
  BrainFactory,
  DecisionRecord,
  DecisionTrace,
  GameConfig,
  GameEvent,
  Player,
  PlayerView,
  Role,
  Transcript,
} from "./types";
import { buildBrainFactory } from "../agents/brains";
import { buildContext } from "../agents/prompts";

const OPTS = { id: "test", createdAt: "2026-01-01T00:00:00.000Z" };

const N_RANDOM = "Illegal target — the engine picked a random legal one.";
const N_RANDOM_NULL = "No target given — the engine picked a random legal one.";
const N_VOTE = "Illegal vote target — counted as an abstain.";
const N_ACCUSE = "Illegal accusation target — ignored.";
const N_EMPTY = "Empty message — nothing was said.";
const N_BOTH = "Both potions requested — the heal wins.";
const N_WITCH_NOTHING = "Requested potion unavailable or target illegal — nothing happened.";

function mockConfig(numPlayers: number, seed: number): GameConfig {
  return { numPlayers, seatModels: Array(numPlayers).fill("mock"), seed };
}

function mockGame(numPlayers: number, seed: number): Promise<Transcript> {
  return simulate(mockConfig(numPlayers, seed), buildBrainFactory(seed), OPTS);
}

async function mockGames(): Promise<Transcript[]> {
  const out: Transcript[] = [];
  for (const n of [9, 10]) for (let seed = 1; seed <= 5; seed++) out.push(await mockGame(n, seed));
  return out;
}

function actorsOf(e: GameEvent): number[] {
  switch (e.kind) {
    case "wolf_chat": return [e.wolfId];
    case "wolf_kill": return e.actorIds;
    case "seer_check": return [e.seerId];
    case "doctor_save": return [e.doctorId];
    case "witch_action": return [e.witchId];
    case "hunter_shot": return [e.hunterId];
    case "statement": return [e.playerId];
    case "accusation": return [e.from];
    case "defense": return [e.playerId];
    case "vote": return [e.voterId];
    default: return [];
  }
}

const decisionsOf = (t: Transcript): DecisionRecord[] => t.decisions ?? [];

// --- scripted-brain scaffolding ---------------------------------------------

function scriptedConfig(roleCounts: Partial<Record<Role, number>>, seed = 11, maxDays = 1): GameConfig {
  const full = { werewolf: 0, seer: 0, doctor: 0, witch: 0, hunter: 0, jester: 0, villager: 0, ...roleCounts };
  const numPlayers = Object.values(full).reduce((a, b) => a + b, 0);
  return { numPlayers, seatModels: Array(numPlayers).fill("mock"), seed, roleCounts: full, maxDays };
}

/** A quiet brain (no night target, "…", abstain) plus per-seat overrides. */
function scripted(
  config: GameConfig,
  overrides: (self: Player, players: Player[]) => Partial<Brain>
): { factory: BrainFactory; players: Player[] } {
  const players = buildPlayers(config, makeRng(config.seed));
  const factory: BrainFactory = (modelId, seatId) => ({
    id: modelId,
    async nightAction() { return { targetId: null }; },
    async dayStatement() { return "…"; },
    async dayVote() { return { targetId: null }; },
    ...overrides(players[seatId], players),
  });
  return { factory, players };
}

const seatOf = (players: Player[], role: Role, nth = 0): number =>
  players.filter((p) => p.role === role)[nth].id;

const STANDARD = { werewolf: 1, seer: 1, doctor: 1, witch: 1, hunter: 1, villager: 2 };

describe("decision records: structure (mock games)", () => {
  it("seq is the index, step is ordered and in range, produced records match their event", async () => {
    for (const t of await mockGames()) {
      const decisions = decisionsOf(t);
      expect(decisions.length).toBeGreaterThan(0);
      decisions.forEach((d, i) => {
        expect(d.seq).toBe(i);
        if (i > 0) expect(d.step).toBeGreaterThanOrEqual(decisions[i - 1].step);
        expect(d.step).toBeGreaterThanOrEqual(1);
        expect(d.step).toBeLessThanOrEqual(t.events.length - 1);
        if (d.produced) {
          const e = t.events[d.step];
          expect(e.kind).toBe(d.kind);
          expect(actorsOf(e)).toContain(d.playerId);
        }
      });
    }
  });

  it("every seat-action event has exactly one producing record (one per wolf for a kill)", async () => {
    const single = ["statement", "vote", "accusation", "defense", "wolf_chat", "seer_check", "doctor_save", "witch_action", "hunter_shot"];
    const seen = new Set<string>();
    for (const t of await mockGames()) {
      const decisions = decisionsOf(t);
      t.events.forEach((e, i) => {
        const producing = decisions.filter((d) => d.produced && d.step === i && d.kind === e.kind);
        if (single.includes(e.kind)) {
          seen.add(e.kind);
          expect(producing).toHaveLength(1);
          expect(actorsOf(e)).toEqual([producing[0].playerId]);
        } else if (e.kind === "wolf_kill") {
          seen.add(e.kind);
          expect(producing.map((d) => d.playerId)).toEqual(e.actorIds);
        } else {
          expect(producing).toHaveLength(0);
        }
      });
    }
    // The sample of games exercises every kind, so the loop above is not vacuous.
    expect([...seen].sort()).toEqual([...single, "wolf_kill"].sort());
  });

  it("events are unaffected by an onDecision listener", async () => {
    const plain = await mockGame(9, 3);
    const seen: DecisionRecord[] = [];
    const observed = await simulate(mockConfig(9, 3), buildBrainFactory(3), {
      ...OPTS,
      onDecision: (r) => seen.push(r),
    });
    expect(observed.events).toEqual(plain.events);
    expect(seen).toEqual(observed.decisions);
  });
});

describe("decision records: mock rationales", () => {
  it("are all heuristic-sourced, explained, clock-free and reproducible", async () => {
    for (const t of await mockGames()) {
      for (const d of decisionsOf(t)) {
        expect(d.source).toBe("bot");
        expect(typeof d.reasoning).toBe("string");
        expect(d.reasoning!.length).toBeGreaterThan(0);
        expect(d.reasoning!.length).toBeLessThanOrEqual(600);
      }
      expect(JSON.stringify(t.decisions)).not.toContain("latencyMs");
    }
    const a = await mockGame(10, 4);
    const b = await mockGame(10, 4);
    expect(JSON.stringify(a.decisions)).toEqual(JSON.stringify(b.decisions));
  });

  it("capture decisions that emit no event", async () => {
    const all = (await mockGames()).flatMap(decisionsOf);
    expect(all.some((d) => d.kind === "accusation" && !d.produced)).toBe(true);
    expect(all.some((d) => d.kind === "witch_action" && !d.produced)).toBe(true);
  });
});

describe("decision records: redaction", () => {
  /** Wraps every MockBrain: logs each view and trace it is handed, then plants a secret. */
  function spyFactory(seed: number) {
    const views: PlayerView[] = [];
    const traces: DecisionTrace[] = [];
    const entrySnapshots: string[] = [];
    const inner = buildBrainFactory(seed);
    const factory: BrainFactory = (modelId, seatId) => {
      const brain = inner(modelId, seatId);
      const wrap = async <T>(view: PlayerView, trace: DecisionTrace | undefined, call: () => Promise<T>) => {
        views.push(view);
        if (trace) {
          traces.push(trace);
          entrySnapshots.push(JSON.stringify(trace));
        }
        const out = await call();
        if (trace) trace.reasoning = `ZZ-SECRET-${seatId}`;
        return out;
      };
      return {
        id: brain.id,
        nightAction: (v, tr) => wrap(v, tr, () => brain.nightAction(v, tr)),
        dayStatement: (v, tr) => wrap(v, tr, () => brain.dayStatement(v, tr)),
        dayVote: (v, tr) => wrap(v, tr, () => brain.dayVote(v, tr)),
        wolfChat: (v, round, tr) => wrap(v, tr, () => brain.wolfChat!(v, round, tr)),
        accuse: (v, tr) => wrap(v, tr, () => brain.accuse!(v, tr)),
        defend: (v, against, tr) => wrap(v, tr, () => brain.defend!(v, against, tr)),
        witchAction: (v, target, tr) => wrap(v, tr, () => brain.witchAction!(v, target, tr)),
        hunterShot: (v, tr) => wrap(v, tr, () => brain.hunterShot!(v, tr)),
      };
    };
    return { factory, views, traces, entrySnapshots };
  }

  it("reasoning never reaches a PlayerView or a prompt context", async () => {
    for (const seed of [2, 5]) {
      const spy = spyFactory(seed);
      const t = await simulate(mockConfig(10, seed), spy.factory, OPTS);
      // Proves the test is live: the planted secret did get recorded.
      expect(JSON.stringify(t.decisions)).toContain("ZZ-SECRET");
      expect(decisionsOf(t).every((d) => d.reasoning === `ZZ-SECRET-${d.playerId}`)).toBe(true);
      expect(spy.views.length).toBeGreaterThan(20);
      for (const view of spy.views) {
        expect(JSON.stringify(view)).not.toContain("ZZ-SECRET");
        expect(buildContext(view)).not.toContain("ZZ-SECRET");
      }
      expect(JSON.stringify(t.events)).not.toContain("ZZ-SECRET");
    }
  });

  it("hands every call its own trace object, empty on entry", async () => {
    const spy = spyFactory(3);
    const t = await simulate(mockConfig(10, 3), spy.factory, OPTS);
    expect(spy.traces.length).toBe(decisionsOf(t).length);
    expect(new Set(spy.traces).size).toBe(spy.traces.length);
    expect(spy.entrySnapshots.every((s) => s === "{}")).toBe(true);
  });
});

describe("decision records: engine rulings (scripted brains)", () => {
  it("clamps an illegal wolf target to a random legal one", async () => {
    const config = scriptedConfig(STANDARD);
    const { factory, players } = scripted(config, (self) =>
      self.role === "werewolf" ? { async nightAction() { return { targetId: 99 }; } } : {}
    );
    const t = await simulate(config, factory, OPTS);
    const rec = decisionsOf(t).find((d) => d.kind === "wolf_kill")!;
    expect(rec.ruling).toBe("clamped");
    expect(rec.rulingNote).toBe(N_RANDOM);
    expect(rec.requested).toEqual({ targetId: 99 });
    const applied = rec.applied!.targetId!;
    expect(players[applied].role).not.toBe("werewolf");
    expect(rec.produced).toBe(true);
    expect(rec.source).toBe("unknown");
  });

  it("clamps a missing wolf target and says so", async () => {
    const config = scriptedConfig(STANDARD);
    const { factory } = scripted(config, () => ({}));
    const t = await simulate(config, factory, OPTS);
    const rec = decisionsOf(t).find((d) => d.kind === "wolf_kill")!;
    expect(rec.ruling).toBe("clamped");
    expect(rec.rulingNote).toBe(N_RANDOM_NULL);
    expect(rec.requested).toEqual({ targetId: null });
    expect(rec.applied!.targetId).not.toBeNull();
  });

  it("counts a self-vote as an abstain", async () => {
    const config = scriptedConfig(STANDARD);
    const { factory } = scripted(config, (self) => ({
      async dayVote() { return { targetId: self.id }; },
    }));
    const t = await simulate(config, factory, OPTS);
    const votes = decisionsOf(t).filter((d) => d.kind === "vote");
    expect(votes.length).toBeGreaterThan(0);
    for (const v of votes) {
      expect(v.requested).toEqual({ targetId: v.playerId });
      expect(v.applied).toEqual({ targetId: null });
      expect(v.ruling).toBe("clamped");
      expect(v.rulingNote).toBe(N_VOTE);
      expect(v.produced).toBe(true);
    }
  });

  it("separates an illegal accusation, a garbage accusation and a pass", async () => {
    const config = scriptedConfig(STANDARD);
    const players = buildPlayers(config, makeRng(config.seed));
    const selfAccuser = seatOf(players, "villager", 0);
    const garbage = seatOf(players, "villager", 1);
    const { factory } = scripted(config, (self) => ({
      async accuse() {
        if (self.id === selfAccuser) return { targetId: self.id };
        if (self.id === garbage) return {} as AccuseDecision;
        return { targetId: null };
      },
    }));
    const t = await simulate(config, factory, OPTS);
    const accs = decisionsOf(t).filter((d) => d.kind === "accusation");
    expect(t.events.some((e) => e.kind === "accusation")).toBe(false);

    const illegal = accs.find((d) => d.playerId === selfAccuser)!;
    expect(illegal).toMatchObject({
      ruling: "dropped", rulingNote: N_ACCUSE, produced: false,
      requested: { targetId: selfAccuser }, applied: { targetId: null },
    });

    const junk = accs.find((d) => d.playerId === garbage)!;
    expect(junk).toMatchObject({
      ruling: "dropped", rulingNote: N_ACCUSE, produced: false,
      requested: { targetId: null }, applied: { targetId: null },
    });

    const passes = accs.filter((d) => d.playerId !== selfAccuser && d.playerId !== garbage);
    expect(passes.length).toBeGreaterThan(0);
    for (const p of passes) {
      expect(p).toMatchObject({
        ruling: "accepted", produced: false, requested: { targetId: null }, applied: { targetId: null },
      });
      expect(p).not.toHaveProperty("rulingNote");
    }
  });

  it("lets the heal win when the witch asks for both potions", async () => {
    const config = scriptedConfig(STANDARD);
    const { factory, players } = scripted(config, (self, all) => ({
      async witchAction() {
        return { heal: true, poisonTargetId: all.find((p) => p.role === "werewolf")!.id };
      },
    }));
    const t = await simulate(config, factory, OPTS);
    const rec = decisionsOf(t).find((d) => d.kind === "witch_action")!;
    expect(rec).toMatchObject({
      ruling: "clamped", rulingNote: N_BOTH, produced: true,
      requested: { targetId: seatOf(players, "werewolf"), heal: true },
      applied: { targetId: null, heal: true },
    });
    expect(t.events[rec.step]).toMatchObject({ kind: "witch_action", action: "heal" });
  });

  it("drops a witch poisoning herself", async () => {
    const config = scriptedConfig(STANDARD);
    const { factory } = scripted(config, (self) => ({
      async witchAction() { return { heal: false, poisonTargetId: self.id }; },
    }));
    const t = await simulate(config, factory, OPTS);
    const rec = decisionsOf(t).find((d) => d.kind === "witch_action")!;
    expect(rec).toMatchObject({
      ruling: "dropped", rulingNote: N_WITCH_NOTHING, produced: false,
      requested: { targetId: rec.playerId, heal: false },
      applied: { targetId: null, heal: false },
    });
    expect(t.events.some((e) => e.kind === "witch_action")).toBe(false);
  });

  it("accepts legal choices with no rulingNote key", async () => {
    const config = scriptedConfig(STANDARD);
    const players = buildPlayers(config, makeRng(config.seed));
    const wolf = seatOf(players, "werewolf");
    const victim = seatOf(players, "villager");
    const { factory } = scripted(config, (self) => ({
      async nightAction() {
        if (self.role === "werewolf") return { targetId: victim };
        if (self.role === "seer") return { targetId: wolf };
        if (self.role === "doctor") return { targetId: self.id };
        return { targetId: null };
      },
      async dayVote() { return { targetId: self.id === wolf ? null : wolf }; },
      async accuse() { return self.role === "seer" ? { targetId: wolf, text: "It is them." } : { targetId: null }; },
      async defend() { return "Not me."; },
      async witchAction() { return { heal: false, poisonTargetId: null }; },
    }));
    const t = await simulate(config, factory, OPTS);
    const decisions = decisionsOf(t);
    expect(decisions.map((d) => d.kind)).toEqual(
      expect.arrayContaining(["wolf_kill", "seer_check", "doctor_save", "witch_action", "statement", "accusation", "defense", "vote"])
    );
    for (const d of decisions) {
      expect(d.ruling).toBe("accepted");
      expect(d).not.toHaveProperty("rulingNote");
      expect(d).not.toHaveProperty("fallbackReason");
      expect(d).not.toHaveProperty("latencyMs");
      expect(d).not.toHaveProperty("reasoning");
    }
    const kill = decisions.find((d) => d.kind === "wolf_kill")!;
    expect(kill.requested).toEqual({ targetId: victim });
    expect(kill.applied).toEqual({ targetId: victim });
    // Text kinds carry no target fields.
    for (const d of decisions.filter((x) => ["statement", "defense"].includes(x.kind))) {
      expect(d).not.toHaveProperty("requested");
      expect(d).not.toHaveProperty("applied");
    }
  });

  it("flags an empty statement as replaced", async () => {
    const config = scriptedConfig(STANDARD);
    const { factory } = scripted(config, () => ({ async dayStatement() { return "   "; } }));
    const t = await simulate(config, factory, OPTS);
    const rec = decisionsOf(t).find((d) => d.kind === "statement")!;
    expect(rec).toMatchObject({ ruling: "clamped", rulingNote: "Empty statement — replaced with “…”.", produced: true });
    expect(t.events[rec.step]).toMatchObject({ kind: "statement", text: "…" });
  });

  it("treats optional methods that resolve to undefined as harmless passes", async () => {
    const config = scriptedConfig({ werewolf: 2, witch: 1, hunter: 1, villager: 3 });
    const players = buildPlayers(config, makeRng(config.seed));
    const hunter = seatOf(players, "hunter");
    const victim = seatOf(players, "villager", 0);
    const accuser = seatOf(players, "villager", 1);
    const nothing = undefined as never;
    const { factory } = scripted(config, (self) => ({
      async nightAction() { return { targetId: self.role === "werewolf" ? victim : null }; },
      async dayVote() { return { targetId: self.id === hunter ? null : hunter }; },
      async wolfChat() { return nothing; },
      // One real accusation, so the hunter is asked to defend.
      async accuse() { return self.id === accuser ? { targetId: hunter } : nothing; },
      async defend() { return nothing; },
      async witchAction() { return nothing; },
      async hunterShot() { return nothing; },
    }));
    const t = await simulate(config, factory, OPTS);
    expect(t.events.at(-1)?.kind).toBe("game_over");
    const decisions = decisionsOf(t);

    const passes = decisions.filter((d) => d.kind === "accusation" && d.playerId !== accuser);
    expect(passes.length).toBeGreaterThan(0);
    for (const p of passes)
      expect(p).toMatchObject({ ruling: "accepted", produced: false, requested: { targetId: null } });

    const witch = decisions.filter((d) => d.kind === "witch_action");
    expect(witch.length).toBeGreaterThan(0);
    for (const w of witch)
      expect(w).toMatchObject({
        ruling: "accepted", produced: false, requested: { targetId: null, heal: false },
      });

    const shot = decisions.find((d) => d.kind === "hunter_shot")!;
    expect(shot).toMatchObject({
      playerId: hunter, ruling: "clamped", rulingNote: N_RANDOM_NULL, produced: true,
      requested: { targetId: null },
    });
    expect(t.events[shot.step]).toMatchObject({ kind: "hunter_shot", targetId: shot.applied!.targetId });

    const chats = decisions.filter((d) => d.kind === "wolf_chat");
    expect(chats).toHaveLength(4); // 2 wolves × 2 rounds
    for (const c of chats) expect(c).toMatchObject({ ruling: "dropped", rulingNote: N_EMPTY, produced: false });

    const defense = decisions.filter((d) => d.kind === "defense");
    expect(defense).toHaveLength(1);
    expect(defense[0]).toMatchObject({ playerId: hunter, ruling: "dropped", rulingNote: N_EMPTY, produced: false });
  });
});

describe("decision records: untrusted traces", () => {
  it("sanitises hostile trace contents and ignores late mutation", async () => {
    const config = scriptedConfig(STANDARD);
    let previous: DecisionTrace | undefined;
    const late = () => {
      if (previous) {
        previous.reasoning = "LATE";
        previous.source = "model";
        previous.latencyMs = 42;
      }
    };
    const { factory } = scripted(config, () => ({
      async nightAction(_view: PlayerView, trace?: DecisionTrace) {
        late();
        Object.assign(trace!, { reasoning: 123, source: "alien", fallbackReason: "bogus", latencyMs: NaN });
        previous = trace;
        return { targetId: null };
      },
      async dayStatement(_view: PlayerView, trace?: DecisionTrace) {
        late();
        trace!.reasoning = "a\u0000b\u0007c\nd\u007f" + "x".repeat(5000);
        trace!.latencyMs = -5;
        previous = trace;
        return "hello";
      },
      async dayVote(_view: PlayerView, trace?: DecisionTrace) {
        late();
        Object.defineProperty(trace!, "reasoning", { get() { throw new Error("x"); } });
        trace!.source = "bot";
        previous = undefined;
        return { targetId: null };
      },
      async accuse(_view: PlayerView, trace?: DecisionTrace) {
        late();
        trace!.reasoning = "m".repeat(5 * 1024 * 1024);
        trace!.latencyMs = 12.6;
        trace!.source = "fallback";
        trace!.fallbackReason = "timeout";
        previous = trace;
        return { targetId: null };
      },
    }));
    const t = await simulate(config, factory, OPTS);
    expect(t.events.at(-1)?.kind).toBe("game_over");
    const decisions = decisionsOf(t);
    expect(JSON.stringify(decisions)).not.toContain("LATE");

    const night = decisions.filter((d) => ["wolf_kill", "seer_check", "doctor_save"].includes(d.kind));
    expect(night.length).toBe(3);
    for (const d of night) {
      expect(d.source).toBe("unknown");
      expect(d).not.toHaveProperty("reasoning");
      expect(d).not.toHaveProperty("fallbackReason");
      expect(d).not.toHaveProperty("latencyMs");
    }

    const statements = decisions.filter((d) => d.kind === "statement");
    expect(statements.length).toBeGreaterThan(0);
    for (const d of statements) {
      expect(d.reasoning).toHaveLength(600);
      expect(d.reasoning!.startsWith("a b c\nd x")).toBe(true);
      expect(d.source).toBe("unknown");
      expect(d).not.toHaveProperty("latencyMs");
    }

    const votes = decisions.filter((d) => d.kind === "vote");
    expect(votes.length).toBeGreaterThan(0);
    for (const d of votes) {
      expect(d.source).toBe("unknown");
      expect(d).not.toHaveProperty("reasoning");
    }

    const accusations = decisions.filter((d) => d.kind === "accusation");
    expect(accusations.length).toBeGreaterThan(0);
    for (const d of accusations) {
      expect(d.reasoning).toBe("m".repeat(600));
      expect(d).toMatchObject({ source: "fallback", fallbackReason: "timeout", latencyMs: 13 });
    }
  });

  it("survives a throwing onDecision, which fires once per record and before its event", async () => {
    const order: string[] = [];
    const t = await simulate(mockConfig(9, 4), buildBrainFactory(4), {
      ...OPTS,
      onDecision: (r) => {
        order.push(`d${r.seq}`);
        throw new Error("listener blew up");
      },
      onEvent: (_e, index) => order.push(`e${index}`),
    });
    expect(t.events.at(-1)?.kind).toBe("game_over");
    const decisions = decisionsOf(t);
    expect(order.filter((o) => o.startsWith("d"))).toEqual(decisions.map((d) => `d${d.seq}`));
    for (const d of decisions) {
      expect(order.indexOf(`d${d.seq}`)).toBeLessThan(order.indexOf(`e${d.step}`));
      // …and after the event before it, so `step` really is the next event's index.
      expect(order.indexOf(`d${d.seq}`)).toBeGreaterThan(order.indexOf(`e${d.step - 1}`));
    }
    expect(t.events).toEqual((await mockGame(9, 4)).events);
  });

  it("uses a legacy note as reasoning", async () => {
    const config = scriptedConfig(STANDARD);
    const { factory } = scripted(config, () => ({
      async nightAction() { return { targetId: null, note: "old-style night note" }; },
      async dayVote() { return { targetId: null, note: "old-style vote note" }; },
    }));
    const t = await simulate(config, factory, OPTS);
    const decisions = decisionsOf(t);
    expect(decisions.find((d) => d.kind === "seer_check")!.reasoning).toBe("old-style night note");
    expect(decisions.find((d) => d.kind === "wolf_kill")!.reasoning).toBe("old-style night note");
    expect(decisions.find((d) => d.kind === "vote")!.reasoning).toBe("old-style vote note");
  });

  it("writes no record for optional methods a brain lacks", async () => {
    const config = scriptedConfig({ werewolf: 2, witch: 1, hunter: 1, villager: 3 });
    const players = buildPlayers(config, makeRng(config.seed));
    const hunter = seatOf(players, "hunter");
    const victim = seatOf(players, "villager");
    const { factory } = scripted(config, (self) => ({
      async nightAction() { return { targetId: self.role === "werewolf" ? victim : null }; },
      async dayVote() { return { targetId: self.id === hunter ? null : hunter }; },
    }));
    const t = await simulate(config, factory, OPTS);
    const kinds = new Set(decisionsOf(t).map((d) => d.kind));
    expect([...kinds].sort()).toEqual(["statement", "vote", "wolf_kill"]);
    // The engine still fires the hunter's shot (random legal target), with no record for it.
    const shotIndex = t.events.findIndex((e) => e.kind === "hunter_shot");
    expect(shotIndex).toBeGreaterThan(0);
    expect(decisionsOf(t).some((d) => d.step === shotIndex && d.produced)).toBe(false);
  });
});

describe("decision records: reasoning cap", () => {
  it("never cuts an astral character in half", async () => {
    const config = scriptedConfig(STANDARD);
    const { factory } = scripted(config, () => ({
      async dayStatement(_view: PlayerView, trace?: DecisionTrace) {
        trace!.reasoning = "a".repeat(599) + "\u{1F600}" + "tail";
        return "hello";
      },
      async dayVote(_view: PlayerView, trace?: DecisionTrace) {
        trace!.reasoning = "b".repeat(598) + "\u{1F600}" + "tail";
        return { targetId: null };
      },
    }));
    const t = await simulate(config, factory, OPTS);
    const statements = decisionsOf(t).filter((d) => d.kind === "statement");
    expect(statements.length).toBeGreaterThan(0);
    // The emoji straddles the 600-unit cap: drop it whole rather than keep a lone surrogate.
    for (const d of statements) expect(d.reasoning).toBe("a".repeat(599));
    const votes = decisionsOf(t).filter((d) => d.kind === "vote");
    expect(votes.length).toBeGreaterThan(0);
    // One that fits exactly is kept.
    for (const d of votes) expect(d.reasoning).toBe("b".repeat(598) + "\u{1F600}");
  });
});
