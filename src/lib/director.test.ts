import { describe, expect, it } from "vitest";
import { directShot, ringPositions, DirectorInput } from "./director";
import type { Shot, Vec3 } from "./director";
import { isVoteBeat, plateScale } from "./director";
import { plateSizeAt } from "./director";
import { buildBrainFactory } from "./agents/brains";
import { simulate } from "./engine/werewolf";
import { deriveState } from "./replay";

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

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Where `p` lands in the shot's frame (perspective, vertical fov): on screen within [-1, 1]. */
function project(shot: Shot, p: Vec3, aspect: number): [number, number] {
  const forward = unit(sub(shot.target, shot.position));
  const right = unit(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const d = sub(p, shot.position);
  const depth = dot(d, forward);
  const t = Math.tan((shot.fov * Math.PI) / 360);
  return [dot(d, right) / depth / (t * aspect), dot(d, up) / depth / t];
}

describe("director: the vote", () => {
  it("ballots get a crane high over the table, looking down", () => {
    const s = directShot(base({ event: "vote" }));
    expect(s.kind).toBe("vote");
    expect(finite([...s.position, ...s.target])).toBe(true);
    expect(s.position[1]).toBeGreaterThan(8);
    // steep: far higher than it is out from the centre
    expect(s.position[1]).toBeGreaterThan(3 * Math.hypot(s.position[0], s.position[2]));
    expect(s.target[1]).toBeLessThan(1);
  });

  it("the tally keeps the crane", () => {
    const s = directShot(base({ event: "vote_result" }));
    expect(s.kind).toBe("vote");
    expect(s.position[1]).toBeGreaterThan(8);
  });

  it("every seat and nameplate stays in frame and below the phase banner, at any drift angle", () => {
    let side = 0;
    let top = -Infinity;
    let bottom = Infinity;
    for (let n = 5; n <= 12; n++) {
      const seats = ringPositions(n);
      for (let time = 0; time < 130; time += 0.5) {
        const s = directShot(base({ event: "vote", seatPositions: seats, time }));
        for (const [x, , z] of seats) {
          // feet and nameplate, in a frame squarer than any desktop stage
          for (const y of [0, 1.75]) {
            const [sx, sy] = project(s, [x, y, z], 1);
            side = Math.max(side, Math.abs(sx));
            top = Math.max(top, sy);
            bottom = Math.min(bottom, sy);
          }
        }
      }
    }
    expect(side).toBeLessThan(0.8);
    expect(top).toBeLessThan(0.7); // the phase banner owns the top of the frame
    expect(bottom).toBeGreaterThan(-0.8);
  });

  it("drifts slowly", () => {
    const a = directShot(base({ event: "vote", time: 10 }));
    const b = directShot(base({ event: "vote", time: 11 }));
    expect(a.position).not.toEqual(b.position);
    const turn = Math.atan2(b.position[2], b.position[0]) - Math.atan2(a.position[2], a.position[0]);
    expect(Math.abs(turn)).toBeLessThan(0.1); // radians per second
  });

  it("stays inside the clearing, clear of the lanterns and above the treetops", () => {
    for (let time = 0; time < 130; time += 1) {
      const [x, y, z] = directShot(base({ event: "vote_result", time })).position;
      expect(Math.hypot(x, z)).toBeLessThan(8.1); // lantern ring
      expect(y).toBeGreaterThan(3.1); // tree tops
    }
  });

  it("is deterministic", () => {
    const a = directShot(base({ event: "vote", time: 7.25 }));
    const b = directShot(base({ event: "vote", time: 7.25 }));
    expect(a).toEqual(b);
  });

  it("the death the vote causes still cuts to the kill close-up", () => {
    const s = directShot(base({ event: "death", highlight: { eliminatedId: 2 } }));
    expect(s.kind).toBe("kill");
    expect(s.focusSeatId).toBe(2);
    expect(s.position[1]).toBeLessThan(1);
  });

  it("other day beats keep their shots", () => {
    expect(directShot(base({ event: "statement", highlight: { speakingId: 3 } })).kind).toBe("speaker");
    expect(directShot(base({ event: "phase" })).kind).toBe("orbit");
    expect(directShot(base({ event: "game_over", phase: "over", finished: true })).kind).toBe("finale");
  });
});

// What the stage draws, in CSS px (Scene3D, ReplayPlayer). drei's Html scales a nameplate by
// distanceFactor / (2 tan(fov/2) distance) whatever the canvas size, so on a smaller stage the
// plates take up more of it. Plate box at scale 1: 90 wide, 64.5 tall (avatar 30, name 18,
// role 16.5); a dead seat's plate turns sideways at y 1.1. The phase banner covers the top
// 54.25px, or a second sublabel line more on a phone, where it is narrow.
const DISTANCE_FACTOR = 6;
const NAME_PX = 12;
const PLATES = [
  { y: 1.75, w: 90, h: 64.5 },
  { y: 1.1, w: 64.5, h: 90 },
];

type WholeTable = "vote" | "finale";

function wholeTableShot(kind: WholeTable, seats: Vec3[], time: number, aspect?: number): Shot {
  return kind === "vote"
    ? directShot(base({ event: "vote", seatPositions: seats, time, aspect }))
    : directShot(base({ event: "game_over", phase: "over", finished: true, seatPositions: seats, time, aspect }));
}

/** Every plate of 5 to 12 seats over a full turn of the shot, in px on a W x H stage. */
function platesOnStage(kind: WholeTable, W: number, H: number) {
  const boxes: { left: number; right: number; top: number; bottom: number; namePx: number }[] = [];
  const turn = (2 * Math.PI) / (kind === "vote" ? 0.05 : 0.12);
  const scale = plateScale(kind === "vote" ? "vote" : "game_over");
  for (let n = 5; n <= 12; n++) {
    const seats = ringPositions(n);
    for (let time = 0; time < turn; time += 0.5) {
      const s = wholeTableShot(kind, seats, time, W / H);
      for (const [x, , z] of seats) {
        for (const plate of PLATES) {
          const at: Vec3 = [x, plate.y, z];
          const [sx, sy] = project(s, at, W / H);
          const px = ((sx + 1) / 2) * W;
          const py = ((1 - sy) / 2) * H;
          const k =
            (DISTANCE_FACTOR * scale) /
            (2 * Math.tan((s.fov * Math.PI) / 360) * Math.hypot(...sub(at, s.position)));
          const hw = (plate.w * k) / 2;
          const hh = (plate.h * k) / 2;
          boxes.push({ left: px - hw, right: px + hw, top: py - hh, bottom: py + hh, namePx: NAME_PX * k });
        }
      }
    }
  }
  return boxes;
}

describe("director: the whole-table shots on any stage", () => {
  const halfWidth = (s: Shot, aspect: number) => Math.tan((s.fov * Math.PI) / 360) * aspect;
  const finale = (aspect?: number) => wholeTableShot("finale", ringPositions(7), 1, aspect);
  const crane = (aspect?: number) => wholeTableShot("vote", ringPositions(7), 1, aspect);

  it("keep their fov on stages as wide as they were composed for", () => {
    for (const aspect of [undefined, 732 / 588, 1.66, 2.15]) expect(finale(aspect).fov).toBe(45);
    for (const aspect of [undefined, 1, 1.24, 2.15]) expect(crane(aspect).fov).toBe(58);
    for (const aspect of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(finale(aspect).fov).toBe(45);
      expect(crane(aspect).fov).toBe(58);
    }
  });

  it("keep the composed horizontal field of view on a narrower stage", () => {
    for (const aspect of [0.64, 0.76, 1]) {
      expect(halfWidth(finale(aspect), aspect)).toBeCloseTo(halfWidth(finale(), 732 / 588), 9);
    }
    for (const aspect of [0.64, 0.76, 0.98]) {
      expect(halfWidth(crane(aspect), aspect)).toBeCloseTo(halfWidth(crane(), 1), 9);
    }
  });

  it("close-ups never widen", () => {
    expect(directShot(base({ highlight: { speakingId: 3 }, aspect: 0.6 })).fov).toBe(40);
    expect(directShot(base({ highlight: { killId: 2 }, aspect: 0.6 })).fov).toBe(38);
  });

  it("keep every nameplate on the stage, and the crane's below the phase banner, from phones to desktops", () => {
    const stages = [[280, 440], [335, 440], [374, 440], [589, 440], [589, 588], [589, 600], [728, 440], [732, 440], [732, 588]];
    for (const [W, H] of stages) {
      for (const kind of ["vote", "finale"] as const) {
        const banner = kind === "vote" ? (W < 420 ? 70.75 : 54.25) : 0;
        const boxes = platesOnStage(kind, W, H);
        const label = `${kind} ${W}x${H}`;
        expect(Math.min(...boxes.map((b) => b.left)), label).toBeGreaterThanOrEqual(0);
        expect(Math.max(...boxes.map((b) => b.right)), label).toBeLessThanOrEqual(W);
        expect(Math.min(...boxes.map((b) => b.top)), label).toBeGreaterThanOrEqual(banner);
        expect(Math.max(...boxes.map((b) => b.bottom)), label).toBeLessThanOrEqual(H);
      }
    }
  });

  it("the crane draws its names at a readable size on desktop stages", () => {
    for (const [W, H] of [[589, 440], [589, 588], [732, 588]]) {
      const smallest = Math.min(...platesOnStage("vote", W, H).map((b) => b.namePx));
      expect(smallest, `${W}x${H}`).toBeGreaterThan(7.5);
    }
  });

  it("the plates grow exactly on the beats the crane films, through a whole game", async () => {
    const t = await simulate(
      { numPlayers: 8, seatModels: Array(8).fill("mock"), seed: 4 },
      buildBrainFactory(4),
      { id: "director", createdAt: "2026-01-01T00:00:00.000Z" }
    );
    const seats = ringPositions(t.players.length);
    let craned = 0;
    for (let step = 0; step < t.events.length; step++) {
      const state = deriveState(t, step);
      const event = t.events[step].kind;
      const shot = directShot({
        phase: state.phase,
        finished: state.finished,
        highlight: state.highlight,
        seatPositions: seats,
        time: step,
        event,
      });
      expect(plateScale(event) > 1, `step ${step} (${event})`).toBe(shot.kind === "vote");
      if (isVoteBeat(event)) craned++;
    }
    expect(craned).toBeGreaterThan(0);
  });
});

// drei Html's size for distanceFactor 6, which plateSizeAt stands in for.
const dreiPlateSize = (distance: number, fov: number) =>
  6 / (2 * Math.tan((fov * Math.PI) / 360) * distance);

describe("director: nameplate size", () => {
  it("is drei's distanceFactor size to within half a 2% step", () => {
    for (const fov of [40, 45, 58, 72]) {
      for (let d = 2; d <= 20; d += 0.37) {
        const ratio = plateSizeAt(d, fov) / dreiPlateSize(d, fov);
        expect(ratio).toBeGreaterThan(1 / 1.0101);
        expect(ratio).toBeLessThan(1.0101);
      }
    }
  });

  it("changes on few frames of the finale orbit, so moving plates are rarely redrawn", () => {
    // Ten seconds of the closing orbit at 60 fps, on the nearest and the farthest seat.
    const seats = ringPositions(9);
    for (const seat of [seats[0], seats[4]]) {
      const plate: Vec3 = [seat[0], 1.75, seat[2]];
      let resized = 0;
      let exactChanges = 0;
      let last = 0;
      let lastExact = 0;
      for (let f = 0; f < 600; f++) {
        const s = directShot(base({ finished: true, seatPositions: seats, time: f / 60 }));
        const d = Math.hypot(...sub(plate, s.position));
        const size = plateSizeAt(d, s.fov);
        const exact = dreiPlateSize(d, s.fov);
        if (f > 0 && size !== last) resized++;
        if (f > 0 && exact !== lastExact) exactChanges++;
        last = size;
        lastExact = exact;
      }
      expect(exactChanges).toBeGreaterThan(590);
      expect(resized).toBeLessThan(60);
    }
  });

  it("stays finite when the camera sits on the plate", () => {
    expect(Number.isFinite(plateSizeAt(0, 45))).toBe(true);
  });
});
