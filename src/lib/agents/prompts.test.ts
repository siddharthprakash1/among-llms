import { describe, expect, it } from "vitest";
import { buildContext, parseTextResponse, parseWitchResponse, parseTargetResponse } from "./prompts";
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

describe("buildContext role redaction", () => {
  const villagerView = {
    ...view,
    self: { id: 0, name: "Ada", role: "villager", alignment: "good", model: "mock" },
    wolfChat: [],
    potions: null,
  } as unknown as PlayerView;

  const wolfView = {
    ...view,
    self: { id: 0, name: "Ada", role: "werewolf", alignment: "evil", model: "mock" },
    knownWolves: [0, 1],
    wolfChat: [{ day: 1, wolfId: 1, text: "tonight we strike" }],
    potions: null,
  } as unknown as PlayerView;

  it("omits the pack chat section for a villager view", () => {
    const ctx = buildContext(villagerView);
    expect(ctx).not.toContain("Your pack's private chat");
  });

  it("includes the pack chat section and its lines for a wolf view", () => {
    const ctx = buildContext(wolfView);
    expect(ctx).toContain("Your pack's private chat");
    expect(ctx).toContain("tonight we strike");
  });
});
