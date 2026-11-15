import { describe, expect, it } from "vitest";
import { GET } from "./route";
import { createLive, finishLive, pushLive, pushLiveDecision } from "@/lib/live";
import { DecisionRecord, GameConfig } from "@/lib/engine/types";

const CONFIG: GameConfig = { numPlayers: 5, seatModels: Array(5).fill("mock"), seed: 1 };

function rec(seq: number, step: number): DecisionRecord {
  return {
    seq, step, produced: false, day: 1, phase: "day", playerId: seq,
    kind: "accusation", source: "bot", ruling: "accepted",
  };
}

/** A game that died after one event, with decisions the next event never came to flush. */
function abandoned(id: string) {
  createLive(id, "2026-01-01T00:00:00.000Z", CONFIG, []);
  pushLiveDecision(id, rec(0, 0));
  pushLive(id, { kind: "vote", day: 1, voterId: 0, targetId: null }, 0);
  pushLiveDecision(id, rec(1, 1));
  pushLiveDecision(id, rec(2, 1));
  finishLive(id, "abandoned");
}

async function frames(id: string, headers: Record<string, string> = {}): Promise<string[]> {
  const req = new Request(`http://test.invalid/api/games/${id}/stream`, { headers });
  const res = await GET(req, { params: Promise.resolve({ id }) });
  const body = await res.text();
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((f) => {
      if (f.startsWith("event: meta")) return "meta";
      if (f.startsWith("event: decision")) return `decision ${JSON.parse(f.split("data: ")[1]).seq}`;
      return `event ${f.match(/^id: (\d+)/)![1]}`;
    });
}

const ALL = ["meta", "decision 0", "event 0", "decision 1", "decision 2"];

describe("GET /api/games/[id]/stream", () => {
  it("flushes decisions left behind by an abandoned game before closing", async () => {
    abandoned("route-test-a");
    expect(await frames("route-test-a")).toEqual(ALL);
  });

  it("closes, with only the undelivered decisions, for a client that already has every event", async () => {
    abandoned("route-test-c");
    expect(await frames("route-test-c", { "last-event-id": "0" })).toEqual([
      "meta", "decision 1", "decision 2",
    ]);
  });

  it("treats a malformed Last-Event-ID as absent instead of hanging", async () => {
    abandoned("route-test-b");
    expect(await frames("route-test-b", { "last-event-id": "abc" })).toEqual(ALL);
  });
});
