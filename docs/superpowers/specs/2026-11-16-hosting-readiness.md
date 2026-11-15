# Hosting readiness for a public arena — implementation spec

Date: 2026-11-16. Status: ready to implement. No deployment or account creation is part of this work; it delivers code and docs that make the app deployable with one documented procedure.

## 1. Outcome and decisions

| Question | Decision |
|---|---|
| Host | One long-lived Node container with a persistent volume. Recommended and documented host: Fly.io (one machine, one volume). Serverless is not supported for live mode or tournaments. |
| Next output | `output: "standalone"`, only when `NEXT_OUTPUT=standalone` (set in the Dockerfile). Local `next build` / `next start` and Windows builds are unchanged. |
| Data dir | New env `ARENA_DATA_DIR`. When set it is strict: no tmp fallback, store calls reject, health returns 503. Unset keeps today's `./data` then tmp fallback. |
| Abuse guard | One dependency-free module, `src/lib/guard.ts`: admin token, public mode (`open` / `bots` / `off`), per-IP rate limit, global daily game budget, concurrency caps, request body cap. |
| Fail-closed image | The Dockerfile sets `ARENA_PUBLIC_MODE=bots`. If the owner forgets the token, real models and tournaments are denied to everyone instead of open to everyone. |
| Restart mid-live-game | The game is lost (never persisted, never rated: existing contract). New: the SSE stream sends a terminal `end` event and the viewer shows an "interrupted" panel instead of reconnecting forever. |
| Restart mid-tournament | Not resumed. At boot, hosted deployments mark orphaned `running` tournaments `abandoned`. Resume was rejected because `runGame` rates each game before the batch's `saveTournament`, so a resumed batch would re-play rated games and double-apply Elo. |
| Non-file Store adapter | Not added (section 9). |
| Engine, brains, persisted types, `Store` interface | Unchanged. `src/lib/store/index.ts` changes only by moving its two pure summary helpers to `summary.ts` and re-exporting them (section 5), which breaks an import cycle. |

Design lineage: the base is the minimal single-module guard (design 1). Grafted from design 2: fail-closed image default, `createFileStore` factory with `globalThis`-pinned lock, abandon-at-boot, 401 vs 403, daily budget, body cap, static wiring test, classification on the normalized config. Grafted from design 3: SSE heartbeat, `node:22-slim` base with a `node -e fetch` health check, Fly connection limits to bound open streams, locked model chips in the form.

Rejected, with reason:

- Branded `Clearance` parameter on `createGame` etc.: changes three signatures for a guarantee the static wiring test gives more cheaply.
- Cookie session and `/operator` page: a Bearer token kept in `localStorage` needs no new routes and has no CSRF surface.
- SIGTERM drain and `NEXT_MANUAL_SIG_HANDLE`: atomic writes make a kill at any instant safe for stored data, and a live LLM game cannot be resumed anyway.
- Transcript retention pruning: it breaks replay permalinks, tournament game links and Elo history links.
- Client `onerror` counter: it would falsely flag bot games as interrupted during a 10 to 30 second redeploy, where `EventSource` reconnect already recovers.
- Strict (throwing) reads inside locked read-modify-write: a behaviour change for local users with a damaged file. Atomic writes remove the cause.

## 2. Facts verified in the code

- `src/lib/store/fileStore.ts`: `resolveDir()` hardcodes `path.join(process.cwd(), "data")` with a silent fallback to `os.tmpdir()/among-llms-data`. `writeJson` is a plain `fs.writeFile`; `readJson` returns its fallback on any error, so a truncated `leaderboard.json` is read as `{}` and overwritten. `dirPromise` and `mutation` are module-level.
- `next.config.mjs` has only `reactStrictMode` and `eslint.ignoreDuringBuilds`. There is no `public/`, no `src/instrumentation.ts`, no middleware.
- `POST /api/games`, `POST /api/games/live`, `POST /api/tournaments` have no auth or limits. `POST /api/games/live` calls `createLiveGame` outside any try.
- `buildConfig` (`src/lib/games.ts`) coerces unknown seat ids to `"mock"`. `buildBrainFactory` creates an `LlmBrain` exactly when `getProviderConfig(id) !== null`. Ollama models count as real.
- `buildTournamentConfig` does not validate roster ids.
- `src/lib/live.ts` keeps live games in a `globalThis` map; `listRunning()` returns the running ones.
- `src/app/api/games/[id]/stream/route.ts` closes silently when the id is neither live nor persisted. In `src/components/LiveGame.tsx` the 5 s not-found timer fires only if `meta` never arrived, so a viewer who already had `meta` reconnects forever after a restart.
- `runTournament` is an in-process loop; nothing restarts it at boot. `TournamentView.tsx` polls every 2 s while status is `running` and renders badges only for `running` and `finished`. `TournamentStatus` already includes `"abandoned"`.
- No existing test calls `createGame`, `createLiveGame`, `createTournament` or imports `fileStore`.
- `src/lib/store/fileStore.ts` imports `summarize` and `summarizeTournament` (values) from `./index`, and `./index` ends with `import { fileStore } from "./fileStore"; export const store: Store = fileStore;`. This cycle works today only because every consumer enters through `./index`. Any module graph that loads `fileStore.ts` first gets `store === undefined` (Vitest 2 / Vite 5 SSR) or a TDZ `ReferenceError` (native ESM, webpack). This spec adds such entry points (`fileStore.test.ts`, `run.test.ts`, `/api/health`), so the cycle is removed in task 1.
- `createTournament` generates `id` synchronously, then awaits `store.getLeaderboard()` and `store.saveTournament()` before starting `runTournament`. `createGame`/`createLiveGame` have no such gap before they register.
- The stream route's `ReadableStream` has no `cancel()` handler, `controller.enqueue` calls are not in try/catch, and `closed`/`safeClose`/`unsub` are local to `start()`. `subscribeLive`'s unsubscribe function is idempotent (a `Set.delete`).
- In `NewGameForm.tsx` the blocking button is "▶ Run a match" (`run(false)`, `POST /api/games`); "📡 Watch live" is `run(true)`. `ModelInfo` has no field that tells a real model from a bot.
- Docker is not installed on the development laptop, so the Dockerfile and `fly.toml` in this spec are unverified until task 11.

## 3. Environment variables

All optional. With none set, behaviour is today's apart from the always-on changes in section 10.

| Var | Meaning | Unset |
|---|---|---|
| `ARENA_DATA_DIR` | Store directory (resolved with `path.resolve`). Strict: an unwritable dir is an error. Also marks the process as a hosted deployment for the boot reconcile (section 7). | `./data`, then tmp fallback |
| `ARENA_ADMIN_TOKEN` | Operator secret, at least 16 characters, sent as `Authorization: Bearer <token>`. A shorter value disables admin and adds a warning. | no admin exists |
| `ARENA_PUBLIC_MODE` | What non-admins may start: `open` (anything), `bots` (bot-only games; no real models, no tournaments), `off` (nothing). An unrecognised value is treated as `bots` with a warning. | `bots` if `ARENA_ADMIN_TOKEN` is non-empty, else `open` |
| `ARENA_RATE_LIMIT` | Starts per minute per client, across the three POST routes. Non-admins only. | off |
| `ARENA_DAILY_GAMES` | Total non-admin starts admitted per 24 h window, all clients combined. A game start costs 1 and a tournament start costs 1 (not one per tournament game). Only admitted requests are counted. Bounds disk growth from standalone games; in `bots` mode that is all non-admin growth. See the `open`-mode caveat below. | off |
| `ARENA_MAX_GAMES` | Cap on concurrently running standalone games (live running plus blocking `POST /api/games` in flight). Applies to everyone. Games played inside a tournament are not counted. | off |
| `ARENA_MAX_TOURNAMENTS` | Cap on concurrently running tournaments. Applies to everyone. | off |
| `ARENA_IP_HEADER` | Request header that carries the client IP (`fly-client-ip` on Fly). If it contains commas, the last entry is used. | all non-admin clients share one rate-limit bucket |
| `NEXT_OUTPUT` | `standalone` at build time. Dockerfile only. | normal build |

Numeric vars: a positive integer enables the limit. Empty means off. Any other non-empty value means off and adds a warning to `/api/health`.

`open`-mode caveat (also goes in `docs/DEPLOY.md`): tournament games are run by `run.ts` calling `simulate()` directly, up to `concurrency` 8 at once, and this spec does not change that. So in `open` mode `ARENA_MAX_GAMES` does not bound concurrent tournament games, and `ARENA_DAILY_GAMES` counts a whole tournament as 1 although it can write dozens of transcripts. There the bounds on tournament load are `ARENA_MAX_TOURNAMENTS`, `ARENA_RATE_LIMIT`, the daily budget's one-per-tournament charge, and the existing clamps in `buildTournamentConfig`. In `bots` and `off` mode (the image default is `bots`) only the admin can start tournaments, so the caveat does not apply.

## 4. Files

New:

| File | Purpose |
|---|---|
| `src/lib/guard.ts` | Config parsing, admin check, rate limiter, caps, body reader, UI info |
| `src/lib/guard.test.ts` | Guard tests |
| `src/lib/guard.wiring.test.ts` | Static scan: every mutating route calls the guard |
| `src/lib/store/summary.ts` | `summarize`, `summarizeTournament` moved out of `index.ts` to break the import cycle |
| `src/lib/store/fileStore.test.ts` | Data dir, atomic write, serialization, legacy load, import-order pin |
| `src/lib/tournaments/run.test.ts` | Abandon-at-boot, synchronous slot reservation |
| `src/app/api/health/route.ts` | Health endpoint |
| `src/instrumentation.ts` | Boot hook |
| `src/components/AdminTokenField.tsx` | Token input |
| `Dockerfile`, `.dockerignore`, `fly.toml` | Deployment |
| `docs/DEPLOY.md` | Deployment procedure |

Edited: `src/lib/store/fileStore.ts`, `src/lib/store/index.ts` (helpers moved out and re-exported, nothing else), `src/lib/tournaments/run.ts`, `src/lib/ui.ts`, `src/app/api/games/route.ts`, `src/app/api/games/live/route.ts`, `src/app/api/tournaments/route.ts`, `src/app/api/models/route.ts`, `src/app/api/games/[id]/stream/route.ts`, `src/components/LiveGame.tsx`, `src/components/NewGameForm.tsx`, `src/components/NewTournamentForm.tsx`, `src/components/TournamentView.tsx`, `next.config.mjs`, `.env.example`, `README.md`.

Not touched: everything under `src/lib/engine/` and `src/lib/agents/`, `src/lib/games.ts`, `src/lib/live.ts`, `src/lib/elo.ts`, `src/lib/replay.ts`, `src/lib/director.ts`, `ReplayPlayer`, `EventFeed`, `GameTable`, `Scene3D`, and every existing test file.

## 5. Store: `src/lib/store/fileStore.ts`

The `Store` interface is unchanged, and `export const store: Store = fileStore;` still type-checks because `FileStore` extends `Store`.

Import cycle (do this first in task 1):

- New `src/lib/store/summary.ts` holds `summarize` and `summarizeTournament`, moved verbatim. It imports `Transcript` and `Tournament` as before and uses `import type { GameSummary, TournamentSummary } from "./index"` (type-only, erased at compile time, so it creates no runtime edge).
- `src/lib/store/index.ts`: delete the two function bodies and add `export { summarize, summarizeTournament } from "./summary";`. Every existing importer of these names from the store index keeps working. Nothing else in `index.ts` changes.
- `src/lib/store/fileStore.ts`: `import { summarize, summarizeTournament } from "./summary";` and `import type { GameSummary, Store, TournamentSummary } from "./index";`. After this `fileStore.ts` has no runtime import of `./index`, so load order no longer matters.

```ts
export interface FileStoreOptions {
  /** Explicit directory: strict (no tmp fallback) and private lock state. For tests. */
  dir?: string;
}
export interface StoreHealth { writable: boolean; persistent: boolean }
export type FileStore = Store & { health(): Promise<StoreHealth> };

/** Pure. `explicit` means the operator chose the dir, so failure must be loud. */
export function pickDataDir(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd()
): { dir: string; explicit: boolean };

export function createFileStore(opts?: FileStoreOptions): FileStore;
export const fileStore: FileStore = createFileStore();
```

Rules:

1. `pickDataDir`: `env.ARENA_DATA_DIR?.trim()` non-empty gives `{ dir: path.resolve(v), explicit: true }`; otherwise `{ dir: path.join(cwd, "data"), explicit: false }`.
2. Per-instance state is `{ dirPromise: Promise<string> | null; mutation: Promise<unknown>; persistent: boolean; seq: number }`.
   - `createFileStore()` with no `dir` uses `globalThis.__amongLlmsStore` (created on first use with `??=`), the same pattern as `live.ts`, so every route bundle shares one lock (invariant 7 and 8). Comment the why in one line.
   - `createFileStore({ dir })` uses a private state object.
3. Directory resolution happens lazily on the first store call, not at import:
   - With `opts.dir`, or `pickDataDir().explicit`: `mkdir -p <dir>/games`, write and remove a probe file. On failure, reset `dirPromise` to `null` (so a later-fixed mount recovers) and rethrow. `persistent = true`. Then, once, best-effort inside try/catch: delete every file ending in `.tmp` directly inside `<dir>`, `<dir>/games` and `<dir>/tournaments` (a missing directory is skipped). These are leftovers from a process killed between write and rename. It is safe because this runs before the instance's first write and a hosted arena is exactly one process per volume. Not done in the non-explicit branch, where two local processes may share `./data`.
   - Otherwise: today's logic unchanged. `persistent = true` when `./data` works, `false` when the tmp fallback was used.
4. `writeJson(file, data)` becomes atomic. The serialized bytes are unchanged (`JSON.stringify(data, null, 2)`, utf8).
   - Write to `` `${file}.${process.pid}.${state.seq++}.tmp` ``, then `fs.rename(tmp, file)`.
   - If rename fails with `EPERM`, `EBUSY` or `EACCES` (Windows, a reader holds the file), retry up to 5 times with a 20 ms wait.
   - If it still fails, fall back to the direct `fs.writeFile(file, …)` used today, then `fs.rm(tmp, { force: true })`.
   - Any other error: remove the tmp file and rethrow.
5. `health()`: `await dataDir()`, write and remove `` `.probe-${process.pid}` `` in the dir, return `{ writable: true, persistent }`. On any error return `{ writable: false, persistent: false }`. It never throws and never returns a path.
6. `readJson`, `withLock`, `INDEX_CAP`, the id regex guard and all eight `Store` methods keep their current logic. Every write still runs inside `withLock`.
7. Update the file's header comment: the tmp fallback applies only when `ARENA_DATA_DIR` is unset.

## 6. Guard: `src/lib/guard.ts`

Imports only `node:crypto` and `getProviderConfig` from `./agents/registry`. It must not import `next/server`, `./live`, `./store` or `./tournaments/run`, so it stays unit-testable; routes pass the load in.

```ts
type Env = Record<string, string | undefined>;

export type PublicMode = "open" | "bots" | "off";

export interface GuardConfig {
  mode: PublicMode;
  /** sha256 of the token; null when unset or shorter than 16 chars. */
  adminTokenHash: Buffer | null;
  rateLimit: number | null;       // per client per minute
  dailyGames: number | null;      // non-admin game starts per 24h, global
  maxGames: number | null;
  maxTournaments: number | null;
  ipHeader: string | null;        // lower-cased
  warnings: string[];             // never contains secret values
}

export interface Denial {
  status: 401 | 403 | 413 | 429 | 503;
  code: "admin_required" | "disabled" | "body_too_large" | "rate_limited" | "budget_exhausted" | "busy";
  error: string;                  // human sentence; the forms show it verbatim
  retryAfterSec?: number;
}

export type StartRequest =
  | { kind: "game"; seatModels: string[] }   // normalized: buildConfig(input).seatModels
  | { kind: "tournament" };

export interface Load { games: number; tournaments: number }

export interface GuardInfo {
  mode: PublicMode;
  adminConfigured: boolean;       // adminTokenHash !== null
  authorized: boolean;            // this request carries the valid token
  canStartGames: boolean;
  canSeatRealModels: boolean;
  canStartTournaments: boolean;
  lockedModels: string[];         // ids this caller may not seat
  realModels: string[];           // ids that call a provider, whoever asks
}

export const MAX_BODY_BYTES = 65_536;

export function readGuardConfig(env?: Env): GuardConfig;
export function isAdmin(req: Request, cfg: GuardConfig): boolean;
export function clientKey(req: Request, cfg: GuardConfig): string;

/** `expires` is stored so pruning never needs the caller's window length. */
export interface Bucket { start: number; count: number; expires: number }
export interface LimitResult { ok: boolean; retryAfterSec: number }

/** Fixed window, read-only: would one more hit be allowed at `now`? */
export function peekRateLimit(buckets: Map<string, Bucket>, key: string, limit: number, now: number): LimitResult;
/** Records one hit. Call only after every check has passed. */
export function commitRateLimit(buckets: Map<string, Bucket>, key: string, now: number, windowMs: number): void;
/** peek, then commit when ok. Convenience for tests and single-limit callers. */
export function hitRateLimit(
  buckets: Map<string, Bucket>,
  key: string, limit: number, now: number, windowMs: number
): LimitResult;

export function checkStart(
  req: Request, start: StartRequest, load: Load,
  opts?: { now?: number; env?: Env; isReal?: (id: string) => boolean }
): Denial | null;

export function describeGuard(
  req: Request, modelIds: string[],
  opts?: { env?: Env; isReal?: (id: string) => boolean }
): GuardInfo;

export function readJsonBody(req: Request): Promise<{ body: unknown } | { denial: Denial }>;
export function denied(d: Denial): Response;

/** Counts a blocking POST /api/games simulation toward ARENA_MAX_GAMES. */
export function trackGame<T>(p: Promise<T>): Promise<T>;
export function inflightGames(): number;
/** Tests only. */
export function resetGuardState(): void;
/** Tests only: the live bucket map behind checkStart. */
export function guardBuckets(): Map<string, Bucket>;
```

State: `globalThis.__amongLlmsGuard ??= { buckets: new Map(), inflight: 0 }`, for the same reason as `live.ts`. Defaults: `env = process.env`, `now = Date.now()`, `isReal = (id) => getProviderConfig(id) !== null`. The config is re-read from env on every call (cheap; no reset hook needed).

Semantics:

- `readGuardConfig`
  - Token: `ARENA_ADMIN_TOKEN?.trim()`. 16 or more characters gives `adminTokenHash = sha256(token)`. Non-empty but shorter gives `null` and the warning `"ARENA_ADMIN_TOKEN is shorter than 16 characters; admin access is disabled."`
  - Mode: `ARENA_PUBLIC_MODE?.trim().toLowerCase()`. A valid value is used. A non-empty invalid value gives `"bots"` and a warning. Empty gives `"bots"` when the token variable is non-empty (even if too short), else `"open"`.
  - Numbers: per section 3.
  - `ipHeader`: `ARENA_IP_HEADER?.trim().toLowerCase() || null`.
- `isAdmin`: false when `adminTokenHash` is null. Otherwise parse `Authorization: Bearer <t>` (scheme case-insensitive), and compare `sha256(t)` to `adminTokenHash` with `crypto.timingSafeEqual`.
- `clientKey`: `"shared"` when `ipHeader` is null or the header is absent or empty. Otherwise the last comma-separated entry, trimmed. `x-forwarded-for` is never read unless it is the named header.
- Rate limiting. A bucket is live while `expires > now`; a missing or expired bucket counts as empty.
  - `peekRateLimit`: no mutation. Live bucket with `count >= limit` gives `ok: false` with `retryAfterSec = max(1, ceil((expires - now) / 1000))`. Otherwise `ok: true`, `retryAfterSec: 0`.
  - `commitRateLimit`: a live bucket gets `count++`. Otherwise, if the map already holds more than 10 000 keys, first delete every bucket with `expires <= now` (each bucket carries its own expiry, so a 60 s per-IP call can never evict the unexpired 24 h `"daily"` bucket), then insert `{ start: now, count: 1, expires: now + windowMs }`.
  - `hitRateLimit`: `peekRateLimit`; when ok, `commitRateLimit`; returns the peek result.
- `checkStart` counts a request against the limiters only when it is admitted. Order, returning the first denial; steps 1 to 4 mutate nothing:
  1. Policy. Skipped for admins and in `open` mode.
     - `off`: deny.
     - `bots`: deny a tournament; deny a game where any `seatModels` id satisfies `isReal`.
     - The denial is `401 admin_required` (`"Admin token required to seat real models or start tournaments."`) when `adminTokenHash` is set, else `403 disabled` (`"This arena only allows bot games."`, or `"This arena is view-only."` in `off` mode).
  2. Caps, for everyone including admins. A game is denied when `maxGames` is set and `load.games >= maxGames`; a tournament when `maxTournaments` is set and `load.tournaments >= maxTournaments`. Denial: `503 busy`, `"The arena is full. Try again in a minute."`, `retryAfterSec: 30`.
  3. Per-client rate limit, peek only. Non-admins only, when `rateLimit` is set. Key `` `ip:${clientKey}` ``. Denial: `429 rate_limited`, `"Slow down — you can start another match in ${n}s."`, `retryAfterSec: n`.
  4. Daily budget, peek only. Non-admins only, both kinds (a tournament costs 1, see section 3), when `dailyGames` is set. Key `"daily"`. Denial: `429 budget_exhausted`, `"The arena has reached today's game limit. Try again later."`, with `retryAfterSec`.
  5. Admitted. For a non-admin, `commitRateLimit` the per-client bucket (window 60 000 ms) when `rateLimit` is set and the `"daily"` bucket (window 86 400 000 ms) when `dailyGames` is set. Return `null`.
  - `checkStart` is synchronous, so peek and commit cannot interleave with another request. A request that is admitted here but then fails in the route (for example a 400 from `createGame`) has still been counted; that is accepted, since such a request is itself rate limited and cannot be produced by a full arena.
- The guard only admits or denies. It never rewrites `seed`, `seatModels` or any other input (invariant 2).
- `describeGuard`: `authorized = isAdmin(...)`. With `allowed = authorized || mode === "open"`: `canSeatRealModels = allowed`, `canStartTournaments = allowed`, `canStartGames = allowed || mode === "bots"`. `realModels = modelIds.filter(isReal)`. `lockedModels = canSeatRealModels ? [] : realModels`.
- `readJsonBody`: if the `content-length` header parses to a number above `MAX_BODY_BYTES`, return the denial without reading. Otherwise `text = await req.text()`; if `Buffer.byteLength(text) > MAX_BODY_BYTES` return the denial `413 body_too_large`, `"Request body too large."`. Otherwise `JSON.parse`, and on a parse error or a non-object result use `{}` (today's behaviour). Always on.
- `denied(d)`: `new Response(JSON.stringify({ error: d.error, code: d.code }), { status: d.status, headers })` with `content-type: application/json` and `retry-after` when `retryAfterSec` is set.
- `trackGame`: increments `inflight`, decrements in `finally`.

With no env set: mode is `open`, every limit is null, and `checkStart` returns `null` for every input.

## 7. Tournaments: `src/lib/tournaments/run.ts`

```ts
const tg = globalThis as unknown as { __amongLlmsTournaments?: Set<string> };
const active: Set<string> = (tg.__amongLlmsTournaments ??= new Set());

export function runningTournaments(): number { return active.size; }

/** Boot-time: tournaments left "running" by a dead process can never progress. */
export async function abandonOrphanedTournaments(s: Store = store): Promise<string[]>;
```

- `createTournament` reserves its slot synchronously, before its first `await`, so two concurrent POSTs cannot both pass `ARENA_MAX_TOURNAMENTS` and the boot reconcile can never see a saved `running` tournament whose id is not yet in `active`. No signature change (`id` is already generated before any await):

  ```ts
  const config = buildTournamentConfig(input);
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  active.add(id);
  try {
    // existing body, unchanged: createdAt, getLeaderboard, build tournament, saveTournament
  } catch (err) {
    active.delete(id);
    throw err;
  }
  void runTournament(id).catch(() => {}).finally(() => active.delete(id));
  return { id };
  ```

  `buildTournamentConfig` stays before the reservation so a config error leaves nothing to undo. Nothing in `runGame`, `runTournament` or `schedule.ts` changes.
- `abandonOrphanedTournaments`: for each summary in `s.listTournaments(200)` with `status === "running"` and an id not in `active`: `getTournament`, skip if null or no longer `running`, set `status = "abandoned"`, `saveTournament`. Returns the ids it changed. Uses only `Store` methods, so writes stay serialized.

`src/instrumentation.ts` (Next 15 calls `register()` once per server start, no config flag):

```ts
export async function register() {
  // Positive block, not an early return: Next also compiles this file for the
  // edge runtime and only drops the node-only imports when they sit inside it.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Hosted deployments only, so a local dev restart behaves as it always has.
    if (process.env.ARENA_DATA_DIR?.trim()) {
      const { abandonOrphanedTournaments } = await import("./lib/tournaments/run");
      const { readGuardConfig } = await import("./lib/guard");
      for (const w of readGuardConfig().warnings) console.warn(`[arena] ${w}`);
      await abandonOrphanedTournaments().catch((e) => console.warn("[arena] reconcile failed", e));
    }
  }
}
```

No static import may appear in this file. Task 8 runs `npm run build` and checks the output for edge-runtime warnings or `node:` scheme errors. If the build still complains, move the inner block into `src/instrumentation.node.ts` (exporting one async function) and `await import("./instrumentation.node")` from inside the `NEXT_RUNTIME === "nodejs"` branch.

## 8. API contracts

Shared shape of every guard denial: HTTP status from `Denial.status`, body `{ "error": string, "code": string }`, plus a `Retry-After` header (seconds) on 429 and 503. Both forms already display `data.error`.

### `POST /api/games`

```ts
export async function POST(req: Request) {
  const parsed = await readJsonBody(req);
  if ("denial" in parsed) return denied(parsed.denial);
  const input = parsed.body as CreateGameInput;
  try {
    const d = checkStart(
      req,
      { kind: "game", seatModels: buildConfig(input).seatModels },
      { games: listRunning().length + inflightGames(), tournaments: runningTournaments() }
    );
    if (d) return denied(d);
    const transcript = await trackGame(createGame(input));
    return NextResponse.json({ id: transcript.id, transcript }, { status: 201 });
  } catch (err) { /* existing 400 { error } */ }
}
```

Classification uses `buildConfig(input).seatModels` so it sees exactly what the brain factory will see after the unknown-to-`"mock"` coercion. `createGame` builds its own config again; only the unseeded random seed can differ, and the guard does not look at it. Success response unchanged.

### `POST /api/games/live`

Same sequence, then `createLiveGame(input)` and the unchanged `202 { id, live: true }`. No `trackGame` (the live registry already counts it). The whole body is now inside a try that returns `400 { error }`; today a throw is an unhandled 500. `GET` unchanged.

### `POST /api/tournaments`

`readJsonBody`, then `checkStart(req, { kind: "tournament" }, { games: listRunning().length + inflightGames(), tournaments: runningTournaments() })`, then the existing `createTournament` call and `201 { id }`. `GET` unchanged. There is no `await` between `checkStart` and the synchronous `active.add` inside `createTournament` (section 7), so the cap holds under concurrent requests.

### `GET /api/models`

Signature becomes `GET(req: Request)`. Response: `{ models: ModelInfo[], guard: GuardInfo }` with `guard = describeGuard(req, models.map((m) => m.id))`. `models` is unchanged.

### `GET /api/games/[id]/stream`

Three changes; the happy path bytes are otherwise unchanged (`delayFor`, the `meta` frame, event frames and pacing stay as they are).

1. Teardown that cannot leak or throw. Hoist the shared state out of `start()` so `cancel()` can reach it, and route every write through one guarded helper:

   ```ts
   let closed = false;
   let ending = false;
   let tailing = false;                       // true only on the live-registry path
   let unsub = () => {};
   let ping: ReturnType<typeof setInterval> | undefined;
   let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;

   const safeClose = () => {
     if (closed) return;
     closed = true;
     clearInterval(ping);
     unsub();                                  // idempotent
     try { ctrl?.close(); } catch { /* already closed or errored */ }
   };
   // A throw from enqueue means the consumer is gone; never let it escape a timer.
   const send = (chunk: string) => {
     if (closed) return;
     try { ctrl!.enqueue(enc.encode(chunk)); } catch { safeClose(); }
   };
   const sendEnd = (reason: "not_found" | "abandoned") => {
     if (closed || ending) return;
     ending = true;
     unsub();
     send(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
     setTimeout(safeClose, 60);                // same flush delay as after game_over
   };

   const stream = new ReadableStream<Uint8Array>({
     async start(controller) { ctrl = controller; /* ... */ },
     cancel() { safeClose(); },
   });
   ```

   - `sendMeta` and `write` become one-line calls to `send` with today's exact frame strings.
   - `cancel()` covers a consumer that goes away without `req.signal` firing. The existing abort listener stays and calls `safeClose()`.
   - `await getGame(id)` is wrapped in try/catch. On a throw (possible now that a strict `ARENA_DATA_DIR` makes store calls reject) call `safeClose()` and return, without `end`: a transient store error must not be shown to the viewer as not found or interrupted, and `EventSource` will retry.
   - `drain()` checks `ending` alongside `closed` in its loop condition and in its exhausted branch.
2. Terminal event. `sendEnd` is called in these cases, and always closes 60 ms later rather than immediately:
   - the id is neither live nor persisted (`not_found`);
   - in `drain()`'s exhausted branch, when `getLive(id)?.status === "abandoned"` (`abandoned`). When the live entry is missing or `finished`, `safeClose()` without `end`, as today;
   - in the live branch, after the replay-buffer loop, when `live.status === "abandoned"` and nothing was queued (`abandoned`). Today that case never closes;
   - from the heartbeat tick (below), which is the only thing that can notice a game that became `abandoned` while this viewer's queue was already empty.
3. Heartbeat, created at the top of `start` and cleared in `safeClose`. Set `tailing = true` in the live branch only, so a slow `getGame` on the persisted path is never cut short by the tick:

   ```ts
   ping = setInterval(() => {
     send(": ping\n\n");
     if (closed || ending || !tailing || draining || queue.length > 0) return;
     const g = getLive(id);
     if (g?.status === "abandoned") sendEnd("abandoned");
     else if (!g || g.status !== "running") safeClose();   // nothing more can arrive
   }, 20_000);
   ```

   SSE comments are ignored by `EventSource`; the ping keeps quiet real-model games (one LLM call can take 45 s) alive through proxy idle timeouts. Because it also keeps dead streams alive, the tick is what ends them.

### `GET /api/health` (new)

`runtime = "nodejs"`, `dynamic = "force-dynamic"`. Not rate limited.

```ts
interface HealthResponse {
  ok: boolean;
  persistent: boolean;            // false when the tmp fallback is in use
  liveGames: number;              // listRunning().length + inflightGames()
  tournaments: number;            // runningTournaments()
  mode: PublicMode;
  adminConfigured: boolean;
  warnings: string[];
}
```

Status 200 when `fileStore.health()` reports `writable: true`, else 503 with `ok: false`. It never includes paths, env values or the token. Add one extra warning, computed in the route, when `mode === "open"`, `ARENA_DATA_DIR` is set and at least one model in `listModels()` has a provider config: `"Real models are configured and ARENA_PUBLIC_MODE is open: anyone can spend your API keys."`

All other GET routes are unchanged and unguarded.

## 9. UI

### `src/lib/ui.ts`

```ts
export const ADMIN_TOKEN_KEY = "arena-admin-token";
/** Bearer header if the operator saved a token in this browser; {} otherwise and during SSR. */
export function adminHeaders(): Record<string, string>;
```

`adminHeaders` returns `{}` when `typeof window === "undefined"`, when `localStorage` throws, or when the stored value is empty; otherwise `{ authorization: "Bearer " + value }`.

### `src/components/AdminTokenField.tsx` (new, client)

Props: `{ onChange: () => void }`. Renders a label "Admin token", an `<input type="password" autoComplete="off">` initialised from `localStorage[ADMIN_TOKEN_KEY]`, and a small "Unlock" button. On submit it writes the trimmed value (or removes the key when empty) and calls `onChange`. All `localStorage` access is in try/catch. Styling matches the tournament name input (`bg-[var(--panel-2)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm`).

### `NewGameForm.tsx`

- State `guard: GuardInfo | null`. Extract the models fetch into `loadModels()`, which calls `fetch("/api/models", { headers: adminHeaders() })` and stores both `models` and `guard`. On fetch failure `guard` stays `null`, which the form treats as fully open (the server remains the authority).
- A chip whose id is in `guard.lockedModels` renders dimmed (`opacity-50 cursor-not-allowed`), with a `🔒` prefix, `aria-disabled`, `title="Operator only — real models cost the host money"`, and `toggle` ignores it. After each `loadModels`, remove locked ids from `selected` (falling back to `["mock"]`).
- When `guard?.adminConfigured && !guard.authorized`, render `<AdminTokenField onChange={loadModels} />` under the chips.
- When `guard && !guard.canStartGames`, replace both start buttons with the line "This arena is view-only. Watch the latest games below."
- The POST adds `...adminHeaders()` to its headers. The existing `error` line shows 401/403/429/503 messages.
- Blocking run on a hosted arena. `POST /api/games` sends no bytes until the game ends, and a hosting proxy cuts an idle response at about 60 s, so a real-model game would show a network error although it finishes and is rated. When `guard && guard.mode !== "open"` and some id in `selected` is in `guard.realModels`, disable the "▶ Run a match" button with `title="Real-model games take minutes — use Watch live"`. "📡 Watch live" stays enabled. No server change.
- Hide the "Add an API key… in .env" hint when `guard?.mode !== "open"` and `guard` is not null.

### `NewTournamentForm.tsx`

- Same `loadModels` and `adminHeaders()` on the POST.
- When `guard && !guard.canStartTournaments`: replace the submit button with the text "Tournaments are run by the arena operator." and, when `guard.adminConfigured`, `<AdminTokenField onChange={loadModels} />`.

### `LiveGame.tsx`

- New state `interrupted: boolean`.
- `es.addEventListener("end", …)`: clear the timeout, `es.close()`. Parse `data.reason`. If `meta` was never received and the reason is `not_found`, `setNotFound(true)`; otherwise `setInterrupted(true)`.
- When `interrupted`, render (checked after `notFound`, before the "Connecting" branch) a `glass p-12 text-center space-y-3` panel: title "Match interrupted", text "The server restarted mid-game, so this match wasn't finished or rated.", and a "Back to the arena" link styled like the not-found panel.

### `TournamentView.tsx`

Add one badge beside the existing two: `{t.status === "abandoned" && <span className="chip">✕ interrupted</span>}`.

With no env set the server returns `mode: "open"`, `adminConfigured: false`, empty `lockedModels`, so none of the new UI renders.

## 10. Backward compatibility

- No env set: `checkStart` returns `null`, the data dir resolves as today, there is no standalone output, the boot hook returns immediately, and no new UI renders.
- Always-on changes (all additive or protective):
  1. Store writes go through tmp plus rename, producing the same bytes, with a direct-write fallback.
  2. The store lock and resolved dir live on `globalThis`. `summarize` and `summarizeTournament` live in `store/summary.ts` and are re-exported from `store/index.ts` under the same names.
  3. The SSE stream may emit a named `end` event and `: ping` comments. Old clients ignore both. A stream whose game can produce no more events is now closed within 20 s instead of staying open.
  4. POST bodies over 64 KB get 413. A legitimate start request is under 1 KB.
  5. `POST /api/games/live` returns 400 instead of an unhandled 500 when input handling throws.
  6. `GET /api/models` has an extra `guard` field.
- Persisted data: no schema change. Existing `data/games/*.json`, `index.json`, `leaderboard.json`, `tournaments/*.json` and `tournaments-index.json` load as before; legacy leaderboards are still normalized by `elo.ts`.
- Existing 129 tests: no existing test file is edited, and no function they call changes signature or behaviour.

## 11. Store adapter decision: not now

1. Live mode and the tournament runner already require one long-lived process, and every host that can run that can mount a volume. A remote store removes no constraint.
2. `updateLeaderboard(updater)` takes a JS closure and is correct only because of the in-process lock. A fetch-only remote KV needs compare-and-swap retry loops for the leaderboard and both indexes, which is exactly where the two historical lost-update bugs were (invariant 7).
3. Without the real service it could only be tested against a hand-written fake of its HTTP API.
4. The durability risks that matter are in the file store and are fixed here: silent tmp fallback, non-atomic writes, no health signal.

The seam stays open: `Store` is one interface and `store` is one line in `src/lib/store/index.ts`. `fileStore.test.ts` exercises the store only through a `makeStore(): Store` helper, so a future adapter can reuse the same cases.

## 12. Deployment files

### `next.config.mjs`

```js
const nextConfig = {
  reactStrictMode: true,
  // Type errors still fail the build; we just don't require an ESLint config.
  eslint: { ignoreDuringBuilds: true },
  // Opt-in: standalone needs symlinks, which break plain Windows builds.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" } : {}),
  outputFileTracingExcludes: { "*": ["./data/**"] },
};
```

Standalone is safe for this app: no `public/`, no native runtime dependencies, the only server filesystem access is `fileStore.ts` on a runtime path, and provider calls are plain `fetch`. The standalone `server.js` changes directory to its own folder, which is why the image sets `ARENA_DATA_DIR` explicitly. If `next build` rejects the `outputFileTracingExcludes` key on 15.1.6, drop it; `.dockerignore` already keeps `data/` out of the image.

### `Dockerfile`

```dockerfile
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 HOSTNAME=0.0.0.0 \
    ARENA_DATA_DIR=/data ARENA_PUBLIC_MODE=bots
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
```

- `HOSTNAME=0.0.0.0` is required: Docker sets `HOSTNAME` to the container id and the standalone server binds to it.
- The container runs as root because Fly volumes mount root-owned. `docs/DEPLOY.md` states this trade-off.
- `NEXT_PUBLIC_GITHUB_URL` is inlined at build time; `docs/DEPLOY.md` notes it must be supplied as a build arg if wanted (add `ARG NEXT_PUBLIC_GITHUB_URL` and `ENV NEXT_PUBLIC_GITHUB_URL=$NEXT_PUBLIC_GITHUB_URL` to the build stage).

### `.dockerignore`

```
node_modules
.next
.git
data
docs
.env
.env.*
!.env.example
*.tsbuildinfo
.remember
.playwright-mcp
Dockerfile
fly.toml
```

### `fly.toml`

```toml
app = "CHANGE-ME"
primary_region = "CHANGE-ME"

[env]
  ARENA_IP_HEADER = "fly-client-ip"
  ARENA_RATE_LIMIT = "6"
  ARENA_DAILY_GAMES = "2000"
  ARENA_MAX_GAMES = "4"
  ARENA_MAX_TOURNAMENTS = "1"

[mounts]
  source = "arena_data"
  destination = "/data"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"      # live games and tournaments live in this process
  auto_start_machines = false
  min_machines_running = 1

  [http_service.concurrency]
    type = "connections"
    soft_limit = 400
    hard_limit = 500              # bounds open SSE streams without app code

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "20s"
    method = "GET"
    path = "/api/health"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

### `.env.example`

Append a commented block headed `# --- Public hosting (all optional; see docs/DEPLOY.md) ---` listing every `ARENA_*` variable from section 3 with a one-line description each.

### `docs/DEPLOY.md` (content to write)

1. **What you are deploying.** One container, one persistent volume, exactly one instance. Why not serverless: the file store, the live registry and the tournament runner all live in one Node process.
2. **Before you start.** Fly.io is a paid host and needs a billing account. Set a hard spend limit on each provider API key as the last line of defence.
3. **Local smoke test** (needs Docker):
   - `docker build -t among-llms .`
   - `docker run --rm -p 3000:3000 -v among-llms-data:/data -e ARENA_ADMIN_TOKEN=<32+ random chars> among-llms`
   - `curl http://localhost:3000/api/health` returns `{"ok":true,"persistent":true,…}`.
4. **Fly.io procedure:**
   1. Install `flyctl`; `fly auth login`.
   2. Edit `app` and `primary_region` in `fly.toml`.
   3. `fly launch --no-deploy --copy-config`
   4. `fly volumes create arena_data --size 1 --region <region>`
   5. Generate a token with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (works in PowerShell, cmd and Git Bash; `openssl` is not on PATH in PowerShell), then `fly secrets set ARENA_ADMIN_TOKEN=<that value>`. Save the token in a password manager. Optionally also set `OPENAI_API_KEY`, `OPENAI_MODELS`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODELS`.
   6. `fly deploy --ha=false`
   7. `fly scale count 1`. Never run more than one machine.
   8. Verify: `curl https://<app>.fly.dev/api/health` returns `ok: true`, `persistent: true`, `mode: "bots"`, `adminConfigured: true`, and an empty `warnings` list.
   9. Verify the guard: a `POST /api/games/live` with body `{"seatModels":["<a real model id>"]}` returns 401 without the header and 202 with `Authorization: Bearer <token>`; a bot game returns 202 without a token; the seventh bot start inside a minute returns 429.
   10. Open the site, paste the token into "Admin token", and seat a real model.
5. **Environment reference.** The table from section 3.
6. **Warning.** Provider keys with `ARENA_PUBLIC_MODE=open` let anyone spend them. The image defaults to `bots`. Include the `open`-mode caveat from section 3: there `ARENA_MAX_GAMES` does not cover tournament games and `ARENA_DAILY_GAMES` counts a tournament as 1.
7. **Operations.**
   - A redeploy ends running live games (viewers see "Match interrupted") and marks running tournaments as interrupted. Finished games, the leaderboard and finished tournaments are intact. Do not deploy during a tournament you care about.
   - Real-model games must be started with "Watch live". The blocking "Run a match" request sends nothing until the game ends, and Fly's proxy cuts an idle response at about 60 s; the game would still finish and be rated, but the browser shows a network error. The form disables that button for real models on a hosted arena.
   - Backup, in two steps so no binary data passes through a shell redirect (PowerShell's `>` corrupts it): `fly ssh console -C "tar czf /tmp/backup.tgz /data"`, then `fly ssh sftp get /tmp/backup.tgz`. Also `fly volumes snapshots list`.
   - Rotate the token with `fly secrets set ARENA_ADMIN_TOKEN=…`.
   - Disk: transcripts are never deleted. Watch volume usage and lower `ARENA_DAILY_GAMES` or extend the volume as needed.
   - The container runs as root because the volume is root-owned.
   - Ollama is not reachable from Fly unless you host it.
8. **Other hosts** (Railway, Render, a VPS). The same image; mount a volume at `/data`; set `ARENA_IP_HEADER` to that proxy's client-IP header; run one instance.
9. **Troubleshooting.**
   - Health 503: the volume is not mounted or not writable.
   - Everyone is rate-limited together: `ARENA_IP_HEADER` is unset or wrong.
   - `Cannot find module …linux-x64-gnu` during build: regenerate `package-lock.json` with `npm install` on any machine.

### `README.md`

- Replace the "Deploying" section (it says "Deploys to Vercel … as-is", which is wrong for live mode and tournaments) with "Hosting a public arena": two sentences on the single container plus volume, the `docker build` / `docker run` quick start, a three-row table of `ARENA_PUBLIC_MODE` values, and a link to `docs/DEPLOY.md`.
- Roadmap: change "A public hosted arena" to "A public hosted arena (deploy-ready: see docs/DEPLOY.md)".
- Update the three "129" test counts (badge, feature bullet, Testing paragraph) to the real count after task 12.

## 13. Tests to add

All Vitest, beside source, no network. The new store and tournament tests never rely on the default `store` export except where test 5 of `run.test.ts` says so. Requests are plain `new Request("http://x/", { headers })`. Env is passed through the `env` option, never by mutating `process.env`, except where stated.

**`src/lib/guard.test.ts`** (`resetGuardState()` in `beforeEach`; `isReal = (id) => id === "gpt-x"`)

1. Empty env: `readGuardConfig({})` is mode `open`, all limits null, no warnings; `checkStart` returns null for a real-model game and for a tournament, 100 times in a row.
2. Token only (16+ chars): mode `bots`. Short token: hash null, mode `bots`, one warning. Invalid `ARENA_PUBLIC_MODE`: `bots` plus a warning. `ARENA_RATE_LIMIT=abc` and `=-1`: null plus a warning.
3. `isAdmin`: false with no token configured; false for a missing, malformed or wrong header; true for the exact Bearer token; scheme is case-insensitive.
4. Policy matrix for modes `open`, `bots`, `off` × bot game, mixed game, tournament × admin or not. `bots` without admin: bot game null, mixed game 401, tournament 401. Same with no token configured: 403. `off`: 403 or 401 for every kind; admin passes everything.
5. `hitRateLimit`: allows `limit` hits, denies the next with `retryAfterSec` between 1 and 60, allows again after the window, keys are independent, and expired buckets are pruned once the map exceeds 10 000 keys. `peekRateLimit` alone never changes the map (deep-equal before and after, including on a denial).
5a. Pruning does not reset the daily budget: with `ARENA_DAILY_GAMES=1`, admit one game at `now = 0`; then `commitRateLimit(guardBuckets(), "ip:" + i, 120_000, 60_000)` for 10 001 distinct `i`; a further game at `now = 120_000` is still `429 budget_exhausted`.
6. `ARENA_RATE_LIMIT=2` with `ARENA_IP_HEADER=fly-client-ip`: the third request from one IP is 429 with `retryAfterSec`; another IP passes; admin is exempt.
7. `clientKey`: `"shared"` when no header is configured, even if `x-forwarded-for` is present; reads the named header; takes the last comma entry, trimmed.
8. `ARENA_DAILY_GAMES=2` in `open` mode: a game then a tournament are admitted, the third non-admin start of either kind is `429 budget_exhausted`; admin starts do not consume it; it resets after 24 h of `now`.
9. Caps: `ARENA_MAX_GAMES=1` with `load.games = 1` gives `503 busy`, including for admin; `load.games = 0` passes. Same for `ARENA_MAX_TOURNAMENTS`.
9a. Denials consume nothing: with `ARENA_MAX_GAMES=1`, `ARENA_DAILY_GAMES=1` and `ARENA_RATE_LIMIT=1`, three calls with `load.games = 1` are all `503 busy`; a fourth with `load.games = 0` is admitted; a fifth is denied. Separately, with `ARENA_DAILY_GAMES=1` and `ARENA_RATE_LIMIT=5`: after the budget is spent, two `budget_exhausted` denials leave the caller's `ip:` bucket in `guardBuckets()` at `count` 1.
10. `trackGame`: `inflightGames()` is 1 while pending, 0 after resolve, 0 after reject.
11. `describeGuard`: open mode gives all `can*` true and empty `lockedModels`; `bots` without auth gives `canStartGames` true, the other two false, `lockedModels` equal to `["gpt-x"]`; with the token everything is true and `lockedModels` is empty. `realModels` is `["gpt-x"]` in all three cases.
12. `readJsonBody`: valid JSON object returned; malformed JSON gives `{}`; a 70 000-byte body gives the 413 denial; a `content-length` above the cap is denied.
13. `denied`: status, JSON body `{ error, code }`, and `retry-after` header.

**`src/lib/guard.wiring.test.ts`**

1. Walk `src/app/api` recursively with `node:fs`. Every `route.ts` whose text matches `/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/` must contain `checkStart(` and `readJsonBody(`. Assert at least three such files exist.

**`src/lib/store/fileStore.test.ts`** (the first import is `./fileStore`, deliberately before anything that loads `./index`, to pin the cycle fix; each test uses `fs.mkdtemp(path.join(os.tmpdir(), "arena-"))`, `makeStore = () => createFileStore({ dir })`, and removes the dir afterwards)

1. `pickDataDir({}, "/x")` gives `path.join("/x", "data")`, `explicit: false`. `pickDataDir({ ARENA_DATA_DIR: "/vol" })` gives `path.resolve("/vol")`, `explicit: true`. Whitespace-only counts as unset.
2. Round trip: `saveTranscript` of a transcript produced by `simulate` with mock brains and a fixed seed, then `getTranscript` deep-equals it, `listSummaries` has one entry, and the files `games/<id>.json` and `index.json` exist.
3. No file ending in `.tmp` remains anywhere under the dir after 10 saves.
4. 20 concurrent `updateLeaderboard` calls that each increment a counter end at 20 (invariant 7 pin).
5. Strict dir: `createFileStore({ dir: path.join(<a regular file>, "sub") })`: `getLeaderboard()` rejects, `health()` returns `{ writable: false, persistent: false }`, and nothing was created under `os.tmpdir()/among-llms-data` by this call (compare `fs.stat` mtime before and after, or skip the assertion if the dir did not exist before and still does not).
6. `health()` on a good dir returns `{ writable: true, persistent: true }` and leaves no probe file.
7. Legacy load: hand-write `games/old1.json` without `disabledRoles` and `leaderboard.json` whose entries lack `asJester` and `history`; `getTranscript("old1")` and `getLeaderboard()` return them.
8. `getTranscript("../x")` returns null.
9. Saving 205 distinct summaries keeps `listSummaries(500)` at 200.
10. Import order: with `./fileStore` imported first at the top of the file, `(await import("./index")).store` is defined and has a `saveTranscript` function, and `(await import("./index")).summarize` is a function. Only identity is asserted; `store` is never called.
11. Stale tmp cleanup: pre-create `games/x.json.1.0.tmp` and `leaderboard.json.1.0.tmp` in the temp dir, make the first store call (`getLeaderboard()`), and assert both are gone while a pre-created `games/keep.json` is still there.

**`src/lib/tournaments/run.test.ts`** (store from `createFileStore({ dir: tmp })`)

1. Save a `Tournament` with `status: "running"` built from `buildRoundRobin` with a bots-only roster. `abandonOrphanedTournaments(s)` returns `[id]`; `getTournament` then has `status: "abandoned"`; `listTournaments` shows `abandoned`.
2. A `finished` tournament is untouched.
3. A second call returns `[]`.
4. `runningTournaments()` is 0 when nothing was started.
5. Synchronous reservation: call `createTournament` twice with bots-only rosters without awaiting; `runningTournaments()` is 2 on the next line. Then await both and poll until `runningTournaments()` is 0. `createTournament` uses the default `store`, so this one test sets `process.env.ARENA_DATA_DIR` to a temp dir in `beforeAll`, deletes `globalThis.__amongLlmsStore` and `globalThis.__amongLlmsTournaments`, loads `./run` with `await import` after `vi.resetModules()`, and in `afterAll` restores the env and deletes both globals again. Nothing is written to the repo's `data/`.

Manual checks, recorded in `docs/DEPLOY.md`: `curl -N http://localhost:3000/api/games/doesnotexist/stream` prints an `event: end` frame with `{"reason":"not_found"}` and then exits (also run in task 6 against `npm run dev`); the container smoke test; SSE events arrive incrementally through the container; restarting the container during a real-model live game shows "Match interrupted"; restarting during a tournament shows the interrupted badge.

## 14. Ordered tasks

Each task is one commit. After every task run `npm test` and `npx tsc --noEmit`; both must be green before moving on.

1. `store/summary.ts` and the `index.ts` re-export (cycle fix) first; then `fileStore.ts`: `pickDataDir`, `createFileStore`, `globalThis` state, strict explicit dir, atomic `writeJson`, stale `.tmp` cleanup, `health()`. Add `fileStore.test.ts`.
2. `guard.ts` and `guard.test.ts`.
3. `run.ts`: the active set with synchronous reservation in `createTournament`, `runningTournaments`, `abandonOrphanedTournaments`. Add `run.test.ts`.
4. Wire the three POST routes (`readJsonBody`, `checkStart`, `denied`, `trackGame`). Add `guard` to `GET /api/models`. Add `guard.wiring.test.ts`.
5. `GET /api/health`.
6. Stream route: hoisted teardown with `cancel()`, guarded `send`, `end` event, heartbeat. `LiveGame.tsx`: `end` listener and interrupted panel. Run the `curl -N` not-found check from section 13, and watch one live bot game to the end to confirm the happy path is unchanged.
7. `ui.ts` `adminHeaders`, `AdminTokenField.tsx`, `NewGameForm.tsx`, `NewTournamentForm.tsx`, the `TournamentView.tsx` badge.
8. `src/instrumentation.ts`. Then run `npm run build` (no env set) and confirm it succeeds with no "not supported in the Edge Runtime" warning and no `node:` scheme error; apply the `instrumentation.node.ts` fallback from section 7 if it does not.
9. `next.config.mjs`, `Dockerfile`, `.dockerignore`, `fly.toml`, `.env.example`.
10. `docs/DEPLOY.md` and the README section and roadmap line.
11. Where Docker is available: `docker build`, `docker run` with a volume, the health curl, and the manual checks in section 13. If Docker is not available, say so in the final report and leave this task open; do not claim the image works.
12. Final verification, in this order:
    - `npm test`: the 129 existing tests plus the new ones pass. Put the real total in the README.
    - `npx tsc --noEmit`: clean.
    - `npm run build` with no env set: succeeds and produces no `.next/standalone`.
    - `npm run dev` with no env set: start a bot game, a live bot game and a bots-only tournament from the UI; confirm no token field, no locked chips, and that the pre-existing `data/` games and leaderboard still render.
    - With `ARENA_ADMIN_TOKEN=<16+ chars>` in `.env.local` and one real provider configured (Ollama is enough): real chips are locked, a real-model POST without the header returns 401, pasting the token unlocks them.

## 15. Open risks

- The Dockerfile, `fly.toml` and the `flyctl` flags (`--copy-config`, `--ha=false`) were not run; Docker is not installed on the development laptop.
- `Fly-Client-IP` is assumed to be set by Fly's proxy and not client-controllable. If that is wrong the per-IP limit is spoofable; the daily budget and caps still hold.
- The edge-compile behaviour of `src/instrumentation.ts` was not verified by a build while writing this spec; task 8 checks it and section 7 gives the fallback.
- `src/instrumentation.ts` under Next 15.1.6 standalone is assumed to run `register()` once at server start. The function it calls is unit-tested; the hook itself is only covered by the manual restart check.
- `outputFileTracingExcludes` as a top-level key is assumed valid on 15.1.6 (fallback in section 12).
- Standalone builds on Windows can fail on symlink creation, which is why it is opt-in and only used inside the Linux image.
- In `open` mode tournament games are outside `ARENA_MAX_GAMES` and a tournament costs 1 against `ARENA_DAILY_GAMES` (section 3). Charging per scheduled game was not done because a knockout's game count is not known at creation and `run.ts` game execution is out of scope.
- A request admitted by `checkStart` that then fails with 400 has still used one rate-limit slot and one daily-budget slot.
- The stale `.tmp` cleanup assumes one process per `ARENA_DATA_DIR`. Two processes on one volume are unsupported anyway (the store lock is in-process).
- The 60 ms delay before closing after `end` copies the existing `game_over` delay; whether an immediate close can drop the last chunk was not measured. The `curl -N` check in task 6 covers the not-found case.
- The 60 s proxy idle cut on the blocking `POST /api/games` is Fly's documented behaviour, not measured here; the form change and the DEPLOY note avoid it rather than fix it.
- Transcripts are never pruned. Average transcript size was not measured; `ARENA_DAILY_GAMES=2000` and a 1 GB volume are starting values to adjust after measuring.
- `readJsonBody` buffers a chunked body before measuring it; a platform request-size limit is the real defence against very large uploads.
- Tournament rosters still accept arbitrary ids (existing behaviour). In `bots` and `off` mode only the admin can start tournaments; in `open` mode a visitor can add made-up names to the leaderboard.
- There is no limit on failed admin-token attempts. A 32-byte random token makes guessing impractical; a short hand-picked token would not be safe.
- A corrupt (not merely missing) `leaderboard.json` or index is still read as empty and overwritten, as today. Atomic writes remove the known cause.
