import { describe, expect, it, vi } from "vitest";

vi.mock("../store", () => ({ store: {} }));

import { buildPlayers, resolveRoleCounts, rolesFromCounts } from "./roles";
import { assignIdentities } from "./names";
import { makeRng, shuffle } from "./rng";
import { simulate } from "./werewolf";
import { GameConfig } from "./types";
import { buildBrainFactory } from "../agents/brains";
import { buildConfig } from "../games";

const cfg = (seed: number, dealSeed?: number): GameConfig => ({
  numPlayers: 9,
  seatModels: Array(9).fill("mock"),
  seed,
  ...(dealSeed === undefined ? {} : { dealSeed }),
});

describe("buildPlayers without dealSeed", () => {
  it("draws the role shuffle and then the identities from one shared stream", () => {
    for (const seed of [1, 42, 987654321]) {
      const config = cfg(seed);
      const rng = makeRng(seed);
      const roles = shuffle(rng, rolesFromCounts(resolveRoleCounts(config)));
      const ids = assignIdentities(rng, 9);
      const players = buildPlayers(config, makeRng(seed));
      expect(players.map((p) => p.role)).toEqual(roles);
      expect(players.map((p) => ({ name: p.name, avatar: p.avatar }))).toEqual(ids);
    }
  });
});

describe("buildPlayers with dealSeed", () => {
  it("is a pure function of (seed, dealSeed)", () => {
    expect(buildPlayers(cfg(7, 99), makeRng(7))).toEqual(buildPlayers(cfg(7, 99), makeRng(7)));
  });

  it("keeps names and avatars fixed by seed while the deal varies with dealSeed", () => {
    const base = buildPlayers(cfg(7, 0), makeRng(7));
    const identity = (ps: typeof base) => ps.map((p) => `${p.name}${p.avatar}`);
    const multiset = (ps: typeof base) => ps.map((p) => p.role).sort();
    const orders = new Set<string>();
    for (let dealSeed = 0; dealSeed < 20; dealSeed++) {
      const players = buildPlayers(cfg(7, dealSeed), makeRng(7));
      expect(identity(players)).toEqual(identity(base));
      expect(multiset(players)).toEqual(multiset(base));
      orders.add(players.map((p) => p.role).join(","));
    }
    expect(orders.size).toBeGreaterThanOrEqual(2);
  });

  it("gives the same role order for one dealSeed under different seeds", () => {
    const a = buildPlayers(cfg(1, 555), makeRng(1));
    const b = buildPlayers(cfg(2, 555), makeRng(2));
    expect(a.map((p) => p.role)).toEqual(b.map((p) => p.role));
    expect(a.map((p) => p.name)).not.toEqual(b.map((p) => p.name));
  });

  it("simulates deterministically and keeps dealSeed in the transcript", async () => {
    const config = cfg(11, 222);
    const run = () => simulate(config, buildBrainFactory(11), { id: "t", createdAt: "2026-01-01T00:00:00.000Z" });
    const [a, b] = [await run(), await run()];
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.config.dealSeed).toBe(222);
    expect(a.events.at(-1)?.kind).toBe("game_over");
  });
});

describe("buildConfig", () => {
  it("never sets dealSeed", () => {
    expect(buildConfig({})).not.toHaveProperty("dealSeed");
  });
});
