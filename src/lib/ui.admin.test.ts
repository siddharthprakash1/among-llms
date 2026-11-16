import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_TOKEN_KEY, adminHeaders, withoutLocked } from "./ui";

const withStorage = (getItem: (k: string) => string | null) =>
  vi.stubGlobal("window", { localStorage: { getItem } });

afterEach(() => vi.unstubAllGlobals());

describe("adminHeaders", () => {
  it("is empty during SSR", () => {
    expect(adminHeaders()).toEqual({});
  });

  it("sends the saved token as a Bearer header", () => {
    withStorage((k) => (k === ADMIN_TOKEN_KEY ? "  secret-token-value  " : null));
    expect(adminHeaders()).toEqual({ authorization: "Bearer secret-token-value" });
  });

  it("is empty for a missing or blank token and when storage throws", () => {
    withStorage(() => null);
    expect(adminHeaders()).toEqual({});
    withStorage(() => "   ");
    expect(adminHeaders()).toEqual({});
    withStorage(() => {
      throw new Error("blocked");
    });
    expect(adminHeaders()).toEqual({});
  });
});

describe("withoutLocked", () => {
  it("returns the same array when nothing selected is locked", () => {
    const selected = ["mock", "gpt-x"];
    expect(withoutLocked(selected, [])).toBe(selected);
    expect(withoutLocked(selected, ["claude-y"])).toBe(selected);
  });

  it("drops locked ids and keeps the rest in order", () => {
    expect(withoutLocked(["gpt-x", "mock", "hunter-bot"], ["gpt-x"])).toEqual(["mock", "hunter-bot"]);
  });

  it("falls back to the mock bot when every selected id is locked", () => {
    expect(withoutLocked(["gpt-x", "claude-y"], ["gpt-x", "claude-y"])).toEqual(["mock"]);
  });
});
