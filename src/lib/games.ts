// Orchestration: turn a game request into a simulated, persisted, ranked game.
// This is the seam the API routes call.

import { randomUUID } from "node:crypto";
import { GameConfig, Transcript } from "./engine/types";
import { simulate } from "./engine/werewolf";
import { MAX_PLAYERS, MIN_PLAYERS } from "./engine/roles";
import { buildBrainFactory } from "./agents/brains";
import { listModels } from "./agents/registry";
import { applyGame } from "./elo";
import { store, GameSummary } from "./store";

export interface CreateGameInput {
  numPlayers?: number;
  seatModels?: string[];
  seed?: number;
}

function clampPlayers(n: number): number {
  if (!Number.isFinite(n)) return 7;
  return Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.trunc(n)));
}

function knownModelIds(): Set<string> {
  return new Set(listModels().map((m) => m.id));
}

/**
 * Build a validated GameConfig from loose user input. Unknown model ids fall
 * back to "mock" so a bad request can never break a game.
 */
export function buildConfig(input: CreateGameInput): GameConfig {
  const numPlayers = clampPlayers(input.numPlayers ?? 7);
  const known = knownModelIds();
  const requested = input.seatModels ?? [];
  const seatModels: string[] = Array.from({ length: numPlayers }, (_, i) => {
    const m = requested[i % (requested.length || 1)] ?? "mock";
    return known.has(m) ? m : "mock";
  });
  const seed =
    input.seed !== undefined && Number.isFinite(input.seed)
      ? Math.trunc(input.seed) >>> 0
      : Math.floor(Math.random() * 0xffffffff) >>> 0;
  return { numPlayers, seatModels, seed };
}

export async function createGame(input: CreateGameInput): Promise<Transcript> {
  const config = buildConfig(input);
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const createdAt = new Date().toISOString();

  const transcript = await simulate(config, buildBrainFactory(config.seed), { id, createdAt });

  await store.saveTranscript(transcript);
  await store.updateLeaderboard((board) => applyGame(board, transcript.outcomes, transcript.id));

  return transcript;
}

export function getGame(id: string): Promise<Transcript | null> {
  return store.getTranscript(id);
}

export function recentGames(limit = 24): Promise<GameSummary[]> {
  return store.listSummaries(limit);
}

export function leaderboard() {
  return store.getLeaderboard();
}
