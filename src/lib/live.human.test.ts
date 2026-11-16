import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const projectControl = vi.hoisted(() => ({ fail: false }));
vi.mock("./human/project", async (orig) => {
  const real = await orig<typeof import("./human/project")>();
  return {
    projectEvent: (...args: Parameters<typeof real.projectEvent>) => {
      if (projectControl.fail) throw new Error("projector down");
      return real.projectEvent(...args);
    },
  };
});

import {
  __resetLiveForTests,
  createLive,
  finishLive,
  getLive,
  isSealed,
  pushLive,
  pushLiveDecision,
  subscribeSeat,
} from "./live";
import { newHumanSeat } from "./human/seat";
import type { SeatEvent } from "./human/types";
import { ALIGNMENT_OF, type GameConfig, type GameEvent, type Player, type Role } from "./engine/types";
import { simulate } from "./engine/werewolf";
import { buildPlayers } from "./engine/roles";
import { makeRng } from "./engine/rng";
import { buildBrainFactory } from "./agents/brains";

const AT = "2026-01-01T00:00:00.000Z";
const ROLES: Role[] = ["villager", "werewolf", "seer", "doctor", "hunter", "hunter", "villager"];
const PLAYERS: Player[] = ROLES.map((role, id) => ({
  id, name: `P${id}`, avatar: "x", model: id === 0 ? "human" : "mock", role, alignment: ALIGNMENT_OF[role], alive: true,
}));
const CONFIG: GameConfig = { numPlayers: 7, seatModels: PLAYERS.map((p) => p.model), seed: 1, dealSeed: 2 };

function register(id: string, seatId = 0) {
  const seat = newHumanSeat(seatId, PLAYERS[seatId].role, PLAYERS[seatId].alignment, "0".repeat(64));
  createLive(id, AT, CONFIG, PLAYERS, seat);
  return seat;
}
const feed = (id: string, events: GameEvent[], from = 0) => events.forEach((e, i) => pushLive(id, e, from + i));
const kinds = (events: SeatEvent[]) => events.map((e) => e.kind);

const NIGHT: GameEvent[] = [
  { kind: "game_start", day: 0 },
  { kind: "phase", phase: "night", day: 1, label: "Night 1" },
  { kind: "wolf_chat", day: 1, wolfId: 1, text: "strike" },
  { kind: "wolf_kill", day: 1, actorIds: [1], targetId: 0 },
  { kind: "seer_check", day: 1, seerId: 2, targetId: 1, result: "evil" },
  { kind: "doctor_save", day: 1, doctorId: 3, targetId: 6 },
  { kind: "saved", day: 1, targetId: 6, by: "doctor" },
];

beforeEach(() => {
  __resetLiveForTests();
  projectControl.fail = false;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("pushLive on a human game", () => {
  it("fills a dense seat buffer with no private kinds for a villager", () => {
    const seat = register("g");
    feed("g", [...NIGHT, { kind: "phase", phase: "day", day: 1, label: "Day 1" }]);
    expect(kinds(seat.events)).toEqual(["game_start", "phase", "phase"]);
    expect(seat.events.every((e) => e !== undefined)).toBe(true);
    expect(getLive("g")!.events.length).toBe(8);
  });

  it("gives a wolf seat the pack's events but nobody else's", () => {
    const seat = register("g", 1);
    feed("g", NIGHT);
    expect(kinds(seat.events)).toEqual(["game_start", "phase", "wolf_chat", "wolf_kill"]);
  });

  it("notifies seat listeners with dense sequence numbers", () => {
    register("g");
    const got: [string, number][] = [];
    const unsub = subscribeSeat("g", (ev, seq) => got.push([ev.kind, seq]));
    feed("g", NIGHT);
    unsub();
    pushLive("g", { kind: "phase", phase: "day", day: 1, label: "Day 1" }, NIGHT.length);
    expect(got).toEqual([["game_start", 0], ["phase", 1]]);
    expect(subscribeSeat("missing", () => {})).toBeTypeOf("function");
  });

  it("never puts decision records or reasoning into the seat buffer", () => {
    const seat = register("g");
    pushLiveDecision("g", {
      seq: 0, step: 3, produced: true, day: 1, phase: "night", playerId: 1,
      kind: "wolf_kill", source: "bot", ruling: "accepted", reasoning: "SECRET PLAN",
    });
    feed("g", NIGHT.map((e) => ({ ...e, reasoning: "SECRET PLAN" }) as unknown as GameEvent));
    expect(JSON.stringify(seat.events)).not.toContain("SECRET PLAN");
    expect(getLive("g")!.decisions.length).toBe(1);
  });

  it("starts ghost view at the first phase after the seat's death", () => {
    const seat = register("g");
    feed("g", [
      ...NIGHT,
      { kind: "death", day: 1, playerId: 0, cause: "wolves", role: "villager" },
    ]);
    expect(seat.dead).toBe(true);
    expect(seat.ghost).toBe(false);
    expect(kinds(seat.events)).toEqual(["game_start", "phase", "death"]);

    feed(
      "g",
      [
        { kind: "phase", phase: "day", day: 1, label: "Day 1" },
        { kind: "phase", phase: "night", day: 2, label: "Night 2" },
        { kind: "wolf_chat", day: 2, wolfId: 1, text: "again" },
        { kind: "seer_check", day: 2, seerId: 2, targetId: 3, result: "good" },
        { kind: "saved", day: 2, targetId: 6, by: "doctor" },
      ],
      NIGHT.length + 1
    );
    expect(kinds(seat.events).slice(3)).toEqual(["seat_reveal", "phase", "phase", "wolf_chat", "seer_check", "saved"]);
    const reveal = seat.events[3] as Extract<SeatEvent, { kind: "seat_reveal" }>;
    expect(reveal.final).toBe(false);
    expect(reveal.events).toBeUndefined();
    expect(reveal.players.map((p) => p.role)).toEqual(ROLES);
    expect(reveal.players[1]).not.toBe(PLAYERS[1]);
    expect(seat.events.filter((e) => e.kind === "seat_reveal").length).toBe(1);
  });

  it("delivers the final reveal, with the raw log, just before game_over", () => {
    const seat = register("g");
    const over: GameEvent = { kind: "game_over", winner: "evil", reason: "wolves win", survivorIds: [1] };
    feed("g", [...NIGHT, over]);
    expect(kinds(seat.events).slice(-2)).toEqual(["seat_reveal", "game_over"]);
    const reveal = seat.events.at(-2) as Extract<SeatEvent, { kind: "seat_reveal" }>;
    expect(reveal.final).toBe(true);
    expect(reveal.players.map((p) => p.role)).toEqual(ROLES);
    expect(reveal.events).toEqual(NIGHT);
    expect(reveal.events!.some((e) => e.kind === "game_over")).toBe(false);
  });
});

describe("isSealed", () => {
  it("is true while a human game runs and false once game_over is logged", () => {
    register("g");
    const game = getLive("g")!;
    expect(isSealed(game)).toBe(true);
    feed("g", NIGHT);
    expect(isSealed(game)).toBe(true);
    pushLive("g", { kind: "game_over", winner: "good", reason: "r", survivorIds: [] }, NIGHT.length);
    expect(isSealed(game)).toBe(false);
  });

  it("is false for a finished or abandoned human game and for bot games", () => {
    register("g");
    finishLive("g", "abandoned");
    expect(isSealed(getLive("g")!)).toBe(false);
    const bot = createLive("bot", AT, CONFIG, PLAYERS);
    expect(isSealed(bot)).toBe(false);
  });
});

describe("listener and projector safety", () => {
  it("removes a throwing seat listener and still serves the others", () => {
    const seat = register("g");
    const good: string[] = [];
    const bad = vi.fn(() => {
      throw new Error("listener down");
    });
    subscribeSeat("g", bad);
    subscribeSeat("g", (ev) => good.push(ev.kind));
    expect(() => feed("g", NIGHT.slice(0, 2))).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(seat.eventListeners.size).toBe(1);
    expect(good).toEqual(["game_start", "phase"]);
  });

  it("survives a projector that throws, and logs once per game", () => {
    const seat = register("g");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    projectControl.fail = true;
    expect(() => feed("g", NIGHT)).not.toThrow();
    expect(getLive("g")!.events).toEqual(NIGHT);
    expect(seat.events).toEqual([]);
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("lets a real game reach game_over with a throwing seat listener subscribed", async () => {
    const config: GameConfig = { numPlayers: 7, seatModels: Array(7).fill("mock"), seed: 9, dealSeed: 10 };
    const players = buildPlayers(config, makeRng(config.seed));
    const seat = newHumanSeat(0, players[0].role, players[0].alignment, "0".repeat(64));
    createLive("real", AT, config, players, seat);
    subscribeSeat("real", () => {
      throw new Error("listener down");
    });
    const t = await simulate(config, buildBrainFactory(3), {
      id: "real", createdAt: AT, onEvent: (e, i) => pushLive("real", e, i),
    });
    expect(t.events.at(-1)?.kind).toBe("game_over");
    expect(seat.events.at(-1)?.kind).toBe("game_over");
    expect(seat.events.at(-2)).toMatchObject({ kind: "seat_reveal", final: true });
    expect(seat.eventListeners.size).toBe(0);
  });
});

describe("two-hunter ghost rule", () => {
  const LIST = (seatId: number): GameEvent[] => [
    { kind: "game_start", day: 0 },
    { kind: "death", day: 1, playerId: seatId, cause: "hunter", role: PLAYERS[seatId].role },
    { kind: "phase", phase: "day", day: 1, label: "Day 1" },
    { kind: "hunter_shot", day: 1, hunterId: seatId, targetId: 1 },
    { kind: "phase", phase: "night", day: 2, label: "Night 2" },
  ];

  it("keeps a dead human Hunter blind until their own shot is logged", () => {
    const seat = register("g", 4);
    feed("g", LIST(4).slice(0, 3));
    expect(kinds(seat.events)).toEqual(["game_start", "death", "phase"]);
    expect(seat.ghost).toBe(false);
    feed("g", LIST(4).slice(3), 3);
    expect(kinds(seat.events)).toEqual(["game_start", "death", "phase", "hunter_shot", "seat_reveal", "phase"]);
    expect(seat.events[4]).toMatchObject({ final: false });
  });

  it("reveals at the first phase for a non-Hunter seat", () => {
    const seat = register("g", 0);
    feed("g", LIST(0));
    expect(kinds(seat.events)).toEqual(["game_start", "death", "seat_reveal", "phase", "hunter_shot", "phase"]);
  });
});

describe("__resetLiveForTests", () => {
  it("empties the registry", () => {
    register("g");
    createLive("bot", AT, CONFIG, PLAYERS);
    __resetLiveForTests();
    expect(getLive("g")).toBeNull();
    expect(getLive("bot")).toBeNull();
  });
});
