import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileStore } from "../store/fileStore";
import type { Store } from "../store";
import { abandonOrphanedTournaments, runningTournaments } from "./run";
import { buildRoundRobin } from "./schedule";
import type { Tournament, TournamentConfig, TournamentStatus } from "./types";

const CONFIG: TournamentConfig = {
  name: "Bots",
  format: "round_robin",
  roster: ["mock", "hunter-bot"],
  gamesPerRound: 1,
  numPlayers: 5,
  concurrency: 1,
  seed: 11,
};

const tournament = (id: string, status: TournamentStatus): Tournament => ({
  id,
  createdAt: "2026-01-01T00:00:00.000Z",
  status,
  config: CONFIG,
  rounds: buildRoundRobin(CONFIG),
});

describe("abandonOrphanedTournaments", () => {
  let dir: string;
  let s: Store;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-"));
    s = createFileStore({ dir });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("marks a tournament left running by a dead process as abandoned", async () => {
    await s.saveTournament(tournament("orphan1", "running"));
    expect(await abandonOrphanedTournaments(s)).toEqual(["orphan1"]);
    expect((await s.getTournament("orphan1"))!.status).toBe("abandoned");
    expect((await s.listTournaments()).map((t) => [t.id, t.status])).toEqual([["orphan1", "abandoned"]]);
  });

  it("leaves a finished tournament untouched", async () => {
    const done = tournament("done1", "finished");
    await s.saveTournament(done);
    expect(await abandonOrphanedTournaments(s)).toEqual([]);
    expect(await s.getTournament("done1")).toEqual(done);
  });

  it("is idempotent", async () => {
    await s.saveTournament(tournament("orphan2", "running"));
    await s.saveTournament(tournament("orphan3", "running"));
    expect((await abandonOrphanedTournaments(s)).sort()).toEqual(["orphan2", "orphan3"]);
    expect(await abandonOrphanedTournaments(s)).toEqual([]);
  });

  it("trusts the stored file over a stale index entry", async () => {
    await s.saveTournament(tournament("stale1", "running"));
    // The file says finished while the index still says running.
    await fs.writeFile(
      path.join(dir, "tournaments", "stale1.json"),
      JSON.stringify(tournament("stale1", "finished"))
    );
    expect(await abandonOrphanedTournaments(s)).toEqual([]);
    expect((await s.getTournament("stale1"))!.status).toBe("finished");
  });

  it("reports no running tournaments when none was started", () => {
    expect(runningTournaments()).toBe(0);
  });
});

describe("createTournament", () => {
  type G = { __amongLlmsStore?: unknown; __amongLlmsTournaments?: unknown };
  const g = globalThis as unknown as G;
  let dir: string;
  let savedEnv: string | undefined;

  // createTournament uses the default store, so point it at a temp dir: nothing
  // here may write to the repo's ./data.
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-"));
    savedEnv = process.env.ARENA_DATA_DIR;
    process.env.ARENA_DATA_DIR = dir;
    delete g.__amongLlmsStore;
    delete g.__amongLlmsTournaments;
    vi.resetModules();
  });
  afterAll(async () => {
    if (savedEnv === undefined) delete process.env.ARENA_DATA_DIR;
    else process.env.ARENA_DATA_DIR = savedEnv;
    delete g.__amongLlmsStore;
    delete g.__amongLlmsTournaments;
    vi.resetModules();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reserves its slot synchronously and releases it when the run ends", async () => {
    const run = await import("./run");
    const input = { roster: ["mock", "hunter-bot"], gamesPerRound: 1, numPlayers: 5, seed: 3 };
    const a = run.createTournament(input);
    const b = run.createTournament({ ...input, seed: 4 });
    expect(run.runningTournaments()).toBe(2);

    const ids = [(await a).id, (await b).id];
    // A tournament this process is running is never treated as orphaned.
    expect(await run.abandonOrphanedTournaments()).toEqual([]);

    await vi.waitFor(() => expect(run.runningTournaments()).toBe(0), { timeout: 20_000, interval: 25 });
    const store = (await import("../store")).store;
    for (const id of ids) expect((await store.getTournament(id))!.status).toBe("finished");
    expect((await fs.readdir(path.join(dir, "tournaments"))).sort()).toEqual(ids.map((i) => `${i}.json`).sort());
  }, 30_000);
});
