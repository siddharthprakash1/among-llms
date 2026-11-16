import { describe, expect, it } from "vitest";
import { buildPromptSpec, legalTargets, validateAnswer } from "./legal";
import type { PromptKind } from "./types";
import { makeView } from "./testUtil";

describe("legalTargets", () => {
  it("lets a wolf kill anyone alive outside the pack", () => {
    expect(legalTargets("night_kill", makeView("werewolf"))).toEqual([2, 3, 4, 5]);
  });

  it("excludes self for check, vote, accuse, poison and the hunter's shot", () => {
    const kinds: PromptKind[] = ["night_check", "vote", "accuse", "witch", "hunter_shot"];
    for (const kind of kinds) expect(legalTargets(kind, makeView("seer"))).toEqual([1, 2, 3, 4, 5]);
  });

  it("gives a dead hunter every living player", () => {
    const view = makeView("hunter", { aliveIds: [1, 2, 3] });
    expect(legalTargets("hunter_shot", view)).toEqual([1, 2, 3]);
  });

  it("lets the doctor protect anyone alive, self included", () => {
    expect(legalTargets("night_protect", makeView("doctor"))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("has no targets for text prompts", () => {
    for (const kind of ["wolf_chat", "statement", "defend"] as PromptKind[]) {
      expect(legalTargets(kind, makeView("werewolf"))).toEqual([]);
    }
  });

  it("returns a copy, not the view's own array", () => {
    const view = makeView("doctor");
    legalTargets("night_protect", view).push(99);
    expect(view.aliveIds).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("buildPromptSpec", () => {
  it("sets pass and text limits per kind", () => {
    const view = makeView("werewolf");
    for (const kind of ["night_kill", "night_check", "night_protect", "hunter_shot"] as PromptKind[]) {
      expect(buildPromptSpec(kind, view)).toMatchObject({ allowPass: false, maxChars: 0 });
    }
    expect(buildPromptSpec("vote", view)).toMatchObject({ allowPass: true, maxChars: 0 });
    expect(buildPromptSpec("accuse", view)).toMatchObject({ allowPass: true, maxChars: 240 });
    expect(buildPromptSpec("wolf_chat", view, { round: 2 })).toMatchObject({ allowPass: true, maxChars: 240, round: 2 });
    expect(buildPromptSpec("statement", view)).toMatchObject({ allowPass: true, maxChars: 280, day: 2, phase: "day" });
  });

  it("offers claimable wolves only to a seer with a living evil result", () => {
    const results = [
      { day: 1, targetId: 3, alignment: "evil" as const },
      { day: 1, targetId: 3, alignment: "evil" as const },
      { day: 2, targetId: 4, alignment: "good" as const },
      { day: 2, targetId: 6, alignment: "evil" as const }, // dead
    ];
    expect(buildPromptSpec("statement", makeView("seer", { seerResults: results })).claimableWolves).toEqual([3]);
    expect(buildPromptSpec("statement", makeView("seer")).claimableWolves).toBeUndefined();
    expect(
      buildPromptSpec("statement", makeView("seer", { seerResults: [results[2], results[3]] }))
    ).not.toHaveProperty("claimableWolves");
    expect(buildPromptSpec("statement", makeView("villager", { seerResults: results })).claimableWolves).toBeUndefined();
    expect(buildPromptSpec("vote", makeView("seer", { seerResults: results })).claimableWolves).toBeUndefined();
  });

  it("carries only from and text of the accusations in a defend prompt", () => {
    const against = [{ day: 2, from: 3, target: 0, text: "liar", reasoning: "SECRET" }];
    const spec = buildPromptSpec("defend", makeView("villager"), { against });
    expect(spec.against).toEqual([{ from: 3, text: "liar" }]);
    expect(spec.maxChars).toBe(280);
  });

  it("copies the witch's potions and the wolves' target", () => {
    const view = makeView("witch", { potions: { heal: true, poison: false } });
    const spec = buildPromptSpec("witch", view, { wolfTargetId: 3 });
    expect(spec).toMatchObject({ wolfTargetId: 3, potions: { heal: true, poison: false }, allowPass: true });
    expect(spec.potions).not.toBe(view.potions);
    expect(buildPromptSpec("witch", makeView("villager")).potions).toEqual({ heal: false, poison: false });
    expect(buildPromptSpec("witch", view).wolfTargetId).toBeNull();
  });
});

describe("validateAnswer", () => {
  const kill = buildPromptSpec("night_kill", makeView("werewolf"));
  const vote = buildPromptSpec("vote", makeView("villager"));
  const accuse = buildPromptSpec("accuse", makeView("villager"));
  const chat = buildPromptSpec("wolf_chat", makeView("werewolf"), { round: 1 });
  const statement = buildPromptSpec("statement", makeView("villager"));
  const seerStatement = buildPromptSpec(
    "statement",
    makeView("seer", { seerResults: [{ day: 1, targetId: 3, alignment: "evil" }] })
  );
  const witch = (potions: { heal: boolean; poison: boolean }, wolfTargetId: number | null) =>
    buildPromptSpec("witch", makeView("witch", { potions }), { wolfTargetId });
  const isError = (v: unknown) => typeof v === "object" && v !== null && "error" in v;

  it("rejects illegal and missing targets", () => {
    expect(isError(validateAnswer(kill, { kind: "target", targetId: 1 }))).toBe(true); // packmate
    expect(isError(validateAnswer(kill, { kind: "target", targetId: 6 }))).toBe(true); // dead
    expect(isError(validateAnswer(kill, { kind: "target", targetId: null }))).toBe(true);
    expect(isError(validateAnswer(kill, { kind: "target", targetId: 2.5 }))).toBe(true);
    expect(isError(validateAnswer(kill, { kind: "target", targetId: "2" }))).toBe(true);
    expect(isError(validateAnswer(vote, { kind: "target", targetId: 0 }))).toBe(true); // self
    expect(isError(validateAnswer(accuse, { kind: "accuse", targetId: 0 }))).toBe(true);
  });

  it("rejects the wrong answer kind", () => {
    expect(isError(validateAnswer(kill, { kind: "text", text: "2" }))).toBe(true);
    expect(isError(validateAnswer(vote, { kind: "accuse", targetId: 2 }))).toBe(true);
    expect(isError(validateAnswer(accuse, { kind: "target", targetId: 2 }))).toBe(true);
    expect(isError(validateAnswer(chat, { kind: "target", targetId: 2 }))).toBe(true);
    expect(isError(validateAnswer(statement, { kind: "witch", heal: false, poisonTargetId: null }))).toBe(true);
    expect(isError(validateAnswer(witch({ heal: true, poison: true }, 3), { kind: "target", targetId: 3 }))).toBe(true);
  });

  it("rejects illegal potion use", () => {
    expect(isError(validateAnswer(witch({ heal: false, poison: true }, 3), { kind: "witch", heal: true, poisonTargetId: null }))).toBe(true);
    expect(isError(validateAnswer(witch({ heal: true, poison: true }, null), { kind: "witch", heal: true, poisonTargetId: null }))).toBe(true);
    expect(isError(validateAnswer(witch({ heal: true, poison: true }, 3), { kind: "witch", heal: true, poisonTargetId: 2 }))).toBe(true);
    expect(isError(validateAnswer(witch({ heal: true, poison: false }, 3), { kind: "witch", heal: false, poisonTargetId: 2 }))).toBe(true);
    expect(isError(validateAnswer(witch({ heal: true, poison: true }, 3), { kind: "witch", heal: false, poisonTargetId: 0 }))).toBe(true);
    expect(isError(validateAnswer(witch({ heal: true, poison: true }, 3), { kind: "witch", heal: "yes", poisonTargetId: null }))).toBe(true);
  });

  it("rejects a seer claim outside claimableWolves", () => {
    expect(isError(validateAnswer(seerStatement, { kind: "seer_claim", targetId: 4 }))).toBe(true);
    expect(isError(validateAnswer(statement, { kind: "seer_claim", targetId: 3 }))).toBe(true);
  });

  it("rejects non-object bodies and over-long strings", () => {
    for (const body of [null, undefined, "x", 5, [], [{ kind: "text", text: "a" }]]) {
      expect(isError(validateAnswer(statement, body))).toBe(true);
    }
    expect(isError(validateAnswer(statement, { kind: "text", text: "x".repeat(2001) }))).toBe(true);
    expect(isError(validateAnswer(statement, { kind: "text" }))).toBe(true);
    expect(isError(validateAnswer(statement, { kind: "text", text: 5 }))).toBe(true);
    expect(isError(validateAnswer(accuse, { kind: "accuse", targetId: 2, text: "x".repeat(2001) }))).toBe(true);
    expect(isError(validateAnswer(accuse, { kind: "accuse", targetId: 2, text: 7 }))).toBe(true);
  });

  it("accepts each legal shape and rebuilds it from named fields only", () => {
    const extra = { promptId: "1", reasoning: "SECRET", admin: true };
    expect(validateAnswer(kill, { kind: "target", targetId: 2, ...extra })).toEqual({ kind: "target", targetId: 2 });
    expect(validateAnswer(vote, { kind: "target", targetId: null, ...extra })).toEqual({ kind: "target", targetId: null });
    expect(validateAnswer(vote, { kind: "target", targetId: 3, ...extra })).toEqual({ kind: "target", targetId: 3 });
    expect(validateAnswer(accuse, { kind: "accuse", targetId: null, ...extra })).toEqual({ kind: "accuse", targetId: null });
    expect(validateAnswer(accuse, { kind: "accuse", targetId: 2, text: "why", ...extra })).toEqual({
      kind: "accuse", targetId: 2, text: "why",
    });
    expect(validateAnswer(chat, { kind: "text", text: "", ...extra })).toEqual({ kind: "text", text: "" });
    expect(validateAnswer(statement, { kind: "text", text: "x".repeat(2000), ...extra })).toEqual({
      kind: "text", text: "x".repeat(2000),
    });
    expect(validateAnswer(seerStatement, { kind: "seer_claim", targetId: 3, text: "extra", ...extra })).toEqual({
      kind: "seer_claim", targetId: 3,
    });
    const w = witch({ heal: true, poison: true }, 3);
    expect(validateAnswer(w, { kind: "witch", heal: true, poisonTargetId: null, ...extra })).toEqual({
      kind: "witch", heal: true, poisonTargetId: null,
    });
    expect(validateAnswer(w, { kind: "witch", heal: false, poisonTargetId: 2, ...extra })).toEqual({
      kind: "witch", heal: false, poisonTargetId: 2,
    });
    expect(validateAnswer(w, { kind: "witch", heal: false, poisonTargetId: null, ...extra })).toEqual({
      kind: "witch", heal: false, poisonTargetId: null,
    });
  });
});
