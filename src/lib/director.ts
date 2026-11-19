// Auto-director camera: a PURE function mapping the current replay moment to a
// camera "shot" (position + look-at target + fov). The 3D scene lerps toward
// whatever this returns each frame, so all cinematography lives here and is
// unit-testable with no WebGL. `time` is passed in (never Date.now) so shots
// stay deterministic and testable.

import type { GameEvent } from "./engine/types";

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
  /** Kind of the event on screen. The vote has no highlight, so this is how the director sees it. */
  event?: GameEvent["kind"];
  /** Width / height of the stage, when known. The whole-table shots widen on narrow stages. */
  aspect?: number;
}

const CENTER: Vec3 = [0, 0.6, 0];

// The vote crane: high over the table (75° down, 12 units out), aimed a little past the
// centre so the far seats sit below the phase banner. Pulled back this far so every seat,
// nameplate (drawn at plateScale) and fallen pawn stays in frame at any drift angle on a
// stage down to 440px tall: nameplates keep their pixel size as the stage shrinks, so short
// is the tight case. Composed for stages at least square; narrower ones get a wider fov.
const CRANE = { radius: 2.85, height: 11.9, lead: 0.25, aimHeight: 0.3, speed: 0.05, fov: 58, minAspect: 1 };

// The closing orbit, composed for the 732x588 desktop stage.
const FINALE = { radius: 9, height: 6.5, speed: 0.12, fov: 45, minAspect: 732 / 588 };

/** Ballots and the tally: the beats the crane films. */
export function isVoteBeat(event?: GameEvent["kind"]): boolean {
  return event === "vote" || event === "vote_result";
}

/**
 * How much larger than usual the stage draws its floating nameplates. The crane films
 * from about twice the day orbit's distance, where names would shrink to about 6px.
 */
export function plateScale(event?: GameEvent["kind"]): number {
  return isVoteBeat(event) ? 1.5 : 1;
}

// A nameplate's on-screen scale is this over its distance from the camera, measured in
// heights of the view (drei Html's distanceFactor), resized only in steps of PLATE_STEP.
const PLATE_DISTANCE_FACTOR = 6;
const PLATE_STEP = 1.02;

/**
 * On-screen scale of a nameplate `distance` units from a camera with a vertical `fov` of
 * that many degrees: drei Html's distanceFactor size, snapped to 2% steps. Sized
 * continuously, a moving camera resizes every plate on every frame and the browser
 * redraws their emoji each time, which held the finale's orbit to about 15 fps on
 * integrated graphics.
 */
export function plateSizeAt(distance: number, fov: number): number {
  const exact = PLATE_DISTANCE_FACTOR / (2 * Math.tan((fov * Math.PI) / 360) * Math.max(distance, 0.01));
  return Math.pow(PLATE_STEP, Math.round(Math.log(exact) / Math.log(PLATE_STEP)));
}

/**
 * Vertical fov for a whole-table shot composed for stages at least `minAspect` wide. A
 * narrower stage keeps the composed horizontal field of view, so no seat falls off the
 * sides; the nameplates, which do not shrink with the stage, get smaller with the view.
 */
function fitWidth(fov: number, minAspect: number, aspect?: number): number {
  if (!aspect || !(aspect < minAspect)) return fov;
  return (Math.atan((Math.tan((fov * Math.PI) / 360) * minAspect) / aspect) * 360) / Math.PI;
}

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
  const { phase, finished, highlight, seatPositions, time, event, aspect } = input;
  const seat = (id?: number): Vec3 | null =>
    id !== undefined && seatPositions[id] ? seatPositions[id] : null;

  if (finished || phase === "over") {
    return {
      kind: "finale",
      position: orbit(time, FINALE.radius, FINALE.height, FINALE.speed),
      target: CENTER,
      fov: fitWidth(FINALE.fov, FINALE.minAspect, aspect),
    };
  }

  const killSeat = seat(highlight.killId) ?? seat(highlight.eliminatedId);
  if (killSeat) {
    return {
      kind: "kill",
      // Low, close, dramatic. Tilted up so the victim's nameplate stays below the phase banner.
      position: portrait(killSeat, 3.0, 0.6),
      target: [killSeat[0], 1.35, killSeat[2]],
      fov: 38,
      focusSeatId: highlight.killId ?? highlight.eliminatedId,
    };
  }

  // Ballots and the tally: crane up and drift slowly so the whole table is in view.
  // A vote's death is the next step and carries `eliminatedId`, so it still gets the
  // kill close-up above.
  if (isVoteBeat(event)) {
    return {
      kind: "vote",
      position: orbit(time, CRANE.radius, CRANE.height, CRANE.speed),
      target: orbit(time, -CRANE.lead, CRANE.aimHeight, CRANE.speed),
      fov: fitWidth(CRANE.fov, CRANE.minAspect, aspect),
    };
  }

  const speakSeat = seat(highlight.speakingId);
  if (speakSeat) {
    return {
      kind: "speaker",
      // Eye-level push-in. Aimed above the head so the floating nameplate (and its
      // thinking badge) sits mid-frame, clear of the phase banner along the top.
      position: portrait(speakSeat, 3.4, 1.7),
      target: [speakSeat[0], 1.4, speakSeat[2]],
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
