import { describe, expect, it } from "vitest";
import {
  advanceBracket,
  attributeWins,
  buildKnockout,
  buildRoundRobin,
  isComplete,
  knockoutSeats,
  matchWinner,
  mixSeed,
  nextPending,
  roundRobinSeats,
  standings,
} from "./schedule";
import { KnockoutMatch, Tournament, TournamentConfig, TournamentGameRef } from "./types";
import { SeatOutcome } from "../engine/types";

function baseConfig(overrides: Partial<TournamentConfig> = {}): TournamentConfig {
  return {
    name: "t",
    format: "round_robin",
    roster: ["a", "b", "c", "d"],
    gamesPerRound: 3,
    numPlayers: 8,
    concurrency: 1,
    seed: 42,
    ...overrides,
  };
}

function seatOutcome(model: string, won: boolean): SeatOutcome {
  return { seatId: 0, model, role: "villager", alignment: "good", won, survived: won };
}

describe("mixSeed", () => {
  it("is deterministic for the same inputs", () => {
    expect(mixSeed(42, 1, 2)).toBe(mixSeed(42, 1, 2));
  });

  it("spreads across different coordinates", () => {
    const s1 = mixSeed(42, 0, 0);
    const s2 = mixSeed(42, 1, 0);
    const s3 = mixSeed(42, 0, 1);
    const s4 = mixSeed(42, 1, 1);
    const values = new Set([s1, s2, s3, s4]);
    expect(values.size).toBe(4);
  });

  it("spreads across different base seeds", () => {
    expect(mixSeed(1, 5, 5)).not.toBe(mixSeed(2, 5, 5));
  });

  it("always returns a non-negative 32-bit integer", () => {
    for (let i = 0; i < 20; i++) {
      const v = mixSeed(i * 7919, i, i * 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("roundRobinSeats", () => {
  it("returns exactly numPlayers seats", () => {
    const seats = roundRobinSeats(["a", "b", "c", "d"], 8, 0, 0);
    expect(seats.length).toBe(8);
  });

  it("only uses models from the roster", () => {
    const roster = ["a", "b", "c", "d"];
    const seats = roundRobinSeats(roster, 8, 2, 1);
    for (const s of seats) expect(roster).toContain(s);
  });

  it("rotates offset based on round and game so different rounds vary seating", () => {
    const roster = ["a", "b", "c", "d"];
    const r0 = roundRobinSeats(roster, 8, 0, 0);
    const r1 = roundRobinSeats(roster, 8, 1, 0);
    expect(r0).not.toEqual(r1);
  });

  it("every roster member appears at least once across enough rounds", () => {
    const roster = ["a", "b", "c", "d", "e"];
    const seen = new Set<string>();
    for (let round = 0; round < roster.length; round++) {
      for (const s of roundRobinSeats(roster, 5, round, 0)) seen.add(s);
    }
    for (const m of roster) expect(seen.has(m)).toBe(true);
  });

  it("is a pure function of its inputs (deterministic)", () => {
    expect(roundRobinSeats(["a", "b", "c"], 6, 3, 2)).toEqual(roundRobinSeats(["a", "b", "c"], 6, 3, 2));
  });
});

describe("knockoutSeats", () => {
  it("fills the first 4 seats alternating a/b, remaining with mock", () => {
    const seats = knockoutSeats("alpha", "beta", 8, 0);
    expect(seats.slice(0, 4)).toEqual(["alpha", "beta", "alpha", "beta"]);
    expect(seats.slice(4)).toEqual(["mock", "mock", "mock", "mock"]);
  });

  it("flips alternation parity based on game index", () => {
    const g0 = knockoutSeats("alpha", "beta", 4, 0);
    const g1 = knockoutSeats("alpha", "beta", 4, 1);
    expect(g0).toEqual(["alpha", "beta", "alpha", "beta"]);
    expect(g1).toEqual(["beta", "alpha", "beta", "alpha"]);
  });

  it("returns exactly numPlayers seats even below 4", () => {
    expect(knockoutSeats("alpha", "beta", 2, 0)).toEqual(["alpha", "beta"]);
  });

  it("fills all non-head-to-head seats with mock regardless of numPlayers", () => {
    const seats = knockoutSeats("alpha", "beta", 12, 0);
    expect(seats.length).toBe(12);
    expect(seats.slice(4).every((s) => s === "mock")).toBe(true);
  });
});

describe("buildRoundRobin", () => {
  it("builds exactly gamesPerRound rounds, each with one game", () => {
    const rounds = buildRoundRobin(baseConfig({ gamesPerRound: 3 }));
    expect(rounds.length).toBe(3);
    for (const round of rounds) expect(round.length).toBe(1);
  });

  it("keys each game as r<round>g0", () => {
    const rounds = buildRoundRobin(baseConfig({ gamesPerRound: 2 }));
    expect(rounds[0][0].key).toBe("r0g0");
    expect(rounds[1][0].key).toBe("r1g0");
  });

  it("derives each game's seed via mixSeed(config.seed, round, 0)", () => {
    const config = baseConfig({ gamesPerRound: 2, seed: 99 });
    const rounds = buildRoundRobin(config);
    expect(rounds[0][0].seed).toBe(mixSeed(99, 0, 0));
    expect(rounds[1][0].seed).toBe(mixSeed(99, 1, 0));
  });

  it("assigns seatModels via roundRobinSeats and starts games pending", () => {
    const config = baseConfig({ gamesPerRound: 1, roster: ["a", "b", "c"], numPlayers: 6 });
    const rounds = buildRoundRobin(config);
    expect(rounds[0][0].seatModels).toEqual(roundRobinSeats(["a", "b", "c"], 6, 0, 0));
    expect(rounds[0][0].status).toBe("pending");
  });

  it("is deterministic given the same config", () => {
    const config = baseConfig();
    expect(buildRoundRobin(config)).toEqual(buildRoundRobin(config));
  });
});

describe("buildKnockout", () => {
  const elo: Record<string, number> = { a: 1000, b: 1400, c: 1200, d: 800 };
  const eloOf = (m: string) => elo[m];

  it("seeds round 0 by elo descending: highest vs lowest", () => {
    const config = baseConfig({ format: "knockout", roster: ["a", "b", "c", "d"], gamesPerRound: 1 });
    const bracket = buildKnockout(config, eloOf);
    // sorted desc by elo: b(1400), c(1200), a(1000), d(800)
    // pairing: 1 vs last, 2 vs second-last => (b,d), (c,a)
    expect(bracket[0].map((m) => [m.a, m.b])).toEqual([
      ["b", "d"],
      ["c", "a"],
    ]);
  });

  it("pads to next power of 2 with byes for a 3-model roster", () => {
    const config = baseConfig({ format: "knockout", roster: ["a", "b", "c"], gamesPerRound: 1 });
    const bracket = buildKnockout(config, eloOf);
    expect(bracket[0].length).toBe(2); // 4-slot bracket => 2 matches in round 0
    const byeMatch = bracket[0].find((m) => m.b === null);
    expect(byeMatch).toBeDefined();
    // bye auto-advances: winner is set to `a` (the non-null side) immediately
    expect(byeMatch!.winner).toBe(byeMatch!.a);
    expect(byeMatch!.games).toEqual([]);
  });

  it("pads to next power of 2 with byes for a 5-model roster (8-slot bracket)", () => {
    const elo5: Record<string, number> = { a: 1000, b: 1400, c: 1200, d: 800, e: 1600 };
    const eloOf5 = (m: string) => elo5[m];
    const config = baseConfig({ format: "knockout", roster: ["a", "b", "c", "d", "e"], gamesPerRound: 1 });
    const bracket = buildKnockout(config, eloOf5);
    expect(bracket[0].length).toBe(4); // 8-slot bracket => 4 matches in round 0
    const byes = bracket[0].filter((m) => m.b === null);
    expect(byes.length).toBe(3); // 5 real seeds, 3 byes to fill 8 slots
    for (const bye of byes) {
      expect(bye.winner).toBe(bye.a);
      expect(bye.games).toEqual([]);
    }
  });

  it("gives real (non-bye) round-0 matches config.gamesPerRound games with correct keys/seeds", () => {
    const config = baseConfig({ format: "knockout", roster: ["a", "b", "c", "d"], gamesPerRound: 3, seed: 7 });
    const bracket = buildKnockout(config, eloOf);
    const m0 = bracket[0][0]; // index 0 => "m0-0"
    expect(m0.key).toBe("m0-0");
    expect(m0.games.length).toBe(3);
    expect(m0.games[0].key).toBe("m0-0g0");
    expect(m0.games[0].seed).toBe(mixSeed(7, 0 * 100 + 0, 0));
    expect(m0.games[1].key).toBe("m0-0g1");
    expect(m0.games[1].seed).toBe(mixSeed(7, 0 * 100 + 0, 1));
    expect(m0.games[0].seatModels).toEqual(knockoutSeats(m0.a!, m0.b!, config.numPlayers, 0));
  });

  it("leaves a roster of 2 as a single match with no byes", () => {
    const config = baseConfig({ format: "knockout", roster: ["a", "b"], gamesPerRound: 1 });
    const bracket = buildKnockout(config, eloOf);
    expect(bracket[0].length).toBe(1);
    expect(bracket[0][0].a).toBe("b"); // higher elo
    expect(bracket[0][0].b).toBe("a");
    expect(bracket[0][0].winner).toBeUndefined();
    expect(bracket[0][0].games.length).toBe(1);
  });

  it("builds all later rounds fully TBD with empty games", () => {
    const config = baseConfig({ format: "knockout", roster: ["a", "b", "c", "d"], gamesPerRound: 1 });
    const bracket = buildKnockout(config, eloOf);
    expect(bracket.length).toBe(2); // 4-slot bracket => 2 rounds (final is round 1)
    expect(bracket[1].length).toBe(1);
    expect(bracket[1][0].a).toBeNull();
    expect(bracket[1][0].b).toBeNull();
    expect(bracket[1][0].games).toEqual([]);
    expect(bracket[1][0].key).toBe("m1-0");
  });

  it("builds the right number of rounds for an 8-slot bracket", () => {
    const elo8: Record<string, number> = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
    const eloOf8 = (m: string) => elo8[m];
    const config = baseConfig({
      format: "knockout",
      roster: ["a", "b", "c", "d", "e", "f", "g", "h"],
      gamesPerRound: 1,
    });
    const bracket = buildKnockout(config, eloOf8);
    expect(bracket.length).toBe(3); // round of 8, semis, final
    expect(bracket[0].length).toBe(4);
    expect(bracket[1].length).toBe(2);
    expect(bracket[2].length).toBe(1);
  });
});

describe("attributeWins", () => {
  it("counts winning seats per roster model", () => {
    const outcomes: SeatOutcome[] = [
      seatOutcome("a", true),
      seatOutcome("a", true),
      seatOutcome("b", false),
      seatOutcome("mock", true),
      seatOutcome("c", false),
    ];
    const result = attributeWins(outcomes, ["a", "b", "c"]);
    expect(result).toEqual({ a: 2, b: 0, c: 0 });
  });

  it("ignores models not in the roster even if they won", () => {
    const outcomes: SeatOutcome[] = [seatOutcome("mock", true), seatOutcome("mock", true)];
    const result = attributeWins(outcomes, ["a", "b"]);
    expect(result).toEqual({ a: 0, b: 0 });
  });

  it("returns zero counts for an empty outcomes array", () => {
    expect(attributeWins([], ["a", "b"])).toEqual({ a: 0, b: 0 });
  });
});

describe("standings", () => {
  function game(key: string, seatModels: string[], modelWins: Record<string, number>): TournamentGameRef {
    return { key, seed: 0, seatModels, status: "finished", modelWins };
  }

  it("sorts by wins desc, then seatWins desc, then model asc", () => {
    const t: Tournament = {
      id: "t1",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "running",
      config: baseConfig({ roster: ["a", "b", "c"] }),
      rounds: [
        [game("r0g0", ["a", "b", "c"], { a: 1, b: 0, c: 0 })],
        [game("r1g0", ["a", "b", "c"], { a: 0, b: 1, c: 0 })],
        [game("r2g0", ["a", "b", "c"], { a: 2, b: 0, c: 0 })], // a wins with 2 seat-wins in one game
      ],
    };
    const rows = standings(t);
    // a: 2 games with >=1 win (r0, r2), seatWins = 1 + 2 = 3
    // b: 1 game with win (r1), seatWins = 1
    // c: 0
    expect(rows.map((r) => r.model)).toEqual(["a", "b", "c"]);
    expect(rows[0]).toEqual({ model: "a", games: 3, wins: 2, seatWins: 3 });
    expect(rows[1]).toEqual({ model: "b", games: 3, wins: 1, seatWins: 1 });
    expect(rows[2]).toEqual({ model: "c", games: 3, wins: 0, seatWins: 0 });
  });

  it("breaks equal wins by seatWins, then by model name ascending", () => {
    const t: Tournament = {
      id: "t2",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "running",
      config: baseConfig({ roster: ["z", "y", "x"] }),
      rounds: [
        [game("r0g0", ["z", "y", "x"], { z: 1, y: 1, x: 0 })], // both z and y win this game
      ],
    };
    const rows = standings(t);
    // z and y tie on wins=1, seatWins=1 -> alphabetical: y before z
    expect(rows.map((r) => r.model)).toEqual(["y", "z", "x"]);
  });

  it("only counts games as played that reference the model in seatModels", () => {
    const t: Tournament = {
      id: "t3",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "running",
      config: baseConfig({ roster: ["a", "b"] }),
      rounds: [[game("r0g0", ["a", "a", "b"], { a: 1, b: 0 })]],
    };
    const rows = standings(t);
    const a = rows.find((r) => r.model === "a")!;
    expect(a.games).toBe(1);
  });

  it("ignores unfinished/pending games", () => {
    const t: Tournament = {
      id: "t4",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "running",
      config: baseConfig({ roster: ["a", "b"] }),
      rounds: [
        [{ key: "r0g0", seed: 0, seatModels: ["a", "b"], status: "pending" }],
        [game("r1g0", ["a", "b"], { a: 1, b: 0 })],
      ],
    };
    const rows = standings(t);
    const a = rows.find((r) => r.model === "a")!;
    expect(a.games).toBe(1);
  });

  it("derives standings from bracket games for knockout tournaments", () => {
    const t: Tournament = {
      id: "t5",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "running",
      config: baseConfig({ format: "knockout", roster: ["a", "b"] }),
      bracket: [
        [
          {
            key: "m0-0",
            a: "a",
            b: "b",
            games: [game("m0-0g0", ["a", "b"], { a: 1, b: 0 })],
          },
        ],
      ],
    };
    const rows = standings(t);
    expect(rows.find((r) => r.model === "a")!.wins).toBe(1);
    expect(rows.find((r) => r.model === "b")!.wins).toBe(0);
  });
});

describe("matchWinner", () => {
  function gameRef(key: string, modelWins: Record<string, number>): TournamentGameRef {
    return { key, seed: 0, seatModels: Object.keys(modelWins), status: "finished", modelWins };
  }

  it("returns undefined while games remain unfinished", () => {
    const m: KnockoutMatch = {
      key: "m0-0",
      a: "a",
      b: "b",
      games: [
        gameRef("g0", { a: 1, b: 0 }),
        { key: "g1", seed: 0, seatModels: ["a", "b"], status: "pending" },
        { key: "g2", seed: 0, seatModels: ["a", "b"], status: "pending" },
      ],
    };
    expect(matchWinner(m)).toBeUndefined();
  });

  it("picks the model with more total seat-wins across a best-of-3 (2-1 split)", () => {
    const m: KnockoutMatch = {
      key: "m0-0",
      a: "a",
      b: "b",
      games: [
        gameRef("g0", { a: 1, b: 0 }),
        gameRef("g1", { a: 0, b: 1 }),
        gameRef("g2", { a: 1, b: 0 }),
      ],
    };
    expect(matchWinner(m)).toBe("a");
  });

  it("breaks a genuine total tie by higher share in the LAST game (a wins last game)", () => {
    const m: KnockoutMatch = {
      key: "m0-0",
      a: "a",
      b: "b",
      games: [
        gameRef("g0", { a: 1, b: 0 }), // a: 1, b: 0
        gameRef("g1", { a: 0, b: 2 }), // a: 1, b: 2
        gameRef("g2", { a: 1, b: 0 }), // a: 2, b: 2 (tied), last game favors a
      ],
    };
    // totals tied 2-2; last game a=1 > b=0 -> a wins
    expect(matchWinner(m)).toBe("a");
  });

  it("breaks a genuine total tie by higher share in the LAST game (b wins last game)", () => {
    const m: KnockoutMatch = {
      key: "m0-0",
      a: "a",
      b: "b",
      games: [
        gameRef("g0", { a: 2, b: 0 }), // a: 2, b: 0
        gameRef("g1", { a: 0, b: 1 }), // a: 2, b: 1
        gameRef("g2", { a: 0, b: 1 }), // a: 2, b: 2 (tied), last game favors b
      ],
    };
    // totals tied 2-2; last game b=1 > a=0 -> b wins
    expect(matchWinner(m)).toBe("b");
  });

  it("breaks a genuine total tie by last-game share, then falls back to `a` deterministically", () => {
    const m: KnockoutMatch = {
      key: "m0-0",
      a: "a",
      b: "b",
      games: [
        gameRef("g0", { a: 1, b: 1 }),
        gameRef("g1", { a: 1, b: 1 }),
      ],
    };
    // totals tied 2-2; last game also tied 1-1 -> fall back to `a`
    expect(matchWinner(m)).toBe("a");
  });

  it("returns the bye winner immediately when b is null (no games)", () => {
    const m: KnockoutMatch = { key: "m0-0", a: "a", b: null, games: [], winner: "a" };
    expect(matchWinner(m)).toBe("a");
  });

  it("returns undefined for a match with no games and no winner (TBD slot)", () => {
    const m: KnockoutMatch = { key: "m1-0", a: null, b: null, games: [] };
    expect(matchWinner(m)).toBeUndefined();
  });
});

describe("advanceBracket", () => {
  it("advances round-0 winners into round-1 slots", () => {
    const bracket: KnockoutMatch[][] = [
      [
        { key: "m0-0", a: "a", b: "b", games: [], winner: "a" },
        { key: "m0-1", a: "c", b: "d", games: [], winner: "d" },
      ],
      [{ key: "m1-0", a: null, b: null, games: [] }],
    ];
    const advanced = advanceBracket(bracket);
    expect(advanced[1][0].a).toBe("a");
    expect(advanced[1][0].b).toBe("d");
  });

  it("does not mutate the input bracket", () => {
    const bracket: KnockoutMatch[][] = [
      [{ key: "m0-0", a: "a", b: "b", games: [], winner: "a" }],
      [{ key: "m1-0", a: null, b: null, games: [] }],
    ];
    const before = JSON.parse(JSON.stringify(bracket));
    advanceBracket(bracket);
    expect(bracket).toEqual(before);
  });

  it("leaves next-round slots TBD when the feeder match has no winner yet", () => {
    const bracket: KnockoutMatch[][] = [
      [
        { key: "m0-0", a: "a", b: "b", games: [] },
        { key: "m0-1", a: "c", b: "d", games: [], winner: "d" },
      ],
      [{ key: "m1-0", a: null, b: null, games: [] }],
    ];
    const advanced = advanceBracket(bracket);
    expect(advanced[1][0].a).toBeNull();
    expect(advanced[1][0].b).toBe("d");
  });

  it("is a no-op safe to call repeatedly (idempotent on already-filled slots)", () => {
    const bracket: KnockoutMatch[][] = [
      [{ key: "m0-0", a: "a", b: "b", games: [], winner: "a" }],
      [{ key: "m1-0", a: null, b: null, games: [] }],
    ];
    const once = advanceBracket(bracket);
    const twice = advanceBracket(once);
    expect(twice).toEqual(once);
  });
});

describe("isComplete", () => {
  function game(key: string, status: "pending" | "running" | "finished"): TournamentGameRef {
    return { key, seed: 0, seatModels: ["a", "b"], status };
  }

  it("round_robin: false while any game is pending or running", () => {
    const t: Tournament = {
      id: "t1",
      createdAt: "x",
      status: "running",
      config: baseConfig(),
      rounds: [[game("r0g0", "finished")], [game("r1g0", "pending")]],
    };
    expect(isComplete(t)).toBe(false);
  });

  it("round_robin: true when every game is finished", () => {
    const t: Tournament = {
      id: "t2",
      createdAt: "x",
      status: "running",
      config: baseConfig(),
      rounds: [[game("r0g0", "finished")], [game("r1g0", "finished")]],
    };
    expect(isComplete(t)).toBe(true);
  });

  it("knockout: false while the final match has no winner", () => {
    const t: Tournament = {
      id: "t3",
      createdAt: "x",
      status: "running",
      config: baseConfig({ format: "knockout" }),
      bracket: [
        [{ key: "m0-0", a: "a", b: "b", games: [], winner: "a" }],
        [{ key: "m1-0", a: null, b: null, games: [] }],
      ],
    };
    expect(isComplete(t)).toBe(false);
  });

  it("knockout: true once the final match has a winner", () => {
    const t: Tournament = {
      id: "t4",
      createdAt: "x",
      status: "running",
      config: baseConfig({ format: "knockout" }),
      bracket: [
        [{ key: "m0-0", a: "a", b: "b", games: [], winner: "a" }],
        [{ key: "m1-0", a: "a", b: "c", games: [], winner: "c" }],
      ],
    };
    expect(isComplete(t)).toBe(true);
  });
});

describe("nextPending", () => {
  function game(key: string, status: "pending" | "running" | "finished"): TournamentGameRef {
    return { key, seed: 0, seatModels: ["a", "b"], status };
  }

  it("round_robin: returns pending games up to the limit, in order", () => {
    const t: Tournament = {
      id: "t1",
      createdAt: "x",
      status: "running",
      config: baseConfig(),
      rounds: [[game("r0g0", "finished")], [game("r1g0", "pending")], [game("r2g0", "pending")]],
    };
    const pending = nextPending(t, 1);
    expect(pending.map((g) => g.key)).toEqual(["r1g0"]);
    expect(nextPending(t, 5).map((g) => g.key)).toEqual(["r1g0", "r2g0"]);
  });

  it("round_robin: excludes already-running games", () => {
    const t: Tournament = {
      id: "t2",
      createdAt: "x",
      status: "running",
      config: baseConfig(),
      rounds: [[game("r0g0", "running")], [game("r1g0", "pending")]],
    };
    expect(nextPending(t, 5).map((g) => g.key)).toEqual(["r1g0"]);
  });

  it("knockout: only returns games from matches whose a & b are both known", () => {
    const t: Tournament = {
      id: "t3",
      createdAt: "x",
      status: "running",
      config: baseConfig({ format: "knockout" }),
      bracket: [
        [
          { key: "m0-0", a: "a", b: "b", games: [game("m0-0g0", "pending")] },
          { key: "m0-1", a: "c", b: null, games: [], winner: "c" }, // bye, no games
        ],
        [{ key: "m1-0", a: null, b: null, games: [game("m1-0g0", "pending")] }], // TBD slots, not eligible
      ],
    };
    const pending = nextPending(t, 5);
    expect(pending.map((g) => g.key)).toEqual(["m0-0g0"]);
  });

  it("knockout: respects the limit across matches", () => {
    const t: Tournament = {
      id: "t4",
      createdAt: "x",
      status: "running",
      config: baseConfig({ format: "knockout" }),
      bracket: [
        [
          { key: "m0-0", a: "a", b: "b", games: [game("m0-0g0", "pending"), game("m0-0g1", "pending")] },
          { key: "m0-1", a: "c", b: "d", games: [game("m0-1g0", "pending")] },
        ],
      ],
    };
    expect(nextPending(t, 2).map((g) => g.key)).toEqual(["m0-0g0", "m0-0g1"]);
  });
});
