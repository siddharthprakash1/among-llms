import { describe, expect, it } from "vitest";
import { simulate } from "../engine/werewolf";
import { buildBrainFactory } from "../agents/brains";
import { HumanBrain } from "../agents/humanBrain";
import type { BrainFactory, GameConfig } from "../engine/types";
import { HUMAN_MODEL_ID } from "./types";

describe("bot games are untouched by the human-seat wiring", () => {
  it("replays byte-identically, also through the wrapped factory", async () => {
    const seed = 20261116;
    const config: GameConfig = {
      numPlayers: 9,
      seatModels: ["mock", "hunter-bot", "sentinel-bot", "mock", "hunter-bot", "sentinel-bot", "mock", "mock", "mock"],
      seed,
    };
    const opts = { id: "d", createdAt: "2026-01-01T00:00:00.000Z" };
    const a = await simulate(config, buildBrainFactory(seed), opts);
    const b = await simulate(config, buildBrainFactory(seed), opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const base = buildBrainFactory(seed);
    const noSuchSeat = 99;
    const wrapped: BrainFactory = (m, s) =>
      s === noSuchSeat ? new HumanBrain({ ask: async () => null }, base(HUMAN_MODEL_ID, s)) : base(m, s);
    const c = await simulate(config, wrapped, opts);
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
    expect(a.config).not.toHaveProperty("dealSeed");
  });
});
