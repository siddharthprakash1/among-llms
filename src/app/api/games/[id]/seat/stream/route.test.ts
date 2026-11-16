import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { GET as PROBE } from "../route";
import { __resetLiveForTests, createLive, finishLive, pushLive, pushLiveDecision } from "@/lib/live";
import { closeSeat, makePromptPort, newHumanSeat, newSeatToken, seatCookieName } from "@/lib/human/seat";
import { buildPromptSpec } from "@/lib/human/legal";
import { makeView } from "@/lib/human/testUtil";
import { ALIGNMENT_OF, type GameConfig, type GameEvent, type Player, type Role } from "@/lib/engine/types";

const ROLES: Role[] = ["villager", "werewolf", "seer", "doctor", "villager"];
const PLAYERS: Player[] = ROLES.map((role, id) => ({
  id, name: `P${id}`, avatar: "x", model: id === 0 ? "human" : "mock", role, alignment: ALIGNMENT_OF[role], alive: true,
}));
const CONFIG: GameConfig = { numPlayers: 5, seatModels: PLAYERS.map((p) => p.model), seed: 424242, dealSeed: 737373 };
const AT = "2026-01-01T00:00:00.000Z";

const LOG: GameEvent[] = [
  { kind: "game_start", day: 0 },
  { kind: "phase", phase: "night", day: 1, label: "Night 1" },
  { kind: "wolf_chat", day: 1, wolfId: 1, text: "SECRET PLAN" },
  { kind: "wolf_kill", day: 1, actorIds: [1], targetId: 4 },
  { kind: "seer_check", day: 1, seerId: 2, targetId: 1, result: "evil" },
  { kind: "phase", phase: "day", day: 1, label: "Day 1" },
  { kind: "statement", day: 1, playerId: 1, text: "hello" },
];

/** A running human game: villager at seat 0, a night behind it, a vote prompt pending. */
function register(id: string) {
  const { token, hash } = newSeatToken();
  const seat = newHumanSeat(0, "villager", "good", hash);
  createLive(id, AT, CONFIG, PLAYERS, seat);
  pushLiveDecision(id, {
    seq: 0, step: 3, produced: true, day: 1, phase: "night", playerId: 1,
    kind: "wolf_kill", source: "bot", ruling: "accepted", reasoning: "SECRET REASONING",
  });
  LOG.forEach((e, i) => pushLive(id, e, i));
  void makePromptPort(id).ask(buildPromptSpec("vote", makeView("villager")));
  return { seat, cookie: `${seatCookieName(id)}=${token}` };
}

interface Frame { event: string; id?: number; data: any }

async function open(id: string, headers: Record<string, string>) {
  const req = new Request(`http://test.invalid/api/games/${id}/seat/stream`, { headers });
  const res = await GET(req, { params: Promise.resolve({ id }) });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: Frame[] = [];
  let raw = "";
  const pump = async (): Promise<boolean> => {
    const { done, value } = await reader.read();
    if (done) return false;
    const text = dec.decode(value, { stream: true });
    raw += text;
    buf += text;
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      if (block.startsWith(":")) continue;
      const event = block.match(/^event: (.+)$/m)?.[1] ?? "message";
      const idLine = block.match(/^id: (\d+)$/m)?.[1];
      const data = JSON.parse(block.match(/^data: (.*)$/m)![1]);
      frames.push({ event, ...(idLine === undefined ? {} : { id: Number(idLine) }), data });
    }
    return true;
  };
  /** Reads until a frame of this event type has arrived (or the stream ends). */
  const until = async (event: string, count = 1) => {
    while (frames.filter((f) => f.event === event).length < count) if (!(await pump())) break;
    return frames;
  };
  return { res, reader, frames, until, pump, raw: () => raw };
}

beforeEach(() => __resetLiveForTests());
afterEach(() => {
  __resetLiveForTests();
  vi.useRealTimers();
});

describe("GET /api/games/[id]/seat/stream", () => {
  it("answers 401 / 404 as plain JSON, never as an event stream", async () => {
    const { cookie } = register("g");
    const req = (id: string, headers: Record<string, string> = {}) =>
      GET(new Request(`http://test.invalid/api/games/${id}/seat/stream`, { headers }), {
        params: Promise.resolve({ id }),
      });
    const none = await req("g");
    expect(none.status).toBe(401);
    expect(none.headers.get("content-type")).toContain("application/json");
    expect(none.headers.get("content-type")).not.toContain("text/event-stream");
    expect(await none.json()).toHaveProperty("error");
    expect((await req("g", { cookie: `${seatCookieName("g")}=forged` })).status).toBe(401);
    expect((await req("nope", { cookie })).status).toBe(404);
  });

  it("sends meta, the seat's backlog, then the pending prompt, and nothing private", async () => {
    const { seat, cookie } = register("g");
    const s = await open("g", { cookie });
    expect(s.res.headers.get("content-type")).toContain("text/event-stream");
    const frames = await s.until("seat");

    expect(frames[0].event).toBe("meta");
    expect(frames[0].data.you).toMatchObject({ seatId: 0, role: "villager" });
    expect(frames[0].data).not.toHaveProperty("config");
    expect(frames[0].data.players.every((p: object) => !("role" in p))).toBe(true);

    const events = frames.filter((f) => f.event === "message");
    expect(events.map((f) => f.id)).toEqual([0, 1, 2, 3]);
    expect(events.map((f) => f.data.kind)).toEqual(["game_start", "phase", "phase", "statement"]);
    expect(frames.at(-1)!.event).toBe("seat");
    expect(frames.at(-1)!.data.prompt).toMatchObject({ id: "1", kind: "vote", afterSeq: 4 });
    expect(frames.at(-1)!.data.remainingMs).toBeGreaterThan(0);
    expect(seat.pending?.deadlineAt).not.toBeNull(); // delivery armed the clock

    const raw = s.raw();
    for (const secret of ["seed", "424242", "737373", "SECRET", "wolf_chat", "seer_check", "event: decision", "reasoning", "tokenHash"]) {
      expect(raw).not.toContain(secret);
    }

    await s.reader.cancel();
    expect(seat.eventListeners.size).toBe(0);
    expect(seat.stateListeners.size).toBe(0);
  });

  it("resumes after Last-Event-ID and still delivers the prompt", async () => {
    const { seat, cookie } = register("g");
    const s = await open("g", { cookie, "last-event-id": "1" });
    const frames = await s.until("seat");
    expect(frames.filter((f) => f.event === "message").map((f) => f.id)).toEqual([2, 3]);
    expect(frames.at(-1)!.data.prompt?.id).toBe("1");
    await s.reader.cancel();
    expect(seat.eventListeners.size + seat.stateListeners.size).toBe(0);
  });

  it("treats a malformed, negative or too-large Last-Event-ID as a fresh connect or a clamp", async () => {
    const { seat, cookie } = register("g");
    for (const [header, ids] of [["abc", [0, 1, 2, 3]], ["-5", [0, 1, 2, 3]], ["1.5", [0, 1, 2, 3]], ["", [0, 1, 2, 3]], [" ", [0, 1, 2, 3]], ["1e0", [0, 1, 2, 3]], ["0x1", [0, 1, 2, 3]], ["999999", []]] as const) {
      const s = await open("g", { cookie, "last-event-id": header });
      const frames = await s.until("seat");
      expect(frames.filter((f) => f.event === "message").map((f) => f.id), header).toEqual(ids);
      expect(frames.at(-1)!.data.prompt?.id, header).toBe("1");
      await s.reader.cancel();
      expect(seat.eventListeners.size + seat.stateListeners.size).toBe(0);
    }
  });

  it("tails live events and prompt changes in order", async () => {
    const { seat, cookie } = register("g");
    const s = await open("g", { cookie });
    await s.until("seat");
    pushLive("g", { kind: "vote", day: 1, voterId: 1, targetId: 0 }, LOG.length);
    const frames = await s.until("message", 5);
    expect(frames.at(-1)).toMatchObject({ event: "message", id: 4, data: { kind: "vote" } });
    await s.reader.cancel();
    expect(seat.eventListeners.size + seat.stateListeners.size).toBe(0);
  });

  it("throws nothing when the ping interval fires after the body was cancelled", async () => {
    vi.useFakeTimers();
    const { seat, cookie } = register("g");
    const s = await open("g", { cookie });
    await s.until("seat");
    await s.reader.cancel();
    expect(seat.eventListeners.size).toBe(0);
    expect(seat.stateListeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
  });

  it("writes a final seat event and ends when an idle game is abandoned", async () => {
    const { seat, cookie } = register("g");
    const s = await open("g", { cookie });
    await s.until("seat");
    finishLive("g", "abandoned");
    closeSeat("g");
    const frames = await s.until("seat", 2);
    expect(frames.at(-1)!.event).toBe("seat");
    expect(frames.at(-1)!.data.prompt).toBeNull();
    expect((await s.reader.read()).done).toBe(true);
    expect(seat.eventListeners.size).toBe(0);
    expect(seat.stateListeners.size).toBe(0);
  });

  it("serves only meta for an already-abandoned game", async () => {
    const { cookie } = register("g");
    finishLive("g", "abandoned");
    closeSeat("g");
    const s = await open("g", { cookie });
    while (await s.pump());
    expect(s.frames.map((f) => f.event)).toEqual(["meta"]);
    expect(s.frames[0].data.status).toBe("abandoned");
  });

  it("replays the final reveal and closes for a finished game", async () => {
    const { seat, cookie } = register("g");
    pushLive("g", { kind: "game_over", winner: "evil", reason: "wolves win", survivorIds: [1] }, LOG.length);
    finishLive("g", "finished");
    closeSeat("g");
    const s = await open("g", { cookie });
    while (await s.pump());
    const kinds = s.frames.filter((f) => f.event === "message").map((f) => f.data.kind);
    expect(kinds.slice(-2)).toEqual(["seat_reveal", "game_over"]);
    const reveal = s.frames.find((f) => f.data.kind === "seat_reveal")!.data;
    expect(reveal.final).toBe(true);
    expect(reveal.events.length).toBe(LOG.length);
    expect(seat.eventListeners.size + seat.stateListeners.size).toBe(0);
  });
});

describe("GET /api/games/[id]/seat", () => {
  const probe = (id: string, cookie?: string) =>
    PROBE(new Request(`http://test.invalid/api/games/${id}/seat`, { headers: cookie ? { cookie } : {} }), {
      params: Promise.resolve({ id }),
    });

  it("returns the redacted meta for the seat's browser only", async () => {
    const { cookie } = register("g");
    const ok = await probe("g", cookie);
    expect(ok.status).toBe(200);
    const body = await ok.text();
    expect(JSON.parse(body).meta.you.role).toBe("villager");
    for (const secret of ["seed", "424242", "737373", "werewolf\",\"alignment", "tokenHash"]) expect(body).not.toContain(secret);
    expect((await probe("g")).status).toBe(401);
    expect((await probe("nope", cookie)).status).toBe(404);
  });
});
