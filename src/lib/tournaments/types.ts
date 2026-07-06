// Tournament domain types. State is persisted as plain JSON in the store;
// all math over it lives in schedule.ts as pure functions.

import { ToggleableRole, Winner } from "../engine/types";

export type TournamentFormat = "round_robin" | "knockout";
export type TournamentStatus = "running" | "finished" | "abandoned";
export type TournamentGameStatus = "pending" | "running" | "finished";

export interface TournamentConfig {
  name: string;
  format: TournamentFormat;
  /** Model ids competing (2–12, deduped). */
  roster: string[];
  /**
   * round_robin: number of season rounds (each round = one game per roster
   * rotation). knockout: best-of-N games per match (odd, 1–7).
   */
  gamesPerRound: number;
  numPlayers: number; // table size 5–12
  concurrency: number; // parallel games, default 1
  seed: number; // base seed; per-game seeds derived via mixSeed
  disabledRoles?: ToggleableRole[];
}

export interface TournamentGameRef {
  /** Stable key within the tournament (e.g. "r0g2" or "m3g1"). */
  key: string;
  seed: number;
  seatModels: string[];
  status: TournamentGameStatus;
  gameId?: string; // set once created
  winner?: Winner;
  /** Seat-win count per roster model in this game (attribution for scoring). */
  modelWins?: Record<string, number>;
}

export interface KnockoutMatch {
  key: string; // "m<round>-<index>"
  a: string | null; // model id; null = TBD (or bye slot)
  b: string | null;
  games: TournamentGameRef[];
  winner?: string; // model id
}

export interface Tournament {
  id: string;
  createdAt: string;
  status: TournamentStatus;
  config: TournamentConfig;
  /** round_robin: flat list of rounds, each a list of games. */
  rounds?: TournamentGameRef[][];
  /** knockout: bracket[roundIdx][matchIdx]. */
  bracket?: KnockoutMatch[][];
}

export interface StandingRow {
  model: string;
  games: number;
  wins: number; // games where this model had at least one winning seat
  seatWins: number; // total winning seats (tiebreak)
}
