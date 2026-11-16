// Tournament orchestrator: create a tournament and run its games in the
// background (concurrency-capped), attributing wins, advancing the bracket, and
// persisting progress to disk after every batch so any route/page sees it live.

import { randomUUID } from "node:crypto";
import { GameConfig, ToggleableRole } from "../engine/types";
import { simulate } from "../engine/werewolf";
import { buildBrainFactory } from "../agents/brains";
import { MAX_PLAYERS, MIN_PLAYERS } from "../engine/roles";
import { applyGame } from "../elo";
import { store, Store } from "../store";
import { HUMAN_MODEL_ID } from "../human/types";
import { KnockoutMatch, Tournament, TournamentConfig, TournamentGameRef } from "./types";
import {
  advanceBracket,
  attributeWins,
  buildKnockout,
  buildRoundRobin,
  isComplete,
  knockoutSeats,
  mixSeed,
  nextPending,
} from "./schedule";

// Ids of tournaments this process is running. On globalThis for the same reason
// as the live registry: each route bundle gets its own copy of this module.
const tg = globalThis as unknown as { __amongLlmsTournaments?: Set<string> };
const active: Set<string> = (tg.__amongLlmsTournaments ??= new Set());

export function runningTournaments(): number {
  return active.size;
}

/** Boot-time: tournaments left "running" by a dead process can never progress. */
export async function abandonOrphanedTournaments(s: Store = store): Promise<string[]> {
  const changed: string[] = [];
  for (const summary of await s.listTournaments(200)) {
    if (summary.status !== "running" || active.has(summary.id)) continue;
    const t = await s.getTournament(summary.id);
    if (!t || t.status !== "running") continue;
    t.status = "abandoned";
    await s.saveTournament(t);
    changed.push(t.id);
  }
  return changed;
}

const TOGGLEABLE: ToggleableRole[] = ["hunter", "witch", "jester"];

export interface CreateTournamentInput {
  name?: string;
  format?: string;
  roster?: string[];
  gamesPerRound?: number;
  numPlayers?: number;
  concurrency?: number;
  seed?: number;
  disabledRoles?: string[];
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(n)));

function buildTournamentConfig(input: CreateTournamentInput): TournamentConfig {
  const roster = Array.from(
    new Set((input.roster ?? ["mock", "hunter-bot", "sentinel-bot"]).filter(
      (m) => Boolean(m) && m !== HUMAN_MODEL_ID
    ))
  ).slice(0, 12);
  while (roster.length < 2) roster.push(roster.length === 0 ? "mock" : "hunter-bot");
  const format = input.format === "knockout" ? "knockout" : "round_robin";
  const numPlayers = clamp(input.numPlayers ?? 7, MIN_PLAYERS, MAX_PLAYERS);
  const gamesPerRound = clamp(input.gamesPerRound ?? (format === "knockout" ? 1 : 4), 1, 7);
  const concurrency = clamp(input.concurrency ?? 1, 1, 8);
  const seed =
    input.seed !== undefined && Number.isFinite(input.seed)
      ? Math.trunc(input.seed) >>> 0
      : Math.floor(Math.random() * 0xffffffff) >>> 0;
  const disabledRoles = (input.disabledRoles ?? []).filter((r): r is ToggleableRole =>
    (TOGGLEABLE as string[]).includes(r)
  );
  return {
    name: input.name?.trim() || "Untitled tournament",
    format,
    roster,
    gamesPerRound,
    numPlayers,
    concurrency,
    seed,
    ...(disabledRoles.length ? { disabledRoles } : {}),
  };
}

/** Fill in games for any bracket match whose players are known but has none yet. */
function materializeBracketGames(bracket: KnockoutMatch[][], config: TournamentConfig): KnockoutMatch[][] {
  return bracket.map((round, r) =>
    round.map((m, i) => {
      if (m.a && m.b && m.games.length === 0) {
        const games: TournamentGameRef[] = Array.from({ length: config.gamesPerRound }, (_, n) => ({
          key: `${m.key}g${n}`,
          seed: mixSeed(config.seed, r * 100 + i, n),
          seatModels: knockoutSeats(m.a as string, m.b as string, config.numPlayers, n),
          status: "pending" as const,
        }));
        return { ...m, games };
      }
      return m;
    })
  );
}

export async function createTournament(input: CreateTournamentInput): Promise<{ id: string }> {
  const config = buildTournamentConfig(input);
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  // Reserved before the first await: two concurrent POSTs cannot both pass the
  // tournament cap, and the boot reconcile never sees this id as orphaned.
  active.add(id);
  try {
    const createdAt = new Date().toISOString();

    const board = await store.getLeaderboard();
    const eloOf = (m: string) => board[m]?.elo ?? 1000;

    const tournament: Tournament =
      config.format === "round_robin"
        ? { id, createdAt, status: "running", config, rounds: buildRoundRobin(config) }
        : {
            id,
            createdAt,
            status: "running",
            config,
            bracket: materializeBracketGames(buildKnockout(config, eloOf), config),
          };

    await store.saveTournament(tournament);
  } catch (err) {
    active.delete(id);
    throw err;
  }
  void runTournament(id)
    // Nothing drives it after a throw, so "running" would be a lie the UI polls forever.
    .catch(() => markAbandoned(id))
    .finally(() => active.delete(id));
  return { id };
}

/** Best-effort: the store may be what failed. */
async function markAbandoned(id: string): Promise<void> {
  try {
    const t = await store.getTournament(id);
    if (!t || t.status !== "running") return;
    t.status = "abandoned";
    await store.saveTournament(t);
  } catch {
    /* the boot reconcile picks it up */
  }
}

async function runGame(config: TournamentConfig, ref: TournamentGameRef, roster: string[]): Promise<void> {
  ref.status = "running";
  const gameConfig: GameConfig = {
    numPlayers: config.numPlayers,
    seatModels: ref.seatModels,
    seed: ref.seed,
    ...(config.disabledRoles ? { disabledRoles: config.disabledRoles } : {}),
  };
  const gameId = randomUUID().replace(/-/g, "").slice(0, 12);
  const createdAt = new Date().toISOString();
  const transcript = await simulate(gameConfig, buildBrainFactory(gameConfig.seed), {
    id: gameId,
    createdAt,
  });
  await store.saveTranscript(transcript);
  await store.updateLeaderboard((b) => applyGame(b, transcript.outcomes, transcript.id));
  ref.status = "finished";
  ref.gameId = gameId;
  ref.winner = transcript.result.winner;
  ref.modelWins = attributeWins(transcript.outcomes, roster);
}

async function runTournament(id: string): Promise<void> {
  for (let guard = 0; guard < 10000; guard++) {
    const t = await store.getTournament(id);
    if (!t || t.status !== "running") return;

    if (isComplete(t)) {
      t.status = "finished";
      await store.saveTournament(t);
      return;
    }

    const batch = nextPending(t, t.config.concurrency);
    if (batch.length === 0) {
      // Knockout waiting on advancement — advance, materialize next games, retry.
      if (t.config.format === "knockout") {
        t.bracket = materializeBracketGames(advanceBracket(t.bracket ?? []), t.config);
        await store.saveTournament(t);
        if (nextPending(t, 1).length === 0) {
          t.status = isComplete(t) ? "finished" : "abandoned";
          await store.saveTournament(t);
          return;
        }
        continue;
      }
      t.status = "finished";
      await store.saveTournament(t);
      return;
    }

    await Promise.all(batch.map((ref) => runGame(t.config, ref, t.config.roster)));

    if (t.config.format === "knockout") {
      t.bracket = materializeBracketGames(advanceBracket(t.bracket ?? []), t.config);
    }
    await store.saveTournament(t);
  }
}
