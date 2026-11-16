import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tournament } from "./types";

// In-memory store whose transcript save can be made to reject, the way a strict
// ARENA_DATA_DIR does when the volume fills up mid-tournament.
const mem = vi.hoisted(() => ({
  tournaments: new Map<string, string>(),
  failTranscripts: false,
  failTournamentSaves: false,
}));
vi.mock("../store", () => ({
  store: {
    saveTranscript: async () => {
      if (mem.failTranscripts) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    },
    updateLeaderboard: async () => ({}),
    getLeaderboard: async () => ({}),
    saveTournament: async (t: Tournament) => {
      if (mem.failTournamentSaves && t.status === "abandoned") throw new Error("disk full");
      mem.tournaments.set(t.id, JSON.stringify(t));
    },
    getTournament: async (id: string) => {
      const raw = mem.tournaments.get(id);
      return raw ? (JSON.parse(raw) as Tournament) : null;
    },
    listTournaments: async () => [],
  },
}));

import { createTournament, runningTournaments } from "./run";

const INPUT = { roster: ["mock", "hunter-bot"], gamesPerRound: 1, numPlayers: 5, seed: 3 };
const stored = (id: string) => JSON.parse(mem.tournaments.get(id)!) as Tournament;

beforeEach(() => {
  mem.tournaments.clear();
  mem.failTranscripts = false;
  mem.failTournamentSaves = false;
});

describe("a tournament whose run throws", () => {
  it("is marked abandoned instead of staying 'running' with nothing driving it", async () => {
    mem.failTranscripts = true;
    const { id } = await createTournament(INPUT);
    await vi.waitFor(() => expect(runningTournaments()).toBe(0), { timeout: 10_000, interval: 10 });
    expect(stored(id).status).toBe("abandoned");
  });

  it("still frees its slot when even the abandoned mark cannot be saved", async () => {
    mem.failTranscripts = true;
    mem.failTournamentSaves = true;
    const { id } = await createTournament(INPUT);
    await vi.waitFor(() => expect(runningTournaments()).toBe(0), { timeout: 10_000, interval: 10 });
    expect(stored(id).status).toBe("running");
  });

  it("a healthy run still finishes", async () => {
    const { id } = await createTournament(INPUT);
    await vi.waitFor(() => expect(runningTournaments()).toBe(0), { timeout: 20_000, interval: 10 });
    expect(stored(id).status).toBe("finished");
  });
});
