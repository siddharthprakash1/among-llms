import { describe, expect, it } from "vitest";
import { seatKnowledge, seatTranscript, textKeyAction } from "./clientState";
import type { SeatEvent, SeatMeta } from "./types";
import { deriveState } from "../replay";
import { ALIGNMENT_OF, type GameEvent, type Player, type Role } from "../engine/types";

const NAMES = ["Aria", "Bishop", "Cleo", "Dax", "Echo"];
function meta(role: Role, packmates: number[] = []): SeatMeta {
  return {
    id: "g1",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    numPlayers: 5,
    players: NAMES.map((name, id) => ({ id, name, avatar: "x", model: id === 0 ? "human" : "mock" })),
    roleCounts: { werewolf: 1, seer: 1, doctor: 1, villager: 2, hunter: 0, witch: 0, jester: 0 },
    you: { seatId: 0, name: "Aria", avatar: "x", role, alignment: ALIGNMENT_OF[role] },
    packmates,
  };
}

const START: SeatEvent[] = [
  { kind: "game_start", day: 0 },
  { kind: "phase", phase: "night", day: 1, label: "Night 1" },
  { kind: "phase", phase: "day", day: 1, label: "Day 1" },
  { kind: "statement", day: 1, playerId: 1, text: "hello" },
];
const FULL_ROLES: Role[] = ["villager", "werewolf", "seer", "doctor", "villager"];
const FULL_PLAYERS: Player[] = FULL_ROLES.map((role, id) => ({
  id, name: NAMES[id], avatar: "x", model: id === 0 ? "human" : "mock", role, alignment: ALIGNMENT_OF[role], alive: true,
}));

describe("seatTranscript", () => {
  it("knows only the own seat at first; the rest are placeholders", () => {
    const { transcript, knownIds, empty } = seatTranscript(meta("seer"), START);
    expect(empty).toBe(false);
    expect([...knownIds]).toEqual([0]);
    expect(transcript.players[0]).toMatchObject({ role: "seer", alignment: "good", model: "human" });
    expect(transcript.players.slice(1).every((p) => p.role === "villager" && p.alignment === "good")).toBe(true);
    expect(transcript.events).toEqual(START);
    expect(transcript.config).toEqual({ numPlayers: 5, seatModels: ["human", "mock", "mock", "mock", "mock"], seed: 0 });
    expect(transcript).not.toHaveProperty("decisions");
  });

  it("knows the packmates of a wolf", () => {
    const { transcript, knownIds } = seatTranscript(meta("werewolf", [3]), START);
    expect([...knownIds].sort()).toEqual([0, 3]);
    expect(transcript.players[3]).toMatchObject({ role: "werewolf", alignment: "evil" });
  });

  it("learns a role from a death", () => {
    const items: SeatEvent[] = [...START, { kind: "death", day: 1, playerId: 2, cause: "vote", role: "doctor" }];
    const { transcript, knownIds } = seatTranscript(meta("villager"), items);
    expect([...knownIds].sort()).toEqual([0, 2]);
    expect(transcript.players[2]).toMatchObject({ role: "doctor", alignment: "good" });
  });

  it("fills every role from a non-final reveal and drops the reveal from the events", () => {
    const items: SeatEvent[] = [
      ...START,
      { kind: "seat_reveal", final: false, players: FULL_PLAYERS },
      { kind: "phase", phase: "night", day: 2, label: "Night 2" },
    ];
    const { transcript, knownIds } = seatTranscript(meta("villager"), items);
    expect(knownIds.size).toBe(5);
    expect(transcript.players.map((p) => p.role)).toEqual(FULL_ROLES);
    expect(transcript.events.length).toBe(5);
    expect(transcript.events.some((e) => (e as { kind: string }).kind === "seat_reveal")).toBe(false);
  });

  it("swaps in the full raw log on a final reveal", () => {
    const raw: GameEvent[] = [
      { kind: "game_start", day: 0 },
      { kind: "phase", phase: "night", day: 1, label: "Night 1" },
      { kind: "wolf_kill", day: 1, actorIds: [1], targetId: 4 },
      { kind: "seer_check", day: 1, seerId: 2, targetId: 1, result: "evil" },
      { kind: "phase", phase: "day", day: 1, label: "Day 1" },
      { kind: "statement", day: 1, playerId: 1, text: "hello" },
    ];
    const over: SeatEvent = { kind: "game_over", winner: "evil", reason: "wolves win", survivorIds: [1] };
    const items: SeatEvent[] = [...START, { kind: "seat_reveal", final: true, players: FULL_PLAYERS, events: raw }, over];
    const { transcript, knownIds } = seatTranscript(meta("villager"), items);
    expect(transcript.events).toEqual([...raw, over]);
    expect(knownIds.size).toBe(5);
    expect(() => deriveState(transcript, transcript.events.length - 1, { revealPrivate: true })).not.toThrow();
  });

  it("reports empty for no items and for items that start with a hole", () => {
    expect(seatTranscript(meta("villager"), []).empty).toBe(true);
    const sparse: (SeatEvent | undefined)[] = [];
    sparse[3] = START[3];
    const out = seatTranscript(meta("villager"), sparse);
    expect(out.empty).toBe(true);
    expect(out.transcript.events).toEqual([]);
  });

  it("uses only the contiguous prefix when ids were skipped", () => {
    const items: (SeatEvent | undefined)[] = [START[0], START[1]];
    items[3] = { kind: "death", day: 1, playerId: 2, cause: "vote", role: "doctor" };
    const { transcript, knownIds, empty } = seatTranscript(meta("villager"), items);
    expect(empty).toBe(false);
    expect(transcript.events).toEqual([START[0], START[1]]);
    expect([...knownIds]).toEqual([0]);
    expect(() => deriveState(transcript, transcript.events.length - 1)).not.toThrow();
  });
});

describe("seatKnowledge", () => {
  const ghostNight: SeatEvent[] = [
    ...START,
    { kind: "seer_check", day: 1, seerId: 0, targetId: 1, result: "evil" },
    { kind: "seer_check", day: 2, seerId: 3, targetId: 2, result: "good" }, // another seat's, seen as a ghost
    { kind: "doctor_save", day: 1, doctorId: 0, targetId: 2 },
    { kind: "doctor_save", day: 2, doctorId: 0, targetId: 4 },
    { kind: "doctor_save", day: 2, doctorId: 3, targetId: 1 },
    { kind: "witch_action", day: 1, witchId: 0, action: "heal", targetId: 2 },
    { kind: "witch_action", day: 2, witchId: 3, action: "poison", targetId: 1 },
  ];

  it("reads only the seat's own events", () => {
    expect(seatKnowledge(meta("seer"), ghostNight)).toEqual({
      visions: [{ day: 1, targetId: 1, alignment: "evil" }],
      lastProtectedId: 4,
      potions: null,
    });
    expect(seatKnowledge(meta("witch"), ghostNight).potions).toEqual({ heal: false, poison: true });
    expect(seatKnowledge(meta("witch"), START).potions).toEqual({ heal: true, poison: true });
    expect(seatKnowledge(meta("villager"), [])).toEqual({ visions: [], lastProtectedId: null, potions: null });
  });

  it("stops at a hole", () => {
    const items: (SeatEvent | undefined)[] = [START[0]];
    items[2] = { kind: "seer_check", day: 1, seerId: 0, targetId: 1, result: "evil" };
    expect(seatKnowledge(meta("seer"), items).visions).toEqual([]);
  });
});

describe("textKeyAction", () => {
  it("sends on Enter only when there is something to send", () => {
    expect(textKeyAction({ key: "Enter" }, "I am the seer")).toBe("send");
    expect(textKeyAction({ key: "Enter" }, "")).toBe("swallow");
    expect(textKeyAction({ key: "Enter" }, "   ")).toBe("swallow");
  });

  it("lets a field with optional text submit blank", () => {
    expect(textKeyAction({ key: "Enter" }, "", true)).toBe("send");
  });

  it("never sends on Shift+Enter, during IME composition, or for other keys", () => {
    expect(textKeyAction({ key: "Enter", shiftKey: true }, "hello")).toBe("swallow");
    expect(textKeyAction({ key: "Enter", isComposing: true }, "hello")).toBe("ignore");
    expect(textKeyAction({ key: "a" }, "hello")).toBe("ignore");
  });
});
