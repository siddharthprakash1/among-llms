import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static scan: a new mutating route cannot ship without the guard. Routes that
// start something call checkStart; a route that acts inside an already admitted
// game (the human seat) calls checkAct after its own token check.
const API = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "api");
const MUTATING = /export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/;

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return routes(p);
    return e.name === "route.ts" ? [p] : [];
  });
}

const rel = (p: string) => path.relative(API, p).split(path.sep).join("/");
const mutating = routes(API)
  .map((p) => ({ name: rel(p), text: readFileSync(p, "utf8") }))
  .filter((r) => MUTATING.test(r.text));

describe("guard wiring", () => {
  it("finds the mutating routes", () => {
    expect(mutating.map((r) => r.name).sort()).toEqual([
      "games/[id]/seat/act/route.ts",
      "games/human/route.ts",
      "games/live/route.ts",
      "games/route.ts",
      "tournaments/route.ts",
    ]);
  });

  it("every mutating route reads its body through the capped reader and calls the guard", () => {
    for (const r of mutating) {
      expect(r.text, r.name).toContain("readJsonBody(");
      expect(/check(Start|Act)\(/.test(r.text), r.name).toBe(true);
      expect(r.text, r.name).toContain("denied(");
      expect(r.text, r.name).not.toMatch(/req\.json\(\)/);
    }
  });

  it("every route that starts a game or a tournament calls checkStart", () => {
    const starts = mutating.filter((r) => !r.name.includes("/seat/"));
    expect(starts.length).toBeGreaterThanOrEqual(4);
    for (const r of starts) expect(r.text, r.name).toContain("checkStart(");
  });

  it("the seat route checks the seat token before the guard", () => {
    const act = mutating.find((r) => r.name === "games/[id]/seat/act/route.ts")!;
    const verify = act.text.indexOf("verifySeat(id");
    expect(verify).toBeGreaterThan(-1);
    expect(act.text.indexOf("checkAct(")).toBeGreaterThan(verify);
    expect(act.text.indexOf("readJsonBody(")).toBeGreaterThan(verify);
  });
});
