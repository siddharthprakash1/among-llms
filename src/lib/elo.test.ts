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
    const board = applyGame({}, outcomes, "g0");
    expect(board["alpha"].elo).toBeGreaterThan(DEFAULT_ELO);
    expect(board["beta"].elo).toBeLessThan(DEFAULT_ELO);
  });

  it("tracks deception (wolf) and detection (village) splits", () => {
    const board = applyGame({}, [
      seat("alpha", "evil", true),
      seat("beta", "good", false),
    ], "g1");
    expect(board["alpha"].asWolf).toEqual({ games: 1, wins: 1 });
    expect(board["alpha"].asVillage).toEqual({ games: 0, wins: 0 });
    expect(board["beta"].asVillage).toEqual({ games: 1, wins: 0 });
  });

  it("counts each seat a model holds as a separate participation", () => {
    const board = applyGame({}, [
      seat("alpha", "evil", true),
      seat("alpha", "good", false),
      seat("beta", "good", false),
    ], "g2");
    expect(board["alpha"].games).toBe(2);
    expect(board["alpha"].wins).toBe(1);
  });

  it("accumulates across games on an existing board", () => {
    const start: Leaderboard = { alpha: emptyRating("alpha") };
    const after = applyGame(start, [seat("alpha", "good", true), seat("beta", "evil", false)], "g3");
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

describe("jester + history", () => {
  const seat = (model: string, alignment: "good" | "evil" | "neutral", role: string, won: boolean) =>
    ({ seatId: 0, model, role, alignment, won, survived: true }) as SeatOutcome;

  it("a jester win rates the jester against everyone else", () => {
    const board = applyGame({}, [
      seat("j", "neutral", "jester", true),
      seat("a", "good", "villager", false),
      seat("b", "evil", "werewolf", false),
    ], "g1");
    expect(board["j"].elo).toBeGreaterThan(1000);
    expect(board["a"].elo).toBeLessThan(1000);
    expect(board["b"].elo).toBeLessThan(1000);
    expect(board["j"].asJester).toEqual({ games: 1, wins: 1 });
  });

  it("a losing jester is excluded from the rating exchange but counted in stats", () => {
    const board = applyGame({}, [
      seat("j", "neutral", "jester", false),
      seat("a", "good", "villager", true),
      seat("b", "evil", "werewolf", false),
    ], "g2");
    expect(board["j"].elo).toBe(1000);
    expect(board["j"].games).toBe(1);
    expect(board["j"].asJester).toEqual({ games: 1, wins: 0 });
    expect(board["a"].elo).toBeGreaterThan(1000);
  });

  it("appends history entries for rated models", () => {
    const board = applyGame({}, [
      seat("a", "good", "villager", true),
      seat("b", "evil", "werewolf", false),
    ], "g3");
    expect(board["a"].history).toEqual([{ gameId: "g3", delta: board["a"].elo - 1000, elo: board["a"].elo }]);
  });

  it("normalizes old entries missing asJester/history", () => {
    const legacy = { m: { model: "m", elo: 1010, games: 1, wins: 1, asWolf: { games: 0, wins: 0 }, asVillage: { games: 1, wins: 1 } } } as unknown as Leaderboard;
    const board = applyGame(legacy, [seat("m", "good", "villager", true), seat("x", "evil", "werewolf", false)], "g4");
    expect(board["m"].asJester).toEqual({ games: 0, wins: 0 });
    expect(board["m"].history.length).toBe(1);
  });
});
