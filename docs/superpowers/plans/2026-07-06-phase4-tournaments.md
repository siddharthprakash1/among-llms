# Among LLMs v2 — Phase 4: Tournaments & Model Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tournament orchestrator (round-robin seasons + knockout brackets, configurable parallelism) with live-updating tournament pages, plus per-model profile pages (Elo sparkline, deception/detection/vote-accuracy, per-role record, head-to-head, recent games).

**Architecture:** Transcripts stay the single source of truth. Pure, seeded scheduling/standings/bracket math in `src/lib/tournaments/`; an in-process orchestrator runs games through the existing `createGame()` seam with a concurrency cap; tournament state persists to `tournaments.json` under the store's existing mutex; profile stats derive from stored transcripts + the Phase-1 Elo history. UI polls while running.

**Tech Stack:** TypeScript, Next.js 15 App Router, Vitest. No new dependencies (sparkline = inline SVG).

## Global Constraints

- Determinism: game seeds derive deterministically from the tournament seed (`mixSeed` below); same tournament config + seed ⇒ same game seeds. (Game outcomes also depend on brains, as everywhere.)
- Zero-config: tournaments must work fully offline with mock/bot models.
- Transcripts are the source of truth; profile aggregates are derived on read (cached per-request only), recomputable at any time.
- `concurrency` default 1; UI warns above 1 that local (Ollama) models may thrash.
- Store writes go through the existing in-process mutex pattern (`withLock` in src/lib/store/fileStore.ts).
- Legacy leaderboard entries may lack `asJester`/`history` — every read path added in this phase must normalize (`?? {games:0,wins:0}` / `?? []`).
- SHARED WORKING TREE: another session works this repo (Phase 3 in flight: werewolf.ts, live runner, stream routes, ReplayPlayer). Do NOT modify: src/lib/engine/werewolf.ts, src/components/ReplayPlayer.tsx, src/components/Scene3D.tsx, src/lib/sound.ts, src/components/Ambience.tsx, src/app/globals.css, src/app/layout.tsx. Stage commits ONLY by explicit path. Never `git add -A`, never stash.
- Table sizes 5–12; model roster 2–12 entries.
- Run tests with `npm test`; single file: `npx vitest run <path>`.

---

### Task 1: Tournament types + pure scheduling/standings/bracket math

**Files:**
- Create: `src/lib/tournaments/types.ts`
- Create: `src/lib/tournaments/schedule.ts`
- Test: `src/lib/tournaments/schedule.test.ts`

**Interfaces produced (used by all later tasks):**

`types.ts` (verbatim):

```ts
// Tournament domain types. State is persisted as plain JSON in the store;
// all math over it lives in schedule.ts as pure functions.

import { ToggleableRole, Winner } from "../engine/types";

export type TournamentFormat = "round_robin" | "knockout";
export type TournamentStatus = "running" | "finished" | "abandoned";
export type TournamentGameStatus = "pending" | "running" | "finished";

export interface TournamentConfig {
  name: string;
  format: TournamentFormat;
  /** Model ids competing (2–12, deduped). */
  roster: string[];
  /**
   * round_robin: number of season rounds (each round = one game per roster
   * rotation). knockout: best-of-N games per match (odd, 1–7).
   */
  gamesPerRound: number;
  numPlayers: number; // table size 5–12
  concurrency: number; // parallel games, default 1
  seed: number; // base seed; per-game seeds derived via mixSeed
  disabledRoles?: ToggleableRole[];
}

export interface TournamentGameRef {
  /** Stable key within the tournament (e.g. "r0g2" or "m3g1"). */
  key: string;
  seed: number;
  seatModels: string[];
  status: TournamentGameStatus;
  gameId?: string; // set once created
  winner?: Winner;
  /** Seat-win count per roster model in this game (attribution for scoring). */
  modelWins?: Record<string, number>;
}

export interface KnockoutMatch {
  key: string; // "m<round>-<index>"
  a: string | null; // model id; null = TBD (or bye slot)
  b: string | null;
  games: TournamentGameRef[];
  winner?: string; // model id
}

export interface Tournament {
  id: string;
  createdAt: string;
  status: TournamentStatus;
  config: TournamentConfig;
  /** round_robin: flat list of rounds, each a list of games. */
  rounds?: TournamentGameRef[][];
  /** knockout: bracket[roundIdx][matchIdx]. */
  bracket?: KnockoutMatch[][];
}

export interface StandingRow {
  model: string;
  games: number;
  wins: number; // games where this model had at least one winning seat
  seatWins: number; // total winning seats (tiebreak)
}
```

`schedule.ts` — pure functions (verbatim signatures; implement exactly):

```ts
import { KnockoutMatch, StandingRow, Tournament, TournamentConfig, TournamentGameRef } from "./types";
import { SeatOutcome, Transcript } from "../engine/types";

/** Deterministic 32-bit mix of tournament seed + coordinates (same imul style as brains.ts). */
export function mixSeed(base: number, a: number, b: number): number {
  let h = base >>> 0;
  h = (Math.imul(h ^ (a + 1), 2654435761) + Math.imul(b + 1, 40503)) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 2246822519) >>> 0;
  return h >>> 0;
}

/** Seat assignment for round-robin game g of round r: roster rotated so every model cycles through seats/counts. */
export function roundRobinSeats(roster: string[], numPlayers: number, round: number, game: number): string[] {
  const seats: string[] = [];
  const offset = (round * 7 + game * 3) % roster.length;
  for (let i = 0; i < numPlayers; i++) seats.push(roster[(offset + i) % roster.length]);
  return seats;
}

/** Head-to-head seats for a knockout game: a/b alternate, remaining seats filled with "mock" bots. */
export function knockoutSeats(a: string, b: string, numPlayers: number, game: number): string[] {
  const seats: string[] = [];
  for (let i = 0; i < numPlayers; i++) {
    if (i < 4) seats.push((i + game) % 2 === 0 ? a : b);
    else seats.push("mock");
  }
  return seats;
}

/** Build the full round-robin schedule: `roundsCount` rounds × one game per rotation. */
export function buildRoundRobin(config: TournamentConfig): TournamentGameRef[][];

/** Build round 0 of a knockout bracket: seed by `eloOf` descending, standard pairing (1v last, 2v second-last…), byes (null b) for non-powers-of-2, later rounds all-TBD. */
export function buildKnockout(config: TournamentConfig, eloOf: (model: string) => number): KnockoutMatch[][];

/** Seat-wins per roster model from a finished game's outcomes. */
export function attributeWins(outcomes: SeatOutcome[], roster: string[]): Record<string, number>;

/** Round-robin standings: wins = games with ≥1 winning seat; sort wins desc, seatWins desc, model asc.
 *  (Conscious deviation from the spec's "Elo delta as tiebreak": seat-wins is self-contained per
 *  tournament and avoids threading global-Elo snapshots through the schedule; noted for review.) */
export function standings(t: Tournament): StandingRow[];

/** Knockout match winner once all its games finished: more total seat-wins across games; tie → higher seat-win share in the LAST game; still tied → a (deterministic). Returns undefined while games remain. */
export function matchWinner(m: KnockoutMatch): string | undefined;

/** Advance winners into the next round's a/b slots (byes auto-advance). Mutates and returns a copy. */
export function advanceBracket(bracket: KnockoutMatch[][]): KnockoutMatch[][];

/** True when every scheduled game is finished (RR) or the final match has a winner (KO). */
export function isComplete(t: Tournament): boolean;

/** Next up-to-`limit` pending game refs eligible to run (RR: any pending; KO: only matches whose a & b are known). */
export function nextPending(t: Tournament, limit: number): TournamentGameRef[];
```

Implementation notes (binding):
- `buildRoundRobin`: rounds = `config.gamesPerRound`; each round has exactly ONE game (`key = "r<round>g0"`, `seed = mixSeed(config.seed, round, 0)`, `seatModels = roundRobinSeats(...)`). A "round" is one full game where the whole roster is seated (rotated); N rounds = every model plays N games. (Roster may be smaller than numPlayers — models repeat seats; that is fine and matches the arena's existing round-robin seat fill.)
- `buildKnockout`: bracket size = next power of 2 ≥ roster length; seeds sorted by `eloOf` desc; byes get `b: null` and `matchWinner` = `a` immediately (no games). Each real match gets `config.gamesPerRound` game refs (`key = "m<r>-<i>g<n>"`, `seed = mixSeed(config.seed, r * 100 + i, n)`, seats via `knockoutSeats(a, b, numPlayers, n)`) — created lazily by Task 3 when the match becomes runnable (refs for round 0 real matches are built here; later rounds get `games: []` until `advanceBracket` fills slots, then the orchestrator materializes refs with the same key/seed scheme).
- `attributeWins`: count `outcomes.filter(o => o.model === m && o.won).length` per roster model.
- All functions are pure — no Date, no Math.random, no I/O.

- [ ] **Step 1: Write failing tests** (`schedule.test.ts`) covering: mixSeed determinism + spread (different coords ⇒ different seeds); roundRobinSeats length/rotation (all roster members appear across rounds); knockoutSeats alternation + mock fill; buildRoundRobin shape (N rounds, keys, deterministic seeds); buildKnockout seeding order, bye handling (3-model roster ⇒ 4-slot bracket, one bye auto-advanced), all-TBD later rounds; attributeWins on a hand-built outcomes array; standings sort + tiebreaks; matchWinner best-of-3 (2-1 split, tie-then-last-game rule); advanceBracket fills next round; isComplete/nextPending for both formats.
- [ ] **Step 2: Run** `npx vitest run src/lib/tournaments/schedule.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** types.ts + schedule.ts exactly as specified.
- [ ] **Step 4: Run — PASS.** Then `npm test` (all green), `npx tsc --noEmit` (clean).
- [ ] **Step 5: Commit** `feat(tournaments): types + pure scheduling, standings, bracket math` (explicit paths).

---

### Task 2: Store support for tournaments

**Files:**
- Modify: `src/lib/store/index.ts` (interface + re-exports)
- Modify: `src/lib/store/fileStore.ts` (implementation)
- Test: `src/lib/store/tournamentStore.test.ts`

**Interfaces:**
- `Store` gains:

```ts
  listTournaments(): Promise<Tournament[]>; // newest first
  getTournament(id: string): Promise<Tournament | null>;
  saveTournament(t: Tournament): Promise<void>; // upsert under the mutex
```

- Persisted at `<dataDir>/tournaments.json` as `Tournament[]` (newest first, cap 100).
- `saveTournament` replaces by id (or prepends) inside `withLock`.
- CAUTION: the OTHER session may be extending the same two store files for live mode. Before editing, re-read both files; add your methods additively at the end of the interface/object; if you find live-mode methods already present, leave them untouched. Keep your diff minimal.

- [ ] **Step 1: Failing tests** — extract the pure upsert logic `upsertTournament(list, t, cap = 100): Tournament[]` (exported from src/lib/store/index.ts) and unit-test it thoroughly: upsert inserts newest-first, replaces by id in place of prepending a duplicate, enforces the cap, leaves input array unmutated. Then ONE integration test through the real store: (a) read existing tournaments.json content first (may be absent), (b) saveTournament with a unique id, (c) assert getTournament returns it and listTournaments contains it first, (d) `afterAll` restores the original file content (or removes the file if it did not exist) via direct fs — never delete or rewrite other user data.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** (pure `upsertTournament(list: Tournament[], t: Tournament, cap = 100): Tournament[]` exported from store/index.ts; fileStore methods use readJson/writeJson + withLock + upsertTournament).
- [ ] **Step 4: Run — PASS**; `npm test`; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(store): tournament persistence under the write mutex`.

---

### Task 3: Orchestrator

**Files:**
- Create: `src/lib/tournaments/orchestrator.ts`
- Test: `src/lib/tournaments/orchestrator.test.ts`

**Interfaces:**
- Consumes: Task 1 math, Task 2 store methods, existing `createGame` (src/lib/games.ts) and `store`.
- Produces:

```ts
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

/** Validate input (roster deduped 2–12 against known models with "mock" fallback like buildConfig; format defaulted to round_robin; gamesPerRound clamped 1–20 (RR) / odd 1–7 (KO); numPlayers clamped 5–12; concurrency clamped 1–4; seed defaulted randomly), build schedule (knockout seeds by current leaderboard Elo, DEFAULT_ELO for unknowns), persist with status "running", kick off runTournament(id) WITHOUT awaiting, and return the Tournament. */
export async function createTournament(input: CreateTournamentInput): Promise<Tournament>;

/** Drive a tournament to completion: loop { refs = nextPending(t, concurrency); run them in parallel via createGame({numPlayers, seatModels: ref.seatModels, seed: ref.seed, disabledRoles}); after EACH game finishes, under-store update: set ref.status/gameId/winner/modelWins (attributeWins), advance bracket + materialize newly-runnable KO match games, persist } until isComplete → status "finished". Any thrown game error: mark tournament "abandoned", persist, stop. */
export async function runTournament(id: string): Promise<void>;

/** HMR-safe in-process set of actively running tournament ids (globalThis stash). */
export function isTournamentActive(id: string): boolean;

/** Lazy reconcile: a stored "running" tournament that is not active in-process is marked "abandoned" (server restarted mid-run). Called by the GET paths in Task 5. */
export async function reconcileTournament(t: Tournament): Promise<Tournament>;
```

Implementation notes (binding):
- Registry: `const active = ((globalThis as Record<string, unknown>).__amongLlmsTournaments ??= new Set<string>()) as Set<string>` — survives Next.js HMR.
- Parallelism: `Promise.all` over the `nextPending` batch; re-read + persist tournament state under a SINGLE store write per finished game (read latest, mutate, saveTournament) to avoid clobbering between parallel finishers — do the read-mutate-write inside a small local promise-chain lock (same pattern as fileStore's withLock; do not reach into fileStore internals).
- KO: after `advanceBracket`, any match with both slots known and `games.length === 0` gets its refs materialized (`gamesPerRound` refs, key/seed scheme from Task 1 notes).
- Tournament games affect the global leaderboard exactly like normal games (createGame already applies Elo) — intended per spec.
- No timers/pacing; games run back-to-back.

- [ ] **Step 1: Failing tests** — with mock-only rosters (fast, offline): (a) round_robin roster ["mock","hunter-bot","sentinel-bot"], 3 rounds, numPlayers 5, concurrency 2, fixed seed → runTournament completes; assert every ref finished with gameId + winner + modelWins; standings rows sum games correctly; tournament status "finished"; the created gameIds exist via store.getTranscript. (b) knockout roster of 3 (one bye), best-of-1 → bracket resolves to a champion; assert bye auto-advanced and final has a winner. (c) reconcileTournament marks a hand-written "running" tournament (not in registry) as "abandoned". Integration tests write real games to the data dir — acceptable locally (they're indistinguishable from user-played games; use numPlayers 5 to keep them small) — but restore tournaments.json in afterAll like Task 2.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS** (may take ~10-30s for the RR test); `npm test`; `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(tournaments): orchestrator with parallel game execution`.

---

### Task 4: Model profile stats

**Files:**
- Create: `src/lib/stats.ts`
- Test: `src/lib/stats.test.ts`

**Interfaces:**

```ts
import { Transcript } from "./engine/types";
import { ModelRating } from "./elo";

export interface HeadToHead { opponent: string; games: number; wins: number; losses: number; }

export interface ModelProfile {
  model: string;
  rating: ModelRating; // normalized (asJester/history defaulted)
  perRole: Record<string, { games: number; wins: number }>;
  voteAccuracy: { hits: number; total: number }; // village-aligned day votes that hit actual wolves
  survivalRate: { survived: number; games: number };
  headToHead: HeadToHead[]; // sorted by games desc
  recentGames: { id: string; createdAt: string; role: string; won: boolean; winner: string }[]; // newest first, cap 20
}

/** Normalize a possibly-legacy rating (missing asJester/history). Exported for reuse. */
export function normalizeRating(model: string, r: Partial<ModelRating> | undefined): ModelRating;

/** Fold transcripts into a profile. Pure — caller supplies transcripts + rating. */
export function buildProfile(model: string, rating: Partial<ModelRating> | undefined, transcripts: Transcript[]): ModelProfile;
```

Implementation notes (binding):
- voteAccuracy: for each transcript, for each seat of `model` whose `alignment === "good"`, count that seat's `vote` events with non-null target; a hit = target seat's role is `werewolf`. (Use `transcript.players` for roles; use `vote` events, not vote_result.)
- headToHead: for each other model in a shared game where the two models' seat alignments OPPOSE (one has a good/neutral-winning seat… keep it simple and well-defined: opponent relationship counted when the models have seats on different `alignment` values ("good" vs "evil") in that game; jester seats ignored). wins = games `model`'s opposing stance won (its seat(s) with won=true), losses = games the opponent side won. One game increments at most one of wins/losses per opponent.
- recentGames: from transcripts sorted by createdAt desc; role of the model's FIRST seat (multi-seat: first by seatId), won = any seat won.
- perRole: every seat counts individually (a model twice-seated counts 2 games in those roles).
- Pure function + tests over hand-built mini-transcripts (build via `simulate` with mock brains at numPlayers 5 for realism where convenient, or hand-crafted objects).

- [ ] **Step 1: Failing tests** — normalizeRating fills defaults; buildProfile voteAccuracy on a crafted transcript (known wolf, known votes); headToHead opposing-alignment counting incl. the one-increment rule; perRole multi-seat counting; recentGames cap + order.
- [ ] **Step 2: Run — FAIL.**  **Step 3: Implement.**  **Step 4: PASS + full gates.**
- [ ] **Step 5: Commit** `feat(stats): model profile aggregation from transcripts`.

---

### Task 5: Tournament APIs + pages

**Files:**
- Create: `src/app/api/tournaments/route.ts` (GET list / POST create)
- Create: `src/app/api/tournaments/[id]/route.ts` (GET one, reconciled)
- Create: `src/app/tournaments/page.tsx` (create form + list)
- Create: `src/app/tournaments/[id]/page.tsx` (server shell)
- Create: `src/components/TournamentView.tsx` (client: polling standings/bracket)
- Create: `src/components/NewTournamentForm.tsx` (client)
- Modify: `src/app/page.tsx` (add a "🏆 Tournaments" link next to the existing header links/buttons — keep it a one-line addition)

**Interfaces:**
- POST /api/tournaments body = `CreateTournamentInput` → 201 `{ id, tournament }`; errors → 400 `{ error }`.
- GET /api/tournaments → `{ tournaments: Tournament[] }` (each passed through `reconcileTournament`).
- GET /api/tournaments/[id] → `{ tournament }` (reconciled) or 404.
- Routes: `export const runtime = "nodejs"; export const dynamic = "force-dynamic";` (match existing games route).
- `NewTournamentForm`: name input; format toggle (Round-robin / Knockout); roster multi-select chips fetched from `/api/models` (same pattern as NewGameForm — reuse its chip styling); rounds/best-of numeric chips (RR: 1–10; KO: 1/3/5); table-size chips (5–12); concurrency chips 1–4 with the warning line "Above 1, local models will fight for the same GPU — best for API models." shown when >1; submit → POST → `router.push(`/tournaments/${id}`)`.
- `TournamentView`: fetches `/api/tournaments/[id]` every 3s while `status === "running"` (clear interval otherwise). Round-robin: standings table (rank, model, wins, seat-wins, games) + per-round game chips linking to `/game/[gameId]` (pending games render as muted chips, running games — status "running" — with a pulsing dot; reuse `.chip` classes). Knockout: bracket columns (round per column, match cards showing a vs b, per-game result dots, winner highlighted gold, byes marked "bye"); each finished game links to `/game/[gameId]`. Status banner for finished (champion / final standings leader) and abandoned.
- Styling: reuse existing `.card`, `.chip`, `.btn`, `.display` classes and CSS vars; no new global CSS (globals.css is off-limits — shared with the other session).

- [ ] **Step 1: Implement API routes** (thin wrappers over Task 2/3 functions).
- [ ] **Step 2: Implement form + view + pages.**
- [ ] **Step 3: Verify** — `npm test` green; `npx tsc --noEmit` clean; `npm run build` succeeds. Then an API-level smoke: `curl -s -X POST localhost:3000/api/tournaments -H 'content-type: application/json' -d '{"roster":["mock","hunter-bot"],"format":"round_robin","gamesPerRound":2,"numPlayers":5}'` against `npm run dev`, then GET it until finished; assert JSON shape (run dev server in background; kill after).
- [ ] **Step 4: Commit** `feat(tournaments): create/list/detail APIs and live-updating tournament pages`.

---

### Task 6: Model profile pages

**Files:**
- Create: `src/app/api/models/[id]/profile/route.ts`
- Create: `src/app/models/[id]/page.tsx` (server shell)
- Create: `src/components/ModelProfile.tsx` (client or server component — server preferred, data via the lib not the API)
- Create: `src/components/EloSparkline.tsx` (pure inline-SVG polyline; props `{ history: EloHistoryEntry[] }`; 100% width, fixed height ~48px, gold stroke, no deps)
- Modify: `src/components/LeaderboardTable.tsx` (model name cells become `<Link href={`/models/${encodeURIComponent(model)}`}>`)

**Interfaces:**
- Profile data assembly (server-side helper in `src/lib/stats.ts` or the page): `listSummaries(200)` → filter summaries whose `models` include the target → `getTranscript` each (cap 60 most recent for the fold) → `buildProfile(model, leaderboard[model], transcripts)`.
- GET /api/models/[id]/profile → `{ profile }` or 404 when the model has no games AND no leaderboard entry. `id` is URL-decoded.
- Page sections (cards, existing styles): header (model label, provider chip if resolvable via `modelLabel`, current Elo big numeral, sparkline underneath); stat tiles (Deception = asWolf win rate, Detection = asVillage win rate, Vote accuracy = hits/total %, Survival %, Jester record when asJester.games > 0); per-role table; head-to-head table (opponent, W-L, games); recent games list linking to `/game/[id]` with win/loss tint.
- Percentages via existing `pct()` from src/lib/ui.ts; guard divide-by-zero (render "—" when games/total = 0).

- [ ] **Step 1: Implement** EloSparkline (pure; include a tiny vitest snapshot-free test asserting the polyline `points` string for a 3-entry history) + stats assembly + route + page + leaderboard links.
- [ ] **Step 2: Verify** — `npm test`, `npx tsc --noEmit`, `npm run build`; dev-server smoke: GET `/models/mock` renders (curl the page route for a 200), GET `/api/models/mock/profile` returns JSON with the documented keys.
- [ ] **Step 3: Commit** `feat(models): profile pages with elo sparkline, deception/detection, head-to-head`.

---

### Task 7: Full verification

**Files:** none new (fixes only if gates fail)

- [ ] **Step 1:** `npm test` — entire suite green (engine, agents, elo, replay, tournaments, stats, store).
- [ ] **Step 2:** `npx tsc --noEmit` clean; `npm run build` succeeds.
- [ ] **Step 3:** End-to-end dev-server pass: create a knockout tournament (roster: the 3 built-in bots, best-of-1, 5 players) via curl; poll to completion; open `/tournaments/<id>` HTML (curl 200); open `/models/mock` (200); confirm leaderboard row count grew via `/api/leaderboard`.
- [ ] **Step 4:** Note in the report anything the shared-tree situation (Phase 3 landing mid-flight) broke or required adapting.
- [ ] **Step 5: Commit** any fixes as `fix(phase4): verification fixes`; otherwise no commit.
