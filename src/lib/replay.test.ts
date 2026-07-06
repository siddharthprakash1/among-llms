import { describe, expect, it } from "vitest";
import { deriveState, totalSteps } from "./replay";
import { Transcript } from "./engine/types";

// Minimal player fixtures shared by the legacy + new-path transcripts below.
function player(id: number, name: string, role: string, alignment: string) {
  return {
    id,
    name,
    avatar: "🙂",
    model: "mock",
    role,
    alignment,
    alive: true,
  };
}

describe("deriveState — legacy transcript compatibility", () => {
  // Shaped like a pre-Phase-1 transcript: `saved` has no `by`, winner is only
  // "good"/"evil", and none of the new event kinds appear. Cast via `as unknown
  // as Transcript` since the old shape doesn't satisfy the new stricter types.
  const legacyTranscript = {
    id: "legacy-1",
    createdAt: new Date().toISOString(),
    config: { numPlayers: 3, seatModels: ["mock", "mock", "mock"], seed: 1 },
    players: [
      player(0, "Ada", "werewolf", "evil"),
      player(1, "Bo", "doctor", "good"),
      player(2, "Cy", "villager", "good"),
    ],
    events: [
      { kind: "game_start", day: 0 },
      { kind: "phase", phase: "night", day: 1, label: "Night falls", sublabel: "" },
      { kind: "wolf_kill", day: 1, actorIds: [0], targetId: 2 },
      // Legacy `saved` event: no `by` field at all.
      { kind: "saved", day: 1, targetId: 2 },
      { kind: "phase", phase: "day", day: 1, label: "Day breaks", sublabel: "" },
      { kind: "statement", day: 1, playerId: 1, text: "I think it's Ada." },
      { kind: "vote", day: 1, voterId: 1, targetId: 0 },
      {
        kind: "vote_result",
        day: 1,
        tally: { 0: 1 },
        eliminatedId: null,
        tie: true,
      },
      { kind: "game_over", winner: "good", reason: "Wolves eliminated.", survivorIds: [1, 2] },
    ],
    result: { winner: "good", reason: "Wolves eliminated.", survivorIds: [1, 2], days: 1 },
    outcomes: [],
  } as unknown as Transcript;

  it("does not throw when folding a full legacy transcript", () => {
    expect(() => deriveState(legacyTranscript, totalSteps(legacyTranscript))).not.toThrow();
  });

  it("marks seats correctly at the end of the legacy game", () => {
    const state = deriveState(legacyTranscript, totalSteps(legacyTranscript));
    expect(state.finished).toBe(true);
    expect(state.winner).toBe("good");
    // No one died in this transcript (the wolf kill was saved).
    expect(state.seats.every((s) => s.alive)).toBe(true);
    // Game over reveals everyone.
    expect(state.seats.every((s) => s.revealed)).toBe(true);
  });

  it("renders the legacy `saved` event with the generic protected copy (no `by`)", () => {
    const state = deriveState(legacyTranscript, totalSteps(legacyTranscript));
    const savedLine = state.log.find((l) => l.text.includes("was protected"));
    expect(savedLine).toBeTruthy();
    expect(savedLine!.text).toContain("Cy was protected");
    expect(savedLine!.text).not.toContain("snatched back");
  });
});

describe("deriveState — revealPrivate gating for new private events", () => {
  const transcript = {
    id: "new-1",
    createdAt: new Date().toISOString(),
    config: { numPlayers: 3, seatModels: ["mock", "mock", "mock"], seed: 1 },
    players: [
      player(0, "Ada", "werewolf", "evil"),
      player(1, "Bo", "witch", "good"),
      player(2, "Cy", "villager", "good"),
    ],
    events: [
      { kind: "game_start", day: 0 },
      { kind: "phase", phase: "night", day: 1, label: "Night falls", sublabel: "" },
      { kind: "wolf_chat", day: 1, wolfId: 0, text: "Let's take out Cy." },
      { kind: "witch_action", day: 1, witchId: 1, action: "heal", targetId: 2 },
    ],
    result: { winner: "good", reason: "", survivorIds: [0, 1, 2], days: 1 },
    outcomes: [],
  } as unknown as Transcript;

  it("hides wolf_chat and witch_action by default", () => {
    const state = deriveState(transcript, totalSteps(transcript));
    expect(state.log.some((l) => l.tone === "wolfchat")).toBe(false);
    expect(state.log.some((l) => l.text.includes("healing draught"))).toBe(false);
  });

  it("reveals wolf_chat and witch_action with { revealPrivate: true }", () => {
    const state = deriveState(transcript, totalSteps(transcript), { revealPrivate: true });
    const wolfLine = state.log.find((l) => l.tone === "wolfchat");
    expect(wolfLine).toBeTruthy();
    expect(wolfLine!.text).toContain("Ada");
    expect(wolfLine!.text).toContain("Let's take out Cy.");

    const witchLine = state.log.find((l) => l.text.includes("healing draught"));
    expect(witchLine).toBeTruthy();
    expect(witchLine!.text).toContain("Bo");
    expect(witchLine!.text).toContain("Cy");
  });
});

describe("deriveState — accusation rendering", () => {
  const transcript = {
    id: "acc-1",
    createdAt: new Date().toISOString(),
    config: { numPlayers: 3, seatModels: ["mock", "mock", "mock"], seed: 1 },
    players: [
      player(0, "Ada", "werewolf", "evil"),
      player(1, "Bo", "seer", "good"),
      player(2, "Cy", "villager", "good"),
    ],
    events: [
      { kind: "game_start", day: 0 },
      { kind: "phase", phase: "day", day: 1, label: "Day breaks", sublabel: "" },
      { kind: "accusation", day: 1, from: 1, target: 0, text: "Ada is acting shady." },
    ],
    result: { winner: "good", reason: "", survivorIds: [0, 1, 2], days: 1 },
    outcomes: [],
  } as unknown as Transcript;

  it("produces a log entry with tone 'accusation' and speakingId/accusedId highlight", () => {
    const state = deriveState(transcript, totalSteps(transcript));
    const accusationEntry = state.log.find((l) => l.tone === "accusation");
    expect(accusationEntry).toBeTruthy();
    expect(accusationEntry!.text).toContain("Bo");
    expect(accusationEntry!.text).toContain("Ada");
    expect(accusationEntry!.text).toContain("Ada is acting shady.");

    expect(state.highlight).toEqual({ speakingId: 1, accusedId: 0 });
  });
});
