import { describe, expect, it } from "vitest";
import { plural } from "./ui";

describe("plural", () => {
  it("uses the singular for exactly one", () => {
    expect(plural(1, "statement")).toBe("1 statement");
  });

  it("adds an s for zero, several and fractional counts", () => {
    expect(plural(0, "statement")).toBe("0 statements");
    expect(plural(2, "statement")).toBe("2 statements");
    expect(plural(12, "day")).toBe("12 days");
    expect(plural(1.5, "day")).toBe("1.5 days");
  });

  it("takes an explicit plural for irregular nouns", () => {
    expect(plural(1, "wolf", "wolves")).toBe("1 wolf");
    expect(plural(3, "wolf", "wolves")).toBe("3 wolves");
  });

  it("pluralises only the last word of a multi-word noun", () => {
    expect(plural(1, "engine override")).toBe("1 engine override");
    expect(plural(4, "engine override")).toBe("4 engine overrides");
  });
});
