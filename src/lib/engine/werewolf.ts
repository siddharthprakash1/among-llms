// The Werewolf game engine: a deterministic, async state machine that drives
// a full game to completion by querying injected "brains", and records every
// step as a replayable Transcript.

import {
  Alignment,
  Brain,
  BrainFactory,
  DeathRecord,
  GameConfig,
  GameEvent,
  Player,
  PlayerView,
  SeatOutcome,
  SeerResult,
  StatementRecord,
  Transcript,
  VoteRecord,
} from "./types";
import { buildPlayers } from "./roles";
import { makeRng, randInt, Rng, shuffle } from "./rng";

interface SimulateOptions {
  id: string;
  createdAt: string;
}

interface MutableState {
  players: Player[];
  deaths: DeathRecord[];
  statements: StatementRecord[];
  votes: VoteRecord[];
  seerMemory: Map<number, SeerResult[]>; // seatId -> results
  lastProtected: Map<number, number | null>; // doctor seatId -> last target
}

function alivePlayers(s: MutableState): Player[] {
  return s.players.filter((p) => p.alive);
}

function countAlive(s: MutableState, alignment: Alignment): number {
  return s.players.filter((p) => p.alive && p.alignment === alignment).length;
}

function publicPlayers(s: MutableState) {
  return s.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, alive: p.alive }));
}

function buildView(
  s: MutableState,
  self: Player,
  phase: "night" | "day",
  day: number
): PlayerView {
  const wolfIds = s.players.filter((p) => p.role === "werewolf").map((p) => p.id);
  return {
    self: {
      id: self.id,
      name: self.name,
      role: self.role,
      alignment: self.alignment,
      model: self.model,
    },
    day,
    phase,
    players: publicPlayers(s),
    aliveIds: alivePlayers(s).map((p) => p.id),
    knownWolves: self.alignment === "evil" ? wolfIds : [],
    seerResults: self.role === "seer" ? s.seerMemory.get(self.id) ?? [] : [],
    lastProtectedId: self.role === "doctor" ? s.lastProtected.get(self.id) ?? null : null,
    deaths: s.deaths.slice(),
    statements: s.statements.slice(),
    votes: s.votes.slice(),
  };
}

// --- target validation --------------------------------------------------

function nightTargets(s: MutableState, self: Player): number[] {
  const alive = alivePlayers(s);
  if (self.role === "werewolf") {
    return alive.filter((p) => p.role !== "werewolf").map((p) => p.id);
  }
  if (self.role === "seer") {
    return alive.filter((p) => p.id !== self.id).map((p) => p.id);
  }
  // doctor may protect anyone alive, including self
  return alive.map((p) => p.id);
}

function validateTarget(candidate: number | null, legal: number[], rng: Rng): number | null {
  if (candidate !== null && legal.includes(candidate)) return candidate;
  if (legal.length === 0) return null;
  return legal[randInt(rng, legal.length)];
}

// --- resolution helpers --------------------------------------------------

export function pluralityPick(prefs: number[], rng: Rng): number | null {
  if (prefs.length === 0) return null;
  const tally = new Map<number, number>();
  for (const t of prefs) tally.set(t, (tally.get(t) ?? 0) + 1);
  let max = 0;
  for (const c of tally.values()) max = Math.max(max, c);
  const top = [...tally.entries()].filter(([, c]) => c === max).map(([id]) => id);
  return shuffle(rng, top)[0];
}

export function tallyVotes(
  votes: { targetId: number | null }[],
  rng: Rng
): { tally: Record<number, number>; eliminatedId: number | null; tie: boolean } {
  const tally: Record<number, number> = {};
  for (const v of votes) {
    if (v.targetId === null) continue;
    tally[v.targetId] = (tally[v.targetId] ?? 0) + 1;
  }
  const entries = Object.entries(tally).map(([id, c]) => [Number(id), c] as const);
  if (entries.length === 0) return { tally, eliminatedId: null, tie: false };
  const max = Math.max(...entries.map(([, c]) => c));
  const top = entries.filter(([, c]) => c === max).map(([id]) => id);
  if (top.length > 1) return { tally, eliminatedId: null, tie: true };
  return { tally, eliminatedId: top[0], tie: false };
}

export function winnerFor(
  aliveWolves: number,
  aliveGood: number
): { winner: Alignment; reason: string } | null {
  if (aliveWolves === 0) return { winner: "good", reason: "Every werewolf has been eliminated." };
  if (aliveWolves >= aliveGood)
    return { winner: "evil", reason: "The werewolves reached parity with the village." };
  return null;
}

function checkWin(s: MutableState): { winner: Alignment; reason: string } | null {
  return winnerFor(countAlive(s, "evil"), countAlive(s, "good"));
}

function deathSummary(deaths: DeathRecord[], day: number, players: Player[]): string {
  const last = deaths.filter((d) => d.day === day && d.cause === "wolves");
  if (last.length === 0) return "Dawn breaks — everyone survived the night.";
  const names = last.map((d) => players[d.playerId].name).join(", ");
  return `Dawn breaks — ${names} did not survive the night.`;
}

// --- main loop -----------------------------------------------------------

export async function simulate(
  config: GameConfig,
  brainFactory: BrainFactory,
  opts: SimulateOptions
): Promise<Transcript> {
  const rng = makeRng(config.seed);
  const players = buildPlayers(config, rng);
  const brains = new Map<number, Brain>();
  for (const p of players) brains.set(p.id, brainFactory(p.model, p.id));

  const state: MutableState = {
    players,
    deaths: [],
    statements: [],
    votes: [],
    seerMemory: new Map(),
    lastProtected: new Map(),
  };

  const events: GameEvent[] = [{ kind: "game_start", day: 0 }];
  const maxDays = config.maxDays ?? config.numPlayers + 3;

  let day = 0;
  let outcome: { winner: Alignment; reason: string } | null = null;

  while (day < maxDays) {
    day++;

    // -------------------- NIGHT --------------------
    events.push({
      kind: "phase",
      phase: "night",
      day,
      label: `Night ${day}`,
      sublabel: "The village sleeps. Somewhere, the wolves are hunting…",
    });

    // Wolves pick a victim (plurality of their preferences).
    const wolves = alivePlayers(state).filter((p) => p.role === "werewolf");
    let killTarget: number | null = null;
    if (wolves.length > 0) {
      const prefs: number[] = [];
      for (const w of wolves) {
        const legal = nightTargets(state, w);
        const decision = await brains.get(w.id)!.nightAction(buildView(state, w, "night", day));
        const t = validateTarget(decision.targetId, legal, rng);
        if (t !== null) prefs.push(t);
      }
      killTarget = pluralityPick(prefs, rng);
      if (killTarget !== null) {
        events.push({ kind: "wolf_kill", day, actorIds: wolves.map((w) => w.id), targetId: killTarget });
      }
    }

    // Seer(s) inspect.
    for (const seer of alivePlayers(state).filter((p) => p.role === "seer")) {
      const legal = nightTargets(state, seer);
      const decision = await brains.get(seer.id)!.nightAction(buildView(state, seer, "night", day));
      const t = validateTarget(decision.targetId, legal, rng);
      if (t !== null) {
        const result = state.players[t].alignment;
        const mem = state.seerMemory.get(seer.id) ?? [];
        mem.push({ day, targetId: t, alignment: result });
        state.seerMemory.set(seer.id, mem);
        events.push({ kind: "seer_check", day, seerId: seer.id, targetId: t, result });
      }
    }

    // Doctor(s) protect.
    const protectedIds = new Set<number>();
    for (const doc of alivePlayers(state).filter((p) => p.role === "doctor")) {
      const legal = nightTargets(state, doc);
      const decision = await brains.get(doc.id)!.nightAction(buildView(state, doc, "night", day));
      const t = validateTarget(decision.targetId, legal, rng);
      if (t !== null) {
        protectedIds.add(t);
        state.lastProtected.set(doc.id, t);
        events.push({ kind: "doctor_save", day, doctorId: doc.id, targetId: t });
      }
    }

    // Resolve the night kill.
    if (killTarget !== null) {
      if (protectedIds.has(killTarget)) {
        events.push({ kind: "saved", day, targetId: killTarget });
      } else {
        const victim = state.players[killTarget];
        victim.alive = false;
        state.deaths.push({ day, playerId: victim.id, cause: "wolves", role: victim.role });
        events.push({ kind: "death", day, playerId: victim.id, cause: "wolves", role: victim.role });
      }
    }

    outcome = checkWin(state);
    if (outcome) break;

    // -------------------- DAY --------------------
    events.push({
      kind: "phase",
      phase: "day",
      day,
      label: `Day ${day}`,
      sublabel: deathSummary(state.deaths, day, state.players),
    });

    // Discussion: each living player speaks once, in a seed-shuffled order.
    const speakers = shuffle(rng, alivePlayers(state).map((p) => p.id));
    for (const sid of speakers) {
      const speaker = state.players[sid];
      if (!speaker.alive) continue;
      const text = await brains.get(sid)!.dayStatement(buildView(state, speaker, "day", day));
      const clean = (text ?? "").trim() || "…";
      state.statements.push({ day, playerId: sid, text: clean });
      events.push({ kind: "statement", day, playerId: sid, text: clean });
    }

    // Voting: everyone alive votes (in seat order), then we tally.
    const dayVotes: VoteRecord[] = [];
    for (const voter of alivePlayers(state)) {
      const legalVote = alivePlayers(state)
        .filter((p) => p.id !== voter.id)
        .map((p) => p.id);
      const decision = await brains.get(voter.id)!.dayVote(buildView(state, voter, "day", day));
      const target =
        decision.targetId !== null && legalVote.includes(decision.targetId)
          ? decision.targetId
          : null;
      const record: VoteRecord = { day, voterId: voter.id, targetId: target };
      dayVotes.push(record);
      state.votes.push(record);
      events.push({ kind: "vote", day, voterId: voter.id, targetId: target });
    }

    const { tally, eliminatedId, tie } = tallyVotes(dayVotes, rng);
    events.push({ kind: "vote_result", day, tally, eliminatedId, tie });
    if (eliminatedId !== null) {
      const victim = state.players[eliminatedId];
      victim.alive = false;
      state.deaths.push({ day, playerId: victim.id, cause: "vote", role: victim.role });
      events.push({ kind: "death", day, playerId: victim.id, cause: "vote", role: victim.role });
    }

    outcome = checkWin(state);
    if (outcome) break;
  }

  // Day-limit fallback: decide by who holds the numbers.
  if (!outcome) {
    const wolves = countAlive(state, "evil");
    const good = countAlive(state, "good");
    outcome =
      good > wolves
        ? { winner: "good", reason: "Day limit reached — the village held the majority." }
        : { winner: "evil", reason: "Day limit reached — the wolves were never rooted out." };
  }

  const survivorIds = alivePlayers(state).map((p) => p.id);
  events.push({
    kind: "game_over",
    winner: outcome.winner,
    reason: outcome.reason,
    survivorIds,
  });

  const outcomes: SeatOutcome[] = state.players.map((p) => ({
    seatId: p.id,
    model: p.model,
    role: p.role,
    alignment: p.alignment,
    won: p.alignment === outcome!.winner,
    survived: p.alive,
  }));

  return {
    id: opts.id,
    createdAt: opts.createdAt,
    config,
    players: state.players,
    events,
    result: { winner: outcome.winner, reason: outcome.reason, survivorIds, days: day },
    outcomes,
  };
}
