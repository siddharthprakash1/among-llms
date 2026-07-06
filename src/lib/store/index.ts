// Storage abstraction. The default implementation is a zero-config JSON file
// store (perfect for local runs); swap `store` for a KV/DB adapter to persist
// on serverless hosts. See README "Deploying".

import { Transcript, Winner } from "../engine/types";
import { Leaderboard } from "../elo";
import { Tournament } from "../tournaments/types";

export interface GameSummary {
  id: string;
  createdAt: string;
  numPlayers: number;
  models: string[]; // distinct model ids seated
  winner: Winner;
  days: number;
  seed: number;
}

export interface TournamentSummary {
  id: string;
  createdAt: string;
  name: string;
  format: string;
  status: string;
  roster: string[];
}

export interface Store {
  saveTranscript(t: Transcript): Promise<void>;
  getTranscript(id: string): Promise<Transcript | null>;
  listSummaries(limit?: number): Promise<GameSummary[]>;
  getLeaderboard(): Promise<Leaderboard>;
  /** Atomic read-modify-write: serialized so concurrent games can't clobber each other. */
  updateLeaderboard(updater: (board: Leaderboard) => Leaderboard): Promise<Leaderboard>;
  saveTournament(t: Tournament): Promise<void>;
  getTournament(id: string): Promise<Tournament | null>;
  listTournaments(limit?: number): Promise<TournamentSummary[]>;
}

export function summarizeTournament(t: Tournament): TournamentSummary {
  return {
    id: t.id,
    createdAt: t.createdAt,
    name: t.config.name,
    format: t.config.format,
    status: t.status,
    roster: t.config.roster,
  };
}

export function summarize(t: Transcript): GameSummary {
  return {
    id: t.id,
    createdAt: t.createdAt,
    numPlayers: t.config.numPlayers,
    models: Array.from(new Set(t.players.map((p) => p.model))),
    winner: t.result.winner,
    days: t.result.days,
    seed: t.config.seed,
  };
}

import { fileStore } from "./fileStore";

export const store: Store = fileStore;
