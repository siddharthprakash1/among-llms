import { describe, expect, it } from "vitest";
import { simulate } from "./werewolf";
import { buildBrainFactory } from "../agents/brains";
import { Winner } from "./types";

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Generated from the engine as it stood BEFORE the reasoning inspector. If one
// of these fails, an rng draw was added or reordered: fix the code, never the literals.
const GOLDEN: [numPlayers: number, seed: number, hash: string, winner: Winner][] = [
  [5, 1, "231ee751", "good"],
  [6, 2, "d488d130", "evil"],
  [7, 3, "c7a82f99", "good"],
  [8, 4, "8349479b", "evil"],
  [9, 5, "54cf9fee", "jester"],
  [10, 6, "a30470b0", "good"],
  [11, 7, "6928dbec", "evil"],
  [12, 8, "35433a11", "good"],
  [7, 12345, "0a984c63", "evil"],
  [9, 777, "bbf17a51", "good"],
  [10, 42, "73ee6683", "good"],
  [12, 99, "b5ab41ca", "evil"],
];

describe("mock-game events golden", () => {
  it("events and winner are byte-identical to the pre-inspector engine", async () => {
    for (const [numPlayers, seed, hash, winner] of GOLDEN) {
      const t = await simulate(
        { numPlayers, seatModels: Array(numPlayers).fill("mock"), seed },
        buildBrainFactory(seed),
        { id: "golden", createdAt: "2026-01-01T00:00:00.000Z" }
      );
      expect([numPlayers, seed, fnv1a(JSON.stringify(t.events)), t.result.winner]).toEqual([
        numPlayers, seed, hash, winner,
      ]);
    }
  });
});
