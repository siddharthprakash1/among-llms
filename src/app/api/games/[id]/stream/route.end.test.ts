import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getTranscript = vi.fn(async (_id: string): Promise<unknown> => null);
vi.mock("@/lib/store", () => ({ store: { getTranscript: (id: string) => getTranscript(id) } }));

import { GET } from "./route";
import { __resetLiveForTests, createLive, finishLive, getLive, pushLive } from "@/lib/live";
import type { GameConfig } from "@/lib/engine/types";

const CONFIG: GameConfig = { numPlayers: 5, seatModels: Array(5).fill("mock"), seed: 1 };
const AT = "2026-01-01T00:00:00.000Z";
const END = (reason: string) => `event: end\ndata: ${JSON.stringify({ reason })}\n\n`;

const get = (id: string, init: RequestInit = {}) =>
  GET(new Request(`http://test.invalid/api/games/${id}/stream`, init), { params: Promise.resolve({ id }) });

beforeEach(() => {
  __resetLiveForTests();
  getTranscript.mockReset();
  getTranscript.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe("stream terminal `end` event", () => {
  it("answers an unknown id with exactly one not_found end frame, then closes", async () => {
    expect(await (await get("doesnotexist")).text()).toBe(END("not_found"));
  });

  it("closes without `end` when the store throws, so the viewer retries", async () => {
    getTranscript.mockRejectedValue(new Error("volume gone"));
    expect(await (await get("x1")).text()).toBe("");
  });

  it("ends an abandoned live game with `abandoned` after its buffered events", async () => {
    createLive("dead", AT, CONFIG, []);
    pushLive("dead", { kind: "vote", day: 1, voterId: 0, targetId: null }, 0);
    finishLive("dead", "abandoned");
    const body = await (await get("dead")).text();
    expect(body.endsWith(END("abandoned"))).toBe(true);
    expect(body).toContain("id: 0\n");
    expect(body.match(/event: end/g)).toHaveLength(1);
  });

  it("does not send `end` for a game that finished normally", async () => {
    createLive("done", AT, CONFIG, []);
    pushLive("done", { kind: "game_over", day: 1, winner: "village" } as never, 0);
    finishLive("done", "finished");
    const body = await (await get("done")).text();
    expect(body).toContain("id: 0\n");
    expect(body).not.toContain("event: end");
  });

  it("the heartbeat pings a quiet running game and ends it once it is abandoned", async () => {
    vi.useFakeTimers();
    createLive("quiet", AT, CONFIG, []);
    const res = await get("quiet");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const next = async () => dec.decode((await reader.read()).value);

    expect(await next()).toContain("event: meta");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await next()).toBe(": ping\n\n");
    expect(getLive("quiet")!.listeners.size).toBe(1);

    finishLive("quiet", "abandoned");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await next()).toBe(": ping\n\n");
    expect(await next()).toBe(END("abandoned"));
    await vi.advanceTimersByTimeAsync(60);
    expect((await reader.read()).done).toBe(true);
    expect(getLive("quiet")!.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a consumer that cancels is unsubscribed and its heartbeat cleared", async () => {
    vi.useFakeTimers();
    createLive("gone", AT, CONFIG, []);
    const res = await get("gone");
    expect(getLive("gone")!.listeners.size).toBe(1);
    await res.body!.cancel();
    expect(getLive("gone")!.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // An event after the consumer left must not throw into the engine.
    expect(() => pushLive("gone", { kind: "vote", day: 1, voterId: 0, targetId: null }, 0)).not.toThrow();
  });

  it("an aborted request is torn down the same way", async () => {
    vi.useFakeTimers();
    createLive("abort", AT, CONFIG, []);
    const ac = new AbortController();
    await get("abort", { signal: ac.signal });
    expect(getLive("abort")!.listeners.size).toBe(1);
    ac.abort();
    expect(getLive("abort")!.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
