// File-based JSON store. Writes to ./data when the working directory is
// writable, otherwise falls back to the OS temp dir (so a read-only serverless
// filesystem degrades gracefully instead of crashing).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transcript } from "../engine/types";
import { Leaderboard } from "../elo";
import { Tournament } from "../tournaments/types";
import { GameSummary, Store, summarize, TournamentSummary, summarizeTournament } from "./index";

const INDEX_CAP = 200;

let dirPromise: Promise<string> | null = null;

async function resolveDir(): Promise<string> {
  const primary = path.join(process.cwd(), "data");
  try {
    await fs.mkdir(path.join(primary, "games"), { recursive: true });
    const probe = path.join(primary, ".probe");
    await fs.writeFile(probe, "ok");
    await fs.rm(probe, { force: true });
    return primary;
  } catch {
    const tmp = path.join(os.tmpdir(), "among-llms-data");
    await fs.mkdir(path.join(tmp, "games"), { recursive: true });
    return tmp;
  }
}

function dataDir(): Promise<string> {
  if (!dirPromise) dirPromise = resolveDir();
  return dirPromise;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

// In-process mutex. The index.json and leaderboard.json updates are
// read-modify-write sequences; without serialization two concurrent games can
// each read the same baseline and clobber the other's result. Chaining all
// mutations through one promise makes them atomic within the server process.
let mutation: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = mutation.then(fn, fn);
  mutation = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export const fileStore: Store = {
  async saveTranscript(t: Transcript): Promise<void> {
    await withLock(async () => {
      const dir = await dataDir();
      await writeJson(path.join(dir, "games", `${t.id}.json`), t);

      const indexPath = path.join(dir, "index.json");
      const index = await readJson<GameSummary[]>(indexPath, []);
      const next = [summarize(t), ...index.filter((s) => s.id !== t.id)].slice(0, INDEX_CAP);
      await writeJson(indexPath, next);
    });
  },

  async getTranscript(id: string): Promise<Transcript | null> {
    // Guard against path traversal in the id.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const dir = await dataDir();
    return readJson<Transcript | null>(path.join(dir, "games", `${id}.json`), null);
  },

  async listSummaries(limit = 50): Promise<GameSummary[]> {
    const dir = await dataDir();
    const index = await readJson<GameSummary[]>(path.join(dir, "index.json"), []);
    return index.slice(0, limit);
  },

  async getLeaderboard(): Promise<Leaderboard> {
    const dir = await dataDir();
    return readJson<Leaderboard>(path.join(dir, "leaderboard.json"), {});
  },

  async updateLeaderboard(
    updater: (board: Leaderboard) => Leaderboard
  ): Promise<Leaderboard> {
    return withLock(async () => {
      const dir = await dataDir();
      const file = path.join(dir, "leaderboard.json");
      const current = await readJson<Leaderboard>(file, {});
      const next = updater(current);
      await writeJson(file, next);
      return next;
    });
  },

  async saveTournament(t: Tournament): Promise<void> {
    await withLock(async () => {
      const dir = await dataDir();
      await fs.mkdir(path.join(dir, "tournaments"), { recursive: true });
      await writeJson(path.join(dir, "tournaments", `${t.id}.json`), t);
      const indexPath = path.join(dir, "tournaments-index.json");
      const index = await readJson<TournamentSummary[]>(indexPath, []);
      const next = [summarizeTournament(t), ...index.filter((s) => s.id !== t.id)].slice(0, INDEX_CAP);
      await writeJson(indexPath, next);
    });
  },

  async getTournament(id: string): Promise<Tournament | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const dir = await dataDir();
    return readJson<Tournament | null>(path.join(dir, "tournaments", `${id}.json`), null);
  },

  async listTournaments(limit = 50): Promise<TournamentSummary[]> {
    const dir = await dataDir();
    const index = await readJson<TournamentSummary[]>(
      path.join(dir, "tournaments-index.json"),
      []
    );
    return index.slice(0, limit);
  },
};
