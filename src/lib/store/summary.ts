// Pure summary projections. They live outside index.ts so fileStore.ts has no
// runtime import of the store index (which itself imports fileStore).

import { Transcript } from "../engine/types";
import { Tournament } from "../tournaments/types";
import type { GameSummary, TournamentSummary } from "./index";

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
