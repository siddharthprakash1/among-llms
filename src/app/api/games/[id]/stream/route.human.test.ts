import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";
import { __resetLiveForTests, createLive, finishLive, pushLive, pushLiveDecision } from "@/lib/live";
import { newHumanSeat } from "@/lib/human/seat";
import { ALIGNMENT_OF, type GameConfig, type GameEvent, type Player, type Role } from "@/lib/engine/types";

const ROLES: Role[] = ["villager", "werewolf", "seer", "doctor", "villager"];
const players = (human: boolean): Player[] =>
  ROLES.map((role, id) => ({
    id, name: `P${id}`, avatar: "x", model: human && id === 0 ? "human" : "mock", role, alignment: ALIGNMENT_OF[role], alive: true,
  }));
const CONFIG: GameConfig = { numPlayers: 5, seatModels: Array(5).fill("mock"), seed: 424242 };
const AT = "2026-01-01T00:00:00.000Z";
const LOG: GameEvent[] = [
  { kind: "game_start", day: 0 },
  { kind: "wolf_chat", day: 1, wolfId: 1, text: "SECRET PLAN" },
];

function humanGame(id: string) {
  createLive(id, AT, { ...CONFIG, dealSeed: 737373 }, players(true), newHumanSeat(0, "villager", "good", "0".repeat(64)));
  pushLiveDecision(id, {
    seq: 0, step: 1, produced: true, day: 1, phase: "night", playerId: 1,
    kind: "wolf_chat", source: "bot", ruling: "accepted", reasoning: "SECRET REASONING",
  });
  LOG.forEach((e, i) => pushLive(id, e, i));
}

const get = (id: string) =>
  GET(new Request(`http://test.invalid/api/games/${id}/stream`), { params: Promise.resolve({ id }) });

beforeEach(() => __resetLiveForTests());

describe("spectator stream and human games", () => {
  it("emits only a sealed meta while a human game is running", async () => {
    humanGame("h");
    const body = await (await get("h")).text();
    expect(body).toBe(`event: meta\ndata: ${JSON.stringify({ id: "h", status: "running", sealed: true })}\n\n`);
    for (const secret of ["seed", "players", "role", "SECRET", "decision", "wolf_chat"]) {
      expect(body).not.toContain(secret);
    }
  });

  it("stays sealed whatever Last-Event-ID the client sends", async () => {
    humanGame("h");
    const res = await GET(
      new Request("http://test.invalid/api/games/h/stream", { headers: { "last-event-id": "0" } }),
      { params: Promise.resolve({ id: "h" }) }
    );
    expect(await res.text()).not.toContain("SECRET");
  });

  it("opens up once game_over is in the log", async () => {
    humanGame("h");
    pushLive("h", { kind: "game_over", winner: "evil", reason: "wolves win", survivorIds: [1] }, LOG.length);
    finishLive("h", "finished");
    const body = await (await get("h")).text();
    expect(body).toContain('"dealSeed":737373');
    expect(body).toContain("event: decision");
    expect(body).toContain("SECRET PLAN");
    expect(body).not.toContain("sealed");
  });

  it("still gives a bot live game its full meta", async () => {
    createLive("b", AT, CONFIG, players(false));
    LOG.forEach((e, i) => pushLive("b", e, i));
    const res = await get("b");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(first.startsWith("event: meta\n")).toBe(true);
    const meta = JSON.parse(first.split("data: ")[1].split("\n")[0]);
    expect(meta.config).toEqual(CONFIG);
    expect(meta.players).toEqual(players(false));
    expect(meta.status).toBe("running");
    expect(meta).not.toHaveProperty("sealed");
    finishLive("b", "abandoned");
  });
});
