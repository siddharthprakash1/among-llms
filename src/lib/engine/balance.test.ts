import { describe, expect, it } from "vitest";
import { simulate } from "./werewolf";
import { buildBrainFactory } from "../agents/brains";

describe("balance smoke", () => {
  it("both main teams win a reasonable share across 60 seeded mock games", async () => {
    const tally = { good: 0, evil: 0, jester: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const numPlayers = 7 + (seed % 4); // 7..10
      const t = await simulate(
        { numPlayers, seatModels: Array(numPlayers).fill("mock"), seed: seed * 101 },
        buildBrainFactory(seed * 101),
        { id: `bal-${seed}`, createdAt: "2026-01-01T00:00:00.000Z" }
      );
      tally[t.result.winner] += 1;
    }
    // Not a strict 50/50 — just "no side is degenerate".
    expect(tally.good).toBeGreaterThanOrEqual(12);
    expect(tally.evil).toBeGreaterThanOrEqual(12);
  }, 30_000);
});
