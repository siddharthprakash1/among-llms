// Tournament orchestrator: create a tournament and run its games in the
// background (concurrency-capped), attributing wins, advancing the bracket, and
// persisting progress to disk after every batch so any route/page sees it live.

import { randomUUID } from "node:crypto";
import { GameConfig, ToggleableRole } from "../engine/types";
import { simulate } from "../engine/werewolf";
import { buildBrainFactory } from "../agents/brains";
import { MAX_PLAYERS, MIN_PLAYERS } from "../engine/roles";
import { applyGame } from "../elo";
import { store } from "../store";
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
    new Set((input.roster ?? ["mock", "hunter-bot", "sentinel-bot"]).filter(Boolean))
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
  void runTournament(id).catch(() => {});
  return { id };
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
