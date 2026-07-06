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

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function modelLabel(id: string): string {
  if (id === "mock") return "Mock bot";
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
