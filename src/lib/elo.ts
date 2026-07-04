// Team-ELO leaderboard. After each game we treat it as winning-team vs
// losing-team and update every participating seat's model toward the average
// rating of the opposing team. A model occupying multiple seats accrues the
// sum of its per-seat deltas. Pure functions — easy to test and to persist.

import { SeatOutcome } from "./engine/types";

export const DEFAULT_ELO = 1000;
const K = 24;

export interface SplitStats {
  games: number;
  wins: number;
}

export interface ModelRating {
  model: string;
  elo: number;
  games: number;
  wins: number;
  asWolf: SplitStats;
  asVillage: SplitStats;
}

export type Leaderboard = Record<string, ModelRating>;

export function emptyRating(model: string): ModelRating {
  return {
    model,
    elo: DEFAULT_ELO,
    games: 0,
    wins: 0,
    asWolf: { games: 0, wins: 0 },
    asVillage: { games: 0, wins: 0 },
  };
}

function clone(board: Leaderboard): Leaderboard {
  const next: Leaderboard = {};
  for (const [k, v] of Object.entries(board)) {
    next[k] = { ...v, asWolf: { ...v.asWolf }, asVillage: { ...v.asVillage } };
  }
  return next;
}

function expected(rating: number, opponent: number): number {
  return 1 / (1 + Math.pow(10, (opponent - rating) / 400));
}

function average(seats: SeatOutcome[], pre: Map<string, number>): number {
  if (seats.length === 0) return DEFAULT_ELO;
  const sum = seats.reduce((acc, o) => acc + (pre.get(o.model) ?? DEFAULT_ELO), 0);
  return sum / seats.length;
}

/** Returns a new leaderboard with one game's results folded in. */
export function applyGame(board: Leaderboard, outcomes: SeatOutcome[]): Leaderboard {
  const next = clone(board);
  const ensure = (m: string): ModelRating => {
    if (!next[m]) next[m] = emptyRating(m);
    return next[m];
  };

  for (const o of outcomes) ensure(o.model);

  // Snapshot pre-game ratings so all updates use the same baseline.
  const pre = new Map<string, number>();
  for (const m of Object.keys(next)) pre.set(m, next[m].elo);

  const winners = outcomes.filter((o) => o.won);
  const losers = outcomes.filter((o) => !o.won);
  const winnersAvg = average(winners, pre);
  const losersAvg = average(losers, pre);

  const delta = new Map<string, number>();
  for (const o of outcomes) {
    const oppAvg = o.won ? losersAvg : winnersAvg;
    const exp = expected(pre.get(o.model) ?? DEFAULT_ELO, oppAvg);
    const score = o.won ? 1 : 0;
    delta.set(o.model, (delta.get(o.model) ?? 0) + K * (score - exp));
  }

  // Update aggregate + split stats per seat.
  for (const o of outcomes) {
    const r = ensure(o.model);
    r.games += 1;
    if (o.won) r.wins += 1;
    if (o.alignment === "evil") {
      r.asWolf.games += 1;
      if (o.won) r.asWolf.wins += 1;
    } else {
      r.asVillage.games += 1;
      if (o.won) r.asVillage.wins += 1;
    }
  }

  // Apply rating deltas off the snapshot.
  for (const [m, d] of delta) {
    ensure(m).elo = Math.round((pre.get(m) ?? DEFAULT_ELO) + d);
  }

  return next;
}

export function winRate(stats: SplitStats): number {
  return stats.games === 0 ? 0 : stats.wins / stats.games;
}

/** Models sorted for display: highest ELO first, then most games. */
export function rankedModels(board: Leaderboard): ModelRating[] {
  return Object.values(board).sort((a, b) => b.elo - a.elo || b.games - a.games);
}
