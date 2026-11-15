import { describe, expect, it } from "vitest";
import {
  countLabel,
  decisionShortcut,
  describeDecision,
  hasDecisions,
  inspect,
  inspectorDwell,
  provenanceSummary,
  thinkingSeat,
} from "./inspector";
import { DecisionRecord, GameEvent, Player, Role } from "./engine/types";

function rec(seq: number, step: number, over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    seq,
    step,
    produced: true,
    day: 1,
    phase: "day",
    playerId: 0,
    kind: "statement",
    source: "bot",
    ruling: "accepted",
    ...over,
  };
}

function player(id: number, name: string, role: Role, model = "mock"): Player {
  return { id, name, avatar: "🦊", model, role, alignment: role === "werewolf" ? "evil" : "good", alive: true };
}

const PLAYERS: Player[] = [
  player(0, "Ada", "werewolf", "gpt-x"),
  player(1, "Bram", "werewolf", "gpt-x"),
  player(2, "Cleo", "seer", "mock"),
  player(3, "Dov", "witch", "claude-y"),
];

// Steps 2 (two wolves, one kill), 3, then nothing until 6 (a pass), 7.
const DECISIONS: DecisionRecord[] = [
  rec(0, 2, { kind: "wolf_kill", playerId: 0 }),
  rec(1, 2, { kind: "wolf_kill", playerId: 1 }),
  rec(2, 3, { kind: "seer_check", playerId: 2 }),
  rec(3, 6, { kind: "accusation", playerId: 2, produced: false }),
  rec(4, 6, { kind: "accusation", playerId: 3 }),
  rec(5, 7, { kind: "vote", playerId: 0 }),
];

describe("inspect", () => {
  it("defaults to the first produced sibling and lists siblings in seq order", () => {
    const m = inspect(DECISIONS, 6, null);
    expect(m.siblings.map((d) => d.seq)).toEqual([3, 4]);
    expect(m.current?.seq).toBe(4);
    expect(m.prev?.seq).toBe(3);
    expect(m.next?.seq).toBe(5);
    expect(m.index).toBe(5);
    expect(m.total).toBe(6);
  });

  it("honours a focus anchored at the step and ignores a stale one", () => {
    expect(inspect(DECISIONS, 6, 3).current?.seq).toBe(3);
    expect(inspect(DECISIONS, 2, 1).current?.seq).toBe(1);
    // seq 5 lives at step 7, so it cannot be focused while looking at step 2.
    expect(inspect(DECISIONS, 2, 5).current?.seq).toBe(0);
  });

  it("falls back to the first sibling when none produced the event", () => {
    const only = [rec(0, 4, { produced: false }), rec(1, 4, { produced: false })];
    expect(inspect(only, 4, null).current?.seq).toBe(0);
  });

  it("finds prev/next across steps with no decision", () => {
    const m = inspect(DECISIONS, 5, null);
    expect(m.current).toBeNull();
    expect(m.siblings).toEqual([]);
    expect(m.prev?.seq).toBe(2);
    expect(m.next?.seq).toBe(3);
    expect(m.index).toBe(0);
  });

  it("handles both ends and an empty game", () => {
    const before = inspect(DECISIONS, 0, null);
    expect(before.prev).toBeNull();
    expect(before.next?.seq).toBe(0);

    const first = inspect(DECISIONS, 2, null);
    expect(first.prev).toBeNull();
    expect(first.index).toBe(1);

    const last = inspect(DECISIONS, 7, null);
    expect(last.next).toBeNull();
    expect(last.index).toBe(6);

    const after = inspect(DECISIONS, 99, null);
    expect(after.prev?.seq).toBe(5);
    expect(after.next).toBeNull();

    expect(inspect([], 3, null)).toEqual({
      current: null, siblings: [], prev: null, next: null, index: 0, total: 0,
    });
  });

  it("works on array positions, not seq (a live buffer may start late)", () => {
    const tail = DECISIONS.slice(3);
    const m = inspect(tail, 7, null);
    expect(m.current?.seq).toBe(5);
    expect(m.prev?.seq).toBe(4);
    expect(m.index).toBe(3);
    expect(m.total).toBe(3);
  });
});

describe("thinkingSeat", () => {
  it("is undefined when Minds is off or there is no current decision", () => {
    expect(thinkingSeat(inspect(DECISIONS, 3, null), false)).toBeUndefined();
    expect(thinkingSeat(inspect(DECISIONS, 5, null), true)).toBeUndefined();
  });

  it("is the current actor, alive or not, produced or not", () => {
    expect(thinkingSeat(inspect(DECISIONS, 3, null), true)).toBe(2);
    expect(thinkingSeat(inspect(DECISIONS, 6, 3), true)).toBe(2);
    const hunter = [rec(0, 9, { kind: "hunter_shot", playerId: 7 })];
    expect(thinkingSeat(inspect(hunter, 9, null), true)).toBe(7);
  });

  it("shows no badge on a narrator step at the live edge, with prev before the edge", () => {
    const edge = inspect(DECISIONS, 4, null);
    expect(edge.current).toBeNull();
    expect(thinkingSeat(edge, true)).toBeUndefined();
    expect(edge.prev?.seq).toBe(2);
  });
});

describe("describeDecision", () => {
  const d = (over: Partial<DecisionRecord>, event?: GameEvent) =>
    describeDecision(rec(0, 1, over), event, PLAYERS);

  it("wolf chat: whisper with its text, or silence", () => {
    expect(d({ kind: "wolf_chat" }, { kind: "wolf_chat", day: 1, wolfId: 0, text: "Cleo tonight." })).toEqual({
      icon: "🐺", text: "Whispers to the pack", said: "Cleo tonight.",
    });
    expect(d({ kind: "wolf_chat", produced: false })).toEqual({
      icon: "🐺", text: "Stays silent in the pack chat",
    });
  });

  it("wolf kill: own preference, and the pack's choice when it differs", () => {
    const kill = (targetId: number): GameEvent => ({ kind: "wolf_kill", day: 1, actorIds: [0, 1], targetId });
    expect(d({ kind: "wolf_kill", applied: { targetId: 2 } }, kill(2)).text).toBe("Wants to kill Cleo");
    expect(d({ kind: "wolf_kill", applied: { targetId: 2 } }, kill(3)).text).toBe(
      "Wants to kill Cleo · pack chose Dov"
    );
  });

  it("seer check shows the result from the event", () => {
    const check = (result: "evil" | "good"): GameEvent => ({
      kind: "seer_check", day: 1, seerId: 2, targetId: 0, result,
    });
    expect(d({ kind: "seer_check", applied: { targetId: 0 } }, check("evil"))).toEqual({
      icon: "🔮", text: "Investigates Ada → WEREWOLF",
    });
    expect(d({ kind: "seer_check", applied: { targetId: 0 } }, check("good")).text).toBe(
      "Investigates Ada → innocent"
    );
  });

  it("doctor, hunter and vote name the applied target", () => {
    expect(d({ kind: "doctor_save", applied: { targetId: 3 } })).toEqual({ icon: "🩺", text: "Protects Dov" });
    expect(d({ kind: "hunter_shot", applied: { targetId: 1 } })).toEqual({ icon: "🏹", text: "Shoots Bram" });
    expect(d({ kind: "vote", applied: { targetId: 1 } })).toEqual({ icon: "🗳", text: "Votes for Bram" });
    expect(d({ kind: "vote", applied: { targetId: null } })).toEqual({ icon: "🗳", text: "Abstains" });
  });

  it("witch: heal, poison and hold", () => {
    const heal: GameEvent = { kind: "witch_action", day: 1, witchId: 3, action: "heal", targetId: 2 };
    expect(d({ kind: "witch_action", applied: { targetId: null, heal: true } }, heal)).toEqual({
      icon: "🧪", text: "Heals Cleo",
    });
    expect(d({ kind: "witch_action", applied: { targetId: null, heal: true } }).text).toBe("Uses the heal");
    expect(d({ kind: "witch_action", applied: { targetId: 0, heal: false } }).text).toBe("Poisons Ada");
    expect(d({ kind: "witch_action", produced: false, applied: { targetId: null, heal: false } }).text).toBe(
      "Holds her potions"
    );
  });

  it("statement and defense carry what was said aloud", () => {
    expect(d({ kind: "statement" }, { kind: "statement", day: 1, playerId: 0, text: "I trust Cleo." })).toEqual({
      icon: "💬", text: "Speaks to the table", said: "I trust Cleo.",
    });
    expect(d({ kind: "defense" }, { kind: "defense", day: 1, playerId: 0, text: "Not me." })).toEqual({
      icon: "🛡", text: "Defends themself", said: "Not me.",
    });
    expect(d({ kind: "defense", produced: false })).toEqual({ icon: "🛡", text: "Offers no defense" });
  });

  it("accusation: made, passed, or illegal", () => {
    const made: GameEvent = { kind: "accusation", day: 1, from: 0, target: 2, text: "It's Cleo." };
    expect(d({ kind: "accusation", requested: { targetId: 2 }, applied: { targetId: 2 } }, made)).toEqual({
      icon: "⚖️", text: "Accuses Cleo", said: "It's Cleo.",
    });
    expect(
      d({ kind: "accusation", produced: false, requested: { targetId: null }, applied: { targetId: null } })
    ).toEqual({ icon: "⚖️", text: "Passes on accusing" });
    expect(
      d({ kind: "accusation", produced: false, requested: { targetId: 0 }, applied: { targetId: null } }).text
    ).toBe("Tries to accuse an illegal target");
  });

  it("ignores an event that is not this decision's own outcome", () => {
    const other: GameEvent = { kind: "statement", day: 1, playerId: 1, text: "Someone else's words." };
    // Not produced: the event at this step belongs to another decision.
    expect(d({ kind: "statement", produced: false }, other)).not.toHaveProperty("said");
    // Produced, but the event has not arrived (live) or is of another kind.
    expect(d({ kind: "statement" }, undefined)).toEqual({ icon: "💬", text: "Speaks to the table" });
    expect(d({ kind: "seer_check", applied: { targetId: 0 } }, other).text).toBe("Investigates Ada");
    expect(d({ kind: "wolf_kill", applied: { targetId: 2 } }, undefined).text).toBe("Wants to kill Cleo");
  });

  it("falls back to a seat label for an unknown player", () => {
    expect(d({ kind: "vote", applied: { targetId: 42 } }).text).toBe("Votes for Seat 42");
  });
});

describe("inspectorDwell", () => {
  it("is the base delay when there is no reasoning", () => {
    expect(inspectorDwell(650, null, 1)).toBe(650);
    expect(inspectorDwell(650, rec(0, 1), 1)).toBe(650);
  });

  it("grows with the reasoning length but never drops below the base", () => {
    expect(inspectorDwell(650, rec(0, 1, { reasoning: "x".repeat(40) }), 1)).toBe(3000);
    expect(inspectorDwell(5000, rec(0, 1, { reasoning: "x" }), 1)).toBe(5000);
  });

  it("is capped at 6000 ms and scales with speed", () => {
    const long = rec(0, 1, { reasoning: "x".repeat(600) });
    expect(inspectorDwell(650, long, 1)).toBe(6000);
    expect(inspectorDwell(650, long, 2)).toBe(3000);
    expect(inspectorDwell(650, long, 0.5)).toBe(12000);
  });
});

describe("provenanceSummary", () => {
  const records: DecisionRecord[] = [
    rec(0, 1, { playerId: 0, source: "model", latencyMs: 1000 }),
    rec(1, 2, { playerId: 1, source: "model", latencyMs: 3000, ruling: "clamped" }),
    rec(2, 3, { playerId: 0, source: "fallback", fallbackReason: "parse", latencyMs: 2000 }),
    rec(3, 4, { playerId: 1, source: "fallback", fallbackReason: "parse" }),
    rec(4, 5, { playerId: 0, source: "fallback", fallbackReason: "timeout", ruling: "dropped" }),
    rec(5, 6, { playerId: 2, source: "bot" }),
    rec(6, 7, { playerId: 2, source: "bot", ruling: "clamped" }),
    rec(7, 8, { playerId: 3, source: "unknown" }),
  ];

  it("groups by model, sorted by model id, with counts and reasons", () => {
    const rows = provenanceSummary(records, PLAYERS);
    expect(rows.map((r) => r.model)).toEqual(["claude-y", "gpt-x", "mock"]);
    expect(rows[1]).toEqual({
      model: "gpt-x",
      decisions: 5,
      own: 2,
      fallbacks: 3,
      byReason: { parse: 2, timeout: 1 },
      overridden: 2,
      avgLatencyMs: 2000,
    });
  });

  it("reports null latency and no own/fallback counts for heuristic seats", () => {
    const rows = provenanceSummary(records, PLAYERS);
    expect(rows[2]).toEqual({
      model: "mock", decisions: 2, own: 0, fallbacks: 0, byReason: {}, overridden: 1, avgLatencyMs: null,
    });
    expect(rows[0]).toMatchObject({ model: "claude-y", decisions: 1, own: 0, fallbacks: 0, avgLatencyMs: null });
    expect(provenanceSummary([], PLAYERS)).toEqual([]);
  });
});

describe("hasDecisions", () => {
  it("is false for a legacy transcript and an empty list, true otherwise", () => {
    expect(hasDecisions({})).toBe(false);
    expect(hasDecisions({ decisions: [] })).toBe(false);
    expect(hasDecisions({ decisions: [rec(0, 1)] })).toBe(true);
  });
});

describe("decisionShortcut", () => {
  it("maps [ and ] and ignores every other key", () => {
    expect(decisionShortcut({ key: "[" })).toBe("prev");
    expect(decisionShortcut({ key: "]" })).toBe("next");
    expect(decisionShortcut({ key: "a" })).toBeNull();
    expect(decisionShortcut({ key: "]", target: null })).toBe("next");
  });

  it("still works while the scrubber (a range input) or a button has focus", () => {
    expect(decisionShortcut({ key: "]", target: { tagName: "INPUT", type: "range" } })).toBe("next");
    expect(decisionShortcut({ key: "[", target: { tagName: "BUTTON" } })).toBe("prev");
  });

  it("yields to text entry", () => {
    expect(decisionShortcut({ key: "]", target: { tagName: "INPUT", type: "text" } })).toBeNull();
    expect(decisionShortcut({ key: "]", target: { tagName: "input" } })).toBeNull();
    expect(decisionShortcut({ key: "[", target: { tagName: "TEXTAREA" } })).toBeNull();
    expect(decisionShortcut({ key: "[", target: { tagName: "SELECT" } })).toBeNull();
    expect(decisionShortcut({ key: "[", target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
  });

  it("yields to browser shortcuts (Cmd+[ is Back)", () => {
    expect(decisionShortcut({ key: "[", metaKey: true })).toBeNull();
    expect(decisionShortcut({ key: "]", ctrlKey: true })).toBeNull();
    expect(decisionShortcut({ key: "]", altKey: true })).toBeNull();
  });
});

describe("countLabel", () => {
  it("pluralises everything but one", () => {
    expect(countLabel(0, "fallback")).toBe("0 fallbacks");
    expect(countLabel(1, "engine override")).toBe("1 engine override");
    expect(countLabel(2, "decision")).toBe("2 decisions");
  });
});
