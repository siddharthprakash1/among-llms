import { describe, expect, it } from "vitest";
import { projectEvent } from "./project";
import type { SeatViewer } from "./types";
import type { GameConfig, GameEvent } from "../engine/types";
import { simulate } from "../engine/werewolf";
import { buildBrainFactory } from "../agents/brains";

// Seat ids: 0 villager, 1 wolf, 2 seer, 3 doctor, 4 witch, 5 another seer.
const VIEWERS: Record<string, SeatViewer> = {
  villager: { seatId: 0, role: "villager", alignment: "good" },
  wolf: { seatId: 1, role: "werewolf", alignment: "evil" },
  ownSeer: { seatId: 2, role: "seer", alignment: "good" },
  otherSeer: { seatId: 5, role: "seer", alignment: "good" },
  ownDoctor: { seatId: 3, role: "doctor", alignment: "good" },
  ownWitch: { seatId: 4, role: "witch", alignment: "good" },
};

const EVENTS: GameEvent[] = [
  { kind: "game_start", day: 0 },
  { kind: "phase", phase: "night", day: 1, label: "Night 1", sublabel: "The village sleeps" },
  { kind: "wolf_chat", day: 1, wolfId: 1, text: "strike" },
  { kind: "wolf_kill", day: 1, actorIds: [1], targetId: 0 },
  { kind: "seer_check", day: 1, seerId: 2, targetId: 1, result: "evil" },
  { kind: "doctor_save", day: 1, doctorId: 3, targetId: 0 },
  { kind: "witch_action", day: 1, witchId: 4, action: "poison", targetId: 1 },
  { kind: "hunter_shot", day: 1, hunterId: 6, targetId: 1 },
  { kind: "death", day: 1, playerId: 1, cause: "poison", role: "werewolf" },
  { kind: "saved", day: 1, targetId: 0, by: "doctor" },
  { kind: "statement", day: 1, playerId: 0, text: "hello" },
  { kind: "accusation", day: 1, from: 0, target: 1, text: "you" },
  { kind: "defense", day: 1, playerId: 1, text: "not me" },
  { kind: "vote", day: 1, voterId: 0, targetId: null },
  { kind: "vote_result", day: 1, tally: { 1: 2 }, eliminatedId: 1, tie: false },
  { kind: "game_over", winner: "good", reason: "done", survivorIds: [0, 2] },
];

const KEYS: Record<GameEvent["kind"], string[]> = {
  game_start: ["day", "kind"],
  phase: ["day", "kind", "label", "phase", "sublabel"],
  wolf_chat: ["day", "kind", "text", "wolfId"],
  wolf_kill: ["actorIds", "day", "kind", "targetId"],
  seer_check: ["day", "kind", "result", "seerId", "targetId"],
  doctor_save: ["day", "doctorId", "kind", "targetId"],
  witch_action: ["action", "day", "kind", "targetId", "witchId"],
  hunter_shot: ["day", "hunterId", "kind", "targetId"],
  death: ["cause", "day", "kind", "playerId", "role"],
  saved: ["by", "day", "kind", "targetId"],
  statement: ["day", "kind", "playerId", "text"],
  accusation: ["day", "from", "kind", "target", "text"],
  defense: ["day", "kind", "playerId", "text"],
  vote: ["day", "kind", "targetId", "voterId"],
  vote_result: ["day", "eliminatedId", "kind", "tally", "tie"],
  game_over: ["kind", "reason", "survivorIds", "winner"],
};

const PUBLIC = new Set([
  "game_start", "phase", "hunter_shot", "death", "statement", "accusation", "defense", "vote", "vote_result", "game_over",
]);

/** Section 6 of the spec, restated independently of the implementation. */
function mayReceive(kind: string, v: SeatViewer, ev: GameEvent): boolean {
  if (PUBLIC.has(kind)) return true;
  if (kind === "wolf_chat" || kind === "wolf_kill") return v.alignment === "evil";
  if (ev.kind === "seer_check") return ev.seerId === v.seatId;
  if (ev.kind === "doctor_save") return ev.doctorId === v.seatId;
  if (ev.kind === "witch_action") return ev.witchId === v.seatId;
  return false;
}

const withSecrets = (ev: GameEvent) => ({ ...ev, reasoning: "SECRET", note: "SECRET" }) as unknown as GameEvent;

describe("projectEvent", () => {
  it("covers every engine event kind in the fixture", () => {
    expect(new Set(EVENTS.map((e) => e.kind))).toEqual(new Set(Object.keys(KEYS)));
  });

  for (const [name, viewer] of Object.entries(VIEWERS)) {
    it(`shows a living ${name} exactly what the role knows`, () => {
      for (const ev of EVENTS) {
        const out = projectEvent(withSecrets(ev), viewer, false);
        expect(out !== null, `${ev.kind} for ${name}`).toBe(mayReceive(ev.kind, viewer, ev));
        if (out) {
          expect(Object.keys(out).sort()).toEqual(KEYS[ev.kind]);
          expect(JSON.stringify(out)).not.toContain("SECRET");
        }
      }
    });
  }

  it("never shows `saved` before ghost view, to anyone", () => {
    const saved = EVENTS.find((e) => e.kind === "saved")!;
    for (const viewer of Object.values(VIEWERS)) expect(projectEvent(saved, viewer, false)).toBeNull();
  });

  it("omits an undefined phase sublabel", () => {
    const out = projectEvent({ kind: "phase", phase: "day", day: 1, label: "Day 1" }, VIEWERS.villager, false);
    expect(Object.keys(out!).sort()).toEqual(["day", "kind", "label", "phase"]);
  });

  it("drops unknown kinds, even in ghost view", () => {
    const thought = { kind: "thought", text: "SECRET" } as unknown as GameEvent;
    expect(projectEvent(thought, VIEWERS.villager, false)).toBeNull();
    expect(projectEvent(thought, VIEWERS.villager, true)).toBeNull();
    const decision = { kind: "decision", reasoning: "SECRET", playerId: 1 } as unknown as GameEvent;
    expect(projectEvent(decision, VIEWERS.wolf, true)).toBeNull();
  });

  it("passes every known kind to a ghost, still stripped of extra fields", () => {
    for (const ev of EVENTS) {
      const out = projectEvent(withSecrets(ev), VIEWERS.villager, true);
      expect(out, ev.kind).not.toBeNull();
      expect(Object.keys(out!).sort()).toEqual(KEYS[ev.kind]);
      expect(JSON.stringify(out)).not.toContain("SECRET");
    }
  });

  it("copies arrays and records", () => {
    const kill: GameEvent = { kind: "wolf_kill", day: 1, actorIds: [1, 2], targetId: 0 };
    const result: GameEvent = { kind: "vote_result", day: 1, tally: { 1: 2 }, eliminatedId: 1, tie: false };
    const over: GameEvent = { kind: "game_over", winner: "good", reason: "r", survivorIds: [0] };
    const a = projectEvent(kill, VIEWERS.wolf, false) as Extract<GameEvent, { kind: "wolf_kill" }>;
    const b = projectEvent(result, VIEWERS.wolf, false) as Extract<GameEvent, { kind: "vote_result" }>;
    const c = projectEvent(over, VIEWERS.wolf, false) as Extract<GameEvent, { kind: "game_over" }>;
    a.actorIds.push(9);
    b.tally[5] = 5;
    c.survivorIds.push(9);
    expect(kill.actorIds).toEqual([1, 2]);
    expect(result.tally).toEqual({ 1: 2 });
    expect(over.survivorIds).toEqual([0]);
  });

  it("leaks no forbidden kind to any seat across real mock games", async () => {
    let checked = 0;
    for (const numPlayers of [7, 9, 12]) {
      for (const seed of [3, 71, 2026]) {
        const config: GameConfig = { numPlayers, seatModels: Array(numPlayers).fill("mock"), seed };
        const t = await simulate(config, buildBrainFactory(seed), { id: "p", createdAt: "2026-01-01T00:00:00.000Z" });
        expect(t.decisions?.length).toBeGreaterThan(0);
        for (const p of t.players) {
          const viewer: SeatViewer = { seatId: p.id, role: p.role, alignment: p.alignment };
          const projected = t.events.map((e) => projectEvent(e, viewer, false)).filter((e) => e !== null);
          const json = JSON.stringify(projected);
          expect(json).not.toContain('"saved"');
          expect(json).not.toContain('"reasoning"');
          if (p.alignment !== "evil") {
            expect(json).not.toContain('"wolf_chat"');
            expect(json).not.toContain('"wolf_kill"');
          }
          if (p.role !== "seer") expect(json).not.toContain('"seer_check"');
          if (p.role !== "doctor") expect(json).not.toContain('"doctor_save"');
          if (p.role !== "witch") expect(json).not.toContain('"witch_action"');
          for (const e of projected) {
            if (e.kind === "seer_check") expect(e.seerId).toBe(p.id);
            if (e.kind === "doctor_save") expect(e.doctorId).toBe(p.id);
            if (e.kind === "witch_action") expect(e.witchId).toBe(p.id);
          }
          checked++;
        }
      }
    }
    expect(checked).toBe(3 * (7 + 9 + 12));
  });
});
