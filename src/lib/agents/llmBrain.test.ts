import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmBrain } from "./llmBrain";
import { MockBrain } from "./mockBrain";
import * as prompts from "./prompts";
import { ProviderConfig } from "./registry";
import { simulate } from "../engine/werewolf";
import { AccusationRecord, DecisionTrace, PlayerView, Role, Transcript } from "../engine/types";

const CFG: ProviderConfig = { kind: "openai", baseUrl: "http://stub.invalid/v1", apiKey: "k", model: "stub" };
const SEED = 7;

function makeView(role: Role): PlayerView {
  return {
    self: { id: 0, name: "Ada", role, alignment: role === "werewolf" ? "evil" : "good", model: "stub" },
    day: 1,
    phase: "day",
    players: [
      { id: 0, name: "Ada", avatar: "🦊", alive: true },
      { id: 1, name: "Bram", avatar: "🐻", alive: true },
      { id: 2, name: "Cleo", avatar: "🐱", alive: true },
      { id: 3, name: "Dov", avatar: "🐸", alive: true },
    ],
    aliveIds: [0, 1, 2, 3],
    knownWolves: role === "werewolf" ? [0] : [],
    seerResults: [],
    lastProtectedId: null,
    wolfChat: [],
    potions: role === "witch" ? { heal: true, poison: true } : null,
    deaths: [],
    statements: [],
    votes: [],
    accusations: [],
    defenses: [],
    dossier: "",
  };
}

const AGAINST: AccusationRecord[] = [{ day: 1, from: 1, target: 0, text: "sus" }];

/** A provider that answers every request with `content` as the model's text. */
function stubReply(content: string) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubFetch(impl: () => Promise<unknown>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const brain = () => new LlmBrain("stub", CFG, SEED);
/** What the built-in heuristic would do from the same seed (the fallback's first move). */
const heuristic = () => new MockBrain("stub", SEED);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LlmBrain provenance", () => {
  it("stamps a good reply as the model's own, with its reasoning and latency", async () => {
    stubReply('{"reasoning":"Bram dodged my question.","target":1}');
    const trace: DecisionTrace = {};
    const decision = await brain().dayVote(makeView("villager"), trace);
    expect(decision).toEqual({ targetId: 1 });
    expect(trace.source).toBe("model");
    expect(trace.reasoning).toBe("Bram dodged my question.");
    expect(trace.fallbackReason).toBeUndefined();
    expect(typeof trace.latencyMs).toBe("number");
    expect(trace.latencyMs!).toBeGreaterThanOrEqual(0);
  });

  it("falls back on HTTP 500 with the heuristic's move and rationale", async () => {
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const view = makeView("werewolf");
    const trace: DecisionTrace = {};
    const decision = await brain().nightAction(view, trace);

    const expectedTrace: DecisionTrace = {};
    const expected = await heuristic().nightAction(view, expectedTrace);
    expect(decision).toEqual(expected);
    expect([1, 2, 3]).toContain(decision.targetId);
    expect(trace.source).toBe("fallback");
    expect(trace.fallbackReason).toBe("http");
    expect(trace.reasoning).toBe(expectedTrace.reasoning);
    expect(trace.reasoning).toBeTruthy();
    expect(trace.latencyMs!).toBeGreaterThanOrEqual(0);
  });

  it("classifies an aborted request as a timeout", async () => {
    stubFetch(async () => {
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    });
    const trace: DecisionTrace = {};
    await brain().dayVote(makeView("villager"), trace);
    expect(trace).toMatchObject({ source: "fallback", fallbackReason: "timeout" });
  });

  it("classifies a non-JSON HTTP body as an error", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }));
    const trace: DecisionTrace = {};
    await brain().dayVote(makeView("villager"), trace);
    expect(trace).toMatchObject({ source: "fallback", fallbackReason: "error" });
  });

  it("labels an explicit null vote as invalid (still not honoured)", async () => {
    stubReply('{"target": null}');
    const trace: DecisionTrace = {};
    await brain().dayVote(makeView("villager"), trace);
    expect(trace).toMatchObject({ source: "fallback", fallbackReason: "invalid" });
  });
});

describe("LlmBrain never speaks raw model text", () => {
  it("a plain-text reply is a parse fallback on a vote", async () => {
    stubReply("hello");
    const trace: DecisionTrace = {};
    await brain().dayVote(makeView("villager"), trace);
    expect(trace).toMatchObject({ source: "fallback", fallbackReason: "parse" });
  });

  it("a plain-text reply is never spoken as a statement, defense or wolf chat", async () => {
    stubReply("hello");
    const villager = makeView("villager");
    const wolf = makeView("werewolf");

    const t1: DecisionTrace = {};
    const statement = await brain().dayStatement(villager, t1);
    expect(statement).toBe(await heuristic().dayStatement(villager));
    expect(statement).not.toBe("hello");
    expect(t1).toMatchObject({ source: "fallback", fallbackReason: "parse" });

    const t2: DecisionTrace = {};
    const defense = await brain().defend(villager, AGAINST, t2);
    expect(defense).toBe(await heuristic().defend(villager, AGAINST));
    expect(defense).not.toBe("hello");
    expect(t2).toMatchObject({ source: "fallback", fallbackReason: "parse" });

    const t3: DecisionTrace = {};
    const chat = await brain().wolfChat(wolf, 1, t3);
    expect(chat).toBe(await heuristic().wolfChat(wolf, 1));
    expect(chat).not.toBe("hello");
    expect(t3).toMatchObject({ source: "fallback", fallbackReason: "parse" });

    // What the inspector shows for a fallback is the heuristic rationale, never the model text.
    const h1: DecisionTrace = {};
    await heuristic().dayStatement(villager, h1);
    const h2: DecisionTrace = {};
    await heuristic().defend(villager, AGAINST, h2);
    const h3: DecisionTrace = {};
    await heuristic().wolfChat(wolf, 1, h3);
    for (const [t, h] of [[t1, h1], [t2, h2], [t3, h3]]) {
      expect(h.reasoning).toBeTruthy();
      expect(t.reasoning).toBe(h.reasoning);
      expect(t.reasoning).not.toContain("hello");
    }
  });

  it("brace-free prose holding private reasoning is not spoken", async () => {
    stubReply("Reasoning: I'm a wolf, deflect onto Cleo. Statement: Cleo is quiet.");
    const trace: DecisionTrace = {};
    const statement = await brain().dayStatement(makeView("werewolf"), trace);
    expect(statement).not.toContain("I'm a wolf");
    expect(trace).toMatchObject({ source: "fallback", fallbackReason: "parse" });
    expect(trace.reasoning).not.toContain("I'm a wolf");
  });

  it("JSON without the speech key is an invalid fallback", async () => {
    stubReply('{"reasoning":"I am a wolf, stay quiet"}');
    const trace: DecisionTrace = {};
    const statement = await brain().dayStatement(makeView("werewolf"), trace);
    expect(statement).not.toContain("I am a wolf");
    expect(trace).toMatchObject({ source: "fallback", fallbackReason: "invalid" });
  });
});

describe("LlmBrain fallbacks", () => {
  it("every method returns a usable value and stamps the fallback", async () => {
    const fetchMock = stubFetch(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const villager = makeView("villager");
    const wolf = makeView("werewolf");
    const calls: [string, (b: LlmBrain, tr: DecisionTrace) => Promise<unknown>, (v: unknown) => void][] = [
      ["night (wolf)", (b, tr) => b.nightAction(wolf, tr), (v) => expect([1, 2, 3]).toContain((v as { targetId: number }).targetId)],
      ["night (seer)", (b, tr) => b.nightAction(makeView("seer"), tr), (v) => expect([1, 2, 3]).toContain((v as { targetId: number }).targetId)],
      ["night (doctor)", (b, tr) => b.nightAction(makeView("doctor"), tr), (v) => expect([0, 1, 2, 3]).toContain((v as { targetId: number }).targetId)],
      ["statement", (b, tr) => b.dayStatement(villager, tr), (v) => expect((v as string).length).toBeGreaterThan(0)],
      ["vote", (b, tr) => b.dayVote(villager, tr), (v) => expect(v).toHaveProperty("targetId")],
      ["wolfChat", (b, tr) => b.wolfChat(wolf, 1, tr), (v) => expect((v as string).length).toBeGreaterThan(0)],
      ["accuse", (b, tr) => b.accuse(villager, tr), (v) => expect(v).toHaveProperty("targetId")],
      ["defend", (b, tr) => b.defend(villager, AGAINST, tr), (v) => expect(v as string).toContain("Bram")],
      ["witch", (b, tr) => b.witchAction(makeView("witch"), 1, tr), (v) => expect(v).toEqual({ heal: false, poisonTargetId: null })],
      ["hunter", (b, tr) => b.hunterShot(makeView("hunter"), tr), (v) => expect([1, 2, 3]).toContain((v as { targetId: number }).targetId)],
    ];
    for (const [label, call, check] of calls) {
      const trace: DecisionTrace = {};
      const value = await call(brain(), trace);
      check(value);
      expect(trace, label).toMatchObject({ source: "fallback", fallbackReason: "error" });
      expect(trace.reasoning, label).toBeTruthy();
      expect(typeof trace.latencyMs, label).toBe("number");
    }
    expect(fetchMock).toHaveBeenCalledTimes(calls.length);
  });

  it("a villager's night makes no request and leaves the trace empty", async () => {
    const fetchMock = stubReply('{"reasoning":"x","target":1}');
    const trace: DecisionTrace = {};
    expect(await brain().nightAction(makeView("villager"), trace)).toEqual({ targetId: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trace).toEqual({});
  });

  it("works without a trace argument", async () => {
    stubFetch(async () => {
      throw new Error("down");
    });
    const b = brain();
    const villager = makeView("villager");
    await expect(b.nightAction(makeView("seer"))).resolves.toHaveProperty("targetId");
    await expect(b.dayStatement(villager)).resolves.toEqual(expect.any(String));
    await expect(b.dayVote(villager)).resolves.toHaveProperty("targetId");
    await expect(b.wolfChat(makeView("werewolf"), 2)).resolves.toEqual(expect.any(String));
    await expect(b.accuse(villager)).resolves.toHaveProperty("targetId");
    await expect(b.defend(villager, AGAINST)).resolves.toEqual(expect.any(String));
    await expect(b.witchAction(makeView("witch"), null)).resolves.toHaveProperty("heal");
    await expect(b.hunterShot(makeView("hunter"))).resolves.toHaveProperty("targetId");

    stubReply('{"reasoning":"r","statement":"I trust Bram."}');
    await expect(brain().dayStatement(villager)).resolves.toBe("I trust Bram.");
  });

  it("a prompt builder that throws falls back without a request", async () => {
    const fetchMock = stubReply('{"reasoning":"x","target":1}');
    vi.spyOn(prompts, "nightPrompt").mockImplementation(() => {
      throw new Error("prompt builder blew up");
    });
    const view = makeView("seer");
    const trace: DecisionTrace = {};
    const decision = await brain().nightAction(view, trace);
    expect(decision).toEqual(await heuristic().nightAction(view));
    expect(trace).toMatchObject({ source: "fallback", fallbackReason: "error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("LlmBrain accuse", () => {
  it("an explicit null target is the model's own pass", async () => {
    stubReply('{"reasoning":"x","target":null}');
    const trace: DecisionTrace = {};
    const decision = await brain().accuse(makeView("villager"), trace);
    expect(decision.targetId).toBeNull();
    expect(trace.source).toBe("model");
    expect(trace.reasoning).toBe("x");
  });

  it("never speaks a legacy reason key", async () => {
    stubReply('{"reason":"Bram is my packmate so I\'ll frame Cleo","target":2}');
    const trace: DecisionTrace = {};
    const decision = await brain().accuse(makeView("werewolf"), trace);
    expect(decision.targetId).toBe(2);
    expect(decision.text).toBeUndefined();
    expect(trace.source).toBe("model");
  });

  it("speaks only the accusation key and keeps the reasoning private", async () => {
    stubReply('{"reasoning":"r","target":2,"accusation":"Cleo dodged every question."}');
    const trace: DecisionTrace = {};
    const decision = await brain().accuse(makeView("villager"), trace);
    expect(decision).toEqual({ targetId: 2, text: "Cleo dodged every question." });
    expect(trace.reasoning).toBe("r");
  });

  it("a reply with no JSON object now falls back instead of silently passing", async () => {
    stubReply("I accuse Bram!");
    const trace: DecisionTrace = {};
    await brain().accuse(makeView("villager"), trace);
    expect(trace).toMatchObject({ source: "fallback", fallbackReason: "parse" });
  });
});

describe("wall-clock boundary", () => {
  it("latencyMs is the only field that can differ between two identical LLM games", async () => {
    stubFetch(async () => {
      throw new Error("provider down");
    });
    const run = (): Promise<Transcript> =>
      simulate(
        { numPlayers: 9, seatModels: Array(9).fill("stub"), seed: 21 },
        (modelId, seatId) => new LlmBrain(modelId, CFG, 1000 + seatId),
        { id: "wall", createdAt: "2026-01-01T00:00:00.000Z" }
      );
    const strip = (t: Transcript): string => {
      for (const d of t.decisions ?? []) {
        expect(typeof d.latencyMs).toBe("number");
        expect(d.source).toBe("fallback");
        delete d.latencyMs;
      }
      return JSON.stringify(t);
    };
    const a = await run();
    const b = await run();
    expect(a.decisions!.length).toBeGreaterThan(0);
    expect(strip(a)).toEqual(strip(b));
  });
});

describe("LlmBrain reads a seat label as the model's own target", () => {
  it("a vote written as a name or a seat label is not a fallback", async () => {
    for (const label of ["Cleo", "cleo", "[2]", "Seat 2", "2 (Cleo)"]) {
      stubReply(JSON.stringify({ reasoning: "r", target: label }));
      const trace: DecisionTrace = {};
      expect(await brain().dayVote(makeView("villager"), trace), label).toEqual({ targetId: 2 });
      expect(trace.source, label).toBe("model");
    }
  });

  it("an accusation at a seat label is made, not silently passed", async () => {
    stubReply(JSON.stringify({ reasoning: "r", target: "Seat 3", accusation: "Dov keeps dodging." }));
    const trace: DecisionTrace = {};
    expect(await brain().accuse(makeView("villager"), trace)).toEqual({ targetId: 3, text: "Dov keeps dodging." });
    expect(trace.source).toBe("model");
  });

  it("an ambiguous label is still no target", async () => {
    stubReply(JSON.stringify({ reasoning: "r", target: "Cleo or Dov" }));
    const trace: DecisionTrace = {};
    await brain().dayVote(makeView("villager"), trace);
    expect(trace).toMatchObject({ source: "fallback", fallbackReason: "invalid" });
  });
});
