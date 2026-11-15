// The Werewolf game engine: a deterministic, async state machine that drives
// a full game to completion by querying injected "brains", and records every
// step as a replayable Transcript.

import {
  AccusationRecord,
  Brain,
  BrainFactory,
  DeathCause,
  DeathRecord,
  DecisionRecord,
  DecisionSource,
  DecisionTrace,
  DefenseRecord,
  FallbackReason,
  GameConfig,
  GameEvent,
  Player,
  PlayerView,
  SeatOutcome,
  SeerResult,
  StatementRecord,
  Transcript,
  VoteRecord,
  Winner,
  WitchPotions,
  WolfChatRecord,
} from "./types";
import { buildPlayers } from "./roles";
import { buildDossier } from "./dossier";
import { makeRng, randInt, Rng } from "./rng";

interface SimulateOptions {
  id: string;
  createdAt: string;
  /** Streaming hook: called as each event is produced (powers live mode). */
  onEvent?: (event: GameEvent, index: number) => void;
  /** Streaming hook for the reasoning sidecar. Always fires before onEvent for the same step. */
  onDecision?: (record: DecisionRecord) => void;
}

/**
 * An event array that also notifies `onEvent` on every push — including pushes
 * from helper functions that receive the array — without touching any of the
 * engine's push sites. Returns a plain array when no callback is given.
 */
function createEventLog(onEvent?: (event: GameEvent, index: number) => void): GameEvent[] {
  const arr: GameEvent[] = [];
  if (!onEvent) return arr;
  return new Proxy(arr, {
    get(target, prop, receiver) {
      if (prop === "push") {
        return (...items: GameEvent[]): number => {
          for (const item of items) {
            target.push(item);
            onEvent(item, target.length - 1);
          }
          return target.length;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

interface MutableState {
  players: Player[];
  deaths: DeathRecord[];
  statements: StatementRecord[];
  votes: VoteRecord[];
  accusations: AccusationRecord[];
  defenses: DefenseRecord[];
  wolfChat: WolfChatRecord[];
  seerMemory: Map<number, SeerResult[]>; // seatId -> results
  lastProtected: Map<number, number | null>; // doctor seatId -> last target
  witchPotions: Map<number, WitchPotions>; // witch seatId -> unspent potions
  hunterFired: Set<number>; // hunters whose revenge shot has resolved
}

function alivePlayers(s: MutableState): Player[] {
  return s.players.filter((p) => p.alive);
}

function countAlive(s: MutableState, alignment: "good" | "evil" | "neutral"): number {
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
    wolfChat: self.alignment === "evil" ? s.wolfChat.slice() : [],
    potions:
      self.role === "witch"
        ? { ...(s.witchPotions.get(self.id) ?? { heal: true, poison: true }) }
        : null,
    deaths: s.deaths.slice(),
    statements: s.statements.slice(),
    votes: s.votes.slice(),
    accusations: s.accusations.slice(),
    defenses: s.defenses.slice(),
    dossier: buildDossier(s.players, s.votes, s.accusations, s.deaths),
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

// --- decision recording (reasoning inspector sidecar) --------------------

const MAX_REASONING = 600;
const SOURCES: DecisionSource[] = ["model", "fallback", "bot", "unknown"];
const FALLBACK_REASONS: FallbackReason[] = ["timeout", "http", "parse", "invalid", "error"];

const N_RANDOM = "Illegal target — the engine picked a random legal one.";
const N_RANDOM_NULL = "No target given — the engine picked a random legal one.";
const N_VOTE = "Illegal vote target — counted as an abstain.";
const N_ACCUSE = "Illegal accusation target — ignored.";
const N_EMPTY_STATEMENT = "Empty statement — replaced with “…”.";
const N_EMPTY = "Empty message — nothing was said.";
const N_BOTH = "Both potions requested — the heal wins.";
const N_HEAL_UNAVAILABLE = "Heal unavailable — the poison was used instead.";
const N_WITCH_NOTHING = "Requested potion unavailable or target illegal — nothing happened.";

type SealedTrace = Pick<DecisionRecord, "source" | "fallbackReason" | "reasoning" | "latencyMs">;

/** Copy + sanitise what a brain wrote. A brain's trace is untrusted: never spread it. */
function sealTrace(trace: DecisionTrace, legacyNote?: unknown): SealedTrace {
  try {
    // Each property is read exactly once: a getter may throw or change its answer.
    const r: unknown = trace.reasoning;
    const src: unknown = trace.source;
    const fr: unknown = trace.fallbackReason;
    const ms: unknown = trace.latencyMs;
    const raw = typeof r === "string" ? r : typeof legacyNote === "string" ? legacyNote : "";
    // Cap before the regex so a multi-megabyte string costs nothing.
    const capped = raw
      .slice(0, MAX_REASONING * 4)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      .trim()
      .slice(0, MAX_REASONING);
    // The cap counts UTF-16 units; do not leave half of an emoji at the cut.
    const reasoning = /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped;
    const source = SOURCES.includes(src as DecisionSource) ? (src as DecisionSource) : "unknown";
    const fallbackReason = FALLBACK_REASONS.includes(fr as FallbackReason)
      ? (fr as FallbackReason)
      : undefined;
    const latencyMs =
      typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined;
    return { source, fallbackReason, reasoning: reasoning || undefined, latencyMs };
  } catch {
    return { source: "unknown" }; // a throwing accessor on the trace must not abort the game
  }
}

/** Garbage (undefined, NaN, strings) from a scripted brain reads as "no target". */
const asTarget = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);

type Draft = Pick<DecisionRecord, "day" | "phase" | "playerId" | "kind" | "produced" | "ruling"> &
  Partial<Pick<DecisionRecord, "requested" | "applied" | "rulingNote">>;

function createDecisionLog(events: GameEvent[], onDecision?: (r: DecisionRecord) => void) {
  const records: DecisionRecord[] = [];
  return {
    records,
    add(d: Draft, t: SealedTrace): void {
      // Fixed key order + omitted (never undefined) keys keep JSON output stable.
      const rec: DecisionRecord = {
        seq: records.length,
        step: events.length,
        produced: d.produced,
        day: d.day,
        phase: d.phase,
        playerId: d.playerId,
        kind: d.kind,
        source: t.source,
        ...(t.fallbackReason ? { fallbackReason: t.fallbackReason } : {}),
        ...(d.requested ? { requested: d.requested } : {}),
        ...(d.applied ? { applied: d.applied } : {}),
        ruling: d.ruling,
        ...(d.rulingNote ? { rulingNote: d.rulingNote } : {}),
        ...(t.reasoning ? { reasoning: t.reasoning } : {}),
        ...(t.latencyMs !== undefined ? { latencyMs: t.latencyMs } : {}),
      };
      records.push(rec);
      try {
        onDecision?.(rec);
      } catch {
        /* inspector telemetry must never abort a game */
      }
    },
  };
}
type DecisionLog = ReturnType<typeof createDecisionLog>;

/** Ruling for a site that went through validateTarget: what was asked vs what was used. */
function targetRuling(
  requestedRaw: unknown,
  applied: number | null
): Pick<Draft, "requested" | "applied" | "ruling" | "rulingNote"> {
  const req = asTarget(requestedRaw);
  return {
    requested: { targetId: req },
    applied: { targetId: applied },
    ruling: applied === req ? "accepted" : "clamped",
    rulingNote: applied === req ? undefined : req === null ? N_RANDOM_NULL : N_RANDOM,
  };
}

// --- resolution helpers --------------------------------------------------

export function pluralityPick(prefs: number[], rng: Rng): number | null {
  if (prefs.length === 0) return null;
  const tally = new Map<number, number>();
  for (const t of prefs) tally.set(t, (tally.get(t) ?? 0) + 1);
  let max = 0;
  for (const c of tally.values()) max = Math.max(max, c);
  const top = [...tally.entries()].filter(([, c]) => c === max).map(([id]) => id);
  return top[randInt(rng, top.length)];
}

export function tallyVotes(
  votes: { targetId: number | null }[]
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

/** Win check over living wolves vs ALL other living players (jester counts as non-wolf). */
export function winnerFor(
  aliveWolves: number,
  aliveNonWolves: number
): { winner: Winner; reason: string } | null {
  if (aliveWolves === 0) return { winner: "good", reason: "Every werewolf has been eliminated." };
  if (aliveWolves >= aliveNonWolves)
    return { winner: "evil", reason: "The werewolves reached parity with the village." };
  return null;
}

function checkWin(s: MutableState): { winner: Winner; reason: string } | null {
  const wolves = countAlive(s, "evil");
  return winnerFor(wolves, alivePlayers(s).length - wolves);
}

function applyDeath(
  s: MutableState,
  events: GameEvent[],
  day: number,
  playerId: number,
  cause: DeathCause
): void {
  const victim = s.players[playerId];
  if (!victim.alive) return;
  victim.alive = false;
  s.deaths.push({ day, playerId, cause, role: victim.role });
  events.push({ kind: "death", day, playerId, cause, role: victim.role });
}

/** Any newly-dead hunter fires one revenge shot, resolved before win checks. */
async function fireHunter(
  s: MutableState,
  events: GameEvent[],
  brains: Map<number, Brain>,
  rng: Rng,
  day: number,
  phase: "night" | "day",
  log: DecisionLog
): Promise<void> {
  // Snapshot of not-yet-fired dead hunters at call time: a hunter killed by
  // another hunter's shot within this same call fires on the NEXT invocation,
  // not this one. Only reachable via custom roleCounts with 2+ hunters — the
  // default role tables cap at 1 hunter per game.
  const fallen = s.deaths.filter((d) => d.role === "hunter" && !s.hunterFired.has(d.playerId));
  for (const d of fallen) {
    s.hunterFired.add(d.playerId);
    const hunter = s.players[d.playerId];
    const legal = alivePlayers(s).map((p) => p.id);
    if (legal.length === 0) continue;
    const brain = brains.get(hunter.id)!;
    const trace: DecisionTrace = {};
    const decision = brain.hunterShot
      ? ((await brain.hunterShot(buildView(s, hunter, phase, day), trace)) ?? { targetId: null })
      : { targetId: null };
    const sealed = brain.hunterShot ? sealTrace(trace) : null; // null ⇒ write no record
    const target = validateTarget(decision.targetId, legal, rng);
    if (sealed) {
      log.add(
        {
          day,
          phase,
          playerId: hunter.id,
          kind: "hunter_shot",
          produced: target !== null,
          ...targetRuling(decision.targetId, target),
        },
        sealed
      );
    }
    if (target === null) continue;
    events.push({ kind: "hunter_shot", day, hunterId: hunter.id, targetId: target });
    applyDeath(s, events, day, target, "hunter");
  }
}

function deathSummary(deaths: DeathRecord[], day: number, players: Player[]): string {
  const last = deaths.filter((d) => d.day === day && d.cause !== "vote");
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
    accusations: [],
    defenses: [],
    wolfChat: [],
    seerMemory: new Map(),
    lastProtected: new Map(),
    witchPotions: new Map(),
    hunterFired: new Set(),
  };

  const events = createEventLog(opts.onEvent);
  // A local, never a field of MutableState: buildView reads only MutableState,
  // so recorded reasoning has no path into any PlayerView or prompt.
  const log = createDecisionLog(events, opts.onDecision);
  events.push({ kind: "game_start", day: 0 });
  const maxDays = config.maxDays ?? config.numPlayers + 3;

  let day = 0;
  let outcome: { winner: Winner; reason: string } | null = null;

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

    const wolves = alivePlayers(state).filter((p) => p.role === "werewolf");

    // Wolf pack chat: two short rounds, only when the pack can actually talk.
    if (wolves.length >= 2) {
      for (let round = 1; round <= 2; round++) {
        for (const w of wolves) {
          if (!w.alive) continue;
          const brain = brains.get(w.id)!;
          if (!brain.wolfChat) continue;
          const trace: DecisionTrace = {};
          const raw = await brain.wolfChat(buildView(state, w, "night", day), round, trace);
          const sealed = sealTrace(trace);
          const text = (raw ?? "").trim().slice(0, 240);
          const base = { day, phase: "night" as const, playerId: w.id, kind: "wolf_chat" as const };
          if (!text) {
            log.add({ ...base, produced: false, ruling: "dropped", rulingNote: N_EMPTY }, sealed);
            continue;
          }
          log.add({ ...base, produced: true, ruling: "accepted" }, sealed);
          state.wolfChat.push({ day, wolfId: w.id, text });
          events.push({ kind: "wolf_chat", day, wolfId: w.id, text });
        }
      }
    }

    // Wolves pick a victim (plurality of their preferences).
    let killTarget: number | null = null;
    if (wolves.length > 0) {
      const prefs: number[] = [];
      // Each wolf's own preference is recorded, but only once the pack result is
      // known (it decides `produced`), so the records are buffered here.
      const pending: { wolfId: number; ruling: ReturnType<typeof targetRuling>; sealed: SealedTrace }[] = [];
      for (const w of wolves) {
        const legal = nightTargets(state, w);
        const trace: DecisionTrace = {};
        const decision = await brains.get(w.id)!.nightAction(buildView(state, w, "night", day), trace);
        const sealed = sealTrace(trace, decision.note);
        const t = validateTarget(decision.targetId, legal, rng);
        pending.push({ wolfId: w.id, ruling: targetRuling(decision.targetId, t), sealed });
        if (t !== null) prefs.push(t);
      }
      killTarget = pluralityPick(prefs, rng);
      for (const p of pending) {
        log.add(
          {
            day,
            phase: "night",
            playerId: p.wolfId,
            kind: "wolf_kill",
            produced: killTarget !== null,
            ...p.ruling,
          },
          p.sealed
        );
      }
      if (killTarget !== null) {
        events.push({ kind: "wolf_kill", day, actorIds: wolves.map((w) => w.id), targetId: killTarget });
      }
    }

    // Seer(s) inspect.
    for (const seer of alivePlayers(state).filter((p) => p.role === "seer")) {
      const legal = nightTargets(state, seer);
      const trace: DecisionTrace = {};
      const decision = await brains.get(seer.id)!.nightAction(buildView(state, seer, "night", day), trace);
      const sealed = sealTrace(trace, decision.note);
      const t = validateTarget(decision.targetId, legal, rng);
      log.add(
        {
          day,
          phase: "night",
          playerId: seer.id,
          kind: "seer_check",
          produced: t !== null,
          ...targetRuling(decision.targetId, t),
        },
        sealed
      );
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
      const trace: DecisionTrace = {};
      const decision = await brains.get(doc.id)!.nightAction(buildView(state, doc, "night", day), trace);
      const sealed = sealTrace(trace, decision.note);
      const t = validateTarget(decision.targetId, legal, rng);
      log.add(
        {
          day,
          phase: "night",
          playerId: doc.id,
          kind: "doctor_save",
          produced: t !== null,
          ...targetRuling(decision.targetId, t),
        },
        sealed
      );
      if (t !== null) {
        protectedIds.add(t);
        state.lastProtected.set(doc.id, t);
        events.push({ kind: "doctor_save", day, doctorId: doc.id, targetId: t });
      }
    }

    // Witch: sees the wolves' target; one potion per night, each single-use.
    // If a brain illegally requests both potions, the heal wins (spec §3.2).
    const healedIds = new Set<number>();
    let poisonTarget: number | null = null;
    for (const witch of alivePlayers(state).filter((p) => p.role === "witch")) {
      if (!state.witchPotions.has(witch.id))
        state.witchPotions.set(witch.id, { heal: true, poison: true });
      const potions = state.witchPotions.get(witch.id)!;
      const brain = brains.get(witch.id)!;
      if (!brain.witchAction) continue;
      const trace: DecisionTrace = {};
      // The nullish default stays: a witchAction that resolves to undefined is a pass, not a crash.
      const decision =
        (await brain.witchAction(buildView(state, witch, "night", day), killTarget, trace)) ??
        { heal: false, poisonTargetId: null };
      const sealed = sealTrace(trace);
      const reqPoison = asTarget(decision.poisonTargetId);
      const base = {
        day,
        phase: "night" as const,
        playerId: witch.id,
        kind: "witch_action" as const,
        requested: { targetId: reqPoison, heal: decision.heal === true },
      };
      const legalPoison = alivePlayers(state)
        .filter((p) => p.id !== witch.id)
        .map((p) => p.id);

      if (decision.heal && potions.heal && killTarget !== null) {
        log.add(
          {
            ...base,
            produced: true,
            applied: { targetId: null, heal: true },
            ruling: reqPoison !== null ? "clamped" : "accepted",
            rulingNote: reqPoison !== null ? N_BOTH : undefined,
          },
          sealed
        );
        potions.heal = false;
        healedIds.add(killTarget);
        events.push({ kind: "witch_action", day, witchId: witch.id, action: "heal", targetId: killTarget });
      } else if (
        decision.poisonTargetId !== null &&
        potions.poison &&
        legalPoison.includes(decision.poisonTargetId)
      ) {
        log.add(
          {
            ...base,
            produced: true,
            applied: { targetId: decision.poisonTargetId, heal: false },
            ruling: decision.heal ? "clamped" : "accepted",
            rulingNote: decision.heal ? N_HEAL_UNAVAILABLE : undefined,
          },
          sealed
        );
        potions.poison = false;
        poisonTarget = decision.poisonTargetId;
        events.push({
          kind: "witch_action",
          day,
          witchId: witch.id,
          action: "poison",
          targetId: poisonTarget,
        });
      } else {
        const asked = decision.heal === true || reqPoison !== null;
        log.add(
          {
            ...base,
            produced: false,
            applied: { targetId: null, heal: false },
            ruling: asked ? "dropped" : "accepted",
            rulingNote: asked ? N_WITCH_NOTHING : undefined,
          },
          sealed
        );
      }
    }

    // Resolve the night: wolf kill (blockable), then poison (unblockable).
    if (killTarget !== null) {
      if (protectedIds.has(killTarget)) {
        events.push({ kind: "saved", day, targetId: killTarget, by: "doctor" });
      } else if (healedIds.has(killTarget)) {
        events.push({ kind: "saved", day, targetId: killTarget, by: "witch" });
      } else {
        applyDeath(state, events, day, killTarget, "wolves");
      }
    }
    if (poisonTarget !== null) applyDeath(state, events, day, poisonTarget, "poison");
    await fireHunter(state, events, brains, rng, day, "night", log);

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

    // Statements: each living player speaks once; order rotates by day so no
    // seat always anchors the discussion.
    const aliveIds = alivePlayers(state).map((p) => p.id);
    const offset = (day - 1) % aliveIds.length;
    const speakers = [...aliveIds.slice(offset), ...aliveIds.slice(0, offset)];
    for (const sid of speakers) {
      const speaker = state.players[sid];
      if (!speaker.alive) continue;
      const trace: DecisionTrace = {};
      const text = await brains.get(sid)!.dayStatement(buildView(state, speaker, "day", day), trace);
      const sealed = sealTrace(trace);
      const trimmed = (text ?? "").trim();
      const clean = trimmed || "…";
      log.add(
        {
          day,
          phase: "day",
          playerId: sid,
          kind: "statement",
          produced: true,
          ruling: trimmed ? "accepted" : "clamped",
          rulingNote: trimmed ? undefined : N_EMPTY_STATEMENT,
        },
        sealed
      );
      state.statements.push({ day, playerId: sid, text: clean });
      events.push({ kind: "statement", day, playerId: sid, text: clean });
    }

    // Accusations: each living player may formally accuse one player.
    const todaysAccusations: AccusationRecord[] = [];
    for (const sid of speakers) {
      const accuser = state.players[sid];
      if (!accuser.alive) continue;
      const brain = brains.get(sid)!;
      const trace: DecisionTrace = {};
      const decision = brain.accuse
        ? ((await brain.accuse(buildView(state, accuser, "day", day), trace)) ?? { targetId: null })
        : { targetId: null };
      const sealed = brain.accuse ? sealTrace(trace) : null; // null ⇒ write no record
      const req = asTarget(decision.targetId);
      const base = { day, phase: "day" as const, playerId: sid, kind: "accusation" as const };
      if (decision.targetId === null) {
        if (sealed) {
          log.add(
            {
              ...base,
              produced: false,
              requested: { targetId: null },
              applied: { targetId: null },
              ruling: "accepted",
            },
            sealed
          );
        }
        continue;
      }
      const legal = alivePlayers(state)
        .filter((p) => p.id !== sid)
        .map((p) => p.id);
      if (!legal.includes(decision.targetId)) {
        if (sealed) {
          log.add(
            {
              ...base,
              produced: false,
              requested: { targetId: req },
              applied: { targetId: null },
              ruling: "dropped",
              rulingNote: N_ACCUSE,
            },
            sealed
          );
        }
        continue;
      }
      const text =
        (decision.text ?? "").trim().slice(0, 240) ||
        `I accuse ${state.players[decision.targetId].name}.`;
      if (sealed) {
        log.add(
          {
            ...base,
            produced: true,
            requested: { targetId: req },
            applied: { targetId: req },
            ruling: "accepted",
          },
          sealed
        );
      }
      const rec: AccusationRecord = { day, from: sid, target: decision.targetId, text };
      todaysAccusations.push(rec);
      state.accusations.push(rec);
      events.push({ kind: "accusation", day, from: sid, target: decision.targetId, text });
    }

    // Defenses: each accused player responds once, in seat order.
    const accusedIds = [...new Set(todaysAccusations.map((a) => a.target))].sort((a, b) => a - b);
    for (const aid of accusedIds) {
      const accused = state.players[aid];
      if (!accused.alive) continue;
      const against = todaysAccusations.filter((a) => a.target === aid);
      const brain = brains.get(aid)!;
      if (!brain.defend) continue;
      const trace: DecisionTrace = {};
      const raw = await brain.defend(buildView(state, accused, "day", day), against, trace);
      const sealed = sealTrace(trace);
      const text = (raw ?? "").trim().slice(0, 280);
      const base = { day, phase: "day" as const, playerId: aid, kind: "defense" as const };
      if (!text) {
        log.add({ ...base, produced: false, ruling: "dropped", rulingNote: N_EMPTY }, sealed);
        continue;
      }
      log.add({ ...base, produced: true, ruling: "accepted" }, sealed);
      state.defenses.push({ day, playerId: aid, text });
      events.push({ kind: "defense", day, playerId: aid, text });
    }

    // Voting: everyone alive votes (in seat order), then we tally.
    const dayVotes: VoteRecord[] = [];
    for (const voter of alivePlayers(state)) {
      const legalVote = alivePlayers(state)
        .filter((p) => p.id !== voter.id)
        .map((p) => p.id);
      const trace: DecisionTrace = {};
      const decision = await brains.get(voter.id)!.dayVote(buildView(state, voter, "day", day), trace);
      const sealed = sealTrace(trace, decision.note);
      const target =
        decision.targetId !== null && legalVote.includes(decision.targetId)
          ? decision.targetId
          : null;
      const req = asTarget(decision.targetId);
      const overruled = req !== null && target === null;
      log.add(
        {
          day,
          phase: "day",
          playerId: voter.id,
          kind: "vote",
          produced: true,
          requested: { targetId: req },
          applied: { targetId: target },
          ruling: overruled ? "clamped" : "accepted",
          rulingNote: overruled ? N_VOTE : undefined,
        },
        sealed
      );
      const record: VoteRecord = { day, voterId: voter.id, targetId: target };
      dayVotes.push(record);
      state.votes.push(record);
      events.push({ kind: "vote", day, voterId: voter.id, targetId: target });
    }

    const { tally, eliminatedId, tie } = tallyVotes(dayVotes);
    events.push({ kind: "vote_result", day, tally, eliminatedId, tie });
    if (eliminatedId !== null) {
      const victim = state.players[eliminatedId];
      applyDeath(state, events, day, eliminatedId, "vote");
      if (victim.role === "jester") {
        outcome = {
          winner: "jester",
          reason: `${victim.name} baited the village into the vote. The Jester wins alone.`,
        };
        break;
      }
      await fireHunter(state, events, brains, rng, day, "day", log);
    }

    outcome = checkWin(state);
    if (outcome) break;
  }

  // Day-limit fallback: decide by who holds the numbers.
  if (!outcome) {
    const wolvesLeft = countAlive(state, "evil");
    const others = alivePlayers(state).length - wolvesLeft;
    outcome =
      others > wolvesLeft
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
    won: outcome!.winner === "jester" ? p.role === "jester" : p.alignment === outcome!.winner,
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
    decisions: log.records,
  };
}
