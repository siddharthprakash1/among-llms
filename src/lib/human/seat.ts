// Server-only seat mechanics: token + cookie, the pending prompt, its clock,
// autopilot and the redacted seat meta. Timers and Date.now live here, never in
// the engine. Nothing in this file may throw out of a timer callback: an
// uncaught exception there would end the Node process and every live game.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Alignment, Role } from "../engine/types";
import { resolveRoleCounts } from "../engine/roles";
import { fireSeatState, getLive, listRunning, type HumanSeat, type LiveGame, type PendingPrompt } from "../live";
import type { PromptPort } from "../agents/humanBrain";
import type { PromptKind, SeatAnswer, SeatMeta, SeatPrompt, SeatStatus } from "./types";
import { validateAnswer } from "./legal";

export const BUDGET_MS: Record<PromptKind, number> = {
  statement: 120_000,
  defend: 90_000,
  accuse: 60_000,
  vote: 60_000,
  wolf_chat: 60_000,
  night_kill: 60_000,
  night_check: 60_000,
  night_protect: 60_000,
  witch: 60_000,
  hunter_shot: 45_000,
};
export const DELIVERY_GRACE_MS = 30_000;
export const AUTOPILOT_AFTER_MISSES = 2;
export const MAX_RUNNING_HUMAN_GAMES = 3;
export const MAX_ACT_BODY_BYTES = 4096;
export const MAX_CREATE_BODY_BYTES = 4096;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function newSeatToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}

export const seatCookieName = (id: string) => `al_seat_${id}`;

export function buildSeatCookie(id: string, token: string, secure: boolean): string {
  return (
    `${seatCookieName(id)}=${token}; Path=/api/games/${id}/seat; HttpOnly; SameSite=Strict; Max-Age=21600` +
    (secure ? "; Secure" : "")
  );
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function verifySeat(
  id: string,
  cookieHeader: string | null
): { ok: true; game: LiveGame; seat: HumanSeat } | { ok: false; status: 401 | 404 } {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, status: 404 };
  const game = getLive(id);
  if (!game || !game.human) return { ok: false, status: 404 };
  const value = readCookie(cookieHeader, seatCookieName(id));
  if (!value) return { ok: false, status: 401 };
  const given = Buffer.from(sha256(value), "hex");
  const want = Buffer.from(game.human.tokenHash, "hex");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, status: 401 };
  return { ok: true, game, seat: game.human };
}

export function newHumanSeat(seatId: number, role: Role, alignment: Alignment, tokenHash: string): HumanSeat {
  return {
    seatId,
    role,
    alignment,
    tokenHash,
    events: [],
    eventListeners: new Set(),
    dead: false,
    ghost: false,
    pending: null,
    promptSeq: 0,
    missed: 0,
    autopilot: false,
    lastResolved: null,
    stateListeners: new Set(),
  };
}

/** Runs once per prompt: resolves the brain first, then tells the streams. */
function settle(
  seat: HumanSeat,
  pending: PendingPrompt,
  answer: SeatAnswer | null,
  outcome: "submitted" | "timeout"
): void {
  if (seat.pending !== pending) return;
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = null;
  seat.pending = null;
  seat.lastResolved = { id: pending.prompt.id, outcome };
  pending.resolve(answer);
  fireSeatState(seat);
}

function onTimeout(seat: HumanSeat, pending: PendingPrompt): void {
  try {
    if (seat.pending !== pending) return;
    seat.missed++;
    if (seat.missed >= AUTOPILOT_AFTER_MISSES) seat.autopilot = true;
    settle(seat, pending, null, "timeout");
  } catch (err) {
    console.error("seat timeout failed", err);
  }
}

/** Starts the answer clock. Idempotent; shared by the grace timer and armPrompt. */
function arm(seat: HumanSeat, pending: PendingPrompt): void {
  try {
    if (seat.pending !== pending || pending.deadlineAt !== null) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.deadlineAt = Date.now() + pending.prompt.budgetMs;
    pending.timer = setTimeout(() => onTimeout(seat, pending), pending.prompt.budgetMs);
    pending.timer.unref?.();
  } catch (err) {
    console.error("seat arm failed", err);
  }
}

export function makePromptPort(gameId: string): PromptPort {
  return {
    ask(spec) {
      return new Promise<SeatAnswer | null>((resolve) => {
        try {
          const game = getLive(gameId);
          const seat = game?.human;
          if (!game || !seat || game.status !== "running" || seat.autopilot) return resolve(null);
          if (seat.pending) settle(seat, seat.pending, null, "timeout");
          const prompt: SeatPrompt = {
            ...spec,
            id: String(++seat.promptSeq),
            budgetMs: BUDGET_MS[spec.kind],
            afterSeq: seat.events.length,
          };
          const pending: PendingPrompt = { prompt, deadlineAt: null, timer: null, resolve };
          // The clock starts when a stream delivers the prompt; this grace timer
          // starts it anyway so an abandoned game still finishes.
          pending.timer = setTimeout(() => arm(seat, pending), DELIVERY_GRACE_MS);
          pending.timer.unref?.();
          seat.pending = pending;
          fireSeatState(seat);
        } catch {
          resolve(null);
        }
      });
    },
  };
}

/** Starts the clock for the pending prompt; returns the remaining ms, or null if it is not pending. */
export function armPrompt(gameId: string, promptId: string): number | null {
  const seat = getLive(gameId)?.human;
  const pending = seat?.pending;
  if (!seat || !pending || pending.prompt.id !== promptId) return null;
  arm(seat, pending);
  return pending.deadlineAt === null ? null : Math.max(0, pending.deadlineAt - Date.now());
}

export function submitAnswer(
  gameId: string,
  body: unknown
): { ok: true } | { ok: false; status: 400 | 409; error: string } {
  const seat = getLive(gameId)?.human;
  const pending = seat?.pending;
  const promptId = (body as { promptId?: unknown } | null)?.promptId;
  if (!seat || !pending || promptId !== pending.prompt.id) return { ok: false, status: 409, error: "stale prompt" };
  const answer = validateAnswer(pending.prompt, body);
  if ("error" in answer) return { ok: false, status: 400, error: answer.error };
  seat.missed = 0;
  settle(seat, pending, answer, "submitted");
  return { ok: true };
}

export function resumeSeat(gameId: string): void {
  const seat = getLive(gameId)?.human;
  if (!seat) return;
  seat.autopilot = false;
  seat.missed = 0;
  fireSeatState(seat);
}

/** Called after finishLive. Always fires the state listeners so idle seat streams see the final status. */
export function closeSeat(gameId: string): void {
  const seat = getLive(gameId)?.human;
  if (!seat) return;
  if (seat.pending) {
    // Not settle(): nobody answered and nobody timed out, so lastResolved stays as it was.
    const pending = seat.pending;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    seat.pending = null;
    pending.resolve(null);
  }
  fireSeatState(seat);
}

export function seatStatus(seat: HumanSeat, writtenSeq: number): SeatStatus {
  const pending = seat.pending && seat.pending.prompt.afterSeq <= writtenSeq ? seat.pending : null;
  return {
    prompt: pending ? pending.prompt : null,
    remainingMs: pending
      ? pending.deadlineAt === null
        ? pending.prompt.budgetMs
        : Math.max(0, pending.deadlineAt - Date.now())
      : null,
    autopilot: seat.autopilot,
    lastResolved: seat.lastResolved ? { ...seat.lastResolved } : null,
  };
}

/** Allow-listed fields only: never the config, a seed, or anyone else's role. */
export function seatMeta(game: LiveGame): SeatMeta {
  const seat = game.human;
  if (!seat) throw new Error("not a human game");
  const me = game.players[seat.seatId];
  return {
    id: game.id,
    createdAt: game.createdAt,
    status: game.status,
    numPlayers: game.config.numPlayers,
    players: game.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, model: p.model })),
    roleCounts: resolveRoleCounts(game.config),
    you: { seatId: seat.seatId, name: me.name, avatar: me.avatar, role: seat.role, alignment: seat.alignment },
    packmates:
      seat.alignment === "evil"
        ? game.players.filter((p) => p.role === "werewolf" && p.id !== seat.seatId).map((p) => p.id)
        : [],
  };
}

export function runningHumanGames(): number {
  return listRunning().filter((g) => g.human).length;
}
