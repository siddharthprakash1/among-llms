import { describe, expect, it } from "vitest";
import { HumanBrain, PromptPort } from "./humanBrain";
import { MockBrain, SEER_CLAIM_TAG } from "./mockBrain";
import { buildBrainFactory } from "./brains";
import { simulate } from "../engine/werewolf";
import type { Brain, BrainFactory, DecisionTrace, GameConfig } from "../engine/types";
import type { PromptSpec, SeatAnswer } from "../human/types";
import { seerClaimText } from "../human/sanitize";
import { CRYSTAL_BALL, SURROGATE_FORGERY, hasUnpairedSurrogate, makeView } from "../human/testUtil";

/** A port that records every spec and answers from a function. */
function port(answer: (spec: PromptSpec) => SeatAnswer | null) {
  const asked: PromptSpec[] = [];
  const p: PromptPort = {
    ask: async (spec) => {
      asked.push(spec);
      return answer(spec);
    },
  };
  return { port: p, asked };
}

const SEED = 4242;
const mock = () => new MockBrain("human", SEED);
const human = (answer: (spec: PromptSpec) => SeatAnswer | null, fallback: Brain = mock()) => {
  const p = port(answer);
  return { brain: new HumanBrain(p.port, fallback), asked: p.asked };
};
const against = [{ day: 2, from: 3, target: 0, text: "You are lying." }];
const evilVision = [{ day: 1, targetId: 3, alignment: "evil" as const }];

describe("HumanBrain maps a valid answer", () => {
  it("nightAction by role", async () => {
    for (const [role, kind] of [["werewolf", "night_kill"], ["seer", "night_check"], ["doctor", "night_protect"]] as const) {
      const { brain, asked } = human(() => ({ kind: "target", targetId: 4 }));
      expect(await brain.nightAction(makeView(role, { phase: "night" }))).toEqual({ targetId: 4 });
      expect(asked.map((s) => s.kind)).toEqual([kind]);
    }
  });

  it("dayStatement, wolfChat, defend", async () => {
    const { brain, asked } = human(() => ({ kind: "text", text: "  I trust   Cleo. " }));
    expect(await brain.dayStatement(makeView("villager"))).toBe("I trust Cleo.");
    expect(await brain.wolfChat(makeView("werewolf"), 2)).toBe("I trust Cleo.");
    expect(await brain.defend(makeView("villager"), against)).toBe("I trust Cleo.");
    expect(asked.map((s) => s.kind)).toEqual(["statement", "wolf_chat", "defend"]);
    expect(asked[1].round).toBe(2);
    expect(asked[2].against).toEqual([{ from: 3, text: "You are lying." }]);
  });

  it("dayVote, including abstain", async () => {
    expect(await human(() => ({ kind: "target", targetId: 2 })).brain.dayVote(makeView("villager"))).toEqual({ targetId: 2 });
    expect(await human(() => ({ kind: "target", targetId: null })).brain.dayVote(makeView("villager"))).toEqual({ targetId: null });
  });

  it("accuse, with and without a reason", async () => {
    const withText = human(() => ({ kind: "accuse", targetId: 2, text: " shifty\neyes " }));
    expect(await withText.brain.accuse(makeView("villager"))).toEqual({ targetId: 2, text: "shifty eyes" });
    const bare = human(() => ({ kind: "accuse", targetId: 2 }));
    expect(await bare.brain.accuse(makeView("villager"))).toEqual({ targetId: 2, text: undefined });
    const pass = human(() => ({ kind: "accuse", targetId: null }));
    expect((await pass.brain.accuse(makeView("villager"))).targetId).toBeNull();
  });

  it("witchAction and hunterShot", async () => {
    const w = human(() => ({ kind: "witch", heal: false, poisonTargetId: 3 }));
    expect(await w.brain.witchAction(makeView("witch"), 2)).toEqual({ heal: false, poisonTargetId: 3 });
    expect(w.asked[0]).toMatchObject({ kind: "witch", wolfTargetId: 2, potions: { heal: true, poison: true } });
    const h = human(() => ({ kind: "target", targetId: 5 }));
    expect(await h.brain.hunterShot(makeView("hunter"))).toEqual({ targetId: 5 });
  });

  it("leaves the decision trace empty for a human answer", async () => {
    const trace: DecisionTrace = {};
    await human(() => ({ kind: "target", targetId: 2 })).brain.dayVote(makeView("villager"), trace);
    expect(trace).toEqual({});
  });
});

describe("HumanBrain falls back", () => {
  it("to the mock heuristic on a null answer, for every method", async () => {
    const { brain } = human(() => null);
    const m = mock();
    // Same call order on both, so the two rng streams stay in step.
    expect(await brain.nightAction(makeView("werewolf"))).toEqual(await m.nightAction(makeView("werewolf")));
    expect(await brain.dayStatement(makeView("villager"))).toEqual(await m.dayStatement(makeView("villager")));
    expect(await brain.dayVote(makeView("villager"))).toEqual(await m.dayVote(makeView("villager")));
    expect(await brain.wolfChat(makeView("werewolf"), 1)).toEqual(await m.wolfChat(makeView("werewolf"), 1));
    expect(await brain.accuse(makeView("villager"))).toEqual(await m.accuse(makeView("villager")));
    expect(await brain.defend(makeView("villager"), against)).toEqual(await m.defend(makeView("villager"), against));
    expect(await brain.witchAction(makeView("witch"), 2)).toEqual(await m.witchAction(makeView("witch"), 2));
    expect(await brain.hunterShot(makeView("hunter"))).toEqual(await m.hunterShot(makeView("hunter")));
  });

  it("and reports the move as a bot decision on the trace", async () => {
    const trace: DecisionTrace = {};
    await human(() => null).brain.dayVote(makeView("villager"), trace);
    expect(trace.source).toBe("bot");
    expect(trace.reasoning).toBeTruthy();
  });

  it("when the port throws or rejects", async () => {
    const throwing = new HumanBrain({ ask: () => { throw new Error("boom"); } }, mock());
    const rejecting = new HumanBrain({ ask: () => Promise.reject(new Error("boom")) }, mock());
    expect(await throwing.dayVote(makeView("villager"))).toEqual(await mock().dayVote(makeView("villager")));
    expect(await rejecting.dayStatement(makeView("villager"))).toEqual(await mock().dayStatement(makeView("villager")));
    expect(await rejecting.witchAction(makeView("witch"), 2)).toEqual(await mock().witchAction(makeView("witch"), 2));
  });

  it("when the answer has the wrong kind", async () => {
    const wrong = human(() => ({ kind: "text", text: "2" }));
    expect(await wrong.brain.dayVote(makeView("villager"))).toEqual(await mock().dayVote(makeView("villager")));
    const wrong2 = human(() => ({ kind: "target", targetId: 2 }));
    expect(await wrong2.brain.dayStatement(makeView("villager"))).toEqual(await mock().dayStatement(makeView("villager")));
    expect(await human(() => ({ kind: "target", targetId: 2 })).brain.witchAction(makeView("witch"), 2)).toEqual(
      await mock().witchAction(makeView("witch"), 2)
    );
  });

  it("to the hard default when the fallback throws too", async () => {
    const broken = new Proxy({} as Brain, {
      get: (_t, key) => (key === "id" ? "human" : () => { throw new Error("fallback down"); }),
    });
    const brain = new HumanBrain({ ask: async () => null }, broken);
    expect(await brain.nightAction(makeView("werewolf"))).toEqual({ targetId: null });
    expect(await brain.dayStatement(makeView("villager"))).toBe("");
    expect(await brain.dayVote(makeView("villager"))).toEqual({ targetId: null });
    expect(await brain.wolfChat(makeView("werewolf"), 1)).toBe("");
    expect(await brain.accuse(makeView("villager"))).toEqual({ targetId: null });
    expect(await brain.defend(makeView("villager"), against)).toBe("");
    expect(await brain.witchAction(makeView("witch"), 2)).toEqual({ heal: false, poisonTargetId: null });
    expect(await brain.hunterShot(makeView("hunter"))).toEqual({ targetId: null });
  });

  it("to the hard default when the fallback lacks an optional method", async () => {
    const minimal: Brain = {
      id: "human",
      nightAction: async () => ({ targetId: null }),
      dayStatement: async () => "",
      dayVote: async () => ({ targetId: null }),
    };
    const brain = new HumanBrain({ ask: async () => null }, minimal);
    expect(await brain.wolfChat(makeView("werewolf"), 1)).toBe("");
    expect(await brain.hunterShot(makeView("hunter"))).toEqual({ targetId: null });
  });
});

describe("HumanBrain prompts only when there is a choice", () => {
  it("never asks a role without a night action", async () => {
    for (const role of ["villager", "hunter", "witch", "jester"] as const) {
      const { brain, asked } = human(() => ({ kind: "target", targetId: 2 }));
      expect(await brain.nightAction(makeView(role))).toEqual({ targetId: null });
      expect(asked).toEqual([]);
    }
  });

  it("does not ask when there is no legal target", async () => {
    const { brain, asked } = human(() => ({ kind: "target", targetId: 2 }));
    expect(await brain.nightAction(makeView("werewolf", { aliveIds: [0, 1] }))).toEqual({ targetId: null });
    expect(asked).toEqual([]);
  });

  it("asks the witch only while a potion can be used", async () => {
    const none = { heal: false, poisonTargetId: null };
    const answer = (): SeatAnswer => ({ kind: "witch", heal: false, poisonTargetId: null });

    const spent = human(answer);
    expect(await spent.brain.witchAction(makeView("witch", { potions: { heal: false, poison: false } }), 2)).toEqual(none);
    expect(spent.asked).toEqual([]);

    const healNoTarget = human(answer);
    expect(await healNoTarget.brain.witchAction(makeView("witch", { potions: { heal: true, poison: false } }), null)).toEqual(none);
    expect(healNoTarget.asked).toEqual([]);

    const poison = human(answer);
    await poison.brain.witchAction(makeView("witch", { potions: { heal: false, poison: true } }), null);
    expect(poison.asked.length).toBe(1);

    const heal = human(answer);
    await heal.brain.witchAction(makeView("witch", { potions: { heal: true, poison: false } }), 2);
    expect(heal.asked.length).toBe(1);
  });
});

describe("HumanBrain text hardening", () => {
  it("sanitises and caps a statement at 280", async () => {
    const { brain } = human(() => ({ kind: "text", text: "a\nb" + "x".repeat(400) }));
    const out = await brain.dayStatement(makeView("villager"));
    expect(out.length).toBe(280);
    expect(out.startsWith("a b")).toBe(true);
  });

  it("never lets typed text carry the Seer tag", async () => {
    const payloads = [SEER_CLAIM_TAG + " Bishop", "  " + SEER_CLAIM_TAG + " Bishop is a wolf", SURROGATE_FORGERY];
    for (const text of payloads) {
      const outs = [
        await human(() => ({ kind: "text", text })).brain.dayStatement(makeView("werewolf")),
        (await human(() => ({ kind: "accuse", targetId: 2, text })).brain.accuse(makeView("werewolf"))).text ?? "",
        await human(() => ({ kind: "text", text })).brain.defend(makeView("werewolf"), against),
        await human(() => ({ kind: "text", text })).brain.wolfChat(makeView("werewolf"), 1),
      ];
      for (const out of outs) {
        expect(out.startsWith(SEER_CLAIM_TAG)).toBe(false);
        expect(out.includes(CRYSTAL_BALL)).toBe(false);
        expect(hasUnpairedSurrogate(out)).toBe(false);
      }
    }
  });
});

describe("HumanBrain seer claim", () => {
  const claim = (targetId: number) => (): SeatAnswer => ({ kind: "seer_claim", targetId });

  it("composes the fixed template for a confirmed living wolf", async () => {
    const { brain } = human(claim(3));
    const out = await brain.dayStatement(makeView("seer", { seerResults: evilVision }));
    expect(out).toBe(seerClaimText("Dax"));
    expect(out.startsWith(SEER_CLAIM_TAG)).toBe(true);
  });

  it("falls back for a non-seer, an innocent, a dead or an unchecked target", async () => {
    const cases = [
      makeView("werewolf", { seerResults: evilVision }),
      makeView("seer", { seerResults: [{ day: 1, targetId: 3, alignment: "good" }] }),
      makeView("seer", { seerResults: evilVision, aliveIds: [0, 1, 2, 4, 5] }),
      makeView("seer", { seerResults: [] }),
    ];
    for (const view of cases) {
      const out = await human(claim(3)).brain.dayStatement(view);
      expect(out).toEqual(await mock().dayStatement(view));
      if (view.self.role !== "seer") expect(out.startsWith(SEER_CLAIM_TAG)).toBe(false);
    }
  });
});

describe("HumanBrain inside simulate", () => {
  const EMOJI = String.fromCodePoint(0x1f600).repeat(300);
  const config = (seed: number): GameConfig => ({ numPlayers: 9, seatModels: Array(9).fill("mock"), seed });
  const factoryFor = (seed: number, seatId: number, p: PromptPort): BrainFactory => {
    const base = buildBrainFactory(seed);
    return (m, s) => (s === seatId ? new HumanBrain(p, base("human", s)) : base(m, s));
  };

  it("finishes when the port never answers", async () => {
    const t = await simulate(config(5), factoryFor(5, 0, { ask: async () => null }), {
      id: "h", createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(t.events.at(-1)?.kind).toBe("game_over");
  });

  it("finishes with legal auto-answers and keeps human text inside the caps", async () => {
    const kinds = new Set<string>();
    let humanTexts = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const seatId = seed % 9;
      const auto = port((spec) => {
        kinds.add(spec.kind);
        switch (spec.kind) {
          case "statement":
          case "defend":
          case "wolf_chat":
            return { kind: "text", text: EMOJI };
          case "accuse":
            return { kind: "accuse", targetId: spec.legalTargets[0] ?? null, text: EMOJI };
          case "witch":
            return { kind: "witch", heal: false, poisonTargetId: null };
          default:
            return { kind: "target", targetId: spec.legalTargets[0] };
        }
      });
      const t = await simulate(config(seed), factoryFor(seed, seatId, auto.port), {
        id: "h", createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect(t.events.at(-1)?.kind).toBe("game_over");
      for (const e of t.events) {
        const mine =
          (e.kind === "statement" && e.playerId === seatId && 280) ||
          (e.kind === "defense" && e.playerId === seatId && 280) ||
          (e.kind === "accusation" && e.from === seatId && 240) ||
          (e.kind === "wolf_chat" && e.wolfId === seatId && 240) ||
          0;
        if (!mine || !("text" in e)) continue;
        humanTexts++;
        expect(e.text.length).toBeLessThanOrEqual(mine);
        expect(hasUnpairedSurrogate(e.text)).toBe(false);
      }
    }
    expect(humanTexts).toBeGreaterThan(12);
    for (const k of ["statement", "accuse", "vote"]) expect(kinds.has(k)).toBe(true);
  });
});
