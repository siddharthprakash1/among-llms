import { describe, expect, it } from "vitest";
import { ROLE_HELP, ROLE_META, modelLabel, roleNoun } from "./ui";
import type { Role } from "./engine/types";

describe("ui helpers for the human seat", () => {
  it("labels the reserved human model id", () => {
    expect(modelLabel("human")).toContain("Human");
    expect(modelLabel("mock")).toBe("Mock bot");
  });

  it("has a help line for every role", () => {
    for (const role of Object.keys(ROLE_META) as Role[]) {
      expect(ROLE_HELP[role].length).toBeGreaterThan(10);
    }
  });

  it("uses the indefinite article only for roles dealt more than once", () => {
    expect(roleNoun("werewolf")).toBe("a Werewolf");
    expect(roleNoun("villager")).toBe("a Villager");
    expect(roleNoun("doctor")).toBe("the Doctor");
    expect(roleNoun("jester")).toBe("the Jester");
  });
});
