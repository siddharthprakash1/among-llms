import { describe, expect, it } from "vitest";
import { applyGame, DEFAULT_ELO, emptyRating, Leaderboard, winRate } from "./elo";
import { SeatOutcome } from "./engine/types";

function seat(model: string, alignment: "good" | "evil", won: boolean): SeatOutcome {
  return { seatId: 0, model, role: alignment === "evil" ? "werewolf" : "villager", alignment, won, survived: won };
}

describe("elo", () => {
  it("moves winners up and losers down from the default", () => {
    const outcomes = [
      seat("alpha", "evil", true),
      seat("alpha", "evil", true),
      seat("beta", "good", false),
      seat("beta", "good", false),
      seat("beta", "good", false),
    ];
    const board = applyGame({}, outcomes);
    expect(board["alpha"].elo).toBeGreaterThan(DEFAULT_ELO);
    expect(board["beta"].elo).toBeLessThan(DEFAULT_ELO);
  });

  it("tracks deception (wolf) and detection (village) splits", () => {
    const board = applyGame({}, [
      seat("alpha", "evil", true),
      seat("beta", "good", false),
    ]);
    expect(board["alpha"].asWolf).toEqual({ games: 1, wins: 1 });
    expect(board["alpha"].asVillage).toEqual({ games: 0, wins: 0 });
    expect(board["beta"].asVillage).toEqual({ games: 1, wins: 0 });
  });

  it("counts each seat a model holds as a separate participation", () => {
    const board = applyGame({}, [
      seat("alpha", "evil", true),
      seat("alpha", "good", false),
      seat("beta", "good", false),
    ]);
    expect(board["alpha"].games).toBe(2);
    expect(board["alpha"].wins).toBe(1);
  });

  it("accumulates across games on an existing board", () => {
    const start: Leaderboard = { alpha: emptyRating("alpha") };
    const after = applyGame(start, [seat("alpha", "good", true), seat("beta", "evil", false)]);
    expect(after["alpha"].games).toBe(1);
    expect(after["alpha"].wins).toBe(1);
    // original board is untouched (pure)
    expect(start["alpha"].games).toBe(0);
  });

  it("computes win rate safely", () => {
    expect(winRate({ games: 0, wins: 0 })).toBe(0);
    expect(winRate({ games: 4, wins: 1 })).toBe(0.25);
  });
});
