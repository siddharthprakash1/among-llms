import { describe, expect, it } from "vitest";
import { applyGame, emptyRating, Leaderboard } from "./elo";
import type { SeatOutcome } from "./engine/types";

const outcome = (seatId: number, model: string, won: boolean): SeatOutcome => ({
  seatId, model, role: won ? "villager" : "werewolf", alignment: won ? "good" : "evil", won, survived: won,
});

describe("applyGame with a human seat", () => {
  it("returns the board unchanged", () => {
    const board: Leaderboard = { mock: { ...emptyRating("mock"), elo: 1040, games: 3, wins: 2 } };
    const before = JSON.parse(JSON.stringify(board));
    const next = applyGame(board, [outcome(0, "human", true), outcome(1, "mock", false), outcome(2, "gpt", true)], "g1");
    expect(next).toEqual(before);
    expect(board).toEqual(before);
    expect(next).not.toHaveProperty("human");
    expect(next).not.toHaveProperty("gpt");
  });

  it("still rates a game without one", () => {
    const next = applyGame({}, [outcome(0, "a", true), outcome(1, "b", false)], "g2");
    expect(next.a.elo).toBeGreaterThan(1000);
  });
});
