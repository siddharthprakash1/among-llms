// Pure logic for the reasoning inspector ("Minds"). Client-safe: no React, no
// Node APIs. Components only render what these functions decide.

import { DecisionRecord, FallbackReason, GameEvent, Player, Transcript } from "./engine/types";
import { HUMAN_MODEL_ID } from "./human/types";
import { pct } from "./ui";

export function hasDecisions(t: Pick<Transcript, "decisions">): boolean {
  return (t.decisions?.length ?? 0) > 0;
}

export interface InspectorModel {
  current: DecisionRecord | null;
  /** All decisions anchored at this step, in seq order (includes current). */
  siblings: DecisionRecord[];
  prev: DecisionRecord | null;
  next: DecisionRecord | null;
  /** 1-based position of `current` in the game's decisions; 0 when there is none. */
  index: number;
  total: number;
}

export function inspect(
  decisions: DecisionRecord[],
  step: number,
  focusSeq: number | null
): InspectorModel {
  const total = decisions.length;
  const siblings = decisions.filter((d) => d.step === step);
  const current =
    siblings.find((d) => d.seq === focusSeq) ?? siblings.find((d) => d.produced) ?? siblings[0] ?? null;

  if (current) {
    // Array position, not `seq`: a live buffer may not start at seq 0.
    const i = decisions.indexOf(current);
    return {
      current,
      siblings,
      prev: decisions[i - 1] ?? null,
      next: decisions[i + 1] ?? null,
      index: i + 1,
      total,
    };
  }

  let prev: DecisionRecord | null = null;
  let next: DecisionRecord | null = null;
  for (const d of decisions) {
    if (d.step < step) prev = d;
    else if (d.step > step) {
      next = d;
      break;
    }
  }
  return { current: null, siblings, prev, next, index: 0, total };
}

/**
 * Seat that gets the 💭 badge: the current decision's actor while Minds is on.
 * No alive filter on purpose: a hunter is already dead when it decides its shot.
 */
export function thinkingSeat(model: InspectorModel, minds: boolean): number | undefined {
  return minds && model.current ? model.current.playerId : undefined;
}

function nameFor(players: Player[], id: number | null | undefined): string {
  if (id === null || id === undefined) return "no one";
  return players.find((p) => p.id === id)?.name ?? `Seat ${id}`;
}

export function describeDecision(
  rec: DecisionRecord,
  event: GameEvent | undefined,
  players: Player[]
): { icon: string; text: string; said?: string } {
  // Only trust the event when it is this decision's own outcome.
  const ev = rec.produced && event?.kind === rec.kind ? event : undefined;
  const applied = nameFor(players, rec.applied?.targetId);

  switch (rec.kind) {
    case "wolf_chat":
      return {
        icon: "🐺",
        text: rec.produced ? "Whispers to the pack" : "Stays silent in the pack chat",
        ...(ev?.kind === "wolf_chat" ? { said: ev.text } : {}),
      };
    case "wolf_kill": {
      const packChose =
        ev?.kind === "wolf_kill" && ev.targetId !== rec.applied?.targetId
          ? ` · pack chose ${nameFor(players, ev.targetId)}`
          : "";
      return { icon: "🐺", text: `Wants to kill ${applied}${packChose}` };
    }
    case "seer_check": {
      const result =
        ev?.kind === "seer_check" ? (ev.result === "evil" ? " → WEREWOLF" : " → innocent") : "";
      return { icon: "🔮", text: `Investigates ${applied}${result}` };
    }
    case "doctor_save":
      return { icon: "🩺", text: `Protects ${applied}` };
    case "witch_action": {
      if (rec.applied?.heal) {
        return {
          icon: "🧪",
          text: ev?.kind === "witch_action" ? `Heals ${nameFor(players, ev.targetId)}` : "Uses the heal",
        };
      }
      if (rec.applied && rec.applied.targetId !== null) return { icon: "🧪", text: `Poisons ${applied}` };
      return { icon: "🧪", text: "Holds her potions" };
    }
    case "hunter_shot":
      return { icon: "🏹", text: `Shoots ${applied}` };
    case "statement":
      return {
        icon: "💬",
        text: "Speaks to the table",
        ...(ev?.kind === "statement" ? { said: ev.text } : {}),
      };
    case "accusation": {
      const text = rec.produced
        ? `Accuses ${applied}`
        : (rec.requested?.targetId ?? null) === null
        ? "Passes on accusing"
        : "Tries to accuse an illegal target";
      return { icon: "⚖️", text, ...(ev?.kind === "accusation" ? { said: ev.text } : {}) };
    }
    case "defense":
      return {
        icon: "🛡",
        text: rec.produced ? "Defends themself" : "Offers no defense",
        ...(ev?.kind === "defense" ? { said: ev.text } : {}),
      };
    case "vote":
      return {
        icon: "🗳",
        text: (rec.applied?.targetId ?? null) === null ? "Abstains" : `Votes for ${applied}`,
      };
  }
}

/** Extra reading time while Minds is on. Never shorter than `baseMs`. */
export function inspectorDwell(baseMs: number, rec: DecisionRecord | null, speed: number): number {
  return rec?.reasoning
    ? Math.max(baseMs, Math.min(6000, 1200 + 45 * rec.reasoning.length) / speed)
    : baseMs;
}

export interface ModelHealth {
  model: string;
  decisions: number;
  /** source === "model" */
  own: number;
  /** source === "fallback" */
  fallbacks: number;
  byReason: Partial<Record<FallbackReason, number>>;
  /** ruling !== "accepted" */
  overridden: number;
  /** Mean over records that have latencyMs; null when none do. */
  avgLatencyMs: number | null;
  /** Human seat only: moves the bot made for it after a timeout or on autopilot. */
  autopilot?: number;
}

export interface SourceChip {
  text: string;
  tone: "good" | "gold" | "plain";
  title?: string;
}

/**
 * How a decision's origin is labelled. A person's own move reaches the record
 * with no reported source (the engine does not know about humans), so the
 * seat's model decides the wording.
 */
export function sourceChip(rec: DecisionRecord, actorModel?: string): SourceChip {
  const human = actorModel === HUMAN_MODEL_ID;
  switch (rec.source) {
    case "model":
      return { text: "● own decision", tone: "good" };
    case "bot":
      return human
        ? { text: "🤖 autopilot", tone: "plain", title: "The person ran out of time; the built-in heuristic made this move." }
        : { text: "🤖 heuristic bot", tone: "plain" };
    case "fallback":
      return {
        text: `⚠ fallback${rec.fallbackReason ? ` · ${rec.fallbackReason}` : ""}`,
        tone: "gold",
        title: "The model's reply was unusable; the built-in heuristic made this move.",
      };
    default:
      return human
        ? { text: "🧑 human move", tone: "gold" }
        : { text: "source not reported", tone: "plain" };
  }
}

/** Shown in place of the thought when a decision has no reasoning. */
export function noReasoningText(rec: DecisionRecord, actorModel?: string): string {
  return actorModel === HUMAN_MODEL_ID && rec.source === "unknown"
    ? "People don't report their reasoning."
    : "No reasoning was returned for this decision.";
}

/** The "how it decided" cell of a Decision health row. */
export function healthLabel(h: ModelHealth): string {
  if (h.model === HUMAN_MODEL_ID) {
    const auto = h.autopilot ?? 0;
    return auto > 0 ? `played by a person · ${auto} on autopilot` : "played by a person";
  }
  if (h.own + h.fallbacks === 0) return "heuristic bot";
  return `${pct(h.own / h.decisions)} own`;
}

export function provenanceSummary(decisions: DecisionRecord[], players: Player[]): ModelHealth[] {
  const rows = new Map<string, ModelHealth & { latencySum: number; latencyCount: number }>();
  for (const rec of decisions) {
    const model = players.find((p) => p.id === rec.playerId)?.model ?? "unknown";
    let row = rows.get(model);
    if (!row) {
      row = {
        model,
        decisions: 0,
        own: 0,
        fallbacks: 0,
        byReason: {},
        overridden: 0,
        avgLatencyMs: null,
        latencySum: 0,
        latencyCount: 0,
      };
      rows.set(model, row);
    }
    row.decisions++;
    if (rec.source === "model") row.own++;
    if (model === HUMAN_MODEL_ID && rec.source === "bot") row.autopilot = (row.autopilot ?? 0) + 1;
    if (rec.source === "fallback") {
      row.fallbacks++;
      if (rec.fallbackReason)
        row.byReason[rec.fallbackReason] = (row.byReason[rec.fallbackReason] ?? 0) + 1;
    }
    if (rec.ruling !== "accepted") row.overridden++;
    if (rec.latencyMs !== undefined) {
      row.latencySum += rec.latencyMs;
      row.latencyCount++;
    }
  }
  return [...rows.values()]
    .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
    .map(({ latencySum, latencyCount, ...row }) => ({
      ...row,
      avgLatencyMs: latencyCount > 0 ? latencySum / latencyCount : null,
    }));
}

/** The slice of a KeyboardEvent the decision shortcuts look at. */
export interface ShortcutKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: unknown;
}

/**
 * Which way `[` / `]` should step, or null when the key is not ours: a modifier
 * is held (Cmd+[ is browser Back) or the viewer is typing. A range input takes
 * no text, so the scrubber keeping focus after a drag must not eat the keys.
 */
export function decisionShortcut(e: ShortcutKey): "prev" | "next" | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const dir = e.key === "[" ? "prev" : e.key === "]" ? "next" : null;
  if (!dir) return null;
  const el = e.target as { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined;
  const tag = el?.tagName?.toUpperCase();
  const typing =
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el?.isContentEditable === true ||
    (tag === "INPUT" && el?.type !== "range");
  return typing ? null : dir;
}

/** "1 fallback", "2 fallbacks". */
export function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
