// In-process registry for live games. A game being simulated streams its events
// here as they are produced; SSE clients replay the buffer then tail new events.
// Local-first: this lives in the Node server process (dev / next start). If the
// process dies mid-game the game is abandoned (never persisted, never rated).

import { Alignment, DecisionRecord, GameConfig, GameEvent, Player, Role } from "./engine/types";
import type { SeatAnswer, SeatEvent, SeatPrompt } from "./human/types";
import { projectEvent } from "./human/project";

export type LiveStatus = "running" | "finished" | "abandoned";

export interface PendingPrompt {
  prompt: SeatPrompt;
  deadlineAt: number | null; // epoch ms; null until armed
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (answer: SeatAnswer | null) => void;
}

/** The one human seat of a game. Plain data, so it survives Next's module-instance split. */
export interface HumanSeat {
  seatId: number;
  role: Role;
  alignment: Alignment;
  tokenHash: string; // sha256 hex of the seat token
  events: SeatEvent[]; // dense projected buffer (index === SSE id)
  eventListeners: Set<(ev: SeatEvent, seq: number) => void>;
  dead: boolean;
  ghost: boolean;
  pending: PendingPrompt | null;
  promptSeq: number;
  missed: number; // consecutive timeouts
  autopilot: boolean;
  lastResolved: { id: string; outcome: "submitted" | "timeout" } | null;
  stateListeners: Set<() => void>; // fired on any pending/autopilot change
}

export interface LiveGame {
  id: string;
  createdAt: string;
  config: GameConfig;
  players: Player[];
  events: GameEvent[]; // replay buffer (index === event id)
  /** Reasoning sidecar; no listeners, since each record is flushed with the event it precedes. */
  decisions: DecisionRecord[];
  status: LiveStatus;
  listeners: Set<(event: GameEvent, index: number) => void>;
  human?: HumanSeat;
}

// Next.js gives route handlers and RSC pages separate module instances, so a
// plain module-level Map wouldn't be shared. Pin the registry to globalThis so
// it's a true per-process singleton visible from every route, page, and the
// background simulation (and it survives dev HMR).
const globalStore = globalThis as unknown as { __amongLlmsLive?: Map<string, LiveGame> };
const registry: Map<string, LiveGame> = globalStore.__amongLlmsLive ?? new Map();
globalStore.__amongLlmsLive = registry;
const MAX_KEPT = 60;

export function createLive(
  id: string,
  createdAt: string,
  config: GameConfig,
  players: Player[],
  human?: HumanSeat
): LiveGame {
  const game: LiveGame = {
    id,
    createdAt,
    config,
    players,
    events: [],
    decisions: [],
    status: "running",
    listeners: new Set(),
    ...(human ? { human } : {}),
  };
  registry.set(id, game);
  // prune oldest finished games to bound memory
  if (registry.size > MAX_KEPT) {
    for (const [k, g] of registry) {
      if (g.status !== "running") {
        registry.delete(k);
        if (registry.size <= MAX_KEPT) break;
      }
    }
  }
  return game;
}

export function getLive(id: string): LiveGame | null {
  return registry.get(id) ?? null;
}

export function pushLive(id: string, event: GameEvent, index: number): void {
  const game = registry.get(id);
  if (!game) return;
  game.events[index] = event;
  for (const l of game.listeners) l(event, index);
  if (game.human) {
    // onEvent runs inside the engine's events.push: nothing here may throw into simulate().
    try {
      projectForSeat(game, game.human, event, index);
    } catch (err) {
      if (!seatErrorLogged.has(id)) {
        seatErrorLogged.add(id);
        console.error("seat projection failed", id, err);
      }
    }
  }
}

const seatErrorLogged = new Set<string>();

function projectForSeat(game: LiveGame, seat: HumanSeat, event: GameEvent, index: number): void {
  const push = (e: SeatEvent) => {
    seat.events.push(e);
    const seq = seat.events.length - 1;
    for (const l of seat.eventListeners) {
      try {
        l(e, seq);
      } catch {
        seat.eventListeners.delete(l);
      }
    }
  };
  // A dead human Hunter stays blind until their own shot is logged: with two
  // hunters that shot is asked only after the next phase event.
  const hunterDone =
    seat.role !== "hunter" ||
    game.events.some((e) => e?.kind === "hunter_shot" && e.hunterId === seat.seatId);
  if (event.kind === "phase" && seat.dead && !seat.ghost && hunterDone) {
    seat.ghost = true;
    push({ kind: "seat_reveal", final: false, players: game.players.map((p) => ({ ...p })) });
  }
  if (event.kind === "game_over") {
    push({
      kind: "seat_reveal",
      final: true,
      players: game.players.map((p) => ({ ...p })),
      events: game.events.slice(0, index),
    });
  }
  const projected = projectEvent(
    event,
    { seatId: seat.seatId, role: seat.role, alignment: seat.alignment },
    seat.ghost
  );
  if (projected) push(projected);
  if (event.kind === "death" && event.playerId === seat.seatId) seat.dead = true;
}

export function subscribeSeat(id: string, fn: (ev: SeatEvent, seq: number) => void): () => void {
  const seat = registry.get(id)?.human;
  if (!seat) return () => {};
  seat.eventListeners.add(fn);
  return () => {
    seat.eventListeners.delete(fn);
  };
}

/** Calls every state listener; a listener that throws is removed and never rethrows. */
export function fireSeatState(seat: HumanSeat): void {
  for (const l of seat.stateListeners) {
    try {
      l();
    } catch {
      seat.stateListeners.delete(l);
    }
  }
}

/** True while a human game must not be shown to spectators. */
export function isSealed(game: LiveGame): boolean {
  return !!game.human && game.status === "running" && !game.events.some((e) => e?.kind === "game_over");
}

/** Test seam only: clears pending seat timers and empties the registry. Never imported by app code. */
export function __resetLiveForTests(): void {
  for (const g of registry.values()) if (g.human?.pending?.timer) clearTimeout(g.human.pending.timer);
  registry.clear();
}

export function pushLiveDecision(id: string, record: DecisionRecord): void {
  const game = registry.get(id);
  if (!game) return;
  (game.decisions ??= []).push(record); // ??= tolerates objects that survived dev HMR
}

/**
 * Decisions the stream should send immediately before event `index`.
 * `cursor` is the caller's position in `decisions`. Records anchored at or before
 * `lastId` were delivered on an earlier connection and are skipped.
 */
export function decisionsThrough(
  decisions: DecisionRecord[],
  cursor: number,
  index: number,
  lastId: number
): { send: DecisionRecord[]; cursor: number } {
  const send: DecisionRecord[] = [];
  while (cursor < decisions.length && decisions[cursor].step <= index) {
    if (decisions[cursor].step > lastId) send.push(decisions[cursor]);
    cursor++;
  }
  return { send, cursor };
}

/** Decisions still buffered once the event stream is exhausted (an abandoned game's last passes). */
export function decisionsRemaining(
  decisions: DecisionRecord[],
  cursor: number,
  lastId: number
): { send: DecisionRecord[]; cursor: number } {
  return decisionsThrough(decisions, cursor, Number.MAX_SAFE_INTEGER, lastId);
}

/**
 * Last-Event-ID as an event index; -1 (send everything) when absent or malformed.
 * A NaN here would make every `index > lastId` test false and hang the stream.
 */
export function parseLastEventId(header: string | null): number {
  if (header === null || !/^\d+$/.test(header.trim())) return -1;
  const n = Number(header.trim());
  return Number.isSafeInteger(n) ? n : -1;
}

export function finishLive(id: string, status: LiveStatus): void {
  const game = registry.get(id);
  if (game) game.status = status;
}

export function subscribeLive(
  id: string,
  fn: (event: GameEvent, index: number) => void
): () => void {
  const game = registry.get(id);
  if (!game) return () => {};
  game.listeners.add(fn);
  return () => {
    game.listeners.delete(fn);
  };
}

export function listRunning(): LiveGame[] {
  return [...registry.values()].filter((g) => g.status === "running");
}
