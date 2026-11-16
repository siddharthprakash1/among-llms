// Orchestration: turn a game request into a simulated, persisted, ranked game.
// This is the seam the API routes call.

import { randomInt, randomUUID } from "node:crypto";
import { BrainFactory, GameConfig, ToggleableRole, Transcript } from "./engine/types";
import { simulate } from "./engine/werewolf";
import { MAX_PLAYERS, MIN_PLAYERS, buildPlayers } from "./engine/roles";
import { makeRng } from "./engine/rng";
import { buildBrainFactory } from "./agents/brains";
import { listModels } from "./agents/registry";
import { applyGame } from "./elo";
import { store, GameSummary } from "./store";
import { createLive, finishLive, pushLive, pushLiveDecision } from "./live";
import { HumanBrain } from "./agents/humanBrain";
import { HUMAN_MODEL_ID } from "./human/types";
import {
  MAX_RUNNING_HUMAN_GAMES,
  closeSeat,
  makePromptPort,
  newHumanSeat,
  newSeatToken,
  runningHumanGames,
} from "./human/seat";

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
        onDecision: (rec) => pushLiveDecision(id, rec),
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

export interface CreateHumanGameInput extends CreateGameInput {
  role?: string;
}

/** Test seam. Routes never pass it. */
export interface HumanGameDeps {
  seed?: number;
  dealSeed?: number;
  botSeed?: number;
  /** Uniform index in [0, n). */
  pickIndex?: (n: number) => number;
}

/**
 * Start a live game with one human seat. Unrated: the transcript is saved but
 * the leaderboard is never touched. The names a seat must be shown reveal
 * config.seed, so the role deal and the bots' randomness come from two other
 * seeds that nothing sent to the seat depends on.
 */
export function createHumanGame(
  input: CreateHumanGameInput,
  deps: HumanGameDeps = {}
): { id: string; token: string } | { error: "busy" } {
  if (runningHumanGames() >= MAX_RUNNING_HUMAN_GAMES) return { error: "busy" };

  // Only these fields are read: a supplied seed or roleCounts is never honoured.
  const config = buildConfig({
    numPlayers: input.numPlayers,
    seatModels: input.seatModels,
    disabledRoles: input.disabledRoles,
  });
  config.seed = deps.seed ?? randomInt(0, 0xffffffff);
  config.dealSeed = deps.dealSeed ?? randomInt(0, 0xffffffff);
  const botSeed = deps.botSeed ?? randomInt(0, 0xffffffff);
  const pickIndex = deps.pickIndex ?? ((n: number) => randomInt(n));

  const dealt = buildPlayers(config, makeRng(config.seed));
  const wanted = dealt.filter((p) => p.role === input.role);
  const pool = wanted.length ? wanted : dealt;
  const seatId = pool[Math.max(0, Math.min(pool.length - 1, Math.trunc(pickIndex(pool.length))))].id;

  config.seatModels[seatId] = HUMAN_MODEL_ID;
  const players = buildPlayers(config, makeRng(config.seed));

  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const createdAt = new Date().toISOString();
  const { token, hash } = newSeatToken();
  const seat = newHumanSeat(seatId, players[seatId].role, players[seatId].alignment, hash);
  createLive(id, createdAt, config, players, seat);

  void (async () => {
    let transcript: Transcript;
    try {
      const base = buildBrainFactory(botSeed);
      const factory: BrainFactory = (m, s) =>
        s === seatId ? new HumanBrain(makePromptPort(id), base(HUMAN_MODEL_ID, s)) : base(m, s);
      transcript = await simulate(config, factory, {
        id,
        createdAt,
        onEvent: (event, index) => pushLive(id, event, index),
        // Buffered for the spectator stream, which stays sealed until game_over.
        onDecision: (rec) => pushLiveDecision(id, rec),
      });
    } catch {
      finishLive(id, "abandoned");
      closeSeat(id);
      return;
    }
    try {
      await store.saveTranscript(transcript);
    } catch (err) {
      console.error("human game finished but could not be saved", id, err);
    }
    finishLive(id, "finished");
    closeSeat(id);
  })();

  return { id, token };
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
