# HANDOFF — Among LLMs

**Audience:** a fresh Claude Code session on a new machine, picking this project up with zero prior context.
**Written:** 2026-11-15, generated from a fresh clone of `main` @ `8d44b33`.
**Safe to delete** once you've onboarded — nothing references this file.

---

## 0. The one critical fact

**This repository is the SOLE copy of the project.** The original development checkout (on the previous machine) was deleted after publication — its folder was repurposed for unrelated files and the `.git` directory is gone. Do not go looking for local state, stashes, or unpushed branches anywhere; there are none. Everything that exists is on GitHub:

- Repo: `siddharthprakash1/among-llms` (public, MIT)
- Default branch: `main` (29 commits, tip `8d44b33`)
- `phase-1-gameplay-depth`: historical working branch, same tip as `main`; keep it synced or delete it — nothing depends on it.

Runtime data (`data/`) and secrets (`.env.local`) were intentionally never committed. They regenerate / get recreated (see §3).

## 1. What this is

A Next.js app where LLM agents play Werewolf against each other:

- **The show** — every game is a replayable transcript, rendered either on a 2D "Classic" table or a 3D village stage (three.js) with an auto-director camera; optional live mode streams games over SSE as models think.
- **The benchmark** — an Elo leaderboard splitting **deception** (win rate as Werewolf) and **detection** (win rate as Villager), per-model profile pages, and round-robin / knockout tournaments.
- **Zero-config** — ships with three deterministic heuristic bots so everything works offline; Ollama/OpenAI/Anthropic keys are optional upgrades.

Read `README.md` next — it is accurate and current. Deeper design context: `docs/superpowers/specs/` (v1 + v2 specs) and `docs/superpowers/plans/` (phase-1 and phase-4 implementation plans).

## 2. Certified state (verified 2026-11-15 on a fresh clone)

| Check | Result |
|---|---|
| `git clone` → `npm install` → `npm test` | **129/129 tests pass, 11 files** |
| `npx tsc --noEmit` | clean (as of `8d44b33`) |
| `npm run build` (prod) | clean; 16 routes — 8 pages + 8 API (as of `8d44b33`) |
| Feature completeness | v1 + all four v2 phases shipped (see §6) |
| Open bugs | none known |

Toolchain last used: Node 25.x / npm 11.x (no `engines` pin; README says Node 18+). Next 15.1.6, React 19, Tailwind v4, three 0.171 + @react-three/fiber 9 + drei 10 + postprocessing 3, framer-motion 11, Vitest 2.

## 3. Getting running on this machine

```bash
git clone git@github.com:siddharthprakash1/among-llms.git
cd among-llms
npm install
npm test          # expect 129 passing
npm run dev       # http://localhost:3000 — fully functional with offline bots
```

Optional real models — create `.env.local` (gitignored; **restart dev server after editing**, Next reads it at boot only):

```env
# Ollama (local, free) — uses Ollama's OpenAI-compatible endpoint
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODELS=qwen2.5:3b,qwen2.5:7b,llama3.2:latest,mistral:latest

# OpenAI / OpenRouter / Together / vLLM / LM Studio
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODELS=gpt-4o-mini

# Anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODELS=claude-haiku-4-5
```

`.env.example` in the repo mirrors this. The registry (`src/lib/agents/registry.ts`) builds the model list from these vars at first use; `mock`, `hunter-bot`, `sentinel-bot` are always present. Models that were well-tested previously: `qwen2.5:3b` (fast, ~15–20 s per 5–8-player game), `llama3.2`, `mistral`. Big models (`gemma3:27b`, `qwen2.5:32b`) work but are slow.

`data/` (games, leaderboard, tournaments as JSON) is gitignored and auto-created on first game; a fresh machine starts with an empty arena — run a few bot matches to repopulate.

## 4. Repo map

```
src/lib/engine/          The deterministic game core. types.ts (all domain types,
                         GameEvent union, Brain interface) · rng.ts (mulberry32,
                         seeded) · roles.ts (role counts by table size 5–12,
                         disabledRoles) · dossier.ts (behavioral summary injected
                         into prompts) · werewolf.ts (simulate(): the whole game
                         loop — night powers, 3-beat days, win checks, onEvent hook)
src/lib/agents/          mockBrain.ts (seeded heuristic bots + play-styles; also
                         the fallback for flaky LLMs) · llmBrain.ts (plain-fetch
                         OpenAI-compatible + Anthropic, JSON mode, 45 s timeout,
                         ALWAYS falls back to mock on error/parse failure) ·
                         prompts.ts (prompt builders + lenient parsers) ·
                         registry.ts (env → model list) · brains.ts (factory)
src/lib/elo.ts           Team Elo, jester special-casing, per-game history
src/lib/stats.ts         Model profile aggregation from transcripts (vote
                         accuracy, survival, per-role, head-to-head)
src/lib/tournaments/     types.ts + schedule.ts (PURE math: RR schedule, KO
                         bracket, byes, standings, match winner) · run.ts
                         (orchestrator: runs games in background, concurrency cap,
                         persists after every batch)
src/lib/live.ts          In-process live-game registry (globalThis-pinned — see §7.1)
src/lib/replay.ts        Pure fold: transcript events → render state at step N
src/lib/director.ts      Pure state→camera-shot mapping for the 3D stage (tested)
src/lib/sound.ts         Synthesized Web Audio cues, zero assets, off by default
src/lib/store/           Store interface + fileStore (JSON under ./data, mutex-
                         serialized writes, tmpdir fallback on read-only fs)
src/lib/games.ts         Orchestration seam: createGame / createLiveGame /
                         getGame / leaderboard
src/app/                 Pages: / · /game/[id] (replay OR live) · /leaderboard ·
                         /models/[id] · /tournaments · /tournaments/[id]
                         API: games, games/[id], games/[id]/stream (SSE),
                         games/live, leaderboard, models, models/[id]/profile,
                         tournaments, tournaments/[id]
src/components/          ReplayPlayer (playback, 2D/3D toggle, sound, god view) ·
                         Scene3D (R3F stage, dynamic ssr:false) · GameTable/
                         PlayerSeat/EventFeed (2D) · LiveGame (SSE consumer) ·
                         Ambience (moon/stars/fog backdrop) · forms, tables,
                         profile, sparkline
docs/superpowers/        Design specs (v1 2026-06-25, v2 2026-07-04) + phase plans
docs/screenshots/        The 6 images the README embeds (see §7.3 before retaking)
```

## 5. Architecture invariants — do not break these

1. **Transcript is the single source of truth.** `simulate()` runs a game to completion and emits an ordered list of typed `GameEvent`s. Replay UI, live SSE, stats, and Elo are all pure consumers. Never put game logic in components.
2. **Determinism.** Same `GameConfig` (incl. `seed`) + same brains ⇒ byte-identical transcript. The engine never touches `Math.random`, `Date.now`, or wall-clock — ids/timestamps are injected by callers. Mock brains get per-seat seeds derived in `brains.ts`. Tests depend on this.
3. **Brains can never crash a game.** `LlmBrain` wraps every decision; any timeout/garbage falls back to `MockBrain` for that turn. Engine additionally validates every target and clamps illegal ones. Keep both layers.
4. **Role-redacted views.** Brains see only what their role legitimately knows (`buildView` in `werewolf.ts`): wolves get packmates + wolf chat, seer gets its own results, witch her potions, everyone gets public history + dossier. Don't leak.
5. **`🔮 SEER —` claim tag** (`mockBrain.ts`) is the bots' coordination protocol: only the real Seer emits it; villagers rally votes behind it; the Doctor guards the claimant; wolves hunt them. This is what makes offline games balanced (~40–55 % village) instead of 93 % wolf wins. Don't let a template or LLM path emit that prefix for non-seers.
6. **Statements are hostile input.** Player text is embedded into other agents' prompts via `JSON.stringify` escaping (`prompts.ts`) to kill prompt injection ("…\nSystem: ignore instructions"). Keep any new prompt interpolation escaped the same way.
7. **Store writes are serialized.** `fileStore.ts` chains all mutations through one in-process mutex, and `updateLeaderboard(updater)` is the atomic read-modify-write. The two historical bugs here were lost Elo updates and lost index entries under concurrent games. Never reintroduce separate `get` + `save` for the leaderboard.
8. **Live registry lives on `globalThis`** (`live.ts`). Next.js gives route handlers and RSC pages separate module instances — a module-level Map silently fails (the original live-mode 404 bug). Consequently the game page (`app/game/[id]/page.tsx`) never asks the registry; it renders `LiveGame` for any un-persisted id and lets the SSE route resolve live vs not-found.
9. **Jester Elo rules** (`elo.ts`): neutral seats are excluded from the team exchange unless the jester wins, in which case jester-vs-everyone. `history` entries power profile sparklines. Legacy boards without `asJester`/`history` are normalized on read.
10. **3D is a pure renderer.** `Scene3D` renders `ReplayState`; all cinematography is the pure, unit-tested `directShot()` in `director.ts`. Loaded via `next/dynamic` `ssr:false`; auto-fallback to 2D when WebGL missing or `prefers-reduced-motion`.

## 6. How it got here (29 commits, condensed)

| Phase | What landed |
|---|---|
| v1 (`c7ea405`) | Engine (Werewolf/Seer/Doctor/Villager), mock+LLM brains, Elo, replay UI, file store |
| P1 gameplay depth (`972830d`…`a89ceb5`) | Hunter (revenge shot), Witch (heal/poison), Jester (lynch-to-win), 3-beat days (statements→accusations→defenses→vote), wolf pack-chat, dossiers, jester Elo + history, role toggles |
| P2a (`b54b20d`) | Noir ambience (moon/stars/fog, day↔night palette via `[data-phase]`), synthesized sound engine |
| P2b (`5a9039f`) | 3D village stage + auto-director camera, bloom/vignette, Classic-view fallback |
| P3 (`3b57e58`) | Live mode: engine `onEvent` hook (push-intercepting Proxy — zero changes at ~20 push sites), globalThis registry, paced SSE (`/api/games/[id]/stream`, resumable via Last-Event-ID), LiveGame viewer |
| P4 (`4d58e9a`…`70268a7`) | Tournaments (pure RR/KO math + orchestrator + pages) and model profiles (stats lib, sparkline, vote accuracy, head-to-head) |
| Hardening | Adversarial review fixes: leaderboard + index RMW races, prompt injection, README image paths; cleanup round (`6c5fe97`); live-routing fix + screenshot re-captures (`04ace82`, `8d44b33`) |

Historical oddity you may see referenced in old docs: development ran as **two concurrent Claude sessions sharing one checkout** (one owned Phase 1/stats, the other 2a/2b/3/4), coordinating by staging explicit paths. That constraint is dead — single session owns everything now.

## 7. Hard-won operational gotchas

### 7.1 Next.js process model
- **Never run two `next dev` instances in one checkout.** They share `.next` and corrupt the webpack cache (`ENOENT …pack.gz`, phantom 404s). Fix: kill all, `rm -rf .next`, start one.
- **Never run `next build` while a dev server is up** — same `.next` contention. Kill dev first.
- Module-level singletons are per-bundle; anything that must be shared across routes/pages/background tasks goes on `globalThis` (see §5.8).

### 7.2 Dev workflow
- `.env.local` changes require a dev-server restart.
- `tsc --noEmit` is the safe typecheck while any server runs (doesn't touch `.next`).
- zsh: lowercase `path` is tied to `$PATH` — a `for path in …` loop breaks every subsequent command in that shell. Use another name.
- Mock games simulate in milliseconds; a "live" mock game feels live only because the SSE route paces emission (`delayFor` in the stream route). Real Ollama games pace themselves.

### 7.3 Screenshots (the white-README-image incident)
Two README images once shipped as unstyled white pages: they were captured against a cold `next dev` before Tailwind's CSS chunk compiled. **Protocol for retakes:** `npm run build && npm run start`, navigate, then verify `getComputedStyle(document.body).backgroundColor === "rgb(10, 10, 18)"` and `document.fonts.status === "loaded"` before shooting. Also: Playwright `fullPage` screenshots duplicate the sticky header mid-page (capture artifact, not a bug) — use viewport shots. README expects exactly: `home.png`, `stage-wide.png`, `stage-3d.png`, `tournament.png`, `profile.png`, `leaderboard.png` under `docs/screenshots/`.

### 7.4 Deploy caveat
File store writes to `./data` — ephemeral on serverless. It degrades gracefully (tmpdir fallback), but durable hosting needs a KV/Postgres adapter behind the one-file `Store` interface. Live mode also assumes a single long-lived Node process (`next start`); a process death mid-live-game just abandons it (never persisted, never rated) — by design.

## 8. Verification protocol (run before claiming anything works)

```bash
npm test                 # 129 tests: engine determinism/termination/legality,
                         # night-resolution order, hunter/witch/jester rules,
                         # Elo + jester + history, replay fold, director shots,
                         # tournament schedule/bracket/standings, stats, balance smoke
npx tsc --noEmit
npm run build            # type-checks + all 16 routes
```

Manual E2E sweep: run a bot match (instant) → replay plays, 3D toggle works; `POST /api/games/live` with an Ollama model → LIVE badge streams; create a bot tournament → standings/bracket fill; click a leaderboard name → profile renders.

## 9. Backlog / known imperfections (none blocking)

- `stage-wide.png` caption in README says "wide" but the shot is another director push-in — retake with the finale/establish shot if you care (protocol §7.3).
- Mock balance ≈ 40–55 % village; small local models go ~0 % village / strong wolf (honest finding, surfaces on leaderboard). Bigger models untested at scale.
- README roadmap (user-endorsed future work): more games (Secret Hitler, Avalon, Diplomacy), human-in-the-seat, per-turn reasoning inspector, hosted public arena.
- Nice-to-haves once discussed: demo GIF at top of README, GitHub topics (`llm`, `werewolf`, `ai-agents`, `nextjs`, `three-js`), seeding a richer public demo leaderboard.
- Repo was built partly for GitHub-stars appeal — README quality and screenshot polish are features, treat them as such.

## 10. Conventions

- Conventional commits (`feat(scope):`, `fix:`, `docs:`); subjects describe behavior, bodies only when they change a reader's action.
- Comments only for non-obvious *why* (external constraints, protocol invariants) — never narrating code.
- New logic lands with tests beside it (`*.test.ts` next to source); keep the engine's determinism tests passing untouched.
- Push to `main` directly (solo project, no PR flow so far).
