// Auto-director camera: a PURE function mapping the current replay moment to a
// camera "shot" (position + look-at target + fov). The 3D scene lerps toward
// whatever this returns each frame, so all cinematography lives here and is
// unit-testable with no WebGL. `time` is passed in (never Date.now) so shots
// stay deterministic and testable.

export type ShotKind = "establish" | "orbit" | "speaker" | "kill" | "vote" | "finale";

export type Vec3 = [number, number, number];

export interface Shot {
  kind: ShotKind;
  position: Vec3;
  target: Vec3;
  fov: number;
  focusSeatId?: number;
}

export interface DirectorInput {
  phase: "pregame" | "night" | "day" | "over";
  finished: boolean;
  highlight: {
    speakingId?: number;
    killId?: number;
    eliminatedId?: number;
    accusedId?: number;
    saveId?: number;
    checkId?: number;
  };
  /** World position of each seat, indexed by seat id. */
  seatPositions: Vec3[];
  /** Seconds since start (monotonic) — drives idle orbit motion. */
  time: number;
}

const CENTER: Vec3 = [0, 0.6, 0];

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function norm(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** A framing that looks at `seat` from outside the ring — good for portraits. */
function portrait(seat: Vec3, dist: number, height: number): Vec3 {
  const outward = norm(sub([seat[0], 0, seat[2]], [CENTER[0], 0, CENTER[2]]));
  return add(add(seat, scale(outward, dist)), [0, height, 0]);
}

/** Slow idle orbit around the table. */
function orbit(time: number, radius: number, height: number, speed: number): Vec3 {
  const a = time * speed;
  return [Math.cos(a) * radius, height, Math.sin(a) * radius];
}

export function directShot(input: DirectorInput): Shot {
  const { phase, finished, highlight, seatPositions, time } = input;
  const seat = (id?: number): Vec3 | null =>
    id !== undefined && seatPositions[id] ? seatPositions[id] : null;

  if (finished || phase === "over") {
    return { kind: "finale", position: orbit(time, 9, 6.5, 0.12), target: CENTER, fov: 45 };
  }

  const killSeat = seat(highlight.killId) ?? seat(highlight.eliminatedId);
  if (killSeat) {
    return {
      kind: "kill",
      position: portrait(killSeat, 2.4, 0.5), // low, close, dramatic
      target: [killSeat[0], 0.9, killSeat[2]],
      fov: 38,
      focusSeatId: highlight.killId ?? highlight.eliminatedId,
    };
  }

  const speakSeat = seat(highlight.speakingId);
  if (speakSeat) {
    return {
      kind: "speaker",
      position: portrait(speakSeat, 3.0, 1.6), // eye-level push-in
      target: [speakSeat[0], 1.1, speakSeat[2]],
      fov: 40,
      focusSeatId: highlight.speakingId,
    };
  }

  if (phase === "night") {
    return { kind: "orbit", position: orbit(time, 6.5, 2.6, 0.18), target: CENTER, fov: 44 };
  }
  if (phase === "day") {
    return { kind: "orbit", position: orbit(time, 7, 4.2, 0.14), target: CENTER, fov: 46 };
  }
  return { kind: "establish", position: [0, 7.5, 9], target: CENTER, fov: 42 };
}

/** Seat world positions in a ring, matching the 2D table layout order. */
export function ringPositions(count: number, radius = 4.2): Vec3[] {
  return Array.from({ length: count }, (_, i) => {
    const a = (-90 + (360 / count) * i) * (Math.PI / 180);
    return [Math.cos(a) * radius, 0, Math.sin(a) * radius] as Vec3;
  });
}
