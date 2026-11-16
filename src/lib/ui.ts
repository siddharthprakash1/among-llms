// Small presentation helpers shared across components.

import { Role } from "./engine/types";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export const ROLE_META: Record<Role, { emoji: string; label: string; align: "good" | "evil" | "neutral" }> = {
  werewolf: { emoji: "🐺", label: "Werewolf", align: "evil" },
  seer: { emoji: "🔮", label: "Seer", align: "good" },
  doctor: { emoji: "🩺", label: "Doctor", align: "good" },
  villager: { emoji: "🧑‍🌾", label: "Villager", align: "good" },
  hunter: { emoji: "🏹", label: "Hunter", align: "good" },
  witch: { emoji: "🧪", label: "Witch", align: "good" },
  jester: { emoji: "🃏", label: "Jester", align: "neutral" },
};

export const ROLE_HELP: Record<Role, string> = {
  werewolf: "Each night your pack kills one player. By day, blend in and get villagers voted out.",
  seer: "Each night you learn one player's true alignment. Reveal a wolf at the right moment.",
  doctor: "Each night you shield one player from the wolves. You may shield yourself.",
  villager: "You have no power but your reasoning. Read the table and vote the wolves out.",
  hunter: "When you die, by fang or by vote, you take one player down with you.",
  witch: "You hold one heal and one poison. Each night you learn who the wolves attacked; use at most one potion.",
  jester: "You win alone if the village votes you out. Dying at night is a loss.",
};

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function modelLabel(id: string): string {
  if (id === "mock") return "Mock bot";
  if (id === "human") return "🧑 Human";
  return id;
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "a Werewolf" / "the Doctor": roles that can be dealt more than once take the indefinite article. */
export function roleNoun(role: Role): string {
  return `${role === "werewolf" || role === "villager" ? "a" : "the"} ${ROLE_META[role].label}`;
}
