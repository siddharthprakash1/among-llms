// File-based JSON store. With ARENA_DATA_DIR set, that directory is used and
// an unwritable one is an error (a hosted arena must never lose data quietly).
// Unset, it writes to ./data when the working directory is writable and
// otherwise falls back to the OS temp dir, so a local run on a read-only
// filesystem degrades instead of crashing.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Transcript } from "../engine/types";
import { Leaderboard } from "../elo";
import { Tournament } from "../tournaments/types";
import { summarize, summarizeTournament } from "./summary";
import type { GameSummary, Store, TournamentSummary } from "./index";

const INDEX_CAP = 200;
const RENAME_RETRIES = 5;
const RENAME_WAIT_MS = 20;

export interface FileStoreOptions {
  /** Explicit directory: strict (no tmp fallback) and private lock state. For tests. */
  dir?: string;
}
export interface StoreHealth {
  writable: boolean;
  persistent: boolean;
}
export type FileStore = Store & { health(): Promise<StoreHealth> };

interface State {
  dirPromise: Promise<string> | null;
  mutation: Promise<unknown>;
  persistent: boolean;
  seq: number;
}

const newState = (): State => ({
  dirPromise: null,
  mutation: Promise.resolve(),
  persistent: false,
  seq: 0,
});

/** Pure. `explicit` means the operator chose the dir, so failure must be loud. */
export function pickDataDir(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd()
): { dir: string; explicit: boolean } {
  const v = env.ARENA_DATA_DIR?.trim();
  if (v) return { dir: path.resolve(v), explicit: true };
  return { dir: path.join(cwd, "data"), explicit: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(dir: string, name: string): Promise<void> {
  const file = path.join(dir, name);
  await fs.writeFile(file, "ok");
  await fs.rm(file, { force: true });
}

/** Leftovers from a process killed between write and rename. */
async function removeStaleTmp(dir: string): Promise<void> {
  for (const sub of [dir, path.join(dir, "games"), path.join(dir, "tournaments")]) {
    let names: string[];
    try {
      names = await fs.readdir(sub);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".tmp")) await fs.rm(path.join(sub, name), { force: true }).catch(() => {});
    }
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function createFileStore(opts: FileStoreOptions = {}): FileStore {
  // Next gives each route bundle its own module instance; the lock and the
  // resolved dir must be one per process or writes stop being serialized.
  const g = globalThis as unknown as { __amongLlmsStore?: State };
  const state: State = opts.dir ? newState() : (g.__amongLlmsStore ??= newState());

  async function resolveStrict(dir: string): Promise<string> {
    await fs.mkdir(path.join(dir, "games"), { recursive: true });
    await probe(dir, ".probe");
    state.persistent = true;
    // Safe only because this runs before the instance's first write and a
    // hosted arena is one process per volume.
    await removeStaleTmp(dir).catch(() => {});
    return dir;
  }

  async function resolveDir(): Promise<string> {
    if (opts.dir) return resolveStrict(path.resolve(opts.dir));
    const picked = pickDataDir();
    if (picked.explicit) return resolveStrict(picked.dir);
    try {
      await fs.mkdir(path.join(picked.dir, "games"), { recursive: true });
      await probe(picked.dir, ".probe");
      state.persistent = true;
      return picked.dir;
    } catch {
      const tmp = path.join(os.tmpdir(), "among-llms-data");
      await fs.mkdir(path.join(tmp, "games"), { recursive: true });
      state.persistent = false;
      return tmp;
    }
  }

  function dataDir(): Promise<string> {
    if (!state.dirPromise) {
      const p = resolveDir();
      state.dirPromise = p;
      // Forget a failure so a mount that is fixed later recovers without a restart.
      p.catch(() => {
        if (state.dirPromise === p) state.dirPromise = null;
      });
    }
    return state.dirPromise;
  }

  // Write-then-rename: a kill at any instant leaves either the old file or the
  // new one, never a truncated one that readJson would treat as empty.
  async function writeJson(file: string, data: unknown): Promise<void> {
    const text = JSON.stringify(data, null, 2);
    const tmp = `${file}.${process.pid}.${state.seq++}.tmp`;
    try {
      await fs.writeFile(tmp, text, "utf8");
    } catch (err) {
      // A partial temp file on a full disk would only make it fuller.
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Windows refuses to replace a file another handle has open.
        const busy = code === "EPERM" || code === "EBUSY" || code === "EACCES";
        if (!busy) {
          await fs.rm(tmp, { force: true }).catch(() => {});
          throw err;
        }
        if (attempt < RENAME_RETRIES) {
          await sleep(RENAME_WAIT_MS);
          continue;
        }
        try {
          await fs.writeFile(file, text, "utf8");
        } finally {
          await fs.rm(tmp, { force: true }).catch(() => {});
        }
        return;
      }
    }
  }

  // In-process mutex. The index.json and leaderboard.json updates are
  // read-modify-write sequences; without serialization two concurrent games can
  // each read the same baseline and clobber the other's result. Chaining all
  // mutations through one promise makes them atomic within the server process.
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = state.mutation.then(fn, fn);
    state.mutation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  return {
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
        // Newest first by creation, not by last save: re-saving an old
        // tournament (the boot reconcile) must not move it above newer ones.
        const next = [summarizeTournament(t), ...index.filter((s) => s.id !== t.id)]
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
          .slice(0, INDEX_CAP);
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

    async health(): Promise<StoreHealth> {
      try {
        const dir = await dataDir();
        await probe(dir, `.probe-${process.pid}`);
        return { writable: true, persistent: state.persistent };
      } catch {
        return { writable: false, persistent: false };
      }
    },
  };
}

export const fileStore: FileStore = createFileStore();
