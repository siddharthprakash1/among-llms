// Model registry. Reads the environment to decide which real models are
// available and how to reach them. The built-in "mock" brain is always present
// so the app works with zero configuration.

export type ProviderKind = "openai" | "anthropic";

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string; // the actual model name sent to the API
}

export interface ModelInfo {
  id: string; // brain id used in GameConfig.seatModels
  label: string;
  provider: string; // "Bot" | "OpenAI" | "Anthropic" | "Ollama"
  available: boolean;
}

import { MockStyle, DEFAULT_STYLE } from "./mockBrain";

/**
 * Built-in offline bots. They use the heuristic MockBrain with different
 * play-styles, so the arena and leaderboard are a real multi-competitor race
 * even with zero API keys configured.
 */
export const BUILTIN_BOTS: { id: string; label: string; style: MockStyle }[] = [
  { id: "mock", label: "Balanced bot", style: DEFAULT_STYLE },
  { id: "hunter-bot", label: "Hunter bot", style: { aggression: 0.9, selfPreserve: 0.3 } },
  { id: "sentinel-bot", label: "Sentinel bot", style: { aggression: 0.3, selfPreserve: 0.8 } },
];

export function getMockStyle(id: string): MockStyle {
  return BUILTIN_BOTS.find((b) => b.id === id)?.style ?? DEFAULT_STYLE;
}

interface Registry {
  models: ModelInfo[];
  configs: Map<string, ProviderConfig>;
}

let cache: Registry | null = null;

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildRegistry(): Registry {
  const models: ModelInfo[] = BUILTIN_BOTS.map((b) => ({
    id: b.id,
    label: b.label,
    provider: "Bot",
    available: true,
  }));
  const configs = new Map<string, ProviderConfig>();
  const seen = new Set<string>(BUILTIN_BOTS.map((b) => b.id));

  const add = (info: ModelInfo, cfg: ProviderConfig) => {
    if (seen.has(info.id)) return;
    seen.add(info.id);
    models.push(info);
    configs.set(info.id, cfg);
  };

  // OpenAI-compatible (OpenAI, OpenRouter, Together, LM Studio, …)
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    const list = splitList(process.env.OPENAI_MODELS);
    const provider = baseUrl.includes("openrouter")
      ? "OpenRouter"
      : baseUrl.includes("openai.com")
      ? "OpenAI"
      : "OpenAI-compatible";
    for (const model of list.length ? list : ["gpt-4o-mini"]) {
      add(
        { id: model, label: model, provider, available: true },
        { kind: "openai", baseUrl, apiKey: openaiKey, model }
      );
    }
  }

  // Anthropic
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const list = splitList(process.env.ANTHROPIC_MODELS);
    for (const model of list.length ? list : ["claude-haiku-4-5-20251001"]) {
      add(
        { id: model, label: model, provider: "Anthropic", available: true },
        { kind: "anthropic", baseUrl, apiKey: anthropicKey, model }
      );
    }
  }

  // Ollama (local, free) — enabled if either var is present.
  if (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODELS) {
    const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
    const list = splitList(process.env.OLLAMA_MODELS);
    for (const model of list.length ? list : ["llama3.1"]) {
      add(
        { id: model, label: model, provider: "Ollama", available: true },
        { kind: "openai", baseUrl, apiKey: process.env.OLLAMA_API_KEY || "ollama", model }
      );
    }
  }

  return { models, configs };
}

function registry(): Registry {
  if (!cache) cache = buildRegistry();
  return cache;
}

/** For tests / hot config changes. */
export function resetRegistry(): void {
  cache = null;
}

export function listModels(): ModelInfo[] {
  return registry().models;
}

export function getProviderConfig(id: string): ProviderConfig | null {
  return registry().configs.get(id) ?? null;
}
