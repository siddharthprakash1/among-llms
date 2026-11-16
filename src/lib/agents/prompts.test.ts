import { describe, expect, it } from "vitest";
import { buildContext, parseTextResponse, parseWitchResponse, parseTargetResponse } from "./prompts";
import {
  SYSTEM_PROMPT,
  accusePrompt,
  defendPrompt,
  hunterPrompt,
  nightPrompt,
  parseReasoning,
  parseStatementResponse,
  statementPrompt,
  votePrompt,
  witchPrompt,
  wolfChatPrompt,
} from "./prompts";
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

// --- reasoning inspector ----------------------------------------------------

describe("parseReasoning", () => {
  it("reads the private field from clean, fenced and prose-wrapped JSON", () => {
    expect(parseReasoning('{"reasoning": " Bram is lying ", "target": 1}')).toBe("Bram is lying");
    expect(parseReasoning('```json\n{"reasoning":"fenced","statement":"hi"}\n```')).toBe("fenced");
    expect(parseReasoning('Sure! Here you go: {"reasoning":"wrapped","target":1} Hope that helps.')).toBe(
      "wrapped"
    );
  });

  it("is undefined for raw text, a missing key, a non-string and blank", () => {
    expect(parseReasoning("I think Bram is a wolf")).toBeUndefined();
    expect(parseReasoning('{"target": 1}')).toBeUndefined();
    expect(parseReasoning('{"reasoning": 42}')).toBeUndefined();
    expect(parseReasoning('{"reasoning": "   "}')).toBeUndefined();
    expect(parseReasoning("")).toBeUndefined();
  });
});

describe("parseTextResponse hardening", () => {
  const STRICT = { allowRaw: false };

  it("lenient mode never speaks a reply that may hold private reasoning", () => {
    expect(
      parseTextResponse('```json\n{"reasoning": "I\'m a wolf, deflect onto Bram', ["statement"])
    ).toBeNull();
    expect(parseTextResponse('ok {"statement": ', ["statement"])).toBeNull();
    expect(parseTextResponse('{"reasoning":"secret"}', ["statement"])).toBeNull();
    expect(
      parseTextResponse("reasoning: I'm a wolf, deflect onto Bram\nstatement: Bram is suspicious", ["statement"])
    ).toBeNull();
  });

  it("strict mode only ever returns a named JSON key", () => {
    expect(parseTextResponse("Just my words", ["statement"], STRICT)).toBeNull();
    expect(
      parseTextResponse(
        "Reasoning: I'm a wolf, Bram is my packmate, deflect onto Cleo. Statement: Cleo has been quiet.",
        ["statement"],
        STRICT
      )
    ).toBeNull();
    expect(
      parseTextResponse("Thinking it over: Bram is my packmate. I'll say Cleo is quiet.", ["statement"], STRICT)
    ).toBeNull();
    expect(parseTextResponse('{"reasoning":"secret","statement":"hi"}', ["statement"], STRICT)).toBe("hi");
    expect(parseTextResponse('{"reasoning":"secret"}', ["statement"], STRICT)).toBeNull();
  });

  it("never treats the legacy reason key as public text", () => {
    expect(
      parseTextResponse('{"reason":"Bram is my packmate","target":4}', ["accusation"], STRICT)
    ).toBeNull();
  });
});

describe("prompt builders ask for private reasoning", () => {
  const wolfView = {
    ...view,
    self: { id: 0, name: "Ada", role: "werewolf", alignment: "evil", model: "mock" },
    knownWolves: [0],
    potions: null,
  } as unknown as PlayerView;

  it("every builder's response format leads with the reasoning key", () => {
    const prompts = [
      nightPrompt(wolfView),
      statementPrompt(view),
      votePrompt(view),
      wolfChatPrompt(wolfView, 1),
      accusePrompt(view),
      defendPrompt(view, [{ from: 1, text: "sus" }]),
      witchPrompt(view, 1),
      hunterPrompt(view),
    ];
    for (const p of prompts) {
      const lines = p.split("\n");
      expect(lines.at(-2)!.startsWith('Respond as JSON: {"reasoning"')).toBe(true);
      // Small local models answer {} unless the prompt ends on a cue.
      expect(lines.at(-1)).toBe("Your JSON answer:");
    }
    expect(SYSTEM_PROMPT).toContain('"reasoning"');
  });

  it("the accuse prompt names the public key accusation, not reason", () => {
    const p = accusePrompt(view);
    expect(p).toContain('"accusation"');
    expect(p).not.toContain('"reason":');
    for (const other of [nightPrompt(wolfView), votePrompt(view), hunterPrompt(view)])
      expect(other).not.toContain('"reason":');
  });
});

describe("parsers tolerate a leading reasoning key", () => {
  it("still parse targets, witch decisions and statements", () => {
    expect(parseTargetResponse('{"reasoning":"Bram is shifty","target":1}', view)).toBe(1);
    expect(parseTargetResponse('{"reasoning":"Bram is shifty","target":"Bram"}', view)).toBe(1);
    expect(parseWitchResponse('{"reasoning":"save them","heal":true,"poison":null}', view)).toEqual({
      heal: true,
      poisonTargetId: null,
    });
    expect(parseStatementResponse('{"reasoning":"lie low","statement":"I trust Bram."}')).toBe(
      "I trust Bram."
    );
  });
});
