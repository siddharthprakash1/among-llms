// Real LLM brain. Talks to an OpenAI-compatible endpoint or the Anthropic
// Messages API via plain fetch (no SDK dependency). Every decision is wrapped:
// on any network/parse error it transparently falls back to the deterministic
// mock heuristic, so a flaky or slow model can never crash a game.

import {
  AccuseDecision,
  AccusationRecord,
  Brain,
  DecisionTrace,
  FallbackReason,
  NightDecision,
  PlayerView,
  VoteDecision,
  WitchDecision,
} from "../engine/types";
import { MockBrain, SEER_CLAIM_TAG } from "./mockBrain";
import { ProviderConfig } from "./registry";
import {
  SYSTEM_PROMPT,
  accusePrompt,
  defendPrompt,
  extractJson,
  hunterPrompt,
  nightPrompt,
  parseReasoning,
  parseTargetResponse,
  parseTextResponse,
  parseWitchResponse,
  statementPrompt,
  votePrompt,
  witchPrompt,
  wolfChatPrompt,
} from "./prompts";

const REQUEST_TIMEOUT_MS = 45_000;
// Headroom for the private reasoning field: a truncated JSON object fails to
// parse and forces a fallback.
const MAX_TOKENS = 512;
// Public speech is only ever read from a named JSON key, never from raw text.
const STRICT = { allowRaw: false } as const;
const MAX_ATTEMPTS = 2;

const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CRYSTAL_BALL = /\u{1F52E}\uFE0F?/gu;

/**
 * Invariant 5.5: bots treat any statement that starts with SEER_CLAIM_TAG as
 * ground truth, so only the real Seer may ever emit U+1F52E. Runs on decoded
 * JSON, where "\ud83d\udd2e" escapes are already the emoji. Lone surrogate
 * halves go first, so deleting an emoji cannot join two halves into a new one.
 * null (nothing left to say) makes the reply unusable.
 */
function guardSeerTag(text: string | null, view: PlayerView): string | null {
  if (text === null || view.self.role === "seer") return text;
  let s = text.replace(UNPAIRED_SURROGATE, "");
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(CRYSTAL_BALL, "");
  }
  s = s.trim();
  return s && !s.startsWith(SEER_CLAIM_TAG) && !s.includes("\u{1F52E}") ? s : null;
}

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

  /**
   * One decision: ask the model, parse, and on any failure let the heuristic
   * answer. Stamps provenance on the trace either way.
   */
  private async decide<T>(
    trace: DecisionTrace | undefined,
    prompt: () => string, // thunk: a throw while building the prompt must fall back too
    parse: (text: string) => T | null, // null ⇒ unusable ⇒ fallback
    fallback: (trace: DecisionTrace) => Promise<T>
  ): Promise<T> {
    const out = trace ?? {};
    // Wall-clock is fine here: this is the agents layer, not the engine.
    const started = Date.now();
    let reason: FallbackReason;
    try {
      const user = prompt();
      let text = "";
      // One retry on an unusable reply: sampling is hot (0.85), so a second
      // draw usually lands. Network/HTTP errors are not retried.
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        text = await this.chat(SYSTEM_PROMPT, user);
        const value = parse(text);
        if (value !== null) {
          out.source = "model";
          out.reasoning = parseReasoning(text);
          out.latencyMs = Date.now() - started;
          return value;
        }
      }
      reason = extractJson(text) === null ? "parse" : "invalid";
    } catch (err) {
      const e = err as Error;
      reason =
        e?.name === "AbortError"
          ? "timeout"
          : /^(Anthropic|OpenAI-compatible) \d+/.test(e?.message ?? "")
          ? "http"
          : "error";
    }
    // The reasoning shown is the heuristic's (why the substitute move was made),
    // never the model's partial text.
    const value = await fallback(out);
    out.source = "fallback";
    out.fallbackReason = reason;
    out.latencyMs = Date.now() - started;
    return value;
  }

  async nightAction(view: PlayerView, trace?: DecisionTrace): Promise<NightDecision> {
    if (view.self.role === "villager") return { targetId: null };
    return this.decide<NightDecision>(
      trace,
      () => nightPrompt(view),
      (text) => {
        const t = parseTargetResponse(text, view);
        return t === null ? null : { targetId: t };
      },
      (tr) => this.fallback.nightAction(view, tr)
    );
  }

  async dayStatement(view: PlayerView, trace?: DecisionTrace): Promise<string> {
    return this.decide(
      trace,
      () => statementPrompt(view),
      (text) => guardSeerTag(parseTextResponse(text, ["statement"], STRICT), view),
      (tr) => this.fallback.dayStatement(view, tr)
    );
  }

  async dayVote(view: PlayerView, trace?: DecisionTrace): Promise<VoteDecision> {
    return this.decide<VoteDecision>(
      trace,
      () => votePrompt(view),
      (text) => {
        const t = parseTargetResponse(text, view);
        return t === null ? null : { targetId: t };
      },
      (tr) => this.fallback.dayVote(view, tr)
    );
  }

  async wolfChat(view: PlayerView, round: number, trace?: DecisionTrace): Promise<string> {
    return this.decide(
      trace,
      () => wolfChatPrompt(view, round),
      (text) => guardSeerTag(parseTextResponse(text, ["message", "statement"], STRICT), view),
      (tr) => this.fallback.wolfChat(view, round, tr)
    );
  }

  async accuse(view: PlayerView, trace?: DecisionTrace): Promise<AccuseDecision> {
    return this.decide<AccuseDecision>(
      trace,
      () => accusePrompt(view),
      (text) => {
        if (extractJson(text) === null) return null;
        // Only "accusation" is ever spoken: a stray "reason" key may be an
        // abbreviated private "reasoning" and must not reach the table.
        const spoken = parseTextResponse(text, ["accusation"], STRICT);
        const said = guardSeerTag(spoken, view);
        if (spoken !== null && said === null) return null;
        return { targetId: parseTargetResponse(text, view), text: said ?? undefined };
      },
      (tr) => this.fallback.accuse(view, tr)
    );
  }

  async defend(view: PlayerView, against: AccusationRecord[], trace?: DecisionTrace): Promise<string> {
    return this.decide(
      trace,
      () => defendPrompt(view, against),
      (text) => guardSeerTag(parseTextResponse(text, ["statement"], STRICT), view),
      (tr) => this.fallback.defend(view, against, tr)
    );
  }

  async witchAction(
    view: PlayerView,
    wolfTargetId: number | null,
    trace?: DecisionTrace
  ): Promise<WitchDecision> {
    return this.decide(
      trace,
      () => witchPrompt(view, wolfTargetId),
      (text) => parseWitchResponse(text, view),
      (tr) => this.fallback.witchAction(view, wolfTargetId, tr)
    );
  }

  async hunterShot(view: PlayerView, trace?: DecisionTrace): Promise<{ targetId: number | null }> {
    return this.decide<{ targetId: number | null }>(
      trace,
      () => hunterPrompt(view),
      (text) => {
        const t = parseTargetResponse(text, view);
        return t === null ? null : { targetId: t };
      },
      (tr) => this.fallback.hunterShot(view, tr)
    );
  }
}
