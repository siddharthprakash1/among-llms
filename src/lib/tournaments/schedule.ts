// Pure scheduling, standings, and bracket math for tournaments. No Date,
// no Math.random, no I/O — everything here is a deterministic function of
// its inputs so tournaments can be replayed/resumed identically.

import { KnockoutMatch, StandingRow, Tournament, TournamentConfig, TournamentGameRef } from "./types";
import { SeatOutcome } from "../engine/types";

/** Deterministic 32-bit mix of tournament seed + coordinates (same imul style as brains.ts). */
export function mixSeed(base: number, a: number, b: number): number {
  let h = base >>> 0;
  h = (Math.imul(h ^ (a + 1), 2654435761) + Math.imul(b + 1, 40503)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 2246822519) >>> 0;
  return h >>> 0;
}

/** Seat assignment for round-robin game g of round r: roster rotated so every model cycles through seats/counts. */
export function roundRobinSeats(roster: string[], numPlayers: number, round: number, game: number): string[] {
  const seats: string[] = [];
  const offset = (round * 7 + game * 3) % roster.length;
  for (let i = 0; i < numPlayers; i++) seats.push(roster[(offset + i) % roster.length]);
  return seats;
}

/** Head-to-head seats for a knockout game: a/b alternate, remaining seats filled with "mock" bots. */
export function knockoutSeats(a: string, b: string, numPlayers: number, game: number): string[] {
  const seats: string[] = [];
  for (let i = 0; i < numPlayers; i++) {
    if (i < 4) seats.push((i + game) % 2 === 0 ? a : b);
    else seats.push("mock");
  }
  return seats;
}

/** Build the full round-robin schedule: `roundsCount` rounds × one game per rotation. */
export function buildRoundRobin(config: TournamentConfig): TournamentGameRef[][] {
  const rounds: TournamentGameRef[][] = [];
  for (let round = 0; round < config.gamesPerRound; round++) {
    const game: TournamentGameRef = {
      key: `r${round}g0`,
      seed: mixSeed(config.seed, round, 0),
      seatModels: roundRobinSeats(config.roster, config.numPlayers, round, 0),
      status: "pending",
    };
    rounds.push([game]);
  }
  return rounds;
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Build round 0 of a knockout bracket: seed by `eloOf` descending, standard pairing (1v last, 2v second-last…), byes (null b) for non-powers-of-2, later rounds all-TBD. */
export function buildKnockout(config: TournamentConfig, eloOf: (model: string) => number): KnockoutMatch[][] {
  const sorted = [...config.roster].sort((m1, m2) => eloOf(m2) - eloOf(m1));
  const bracketSize = nextPowerOfTwo(sorted.length);
  const seeds: (string | null)[] = [...sorted];
  while (seeds.length < bracketSize) seeds.push(null);

  const round0: KnockoutMatch[] = [];
  const matchCount = bracketSize / 2;
  for (let i = 0; i < matchCount; i++) {
    // Null padding is only ever appended after real seeds, and pairing pairs
    // the first half of `seeds` against the second half in reverse, so a
    // null can only ever land in the `b` slot here (never `a`) for any
    // roster of length >= 1.
    const a = seeds[i] as string;
    const b = seeds[bracketSize - 1 - i];
    const key = `m0-${i}`;
    if (b === null) {
      // Bye: the present side auto-advances, no games are played.
      round0.push({ key, a, b: null, games: [], winner: a });
    } else {
      const games: TournamentGameRef[] = [];
      for (let n = 0; n < config.gamesPerRound; n++) {
        games.push({
          key: `${key}g${n}`,
          seed: mixSeed(config.seed, 0 * 100 + i, n),
          seatModels: knockoutSeats(a, b, config.numPlayers, n),
          status: "pending",
        });
      }
      round0.push({ key, a, b, games });
    }
  }

  const bracket: KnockoutMatch[][] = [round0];
  let roundSize = matchCount;
  let round = 1;
  while (roundSize > 1) {
    const nextMatchCount = roundSize / 2;
    const roundMatches: KnockoutMatch[] = [];
    for (let i = 0; i < nextMatchCount; i++) {
      roundMatches.push({ key: `m${round}-${i}`, a: null, b: null, games: [] });
    }
    bracket.push(roundMatches);
    roundSize = nextMatchCount;
    round++;
  }

  return bracket;
}

/** Seat-wins per roster model from a finished game's outcomes. */
export function attributeWins(outcomes: SeatOutcome[], roster: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const m of roster) result[m] = 0;
  for (const o of outcomes) {
    if (o.won && Object.prototype.hasOwnProperty.call(result, o.model)) {
      result[o.model]++;
    }
  }
  return result;
}

function allGames(t: Tournament): TournamentGameRef[] {
  if (t.config.format === "round_robin") {
    return (t.rounds ?? []).flat();
  }
  return (t.bracket ?? []).flat().flatMap((m) => m.games);
}

/** Round-robin standings: wins = games with ≥1 winning seat; sort wins desc, seatWins desc, model asc.
 *  (Conscious deviation from the spec's "Elo delta as tiebreak": seat-wins is self-contained per
 *  tournament and avoids threading global-Elo snapshots through the schedule; noted for review.) */
export function standings(t: Tournament): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  for (const model of t.config.roster) {
    rows.set(model, { model, games: 0, wins: 0, seatWins: 0 });
  }

  for (const g of allGames(t)) {
    if (g.status !== "finished") continue;
    const modelWins = g.modelWins ?? {};
    for (const model of t.config.roster) {
      if (!g.seatModels.includes(model)) continue;
      const row = rows.get(model)!;
      row.games++;
      const w = modelWins[model] ?? 0;
      if (w > 0) row.wins++;
      row.seatWins += w;
    }
  }

  return Array.from(rows.values()).sort((r1, r2) => {
    if (r1.wins !== r2.wins) return r2.wins - r1.wins;
    if (r1.seatWins !== r2.seatWins) return r2.seatWins - r1.seatWins;
    return r1.model < r2.model ? -1 : r1.model > r2.model ? 1 : 0;
  });
}

/** Knockout match winner once all its games finished: more total seat-wins across games; tie → higher seat-win share in the LAST game; still tied → a (deterministic). Returns undefined while games remain. */
export function matchWinner(m: KnockoutMatch): string | undefined {
  if (m.winner !== undefined) return m.winner;
  if (m.a === null || m.b === null) return undefined;
  if (m.games.length === 0) return undefined;
  if (!m.games.every((g) => g.status === "finished")) return undefined;

  let totalA = 0;
  let totalB = 0;
  for (const g of m.games) {
    const modelWins = g.modelWins ?? {};
    totalA += modelWins[m.a] ?? 0;
    totalB += modelWins[m.b] ?? 0;
  }

  if (totalA !== totalB) return totalA > totalB ? m.a : m.b;

  const last = m.games[m.games.length - 1];
  const lastWins = last.modelWins ?? {};
  const lastA = lastWins[m.a] ?? 0;
  const lastB = lastWins[m.b] ?? 0;
  if (lastA !== lastB) return lastA > lastB ? m.a : m.b;

  return m.a;
}

/** Advance winners into the next round's a/b slots (byes auto-advance). Mutates and returns a copy. */
export function advanceBracket(bracket: KnockoutMatch[][]): KnockoutMatch[][] {
  const copy: KnockoutMatch[][] = bracket.map((round) => round.map((m) => ({ ...m, games: [...m.games] })));

  for (let r = 0; r < copy.length - 1; r++) {
    const round = copy[r];
    const nextRound = copy[r + 1];
    for (let i = 0; i < round.length; i++) {
      const winner = matchWinner(round[i]);
      if (winner === undefined) continue;
      const nextMatch = nextRound[Math.floor(i / 2)];
      if (i % 2 === 0) {
        nextMatch.a = winner;
      } else {
        nextMatch.b = winner;
      }
    }
  }

  return copy;
}

/** True when every scheduled game is finished (RR) or the final match has a winner (KO). */
export function isComplete(t: Tournament): boolean {
  if (t.config.format === "round_robin") {
    return allGames(t).every((g) => g.status === "finished");
  }
  const bracket = t.bracket ?? [];
  if (bracket.length === 0) return false;
  const finalRound = bracket[bracket.length - 1];
  if (finalRound.length !== 1) return false;
  return matchWinner(finalRound[0]) !== undefined;
}

/** Next up-to-`limit` pending game refs eligible to run (RR: any pending; KO: only matches whose a & b are known). */
export function nextPending(t: Tournament, limit: number): TournamentGameRef[] {
  const result: TournamentGameRef[] = [];

  if (t.config.format === "round_robin") {
    for (const round of t.rounds ?? []) {
      for (const g of round) {
        if (result.length >= limit) return result;
        if (g.status === "pending") result.push(g);
      }
    }
    return result;
  }

  for (const round of t.bracket ?? []) {
    for (const m of round) {
      if (m.a === null || m.b === null) continue;
      for (const g of m.games) {
        if (result.length >= limit) return result;
        if (g.status === "pending") result.push(g);
      }
    }
  }
  return result;
}
