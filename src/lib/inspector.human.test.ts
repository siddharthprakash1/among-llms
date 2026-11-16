import { describe, expect, it } from "vitest";
import { healthLabel, noReasoningText, provenanceSummary, sourceChip } from "./inspector";
import type { DecisionRecord, Player } from "./engine/types";

const rec = (seq: number, playerId: number, source: DecisionRecord["source"]): DecisionRecord => ({
  seq, step: seq, produced: true, day: 1, phase: "day", playerId, kind: "statement", source, ruling: "accepted",
});
const PLAYERS: Player[] = [
  { id: 0, name: "You", avatar: "x", model: "human", role: "villager", alignment: "good", alive: true },
  { id: 1, name: "Bot", avatar: "x", model: "mock", role: "werewolf", alignment: "evil", alive: true },
];

describe("the human seat in the reasoning inspector", () => {
  it("labels a person's own move as a human move, not as an unreported source", () => {
    expect(sourceChip(rec(0, 0, "unknown"), "human").text).toBe("🧑 human move");
    expect(noReasoningText(rec(0, 0, "unknown"), "human")).toBe("People don't report their reasoning.");
  });

  it("labels the human seat's timed-out moves as autopilot", () => {
    expect(sourceChip(rec(0, 0, "bot"), "human").text).toBe("🤖 autopilot");
    expect(noReasoningText(rec(0, 0, "bot"), "human")).toBe("No reasoning was returned for this decision.");
  });

  it("keeps the wording for every other seat", () => {
    expect(sourceChip(rec(0, 1, "unknown"), "mock").text).toBe("source not reported");
    expect(sourceChip(rec(0, 1, "unknown")).text).toBe("source not reported");
    expect(sourceChip(rec(0, 1, "bot"), "mock").text).toBe("🤖 heuristic bot");
    expect(sourceChip(rec(0, 1, "model"), "gpt-x")).toEqual({ text: "● own decision", tone: "good" });
    expect(sourceChip({ ...rec(0, 1, "fallback"), fallbackReason: "parse" }, "gpt-x").text).toBe("⚠ fallback · parse");
    expect(noReasoningText(rec(0, 1, "unknown"), "mock")).toBe("No reasoning was returned for this decision.");
  });

  it("summarises the human row as played by a person, with an autopilot count", () => {
    const all = [rec(0, 0, "unknown"), rec(1, 1, "bot"), rec(2, 0, "bot"), rec(3, 0, "unknown")];
    const rows = provenanceSummary(all, PLAYERS);
    const human = rows.find((r) => r.model === "human")!;
    const mock = rows.find((r) => r.model === "mock")!;
    expect(human.autopilot).toBe(1);
    expect(healthLabel(human)).toBe("played by a person · 1 on autopilot");
    expect(mock.autopilot).toBeUndefined();
    expect(healthLabel(mock)).toBe("heuristic bot");

    const [clean] = provenanceSummary([rec(0, 0, "unknown")], PLAYERS);
    expect(healthLabel(clean)).toBe("played by a person");
  });

  it("still reports the share of own decisions for a model", () => {
    expect(
      healthLabel({ model: "gpt-x", decisions: 4, own: 3, fallbacks: 1, byReason: {}, overridden: 0, avgLatencyMs: null })
    ).toBe("75% own");
  });
});
