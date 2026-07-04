// Prompt construction + lenient response parsing for real LLM brains.
// Prompts are compact and role-redacted; parsing tolerates messy model output
// (markdown fences, prose around JSON) and the caller falls back to heuristics
// if parsing fails entirely.

import { PlayerView, Role } from "../engine/types";

const ROLE_BRIEF: Record<Role, string> = {
  werewolf:
    "You are a WEREWOLF. Each night your pack secretly kills one villager. By day you must blend in, deflect suspicion, and avoid being voted out. Lying is your job.",
  seer:
    "You are the SEER. Each night you learn the true alignment of one player. Use this carefully — reveal too early and the wolves will kill you.",
  doctor:
    "You are the DOCTOR. Each night you protect one player (possibly yourself) from the wolves. Stay hidden so the wolves don't target you.",
  villager:
    "You are a VILLAGER. You have no special power — only your reasoning and the discussion. Find the wolves and vote them out.",
};

function nameOf(view: PlayerView, id: number): string {
  return view.players.find((p) => p.id === id)?.name ?? `Seat ${id}`;
}

function roster(view: PlayerView): string {
  return view.players
    .map((p) => {
      const dead = view.deaths.find((d) => d.playerId === p.id);
      const status = dead ? `DEAD (was ${dead.role}, ${dead.cause})` : "alive";
      return `  - [${p.id}] ${p.name} — ${status}`;
    })
    .join("\n");
}

function privateKnowledge(view: PlayerView): string {
  const lines: string[] = [];
  if (view.knownWolves.length > 0) {
    const pack = view.knownWolves
      .filter((id) => id !== view.self.id)
      .map((id) => `${nameOf(view, id)} [${id}]`);
    lines.push(`Your packmates: ${pack.length ? pack.join(", ") : "(you are the last wolf)"}.`);
  }
  if (view.self.role === "seer" && view.seerResults.length > 0) {
    lines.push(
      "Your night visions: " +
        view.seerResults
          .map((r) => `${nameOf(view, r.targetId)} is ${r.alignment === "evil" ? "a WEREWOLF" : "innocent"}`)
          .join("; ") +
        "."
    );
  }
  if (view.self.role === "doctor" && view.lastProtectedId !== null) {
    lines.push(`Last night you protected ${nameOf(view, view.lastProtectedId)}.`);
  }
  return lines.length ? lines.join("\n") : "(no private information yet)";
}

function recentDiscussion(view: PlayerView, limit = 16): string {
  const recent = view.statements.slice(-limit);
  if (recent.length === 0) return "(no discussion yet)";
  return recent
    .map((s) => `  ${nameOf(view, s.playerId)}: "${s.text}"`)
    .join("\n");
}

function recentVotes(view: PlayerView): string {
  if (view.votes.length === 0) return "(no votes yet)";
  const lastDay = Math.max(...view.votes.map((v) => v.day));
  const rows = view.votes.filter((v) => v.day === lastDay);
  return rows
    .map(
      (v) =>
        `  ${nameOf(view, v.voterId)} voted ${
          v.targetId === null ? "to abstain" : `for ${nameOf(view, v.targetId)}`
        }`
    )
    .join("\n");
}

export function buildContext(view: PlayerView): string {
  return [
    `You are ${view.self.name} (seat ${view.self.id}) in a game of Werewolf.`,
    ROLE_BRIEF[view.self.role],
    "",
    "Players:",
    roster(view),
    "",
    "What you privately know:",
    privateKnowledge(view),
    "",
    "Recent discussion:",
    recentDiscussion(view),
    "",
    `Most recent votes:`,
    recentVotes(view),
  ].join("\n");
}

export const SYSTEM_PROMPT = [
  "You are an elite Werewolf (Mafia) player. Play ruthlessly to win for YOUR team.",
  "Village side (Villager/Seer/Doctor): your goal is to find and vote out every werewolf. A credible Seer claim that names a wolf is the strongest evidence in the game — rally the vote behind it. Track who defends whom and who keeps voting together.",
  "Seer: once you've confirmed a wolf, revealing it out loud can win the game for the village — but you'll be hunted at night, so time it well.",
  "Werewolves: your goal is to survive until wolves equal the villagers. Blend in, cast believable doubt on villagers, protect your packmates without being obvious, and never reveal who your fellow wolves are.",
  "Be concise and in-character. Respond with ONLY the requested JSON object — no markdown, no text outside the JSON.",
].join("\n");

export function nightPrompt(view: PlayerView): string {
  const legal =
    view.self.role === "werewolf"
      ? view.aliveIds.filter((id) => !view.knownWolves.includes(id))
      : view.self.role === "doctor"
      ? view.aliveIds
      : view.aliveIds.filter((id) => id !== view.self.id);
  const verb =
    view.self.role === "werewolf"
      ? "kill"
      : view.self.role === "seer"
      ? "investigate"
      : "protect";
  return [
    buildContext(view),
    "",
    `It is NIGHT ${view.day}. Choose ONE player to ${verb}.`,
    `Legal target seat ids: [${legal.join(", ")}].`,
    'Respond as JSON: {"target": <seat id number>, "reason": "<one short sentence>"}',
  ].join("\n");
}

export function statementPrompt(view: PlayerView): string {
  return [
    buildContext(view),
    "",
    `It is DAY ${view.day}, open discussion. Say ONE short, persuasive thing to the table (1–2 sentences). Stay in character for your role and team.`,
    'Respond as JSON: {"statement": "<your words>"}',
  ].join("\n");
}

export function votePrompt(view: PlayerView): string {
  const legal = view.aliveIds.filter((id) => id !== view.self.id);
  return [
    buildContext(view),
    "",
    `It is DAY ${view.day}, time to vote someone out. Vote to maximize your team's chance of winning.`,
    `Legal seat ids: [${legal.join(", ")}]. You may abstain with target null.`,
    'Respond as JSON: {"target": <seat id number or null>, "reason": "<one short sentence>"}',
  ].join("\n");
}

// --- parsing -------------------------------------------------------------

function extractJson(text: string): unknown | null {
  if (!text) return null;
  // Strip code fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function coerceTarget(value: unknown, view: PlayerView): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "null" || trimmed === "") return null;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum)) return Math.trunc(asNum);
    // try to match a name
    const byName = view.players.find(
      (p) => p.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (byName) return byName.id;
  }
  return null;
}

export function parseTargetResponse(text: string, view: PlayerView): number | null {
  const obj = extractJson(text) as { target?: unknown } | null;
  if (!obj || !("target" in obj)) return null;
  if (obj.target === null) return null;
  return coerceTarget(obj.target, view);
}

export function parseStatementResponse(text: string): string | null {
  const obj = extractJson(text) as { statement?: unknown } | null;
  if (obj && typeof obj.statement === "string" && obj.statement.trim()) {
    return obj.statement.trim();
  }
  // fall back to raw text if it's short enough to be a statement
  const raw = (text ?? "").trim();
  if (raw && raw.length <= 400 && !raw.startsWith("{")) return raw;
  return null;
}
