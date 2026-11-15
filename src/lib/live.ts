// In-process registry for live games. A game being simulated streams its events
// here as they are produced; SSE clients replay the buffer then tail new events.
// Local-first: this lives in the Node server process (dev / next start). If the
// process dies mid-game the game is abandoned (never persisted, never rated).

import { DecisionRecord, GameConfig, GameEvent, Player } from "./engine/types";

export type LiveStatus = "running" | "finished" | "abandoned";

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
  players: Player[]
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
