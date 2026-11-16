// A Brain whose decisions come from a person. It never rejects: a missing,
// late or malformed answer falls back to the heuristic brain for that turn,
// and the engine's own validation stays the second layer.

import type {
  AccusationRecord,
  AccuseDecision,
  Brain,
  DecisionTrace,
  NightDecision,
  PlayerView,
  VoteDecision,
  WitchDecision,
} from "../engine/types";
import { HUMAN_MODEL_ID, type PromptKind, type PromptSpec, type SeatAnswer } from "../human/types";
import { buildPromptSpec } from "../human/legal";
import { HUMAN_TEXT_MAX, sanitizeHumanText, seerClaimText } from "../human/sanitize";
import { SEER_CLAIM_TAG } from "./mockBrain";

export interface PromptPort {
  /** Resolves with the human's answer, or null on timeout / autopilot / game end. Never rejects. */
  ask(spec: PromptSpec): Promise<SeatAnswer | null>;
}

// Second layer for the Seer-tag invariant: human free text can never carry the tag.
const clean = (t: string): string | null =>
  t.startsWith(SEER_CLAIM_TAG) || t.includes("\u{1F52E}") ? null : t;

const NIGHT_KIND: Partial<Record<string, PromptKind>> = {
  werewolf: "night_kill",
  seer: "night_check",
  doctor: "night_protect",
};

export class HumanBrain implements Brain {
  readonly id = HUMAN_MODEL_ID;
  constructor(
    private port: PromptPort,
    private fallback: Brain
  ) {}

  /**
   * One shape for every decision: ask, map, and on null / wrong kind / any throw
   * delegate to the fallback (which reports itself on the trace as a bot move).
   * A human answer leaves the trace empty: people do not report reasoning.
   */
  private async decide<T>(
    spec: () => PromptSpec | null,
    map: (answer: SeatAnswer) => T | null,
    fallback: () => Promise<T | undefined> | undefined,
    hardDefault: T,
    skip?: T
  ): Promise<T> {
    try {
      const s = spec();
      if (s === null && skip !== undefined) return skip;
      if (s !== null) {
        const answer = await this.port.ask(s);
        if (answer) {
          const mapped = map(answer);
          if (mapped !== null) return mapped;
        }
      }
    } catch {
      /* fall through to the fallback */
    }
    try {
      return (await fallback()) ?? hardDefault;
    } catch {
      return hardDefault;
    }
  }

  nightAction(view: PlayerView, trace?: DecisionTrace): Promise<NightDecision> {
    const kind = NIGHT_KIND[view.self.role];
    return this.decide<NightDecision>(
      () => {
        if (!kind) return null;
        const spec = buildPromptSpec(kind, view);
        return spec.legalTargets.length ? spec : null;
      },
      (a) => (a.kind === "target" ? { targetId: a.targetId } : null),
      () => this.fallback.nightAction(view, trace),
      { targetId: null },
      { targetId: null }
    );
  }

  dayStatement(view: PlayerView, trace?: DecisionTrace): Promise<string> {
    return this.decide<string>(
      () => buildPromptSpec("statement", view),
      (a) => {
        if (a.kind === "text") return clean(sanitizeHumanText(a.text, HUMAN_TEXT_MAX.statement));
        if (a.kind === "seer_claim") {
          const confirmed =
            view.self.role === "seer" &&
            view.seerResults.some((r) => r.targetId === a.targetId && r.alignment === "evil") &&
            view.aliveIds.includes(a.targetId);
          const name = view.players.find((p) => p.id === a.targetId)?.name;
          return confirmed && name ? seerClaimText(name) : null;
        }
        return null;
      },
      () => this.fallback.dayStatement(view, trace),
      ""
    );
  }

  dayVote(view: PlayerView, trace?: DecisionTrace): Promise<VoteDecision> {
    return this.decide<VoteDecision>(
      () => buildPromptSpec("vote", view),
      (a) => (a.kind === "target" ? { targetId: a.targetId } : null),
      () => this.fallback.dayVote(view, trace),
      { targetId: null }
    );
  }

  wolfChat(view: PlayerView, round: number, trace?: DecisionTrace): Promise<string> {
    return this.decide<string>(
      () => buildPromptSpec("wolf_chat", view, { round }),
      (a) => (a.kind === "text" ? clean(sanitizeHumanText(a.text, HUMAN_TEXT_MAX.wolf_chat)) : null),
      () => this.fallback.wolfChat?.(view, round, trace),
      ""
    );
  }

  accuse(view: PlayerView, trace?: DecisionTrace): Promise<AccuseDecision> {
    return this.decide<AccuseDecision>(
      () => buildPromptSpec("accuse", view),
      (a) => {
        if (a.kind !== "accuse") return null;
        const text = clean(sanitizeHumanText(a.text ?? "", HUMAN_TEXT_MAX.accuse));
        if (text === null) return null;
        return { targetId: a.targetId, text: text || undefined };
      },
      () => this.fallback.accuse?.(view, trace),
      { targetId: null }
    );
  }

  defend(view: PlayerView, against: AccusationRecord[], trace?: DecisionTrace): Promise<string> {
    return this.decide<string>(
      () => buildPromptSpec("defend", view, { against }),
      (a) => (a.kind === "text" ? clean(sanitizeHumanText(a.text, HUMAN_TEXT_MAX.defend)) : null),
      () => this.fallback.defend?.(view, against, trace),
      ""
    );
  }

  witchAction(view: PlayerView, wolfTargetId: number | null, trace?: DecisionTrace): Promise<WitchDecision> {
    const none: WitchDecision = { heal: false, poisonTargetId: null };
    return this.decide<WitchDecision>(
      () => {
        const potions = view.potions ?? { heal: false, poison: false };
        // The engine asks every night; when "do nothing" is the only legal answer
        // an unanswered prompt would wrongly count towards autopilot.
        if (!potions.poison && !(potions.heal && wolfTargetId !== null)) return null;
        return buildPromptSpec("witch", view, { wolfTargetId });
      },
      (a) => (a.kind === "witch" ? { heal: a.heal, poisonTargetId: a.poisonTargetId } : null),
      () => this.fallback.witchAction?.(view, wolfTargetId, trace),
      none,
      none
    );
  }

  hunterShot(view: PlayerView, trace?: DecisionTrace): Promise<{ targetId: number | null }> {
    return this.decide<{ targetId: number | null }>(
      () => buildPromptSpec("hunter_shot", view),
      (a) => (a.kind === "target" ? { targetId: a.targetId } : null),
      () => this.fallback.hunterShot?.(view, trace),
      { targetId: null }
    );
  }
}
