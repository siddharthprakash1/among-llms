// Real LLM brain. Talks to an OpenAI-compatible endpoint or the Anthropic
// Messages API via plain fetch (no SDK dependency). Every decision is wrapped:
// on any network/parse error it transparently falls back to the deterministic
// mock heuristic, so a flaky or slow model can never crash a game.

import {
  AccuseDecision,
  AccusationRecord,
  Brain,
  NightDecision,
  PlayerView,
  VoteDecision,
  WitchDecision,
} from "../engine/types";
import { MockBrain } from "./mockBrain";
import { ProviderConfig } from "./registry";
import {
  SYSTEM_PROMPT,
  accusePrompt,
  defendPrompt,
  hunterPrompt,
  nightPrompt,
  parseStatementResponse,
  parseTargetResponse,
  parseTextResponse,
  parseWitchResponse,
  statementPrompt,
  votePrompt,
  witchPrompt,
  wolfChatPrompt,
} from "./prompts";

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_TOKENS = 320;

export class LlmBrain implements Brain {
  readonly id: string;
  private cfg: ProviderConfig;
  private fallback: MockBrain;

  constructor(id: string, cfg: ProviderConfig, fallbackSeed: number) {
    this.id = id;
    this.cfg = cfg;
    this.fallback = new MockBrain(id, fallbackSeed);
  }

  private async chat(system: string, user: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      if (this.cfg.kind === "anthropic") {
        const res = await fetch(`${this.cfg.baseUrl}/v1/messages`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": this.cfg.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: this.cfg.model,
            max_tokens: MAX_TOKENS,
            temperature: 0.85,
            system,
            messages: [{ role: "user", content: user }],
          }),
        });
        if (!res.ok) throw new Error(`Anthropic ${res.status}`);
        const data = (await res.json()) as { content?: { text?: string }[] };
        return data.content?.map((c) => c.text ?? "").join("") ?? "";
      }

      // OpenAI-compatible
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          max_tokens: MAX_TOKENS,
          temperature: 0.85,
          // Every prompt asks for a JSON object; JSON mode makes real models
          // (Ollama, OpenAI, OpenRouter, vLLM, …) return parseable output. A
          // provider that rejects the field just triggers the mock fallback.
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`OpenAI-compatible ${res.status}`);
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  }

  async nightAction(view: PlayerView): Promise<NightDecision> {
    if (view.self.role === "villager") return { targetId: null };
    try {
      const text = await this.chat(SYSTEM_PROMPT, nightPrompt(view));
      const target = parseTargetResponse(text, view);
      if (target === null) return this.fallback.nightAction(view);
      return { targetId: target };
    } catch {
      return this.fallback.nightAction(view);
    }
  }

  async dayStatement(view: PlayerView): Promise<string> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, statementPrompt(view));
      const statement = parseStatementResponse(text);
      if (!statement) return this.fallback.dayStatement(view);
      return statement;
    } catch {
      return this.fallback.dayStatement(view);
    }
  }

  async dayVote(view: PlayerView): Promise<VoteDecision> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, votePrompt(view));
      const target = parseTargetResponse(text, view);
      if (target === null) return this.fallback.dayVote(view);
      return { targetId: target };
    } catch {
      return this.fallback.dayVote(view);
    }
  }

  async wolfChat(view: PlayerView, round: number): Promise<string> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, wolfChatPrompt(view, round));
      return parseTextResponse(text, ["message", "statement"]) ?? this.fallback.wolfChat(view, round);
    } catch {
      return this.fallback.wolfChat(view, round);
    }
  }

  async accuse(view: PlayerView): Promise<AccuseDecision> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, accusePrompt(view));
      return { targetId: parseTargetResponse(text, view), text: parseTextResponse(text, ["reason"]) ?? undefined };
    } catch {
      return this.fallback.accuse(view);
    }
  }

  async defend(view: PlayerView, against: AccusationRecord[]): Promise<string> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, defendPrompt(view, against));
      return parseTextResponse(text, ["statement"]) ?? this.fallback.defend(view, against);
    } catch {
      return this.fallback.defend(view, against);
    }
  }

  async witchAction(view: PlayerView, wolfTargetId: number | null): Promise<WitchDecision> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, witchPrompt(view, wolfTargetId));
      return parseWitchResponse(text, view) ?? this.fallback.witchAction(view, wolfTargetId);
    } catch {
      return this.fallback.witchAction(view, wolfTargetId);
    }
  }

  async hunterShot(view: PlayerView): Promise<{ targetId: number | null }> {
    try {
      const text = await this.chat(SYSTEM_PROMPT, hunterPrompt(view));
      const target = parseTargetResponse(text, view);
      if (target === null) return this.fallback.hunterShot(view);
      return { targetId: target };
    } catch {
      return this.fallback.hunterShot(view);
    }
  }
}
