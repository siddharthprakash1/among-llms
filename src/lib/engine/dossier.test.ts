import { describe, expect, it } from "vitest";
import { buildDossier } from "./dossier";

const players = [
  { id: 0, name: "Ada", alive: true },
  { id: 1, name: "Bram", alive: true },
  { id: 2, name: "Cyra", alive: false },
];

describe("buildDossier", () => {
  it("is empty before any history exists", () => {
    expect(buildDossier(players, [], [], [])).toBe("");
  });

  it("summarizes votes, accusations, and votes against revealed innocents", () => {
    const votes = [{ day: 1, voterId: 0, targetId: 2 }];
    const accusations = [{ day: 1, from: 1, target: 0, text: "sus" }];
    const deaths = [{ day: 1, playerId: 2, cause: "vote" as const, role: "villager" as const }];
    const d = buildDossier(players, votes, accusations, deaths);
    expect(d).toContain("Ada: voted: Cyra(D1)");
    expect(d).toContain("1 vote(s) against players revealed innocent");
    expect(d).toContain("Bram: accused: Ada(D1)");
    expect(d).not.toContain("Cyra:"); // dead players get no line
  });
});
