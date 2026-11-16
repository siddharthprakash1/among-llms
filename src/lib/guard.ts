// Abuse guard for a public arena: admin token, public mode, per-client rate
// limit, daily budget, concurrency caps and a request body cap. With no ARENA_*
// env set it admits everything. It only admits or denies: it never rewrites a
// request. Deliberately free of next/server, the live registry and the store so
// it stays unit-testable; routes pass the current load in.

import { createHash, timingSafeEqual } from "node:crypto";
import { getProviderConfig } from "./agents/registry";

type Env = Record<string, string | undefined>;

export type PublicMode = "open" | "bots" | "off";

export interface GuardConfig {
  mode: PublicMode;
  /** sha256 of the token; null when unset or shorter than 16 chars. */
  adminTokenHash: Buffer | null;
  rateLimit: number | null; // per client per minute
  dailyGames: number | null; // non-admin starts per 24h, global
  maxGames: number | null;
  maxTournaments: number | null;
  ipHeader: string | null; // lower-cased
  warnings: string[]; // never contains secret values
}

export interface Denial {
  status: 401 | 403 | 413 | 429 | 503;
  code: "admin_required" | "disabled" | "body_too_large" | "rate_limited" | "budget_exhausted" | "busy";
  error: string; // human sentence; the forms show it verbatim
  retryAfterSec?: number;
}

export type StartRequest =
  | { kind: "game"; seatModels: string[] } // normalized: buildConfig(input).seatModels
  | { kind: "tournament" };

export interface Load {
  games: number;
  tournaments: number;
}

export interface GuardInfo {
  mode: PublicMode;
  adminConfigured: boolean;
  authorized: boolean; // this request carries the valid token
  canStartGames: boolean;
  canSeatRealModels: boolean;
  canStartTournaments: boolean;
  lockedModels: string[]; // ids this caller may not seat
  realModels: string[]; // ids that call a provider, whoever asks
}

export const MAX_BODY_BYTES = 65_536;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MIN_TOKEN_CHARS = 16;
const PRUNE_ABOVE = 10_000;
/**
 * Seat actions allowed per start allowed. A seat answers a handful of prompts
 * a minute, so this only stops a flood; a normal player never reaches it.
 */
export const ACTS_PER_START = 20;

/** `expires` is stored so pruning never needs the caller's window length. */
export interface Bucket {
  start: number;
  count: number;
  expires: number;
}
export interface LimitResult {
  ok: boolean;
  retryAfterSec: number;
}

interface GuardState {
  buckets: Map<string, Bucket>;
  inflight: number;
}
// Same reason as live.ts: every route bundle must share one set of counters.
const g = globalThis as unknown as { __amongLlmsGuard?: GuardState };
const state = (): GuardState => (g.__amongLlmsGuard ??= { buckets: new Map(), inflight: 0 });

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();
const defaultIsReal = (id: string) => getProviderConfig(id) !== null;

export function readGuardConfig(env: Env = process.env): GuardConfig {
  const warnings: string[] = [];

  const token = env.ARENA_ADMIN_TOKEN?.trim() ?? "";
  let adminTokenHash: Buffer | null = null;
  if (token.length >= MIN_TOKEN_CHARS) adminTokenHash = sha256(token);
  else if (token) {
    warnings.push("ARENA_ADMIN_TOKEN is shorter than 16 characters; admin access is disabled.");
  }

  const rawMode = env.ARENA_PUBLIC_MODE?.trim().toLowerCase() ?? "";
  let mode: PublicMode;
  if (rawMode === "open" || rawMode === "bots" || rawMode === "off") mode = rawMode;
  else if (rawMode) {
    mode = "bots";
    warnings.push('ARENA_PUBLIC_MODE is not one of "open", "bots", "off"; using "bots".');
  } else {
    mode = token ? "bots" : "open";
  }

  const num = (name: string): number | null => {
    const v = env[name]?.trim() ?? "";
    if (!v) return null;
    const n = /^\d+$/.test(v) ? Number(v) : NaN;
    if (Number.isSafeInteger(n) && n > 0) return n;
    warnings.push(`${name} is not a positive integer; that limit is off.`);
    return null;
  };

  return {
    mode,
    adminTokenHash,
    rateLimit: num("ARENA_RATE_LIMIT"),
    dailyGames: num("ARENA_DAILY_GAMES"),
    maxGames: num("ARENA_MAX_GAMES"),
    maxTournaments: num("ARENA_MAX_TOURNAMENTS"),
    ipHeader: env.ARENA_IP_HEADER?.trim().toLowerCase() || null,
    warnings,
  };
}

export function isAdmin(req: Request, cfg: GuardConfig): boolean {
  if (!cfg.adminTokenHash) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  // Hashing first makes both sides the same length, as timingSafeEqual requires.
  return timingSafeEqual(sha256(m[1]), cfg.adminTokenHash);
}

export function clientKey(req: Request, cfg: GuardConfig): string {
  if (!cfg.ipHeader) return "shared";
  // The last entry is the one the nearest proxy appended; earlier ones are client-supplied.
  const last = (req.headers.get(cfg.ipHeader) ?? "").split(",").pop()?.trim();
  return last || "shared";
}

/** Fixed window, read-only: would one more hit be allowed at `now`? */
export function peekRateLimit(
  buckets: Map<string, Bucket>,
  key: string,
  limit: number,
  now: number
): LimitResult {
  const b = buckets.get(key);
  if (b && b.expires > now && b.count >= limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.expires - now) / 1000)) };
  }
  return { ok: true, retryAfterSec: 0 };
}

/** Records one hit. Call only after every check has passed. */
export function commitRateLimit(
  buckets: Map<string, Bucket>,
  key: string,
  now: number,
  windowMs: number
): void {
  const b = buckets.get(key);
  if (b && b.expires > now) {
    b.count++;
    return;
  }
  if (buckets.size > PRUNE_ABOVE) {
    for (const [k, v] of buckets) if (v.expires <= now) buckets.delete(k);
  }
  buckets.set(key, { start: now, count: 1, expires: now + windowMs });
}

/** peek, then commit when ok. Convenience for tests and single-limit callers. */
export function hitRateLimit(
  buckets: Map<string, Bucket>,
  key: string,
  limit: number,
  now: number,
  windowMs: number
): LimitResult {
  const r = peekRateLimit(buckets, key, limit, now);
  if (r.ok) commitRateLimit(buckets, key, now, windowMs);
  return r;
}

interface CheckOpts {
  now?: number;
  env?: Env;
  isReal?: (id: string) => boolean;
}

/**
 * Admit or deny a request that starts a game or a tournament. Synchronous, so
 * its peeks and commits cannot interleave with another request; a denial
 * consumes nothing.
 */
export function checkStart(
  req: Request,
  start: StartRequest,
  load: Load,
  opts: CheckOpts = {}
): Denial | null {
  const cfg = readGuardConfig(opts.env);
  const now = opts.now ?? Date.now();
  const isReal = opts.isReal ?? defaultIsReal;
  const admin = isAdmin(req, cfg);
  const { buckets } = state();

  if (!admin && cfg.mode !== "open") {
    const blocked =
      cfg.mode === "off" ||
      start.kind === "tournament" ||
      start.seatModels.some((id) => isReal(id));
    if (blocked) {
      if (cfg.adminTokenHash) {
        return {
          status: 401,
          code: "admin_required",
          error: "Admin token required to seat real models or start tournaments.",
        };
      }
      return {
        status: 403,
        code: "disabled",
        error: cfg.mode === "off" ? "This arena is view-only." : "This arena only allows bot games.",
      };
    }
  }

  const full =
    start.kind === "game"
      ? cfg.maxGames !== null && load.games >= cfg.maxGames
      : cfg.maxTournaments !== null && load.tournaments >= cfg.maxTournaments;
  if (full) {
    return {
      status: 503,
      code: "busy",
      error: "The arena is full. Try again in a minute.",
      retryAfterSec: 30,
    };
  }

  if (admin) return null;

  const ipKey = `ip:${clientKey(req, cfg)}`;
  if (cfg.rateLimit !== null) {
    const r = peekRateLimit(buckets, ipKey, cfg.rateLimit, now);
    if (!r.ok) {
      return {
        status: 429,
        code: "rate_limited",
        error: `Slow down — you can start another match in ${r.retryAfterSec}s.`,
        retryAfterSec: r.retryAfterSec,
      };
    }
  }
  if (cfg.dailyGames !== null) {
    const r = peekRateLimit(buckets, "daily", cfg.dailyGames, now);
    if (!r.ok) {
      return {
        status: 429,
        code: "budget_exhausted",
        error: "The arena has reached today's game limit. Try again later.",
        retryAfterSec: r.retryAfterSec,
      };
    }
  }

  if (cfg.rateLimit !== null) commitRateLimit(buckets, ipKey, now, MINUTE_MS);
  if (cfg.dailyGames !== null) commitRateLimit(buckets, "daily", now, DAY_MS);
  return null;
}

/**
 * Admit or deny a mutating request inside a game that was already admitted (a
 * human seat's answer). Only a per-client flood limit applies: mode, caps and
 * the daily budget were charged at the start, and a seated player must always
 * be able to finish. The caller verifies the seat token first; this never
 * replaces that check.
 */
export function checkAct(req: Request, opts: { now?: number; env?: Env } = {}): Denial | null {
  const cfg = readGuardConfig(opts.env);
  if (cfg.rateLimit === null || isAdmin(req, cfg)) return null;
  const now = opts.now ?? Date.now();
  const r = hitRateLimit(
    state().buckets,
    `act:${clientKey(req, cfg)}`,
    cfg.rateLimit * ACTS_PER_START,
    now,
    MINUTE_MS
  );
  if (r.ok) return null;
  return {
    status: 429,
    code: "rate_limited",
    error: `Slow down — try again in ${r.retryAfterSec}s.`,
    retryAfterSec: r.retryAfterSec,
  };
}

export function describeGuard(
  req: Request,
  modelIds: string[],
  opts: { env?: Env; isReal?: (id: string) => boolean } = {}
): GuardInfo {
  const cfg = readGuardConfig(opts.env);
  const isReal = opts.isReal ?? defaultIsReal;
  const authorized = isAdmin(req, cfg);
  const allowed = authorized || cfg.mode === "open";
  const realModels = modelIds.filter((id) => isReal(id));
  return {
    mode: cfg.mode,
    adminConfigured: cfg.adminTokenHash !== null,
    authorized,
    canStartGames: allowed || cfg.mode === "bots",
    canSeatRealModels: allowed,
    canStartTournaments: allowed,
    lockedModels: allowed ? [] : realModels,
    realModels,
  };
}

const tooLarge = (): Denial => ({
  status: 413,
  code: "body_too_large",
  error: "Request body too large.",
});

/** `reason`: "json" did not parse, "shape" parsed to something other than an object. */
export type JsonBody =
  | { body: unknown; malformed: false }
  | { body: Record<string, never>; malformed: true; reason: "json" | "shape" };

/**
 * Read a JSON object body with a size cap. A declared length over the cap is
 * refused before anything is read, and the body is read chunk by chunk so a
 * request without Content-Length (chunked) cannot make the server buffer more
 * than the cap. Malformed JSON and non-object values become `{}`; `malformed`
 * tells the caller which, for routes that must 400.
 */
export async function readJsonBody(
  req: Request,
  maxBytes: number = MAX_BODY_BYTES
): Promise<JsonBody | { denial: Denial }> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { denial: tooLarge() };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = req.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { denial: tooLarge() };
      }
      chunks.push(value);
    }
  } catch {
    return { body: {}, malformed: true, reason: "json" };
  }
  const text = Buffer.concat(chunks, total).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { body: {}, malformed: true, reason: "json" };
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return { body: parsed, malformed: false };
  }
  return { body: {}, malformed: true, reason: "shape" };
}

/**
 * `error` overrides the sentence only: the human-game routes answered an
 * oversize body with their own wording before the guard existed, and keep it.
 */
export function denied(d: Denial, error: string = d.error): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (d.retryAfterSec !== undefined) headers["retry-after"] = String(d.retryAfterSec);
  return new Response(JSON.stringify({ error, code: d.code }), { status: d.status, headers });
}

/**
 * Response for a start that threw after it was admitted. A filesystem error
 * (strict ARENA_DATA_DIR that is not writable) is the host's fault, and its
 * message carries the server's data path, so it is never echoed to the client.
 */
export function startFailed(err: unknown, fallback: string): Response {
  const sys = err as { code?: unknown; syscall?: unknown } | null;
  if (sys && typeof sys.code === "string" && typeof sys.syscall === "string") {
    return Response.json(
      { error: "The arena's storage is unavailable. Try again later.", code: "storage_unavailable" },
      { status: 503 }
    );
  }
  return Response.json({ error: err instanceof Error ? err.message : fallback }, { status: 400 });
}

/** Counts a blocking POST /api/games simulation toward ARENA_MAX_GAMES. */
export function trackGame<T>(p: Promise<T>): Promise<T> {
  const s = state();
  s.inflight++;
  return p.finally(() => {
    s.inflight--;
  });
}

export function inflightGames(): number {
  return state().inflight;
}

/** Tests only. */
export function resetGuardState(): void {
  const s = state();
  s.buckets.clear();
  s.inflight = 0;
}

/** Tests only: the live bucket map behind checkStart. */
export function guardBuckets(): Map<string, Bucket> {
  return state().buckets;
}
