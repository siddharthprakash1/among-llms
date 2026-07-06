// Orchestration: turn a game request into a simulated, persisted, ranked game.
// This is the seam the API routes call.

import { randomUUID } from "node:crypto";
import { GameConfig, ToggleableRole, Transcript } from "./engine/types";
import { simulate } from "./engine/werewolf";
import { MAX_PLAYERS, MIN_PLAYERS, buildPlayers } from "./engine/roles";
import { makeRng } from "./engine/rng";
import { buildBrainFactory } from "./agents/brains";
import { listModels } from "./agents/registry";
import { applyGame } from "./elo";
import { store, GameSummary } from "./store";
import { createLive, finishLive, pushLive } from "./live";

export interface CreateGameInput {
  numPlayers?: number;
  seatModels?: string[];
  seed?: number;
  disabledRoles?: string[];
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
  const TOGGLEABLE: ToggleableRole[] = ["hunter", "witch", "jester"];
  const disabledRoles = (input.disabledRoles ?? []).filter((r): r is ToggleableRole =>
    (TOGGLEABLE as string[]).includes(r)
  );
  return { numPlayers, seatModels, seed, ...(disabledRoles.length ? { disabledRoles } : {}) };
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

/**
 * Kick off a live game: register it in-process, return the id immediately, and
 * simulate in the background — streaming events to SSE subscribers, then
 * persisting the finished transcript and updating the leaderboard. If the
 * process dies mid-game the game is simply never persisted (abandoned).
 */
export function createLiveGame(input: CreateGameInput): { id: string } {
  const config = buildConfig(input);
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const createdAt = new Date().toISOString();
  const players = buildPlayers(config, makeRng(config.seed));
  createLive(id, createdAt, config, players);

  void (async () => {
    try {
      const transcript = await simulate(config, buildBrainFactory(config.seed), {
        id,
        createdAt,
        onEvent: (event, index) => pushLive(id, event, index),
      });
      await store.saveTranscript(transcript);
      await store.updateLeaderboard((board) => applyGame(board, transcript.outcomes, transcript.id));
      finishLive(id, "finished");
    } catch {
      finishLive(id, "abandoned");
    }
  })();

  return { id };
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
