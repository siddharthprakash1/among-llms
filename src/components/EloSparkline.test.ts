import { describe, expect, it } from "vitest";
import { sparklinePoints } from "./EloSparkline";
import { EloHistoryEntry } from "@/lib/elo";

describe("sparklinePoints", () => {
  it("computes the exact points string for a 3-entry history", () => {
    const history: EloHistoryEntry[] = [
      { gameId: "g1", delta: 12, elo: 1012 },
      { gameId: "g2", delta: -20, elo: 992 },
      { gameId: "g3", delta: 8, elo: 1000 },
    ];
    // width=100, height=50. min=992, max=1012, span=20.
    // i=0: x=0,               y=50-((1012-992)/20)*50=50-50=0
    // i=1: x=(1/2)*100=50,    y=50-((992-992)/20)*50=50-0=50
    // i=2: x=(2/2)*100=100,   y=50-((1000-992)/20)*50=50-20=30
    expect(sparklinePoints(history, 100, 50)).toBe("0,0 50,50 100,30");
  });

  it("returns an empty string for zero entries", () => {
    expect(sparklinePoints([], 100, 50)).toBe("");
  });

  it("returns a flat two-point line for a single entry", () => {
    const history: EloHistoryEntry[] = [{ gameId: "g1", delta: 12, elo: 1012 }];
    expect(sparklinePoints(history, 100, 50)).toBe("0,25 100,25");
  });

  it("centers the flat line at y=height/2 when all elo values are equal", () => {
    // span collapses to 0 when max===min, so rather than pin the line to the
    // bottom edge we center it vertically at height/2.
    const history: EloHistoryEntry[] = [
      { gameId: "g1", delta: 0, elo: 1000 },
      { gameId: "g2", delta: 0, elo: 1000 },
    ];
    expect(sparklinePoints(history, 100, 50)).toBe("0,25 100,25");
  });
});
