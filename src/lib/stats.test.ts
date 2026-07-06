import { describe, expect, it } from "vitest";
import { normalizeRating, buildProfile } from "./stats";
import { DEFAULT_ELO, ModelRating } from "./elo";
import { Player, Transcript, GameEvent, SeatOutcome, GameConfig, GameResult } from "./engine/types";

// ---------------------------------------------------------------------------
// Helpers to hand-craft minimal, precise transcripts.
// ---------------------------------------------------------------------------

function player(id: number, model: string, role: Player["role"], alignment: Player["alignment"]): Player {
  return { id, name: `P${id}`, avatar: "🙂", model, role, alignment, alive: true };
}

function outcome(p: Player, won: boolean, survived = true): SeatOutcome {
  return { seatId: p.id, model: p.model, role: p.role, alignment: p.alignment, won, survived };
}

function baseConfig(numPlayers: number): GameConfig {
  return { numPlayers, seatModels: Array(numPlayers).fill("mock"), seed: 1 };
}

function baseResult(winner: GameResult["winner"], survivorIds: number[]): GameResult {
  return { winner, reason: "test", survivorIds, days: 1 };
}

// ---------------------------------------------------------------------------
// normalizeRating
// ---------------------------------------------------------------------------

describe("normalizeRating", () => {
  it("fills a complete default rating when given undefined", () => {
    const r = normalizeRating("alpha", undefined);
    expect(r).toEqual({
      model: "alpha",
      elo: DEFAULT_ELO,
      games: 0,
      wins: 0,
      asWolf: { games: 0, wins: 0 },
      asVillage: { games: 0, wins: 0 },
      asJester: { games: 0, wins: 0 },
      history: [],
    });
  });

  it("fills missing asJester/history on a legacy partial rating, preserving present fields", () => {
    const legacy: Partial<ModelRating> = {
      model: "alpha",
      elo: 1050,
      games: 3,
      wins: 2,
      asWolf: { games: 1, wins: 1 },
      asVillage: { games: 2, wins: 1 },
      // asJester and history intentionally missing (legacy record)
    };
    const r = normalizeRating("alpha", legacy);
    expect(r.model).toBe("alpha");
    expect(r.elo).toBe(1050);
    expect(r.games).toBe(3);
    expect(r.wins).toBe(2);
    expect(r.asWolf).toEqual({ games: 1, wins: 1 });
    expect(r.asVillage).toEqual({ games: 2, wins: 1 });
    expect(r.asJester).toEqual({ games: 0, wins: 0 });
    expect(r.history).toEqual([]);
  });

  it("forces the model field to the requested model id even if the partial disagrees", () => {
    const r = normalizeRating("beta", { model: "wrong-name" } as Partial<ModelRating>);
    expect(r.model).toBe("beta");
  });
});

// ---------------------------------------------------------------------------
// buildProfile: voteAccuracy
// ---------------------------------------------------------------------------

describe("buildProfile voteAccuracy", () => {
  // 5-seat hand-built game. alpha is the lone seat we care about, seated as
  // the (good-aligned) seer at seat 0. beta is the sole werewolf at seat 1.
  // alpha casts two day votes: one hits the wolf (seat 1), one misses (seat 3).
  const players: Player[] = [
    player(0, "alpha", "seer", "good"),
    player(1, "beta", "werewolf", "evil"),
    player(2, "gamma", "villager", "good"),
    player(3, "delta", "villager", "good"),
    player(4, "epsilon", "doctor", "good"),
  ];

  const events: GameEvent[] = [
    { kind: "game_start", day: 0 },
    // Day 1: alpha votes for the wolf (hit). Another player's vote must be ignored.
    { kind: "vote", day: 1, voterId: 0, targetId: 1 },
    { kind: "vote", day: 1, voterId: 2, targetId: 1 },
    { kind: "vote_result", day: 1, tally: { 1: 2 }, eliminatedId: null, tie: false },
    // Day 2: alpha votes for a villager (miss). An abstain (null target) must not count.
    { kind: "vote", day: 2, voterId: 0, targetId: 3 },
    { kind: "vote", day: 2, voterId: 4, targetId: null },
    { kind: "vote_result", day: 2, tally: { 3: 1 }, eliminatedId: null, tie: false },
    { kind: "game_over", winner: "good", reason: "test", survivorIds: [0, 2, 3, 4] },
  ];

  const outcomes: SeatOutcome[] = [
    outcome(players[0], true),
    outcome(players[1], false, false),
    outcome(players[2], true),
    outcome(players[3], true),
    outcome(players[4], true),
  ];

  const transcript: Transcript = {
    id: "g1",
    createdAt: "2026-01-01T00:00:00.000Z",
    config: baseConfig(5),
    players,
    events,
    result: baseResult("good", [0, 2, 3, 4]),
    outcomes,
  };

  it("counts exactly one hit and two total good-aligned day votes for alpha", () => {
    const profile = buildProfile("alpha", undefined, [transcript]);
    expect(profile.voteAccuracy).toEqual({ hits: 1, total: 2 });
  });

  it("does not attribute alpha's votes to a model with no seat in the game", () => {
    const profile = buildProfile("zeta", undefined, [transcript]);
    expect(profile.voteAccuracy).toEqual({ hits: 0, total: 0 });
  });

  it("ignores votes cast by evil-aligned seats of the same model", () => {
    // beta (werewolf, evil) also votes for the wolf itself — must not count
    // toward voteAccuracy since only "good" alignment seats are considered.
    const evilVoteEvents: GameEvent[] = [
      ...events,
      { kind: "vote", day: 1, voterId: 1, targetId: 1 },
    ];
    const t2: Transcript = { ...transcript, events: evilVoteEvents };
    const profile = buildProfile("beta", undefined, [t2]);
    expect(profile.voteAccuracy).toEqual({ hits: 0, total: 0 });
  });
});

// ---------------------------------------------------------------------------
// buildProfile: headToHead
// ---------------------------------------------------------------------------

describe("buildProfile headToHead", () => {
  // Game 1: alpha (good) vs beta (evil) and gamma (evil). Good wins.
  // alpha's opposing side (evil) contains beta AND gamma — both share one
  // alignment vs alpha, so this must count as exactly one win against each
  // opponent (one-increment-per-game-per-opponent), not two per opponent.
  const g1Players: Player[] = [
    player(0, "alpha", "seer", "good"),
    player(1, "beta", "werewolf", "evil"),
    player(2, "gamma", "werewolf", "evil"),
    player(3, "delta", "villager", "good"),
    player(4, "epsilon", "villager", "good"),
  ];
  const g1: Transcript = {
    id: "g1",
    createdAt: "2026-01-01T00:00:00.000Z",
    config: baseConfig(5),
    players: g1Players,
    events: [{ kind: "game_start", day: 0 }, { kind: "game_over", winner: "good", reason: "t", survivorIds: [0, 3, 4] }],
    result: baseResult("good", [0, 3, 4]),
    outcomes: [
      outcome(g1Players[0], true),
      outcome(g1Players[1], false, false),
      outcome(g1Players[2], false, false),
      outcome(g1Players[3], true),
      outcome(g1Players[4], true),
    ],
  };

  // Game 2: alpha now seated evil (werewolf) opposite beta (good). Evil wins,
  // so alpha's head-to-head against beta should register a loss this time
  // (from beta's perspective) but a WIN for alpha against beta.
  const g2Players: Player[] = [
    player(0, "alpha", "werewolf", "evil"),
    player(1, "beta", "seer", "good"),
    player(2, "gamma", "villager", "good"),
    player(3, "delta", "villager", "good"),
    player(4, "epsilon", "villager", "good"),
  ];
  const g2: Transcript = {
    id: "g2",
    createdAt: "2026-01-02T00:00:00.000Z",
    config: baseConfig(5),
    players: g2Players,
    events: [{ kind: "game_start", day: 0 }, { kind: "game_over", winner: "evil", reason: "t", survivorIds: [0] }],
    result: baseResult("evil", [0]),
    outcomes: [
      outcome(g2Players[0], true),
      outcome(g2Players[1], false, false),
      outcome(g2Players[2], false, false),
      outcome(g2Players[3], false, false),
      outcome(g2Players[4], false, false),
    ],
  };

  // Game 3: alpha and beta seated on the SAME alignment (both good) — no
  // opposing relationship, must not contribute to alpha-vs-beta head-to-head.
  const g3Players: Player[] = [
    player(0, "alpha", "villager", "good"),
    player(1, "beta", "doctor", "good"),
    player(2, "gamma", "werewolf", "evil"),
    player(3, "delta", "werewolf", "evil"),
    player(4, "epsilon", "villager", "good"),
  ];
  const g3: Transcript = {
    id: "g3",
    createdAt: "2026-01-03T00:00:00.000Z",
    config: baseConfig(5),
    players: g3Players,
    events: [{ kind: "game_start", day: 0 }, { kind: "game_over", winner: "good", reason: "t", survivorIds: [0, 1, 4] }],
    result: baseResult("good", [0, 1, 4]),
    outcomes: [
      outcome(g3Players[0], true),
      outcome(g3Players[1], true),
      outcome(g3Players[2], false, false),
      outcome(g3Players[3], false, false),
      outcome(g3Players[4], true),
    ],
  };

  // Game 4: alpha seated as jester (neutral) opposite beta (good). Jester
  // seats must be ignored entirely for head-to-head purposes.
  const g4Players: Player[] = [
    player(0, "alpha", "jester", "neutral"),
    player(1, "beta", "villager", "good"),
    player(2, "gamma", "werewolf", "evil"),
    player(3, "delta", "villager", "good"),
    player(4, "epsilon", "villager", "good"),
  ];
  const g4: Transcript = {
    id: "g4",
    createdAt: "2026-01-04T00:00:00.000Z",
    config: baseConfig(5),
    players: g4Players,
    events: [{ kind: "game_start", day: 0 }, { kind: "game_over", winner: "jester", reason: "t", survivorIds: [0] }],
    result: baseResult("jester", [0]),
    outcomes: [
      outcome(g4Players[0], true),
      outcome(g4Players[1], false, false),
      outcome(g4Players[2], false, false),
      outcome(g4Players[3], false, false),
      outcome(g4Players[4], false, false),
    ],
  };

  it("counts one win per opponent per game even when multiple opposing seats share that opponent", () => {
    const profile = buildProfile("alpha", undefined, [g1]);
    const vsBeta = profile.headToHead.find((h) => h.opponent === "beta");
    const vsGamma = profile.headToHead.find((h) => h.opponent === "gamma");
    expect(vsBeta).toEqual({ opponent: "beta", games: 1, wins: 1, losses: 0 });
    expect(vsGamma).toEqual({ opponent: "gamma", games: 1, wins: 1, losses: 0 });
  });

  it("accumulates wins/losses across games and ignores same-alignment and jester games", () => {
    const profile = buildProfile("alpha", undefined, [g1, g2, g3, g4]);
    const vsBeta = profile.headToHead.find((h) => h.opponent === "beta")!;
    // g1: alpha(good) vs beta(evil), good won -> alpha win.
    // g2: alpha(evil) vs beta(good), evil won -> alpha win.
    // g3: alpha(good) & beta(good) same alignment -> not counted.
    // g4: alpha is jester -> not counted.
    expect(vsBeta.games).toBe(2);
    expect(vsBeta.wins).toBe(2);
    expect(vsBeta.losses).toBe(0);

    // gamma opposes alpha in g1 (evil vs alpha-good, good won -> alpha win),
    // g2 (gamma-good vs alpha-evil, evil won -> alpha win), and g3
    // (evil vs alpha-good, good won -> alpha win). g4 is jester -> skipped.
    const vsGamma = profile.headToHead.find((h) => h.opponent === "gamma")!;
    expect(vsGamma.games).toBe(3);
    expect(vsGamma.wins).toBe(3);
    expect(vsGamma.losses).toBe(0);
  });

  it("sorts headToHead entries by games descending", () => {
    const profile = buildProfile("alpha", undefined, [g1, g2, g3, g4]);
    const gamesList = profile.headToHead.map((h) => h.games);
    const sorted = [...gamesList].sort((a, b) => b - a);
    expect(gamesList).toEqual(sorted);
  });

  it("registers a loss when the opponent's side wins", () => {
    // alpha (good) loses to beta+gamma (evil) side.
    const lossPlayers: Player[] = [
      player(0, "alpha", "seer", "good"),
      player(1, "beta", "werewolf", "evil"),
      player(2, "gamma", "villager", "good"),
      player(3, "delta", "villager", "good"),
      player(4, "epsilon", "villager", "good"),
    ];
    const lossGame: Transcript = {
      id: "g5",
      createdAt: "2026-01-05T00:00:00.000Z",
      config: baseConfig(5),
      players: lossPlayers,
      events: [{ kind: "game_start", day: 0 }, { kind: "game_over", winner: "evil", reason: "t", survivorIds: [1] }],
      result: baseResult("evil", [1]),
      outcomes: [
        outcome(lossPlayers[0], false, false),
        outcome(lossPlayers[1], true),
        outcome(lossPlayers[2], false, false),
        outcome(lossPlayers[3], false, false),
        outcome(lossPlayers[4], false, false),
      ],
    };
    const profile = buildProfile("alpha", undefined, [lossGame]);
    const vsBeta = profile.headToHead.find((h) => h.opponent === "beta");
    expect(vsBeta).toEqual({ opponent: "beta", games: 1, wins: 0, losses: 1 });
  });
});

// ---------------------------------------------------------------------------
// buildProfile: perRole
// ---------------------------------------------------------------------------

describe("buildProfile perRole", () => {
  it("counts every seat individually, including a model seated twice in one game", () => {
    // alpha occupies TWO seats in the same game: a winning seer seat and a
    // losing villager seat. Each seat must count separately toward perRole.
    const players: Player[] = [
      player(0, "alpha", "seer", "good"),
      player(1, "alpha", "villager", "good"),
      player(2, "beta", "werewolf", "evil"),
      player(3, "gamma", "villager", "good"),
      player(4, "delta", "villager", "good"),
    ];
    const transcript: Transcript = {
      id: "g1",
      createdAt: "2026-01-01T00:00:00.000Z",
      config: baseConfig(5),
      players,
      events: [{ kind: "game_start", day: 0 }, { kind: "game_over", winner: "good", reason: "t", survivorIds: [0, 3, 4] }],
      result: baseResult("good", [0, 3, 4]),
      outcomes: [
        outcome(players[0], true),
        outcome(players[1], false, false),
        outcome(players[2], false, false),
        outcome(players[3], true),
        outcome(players[4], true),
      ],
    };

    const profile = buildProfile("alpha", undefined, [transcript]);
    expect(profile.perRole.seer).toEqual({ games: 1, wins: 1 });
    expect(profile.perRole.villager).toEqual({ games: 1, wins: 0 });
  });

  it("accumulates perRole counts across multiple games", () => {
    const mkGame = (id: string, role: Player["role"], won: boolean): Transcript => {
      const players: Player[] = [
        player(0, "alpha", role, role === "werewolf" ? "evil" : "good"),
        player(1, "beta", "villager", "good"),
        player(2, "gamma", "werewolf", "evil"),
        player(3, "delta", "villager", "good"),
        player(4, "epsilon", "villager", "good"),
      ];
      return {
        id,
        createdAt: "2026-01-01T00:00:00.000Z",
        config: baseConfig(5),
        players,
        events: [{ kind: "game_start", day: 0 }, { kind: "game_over", winner: won ? "good" : "evil", reason: "t", survivorIds: [] }],
        result: baseResult(won ? "good" : "evil", []),
        outcomes: players.map((p) => outcome(p, p.id === 0 ? won : !won, false)),
      };
    };
    const profile = buildProfile("alpha", undefined, [
      mkGame("g1", "villager", true),
      mkGame("g2", "villager", false),
      mkGame("g3", "doctor", true),
    ]);
    expect(profile.perRole.villager).toEqual({ games: 2, wins: 1 });
    expect(profile.perRole.doctor).toEqual({ games: 1, wins: 1 });
  });
});

// ---------------------------------------------------------------------------
// buildProfile: recentGames
// ---------------------------------------------------------------------------

describe("buildProfile recentGames", () => {
  function mkGame(id: string, createdAt: string, seatId: number, role: Player["role"], won: boolean, winner: GameResult["winner"]): Transcript {
    const players: Player[] = Array.from({ length: 5 }, (_, i) =>
      i === seatId ? player(i, "alpha", role, "good") : player(i, `bot${i}`, "villager", "good")
    );
    return {
      id,
      createdAt,
      config: baseConfig(5),
      players,
      events: [{ kind: "game_start", day: 0 }, { kind: "game_over", winner, reason: "t", survivorIds: [] }],
      result: baseResult(winner, []),
      outcomes: players.map((p) => outcome(p, p.id === seatId ? won : !won, false)),
    };
  }

  it("orders newest first by createdAt regardless of input order", () => {
    const older = mkGame("g-old", "2026-01-01T00:00:00.000Z", 0, "villager", true, "good");
    const newer = mkGame("g-new", "2026-01-03T00:00:00.000Z", 0, "seer", false, "evil");
    const middle = mkGame("g-mid", "2026-01-02T00:00:00.000Z", 0, "doctor", true, "good");

    const profile = buildProfile("alpha", undefined, [older, newer, middle]);
    expect(profile.recentGames.map((g) => g.id)).toEqual(["g-new", "g-mid", "g-old"]);
    expect(profile.recentGames[0]).toEqual({ id: "g-new", createdAt: "2026-01-03T00:00:00.000Z", role: "seer", won: false, winner: "evil" });
  });

  it("caps recentGames at 20 even when more transcripts are supplied", () => {
    const games = Array.from({ length: 25 }, (_, i) =>
      mkGame(`g${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, 0, "villager", true, "good")
    );
    const profile = buildProfile("alpha", undefined, games);
    expect(profile.recentGames.length).toBe(20);
    // newest of the 25 (g24, the 25th day) should be first.
    expect(profile.recentGames[0].id).toBe("g24");
  });

  it("uses the FIRST seat by seatId for role/winner reporting when a model has multiple seats", () => {
    const players: Player[] = [
      player(0, "alpha", "villager", "good"),
      player(1, "alpha", "seer", "good"),
      player(2, "beta", "werewolf", "evil"),
      player(3, "gamma", "villager", "good"),
      player(4, "delta", "villager", "good"),
    ];
    const transcript: Transcript = {
      id: "multi",
      createdAt: "2026-01-01T00:00:00.000Z",
      config: baseConfig(5),
      players,
      events: [{ kind: "game_start", day: 0 }, { kind: "game_over", winner: "good", reason: "t", survivorIds: [] }],
      result: baseResult("good", []),
      outcomes: [
        outcome(players[0], false, false),
        outcome(players[1], true),
        outcome(players[2], false, false),
        outcome(players[3], true),
        outcome(players[4], true),
      ],
    };
    const profile = buildProfile("alpha", undefined, [transcript]);
    expect(profile.recentGames[0]).toEqual({ id: "multi", createdAt: "2026-01-01T00:00:00.000Z", role: "villager", won: true, winner: "good" });
  });
});

// ---------------------------------------------------------------------------
// buildProfile: survivalRate + rating passthrough
// ---------------------------------------------------------------------------

describe("buildProfile survivalRate and rating", () => {
  it("counts survived seats over total seats for the model", () => {
    const players: Player[] = [
      player(0, "alpha", "seer", "good"),
      player(1, "beta", "werewolf", "evil"),
      player(2, "alpha", "villager", "good"),
      player(3, "gamma", "villager", "good"),
      player(4, "delta", "villager", "good"),
    ];
    const transcript: Transcript = {
      id: "g1",
      createdAt: "2026-01-01T00:00:00.000Z",
      config: baseConfig(5),
      players,
      events: [{ kind: "game_start", day: 0 }, { kind: "game_over", winner: "good", reason: "t", survivorIds: [0] }],
      result: baseResult("good", [0]),
      outcomes: [
        outcome(players[0], true, true),
        outcome(players[1], false, false),
        outcome(players[2], true, false),
        outcome(players[3], false, false),
        outcome(players[4], false, false),
      ],
    };
    const profile = buildProfile("alpha", undefined, [transcript]);
    expect(profile.survivalRate).toEqual({ survived: 1, games: 2 });
  });

  it("normalizes the supplied rating and stamps the model id", () => {
    const profile = buildProfile("alpha", { elo: 1200, games: 5, wins: 3 }, []);
    expect(profile.model).toBe("alpha");
    expect(profile.rating.model).toBe("alpha");
    expect(profile.rating.elo).toBe(1200);
    expect(profile.rating.asJester).toEqual({ games: 0, wins: 0 });
    expect(profile.rating.history).toEqual([]);
  });

  it("produces shapes with no NaN when a model has zero games anywhere", () => {
    const profile = buildProfile("ghost", undefined, []);
    expect(profile.voteAccuracy).toEqual({ hits: 0, total: 0 });
    expect(profile.survivalRate).toEqual({ survived: 0, games: 0 });
    expect(profile.headToHead).toEqual([]);
    expect(profile.recentGames).toEqual([]);
    expect(profile.perRole).toEqual({});
  });
});
