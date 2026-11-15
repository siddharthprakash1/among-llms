# Per-turn Reasoning Inspector ("Minds") — implementation spec

Date: 2026-11-16. Status: ready to implement. No source file has been changed by this spec.

A viewer can step through a game decision by decision and read what each seat was privately
thinking when it acted, together with provenance: was the move the model's own or a heuristic
fallback, did the engine override it, and how long the model took.

Baseline verified while writing this spec: `npm test` is green with **131 tests in 12 files**
(the brief said 129; use 131 as the "nothing existing broke" number).

---

## 1. Decisions at a glance

| Question | Decision | Why (checked against the code) |
|---|---|---|
| How a brain returns reasoning | The engine passes a fresh, write-only `DecisionTrace` object as a **trailing optional argument** to every `Brain` method. No return type changes. | `dayStatement`, `wolfChat`, `defend` return bare strings, so a return-value channel is impossible without breaking callers. A `takeTrace()` getter would put per-decision state on the brain instance (stale-trace hazard, and `LlmBrain` owns a `MockBrain`). Scripted test brains are object literals with fewer parameters, which TypeScript accepts. |
| Where it is recorded | New optional sidecar `Transcript.decisions?: DecisionRecord[]`. `Transcript.events` is **not touched**. | Several decisions emit no event: each wolf's own kill preference (`werewolf.ts` wolf loop folds them through `pluralityPick`), an accusation pass or illegal accusation (the two `continue`s), a witch holding her potions, empty wolf chat/defense. A new event kind would shift `totalSteps`, the scrubber, `stepDelay` (1200 ms default), SSE `delayFor` (600 ms default) and `Last-Event-ID`. A sidecar leaves `deriveState`, `stats.ts`, `elo.ts`, `director.ts`, `sound` and pacing untouched. |
| Anchoring | `step` = `events.length` at the moment the record is written = index of the next event pushed. `produced: true` when that event is this decision's own outcome. | Every decision for event *i* exists before event *i* is pushed, which makes live streaming trivial. `game_over` is always pushed last, so `step` is always a valid index. |
| Provenance | `source` (`model` / `fallback` / `bot` / `unknown`), `fallbackReason`, engine `ruling` (`accepted` / `clamped` / `dropped`) with `requested` vs `applied`. | Today a flaky model silently plays as `MockBrain` and nobody can tell. |
| Latency | Recorded as optional `latencyMs`, measured **only inside `LlmBrain`** (agents layer, already non-deterministic network code). The engine copies an opaque number and never reads a clock. `MockBrain` never sets it. | Keeps invariant 2: mock transcripts stay byte-identical across runs. `latencyMs` is the only wall-clock field a transcript can contain (boundary stated in 4.4, pinned by test 22b). |
| Legacy `note` field | Kept on `NightDecision`/`VoteDecision` as legacy input (`reasoning = trace.reasoning ?? decision.note`). `MockBrain` stops setting it. | Nothing reads it today (`grep` confirms); keeping the type avoids breaking any third-party brain. |
| Live | Named SSE frame `event: decision` with no `id:` line, emitted just before the event it is anchored to. | Named frames never reach `es.onmessage`; `Last-Event-ID` stays an event index. |
| UI | `MindInspector` card at the top of the right-hand column (beside the stage, above the feed), identical for Classic 2D and Cinematic 3D. Gated by a `🧠 Minds` toggle that implies god view. A `💭` badge marks the acting seat in 2D and 3D. | Stays in view next to the stage while stepping; covers nothing on the stage; "said aloud" directly above "privately thought" is the screenshot. |
| Spoiler trust model | Client-side gate, same as god view. | `app/game/[id]/page.tsx` already ships the whole transcript with roles; the SSE `meta` frame already sends `players` with roles. |

Cut from scope (deliberately): `?t=<seq>` deep links, feed markers, director camera framing of the
thinker, extra keyboard shortcuts beyond `[` / `]`, an env switch to disable reasoning prompts,
honouring an explicit `null` vote from an LLM (see 6.3).

---

## 2. Files

New:

| File | Purpose |
|---|---|
| `src/lib/engine/events-golden.test.ts` | Pins mock-game `events` before any change. |
| `src/lib/engine/decisions.test.ts` | Engine recording, clamping, redaction, sanitising. |
| `src/lib/agents/llmBrain.test.ts` | Provenance stamping with stubbed `fetch`. |
| `src/lib/inspector.ts` + `src/lib/inspector.test.ts` | Pure, client-safe inspector logic. |
| `src/lib/live.test.ts` | Decision buffer + stream selection helper. |
| `src/components/MindInspector.tsx` | The inspector card. |

Modified:

| File | Change |
|---|---|
| `src/lib/engine/types.ts` | New types; trailing `trace?` on `Brain` methods; `Transcript.decisions?`. |
| `src/lib/engine/werewolf.ts` | `sealTrace`, `createDecisionLog`, call-site wiring, `onDecision`, return `decisions`. |
| `src/lib/agents/mockBrain.ts` | Rationale per branch via the trace; drop `note:` literals. |
| `src/lib/agents/prompts.ts` | `reasoning` in every prompt; `parseReasoning`; export `extractJson`; harden `parseTextResponse` and add its strict `{ allowRaw: false }` option; accuse public key renamed. |
| `src/lib/agents/llmBrain.ts` | `MAX_TOKENS` 320 → 512; single `decide()` helper. |
| `src/lib/agents/prompts.test.ts` | Append cases only. |
| `src/lib/live.ts` | `decisions` buffer, `pushLiveDecision`, `decisionsThrough`. |
| `src/lib/games.ts` | `createLiveGame` passes `onDecision`. |
| `src/app/api/games/[id]/stream/route.ts` | Emit `decision` frames. |
| `src/components/ReplayPlayer.tsx`, `LiveGame.tsx` | Toggle, gating, panel, navigation. |
| `src/components/GameTable.tsx`, `PlayerSeat.tsx`, `Scene3D.tsx` | Optional `thinkingId` prop → `💭` badge. |
| `src/app/globals.css` | `--mind` colour, `.tag-mind`. |
| `README.md` | Feature bullet; remove the roadmap line "Per-turn … reasoning inspector"; screenshot. |

Not modified: `replay.ts`, `director.ts`, `stats.ts`, `elo.ts`, `store/*`, `tournaments/*`,
`brains.ts`, `registry.ts`, `EventFeed.tsx`, `sound.ts`, all other API routes, and every existing
test case. No new dependencies.

---

## 3. Types (`src/lib/engine/types.ts`, additive)

```ts
export type DecisionKind =
  | "wolf_chat" | "wolf_kill" | "seer_check" | "doctor_save" | "witch_action"
  | "hunter_shot" | "statement" | "accusation" | "defense" | "vote";

/** model = the LLM's own answer · fallback = LLM reply unusable, heuristic answered ·
 *  bot = built-in heuristic seat · unknown = the brain reported nothing. */
export type DecisionSource = "model" | "fallback" | "bot" | "unknown";

/** timeout = request aborted · http = non-2xx · parse = no JSON object in the reply ·
 *  invalid = JSON but no usable answer field · error = anything else thrown. */
export type FallbackReason = "timeout" | "http" | "parse" | "invalid" | "error";

/** accepted = used as-is · clamped = engine substituted something · dropped = ignored, no effect. */
export type EngineRuling = "accepted" | "clamped" | "dropped";

/**
 * Write-only sink the engine hands to a brain for ONE call. Never part of a
 * PlayerView and never interpolated into a prompt.
 */
export interface DecisionTrace {
  reasoning?: string;
  source?: DecisionSource;
  fallbackReason?: FallbackReason;
  /** Wall-clock ms measured by the brain. The engine never reads a clock. */
  latencyMs?: number;
}

export interface DecisionChoice {
  targetId: number | null;
  /** witch_action only */
  heal?: boolean;
}

/** One brain call, as recorded for spectators. Spoiler data. */
export interface DecisionRecord {
  seq: number;        // 0-based position in Transcript.decisions
  step: number;       // index into Transcript.events this decision is shown with
  produced: boolean;  // true: events[step] is this decision's own outcome
  day: number;
  phase: Phase;
  playerId: number;
  kind: DecisionKind;
  source: DecisionSource;
  fallbackReason?: FallbackReason;
  requested?: DecisionChoice;  // target kinds only: what the brain asked for
  applied?: DecisionChoice;    // target kinds only: what the engine used
  ruling: EngineRuling;
  rulingNote?: string;         // engine-authored, deterministic
  reasoning?: string;          // capped at 600 chars by the engine
  latencyMs?: number;
}
```

`Brain` — only trailing optional parameters are added:

```ts
export interface Brain {
  readonly id: string;
  nightAction(view: PlayerView, trace?: DecisionTrace): Promise<NightDecision>;
  dayStatement(view: PlayerView, trace?: DecisionTrace): Promise<string>;
  dayVote(view: PlayerView, trace?: DecisionTrace): Promise<VoteDecision>;
  wolfChat?(view: PlayerView, round: number, trace?: DecisionTrace): Promise<string>;
  accuse?(view: PlayerView, trace?: DecisionTrace): Promise<AccuseDecision>;
  defend?(view: PlayerView, against: AccusationRecord[], trace?: DecisionTrace): Promise<string>;
  witchAction?(view: PlayerView, wolfTargetId: number | null, trace?: DecisionTrace): Promise<WitchDecision>;
  hunterShot?(view: PlayerView, trace?: DecisionTrace): Promise<{ targetId: number | null }>;
}
```

`Transcript` gains one optional field, last:

```ts
  /** Private per-decision reasoning + provenance. Absent on games recorded before the inspector. */
  decisions?: DecisionRecord[];
```

Change the comment on `NightDecision.note` to `/** Legacy: prefer the DecisionTrace argument. */`.
`PlayerView`, `GameEvent`, `SeatOutcome`, `GameResult`, `GameConfig` are unchanged.

"Target kinds" = `wolf_kill`, `seer_check`, `doctor_save`, `witch_action`, `hunter_shot`,
`accusation`, `vote`. `requested`/`applied` are omitted for `wolf_chat`, `statement`, `defense`.

Record invariants (tested): `seq` equals the array index; `step` is non-decreasing in `seq`;
`1 <= step <= events.length - 1`; when `produced`, `events[step].kind === kind` and the event's
actor is `playerId` (for `wolf_kill`, `actorIds` includes `playerId`).

Scope of the event → record mapping: a record exists only when a brain method was actually
called (4.3 rule 4). The guarantee "every seat-action event has a producing record" therefore
holds only for seats whose brain implements the method. The one event this affects is
`hunter_shot`: a brain without `hunterShot` still yields the event (the engine's
`validateTarget` picks a random legal target, as today) with no record, and the inspector shows
its "Narrator moment" text on that step. `MockBrain` and `LlmBrain` implement every method, so
this only concerns scripted or third-party brains. No engine change is made for it.

---

## 4. Engine (`src/lib/engine/werewolf.ts`)

### 4.1 Options and return

```ts
interface SimulateOptions {
  id: string;
  createdAt: string;
  onEvent?: (event: GameEvent, index: number) => void;
  /** Streaming hook for the reasoning sidecar. Always fires before onEvent for the same step. */
  onDecision?: (record: DecisionRecord) => void;
}
```

`simulate` returns `{ ...existing fields in the existing order, decisions: log.records }`
(`decisions` last).

### 4.2 Helpers (module-level, next to `validateTarget`)

```ts
const MAX_REASONING = 600;
const SOURCES: DecisionSource[] = ["model", "fallback", "bot", "unknown"];
const FALLBACK_REASONS: FallbackReason[] = ["timeout", "http", "parse", "invalid", "error"];

type SealedTrace = Pick<DecisionRecord, "source" | "fallbackReason" | "reasoning" | "latencyMs">;

/** Copy + sanitise what a brain wrote. A brain's trace is untrusted: never spread it. */
function sealTrace(trace: DecisionTrace, legacyNote?: unknown): SealedTrace {
  try {
    // Each property is read exactly once: a getter may throw or change its answer.
    const r: unknown = trace.reasoning;
    const src: unknown = trace.source;
    const fr: unknown = trace.fallbackReason;
    const ms: unknown = trace.latencyMs;
    const raw = typeof r === "string" ? r : typeof legacyNote === "string" ? legacyNote : "";
    // Cap before the regex so a multi-megabyte string costs nothing.
    const reasoning = raw.slice(0, MAX_REASONING * 4)
                         .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
                         .trim().slice(0, MAX_REASONING);
    const source = SOURCES.includes(src as DecisionSource) ? (src as DecisionSource) : "unknown";
    const fallbackReason = FALLBACK_REASONS.includes(fr as FallbackReason) ? (fr as FallbackReason) : undefined;
    const latencyMs = typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined;
    return { source, fallbackReason, reasoning: reasoning || undefined, latencyMs };
  } catch {
    return { source: "unknown" };   // a throwing accessor on the trace must not abort the game
  }
}

/** Garbage (undefined, NaN, strings) from a scripted brain reads as "no target". */
const asTarget = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);

type Draft = Pick<DecisionRecord, "day" | "phase" | "playerId" | "kind" | "produced" | "ruling"> &
  Partial<Pick<DecisionRecord, "requested" | "applied" | "rulingNote">>;

function createDecisionLog(events: GameEvent[], onDecision?: (r: DecisionRecord) => void) {
  const records: DecisionRecord[] = [];
  return {
    records,
    add(d: Draft, t: SealedTrace): void {
      // Fixed key order + omitted (never undefined) keys keep JSON output stable.
      const rec: DecisionRecord = {
        seq: records.length,
        step: events.length,
        produced: d.produced,
        day: d.day,
        phase: d.phase,
        playerId: d.playerId,
        kind: d.kind,
        source: t.source,
        ...(t.fallbackReason ? { fallbackReason: t.fallbackReason } : {}),
        ...(d.requested ? { requested: d.requested } : {}),
        ...(d.applied ? { applied: d.applied } : {}),
        ruling: d.ruling,
        ...(d.rulingNote ? { rulingNote: d.rulingNote } : {}),
        ...(t.reasoning ? { reasoning: t.reasoning } : {}),
        ...(t.latencyMs !== undefined ? { latencyMs: t.latencyMs } : {}),
      };
      records.push(rec);
      try { onDecision?.(rec); } catch { /* inspector telemetry must never abort a game */ }
    },
  };
}
type DecisionLog = ReturnType<typeof createDecisionLog>;
```

In `simulate`: `const log = createDecisionLog(events, opts.onDecision);` right after
`createEventLog`. It is a **local**, never a field of `MutableState`; that is the structural
guarantee that `buildView` (which reads only `MutableState`) cannot leak reasoning.
`fireHunter` gets `log: DecisionLog` as a new last parameter.

### 4.3 Rules for every call site

1. Create `const trace: DecisionTrace = {};` immediately before the awaited brain call and pass
   it as the last argument. One fresh object per call; never reuse.
2. Call `sealTrace(trace, …)` immediately after the await (before any later await), so late
   mutation by the brain is ignored.
3. Call `log.add(...)` **immediately before** the `events.push` of the decision's own event
   (`produced: true`), or at the point the engine decides no event will follow
   (`produced: false`). Because `step = events.length`, order matters.
4. Record only when a brain method was actually invoked. If an optional method is absent
   (`wolfChat`, `accuse`, `defend`, `witchAction`, `hunterShot`), write no record and keep
   today's default behaviour. Test for the method explicitly so this is knowable, **but keep
   today's nullish default on the awaited result**: a method that exists and resolves to
   `undefined`/`null` is a harmless pass today and must stay one (invariant 3). The presence
   check decides only whether a record is written. The three object-returning sites become:

   ```ts
   // accuse
   const brain = brains.get(sid)!;
   const trace: DecisionTrace = {};
   const decision = brain.accuse
     ? ((await brain.accuse(buildView(state, accuser, "day", day), trace)) ?? { targetId: null })
     : { targetId: null };
   const sealed = brain.accuse ? sealTrace(trace) : null;   // null ⇒ write no record

   // hunterShot (inside fireHunter) — same shape, default { targetId: null };
   // validateTarget(decision.targetId, legal, rng) is then called exactly as today.

   // witchAction — see the witch block below, default { heal: false, poisonTargetId: null }.
   ```

   `wolfChat` and `defend` keep today's `(raw ?? "")` on the result. Keep the calls as method
   calls on `brain` (`brain.accuse(...)`, never a detached function) so `this` is preserved.
5. No rng call is added, removed or reordered. `validateTarget`, `pluralityPick` and
   `buildView` are called exactly as today, in the same order.

Ruling notes (exact strings):

- `N_RANDOM = "Illegal target — the engine picked a random legal one."`
- `N_RANDOM_NULL = "No target given — the engine picked a random legal one."`
- `N_VOTE = "Illegal vote target — counted as an abstain."`
- `N_ACCUSE = "Illegal accusation target — ignored."`
- `N_EMPTY_STATEMENT = "Empty statement — replaced with “…”."`
- `N_EMPTY = "Empty message — nothing was said."`
- `N_BOTH = "Both potions requested — the heal wins."`
- `N_HEAL_UNAVAILABLE = "Heal unavailable — the poison was used instead."`
- `N_WITCH_NOTHING = "Requested potion unavailable or target illegal — nothing happened."`

For sites that go through `validateTarget` (wolves, seer, doctor, hunter), with
`req = asTarget(decision.targetId)` and `t` the validated target:
`ruling = t === req ? "accepted" : "clamped"`, `rulingNote = t === req ? undefined : req === null ? N_RANDOM_NULL : N_RANDOM`,
`requested = { targetId: req }`, `applied = { targetId: t }`.

| Site | kind / phase | produced | Notes |
|---|---|---|---|
| Wolf chat loop | `wolf_chat` / night | text non-empty | Empty text: `ruling: "dropped"`, `N_EMPTY`, `produced: false`, then `continue`. Otherwise `accepted`; add before the push. Truncation to 240 chars is not flagged. |
| Wolf kill loop | `wolf_kill` / night | `killTarget !== null` | Buffer `{ draft, sealed }` per wolf inside the loop (seal inside the loop). After `pluralityPick`, add all buffered records in wolf order, then push `wolf_kill` if any. `applied.targetId` is that wolf's own validated preference; the pack result is in the event. Pass `decision.note` as `legacyNote`. |
| Seer loop | `seer_check` / night | `t !== null` | Add before the push. `legacyNote = decision.note`. |
| Doctor loop | `doctor_save` / night | `t !== null` | Same. |
| Witch | `witch_action` / night | a potion was used | See below. |
| `fireHunter` | `hunter_shot` / `phase` param | `target !== null` | Add before the `hunter_shot` push (or before `continue` when `target === null`). |
| Statements | `statement` / day | always | `ruling = "clamped"` + `N_EMPTY_STATEMENT` when the trimmed text was empty, else `accepted`. |
| Accusations | `accusation` / day | accusation recorded | Keep the existing control flow untouched and key the record on the **branch actually taken**, with `req = asTarget(decision.targetId)` used only to fill `requested`. First `continue` (strict `decision.targetId === null`): `accepted`, `produced: false`, `requested = applied = { targetId: null }`. Second `continue` (`!legal.includes(decision.targetId)`): `dropped`, `N_ACCUSE`, `requested = { targetId: req }` (which is `null` for garbage such as `{}` or `"3"`), `applied = { targetId: null }`, `produced: false`. Legal: `accepted`, `requested = applied = { targetId: req }`, add before the push. |
| Defenses | `defense` / day | text non-empty | Empty: `dropped`, `N_EMPTY`, `produced: false`. |
| Votes | `vote` / day | always | `clamped` + `N_VOTE` when `req !== null && target === null`; else `accepted`. `legacyNote = decision.note`. |

Witch (restructure the existing `if / else if` so the outcome is known before any push; the
game effect must be identical):

```ts
const brain = brains.get(witch.id)!;
if (!brain.witchAction) continue;                       // same effect as today's default decision
const trace: DecisionTrace = {};
// The nullish default stays: a witchAction that resolves to undefined is a pass, not a crash.
const decision =
  (await brain.witchAction(buildView(state, witch, "night", day), killTarget, trace)) ??
  { heal: false, poisonTargetId: null };
const sealed = sealTrace(trace);
const reqPoison = asTarget(decision.poisonTargetId);
const requested = { targetId: reqPoison, heal: decision.heal === true };
const base = { day, phase: "night" as const, playerId: witch.id, kind: "witch_action" as const, requested };

if (decision.heal && potions.heal && killTarget !== null) {
  log.add({ ...base, produced: true, applied: { targetId: null, heal: true },
            ruling: reqPoison !== null ? "clamped" : "accepted",
            rulingNote: reqPoison !== null ? N_BOTH : undefined }, sealed);
  /* existing heal effect + push */
} else if (decision.poisonTargetId !== null && potions.poison && legalPoison.includes(decision.poisonTargetId)) {
  log.add({ ...base, produced: true, applied: { targetId: decision.poisonTargetId, heal: false },
            ruling: decision.heal ? "clamped" : "accepted",
            rulingNote: decision.heal ? N_HEAL_UNAVAILABLE : undefined }, sealed);
  /* existing poison effect + push */
} else {
  const asked = decision.heal === true || reqPoison !== null;
  log.add({ ...base, produced: false, applied: { targetId: null, heal: false },
            ruling: asked ? "dropped" : "accepted",
            rulingNote: asked ? N_WITCH_NOTHING : undefined }, sealed);
}
```

`legalPoison` is today's `alivePlayers(state).filter(p => p.id !== witch.id).map(p => p.id)`;
computing it before the branch is side-effect free.

### 4.4 Invariants preserved

- **Determinism (2).** No clock, no extra rng in the engine. `events` for mock games are
  byte-identical to today (golden test). `decisions` for mock games are a pure function of seed
  and view. **Boundary:** a transcript is byte-identical across runs for clock-free brains
  (`MockBrain`, scripted brains). `latencyMs`, written only by `LlmBrain`, is the **only**
  wall-clock field a transcript can contain; a game whose LLM seats all fall back
  deterministically (provider down, stubbed `fetch`) is identical across runs once `latencyMs`
  is removed from each record. Test 22b pins this so no other nondeterminism can creep in. Any
  future whole-transcript comparison involving an `LlmBrain` must strip `latencyMs` first.
- **Brains cannot crash a game (3).** `sealTrace` is wrapped in `try/catch`, reads each trace
  property once and caps length before sanitising; `onDecision` is wrapped. The nullish default
  on the result of `accuse` / `witchAction` / `hunterShot` is kept (rule 4). Target validation
  is unchanged.
- **Redaction and injection (4, 6).** Reasoning is never written to `MutableState`, so it has no
  path into `PlayerView`, `buildDossier` or any prompt builder. No new prompt interpolation.
  The second path, a model's reply being mis-parsed so that private reasoning is spoken
  aloud, is closed in 6.1/6.2: `LlmBrain` accepts public speech only from a named JSON key.
- **Seer tag (5).** Reasoning never enters `statements`; `isSeerClaim` cannot see it.
- **Store (7).** No new store writes; `decisions` rides inside the transcript already saved.

---

## 5. `MockBrain` (`src/lib/agents/mockBrain.ts`)

Every public method takes the trailing `trace?: DecisionTrace` and, on **every** return path,
reports through one helper:

```ts
function explain(trace: DecisionTrace | undefined, reasoning: string): void {
  if (!trace) return;
  trace.source = "bot";
  trace.reasoning = reasoning;
}
```

Hard rules:

- Rationale strings are built only from values the heuristic already computed. **Nothing in the
  rationale path may call `this.rng`, `pick`, `leaderOf`, `primeSuspect` or `render`.** One extra
  draw changes every mock game, `balance.test.ts`, and the README screenshots.
- Return values are unchanged. Remove the `note:` literals.
- The `a ?? b ?? pick(...)` chains (wolf branch of `dayStatement`, `dayVote`, `accuse`;
  `hunterShot`) become sequential `if`s **in the same evaluation order** so each branch can name
  its reason while short-circuiting exactly as today. Same for `claim ?? leaderOf(buddySuspicion…)`
  and for `suspect === null || this.rng() > …` in `accuse` (the rng is not drawn when
  `suspect === null`).
- `wolfPick` returns `{ target: number; why: string } | null`.

Rationale per branch (`{T}` = `nameOf(view, target)`, `{n}` = a count):

| Method / branch | Reasoning |
|---|---|
| `wolfPick` — Seer claimant | `{T} claimed Seer — silence them before they expose the pack.` |
| `wolfPick` — best has threat `n > 0` | `{T} has voted against the pack {n}× — the biggest threat to us.` |
| `wolfPick` — otherwise | `Nobody is onto the pack yet; {T} is as good a victim as any.` |
| `nightAction` wolf | the `wolfPick` why; when null: `No legal target tonight.` |
| `nightAction` seer — prime suspect in pool | `{T} is drawing the most votes — worth a look.` |
| `nightAction` seer — random unscanned | `No strong lead; scanning {T}, whom I haven't checked.` |
| `nightAction` seer — everyone scanned | `Everyone has been scanned; re-checking {T}.` |
| `nightAction` seer — empty pool | `No one left to scan.` |
| `nightAction` doctor — Seer claimant | `Shield {T}: a claimed Seer is the wolves' obvious target.` |
| `nightAction` doctor — self (roll) | `No one worth the risk — guarding myself tonight.` |
| `nightAction` doctor — random other | `No Seer to protect; guessing the wolves go for {T}.` |
| `nightAction` doctor — alone | `Only I am left to guard.` |
| `nightAction` other roles | `No night action for my role.` |
| `dayStatement` — no others | `Nobody left to persuade.` |
| `dayStatement` seer with a live confirmed wolf | `I've confirmed {T} is a wolf — time to go public.` |
| `dayStatement` jester | `Look just guilty enough to draw the rope.` |
| wolf — via `buddySuspicion` | `{T}'s votes lined up with a dead packmate — an easy frame.` |
| wolf — via `primeSuspect` | `The table already suspects {T}; pile on.` |
| wolf — random | `No heat on anyone yet; cast doubt on {T}.` |
| good — via Seer claim | `The Seer named {T}. Rally behind it.` |
| good — via `buddySuspicion` | `{T} kept voting alongside a revealed wolf.` |
| good — self-defence | `I've drawn {n} votes — time to defend myself.` |
| good — neutral | `No solid read yet; keep people talking.` |
| `dayVote` — no others | `No one to vote for.` |
| `dayVote` seer with confirmed wolf | `Vote out {T}, the wolf I confirmed.` |
| `dayVote` jester — prime suspect / random | `Vote with the crowd on {T} so I blend in.` / `No crowd to follow; a throwaway vote on {T}.` |
| `dayVote` wolf | the three wolf lines above (same wording) |
| `dayVote` good — claim / buddy | same two good lines above |
| `dayVote` good — aggressive pressure | `No hard read, but {T} is the standing suspect — keep the pressure on.` |
| `dayVote` good — abstain | `No hard read — abstaining beats lynching a villager.` |
| `wolfChat` round 1 / other | `Propose {T}: ` + why / `Back the pack's pick, {T}: ` + why; null: `No one left to hunt.` |
| `accuse` — no others | `No one to accuse.` |
| `accuse` jester — pass / accuse | `Stay quiet this round — don't overplay it.` / `A loose accusation at {T} keeps eyes on me.` |
| `accuse` wolf | the three wolf lines above |
| `accuse` seer with confirmed wolf | `Put the wolf I confirmed, {T}, on the record.` |
| `accuse` good — no suspect | `Nothing solid enough to accuse on.` |
| `accuse` good — suspect but roll says pass | `Holding fire on {T} for now.` |
| `accuse` good — accuse (claim / buddy) | `The Seer named {T} — put it on the record.` / `{T} voted with a revealed wolf — put it on the record.` |
| `defend` — has accusers / none | `Turn it back on {accuser}, who accused me first.` / `Plead my case to the table.` |
| `witchAction` — heal self / heal Seer | `The wolves are coming for me — drink the heal.` / `The wolves hit {T}, our claimed Seer — worth the heal.` |
| `witchAction` — poison | `The Seer confirmed {T}; poison settles it.` |
| `witchAction` — hold | `Nothing worth a potion tonight.` |
| `hunterShot` — confirmed / prime / random / none | `Taking the Seer-confirmed wolf {T} with me.` / `{T} is the table's top suspect — my last arrow.` / `No read — a blind shot at {T}.` / `No one left to shoot.` |

---

## 6. Prompts and `LlmBrain`

### 6.1 `src/lib/agents/prompts.ts`

Add one shared fragment and use it as the **first** key of every response-format line (the
model thinks before committing):

```ts
const PRIVATE_REASONING =
  '"reasoning": "<PRIVATE, max 40 words: what you really think and why. Only spectators ever see this — never another player.>"';
```

| Prompt | New final line |
|---|---|
| `nightPrompt`, `hunterPrompt` | `` `Respond as JSON: {${PRIVATE_REASONING}, "target": <seat id number>}` `` (the old discarded `"reason"` key is removed) |
| `votePrompt` | `` `Respond as JSON: {${PRIVATE_REASONING}, "target": <seat id number or null>}` `` |
| `statementPrompt` | `` `Respond as JSON: {${PRIVATE_REASONING}, "statement": "<your words to the table>"}` `` |
| `defendPrompt` | `` `Respond as JSON: {${PRIVATE_REASONING}, "statement": "<your defense>"}` `` |
| `wolfChatPrompt` | `` `Respond as JSON: {${PRIVATE_REASONING}, "message": "<your message to the pack>"}` `` |
| `accusePrompt` | `` `Respond as JSON: {${PRIVATE_REASONING}, "target": <seat id or null>, "accusation": "<one sharp sentence the TABLE WILL HEAR>"}` `` |
| `witchPrompt` | `` `Respond as JSON: {${PRIVATE_REASONING}, "heal": true|false, "poison": <seat id or null>}` `` |

The accuse public key is renamed `reason` → `accusation` because it sat one letter away from the
private `reasoning`. The parser reads **only** `["accusation"]` for the public text. The old
`reason` key is deliberately not accepted as speech: in the old night/vote/hunter prompts it was
the private rationale key, so a model that abbreviates `reasoning` to `reason` would have its
private thinking pushed as an `accusation` event and into `state.accusations`, which
`buildContext` embeds in every other seat's prompt. When `accusation` is missing the engine's
existing default text (`I accuse <name>.`) applies. A stray `reason` key is simply ignored.

`SYSTEM_PROMPT`: insert before the last line:
`'Every reply includes a private "reasoning" field: your honest thinking in at most 40 words. It is never shown to any other player.'`

Parsing changes:

```ts
export function extractJson(text: string): unknown | null   // now exported, body unchanged

/** The private reasoning field, or undefined. Never falls back to raw text. */
export function parseReasoning(text: string): string | undefined {
  const obj = extractJson(text) as Record<string, unknown> | null;
  const v = obj?.reasoning;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
```

**Harden `parseTextResponse` (required, closes a leak this feature would widen).** Today its
raw-text fallback returns the whole reply as public speech when it is ≤ 400 chars and does not
start with `{`. A fenced or truncated reply such as `` ```json\n{"reasoning": "I'm a wolf, deflect onto Bram… `` 
passes that check and would be spoken at the table and embedded in other agents' prompts. A
brace-free reply is just as dangerous now that every prompt solicits private thinking first
(the Anthropic path has no JSON mode; small local models often answer in prose):
`Reasoning: I'm a wolf, Bram is my packmate, deflect onto Cleo. Statement: Cleo has been quiet.`
would be spoken whole. Two changes:

```ts
export function parseTextResponse(
  text: string, keys: string[], opts: { allowRaw?: boolean } = {},
): string | null {
  const obj = extractJson(text) as Record<string, unknown> | null;
  if (obj) { /* existing key loop, unchanged */ }
  // Strict mode: public speech must come from a named JSON key, never from raw text.
  if (opts.allowRaw === false) return null;
  const raw = (text ?? "").trim();
  if (raw && raw.length <= 400 && !raw.includes("{") && !/\breasoning\b/i.test(raw)) return raw;
  return null;
}
```

1. **Strict mode (`{ allowRaw: false }`) is what `LlmBrain` uses for every public-speech path**
   (`dayStatement`, `defend`, `wolfChat`, `accuse`; see 6.2). There the raw-text fallback does
   not exist: no JSON object with a non-empty string under one of the keys means `null`, which
   sends the decision to the heuristic, labelled `fallback · parse` (or `invalid`).
2. The default (lenient) mode is kept only so the exported function's existing contract and its
   untouched test hold (`"Just my words"` → returned, `""` → null). It is tightened as defence
   in depth for any other caller: no raw fallback when the reply contains a `{` anywhere or
   mentions `reasoning`.

`parseStatementResponse` is left as it is (lenient, exported); `LlmBrain` stops calling it.

`buildContext` and its helpers are not touched.

### 6.2 `src/lib/agents/llmBrain.ts`

- `MAX_TOKENS = 512` (a truncated JSON object fails `extractJson` and forces a fallback; the
  extra field needs headroom).
- Every public method gains the trailing `trace?: DecisionTrace` and becomes one `decide` call.
  The villager early return in `nightAction` stays.

```ts
private async decide<T>(
  trace: DecisionTrace | undefined,
  prompt: () => string,                                   // thunk: built inside the try, as today
  parse: (text: string) => T | null,                      // null ⇒ unusable ⇒ fallback
  fallback: (trace: DecisionTrace) => Promise<T>,
): Promise<T> {
  const out = trace ?? {};
  // Wall-clock is fine here: this is the agents layer, not the engine.
  const started = Date.now();
  let reason: FallbackReason;
  try {
    const text = await this.chat(SYSTEM_PROMPT, prompt());
    const value = parse(text);
    if (value !== null) {
      out.source = "model";
      out.reasoning = parseReasoning(text);
      out.latencyMs = Date.now() - started;
      return value;
    }
    reason = extractJson(text) === null ? "parse" : "invalid";
  } catch (err) {
    const e = err as Error;
    reason = e?.name === "AbortError" ? "timeout"
           : /^(Anthropic|OpenAI-compatible) \d+/.test(e?.message ?? "") ? "http" : "error";
  }
  const value = await fallback(out);      // MockBrain fills its own rationale
  out.source = "fallback";
  out.fallbackReason = reason;
  out.latencyMs = Date.now() - started;
  return value;
}
```

On fallback the reasoning shown is the heuristic's (why the substitute move was made), never the
model's partial text.

The prompt is a thunk so that the builder runs inside the `try`, exactly as every
`nightPrompt(view)` / `witchPrompt(...)` call does today: a throw while building a prompt is
classified `error` and falls back instead of propagating into `simulate` (invariant 3). Call
sites pass e.g. `() => nightPrompt(view)`.

Per method (`parse` → `fallback`). `STRICT` = `{ allowRaw: false }`; every public-speech parse
uses it, so nothing but a named JSON key can ever be spoken:

| Method | parse | fallback |
|---|---|---|
| `nightAction`, `hunterShot` | `t = parseTargetResponse(text, view); return t === null ? null : { targetId: t }` | `(tr) => this.fallback.nightAction(view, tr)` / `hunterShot` |
| `dayVote` | same as above | `(tr) => this.fallback.dayVote(view, tr)` |
| `dayStatement` | `parseTextResponse(text, ["statement"], STRICT)` | `dayStatement` |
| `wolfChat` | `parseTextResponse(text, ["message", "statement"], STRICT)` | `wolfChat(view, round, tr)` |
| `defend` | `parseTextResponse(text, ["statement"], STRICT)` | `defend(view, against, tr)` |
| `witchAction` | `parseWitchResponse(text, view)` | `witchAction(view, wolfTargetId, tr)` |
| `accuse` | `extractJson(text) === null ? null : { targetId: parseTargetResponse(text, view), text: parseTextResponse(text, ["accusation"], STRICT) ?? undefined }` | `accuse(view, tr)` |

### 6.3 Behaviour changes in LLM games (mock games are unaffected)

1. Prompts ask for reasoning first. This is mild chain-of-thought and may shift play, token use
   and latency; Elo from before and after is not strictly comparable.
2. `accuse`: a reply with no JSON object used to be a silent pass; it now falls back to the
   heuristic like every other decision, and is labelled `fallback · parse`.
3. A statement, defense or wolf-chat reply that is not a JSON object with the expected key is
   no longer spoken verbatim (6.1 strict mode); the seat falls back to the heuristic and is
   labelled `fallback · parse` / `invalid`. This trades a little model voice from providers
   that ignore the JSON instruction for the guarantee that solicited private reasoning cannot
   be spoken. Fenced and prose-wrapped JSON still parse through `extractJson`, as today.
3a. An accusation whose JSON has a target but no `accusation` key gets the engine's default
   text `I accuse <name>.`; a `reason` key is no longer read as the public sentence.
4. Unchanged on purpose: a vote reply of `{"target": null}` still falls back to the heuristic
   vote, as today. It is now labelled `fallback · invalid` rather than hidden. Honouring an
   explicit abstain is a gameplay change and is left for a separate decision.

---

## 7. Live mode and API

### 7.1 `src/lib/live.ts`

```ts
export interface LiveGame {
  // ...existing...
  decisions: DecisionRecord[];
}

export function pushLiveDecision(id: string, record: DecisionRecord): void {
  const game = registry.get(id);
  if (!game) return;
  (game.decisions ??= []).push(record);   // ??= tolerates objects that survived dev HMR
}

/**
 * Decisions the stream should send immediately before event `index`.
 * `cursor` is the caller's position in `decisions`. Records anchored at or before
 * `lastId` were delivered on an earlier connection and are skipped.
 */
export function decisionsThrough(
  decisions: DecisionRecord[], cursor: number, index: number, lastId: number,
): { send: DecisionRecord[]; cursor: number } {
  const send: DecisionRecord[] = [];
  while (cursor < decisions.length && decisions[cursor].step <= index) {
    if (decisions[cursor].step > lastId) send.push(decisions[cursor]);
    cursor++;
  }
  return { send, cursor };
}
```

`createLive` initialises `decisions: []`. `subscribeLive`, `pushLive`, the `globalThis` registry
and pruning are unchanged. No decision listeners are needed: decisions are flushed with the
event they precede.

### 7.2 `src/lib/games.ts`

`createLiveGame` adds `onDecision: (rec) => pushLiveDecision(id, rec)` to the `simulate`
options. `createGame` and `tournaments/run.ts` need no change (the returned transcript already
carries `decisions` and is saved whole).

### 7.3 `GET /api/games/[id]/stream`

Wire contract (additions only):

```
event: meta
data: {...unchanged...}

event: decision
data: <DecisionRecord JSON>          ← zero or more, no "id:" line

id: <event index>
data: <GameEvent JSON>               ← unchanged
```

All `decision` frames with `step <= i` are written immediately before the frame for event `i`.
Implementation inside `start()`:

```ts
let decisionSource: () => DecisionRecord[] = () => [];
let cursor = 0;
const write = (ev: GameEvent, index: number) => {
  if (closed) return;
  const out = decisionsThrough(decisionSource(), cursor, index, lastId);
  cursor = out.cursor;
  for (const d of out.send)
    controller.enqueue(enc.encode(`event: decision\ndata: ${JSON.stringify(d)}\n\n`));
  controller.enqueue(enc.encode(`id: ${index}\ndata: ${JSON.stringify(ev)}\n\n`));
};
```

Set `decisionSource = () => live.decisions ?? []` in the live branch and
`() => t.decisions ?? []` in the persisted branch. `delayFor`, the queue, `enqueue`'s
`index > lastId` filter and `Last-Event-ID` semantics are unchanged. `JSON.stringify` never emits
a raw newline, so hostile reasoning cannot break a frame. Old clients ignore named frames.

`GET /api/games/[id]`, `POST /api/games`, `POST /api/games/live`: no code change; the transcript
JSON simply includes `decisions`. No new routes.

---

## 8. Pure inspector logic (`src/lib/inspector.ts`, client-safe, no React)

```ts
import { DecisionRecord, FallbackReason, GameEvent, Player, Transcript } from "./engine/types";

export function hasDecisions(t: Pick<Transcript, "decisions">): boolean;   // (t.decisions?.length ?? 0) > 0

export interface InspectorModel {
  current: DecisionRecord | null;
  /** All decisions anchored at this step, in seq order (includes current). */
  siblings: DecisionRecord[];
  prev: DecisionRecord | null;
  next: DecisionRecord | null;
  /** 1-based position of `current` in the game's decisions; 0 when there is none. */
  index: number;
  total: number;
}

export function inspect(decisions: DecisionRecord[], step: number, focusSeq: number | null): InspectorModel;

/** Seat that gets the 💭 badge: the current decision's actor while Minds is on, else undefined.
 *  The only source of `thinkingId`; renderers do nothing beyond `thinkingId === seat.id`. */
export function thinkingSeat(model: InspectorModel, minds: boolean): number | undefined;

export function describeDecision(
  rec: DecisionRecord, event: GameEvent | undefined, players: Player[],
): { icon: string; text: string; said?: string };

/** Extra reading time while Minds is on. Never shorter than `baseMs`. */
export function inspectorDwell(baseMs: number, rec: DecisionRecord | null, speed: number): number;

export interface ModelHealth {
  model: string;
  decisions: number;
  own: number;                                   // source === "model"
  fallbacks: number;                             // source === "fallback"
  byReason: Partial<Record<FallbackReason, number>>;
  overridden: number;                            // ruling !== "accepted"
  avgLatencyMs: number | null;                   // mean over records that have latencyMs
}
export function provenanceSummary(decisions: DecisionRecord[], players: Player[]): ModelHealth[];
```

`inspect` rules (work on array positions; never index the array by `seq`):

- `siblings` = records with `step === step`.
- `current` = the sibling whose `seq === focusSeq`; else the first sibling with `produced`;
  else `siblings[0]`; else `null`.
- With a `current` at array position `i`: `prev = decisions[i-1] ?? null`, `next = decisions[i+1] ?? null`, `index = i + 1`.
- Without one: `prev` = last record with `step < step`, `next` = first record with `step > step`, `index = 0`.

`thinkingSeat`: `minds && model.current ? model.current.playerId : undefined`. It applies no
alive filter on purpose: a hunter is always dead when `hunter_shot` is decided (the `death`
event precedes `fireHunter`), and the badge must still mark them (9.5).

`describeDecision` uses `event` only when `rec.produced && event?.kind === rec.kind`. `{A}` is the
name for `rec.applied?.targetId`; names come from `players`, falling back to `Seat {id}`.

| kind | icon | text | said |
|---|---|---|---|
| `wolf_chat` | 🐺 | produced: `Whispers to the pack` · else `Stays silent in the pack chat` | event `text` |
| `wolf_kill` | 🐺 | `Wants to kill {A}`, plus ` · pack chose {event target}` when the event target differs | — |
| `seer_check` | 🔮 | `Investigates {A}`, plus ` → WEREWOLF` / ` → innocent` from the event result | — |
| `doctor_save` | 🩺 | `Protects {A}` | — |
| `witch_action` | 🧪 | `applied.heal`: `Heals {event target}` (or `Uses the heal`) · `applied.targetId !== null`: `Poisons {A}` · else `Holds her potions` | — |
| `hunter_shot` | 🏹 | `Shoots {A}` | — |
| `statement` | 💬 | `Speaks to the table` | event `text` |
| `accusation` | ⚖️ | produced: `Accuses {A}` · `requested.targetId === null`: `Passes on accusing` · else `Tries to accuse an illegal target` | event `text` |
| `defense` | 🛡 | produced: `Defends themself` · else `Offers no defense` | event `text` |
| `vote` | 🗳 | `applied.targetId === null`: `Abstains` · else `Votes for {A}` | — |

`inspectorDwell`: `rec?.reasoning ? Math.max(baseMs, Math.min(6000, 1200 + 45 * rec.reasoning.length) / speed) : baseMs`.
(A vote dwells 650 ms today, too short to read. `stepDelay` itself is untouched.)

`provenanceSummary`: group by `players[rec.playerId].model`, rows sorted by model id.

---

## 9. UI

### 9.1 `globals.css`

Add `--mind: #b48cff;` to `:root`, and next to the other tags:

```css
.tag-mind {
  color: var(--mind);
  border-color: color-mix(in srgb, var(--mind) 40%, transparent);
  background: color-mix(in srgb, var(--mind) 12%, transparent);
}
```

### 9.2 `src/components/MindInspector.tsx` (new, `"use client"`, presentational only)

```ts
interface Props {
  model: InspectorModel;
  players: Player[];
  /** events[model.current.step], if it has arrived. */
  event: GameEvent | undefined;
  onJump: (rec: DecisionRecord) => void;      // prev / next / sibling chip
  onClose: () => void;
  /** LiveGame only. */
  live?: { following: boolean; onFollow: () => void };
}
```

Structure, top to bottom, inside `div.card.flex.flex-col.overflow-hidden` with a 3px left
border in `var(--mind)`:

1. **Header** (`px-4 py-3 border-b`): `🧠 Inside the mind` in `.display text-xl`; a
   `chip tag-evil` reading `SPOILERS`; right-aligned `◀` and `▶` (`btn btn-ghost px-2.5 py-1`,
   `disabled` when `model.prev` / `model.next` is null, `title="Previous decision ( [ )"` /
   `"Next decision ( ] )"`); a tabular counter `{index} / {total}` (show `– / {total}` when
   `index === 0`); `✕` close. In live mode, when `!live.following`, a `chip tag-evil` button
   `● Jump to live`.
2. **Body** (`flex-1 overflow-y-auto scrollbar-thin px-4 py-3 space-y-3`), wrapped in
   framer-motion `AnimatePresence mode="wait"` keyed by `current.seq` (opacity/y crossfade,
   150 ms). When `current` is null: muted text `Narrator moment — no decision on this step.`
   and a `Next decision ▶` button if `model.next`.
   - **Actor row:** avatar (text-2xl), name (font-semibold), role chip
     (`ROLE_META[role]` emoji + label, class by `align`: `tag-evil` / `tag-good` / `tag-neutral`),
     `modelLabel(model)` in muted 11px.
   - **Decision line:** `{icon} {text}` from `describeDecision`, 14px semibold, preceded by a
     muted `Night 2 · ` / `Day 2 · ` from `rec.phase` and `rec.day`.
   - **Said aloud** (only when `said`): label `SAID ALOUD` (10px, muted, tracking-wide) above a
     bubble with the feed's classes
     (`text-[13.5px] bg-[var(--panel-2)] border border-[var(--border)] rounded-xl rounded-tl-sm px-3 py-1.5`).
   - **Privately thought:** label `PRIVATELY THOUGHT` in `var(--mind)`, then the reasoning in
     `font-serif italic text-[17px] leading-snug whitespace-pre-wrap break-words` with
     `border-l-2 pl-3` in `var(--mind)`. When absent: muted
     `No reasoning was returned for this decision.`
   - **Provenance chips** (`flex flex-wrap gap-1.5`):
     - `model` → `chip tag-good` `● own decision`
     - `bot` → `chip` `🤖 heuristic bot`
     - `fallback` → `chip tag-gold` `⚠ fallback · {fallbackReason}` with
       `title="The model's reply was unusable; the built-in heuristic made this move."`
     - `unknown` → `chip` `source not reported`
     - `ruling !== "accepted"` → `chip tag-gold` `⚠ engine {ruling}` with `title={rulingNote}`;
       additionally render `rulingNote` as an 11px muted line under the chips.
     - `latencyMs !== undefined` → `chip` `⏱ {(ms/1000).toFixed(1)}s`
   - **Sibling strip** (only when `siblings.length > 1`): one small button per sibling showing
     its avatar; the current one gets a `var(--mind)` ring; non-produced ones are at 60% opacity
     with `title` = their `describeDecision` text. Clicking calls `onJump(sibling)`.

All model text is rendered as React text children. Never `dangerouslySetInnerHTML`: reasoning is
hostile input.

### 9.3 `ReplayPlayer.tsx`

State and derived values:

```ts
// module level: a stable identity, so legacy transcripts do not defeat the useMemo below
const NO_DECISIONS: DecisionRecord[] = [];

const decisions = transcript.decisions ?? NO_DECISIONS;
const canInspect = decisions.length > 0;
const [minds, setMinds] = useState(false);
const [focusSeq, setFocusSeq] = useState<number | null>(null);
const spoil = godView || minds;                       // reasoning reveals roles
const model = useMemo(() => inspect(decisions, step, focusSeq), [decisions, step, focusSeq]);
const thinkingId = thinkingSeat(model, minds);        // pure, tested (section 8)
```

- `seek` and `restart` call `setFocusSeq(null)`, so scrubbing back to a step shows its default
  (produced) decision rather than a sibling clicked earlier. `jump` (below) sets the step
  directly, not through `seek`, so its focus survives.

- Replace `godView` with `spoil` in the three reveal sites: `deriveState(..., { revealPrivate: spoil || step >= total })`
  (and its dependency array), and `showRole={spoil || state.finished}` for both `Scene3D` and
  `GameTable`.
- `jump(rec)`: `setPlaying(false); setStep(rec.step); setFocusSeq(rec.seq);`. A stale `focusSeq`
  is harmless: `inspect` ignores a focus that is not anchored at the current step.
- Playback effect: delay becomes
  `minds ? inspectorDwell(stepDelay(transcript, step, speed), model.current, speed) : stepDelay(transcript, step, speed)`;
  add `minds` and `model.current` to the dependency array.
- Keyboard: while `minds` is on, a `keydown` listener on `window` maps `[` → `model.prev`,
  `]` → `model.next` (via `jump`); ignore events whose target is an `input`, `textarea` or
  `select`. Remove the listener on cleanup. The effect's dependency array is
  `[minds, model.prev, model.next, jump]` (`jump` wrapped in `useCallback`); never list `model`
  itself in a dependency array, only the fields used (it is a new object whenever it recomputes).
- Controls bar, after the god-view button:

```tsx
<button
  className={cn("btn btn-ghost px-3", minds && "!text-[var(--mind)]")}
  onClick={() => setMinds((m) => !m)}
  disabled={!canInspect}
  title={canInspect
    ? "Show each player's private reasoning (spoilers: reveals all roles)"
    : "Recorded before reasoning capture"}
>
  🧠 Minds
</button>
```

- Right column. Replace the wrapper `<div className="h-[460px] lg:h-auto lg:min-h-[560px]">` with:

```tsx
<div className="lg:relative lg:min-h-[560px]">
  <div className="flex flex-col gap-5 lg:absolute lg:inset-0">
    {minds && (
      <div className="shrink-0 max-h-[340px] lg:max-h-[52%] flex">
        <MindInspector model={model} players={transcript.players}
          event={model.current ? transcript.events[model.current.step] : undefined}
          onJump={jump} onClose={() => setMinds(false)} />
      </div>
    )}
    <div className="h-[460px] lg:h-auto lg:flex-1 lg:min-h-0">
      <EventFeed log={state.log} seats={state.seats} />
    </div>
  </div>
</div>
```

  (`MindInspector`'s root needs `w-full`.) On large screens the column height is set by the
  stage and the inner layer fills it, so the inspector can never stretch the row; on small
  screens the order is stage, inspector, feed. With Minds off the layout is visually unchanged.
- Pass `thinkingId={thinkingId}` to `GameTable` and `Scene3D`.
- Reveal card: when `state.finished && canInspect`, add below the seat grid a
  **Decision health** block: `display text-lg` heading, then one row per `provenanceSummary`
  entry: model chip (`tag-gold`), `{decisions} decisions`, `{pct(own / decisions)} own`
  (omit for rows where `own + fallbacks === 0`, i.e. pure bots, and show `heuristic bot`),
  `{fallbacks} fallbacks` (in `var(--gold)` when > 0, with the `byReason` breakdown as `title`),
  `{overridden} engine overrides`, `avg {x.x}s` when `avgLatencyMs !== null`. It holds aggregates
  only, so it is not gated beyond `state.finished`.

### 9.4 `LiveGame.tsx`

```ts
const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
const [minds, setMinds] = useState(false);
const [pinnedSeq, setPinnedSeq] = useState<number | null>(null);   // null = follow the live edge
```

- In the SSE effect:

```ts
es.addEventListener("decision", (e) => {
  try {
    const rec = JSON.parse((e as MessageEvent).data) as DecisionRecord;
    setDecisions((cur) => (cur.some((d) => d.seq === rec.seq) ? cur : [...cur, rec]));
  } catch { /* ignore */ }
});
```

  `es.onmessage` is unchanged.
- The synthesised `transcript` memo is **not** changed: do not add `decisions` to it. Nothing
  in `LiveGame` reads `transcript.decisions` (the inspector uses the `decisions` state
  directly), and adding it would put `decisions` in that memo's deps and re-run `deriveState`
  on every decision frame.
- Spoiler gate (the live viewer has none today): `revealPrivate: done || minds` and
  `showRole={done || minds}`. The `state` memo's dependency array becomes
  `[transcript, events.length, done, minds]`; without `minds` the feed would not reveal wolf
  chat / witch lines until the next SSE event arrives.
- Header: a `🧠 Minds (spoilers)` button with the same styling as the replay one, `disabled`
  while `decisions.length === 0`.
- Inspector model. Follow mode uses the **same rule as replay**, anchored at the live edge, so
  narrator stretches (`saved`, `death`, `phase`, `vote_result`) show "Narrator moment" and no
  badge in both modes:

```ts
const pinned = pinnedSeq !== null ? decisions.find((d) => d.seq === pinnedSeq) : undefined;
const model = pinned
  ? inspect(decisions, pinned.step, pinned.seq)
  : inspect(decisions, events.length - 1, null);       // follow: the step the table is showing
const thinkingId = thinkingSeat(model, minds && !pinned);
```

  `LiveGame` has early returns (`if (notFound)`, `if (!state || !meta)`) below its hooks.
  Compute `pinned` / `model` / `thinkingId` as the plain expressions above (`inspect` is a
  cheap linear scan), or, if memoised, declare the `useMemo` **above** those early returns;
  a hook placed after them breaks the rules of hooks.
  In follow mode a decision frame that has arrived ahead of its event (`step === events.length`)
  is simply not shown yet, so `current`'s event always exists. When `current` is null, `◀`
  targets `model.prev`, which `inspect` already defines as the last record before the live edge.
- Render the same right-column structure as 9.3 (the existing wrapper here is
  `h-[460px] lg:h-auto lg:min-h-[520px]`; keep 520) with
  `onJump={(rec) => setPinnedSeq(rec.seq)}`,
  `live={{ following: pinnedSeq === null, onFollow: () => setPinnedSeq(null) }}`,
  `event={model.current ? events[model.current.step] : undefined}` (undefined only when the
  viewer steps `▶` onto a pinned record whose event has not arrived; `describeDecision`
  handles that).
- The table and feed keep following the live edge; only the inspector browses back. The badge
  is shown only while following (the `minds && !pinned` argument above). Live stays 2D-only,
  as today.

### 9.5 Acting-seat badge (2D and 3D)

`thinkingId` is always the result of the pure, unit-tested `thinkingSeat(model, minds)`
(section 8), computed in `ReplayPlayer` / `LiveGame` and passed down as an optional prop. The
renderers contain no decision logic beyond `const thinking = thinkingId === seat.id`.

Dead actors, stated once for both renderers: **the badge is shown whether or not the seat is
alive** (a hunter deciding `hunter_shot` is already dead), it is drawn upright, and the
`var(--mind)` ring is shown for living seats only.

- `GameTable`: new optional prop `thinkingId?: number`, forwarded to `PlayerSeat`.
- `PlayerSeat`: new optional prop `thinkingId?: number`; `const thinking = thinkingId === seat.id`.
  - Ring: insert `thinking ? "var(--mind)"` into the `ringColor` chain immediately before the
    `reveal` branch (lowest highlight priority). The chain starts with `!seat.alive ? …`, so a
    dead seat keeps its dead ring with no extra condition.
  - Badge, when `thinking` (no `seat.alive` condition), mirroring the role badge at the
    top-left: `absolute -top-1.5 -left-1.5 text-[13px] bg-[var(--bg)] rounded-full w-[22px] h-[22px] grid place-items-center border`
    with `borderColor: var(--mind)`, content `💭`. Render it outside any element that carries
    the dead seat's 0.4 opacity / grayscale so it stays legible.
- `Scene3D`: new optional prop `thinkingId?: number` on `Scene3DProps`, forwarded to `Pawn` as
  a boolean `thinking`. Inside `<Html>`, wrap the existing nameplate `div` (the one with
  `transform: rotate(…)`, which turns 90° for dead seats) in a plain outer
  `<div style={{ textAlign: "center" }}>` and render
  `{thinking && <div style={{ fontSize: 16, lineHeight: 1 }}>💭</div>}` as the first child of
  that outer div, i.e. **outside** the rotated div, so the badge is upright for dead seats
  too. Nothing else in `Scene3D` changes; `CameraRig`, `directShot` and `Highlight` are
  untouched. Scene3D still only renders what pure, tested code decided (invariant 10).

### 9.6 README

- Features: add `🧠 **Reasoning inspector** — step through any game and read what each model was privately thinking, next to what it said out loud, with fallback and engine-override provenance.`
- Roadmap: remove the "Per-turn … reasoning inspector" line.
- Screenshot `docs/screenshots/inspector.png`, referenced under "The show". Capture against a
  production server (`npm run build`, then `npm start`, as two commands; the convention of
  commit `8d44b33`): a 9-player game paused on a wolf's statement with Minds on, so the public
  statement and the private reasoning disagree in one frame. This needs a browser. In an
  unattended run without one it is deferred to the user (task 13); the feature is complete
  without the image, and no image link is added until the file exists.

---

## 10. Backward compatibility

- **Old persisted transcripts** (`data/games/*.json`): no `decisions` key. Every reader uses
  `t.decisions ?? []`. The Minds button is disabled with the tooltip above; nothing else changes.
- **New transcripts read by old code:** the extra key is ignored (`summarize`, `stats.ts`,
  `elo.ts`, `deriveState` never enumerate transcript keys).
- **Existing tests:** no existing case is edited.
  - `events` for mock games are byte-identical (golden test).
  - The determinism test compares whole transcripts from two runs; mock `decisions` are pure and
    carry no latency.
  - Scripted brains ignore the extra argument; their records have `source: "unknown"`.
  - `new MockBrain("mock", 1).defend(view, against)` still returns a string.
  - `prompts.test.ts` cases still hold under the hardened `parseTextResponse`: they call it
    without the options argument, i.e. in lenient mode, where `"Just my words"` is still returned.
  - Scripted brains whose optional methods resolve to `undefined` still pass harmlessly (the
    nullish defaults are kept, 4.3 rule 4).
- **Third-party `Brain` implementations:** trailing optional parameters are source-compatible.
- **SSE clients built before this change:** ignore `event: decision` frames.

---

## 11. Tests (Vitest, beside source)

`src/lib/engine/events-golden.test.ts` — written first, on untouched code.
1. For 12 fixed `(numPlayers, seed)` pairs covering 5–12 players with mock brains, assert an
   FNV-1a hash (inline 6-line helper, no dependency) of `JSON.stringify(t.events)` plus
   `t.result.winner` against literals. Generate the literals once from the untouched code and
   paste them in; they must never change during this work.

`src/lib/engine/decisions.test.ts`
2. Mock games (seeds 1–5, 9 and 10 players): `seq` equals index; `step` non-decreasing and within
   `1..events.length-1`; for `produced` records `events[step].kind === kind` and the actor matches.
3. In mock games (every method implemented; see the scope note in section 3): every
   `statement`, `vote`, `accusation`, `defense`, `wolf_chat`, `seer_check`, `doctor_save`,
   `witch_action`, `hunter_shot` event has exactly one producing record; each `wolf_kill` has one
   record per `actorIds` entry.
4. Mock records all have `source: "bot"`, non-empty `reasoning` ≤ 600 chars, and
   `JSON.stringify(t.decisions)` does not contain `latencyMs`; two runs give identical `decisions`.
5. Non-event decisions are captured: across seeds, at least one `accusation` record with
   `produced: false` and one `witch_action` record with `produced: false`.
6. **Redaction.** A factory wraps each `MockBrain`: it records every `PlayerView` it receives and,
   after delegating, overwrites `trace.reasoning` with `"ZZ-SECRET-<seat>"`. For every recorded
   view, neither `JSON.stringify(view)` nor `buildContext(view)` contains `ZZ-SECRET`; the
   transcript's `decisions` do contain it (proves the test is live).
7. Each call receives a distinct trace object that is empty on entry.
8. Clamping (scripted brains): illegal wolf target → `clamped`, `requested.targetId: 99`, legal
   `applied`; null wolf target → `clamped` with `N_RANDOM_NULL`; self-vote → `applied.targetId: null`,
   `clamped`; illegal accusation → `dropped`, `produced: false`; `accuse` resolving to `{}` →
   `dropped` with `N_ACCUSE` and `requested.targetId: null` (the illegal branch, not a pass);
   `accuse` resolving to `{ targetId: null }` → `accepted`, `produced: false`; witch asking for
   both potions → `clamped`, `applied.heal: true`; witch asking to poison herself → `dropped`;
   a legal choice → `accepted` with no `rulingNote` key.
8b. Nullish results (invariant 3): a scripted brain whose `accuse`, `witchAction` and
   `hunterShot` exist but resolve to `undefined` completes the game without throwing; its
   `accusation` records are `accepted` passes and its `witch_action` records `accepted` holds,
   each with `requested.targetId: null`; its `hunter_shot` record has `requested.targetId: null`
   and is `clamped` with `N_RANDOM_NULL` (the engine picks a legal target, as today). Same for
   `wolfChat` / `defend` resolving to `undefined` (`dropped`, `N_EMPTY`).
9. Hostile trace: non-string reasoning, a 5,000-char string, control characters, `NaN` and
   negative latency, an unknown `source`, and mutation after the call returns are all sanitised
   (600-char cap, `source: "unknown"`, no `latencyMs`); the game completes. Plus: a brain that
   installs a throwing accessor
   (`Object.defineProperty(trace, "reasoning", { get() { throw new Error("x"); } })`) yields a
   record with `source: "unknown"` and no reasoning, and the game completes; a 5 MB reasoning
   string is capped to 600 chars and the game completes.
10. A throwing `onDecision` does not abort the game; `onDecision` fires once per record and, for
    a produced record, before `onEvent` is called with `index === record.step`.
11. A scripted brain that sets only the legacy `note` gets it as `reasoning`; a brain lacking the
    optional methods produces no records for those kinds and no crash (a `hunter_shot` event
    may then exist with no record; assert exactly that, per the section 3 scope note).
12. `events` from a run with `onDecision` set deep-equal `events` from a run without it.

`src/lib/agents/prompts.test.ts` (append only)
13. `parseReasoning`: clean, fenced and prose-wrapped JSON; `undefined` for raw text, a missing
    key, a non-string, blank.
14. `parseTextResponse` hardening.
    Lenient (no options): fenced-but-truncated JSON, a short reply containing `{`, complete JSON
    lacking the key, and the brace-free reply
    `reasoning: I'm a wolf, deflect onto Bram\nstatement: Bram is suspicious` all return `null`.
    Strict (`{ allowRaw: false }`): `"Just my words"` → `null`; the brace-free prose reply
    `Reasoning: I'm a wolf, Bram is my packmate, deflect onto Cleo. Statement: Cleo has been quiet.`
    → `null`; `Thinking it over: Bram is my packmate. I'll say Cleo is quiet.` (no keyword, no
    brace) → `null`; `{"reasoning":"secret","statement":"hi"}` with keys `["statement"]` → `"hi"`;
    `{"reasoning":"secret"}` with keys `["statement"]` → `null`.
15. Every prompt builder's output contains `"reasoning"`; `accusePrompt` contains `"accusation"`
    and no `"reason":` key. `parseTextResponse('{"reason":"Bram is my packmate","target":4}', ["accusation"], { allowRaw: false })`
    → `null` (the legacy key is never public text).
16. `parseTargetResponse`, `parseWitchResponse`, `parseStatementResponse` still parse replies
    with a leading `reasoning` key.

`src/lib/agents/llmBrain.test.ts` (new; `vi.stubGlobal("fetch", …)`, restore in `afterEach`; no network)
17. Good reply → trace `{ source: "model", reasoning, latencyMs: number >= 0 }` and the parsed decision.
18. HTTP 500 → `fallback` / `http`, a legal decision, and the heuristic's rationale as reasoning.
19. `fetch` rejecting with an `AbortError`-named error → `fallback` / `timeout`.
20. Model text `hello` inside a valid provider envelope (e.g.
    `{"choices":[{"message":{"content":"hello"}}]}`): on `dayVote` → `fallback` / `parse`; on
    `dayStatement`, `defend` and `wolfChat` → also `fallback` / `parse`, and the returned text is
    the heuristic's, not `hello` (strict mode). Model text
    `Reasoning: I'm a wolf, deflect onto Cleo. Statement: Cleo is quiet.` on `dayStatement` →
    `fallback` / `parse`, and the returned statement does not contain `I'm a wolf`. An HTTP 200
    whose body is not JSON (`res.json()` throws) → `fallback` / `error`. Model text
    `{"target": null}` on a vote → `fallback` / `invalid`.
21. With a failing `fetch`, all eight methods return usable values and stamp
    `source: "fallback"`; `nightAction` is called with a werewolf, a seer and a doctor view.
    Separately: `nightAction` with a villager view returns `{ targetId: null }`, makes no
    `fetch` call and leaves the trace empty (`{}`). Calling any method without a trace argument
    does not throw.
22. `accuse` with `{"reasoning":"x","target":null}` → a pass with `source: "model"`.
    `accuse` with `{"reason":"Bram is my packmate so I'll frame Cleo","target":<legal id>}` →
    `targetId` set, `text` undefined, `source: "model"`. `accuse` with
    `{"reasoning":"r","target":<legal id>,"accusation":"Cleo dodged every question."}` → that
    text, and `trace.reasoning === "r"`.
22b. Wall-clock boundary: run `simulate` twice with the same seed, `id` and `createdAt`, every
    seat an `LlmBrain` over a `fetch` stub that always rejects. After deleting `latencyMs` from
    every record in `decisions`, `JSON.stringify` of the two transcripts is identical, and every
    record has a numeric `latencyMs` before stripping. (`latencyMs` is the only wall-clock field.)
22c. A prompt builder that throws (spy `nightPrompt` via `vi.spyOn` on the prompts module, or
    pass a view whose `players` getter throws) → the method resolves with the heuristic's
    decision, `fallback` / `error`, and no `fetch` call.

`src/lib/inspector.test.ts`
23. `inspect`: focus rules, sibling order, prev/next across empty steps and at both ends,
    stale `focusSeq` ignored, empty array.
24. `describeDecision` for each kind, including pass, "pack chose another", seer result, witch
    hold/heal/poison, and an undefined event.
25. `inspectorDwell` bounds (never below base, capped at 6000 / speed, base when no reasoning).
26. `provenanceSummary` counts, `byReason`, and `avgLatencyMs` null for bots.
27. `hasDecisions` false for a legacy transcript.
27b. `thinkingSeat`: `undefined` when Minds is off or `current` is null; otherwise
    `current.playerId`, including for a `hunter_shot` record (actor already dead) and for a
    non-produced record. Live rule: `inspect(decisions, edge, null)` at a narrator step (no
    record anchored there) has `current === null`, so `thinkingSeat` is `undefined`, and `prev`
    is the last record before the edge.

`src/lib/live.test.ts`
28. `decisionsThrough`: ordering, cursor advance, skipping records at or before `lastId`, and no
    output for an event with no anchored decisions.
29. `createLive` starts with `decisions: []`; `pushLiveDecision` appends and tolerates a game
    object without the field; unknown id is a no-op.

Components have no test setup in this repo; they are covered by the manual pass in task 13.

---

## 12. Ordered tasks

Each of tasks 1–8 leaves `npm test` green and can be its own commit. Recorded data ships before
any UI exists.

1. **Golden test.** Add `events-golden.test.ts` against untouched code. `npm test` → 131 + 1.
2. **Types.** Section 3. `npx tsc --noEmit` clean.
3. **Engine.** Section 4. Add `decisions.test.ts` cases 2, 3, 7–12 (including 8b) that do not depend on mock
   rationales (use scripted brains; assert `source: "unknown"` where relevant).
4. **MockBrain.** Section 5. Add cases 4–6. The golden, balance and determinism tests must stay
   green; if the golden test fails, an rng draw was added or reordered — fix the brain, never the
   literals.
5. **Prompts.** Section 6.1 plus tests 13–16.
6. **LlmBrain.** Section 6.2 plus `llmBrain.test.ts`.
7. **Live.** Sections 7.1–7.3 plus `live.test.ts`.
8. **Inspector logic.** `inspector.ts` plus `inspector.test.ts`.
9. **CSS + `MindInspector.tsx`.** Sections 9.1–9.2.
10. **ReplayPlayer.** Section 9.3, plus `thinkingId` in `GameTable`, `PlayerSeat`, `Scene3D` (9.5).
11. **LiveGame.** Section 9.4.
12. **README.** Section 9.6 text changes.
13. **Verify.**
    - `npm test` — all 131 pre-existing tests pass unmodified, plus the new ones.
    - `npx tsc --noEmit` — clean.
    - `npm run build` — succeeds.
    - `git diff --numstat -- "src/**/*.test.ts"` (run against the commit the work started from):
      the deletions column (second number) must be `0` for every pre-existing test file. Only
      `src/lib/agents/prompts.test.ts` may appear at all, with additions only. New test files
      are untracked or newly added and are not subject to this check.
    - Browser pass, against a production server. Run `npm run build`, then `npm start`, as two
      separate commands (`&&` is not supported by Windows PowerShell 5; it works in Git Bash).
      A 9-player mock game: toggle Minds in Classic and Cinematic, step `[` / `]` across a
      `wolf_kill` (sibling strip shows each wolf), find an accusation pass and a witch hold,
      find a hunter shot (the `💭` badge is on the dead hunter, upright, in both renderers),
      check 375 px width, confirm Minds off looks exactly as before. A live mock game: toggle
      Minds mid-stream (wolf chat appears in the feed at once), check narrator steps show
      "Narrator moment" with no badge, pin back, jump to live. An existing game from
      `data/games/`: Minds disabled with its tooltip, replay otherwise unchanged.
    - Capture `docs/screenshots/inspector.png` and add the image line (section 9.6).
    - **Unattended runs.** The last two items need a browser. If a browser tool is available,
      drive them with it. If not, do not skip them silently and do not block on them: finish
      everything else, leave the README without the image line, and list both items under
      "Deferred to the user" in the final report, with the exact steps above. The task counts
      as complete with those two items deferred and reported.

---

## 13. Rejected alternatives

- **Optional `decisions` field on existing events.** Simplest wiring (no SSE change), but cannot
  represent decisions that emit no event, and puts private text inside objects the feed and every
  event consumer already hold.
- **New `GameEvent` kind.** Shifts step indices and pacing defaults; needs edits in `deriveState`,
  `stepDelay`, `delayFor`, `cueFor`, and breaks the event-ordering tests.
- **`Brain.takeTrace()` side channel.** Per-decision state on a long-lived instance; a missed
  "take" attaches a stale trace to a later decision; awkward with `LlmBrain`'s inner `MockBrain`.
- **Engine-measured latency.** Violates the no-clock invariant.
- **Opt-in SSE (`?minds=1`).** Needs a reconnect on toggle, and roles already stream in `meta`.
- **Inspector as a full-width card below the stage.** Falls below the fold on a laptop, so the
  viewer cannot watch the table and read the mind at once.
