// Wires model ids to concrete brains. The factory derives a deterministic
// per-seat seed so mock games are fully reproducible from the game seed.

import { BrainFactory } from "../engine/types";
import { MockBrain } from "./mockBrain";
import { LlmBrain } from "./llmBrain";
import { getMockStyle, getProviderConfig } from "./registry";

export function buildBrainFactory(seed: number): BrainFactory {
  return (modelId, seatId) => {
    const mockSeed = (Math.imul(seed >>> 0, 2654435761) + Math.imul(seatId + 1, 40503)) >>> 0;
    const cfg = getProviderConfig(modelId);
    if (!cfg) {
      // Built-in bot (or any id without a provider) → heuristic brain.
      return new MockBrain(modelId, mockSeed, getMockStyle(modelId));
    }
    return new LlmBrain(modelId, cfg, mockSeed);
  };
}
