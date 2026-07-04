# Among LLMs v2 — Phase 1: Gameplay Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Hunter/Witch/Jester roles, a three-beat day (statements → accusations → defenses → vote), private wolf chat, and per-player dossiers to the deterministic Werewolf engine, with full mock-brain parity, LLM prompts, Elo handling for the neutral Jester, and replay rendering.

**Architecture:** Evolve the existing transcript engine (`simulate()` in `src/lib/engine/werewolf.ts`): extend the event vocabulary and `PlayerView`, add optional Brain methods with safe engine defaults, keep everything seeded/deterministic. UI renders new events in the existing replay player; private events (wolf chat, witch actions) gate on a `revealPrivate` flag.

**Tech Stack:** TypeScript, Next.js 15 App Router, Vitest, seeded mulberry32 PRNG. No new dependencies in this phase.

## Global Constraints

- Determinism is a hard invariant: same seed + same brains ⇒ byte-identical transcript.
- Every feature must work offline with MockBrain (zero-config parity).
- LlmBrain falls back to MockBrain heuristics on any error/timeout/parse failure (existing pattern; applies to all new methods).
- Table sizes 5–12 (`MIN_PLAYERS`/`MAX_PLAYERS` in `src/lib/engine/roles.ts`).
- Elo K=24 (`src/lib/elo.ts`).
- Old transcripts in `data/games/` must still replay (tolerate missing `by` on `saved` events; missing `asJester`/`history` on leaderboard entries).
- Run tests with `npm test` (vitest run); single file: `npx vitest run <path>`.

---

### Task 1: Types + role tables

**Files:**
- Modify: `src/lib/engine/types.ts`
- Modify: `src/lib/engine/roles.ts`
- Test: `src/lib/engine/werewolf.test.ts` (role-setup describe block)

**Interfaces produced (used by all later tasks):**
- `Role` gains `"hunter" | "witch" | "jester"`; `Alignment` gains `"neutral"`; new `Winner = "good" | "evil" | "jester"`; new `DeathCause = "wolves" | "vote" | "poison" | "hunter"`; new `ToggleableRole = "hunter" | "witch" | "jester"`.
- New records: `AccusationRecord {day, from, target, text}`, `DefenseRecord {day, playerId, text}`, `WolfChatRecord {day, wolfId, text}`, `WitchPotions {heal, poison}`, `AccuseDecision {targetId, text?}`, `WitchDecision {heal, poisonTargetId}`.
- `PlayerView` gains `accusations`, `defenses`, `wolfChat` (wolves only), `potions` (witch only, else null), `dossier: string`.
- `Brain` gains OPTIONAL methods: `wolfChat?(view, round)`, `accuse?(view)`, `defend?(view, against)`, `witchAction?(view, wolfTargetId)`, `hunterShot?(view)`.
- `GameConfig` gains `disabledRoles?: ToggleableRole[]`.
- New events: `wolf_chat`, `accusation`, `defense`, `witch_action`, `hunter_shot`; `saved` gains `by: "doctor" | "witch"`; `death.cause: DeathCause`; `game_over.winner: Winner`; `GameResult.winner: Winner`.
- `defaultRoleCounts(n, disabled?)` returns counts for all 7 roles per the spec table; `resolveRoleCounts` applies `config.disabledRoles` then `config.roleCounts`.

- [ ] **Step 1: Write failing tests** — replace the `role setup` describe in `src/lib/engine/werewolf.test.ts`:

```ts
describe("role setup", () => {
  it("derives the spec's 7-player distribution", () => {
    expect(defaultRoleCounts(7)).toEqual({
      werewolf: 2, seer: 1, doctor: 1, hunter: 1, witch: 0, jester: 0, villager: 2,
    });
  });

  it("matches the spec table for every size", () => {
    const wolves = { 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 3, 11: 3, 12: 4 } as Record<number, number>;
    for (let n = 5; n <= 12; n++) {
      const c = defaultRoleCounts(n);
      expect(c.werewolf).toBe(wolves[n]);
      expect(c.seer).toBe(1);
      expect(c.doctor).toBe(1);
      expect(c.hunter).toBe(n >= 6 ? 1 : 0);
      expect(c.witch).toBe(n >= 8 ? 1 : 0);
      expect(c.jester).toBe(n >= 9 ? 1 : 0);
      expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(n);
    }
  });

  it("replaces disabled specials with villagers", () => {
    const c = defaultRoleCounts(9, ["jester", "witch"]);
    expect(c.jester).toBe(0);
    expect(c.witch).toBe(0);
    expect(c.villager).toBe(4);
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(9);
  });

  it("deals every seat exactly one role", () => {
    const players = buildPlayers(makeConfig(8, 3), makeRng(3));
    expect(players).toHaveLength(8);
    expect(players.filter((p) => p.role === "werewolf").length).toBe(2);
    expect(new Set(players.map((p) => p.id)).size).toBe(8);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/engine/werewolf.test.ts` — expect FAIL (new roles unknown).

- [ ] **Step 3: Implement types.ts changes**

```ts
export type Role = "werewolf" | "seer" | "doctor" | "villager" | "hunter" | "witch" | "jester";
export type Alignment = "good" | "evil" | "neutral";
export type Winner = "good" | "evil" | "jester";
export type DeathCause = "wolves" | "vote" | "poison" | "hunter";
export type ToggleableRole = "hunter" | "witch" | "jester";

export const ALIGNMENT_OF: Record<Role, Alignment> = {
  werewolf: "evil", seer: "good", doctor: "good", villager: "good",
  hunter: "good", witch: "good", jester: "neutral",
};
```

`GameConfig` gains `disabledRoles?: ToggleableRole[]`. `DeathRecord.cause: DeathCause`. New interfaces:

```ts
export interface AccusationRecord { day: number; from: number; target: number; text: string; }
export interface DefenseRecord { day: number; playerId: number; text: string; }
export interface WolfChatRecord { day: number; wolfId: number; text: string; }
export interface WitchPotions { heal: boolean; poison: boolean; }
export interface AccuseDecision { targetId: number | null; text?: string; }
export interface WitchDecision { heal: boolean; poisonTargetId: number | null; }
```

`PlayerView` additions (after `votes`):

```ts
  accusations: AccusationRecord[];
  defenses: DefenseRecord[];
  wolfChat: WolfChatRecord[]; // wolves only; [] for everyone else
  potions: WitchPotions | null; // witch only
  dossier: string; // engine-built behavioral summary; "" until data exists
```

`Brain` optional methods (engine substitutes safe defaults when absent):

```ts
  wolfChat?(view: PlayerView, round: number): Promise<string>;
  accuse?(view: PlayerView): Promise<AccuseDecision>;
  defend?(view: PlayerView, against: AccusationRecord[]): Promise<string>;
  witchAction?(view: PlayerView, wolfTargetId: number | null): Promise<WitchDecision>;
  hunterShot?(view: PlayerView): Promise<{ targetId: number | null }>;
```

Event union changes:

```ts
  | { kind: "wolf_chat"; day: number; wolfId: number; text: string }
  | { kind: "accusation"; day: number; from: number; target: number; text: string }
  | { kind: "defense"; day: number; playerId: number; text: string }
  | { kind: "witch_action"; day: number; witchId: number; action: "heal" | "poison"; targetId: number }
  | { kind: "hunter_shot"; day: number; hunterId: number; targetId: number }
  | { kind: "saved"; day: number; targetId: number; by: "doctor" | "witch" }
  | { kind: "death"; day: number; playerId: number; cause: DeathCause; role: Role }
  | { kind: "game_over"; winner: Winner; reason: string; survivorIds: number[] };
```

`GameResult.winner: Winner`.

- [ ] **Step 4: Implement roles.ts**

```ts
const WOLVES_BY_SIZE: Record<number, number> = { 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 3, 11: 3, 12: 4 };
const SPECIALS_BY_SIZE: Record<number, Role[]> = {
  5: ["seer", "doctor"],
  6: ["seer", "doctor", "hunter"],
  7: ["seer", "doctor", "hunter"],
  8: ["seer", "doctor", "hunter", "witch"],
  9: ["seer", "doctor", "hunter", "witch", "jester"],
  10: ["seer", "doctor", "hunter", "witch", "jester"],
  11: ["seer", "doctor", "hunter", "witch", "jester"],
  12: ["seer", "doctor", "hunter", "witch", "jester"],
};

export function defaultRoleCounts(n: number, disabled: ToggleableRole[] = []): Record<Role, number> {
  const clamped = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
  const counts: Record<Role, number> = {
    werewolf: WOLVES_BY_SIZE[clamped], seer: 0, doctor: 0, hunter: 0, witch: 0, jester: 0, villager: 0,
  };
  for (const role of SPECIALS_BY_SIZE[clamped]) {
    if ((disabled as Role[]).includes(role)) continue;
    counts[role] += 1;
  }
  const nonVillager = (Object.keys(counts) as Role[])
    .filter((r) => r !== "villager")
    .reduce((acc, r) => acc + counts[r], 0);
  counts.villager = Math.max(0, clamped - nonVillager);
  return counts;
}

export function resolveRoleCounts(config: GameConfig): Record<Role, number> {
  const base = defaultRoleCounts(config.numPlayers, config.disabledRoles ?? []);
  if (!config.roleCounts) return base;
  return { ...base, ...config.roleCounts } as Record<Role, number>;
}
```

- [ ] **Step 5: Run** `npx vitest run src/lib/engine/werewolf.test.ts` — role-setup tests PASS (other suites may fail on `winner` typing; fixed in Task 2 — if so, note and continue).
- [ ] **Step 6: Commit** `feat(engine): add hunter/witch/jester roles, neutral alignment, phase-1 types`

---

### Task 2: Engine — parity/winner + three-beat day + wolf chat

**Files:**
- Modify: `src/lib/engine/werewolf.ts`
- Test: `src/lib/engine/werewolf.test.ts`

**Interfaces:**
- Consumes Task 1 types.
- Produces: `winnerFor(aliveWolves: number, aliveNonWolves: number)` (renamed meaning of arg 2), `applyDeath` internal helper, day beats emitting `accusation`/`defense` events, night `wolf_chat` events, rotating statement order.

- [ ] **Step 1: Write failing tests** (add to werewolf.test.ts):

```ts
describe("three-beat day + wolf chat", () => {
  it("orders day events statements → accusations → defenses → votes", async () => {
    const t = await mockGame(9, 42);
    const day1 = t.events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => "day" in e && e.day === 1 && ["statement", "accusation", "defense", "vote"].includes(e.kind));
    const rank = { statement: 0, accusation: 1, defense: 2, vote: 3 } as Record<string, number>;
    for (let j = 1; j < day1.length; j++) {
      expect(rank[day1[j].e.kind]).toBeGreaterThanOrEqual(rank[day1[j - 1].e.kind]);
    }
  });

  it("wolf chat only happens with 2+ wolves and only wolves speak in it", async () => {
    const t9 = await mockGame(9, 7); // 2 wolves
    const wolfIds = new Set(t9.players.filter((p) => p.role === "werewolf").map((p) => p.id));
    const chats = t9.events.filter((e) => e.kind === "wolf_chat");
    for (const c of chats) expect(wolfIds.has(c.wolfId)).toBe(true);

    const t5 = await mockGame(5, 7); // 1 wolf → no chat
    expect(t5.events.some((e) => e.kind === "wolf_chat")).toBe(false);
  });

  it("accusations target living non-self players; defenses come from the accused", async () => {
    const t = await mockGame(9, 99);
    const aliveAt = new Set(t.players.map((p) => p.id));
    for (const e of t.events) {
      if (e.kind === "death") aliveAt.delete(e.playerId);
      if (e.kind === "accusation") {
        expect(e.from).not.toBe(e.target);
        expect(aliveAt.has(e.target)).toBe(true);
        expect(aliveAt.has(e.from)).toBe(true);
      }
    }
    const accusedByDay = new Map<number, Set<number>>();
    for (const e of t.events) {
      if (e.kind === "accusation") {
        if (!accusedByDay.has(e.day)) accusedByDay.set(e.day, new Set());
        accusedByDay.get(e.day)!.add(e.target);
      }
      if (e.kind === "defense") expect(accusedByDay.get(e.day)?.has(e.playerId)).toBe(true);
    }
  });
});
```

Also update the `pure helpers` winnerFor test (arg 2 is now all living non-wolves — same numbers still pass) and the `full games` winner assertion to `expect(["good", "evil", "jester"]).toContain(t.result.winner)` and outcomes check to:

```ts
for (const o of t.outcomes) {
  const expected = t.result.winner === "jester" ? o.role === "jester" : o.alignment === t.result.winner;
  expect(o.won).toBe(expected);
}
```

- [ ] **Step 2: Run — FAIL** (no accusation events emitted yet; mock brains lack accuse until Task 5, so the ordering test passes vacuously — the wolf-chat test drives the engine change; accusation legality is re-verified after Task 5).

- [ ] **Step 3: Implement in werewolf.ts**

MutableState gains:

```ts
  accusations: AccusationRecord[];
  defenses: DefenseRecord[];
  wolfChat: WolfChatRecord[];
  witchPotions: Map<number, WitchPotions>;
  hunterFired: Set<number>;
```

(initialize all in `simulate`). `buildView` additions:

```ts
    accusations: s.accusations.slice(),
    defenses: s.defenses.slice(),
    wolfChat: self.alignment === "evil" ? s.wolfChat.slice() : [],
    potions: self.role === "witch" ? { ...(s.witchPotions.get(self.id) ?? { heal: true, poison: true }) } : null,
    dossier: "", // wired in Task 4
```

Winner/parity:

```ts
export function winnerFor(aliveWolves: number, aliveNonWolves: number): { winner: Winner; reason: string } | null {
  if (aliveWolves === 0) return { winner: "good", reason: "Every werewolf has been eliminated." };
  if (aliveWolves >= aliveNonWolves)
    return { winner: "evil", reason: "The werewolves reached parity with the village." };
  return null;
}

function checkWin(s: MutableState): { winner: Winner; reason: string } | null {
  const wolves = countAlive(s, "evil");
  return winnerFor(wolves, alivePlayers(s).length - wolves);
}
```

Central death helper (replace both inline death blocks):

```ts
function applyDeath(s: MutableState, events: GameEvent[], day: number, playerId: number, cause: DeathCause): void {
  const victim = s.players[playerId];
  if (!victim.alive) return;
  victim.alive = false;
  s.deaths.push({ day, playerId, cause, role: victim.role });
  events.push({ kind: "death", day, playerId, cause, role: victim.role });
}
```

Wolf chat — insert at the top of the night section, before the kill vote. NOTE: the kill-vote block below it already declares `const wolves`; move that single declaration up so it is declared once and reused by both blocks:

```ts
    const wolves = alivePlayers(state).filter((p) => p.role === "werewolf");
    if (wolves.length >= 2) {
      for (let round = 1; round <= 2; round++) {
        for (const w of wolves) {
          if (!w.alive) continue;
          const raw = await brains.get(w.id)!.wolfChat?.(buildView(state, w, "night", day), round);
          const text = (raw ?? "").trim().slice(0, 240);
          if (!text) continue;
          state.wolfChat.push({ day, wolfId: w.id, text });
          events.push({ kind: "wolf_chat", day, wolfId: w.id, text });
        }
      }
    }
```

Rotating statements (replace the shuffle):

```ts
    const aliveIds = alivePlayers(state).map((p) => p.id);
    const offset = (day - 1) % aliveIds.length;
    const speakers = [...aliveIds.slice(offset), ...aliveIds.slice(0, offset)];
```

Accusation + defense beats — insert between statements and voting:

```ts
    // Accusations: each living player may formally accuse one player.
    const todaysAccusations: AccusationRecord[] = [];
    for (const sid of speakers) {
      const accuser = state.players[sid];
      if (!accuser.alive) continue;
      const decision =
        (await brains.get(sid)!.accuse?.(buildView(state, accuser, "day", day))) ?? { targetId: null };
      if (decision.targetId === null) continue;
      const legal = alivePlayers(state).filter((p) => p.id !== sid).map((p) => p.id);
      if (!legal.includes(decision.targetId)) continue;
      const text =
        (decision.text ?? "").trim().slice(0, 240) || `I accuse ${state.players[decision.targetId].name}.`;
      const rec: AccusationRecord = { day, from: sid, target: decision.targetId, text };
      todaysAccusations.push(rec);
      state.accusations.push(rec);
      events.push({ kind: "accusation", day, from: sid, target: decision.targetId, text });
    }

    // Defenses: each accused player responds once, in seat order.
    const accusedIds = [...new Set(todaysAccusations.map((a) => a.target))].sort((a, b) => a - b);
    for (const aid of accusedIds) {
      const accused = state.players[aid];
      if (!accused.alive) continue;
      const against = todaysAccusations.filter((a) => a.target === aid);
      const raw = await brains.get(aid)!.defend?.(buildView(state, accused, "day", day), against);
      const text = (raw ?? "").trim().slice(0, 280);
      if (!text) continue;
      state.defenses.push({ day, playerId: aid, text });
      events.push({ kind: "defense", day, playerId: aid, text });
    }
```

`deathSummary` covers all night causes:

```ts
  const last = deaths.filter((d) => d.day === day && d.cause !== "vote");
```

Max-days fallback + outcomes:

```ts
    const wolvesLeft = countAlive(state, "evil");
    const others = alivePlayers(state).length - wolvesLeft;
    outcome = others > wolvesLeft
      ? { winner: "good", reason: "Day limit reached — the village held the majority." }
      : { winner: "evil", reason: "Day limit reached — the wolves were never rooted out." };
```

```ts
    won: outcome!.winner === "jester" ? p.role === "jester" : p.alignment === outcome!.winner,
```

Type `outcome` as `{ winner: Winner; reason: string } | null`. The vote-death block becomes `applyDeath(state, events, day, eliminatedId, "vote")` (jester/hunter handling arrives in Task 3).

- [ ] **Step 4: Run** `npx vitest run src/lib/engine/werewolf.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(engine): three-beat day, wolf chat, rotating speakers, neutral-aware parity`

---

### Task 3: Engine — Witch, Hunter, Jester

**Files:**
- Modify: `src/lib/engine/werewolf.ts`
- Test: `src/lib/engine/werewolf.test.ts`

**Interfaces:**
- Produces: night witch step (heal precedence, one potion/night, single-use), `saved.by`, poison deaths, `fireHunter` (runs after night deaths and after vote deaths, before win checks), jester vote-out → immediate `game_over` with winner `"jester"`.

- [ ] **Step 1: Write failing tests** — scripted-brain tests. Extend the scripted factory pattern (5 players is too small for specials, so scripted tests use explicit `roleCounts`):

```ts
describe("witch, hunter, jester (scripted)", () => {
  const CFG = (seed: number, roleCounts: Partial<Record<Role, number>>, n = 7): GameConfig => ({
    numPlayers: n, seatModels: Array(n).fill("mock"), seed, roleCounts,
  });

  function brainsFor(
    players: Player[],
    script: {
      wolfTarget?: (p: Player[]) => number;
      witch?: (view: PlayerView, wolfTarget: number | null) => WitchDecision;
      hunterTarget?: (p: Player[]) => number;
      votes?: (self: Player, p: Player[]) => number | null;
    }
  ): BrainFactory {
    return (modelId, seatId) => ({
      id: modelId,
      async nightAction() {
        const role = players[seatId].role;
        if (role === "werewolf" && script.wolfTarget) return { targetId: script.wolfTarget(players) };
        return { targetId: null };
      },
      async dayStatement() { return "…"; },
      async dayVote() { return { targetId: script.votes ? script.votes(players[seatId], players) : null }; },
      async witchAction(view, wolfTargetId) {
        return script.witch ? script.witch(view, wolfTargetId) : { heal: false, poisonTargetId: null };
      },
      async hunterShot() {
        return { targetId: script.hunterTarget ? script.hunterTarget(players) : null };
      },
    });
  }

  it("witch heal cancels the wolf kill and is single-use; poison is unblockable", async () => {
    const config = CFG(11, { werewolf: 1, seer: 0, doctor: 0, witch: 1, hunter: 0, jester: 0, villager: 5 });
    const players = buildPlayers(config, makeRng(11));
    const victim = players.find((p) => p.role === "villager")!.id;
    const factory = brainsFor(players, {
      wolfTarget: () => victim,
      witch: (view, wolfTarget) =>
        view.potions?.heal && wolfTarget !== null
          ? { heal: true, poisonTargetId: null }
          : { heal: false, poisonTargetId: null },
    });
    const t = await simulate(config, factory, OPTS);
    const saves = t.events.filter((e) => e.kind === "saved" && e.by === "witch");
    expect(saves.length).toBe(1); // heal potion spent on night 1, never again
    expect(t.events.some((e) => e.kind === "death" && e.day === 1)).toBe(false);
  });

  it("witch poison kills even a doctor-protected player", async () => {
    const config = CFG(13, { werewolf: 1, seer: 0, doctor: 1, witch: 1, hunter: 0, jester: 0, villager: 4 });
    const players = buildPlayers(config, makeRng(13));
    const mark = players.find((p) => p.role === "villager")!.id;
    const factory: BrainFactory = (modelId, seatId) => ({
      id: modelId,
      async nightAction() {
        if (players[seatId].role === "doctor") return { targetId: mark }; // protects the poison target
        return { targetId: null }; // wolf abstains (engine will re-roll: pass legal null through validate → random) — so instead wolf targets the witch's mark too
      },
      async dayStatement() { return "…"; },
      async dayVote() { return { targetId: null }; },
      async witchAction() { return { heal: false, poisonTargetId: mark }; },
    });
    const t = await simulate(config, factory, OPTS);
    const poisonDeath = t.events.find((e) => e.kind === "death" && e.cause === "poison");
    expect(poisonDeath && poisonDeath.playerId === mark).toBe(true);
  });

  it("a hunter voted out drags a target down before the win check", async () => {
    const config = CFG(17, { werewolf: 2, seer: 0, doctor: 0, witch: 0, hunter: 1, jester: 0, villager: 4 });
    const players = buildPlayers(config, makeRng(17));
    const hunter = players.find((p) => p.role === "hunter")!.id;
    const wolf = players.find((p) => p.role === "werewolf")!.id;
    const factory = brainsFor(players, {
      hunterTarget: () => wolf,
      votes: () => hunter, // everyone votes the hunter out on day 1
    });
    const t = await simulate(config, factory, OPTS);
    const shot = t.events.find((e) => e.kind === "hunter_shot");
    expect(shot).toBeTruthy();
    expect(shot!.hunterId).toBe(hunter);
    expect(shot!.targetId).toBe(wolf);
    expect(t.events.some((e) => e.kind === "death" && e.cause === "hunter" && e.playerId === wolf)).toBe(true);
  });

  it("voting out the jester ends the game immediately with a jester win", async () => {
    const config = CFG(23, { werewolf: 2, seer: 0, doctor: 0, witch: 0, hunter: 0, jester: 1, villager: 4 });
    const players = buildPlayers(config, makeRng(23));
    const jester = players.find((p) => p.role === "jester")!.id;
    const factory = brainsFor(players, { votes: () => jester });
    const t = await simulate(config, factory, OPTS);
    expect(t.result.winner).toBe("jester");
    expect(t.events.at(-1)?.kind).toBe("game_over");
    for (const o of t.outcomes) expect(o.won).toBe(o.role === "jester");
  });
});
```

Imports needed in the test file: `Role`, `Player`, `PlayerView`, `WitchDecision` from `./types`.
Note the second test's wolf: `nightAction` returning `{targetId: null}` for a wolf gets re-rolled to a random legal target by `validateTarget` — that's fine for the poison assertion, which only checks the poison death.

- [ ] **Step 2: Run — FAIL** (no witch/hunter/jester logic yet).

- [ ] **Step 3: Implement in werewolf.ts** — after the doctor block in the night section:

```ts
    // Witch: sees the wolves' target; one potion per night, each single-use.
    const healedIds = new Set<number>();
    let poisonTarget: number | null = null;
    for (const witch of alivePlayers(state).filter((p) => p.role === "witch")) {
      if (!state.witchPotions.has(witch.id)) state.witchPotions.set(witch.id, { heal: true, poison: true });
      const potions = state.witchPotions.get(witch.id)!;
      const decision =
        (await brains.get(witch.id)!.witchAction?.(buildView(state, witch, "night", day), killTarget)) ??
        { heal: false, poisonTargetId: null };
      if (decision.heal && potions.heal && killTarget !== null) {
        potions.heal = false;
        healedIds.add(killTarget);
        events.push({ kind: "witch_action", day, witchId: witch.id, action: "heal", targetId: killTarget });
      } else if (decision.poisonTargetId !== null && potions.poison) {
        const legal = alivePlayers(state).filter((p) => p.id !== witch.id).map((p) => p.id);
        if (legal.includes(decision.poisonTargetId)) {
          potions.poison = false;
          poisonTarget = decision.poisonTargetId;
          events.push({ kind: "witch_action", day, witchId: witch.id, action: "poison", targetId: poisonTarget });
        }
      }
    }
```

Night kill resolution becomes:

```ts
    if (killTarget !== null) {
      if (protectedIds.has(killTarget)) {
        events.push({ kind: "saved", day, targetId: killTarget, by: "doctor" });
      } else if (healedIds.has(killTarget)) {
        events.push({ kind: "saved", day, targetId: killTarget, by: "witch" });
      } else {
        applyDeath(state, events, day, killTarget, "wolves");
      }
    }
    if (poisonTarget !== null) applyDeath(state, events, day, poisonTarget, "poison");
    await fireHunter(state, events, brains, rng, day, "night");
```

The hunter helper (module-level, above `simulate`):

```ts
async function fireHunter(
  s: MutableState,
  events: GameEvent[],
  brains: Map<number, Brain>,
  rng: Rng,
  day: number,
  phase: "night" | "day"
): Promise<void> {
  const fallen = s.deaths.filter((d) => d.role === "hunter" && !s.hunterFired.has(d.playerId));
  for (const d of fallen) {
    s.hunterFired.add(d.playerId);
    const hunter = s.players[d.playerId];
    const legal = alivePlayers(s).map((p) => p.id);
    if (legal.length === 0) continue;
    const decision = (await brains.get(hunter.id)!.hunterShot?.(buildView(s, hunter, phase, day))) ?? { targetId: null };
    const target = validateTarget(decision.targetId, legal, rng);
    if (target === null) continue;
    events.push({ kind: "hunter_shot", day, hunterId: hunter.id, targetId: target });
    applyDeath(s, events, day, target, "hunter");
  }
}
```

Vote-death block becomes:

```ts
    if (eliminatedId !== null) {
      const victim = state.players[eliminatedId];
      applyDeath(state, events, day, eliminatedId, "vote");
      if (victim.role === "jester") {
        outcome = {
          winner: "jester",
          reason: `${victim.name} baited the village into the vote. The Jester wins alone.`,
        };
        break;
      }
      await fireHunter(state, events, brains, rng, day, "day");
    }
```

- [ ] **Step 4: Run** `npx vitest run src/lib/engine/werewolf.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(engine): witch potions, hunter revenge shot, jester solo win`

---

### Task 4: Dossier

**Files:**
- Create: `src/lib/engine/dossier.ts`
- Create: `src/lib/engine/dossier.test.ts`
- Modify: `src/lib/engine/werewolf.ts` (`buildView` wires `dossier`)

**Interfaces:**
- Produces: `buildDossier(players, votes, accusations, deaths): string` — deterministic, one line per living player, "" when no history.

- [ ] **Step 1: Failing test** (`src/lib/engine/dossier.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { buildDossier } from "./dossier";

const players = [
  { id: 0, name: "Ada", alive: true },
  { id: 1, name: "Bram", alive: true },
  { id: 2, name: "Cyra", alive: false },
];

describe("buildDossier", () => {
  it("is empty before any history exists", () => {
    expect(buildDossier(players, [], [], [])).toBe("");
  });

  it("summarizes votes, accusations, and votes against revealed innocents", () => {
    const votes = [{ day: 1, voterId: 0, targetId: 2 }];
    const accusations = [{ day: 1, from: 1, target: 0, text: "sus" }];
    const deaths = [{ day: 1, playerId: 2, cause: "vote" as const, role: "villager" as const }];
    const d = buildDossier(players, votes, accusations, deaths);
    expect(d).toContain("Ada: voted: Cyra(D1)");
    expect(d).toContain("1 vote(s) against players revealed innocent");
    expect(d).toContain("Bram: accused: Ada(D1)");
    expect(d).toContain("Ada");
    expect(d).not.toContain("Cyra:"); // dead players get no line
  });
});
```

- [ ] **Step 2: Run — FAIL.** `npx vitest run src/lib/engine/dossier.test.ts`

- [ ] **Step 3: Implement** `src/lib/engine/dossier.ts`:

```ts
// Deterministic per-player behavioral summary injected into prompts so agents
// can cite history ("you voted with the dead wolf on day 2") without the
// engine shipping full verbatim history every day.

import { AccusationRecord, DeathRecord, VoteRecord } from "./types";

interface DossierPlayer { id: number; name: string; alive: boolean; }

export function buildDossier(
  players: DossierPlayer[],
  votes: VoteRecord[],
  accusations: AccusationRecord[],
  deaths: DeathRecord[]
): string {
  if (votes.length === 0 && accusations.length === 0) return "";
  const name = (id: number) => players.find((p) => p.id === id)?.name ?? `Seat ${id}`;
  const revealedInnocents = new Set(deaths.filter((d) => d.role !== "werewolf").map((d) => d.playerId));
  const lines: string[] = [];
  for (const p of players) {
    if (!p.alive) continue;
    const cast = votes.filter((v) => v.voterId === p.id && v.targetId !== null);
    const made = accusations.filter((a) => a.from === p.id);
    const received = accusations.filter((a) => a.target === p.id).length;
    const badVotes = cast.filter((v) => revealedInnocents.has(v.targetId!)).length;
    const parts: string[] = [];
    if (cast.length) parts.push(`voted: ${cast.map((v) => `${name(v.targetId!)}(D${v.day})`).join(", ")}`);
    if (made.length) parts.push(`accused: ${made.map((a) => `${name(a.target)}(D${a.day})`).join(", ")}`);
    if (received) parts.push(`accused by ${received}`);
    if (badVotes) parts.push(`${badVotes} vote(s) against players revealed innocent`);
    if (parts.length) lines.push(`${p.name}: ${parts.join("; ")}`);
  }
  return lines.join("\n");
}
```

In `werewolf.ts` `buildView`, replace `dossier: ""` with `dossier: buildDossier(s.players, s.votes, s.accusations, s.deaths),` and add `import { buildDossier } from "./dossier";` at the top.

- [ ] **Step 4: Run both engine test files — PASS.**
- [ ] **Step 5: Commit** `feat(engine): behavioral dossier in every PlayerView`

---

### Task 5: MockBrain — full parity for the new powers

**Files:**
- Modify: `src/lib/agents/mockBrain.ts`
- Test: `src/lib/engine/werewolf.test.ts` (legality + determinism already cover it; add mock-specific assertions)

**Interfaces:**
- Produces: `MockBrain` implements `wolfChat`, `accuse`, `defend`, `witchAction`, `hunterShot`; jester-flavored `dayStatement`/`dayVote`/`accuse` behavior.

- [ ] **Step 1: Failing tests** (append to `full games` describe):

```ts
  it("mock games at 9+ players produce wolf chat, accusations, and defenses", async () => {
    let chats = 0, accusations = 0, defenses = 0;
    for (const seed of [3, 11, 29]) {
      const t = await mockGame(9, seed);
      chats += t.events.filter((e) => e.kind === "wolf_chat").length;
      accusations += t.events.filter((e) => e.kind === "accusation").length;
      defenses += t.events.filter((e) => e.kind === "defense").length;
    }
    expect(chats).toBeGreaterThan(0);
    expect(accusations).toBeGreaterThan(0);
    expect(defenses).toBeGreaterThan(0);
  });

  it("witch and hunter mock heuristics only ever act legally", async () => {
    for (let seed = 100; seed < 120; seed++) {
      const t = await mockGame(10, seed);
      const witchActs = t.events.filter((e) => e.kind === "witch_action");
      expect(witchActs.filter((e) => e.action === "heal").length).toBeLessThanOrEqual(1);
      expect(witchActs.filter((e) => e.action === "poison").length).toBeLessThanOrEqual(1);
      for (const e of t.events) {
        if (e.kind === "hunter_shot") expect(e.hunterId).not.toBe(e.targetId);
      }
    }
  });
```

- [ ] **Step 2: Run — FAIL** (no chats/accusations emitted).

- [ ] **Step 3: Implement in mockBrain.ts.** New templates after the existing `TEMPLATES`:

```ts
const WOLF_CHAT_PROPOSE = [
  "I say we take {target} tonight — they're steering the village too well.",
  "{target} worries me. One bite and the problem is gone.",
  "Let's silence {target} before they put it together.",
];
const WOLF_CHAT_AGREE = [
  "Agreed. {target} doesn't see the dawn.",
  "Fine by me. {target} it is.",
  "Then it's settled — {target}.",
];
const ACCUSE_FORMAL = [
  "I formally accuse {target}. Their votes never add up.",
  "It has to be {target}. Watch who they defend.",
  "{target} has dodged every hard question. I accuse them.",
];
const JESTER_LINES = [
  "Strange, isn't it, how I always seem to know where the bodies are…",
  "Vote how you must. I was out walking by the mill last night, that's all.",
  "Honestly? I wouldn't even blame you for voting me out. Just saying.",
];

function fillTarget(template: string, targetName: string): string {
  return template.replace(/\{target\}/g, targetName);
}
```

Extract the wolf's target-picking logic from `nightAction` into a private method `wolfPick(view): number | null` (seer claimants first, then threat score — identical code) and reuse it in both `nightAction` and `wolfChat`. New methods on the class:

```ts
  async wolfChat(view: PlayerView, round: number): Promise<string> {
    const target = this.wolfPick(view);
    if (target === null) return "";
    const pool = round === 1 ? WOLF_CHAT_PROPOSE : WOLF_CHAT_AGREE;
    return fillTarget(pick(this.rng, pool), nameOf(view, target));
  }

  async accuse(view: PlayerView) {
    const others = aliveOthers(view);
    if (others.length === 0) return { targetId: null };
    if (view.self.role === "jester") {
      // Draw a little fire without being obvious.
      if (this.rng() < 0.4) return { targetId: null };
      const target = pick(this.rng, others);
      return { targetId: target, text: fillTarget(pick(this.rng, ACCUSE_FORMAL), nameOf(view, target)) };
    }
    if (view.self.alignment === "evil") {
      const nonWolves = others.filter((id) => !view.knownWolves.includes(id));
      const pool = nonWolves.length ? nonWolves : others;
      const target =
        leaderOf(buddySuspicion(view), this.rng, pool) ??
        primeSuspect(view, this.rng, view.knownWolves) ??
        pick(this.rng, pool);
      return { targetId: target, text: fillTarget(pick(this.rng, ACCUSE_FORMAL), nameOf(view, target)) };
    }
    if (view.self.role === "seer") {
      const wolf = knownLiveWolfForSeer(view);
      if (wolf !== null)
        return { targetId: wolf, text: fillTarget(pick(this.rng, ACCUSE_FORMAL), nameOf(view, wolf)) };
    }
    const suspect =
      leaderOf(activeSeerClaims(view), this.rng, others) ?? leaderOf(buddySuspicion(view), this.rng, others);
    if (suspect === null || this.rng() > 0.35 + 0.5 * this.style.aggression) return { targetId: null };
    return { targetId: suspect, text: fillTarget(pick(this.rng, ACCUSE_FORMAL), nameOf(view, suspect)) };
  }

  async defend(view: PlayerView): Promise<string> {
    return render(view, "defend", null, this.rng);
  }

  async witchAction(view: PlayerView, wolfTargetId: number | null) {
    const claimants = seerClaimants(view);
    if (
      view.potions?.heal &&
      wolfTargetId !== null &&
      (wolfTargetId === view.self.id || claimants.includes(wolfTargetId))
    ) {
      return { heal: true, poisonTargetId: null };
    }
    if (view.potions?.poison) {
      const confirmed = leaderOf(activeSeerClaims(view), this.rng, aliveOthers(view));
      if (confirmed !== null) return { heal: false, poisonTargetId: confirmed };
    }
    return { heal: false, poisonTargetId: null };
  }

  async hunterShot(view: PlayerView) {
    const others = view.aliveIds.filter((id) => id !== view.self.id);
    if (others.length === 0) return { targetId: null };
    const confirmed = leaderOf(activeSeerClaims(view), this.rng, others);
    const target = confirmed ?? primeSuspect(view, this.rng) ?? pick(this.rng, others);
    return { targetId: target };
  }
```

Jester flavor in `dayStatement` (insert before the evil branch):

```ts
    if (view.self.role === "jester") {
      return this.rng() < 0.5 ? pick(this.rng, JESTER_LINES) : render(view, "neutral", null, this.rng);
    }
```

and in `dayVote` (insert before the evil branch):

```ts
    if (view.self.role === "jester") {
      const ps = primeSuspect(view, this.rng);
      return { targetId: ps ?? pick(this.rng, others) };
    }
```

- [ ] **Step 4: Run** `npx vitest run src/lib/engine/werewolf.test.ts` — PASS (including determinism + legality suites).
- [ ] **Step 5: Commit** `feat(agents): mock-brain parity for wolf chat, accusations, witch, hunter, jester`

---

### Task 6: Prompts + parsers for the new beats

**Files:**
- Modify: `src/lib/agents/prompts.ts`
- Create: `src/lib/agents/prompts.test.ts`

**Interfaces:**
- Produces: `wolfChatPrompt(view, round)`, `accusePrompt(view)`, `defendPrompt(view, against)`, `witchPrompt(view, wolfTargetId)`, `hunterPrompt(view)`, `parseTextResponse(text, keys)`, `parseWitchResponse(text, view): WitchDecision | null`. `buildContext` gains accusations/defenses/wolf-chat/dossier sections and limits verbatim discussion to the last 2 days.

- [ ] **Step 1: Failing tests** (`src/lib/agents/prompts.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { parseTextResponse, parseWitchResponse, parseTargetResponse } from "./prompts";
import { PlayerView } from "../engine/types";

const view = {
  self: { id: 0, name: "Ada", role: "witch", alignment: "good", model: "mock" },
  day: 1, phase: "night",
  players: [
    { id: 0, name: "Ada", avatar: "🦊", alive: true },
    { id: 1, name: "Bram", avatar: "🐻", alive: true },
  ],
  aliveIds: [0, 1], knownWolves: [], seerResults: [], lastProtectedId: null,
  deaths: [], statements: [], votes: [], accusations: [], defenses: [], wolfChat: [],
  potions: { heal: true, poison: true }, dossier: "",
} as unknown as PlayerView;

describe("parseTextResponse", () => {
  it("reads the first matching key", () => {
    expect(parseTextResponse('{"message": "we strike"}', ["message"])).toBe("we strike");
    expect(parseTextResponse('```json\n{"statement":"hello"}\n```', ["statement"])).toBe("hello");
  });
  it("falls back to short raw text", () => {
    expect(parseTextResponse("Just my words", ["statement"])).toBe("Just my words");
    expect(parseTextResponse("", ["statement"])).toBeNull();
  });
});

describe("parseWitchResponse", () => {
  it("parses heal and poison variants", () => {
    expect(parseWitchResponse('{"heal": true, "poison": null}', view)).toEqual({ heal: true, poisonTargetId: null });
    expect(parseWitchResponse('{"heal": false, "poison": 1}', view)).toEqual({ heal: false, poisonTargetId: 1 });
    expect(parseWitchResponse('{"heal": false, "poison": "Bram"}', view)).toEqual({ heal: false, poisonTargetId: 1 });
    expect(parseWitchResponse("gibberish", view)).toBeNull();
  });
});

describe("parseTargetResponse", () => {
  it("still resolves names and numbers", () => {
    expect(parseTargetResponse('{"target": "Bram"}', view)).toBe(1);
    expect(parseTargetResponse('{"target": 1}', view)).toBe(1);
  });
});
```

- [ ] **Step 2: Run — FAIL** (`npx vitest run src/lib/agents/prompts.test.ts`).

- [ ] **Step 3: Implement.** `ROLE_BRIEF` additions:

```ts
  hunter:
    "You are the HUNTER. You have no night action, but the moment you die — night kill or day vote — you immediately shoot one player, who dies too. Choose your revenge wisely.",
  witch:
    "You are the WITCH. You hold two single-use potions: a HEAL (each night you learn who the wolves attacked and may save them) and a POISON (kill any player at night). At most one potion per night. Spend them at the perfect moment.",
  jester:
    "You are the JESTER. You win ALONE if the village votes you out during the day. Getting killed at night is a loss. Act just suspicious enough to attract the rope — without being so obvious the village smells the act.",
```

`buildContext` additions (insert between discussion and votes sections):

```ts
    "",
    "Formal accusations so far:",
    recentAccusations(view),
    "",
    "Defenses so far:",
    recentDefenses(view),
    ...(view.wolfChat.length
      ? ["", "Your pack's private chat:", view.wolfChat.slice(-8).map((c) => `  ${nameOf(view, c.wolfId)}: "${c.text}"`).join("\n")]
      : []),
    ...(view.dossier ? ["", "Behavioral dossier (public record):", view.dossier] : []),
```

with helpers:

```ts
function recentAccusations(view: PlayerView): string {
  const recent = view.accusations.filter((a) => a.day >= view.day - 1);
  if (recent.length === 0) return "(none)";
  return recent
    .map((a) => `  D${a.day}: ${nameOf(view, a.from)} accused ${nameOf(view, a.target)} — "${a.text}"`)
    .join("\n");
}

function recentDefenses(view: PlayerView): string {
  const recent = view.defenses.filter((d) => d.day >= view.day - 1);
  if (recent.length === 0) return "(none)";
  return recent.map((d) => `  D${d.day}: ${nameOf(view, d.playerId)}: "${d.text}"`).join("\n");
}
```

and `recentDiscussion` limited to the last 2 days: `const recent = view.statements.filter((s) => s.day >= view.day - 1).slice(-limit);`

New prompts:

```ts
export function wolfChatPrompt(view: PlayerView, round: number): string {
  return [
    buildContext(view),
    "",
    `It is NIGHT ${view.day}. Private werewolf pack chat, round ${round} of 2. Coordinate the kill with your packmates in ONE short sentence.`,
    'Respond as JSON: {"message": "<your message to the pack>"}',
  ].join("\n");
}

export function accusePrompt(view: PlayerView): string {
  const legal = view.aliveIds.filter((id) => id !== view.self.id);
  return [
    buildContext(view),
    "",
    `It is DAY ${view.day}, formal accusation round. You may accuse ONE player (with a reason the table will hear) or pass.`,
    `Legal seat ids: [${legal.join(", ")}]. Pass with target null.`,
    'Respond as JSON: {"target": <seat id or null>, "reason": "<one sharp sentence>"}',
  ].join("\n");
}

export function defendPrompt(view: PlayerView, against: { from: number; text: string }[]): string {
  const lines = against.map((a) => `  ${nameOf(view, a.from)}: "${a.text}"`).join("\n");
  return [
    buildContext(view),
    "",
    `It is DAY ${view.day}. You stand ACCUSED:`,
    lines,
    "Give ONE short, convincing rebuttal (1–2 sentences).",
    'Respond as JSON: {"statement": "<your defense>"}',
  ].join("\n");
}

export function witchPrompt(view: PlayerView, wolfTargetId: number | null): string {
  const legal = view.aliveIds.filter((id) => id !== view.self.id);
  return [
    buildContext(view),
    "",
    `It is NIGHT ${view.day}. ${
      wolfTargetId !== null
        ? `The wolves are attacking ${nameOf(view, wolfTargetId)} [${wolfTargetId}].`
        : "The wolves attack no one tonight."
    }`,
    `Potions left — heal: ${view.potions?.heal ? "YES" : "spent"}, poison: ${view.potions?.poison ? "YES" : "spent"}. At most ONE potion per night.`,
    `Legal poison targets: [${legal.join(", ")}].`,
    'Respond as JSON: {"heal": true|false, "poison": <seat id or null>}',
  ].join("\n");
}

export function hunterPrompt(view: PlayerView): string {
  const legal = view.aliveIds.filter((id) => id !== view.self.id);
  return [
    buildContext(view),
    "",
    `You have just been killed. As the HUNTER you fire one final shot NOW.`,
    `Legal targets: [${legal.join(", ")}].`,
    'Respond as JSON: {"target": <seat id>, "reason": "<one short sentence>"}',
  ].join("\n");
}
```

New parsers:

```ts
export function parseTextResponse(text: string, keys: string[]): string | null {
  const obj = extractJson(text) as Record<string, unknown> | null;
  if (obj) {
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  const raw = (text ?? "").trim();
  if (raw && raw.length <= 400 && !raw.startsWith("{")) return raw;
  return null;
}

export function parseWitchResponse(text: string, view: PlayerView): WitchDecision | null {
  const obj = extractJson(text) as { heal?: unknown; poison?: unknown } | null;
  if (!obj) return null;
  const heal = obj.heal === true || obj.heal === "true";
  const poisonTargetId = obj.poison === null || obj.poison === undefined ? null : coerceTarget(obj.poison, view);
  return { heal, poisonTargetId };
}
```

(`parseStatementResponse` can delegate: `return parseTextResponse(text, ["statement"]);`. Import `WitchDecision` from `../engine/types`.)

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(agents): prompts + parsers for wolf chat, accusations, defenses, witch, hunter`

---

### Task 7: LlmBrain — wire the new powers with mock fallback

**Files:**
- Modify: `src/lib/agents/llmBrain.ts`

**Interfaces:**
- Consumes Task 6 prompts/parsers and MockBrain methods from Task 5.

- [ ] **Step 1: Implement** (fallback pattern identical to existing methods):

```ts
  async wolfChat(view: PlayerView, round: number): Promise<string> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, wolfChatPrompt(view, round));
      return parseTextResponse(text, ["message", "statement"]) ?? this.fallback.wolfChat(view, round);
    } catch {
      return this.fallback.wolfChat(view, round);
    }
  }

  async accuse(view: PlayerView): Promise<AccuseDecision> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, accusePrompt(view));
      const obj = { targetId: parseTargetResponse(text, view), text: parseTextResponse(text, ["reason"]) ?? undefined };
      return obj;
    } catch {
      return this.fallback.accuse(view);
    }
  }

  async defend(view: PlayerView, against: AccusationRecord[]): Promise<string> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, defendPrompt(view, against));
      return parseTextResponse(text, ["statement"]) ?? this.fallback.defend(view);
    } catch {
      return this.fallback.defend(view);
    }
  }

  async witchAction(view: PlayerView, wolfTargetId: number | null): Promise<WitchDecision> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, witchPrompt(view, wolfTargetId));
      return parseWitchResponse(text, view) ?? this.fallback.witchAction(view, wolfTargetId);
    } catch {
      return this.fallback.witchAction(view, wolfTargetId);
    }
  }

  async hunterShot(view: PlayerView): Promise<{ targetId: number | null }> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, hunterPrompt(view));
      const target = parseTargetResponse(text, view);
      if (target === null) return this.fallback.hunterShot(view);
      return { targetId: target };
    } catch {
      return this.fallback.hunterShot(view);
    }
  }
```

Note: `accuse` deliberately does NOT fall back on a null target — a pass is a legitimate move; it only falls back on a thrown error.

- [ ] **Step 2: Run** `npm test` (type-level verification; behavior is fallback-covered).
- [ ] **Step 3: Commit** `feat(agents): llm brain speaks in wolf chat, accuses, defends, plays witch and hunter`

---

### Task 8: Elo — neutral jester + rating history

**Files:**
- Modify: `src/lib/elo.ts`
- Modify: `src/lib/games.ts:56` (pass gameId)
- Test: `src/lib/elo.test.ts`

**Interfaces:**
- Produces: `applyGame(board, outcomes, gameId)` (3rd param now required); `ModelRating` gains `asJester: SplitStats` and `history: { gameId: string; delta: number; elo: number }[]`; old persisted entries are normalized on read.

- [ ] **Step 1: Failing tests** (append to elo.test.ts; adapt existing `applyGame(board, outcomes)` calls to pass a gameId like `"g1"`):

```ts
describe("jester + history", () => {
  const seat = (model: string, alignment: "good" | "evil" | "neutral", role: string, won: boolean) =>
    ({ seatId: 0, model, role, alignment, won, survived: true }) as SeatOutcome;

  it("a jester win rates the jester against everyone else", () => {
    const board = applyGame({}, [
      seat("j", "neutral", "jester", true),
      seat("a", "good", "villager", false),
      seat("b", "evil", "werewolf", false),
    ], "g1");
    expect(board["j"].elo).toBeGreaterThan(1000);
    expect(board["a"].elo).toBeLessThan(1000);
    expect(board["b"].elo).toBeLessThan(1000);
    expect(board["j"].asJester).toEqual({ games: 1, wins: 1 });
  });

  it("a losing jester is excluded from the rating exchange but counted in stats", () => {
    const board = applyGame({}, [
      seat("j", "neutral", "jester", false),
      seat("a", "good", "villager", true),
      seat("b", "evil", "werewolf", false),
    ], "g2");
    expect(board["j"].elo).toBe(1000);
    expect(board["j"].games).toBe(1);
    expect(board["j"].asJester).toEqual({ games: 1, wins: 0 });
    expect(board["a"].elo).toBeGreaterThan(1000);
  });

  it("appends history entries for rated models", () => {
    const board = applyGame({}, [
      seat("a", "good", "villager", true),
      seat("b", "evil", "werewolf", false),
    ], "g3");
    expect(board["a"].history).toEqual([{ gameId: "g3", delta: board["a"].elo - 1000, elo: board["a"].elo }]);
  });

  it("normalizes old entries missing asJester/history", () => {
    const legacy = { m: { model: "m", elo: 1010, games: 1, wins: 1, asWolf: { games: 0, wins: 0 }, asVillage: { games: 1, wins: 1 } } } as unknown as Leaderboard;
    const board = applyGame(legacy, [seat("m", "good", "villager", true), seat("x", "evil", "werewolf", false)], "g4");
    expect(board["m"].asJester).toEqual({ games: 0, wins: 0 });
    expect(board["m"].history.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement in elo.ts:**

```ts
export interface EloHistoryEntry { gameId: string; delta: number; elo: number; }

export interface ModelRating {
  model: string;
  elo: number;
  games: number;
  wins: number;
  asWolf: SplitStats;
  asVillage: SplitStats;
  asJester: SplitStats;
  history: EloHistoryEntry[];
}
```

`emptyRating` adds `asJester: { games: 0, wins: 0 }, history: []`. `clone` deep-copies `asJester` and `history` and MUST tolerate legacy entries where they are undefined: `asJester: { ...(v.asJester ?? { games: 0, wins: 0 }) }, history: [...(v.history ?? [])]`. In `applyGame(board, outcomes, gameId: string)`:

```ts
  const ensure = (m: string): ModelRating => {
    const base = emptyRating(m);
    next[m] = { ...base, ...(next[m] ?? {}), asWolf: { ...base.asWolf, ...next[m]?.asWolf },
      asVillage: { ...base.asVillage, ...next[m]?.asVillage },
      asJester: { ...base.asJester, ...(next[m] as Partial<ModelRating> | undefined)?.asJester },
      history: next[m]?.history ?? [] };
    return next[m];
  };
```

Rated subset + stats:

```ts
  const jesterWon = outcomes.some((o) => o.alignment === "neutral" && o.won);
  const rated = jesterWon ? outcomes : outcomes.filter((o) => o.alignment !== "neutral");

  const winners = rated.filter((o) => o.won);
  const losers = rated.filter((o) => !o.won);
  // …expected/delta loop over `rated` instead of `outcomes`…

  for (const o of outcomes) {
    const r = ensure(o.model);
    r.games += 1;
    if (o.won) r.wins += 1;
    if (o.alignment === "evil") { r.asWolf.games += 1; if (o.won) r.asWolf.wins += 1; }
    else if (o.alignment === "neutral") { r.asJester.games += 1; if (o.won) r.asJester.wins += 1; }
    else { r.asVillage.games += 1; if (o.won) r.asVillage.wins += 1; }
  }

  for (const [m, d] of delta) {
    const r = ensure(m);
    const before = pre.get(m) ?? DEFAULT_ELO;
    r.elo = Math.round(before + d);
    r.history = [...r.history, { gameId, delta: r.elo - before, elo: r.elo }];
  }
```

`games.ts:56` becomes `applyGame(board, transcript.outcomes, transcript.id)`.

- [ ] **Step 4: Run** `npx vitest run src/lib/elo.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(elo): jester solo-team rating, neutral exclusion, per-game history`

---

### Task 9: Replay + UI rendering of the new events

**Files:**
- Modify: `src/lib/replay.ts`
- Modify: `src/lib/ui.ts`
- Modify: `src/components/EventFeed.tsx`
- Modify: `src/components/ReplayPlayer.tsx`
- Modify: `src/components/PlayerSeat.tsx`
- Test: manual replay of an old + a new game (see Step 4)

**Interfaces:**
- Produces: `deriveState(t, step, opts?: { revealPrivate?: boolean })`; `LogTone` gains `"wolfchat" | "accusation" | "defense"`; `Highlight` gains `accusedId?: number`; `ROLE_META` covers all 7 roles with `align: "good" | "evil" | "neutral"`.

- [ ] **Step 1: replay.ts.** Signature: `export function deriveState(t: Transcript, rawStep: number, opts: { revealPrivate?: boolean } = {}): ReplayState`. `ReplayState.winner?: Winner`. New cases in the fold:

```ts
      case "wolf_chat":
        if (opts.revealPrivate) {
          log.push({ key: k, tone: "wolfchat", day: ev.day, playerId: ev.wolfId,
            text: `🐺 ${nameIn(seats, ev.wolfId)} (pack): "${ev.text}"` });
        }
        break;
      case "accusation":
        log.push({ key: k, tone: "accusation", day: ev.day, playerId: ev.from,
          text: `⚖️ ${nameIn(seats, ev.from)} accuses ${nameIn(seats, ev.target)}: "${ev.text}"` });
        break;
      case "defense":
        log.push({ key: k, tone: "defense", day: ev.day, playerId: ev.playerId, text: ev.text });
        break;
      case "witch_action":
        if (opts.revealPrivate) {
          log.push({ key: k, tone: "night", day: ev.day,
            text: ev.action === "heal"
              ? `🧪 The Witch (${nameIn(seats, ev.witchId)}) pours the healing draught over ${nameIn(seats, ev.targetId)}.`
              : `🧪 The Witch (${nameIn(seats, ev.witchId)}) slips poison to ${nameIn(seats, ev.targetId)}.` });
        }
        break;
      case "hunter_shot":
        log.push({ key: k, tone: "death", day: ev.day,
          text: `🏹 With their dying breath, ${nameIn(seats, ev.hunterId)} shoots ${nameIn(seats, ev.targetId)}!` });
        break;
```

`saved` copy: `` `The wolves struck — but ${nameIn(seats, ev.targetId)} was ${("by" in ev && ev.by === "witch") ? "snatched back by the Witch" : "protected"}. No one died.` `` (old transcripts have no `by`). `death` copy per cause:

```ts
          text:
            ev.cause === "wolves" ? `☠️ ${seat.name} was found dead at dawn. They were a ${ev.role}.`
            : ev.cause === "poison" ? `☠️ ${seat.name} died frothing at dawn — poisoned. They were a ${ev.role}.`
            : ev.cause === "hunter" ? `☠️ ${seat.name} falls to the Hunter's last arrow. They were a ${ev.role}.`
            : `🗳️ The village voted out ${seat.name} — who was a ${ev.role}.`,
```

`game_over` copy: `` ev.winner === "good" ? "🏡 The Village wins!" : ev.winner === "evil" ? "🐺 The Werewolves win!" : "🃏 The Jester wins!" ``. `highlightFor` additions: `case "accusation": return { speakingId: ev.from, accusedId: ev.target };`, `case "defense": return { speakingId: ev.playerId };`, `case "hunter_shot": return { killId: ev.targetId };`. `stepDelay` additions: `wolf_chat: 1700, accusation: 2300, defense: 2400, witch_action: 1500, hunter_shot: 2300`.

- [ ] **Step 2: ui.ts** — `ROLE_META` full table (align union gains `"neutral"`):

```ts
export const ROLE_META: Record<Role, { emoji: string; label: string; align: "good" | "evil" | "neutral" }> = {
  werewolf: { emoji: "🐺", label: "Werewolf", align: "evil" },
  seer: { emoji: "🔮", label: "Seer", align: "good" },
  doctor: { emoji: "🩺", label: "Doctor", align: "good" },
  villager: { emoji: "🧑‍🌾", label: "Villager", align: "good" },
  hunter: { emoji: "🏹", label: "Hunter", align: "good" },
  witch: { emoji: "🧪", label: "Witch", align: "good" },
  jester: { emoji: "🃏", label: "Jester", align: "neutral" },
};
```

- [ ] **Step 3: Components.**
  - `PlayerSeat.tsx` reveal ring: `meta.align === "evil" ? evil-mix : meta.align === "neutral" ? "color-mix(in srgb, var(--gold) 60%, transparent)" : good-mix`.
  - `ReplayPlayer.tsx`: `const state = useMemo(() => deriveState(transcript, step, { revealPrivate: godView || step >= total }), [transcript, step, godView, total]);` and the result banner handles jester: label `state.winner === "good" ? "🏡 The Village prevails" : state.winner === "evil" ? "🐺 The Werewolves win" : "🃏 The Jester wins alone"`, border class gold for jester.
  - `EventFeed.tsx`: render `defense` through the speech-bubble branch with a small `🛡 in their defense` label above the bubble; add tones:

```tsx
                entry.tone === "wolfchat" && "text-[var(--evil)] italic",
                entry.tone === "accusation" && "text-[var(--gold)] font-medium",
```

(in the final `cn(...)` catch-all block; speech branch condition becomes `entry.tone === "speech" || entry.tone === "defense"`).

- [ ] **Step 4: Verify** — `npx tsc --noEmit` clean, `npm test` green, then `npm run dev`: open an OLD replay from `data/games` (must not crash, saved copy generic) and create a NEW 9-player mock game (accusations/defenses visible; wolf chat only with god view or at the end; jester banner if voted out).
- [ ] **Step 5: Commit** `feat(ui): render accusations, defenses, wolf chat, witch/hunter moments, jester finale`

---

### Task 10: New Game form toggles + API passthrough

**Files:**
- Modify: `src/components/NewGameForm.tsx`
- Modify: `src/lib/games.ts`

**Interfaces:**
- Produces: `CreateGameInput.disabledRoles?: string[]` (sanitized to `ToggleableRole[]`), form checkboxes for Hunter/Witch/Jester (on by default).

- [ ] **Step 1: games.ts** — `CreateGameInput` gains `disabledRoles?: string[]`; in `buildConfig`:

```ts
  const TOGGLEABLE: ToggleableRole[] = ["hunter", "witch", "jester"];
  const disabledRoles = (input.disabledRoles ?? []).filter((r): r is ToggleableRole =>
    (TOGGLEABLE as string[]).includes(r)
  );
  return { numPlayers, seatModels, seed, ...(disabledRoles.length ? { disabledRoles } : {}) };
```

- [ ] **Step 2: NewGameForm.tsx** — state `const [specials, setSpecials] = useState<Record<string, boolean>>({ hunter: true, witch: true, jester: true });`, a chip row analogous to the model chips labeled `🏹 Hunter / 🧪 Witch / 🃏 Jester` toggling the booleans, and the POST body gains `disabledRoles: Object.keys(specials).filter((r) => !specials[r])`. Under the row, a one-line hint: `Hunter joins at 6+, Witch at 8+, Jester at 9+ players.`

- [ ] **Step 3: Verify** `npx tsc --noEmit` + create a game with jester disabled at 9 players → transcript has no jester seat.
- [ ] **Step 4: Commit** `feat(ui): special-role toggles on the new game form`

---

### Task 11: Full verification + balance check

**Files:**
- Create: `src/lib/engine/balance.test.ts`

- [ ] **Step 1: Balance test** (deterministic across fixed seeds — safe to assert):

```ts
import { describe, expect, it } from "vitest";
import { simulate } from "./werewolf";
import { buildBrainFactory } from "../agents/brains";

describe("balance smoke", () => {
  it("both main teams win a reasonable share across 60 seeded mock games", async () => {
    const tally = { good: 0, evil: 0, jester: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const numPlayers = 7 + (seed % 4); // 7..10
      const t = await simulate(
        { numPlayers, seatModels: Array(numPlayers).fill("mock"), seed: seed * 101 },
        buildBrainFactory(seed * 101),
        { id: `bal-${seed}`, createdAt: "2026-01-01T00:00:00.000Z" }
      );
      tally[t.result.winner] += 1;
    }
    // Not a strict 50/50 — just "no side is degenerate".
    expect(tally.good).toBeGreaterThanOrEqual(12);
    expect(tally.evil).toBeGreaterThanOrEqual(12);
  }, 30_000);
});
```

- [ ] **Step 2: Run everything** — `npm test` (all suites), `npx tsc --noEmit`, `npm run build`. If the balance assertion fails, tune MockBrain heuristics (villager accusation aggression, wolf chat targeting) — NOT the engine rules — until both floors pass, keeping all other tests green.
- [ ] **Step 3: Regenerate demo data** — old `data/games/*.json` still replay fine; optionally add a few fresh 9–10 player games via the UI for the new events to show on the home page.
- [ ] **Step 4: Commit** `test: phase-1 balance smoke + full-suite verification`
