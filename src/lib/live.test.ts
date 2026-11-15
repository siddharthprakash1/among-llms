import { describe, expect, it } from "vitest";
import {
  createLive,
  decisionsRemaining,
  decisionsThrough,
  getLive,
  parseLastEventId,
  pushLiveDecision,
} from "./live";
import { DecisionRecord, GameConfig } from "./engine/types";

function rec(seq: number, step: number): DecisionRecord {
  return {
    seq, step, produced: true, day: 1, phase: "night", playerId: 0,
    kind: "wolf_kill", source: "bot", ruling: "accepted",
  };
}

const CONFIG: GameConfig = { numPlayers: 5, seatModels: Array(5).fill("mock"), seed: 1 };

describe("decisionsThrough", () => {
  // Two decisions before event 2, one before event 3, none for 4, one before 5.
  const decisions = [rec(0, 2), rec(1, 2), rec(2, 3), rec(3, 5)];

  it("sends each decision once, in order, just before its event", () => {
    let cursor = 0;
    const sent: number[][] = [];
    for (let index = 0; index <= 5; index++) {
      const out = decisionsThrough(decisions, cursor, index, -1);
      cursor = out.cursor;
      sent.push(out.send.map((d) => d.seq));
    }
    expect(sent).toEqual([[], [], [0, 1], [2], [], [3]]);
    expect(cursor).toBe(4);
  });

  it("returns nothing and leaves the cursor alone for an event with no anchored decision", () => {
    expect(decisionsThrough(decisions, 3, 4, -1)).toEqual({ send: [], cursor: 3 });
    expect(decisionsThrough([], 0, 7, -1)).toEqual({ send: [], cursor: 0 });
  });

  it("skips decisions delivered on an earlier connection but still advances past them", () => {
    // Reconnect with Last-Event-ID 2: the first event written is index 3.
    const out = decisionsThrough(decisions, 0, 3, 2);
    expect(out.send.map((d) => d.seq)).toEqual([2]);
    expect(out.cursor).toBe(3);
  });

  it("holds back decisions that have arrived ahead of their event", () => {
    const out = decisionsThrough(decisions, 0, 2, -1);
    expect(out.send.map((d) => d.seq)).toEqual([0, 1]);
    expect(out.cursor).toBe(2);
  });
});

describe("live decision buffer", () => {
  it("starts empty and appends in order", () => {
    const game = createLive("live-test-a", "2026-01-01T00:00:00.000Z", CONFIG, []);
    expect(game.decisions).toEqual([]);
    pushLiveDecision("live-test-a", rec(0, 2));
    pushLiveDecision("live-test-a", rec(1, 3));
    expect(getLive("live-test-a")!.decisions.map((d) => d.seq)).toEqual([0, 1]);
  });

  it("tolerates a game object created before the field existed", () => {
    const game = createLive("live-test-b", "2026-01-01T00:00:00.000Z", CONFIG, []);
    delete (game as { decisions?: DecisionRecord[] }).decisions;
    pushLiveDecision("live-test-b", rec(0, 2));
    expect(getLive("live-test-b")!.decisions).toEqual([rec(0, 2)]);
  });

  it("ignores an unknown game id", () => {
    expect(() => pushLiveDecision("live-test-missing", rec(0, 2))).not.toThrow();
    expect(getLive("live-test-missing")).toBeNull();
  });
});

describe("decisionsRemaining", () => {
  const decisions = [rec(0, 0), rec(1, 1), rec(2, 1)];

  it("returns what no later event will flush (the last decisions of an abandoned game)", () => {
    // Event 0 was written; the game died before event 1 existed.
    const through = decisionsThrough(decisions, 0, 0, -1);
    const rest = decisionsRemaining(decisions, through.cursor, -1);
    expect(rest.send.map((d) => d.seq)).toEqual([1, 2]);
    expect(rest.cursor).toBe(3);
    expect(decisionsRemaining(decisions, rest.cursor, -1).send).toEqual([]);
  });

  it("still skips what an earlier connection delivered", () => {
    expect(decisionsRemaining(decisions, 0, 0).send.map((d) => d.seq)).toEqual([1, 2]);
  });
});

describe("parseLastEventId", () => {
  it("reads an event index", () => {
    expect(parseLastEventId("0")).toBe(0);
    expect(parseLastEventId("17")).toBe(17);
    expect(parseLastEventId(" 3 ")).toBe(3);
  });

  it("is -1 (send everything) when absent or malformed, never NaN", () => {
    for (const h of [null, "", "abc", "1.5", "-2", "1e3", "NaN", "Infinity", "9".repeat(40)])
      expect(parseLastEventId(h)).toBe(-1);
  });
});
