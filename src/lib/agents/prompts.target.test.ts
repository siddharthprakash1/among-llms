import { describe, expect, it } from "vitest";
import { parseTargetResponse, parseWitchResponse } from "./prompts";
import { makeView } from "../human/testUtil";

// Seats: Aria 0 (self), Bishop 1, Cleo 2, Dax 3, Echo 4, Fable 5, Gray 6 (dead).
const view = makeView("villager");
const target = (t: unknown) => parseTargetResponse(JSON.stringify({ reasoning: "r", target: t }), view);

describe("target coercion", () => {
  it("still reads numbers, numeric strings and exact names", () => {
    expect(target(3)).toBe(3);
    expect(target(3.0)).toBe(3);
    expect(target("3")).toBe(3);
    expect(target(" 3 ")).toBe(3);
    expect(target("Dax")).toBe(3);
    expect(target(null)).toBeNull();
    expect(target("null")).toBeNull();
    expect(target("")).toBeNull();
  });

  it("reads a seat written as a label when every part names the same seat", () => {
    const labels = [
      "dax",
      "DAX",
      " Dax. ",
      "[3]",
      "Seat 3",
      "seat #3",
      "#3",
      "Player 3",
      "3 (Dax)",
      "Dax (3)",
      "Dax [3]",
      "[3] Dax",
      "[3] Dax \u{2014} alive",
      "Seat 3: Dax",
      "\u{1F438} Dax",
    ];
    for (const label of labels) expect(target(label), label).toBe(3);
    expect(target([3])).toBe(3);
    expect(target(["Dax"])).toBe(3);
  });

  it("never guesses: two seats, a sentence or a non-label is no target", () => {
    const labels = [
      "3 (Echo)",
      "Dax (4)",
      "Dax or Echo",
      "Dax, Echo",
      "Dax and Echo",
      "[3] [4]",
      "Seat 3 or 4",
      "not Dax",
      "I vote for Dax",
      "Dax (the wolf)",
      "Daxter",
      "nobody",
      "none",
      "abstain",
      "Seat",
      "three",
    ];
    for (const label of labels) expect(target(label), label).toBeNull();
    expect(target([3, 4])).toBeNull();
    expect(target([])).toBeNull();
    expect(target({ id: 3 })).toBeNull();
    expect(target(true)).toBeNull();
  });

  it("resolves the seat and leaves legality to the engine", () => {
    expect(target("Gray")).toBe(6); // dead
    expect(target("Aria")).toBe(0); // the speaker
    expect(target("Seat 9")).toBe(9); // no such seat
  });

  it("applies to the witch's poison", () => {
    const witch = makeView("witch");
    const poison = (p: unknown) =>
      parseWitchResponse(JSON.stringify({ reasoning: "r", heal: false, poison: p }), witch);
    expect(poison("Seat 3")).toEqual({ heal: false, poisonTargetId: 3 });
    expect(poison("echo")).toEqual({ heal: false, poisonTargetId: 4 });
    expect(poison("none")).toEqual({ heal: false, poisonTargetId: null });
    expect(poison("Dax or Echo")).toEqual({ heal: false, poisonTargetId: null });
  });
});
