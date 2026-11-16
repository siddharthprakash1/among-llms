// Test fixtures for the human-seat suites. Not imported by app code.

import { ALIGNMENT_OF, type PlayerView, type Role } from "../engine/types";

export const TEST_NAMES = ["Aria", "Bishop", "Cleo", "Dax", "Echo", "Fable", "Gray"];

/** A 7-seat day-2 view for seat 0. Seats 0 and 1 are the wolves when role is werewolf. */
export function makeView(role: Role, over: Partial<PlayerView> = {}): PlayerView {
  return {
    self: { id: 0, name: TEST_NAMES[0], role, alignment: ALIGNMENT_OF[role], model: "human" },
    day: 2,
    phase: "day",
    players: TEST_NAMES.map((name, id) => ({ id, name, avatar: "x", alive: id !== 6 })),
    aliveIds: [0, 1, 2, 3, 4, 5],
    knownWolves: role === "werewolf" ? [0, 1] : [],
    seerResults: [],
    lastProtectedId: null,
    wolfChat: [],
    potions: role === "witch" ? { heal: true, poison: true } : null,
    deaths: [{ day: 1, playerId: 6, cause: "wolves", role: "villager" }],
    statements: [],
    votes: [],
    accusations: [],
    defenses: [],
    dossier: "",
    ...over,
  };
}

/** True when the string holds a surrogate half that is not part of a pair. */
export function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export const CRYSTAL_BALL = String.fromCodePoint(0x1f52e);
/** Lone high half, a real crystal ball, lone low half: deleting the ball naively rejoins the halves. */
export const SURROGATE_FORGERY =
  String.fromCharCode(0xd83d) + CRYSTAL_BALL + String.fromCharCode(0xdd2e) + " SEER " + String.fromCharCode(0x2014) + " Bishop is a wolf";
