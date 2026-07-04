# Among LLMs v2 — Design Spec

**Date:** 2026-07-04
**Status:** Approved by user (this document reflects the approved brainstorm)
**Supersedes:** extends `2026-06-25-among-llms-design.md` (v1 remains accurate for the existing foundation)

## 1. Goal

Make the arena **deeper** (richer social play, more roles, live games, tournaments) and **visually stunning** (cinematic noir village rendered as a full 3D scene with a directed camera), while preserving v1's pillars:

- **Local-first, zero-config.** Clone-and-run with the deterministic mock brains; Ollama/OpenAI/Anthropic keys are optional. Every new feature works offline with mock brains.
- **Deterministic engine.** Same seed + same brains ⇒ identical transcript. The transcript (ordered typed events) stays the single source of truth.
- **Shareable replays.** Every game, live or not, ends as a replayable transcript.

**Architecture decision (approved): evolve the transcript engine** — extend the event vocabulary and stream events as they are produced. No actor-model rewrite; no free-form interruption dynamics.

## 2. Build order (approved)

| Phase | Deliverable |
|-------|-------------|
| 1 | Gameplay depth: 3 new roles, 3-beat day discussion, wolf chat, agent memory |
| 2a | App-wide noir theme + cinematic 2D table (becomes the "Classic view" fallback) + sound design |
| 2b | Full 3D stage with auto-director camera (the flagship view) |
| 3 | Live mode: games stream over SSE as they simulate |
| 4 | Tournaments (round-robin + knockout, parallel execution) + model profile pages |

Each phase gets its own implementation plan and lands independently.

---

## 3. Phase 1 — Gameplay depth

### 3.1 New roles

| Role | Team | Power |
|------|------|-------|
| **Hunter** | Village | On death (night kill, poison, or vote) immediately shoots one living player, who also dies. Shot resolves before win-condition checks. Max one hunter per game, so no chains. |
| **Witch** | Village | Two single-use potions. **Heal:** at night she learns who the wolves targeted and may save them. **Poison:** at night she may kill any player. She may use at most one potion per night. Poison is not blockable by the doctor. |
| **Jester** | Neutral (new third alignment) | Wins **alone** if eliminated by day vote; the game ends immediately with winner `jester`. If he dies any other way or the game ends otherwise, he simply loses. Counts as a non-wolf for parity. Wolves do not know the jester. |

Death causes grow from `"wolves" | "vote"` to `"wolves" | "vote" | "poison" | "hunter"`.

### 3.2 Night resolution order (deterministic)

1. Wolves chat (3.4), then agree a kill target.
2. Seer inspects one player.
3. Doctor protects one player (blocks the wolf kill only).
4. Witch learns the wolf target; may heal (blocks the kill) **or** poison another player — one potion per night. If a brain illegally requests both, the engine keeps the heal and discards the poison.
5. Deaths resolve: wolf kill (unless doctor-protected or witch-healed), then poison. Hunter shot fires immediately on his death. Then win check.

### 3.3 Day structure: three speaking beats

1. **Statements** — every living player speaks once (speaking order rotates by day so no seat always anchors).
2. **Accusations** — each living player may formally accuse one player with a stated reason, or pass. Structured event, not chatter.
3. **Defenses** — each accused player (deduplicated) gives one rebuttal.
4. **Vote** — as today: plurality eliminated, tie = no elimination, roles revealed on death.

### 3.4 Wolf chat

Before choosing the night kill, wolves exchange **two rounds** of one short message each (skipped when only one wolf lives). Chat is private: hidden in normal viewing, visible in god view and after game end.

### 3.5 New events

```
wolf_chat   { day, wolfId, text }
accusation  { day, from, target, text }
defense     { day, playerId, text }
hunter_shot { day, hunterId, targetId }
witch_action{ day, kind: "heal" | "poison", targetId }   // private, god view only
saved       { day, targetId, by: "doctor" | "witch" }     // `by` added to existing event
death       { ..., cause: "wolves" | "vote" | "poison" | "hunter" }
game_over   { winner: "good" | "evil" | "jester", ... }
```

### 3.6 Brain interface additions

```
wolfChat(view, round)            -> string
accuse(view)                     -> { targetId: number | null, text?: string }
defend(view, accusationsAgainstMe) -> string
witchAction(view, wolfTargetId)  -> { heal: boolean, poisonTargetId: number | null }
hunterShot(view)                 -> { targetId: number }
```

- **MockBrain** implements all of these with seeded heuristics and templated flavor text (wolves deflect and scapegoat; villagers cite voting history; jester acts subtly suspicious). Zero-config play keeps full feature parity.
- **LlmBrain** gains prompts for each; every response is parsed strictly and **falls back to the mock heuristic on any error/timeout** (existing pattern, unchanged).

### 3.7 Agent memory

`PlayerView` grows: `accusations`, `defenses`, `wolfChat` (wolves only), `potions` (witch only). The engine also builds a deterministic per-player **dossier** — compact behavioral summary (votes cast, accusations made/received, contradictions such as "voted against a revealed villager") — injected into prompts. Verbatim history is kept for the most recent 2 days; older days appear only in the dossier, keeping prompts bounded for small local models.

### 3.8 Role defaults by table size

Specials can be toggled off in the New Game form (replaced by villagers). Defaults:

| Players | Wolves | Specials | Villagers |
|---------|--------|----------|-----------|
| 5 | 1 | seer, doctor | 2 |
| 6 | 1 | seer, doctor, hunter | 2 |
| 7 | 2 | seer, doctor, hunter | 2 |
| 8 | 2 | seer, doctor, hunter, witch | 2 |
| 9 | 2 | seer, doctor, hunter, witch, jester | 2 |
| 10 | 3 | seer, doctor, hunter, witch, jester | 2 |
| 11 | 3 | seer, doctor, hunter, witch, jester | 3 |
| 12 | 4 | seer, doctor, hunter, witch, jester | 3 |

### 3.9 Elo with a neutral role

- Village/wolf wins: unchanged team-vs-team update (K=24), except the jester's model is excluded from both teams.
- Jester win: jester's model is treated as a one-model team beating the average rating of all other seated models; all others update as the losing side.
- `leaderboard.json` additionally records an **Elo history entry per model per game** (gameId, delta, rating after) to power profile sparklines (Phase 4).

---

## 4. Phase 2a — Noir theme + cinematic 2D table + sound

App-wide restyle in the approved **cinematic noir village** direction (moonlit blues at night, lantern amber by day, gold/blood accents, Instrument Serif display type pushed harder).

- **Atmosphere:** full-viewport layered CSS/SVG ambience — drifting fog, stars, moon glow at night; warm dusk for day. Slow scene-level cross-fade on phase change.
- **2D table upgrades:** portrait medallions with nameplates; role cards that 3D-flip (framer-motion) on death/god-view; spotlight-dim kill moment with claw-mark overlay; shield shimmer on saves; moonbeam sweep on seer checks; SVG accusation arrows across the table that thicken with pile-ons; vote tokens that fly to a center tally revealed one vote at a time.
- **Story log:** the event feed becomes speech bubbles styled per beat (statement / accusation / defense / wolf chat as red-tinged whispers), with day dividers and death markers.
- **Home & leaderboard:** moonlit hero, match cards as case files, leaderboard rows as ranked wanted-poster entries.
- **Sound design (view-agnostic, event-driven):** Web Audio engine mapping game events to bundled **CC0** SFX — night ambience loop (wind/crickets), kill sting + slash, heartbeat under vote reveals, wolf howl / village bell endings, murmur under wolf chat. **Off by default**, single toggle, persisted in localStorage.
- This 2D view ships as the permanent **Classic view** — the automatic fallback when WebGL is unavailable or `prefers-reduced-motion` is set, and a manual toggle otherwise.

## 5. Phase 2b — Full 3D stage with auto-director camera (flagship)

The game view becomes a full-viewport 3D scene: a moonlit village clearing with a round wooden table, lantern posts, silhouetted huts and trees, and a real moon. **Everything about the stage is 3D and the camera moves** (approved explicitly).

- **Tech:** `three`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing` (bloom, vignette, subtle depth of field). All geometry is stylized low-poly **procedural** (primitives/lathes) — no external 3D assets, repo stays lean.
- **Players as pieces:** each seat is a carved pawn with a floating avatar billboard and nameplate. Death topples the pawn and raises a gravestone; the role card is a real 3D card that flips. Revealed wolves get glowing eyes in the fog.
- **Auto-director camera (headline feature):** while playing, a director maps replay state + current event to shots — slow idle orbit during discussion, push-in on the speaker, low dramatic angle + spotlight for night kills, overhead crane shot as votes arc in, sweeping finale. When paused, free orbit (drei `OrbitControls`). The state→shot mapping is a pure function and unit-testable.
- **Event spectacle in 3D:** glowing accusation arcs over the table (thicken with pile-ons), physical vote coins arcing into the tally, blood-mist puff + brief camera shake on kills, fireflies and drifting fog as particles, red fog pulse on wolf wins / golden dust on village wins.
- **DOM overlays:** story log, controls, and banners remain DOM as glass panels over the canvas — text stays crisp, accessible, and selectable. This is a deliberate exception to "everything 3D" for legibility.
- **Performance guardrails:** quality auto-detect (particle counts, shadow resolution), `devicePixelRatio` clamped ≤ 2, render paused when the tab is hidden, 60fps target on integrated graphics. Automatic fall back to Classic view when WebGL is unavailable.
- **Purity:** the scene is a pure renderer of the same `ReplayState` that drives the 2D view. No game logic in the scene graph.

## 6. Phase 3 — Live mode

- `POST /api/games` gains `mode: "live"`: the game record is created with `status: "running"`, simulation starts server-side, and the id returns immediately. Game records get `status: "running" | "finished" | "abandoned"`.
- The engine gains an **event callback**: each event is appended to the stored game as produced and pushed to an in-process per-game emitter registry (`Map<gameId, emitter>`).
- **`GET /api/games/[id]/stream`** (SSE, Node runtime): replays all persisted events from index 0, then tails live. Event id = event index; reconnects resume via `Last-Event-ID`. Joining mid-game therefore works by construction.
- **Thinking indicators:** while awaiting a brain, the runner emits ephemeral `acting { seatId, action }` messages on the stream only — never persisted, so replays stay clean (replays synthesize pacing as today).
- **Unified player:** one player component consumes either a finished transcript or the SSE stream. Live view shows a typing indicator on the thinking seat, a **LIVE** badge, scrub-back through elapsed events, and a LIVE button that snaps to the edge.
- Home page lists running games with a pulsing live badge (lightweight polling of `/api/games?status=running`).
- On completion: transcript finalized, leaderboard updated (exactly as today). If the server dies mid-game, the game is marked `abandoned` on next load — acceptable for local-first; abandoned games don't touch Elo.
- Mock-brain live games get small dramatic delays; LLM games pace themselves naturally (Ollama latency becomes suspense).

## 7. Phase 4 — Tournaments & meta

- **Orchestrator** runs a set of games over a model roster with **configurable parallelism** (approved): `concurrency` setting, default 1 (kind to a single Ollama box), higher for API providers. Warn in the UI that local models may thrash above 1.
- **Formats:**
  - *Round-robin season* — every model plays N games across shuffled seats/roles; standings by wins, Elo delta as tiebreak.
  - *Knockout bracket* — head-to-head elimination, best-of-N per round (odd N; table filled with mock bots so seat counts work).
- **Pages:** `/tournaments` (create + list), `/tournaments/[id]` (live-updating standings/bracket; each cell links to its game — running games open in live mode).
- **Model profiles** (`/models/[id]`): Elo history sparkline (from 3.9 history), deception rating (wolf win rate), detection rating (village win rate + **vote accuracy** — fraction of day votes cast against actual wolves while village-aligned), survival rate, per-role record, head-to-head nemesis/victim records, recent games.
- **Data:** transcripts remain the source of truth. `tournaments.json` stores tournament state; per-model aggregates are derived from transcripts and cached, recomputable at any time.

---

## 8. Cross-cutting

### 8.1 Error handling

- LLM failure/timeout/parse error → mock-heuristic fallback mid-game (existing invariant, extended to all new brain methods).
- SSE disconnect → EventSource auto-reconnect resumes via `Last-Event-ID`.
- Server restart mid-live-game → game `abandoned`, excluded from Elo.
- No WebGL / reduced motion / weak hardware → Classic 2D view. Audio failure → silent, toggle disabled.

### 8.2 Testing (Vitest, engine-level determinism preserved)

- Night resolution order; doctor vs witch heal interaction; poison unblockable; potion single-use legality.
- Hunter shot on every death cause; shot resolves before win check.
- Jester: day-vote elimination ends game with `jester` winner; all other jester deaths don't; parity counts jester as non-wolf.
- Discussion event ordering (statements → accusations → defenses → vote); rotating speaker order; wolf chat skipped for solo wolf.
- Seeded determinism across all new features; every game terminates.
- Elo: jester-win updates, jester exclusion otherwise, history entries appended.
- Director: state→shot mapping unit tests. Store: append + tail + resume-from-index. Tournament: scheduling, parallelism cap, standings/bracket math.
- Mock brains only ever return legal actions for all new roles/beats.

### 8.3 Performance

60fps target on integrated graphics; particle caps; pixel-ratio clamp; pause when hidden; transcripts stay small JSON (hundreds of events) so file store and full-stream replay remain trivially fast.

### 8.4 New dependencies

`three`, `@react-three/fiber`, `@react-three/drei`, `@react-three/postprocessing` (Phase 2b only). No database, no new services.

## 9. Out of scope

Human players joining games; other game types (Secret Hitler, Diplomacy); hosted multi-tenant public demo (design stays serverless-portable but nothing is built for it); custom-modeled/rigged 3D characters; voice/TTS; mobile-first layouts (desktop-first, responsive-degrading).
