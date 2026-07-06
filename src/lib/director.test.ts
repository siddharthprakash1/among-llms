import { describe, expect, it } from "vitest";
import { directShot, ringPositions, DirectorInput } from "./director";

const base = (over: Partial<DirectorInput> = {}): DirectorInput => ({
  phase: "day",
  finished: false,
  highlight: {},
  seatPositions: ringPositions(7),
  time: 1,
  ...over,
});

function finite(v: number[]): boolean {
  return v.every((n) => Number.isFinite(n));
}

describe("director", () => {
  it("ring positions are evenly placed on a circle at y=0", () => {
    const p = ringPositions(6, 4);
    expect(p).toHaveLength(6);
    for (const [x, y, z] of p) {
      expect(y).toBe(0);
      expect(Math.hypot(x, z)).toBeCloseTo(4, 5);
    }
  });

  it("a finished game gets the finale shot", () => {
    const s = directShot(base({ finished: true }));
    expect(s.kind).toBe("finale");
    expect(finite([...s.position, ...s.target])).toBe(true);
  });

  it("a speaker gets a push-in framed on that seat", () => {
    const s = directShot(base({ highlight: { speakingId: 3 } }));
    expect(s.kind).toBe("speaker");
    expect(s.focusSeatId).toBe(3);
    // target is near seat 3's x/z
    const seat = ringPositions(7)[3];
    expect(s.target[0]).toBeCloseTo(seat[0], 5);
    expect(s.target[2]).toBeCloseTo(seat[2], 5);
  });

  it("a kill takes priority over a speaker and frames the victim low", () => {
    const s = directShot(base({ phase: "night", highlight: { killId: 2, speakingId: 5 } }));
    expect(s.kind).toBe("kill");
    expect(s.focusSeatId).toBe(2);
    expect(s.position[1]).toBeLessThan(1); // low angle
  });

  it("idle night falls back to a slow orbit", () => {
    const s = directShot(base({ phase: "night", highlight: {} }));
    expect(s.kind).toBe("orbit");
  });

  it("orbit shots move over time (not static)", () => {
    const a = directShot(base({ phase: "night", time: 0 }));
    const b = directShot(base({ phase: "night", time: 3 }));
    expect(a.position).not.toEqual(b.position);
  });
});
