// ./fileStore is imported first on purpose: it pins the fix for the old
// fileStore <-> index import cycle (see the "import order" test).
import { createFileStore, pickDataDir } from "./fileStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Store } from "./index";
import { simulate } from "../engine/werewolf";
import { buildBrainFactory } from "../agents/brains";
import type { Transcript } from "../engine/types";

let dir: string;
const makeStore = (): Store => createFileStore({ dir });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "arena-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function game(id: string, seed = 7): Promise<Transcript> {
  const config = { numPlayers: 5, seatModels: Array(5).fill("mock"), seed };
  return simulate(config, buildBrainFactory(seed), { id, createdAt: "2026-01-01T00:00:00.000Z" });
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

describe("pickDataDir", () => {
  it("defaults to ./data and treats ARENA_DATA_DIR as explicit", () => {
    expect(pickDataDir({}, "/x")).toEqual({ dir: path.join("/x", "data"), explicit: false });
    expect(pickDataDir({ ARENA_DATA_DIR: "/vol" })).toEqual({ dir: path.resolve("/vol"), explicit: true });
    expect(pickDataDir({ ARENA_DATA_DIR: "   " }, "/x")).toEqual({
      dir: path.join("/x", "data"),
      explicit: false,
    });
  });
});

describe("file store", () => {
  it("round-trips a transcript and writes the game file and the index", async () => {
    const s = makeStore();
    const t = await game("rt1");
    await s.saveTranscript(t);
    expect(await s.getTranscript("rt1")).toEqual(JSON.parse(JSON.stringify(t)));
    const list = await s.listSummaries();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("rt1");
    expect(await exists(path.join(dir, "games", "rt1.json"))).toBe(true);
    expect(await exists(path.join(dir, "index.json"))).toBe(true);
  });

  it("writes the same bytes as a plain JSON.stringify(data, null, 2)", async () => {
    const s = makeStore();
    const t = await game("bytes");
    await s.saveTranscript(t);
    const raw = await fs.readFile(path.join(dir, "games", "bytes.json"), "utf8");
    expect(raw).toBe(JSON.stringify(t, null, 2));
  });

  it("leaves no .tmp file behind after 10 saves", async () => {
    const s = makeStore();
    const t = await game("base");
    for (let i = 0; i < 10; i++) await s.saveTranscript({ ...t, id: `g${i}` });
    const files = await walk(dir);
    expect(files.length).toBeGreaterThanOrEqual(11);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("serializes 20 concurrent leaderboard updates (no lost update)", async () => {
    const s = makeStore();
    type Counter = { n?: number };
    await Promise.all(
      Array.from({ length: 20 }, () =>
        s.updateLeaderboard((b) => {
          const c = b as unknown as Counter;
          return { ...b, n: (c.n ?? 0) + 1 } as never;
        })
      )
    );
    expect((await s.getLeaderboard()) as unknown as Counter).toEqual({ n: 20 });
  });

  it("is strict about an explicit dir: rejects, reports unhealthy, and never touches the tmp fallback", async () => {
    const fallback = path.join(os.tmpdir(), "among-llms-data");
    const before = await fs.stat(fallback).then((st) => st.mtimeMs, () => null);

    const file = path.join(dir, "plain-file");
    await fs.writeFile(file, "x");
    const s = createFileStore({ dir: path.join(file, "sub") });
    await expect(s.getLeaderboard()).rejects.toThrow();
    await expect(s.saveTranscript(await game("nope"))).rejects.toThrow();
    expect(await s.health()).toEqual({ writable: false, persistent: false });

    const after = await fs.stat(fallback).then((st) => st.mtimeMs, () => null);
    expect(after).toBe(before);
  });

  it("recovers once a failing dir becomes usable", async () => {
    const target = path.join(dir, "later");
    await fs.writeFile(target, "x"); // a file where the dir should be
    const s = createFileStore({ dir: target });
    await expect(s.getLeaderboard()).rejects.toThrow();
    await fs.rm(target);
    expect(await s.getLeaderboard()).toEqual({});
    expect(await s.health()).toEqual({ writable: true, persistent: true });
  });

  it("reports a good dir healthy and leaves no probe file", async () => {
    const s = createFileStore({ dir });
    expect(await s.health()).toEqual({ writable: true, persistent: true });
    const names = await fs.readdir(dir);
    expect(names.filter((n) => n.startsWith(".probe"))).toEqual([]);
  });

  it("loads legacy files that predate disabledRoles, asJester and history", async () => {
    await fs.mkdir(path.join(dir, "games"), { recursive: true });
    const old = {
      id: "old1",
      createdAt: "2025-01-01T00:00:00.000Z",
      config: { numPlayers: 5, seatModels: ["mock"], seed: 1 },
      players: [],
      events: [],
      outcomes: [],
      result: { winner: "village", days: 2 },
    };
    const board = { mock: { model: "mock", elo: 1012, games: 3, wins: 2 } };
    await fs.writeFile(path.join(dir, "games", "old1.json"), JSON.stringify(old));
    await fs.writeFile(path.join(dir, "leaderboard.json"), JSON.stringify(board));
    const s = makeStore();
    expect(await s.getTranscript("old1")).toEqual(old);
    expect(await s.getLeaderboard()).toEqual(board);
  });

  it("refuses a path-traversal id", async () => {
    const s = makeStore();
    expect(await s.getTranscript("../x")).toBeNull();
    expect(await s.getTournament("../x")).toBeNull();
  });

  it("caps the index at 200 summaries, newest first", async () => {
    const s = makeStore();
    const t = await game("base");
    for (let i = 0; i < 205; i++) await s.saveTranscript({ ...t, id: `g${i}` });
    const list = await s.listSummaries(500);
    expect(list).toHaveLength(200);
    expect(list[0].id).toBe("g204");
  });

  it("import order: loading ./fileStore before ./index leaves the default store defined", async () => {
    const mod = await import("./index");
    expect(mod.store).toBeDefined();
    expect(typeof mod.store.saveTranscript).toBe("function");
    expect(typeof mod.summarize).toBe("function");
  });

  it("removes stale .tmp files on the first call and keeps real files", async () => {
    await fs.mkdir(path.join(dir, "games"), { recursive: true });
    await fs.mkdir(path.join(dir, "tournaments"), { recursive: true });
    await fs.writeFile(path.join(dir, "games", "x.json.1.0.tmp"), "{");
    await fs.writeFile(path.join(dir, "tournaments", "t.json.1.0.tmp"), "{");
    await fs.writeFile(path.join(dir, "leaderboard.json.1.0.tmp"), "{");
    await fs.writeFile(path.join(dir, "games", "keep.json"), "{}");
    const s = makeStore();
    await s.getLeaderboard();
    expect(await exists(path.join(dir, "games", "x.json.1.0.tmp"))).toBe(false);
    expect(await exists(path.join(dir, "tournaments", "t.json.1.0.tmp"))).toBe(false);
    expect(await exists(path.join(dir, "leaderboard.json.1.0.tmp"))).toBe(false);
    expect(await exists(path.join(dir, "games", "keep.json"))).toBe(true);
  });

  it("removes its temp file when the write itself fails (disk full)", async () => {
    const s = makeStore();
    await s.getLeaderboard(); // resolve the dir before the failure is armed
    const realWrite = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, opts) => {
      if (typeof file === "string" && file.endsWith(".tmp")) {
        await realWrite(file, String(data).slice(0, 10), opts);
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
      return realWrite(file, data, opts);
    });
    try {
      await expect(s.updateLeaderboard(() => ({}))).rejects.toMatchObject({ code: "ENOSPC" });
    } finally {
      spy.mockRestore();
    }
    expect((await walk(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(await exists(path.join(dir, "leaderboard.json"))).toBe(false);
    // The store is usable again once the disk has room.
    await s.updateLeaderboard(() => ({}));
    expect(await s.getLeaderboard()).toEqual({});
  });

  it("keeps the tournaments index newest-created first when an old one is saved again", async () => {
    const s = makeStore();
    const base = {
      status: "running" as const,
      config: {
        name: "T", format: "round_robin" as const, roster: ["mock", "hunter-bot"],
        gamesPerRound: 1, numPlayers: 5, concurrency: 1, seed: 1,
      },
      rounds: [],
    };
    const at = (day: number) => `2026-01-0${day}T00:00:00.000Z`;
    for (const [id, day] of [["old", 1], ["mid", 2], ["new", 3]] as const) {
      await s.saveTournament({ ...base, id, createdAt: at(day) });
    }
    await s.saveTournament({ ...base, id: "old", createdAt: at(1), status: "abandoned" });
    await s.saveTournament({ ...base, id: "mid", createdAt: at(2), status: "abandoned" });
    expect((await s.listTournaments()).map((t) => [t.id, t.status])).toEqual([
      ["new", "running"],
      ["mid", "abandoned"],
      ["old", "abandoned"],
    ]);
  });
});
