// In-process registry for live games. A game being simulated streams its events
// here as they are produced; SSE clients replay the buffer then tail new events.
// Local-first: this lives in the Node server process (dev / next start). If the
// process dies mid-game the game is abandoned (never persisted, never rated).

import { GameConfig, GameEvent, Player } from "./engine/types";

export type LiveStatus = "running" | "finished" | "abandoned";

export interface LiveGame {
  id: string;
  createdAt: string;
  config: GameConfig;
  players: Player[];
  events: GameEvent[]; // replay buffer (index === event id)
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
