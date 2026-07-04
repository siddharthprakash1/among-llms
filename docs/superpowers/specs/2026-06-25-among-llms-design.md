# Among LLMs — Design Spec

**Date:** 2026-06-25
**Status:** Approved (Option B), building end-to-end
**Tagline:** *Watch AI models lie to each other. A social-deduction arena where LLMs play Werewolf — and try to outlie each other.*

## 1. Concept

A **visual social-deduction arena** where LLM agents play Werewolf/Mafia. Two pillars:

- **The show** — you watch a game play out live in a polished web UI: night kills, accusations, alliances, the dramatic vote. Every game is a shareable replay.
- **The arena** — different models (Claude, GPT, Llama, local) sit at the *same table*. An ELO leaderboard ranks them on **deception** (win-rate as Werewolf) and **detection** (win-rate as Villager).

**Run model (hybrid):** ships working with **zero setup** via a deterministic `mock` brain (no key, no install). Plug in an OpenAI-compatible key, Anthropic key, or local Ollama for real model play.

## 2. Why this gets stars

- Inherently clippable drama ("GPT-5 got caught lying and voted out by Claude").
- Leaderboard = a reason to return + something people cite.
- Zero-friction try (mock brain works offline; hosted demo on Vercel).
- Nobody owns the *pretty* version of this yet.

## 3. Architecture

**Stack:** Next.js 15 (App Router) + React 19 + TypeScript + Tailwind v4 + Framer Motion. Vitest for tests. File-based JSON store (zero-config locally; pluggable).

**Core principle: simulate-then-replay.** The server runs a full game to completion and stores a **transcript** (an ordered list of typed events). The UI is a *player* that animates the transcript with a timeline scrubber. Benefits: robust (no fragile streaming), real-LLM games (slow) compute once then replay smoothly, and shareable replays come for free.

```
src/
  lib/engine/      types, seeded RNG, role setup, werewolf state machine (simulate())
  lib/agents/      Brain interface, mockBrain (heuristic+deterministic), llmBrain (OpenAI-compat + Anthropic + Ollama), prompts, registry
  lib/elo.ts       team ELO update
  lib/store/       Store interface + fileStore (fs JSON, tmpdir fallback)
  app/             home, game/[id] replay player, leaderboard, api routes
  components/      GameTable, PlayerSeat, ChatLog, PhaseBanner, Controls, LeaderboardTable, NewGameForm
```

**Data flow:** `POST /api/games {config, seatModels, seed?}` → engine simulates with assigned brains → transcript stored + leaderboard updated → returns `gameId`. `GET /api/games/[id]` → transcript. `/game/[id]` plays it back.

## 4. Game rules (Werewolf, simplified but real)

- Default 7 seats: **2 Werewolves, 1 Seer, 1 Doctor, 3 Villagers** (configurable 5–12, table scales).
- **Night:** wolves agree a kill; seer inspects one player's alignment; doctor protects one player (a protected target survives the wolves).
- **Day:** announce the death (or "saved"); each living player makes one statement; everyone votes; plurality is eliminated (ties → no elimination). Eliminated roles are revealed.
- **Win:** Village wins when all wolves are dead. Wolves win when wolves ≥ villagers (parity).
- Determinism via seeded PRNG → reproducible replays.

## 5. Agent layer

`Brain` interface: `nightAction`, `dayStatement`, `dayVote`, each given a redacted game view (only what that role legitimately knows). Two implementations:

- **mockBrain** — deterministic heuristics over a seeded RNG. Wolves coordinate kills and bluff; seer/doctor act on private info; villagers reason over voting history. Generates *flavorful templated statements* so replays are entertaining with no LLM.
- **llmBrain** — unified `fetch` to an OpenAI-compatible endpoint (OpenAI/OpenRouter/Together/Ollama/LM Studio) or Anthropic Messages API. Returns strict JSON; **on any parse/error it falls back to the mock heuristic** so a flaky model never crashes a game.

`registry` exposes available models based on env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_BASE_URL`, `OLLAMA_BASE_URL`, …); `mock` is always present and is the default.

## 6. ELO / leaderboard

Per model: games, wins, win-rate overall / as-wolf (deception) / as-village (detection), ELO. After each game, treat it as winning-team vs losing-team; update each participating model toward the average opponent rating (K=24). Stored in `data/leaderboard.json`.

## 7. Testing (the verifiable core)

Vitest unit tests on the engine + mock brain + ELO:
- role setup counts; seeded determinism (same seed ⇒ identical transcript)
- doctor save prevents death; seer learns true alignment
- voting/elimination incl. tie = no elimination
- win conditions both directions; every game terminates with a winner
- mock brain only ever returns *legal* actions
- ELO is zero-sum-ish and moves the right direction

## 8. Out of scope for v1 (the 6-month vision)

Multiple games (Secret Hitler/Diplomacy), human-join, tournaments, public API, real DB / Vercel KV adapter (documented, not built).
