// What a human seat may answer. Strict on purpose: the engine silently
// randomises an illegal target, so nothing illegal may be forwarded to it.

import type { AccusationRecord, PlayerView } from "../engine/types";
import type { PromptKind, PromptSpec, SeatAnswer } from "./types";
import { HUMAN_TEXT_MAX } from "./sanitize";

const MAX_RAW_TEXT = 2000;

export function legalTargets(kind: PromptKind, view: PlayerView): number[] {
  switch (kind) {
    case "night_kill":
      return view.aliveIds.filter((id) => !view.knownWolves.includes(id));
    case "night_check":
    case "vote":
    case "accuse":
    case "witch":
    case "hunter_shot":
      return view.aliveIds.filter((id) => id !== view.self.id);
    case "night_protect":
      return [...view.aliveIds];
    default:
      return [];
  }
}

export function buildPromptSpec(
  kind: PromptKind,
  view: PlayerView,
  extra: { round?: number; wolfTargetId?: number | null; against?: AccusationRecord[] } = {}
): PromptSpec {
  const spec: PromptSpec = {
    kind,
    day: view.day,
    phase: view.phase,
    legalTargets: legalTargets(kind, view),
    allowPass: true,
    maxChars: 0,
  };
  switch (kind) {
    case "night_kill":
    case "night_check":
    case "night_protect":
    case "hunter_shot":
      spec.allowPass = false;
      break;
    case "vote":
      break;
    case "accuse":
      spec.maxChars = HUMAN_TEXT_MAX.accuse;
      break;
    case "wolf_chat":
      spec.maxChars = HUMAN_TEXT_MAX.wolf_chat;
      if (extra.round !== undefined) spec.round = extra.round;
      break;
    case "defend":
      spec.maxChars = HUMAN_TEXT_MAX.defend;
      spec.against = (extra.against ?? []).map((a) => ({ from: a.from, text: a.text }));
      break;
    case "statement": {
      spec.maxChars = HUMAN_TEXT_MAX.statement;
      if (view.self.role === "seer") {
        const wolves = Array.from(
          new Set(
            view.seerResults
              .filter((r) => r.alignment === "evil" && view.aliveIds.includes(r.targetId))
              .map((r) => r.targetId)
          )
        );
        if (wolves.length) spec.claimableWolves = wolves;
      }
      break;
    }
    case "witch":
      spec.wolfTargetId = extra.wolfTargetId ?? null;
      spec.potions = view.potions
        ? { heal: view.potions.heal, poison: view.potions.poison }
        : { heal: false, poison: false };
      break;
  }
  return spec;
}

const fail = (error: string) => ({ error });

function okText(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_RAW_TEXT;
}

export function validateAnswer(prompt: PromptSpec, body: unknown): SeatAnswer | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail("Answer must be a JSON object.");
  const b = body as Record<string, unknown>;
  const isLegal = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && prompt.legalTargets.includes(v);

  switch (prompt.kind) {
    case "night_kill":
    case "night_check":
    case "night_protect":
    case "hunter_shot":
      if (b.kind !== "target") return fail("This prompt needs a target.");
      if (!isLegal(b.targetId)) return fail("That is not a legal target.");
      return { kind: "target", targetId: b.targetId };
    case "vote":
      if (b.kind !== "target") return fail("This prompt needs a vote.");
      if (b.targetId === null) return { kind: "target", targetId: null };
      if (!isLegal(b.targetId)) return fail("That is not a legal target.");
      return { kind: "target", targetId: b.targetId };
    case "accuse": {
      if (b.kind !== "accuse") return fail("This prompt needs an accusation or a pass.");
      if (b.targetId !== null && !isLegal(b.targetId)) return fail("That is not a legal target.");
      if (b.text !== undefined && !okText(b.text)) return fail("The reason must be a short text.");
      const targetId = b.targetId as number | null;
      return b.text === undefined ? { kind: "accuse", targetId } : { kind: "accuse", targetId, text: b.text };
    }
    case "wolf_chat":
    case "defend":
      if (b.kind !== "text") return fail("This prompt needs text.");
      if (!okText(b.text)) return fail("The text is missing or too long.");
      return { kind: "text", text: b.text };
    case "statement":
      if (b.kind === "text") {
        if (!okText(b.text)) return fail("The text is missing or too long.");
        return { kind: "text", text: b.text };
      }
      if (b.kind === "seer_claim") {
        const t = b.targetId;
        if (typeof t !== "number" || !Number.isInteger(t) || !(prompt.claimableWolves ?? []).includes(t))
          return fail("You have no confirmed vision of that player.");
        return { kind: "seer_claim", targetId: t };
      }
      return fail("This prompt needs a statement.");
    case "witch": {
      if (b.kind !== "witch") return fail("This prompt needs a potion choice.");
      if (typeof b.heal !== "boolean") return fail("heal must be true or false.");
      const potions = prompt.potions ?? { heal: false, poison: false };
      if (b.heal && !(potions.heal && prompt.wolfTargetId != null)) return fail("You cannot heal tonight.");
      const poison = b.poisonTargetId ?? null;
      if (poison !== null) {
        if (!potions.poison) return fail("Your poison is spent.");
        if (!isLegal(poison)) return fail("That is not a legal target.");
        if (b.heal) return fail("At most one potion per night.");
      }
      return { kind: "witch", heal: b.heal, poisonTargetId: poison as number | null };
    }
    default:
      return fail("Unknown prompt.");
  }
}
