"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { Role } from "@/lib/engine/types";
import type { SeatKnowledge, SeatMeta } from "@/lib/human/types";
import type { ReplaySeat } from "@/lib/replay";
import { ROLE_HELP, ROLE_META, cn } from "@/lib/ui";

interface Props {
  meta: SeatMeta;
  knowledge: SeatKnowledge;
  seats: ReplaySeat[];
}

const ROLE_ORDER: Role[] = ["werewolf", "seer", "doctor", "hunter", "witch", "jester", "villager"];

const TEAM = {
  evil: { tag: "tag-evil", label: "Werewolves", color: "var(--evil)" },
  good: { tag: "tag-good", label: "Village", color: "var(--good)" },
  neutral: { tag: "tag-gold", label: "Alone", color: "var(--gold)" },
} as const;

export default function RoleCard({ meta, knowledge, seats }: Props) {
  const [hidden, setHidden] = useState(false);
  const reduce = useReducedMotion();
  const role = ROLE_META[meta.you.role];
  const team = TEAM[role.align];
  const nameOf = (id: number) => seats.find((s) => s.id === id)?.name ?? `Seat ${id}`;
  const seatOf = (id: number) => seats.find((s) => s.id === id);

  return (
    <motion.section
      aria-label="Your role"
      initial={reduce ? false : { rotateY: -80, opacity: 0 }}
      animate={{ rotateY: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
      className="card relative overflow-hidden"
      style={{
        borderColor: `color-mix(in srgb, ${team.color} 45%, var(--border))`,
        transformPerspective: 900,
      }}
    >
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-24 pointer-events-none"
        style={{
          background: `radial-gradient(120% 100% at 0% 0%, color-mix(in srgb, ${team.color} 16%, transparent), transparent 70%)`,
        }}
      />
      <button
        type="button"
        onClick={() => setHidden((h) => !h)}
        aria-pressed={hidden}
        title={hidden ? "Show your role" : "Hide your role"}
        aria-label={hidden ? "Show your role" : "Hide your role"}
        className="absolute top-3 right-3 z-10 w-8 h-8 grid place-items-center rounded-full border border-[var(--border)] bg-[var(--panel-2)] text-sm text-[var(--muted)] hover:text-[var(--text)] transition-colors"
      >
        {hidden ? "🙈" : "👁"}
      </button>

      <div className={cn("relative p-4 space-y-3 transition-[filter] duration-200", hidden && "role-veil")} aria-hidden={hidden}>
        <div className="flex items-center gap-3 pr-10">
          <span className="text-[40px] leading-none">{role.emoji}</span>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--muted)] font-semibold">
              Your role
            </div>
            <div className="display text-3xl">{role.label}</div>
            {/* Phone widths: beside the title the chip would overlap a long role name. */}
            <div className="mt-1 sm:hidden">
              <span className={cn("chip", team.tag)}>{team.label}</span>
            </div>
          </div>
          <div className="ml-auto shrink-0 hidden sm:block">
            <span className={cn("chip", team.tag)}>{team.label}</span>
          </div>
        </div>

        <p className="text-[13px] text-[var(--muted)] leading-relaxed">{ROLE_HELP[meta.you.role]}</p>

        {meta.packmates.length > 0 && (
          <Row label="Pack">
            {meta.packmates.map((id) => {
              const s = seatOf(id);
              return (
                <span key={id} className={cn("chip tag-evil", s && !s.alive && "line-through opacity-60")}>
                  {s?.avatar} {nameOf(id)}
                </span>
              );
            })}
          </Row>
        )}

        {meta.you.role === "seer" && (
          <Row label="Visions">
            {knowledge.visions.length === 0 ? (
              <span className="text-[12px] text-[var(--muted)]">None yet. The night will tell.</span>
            ) : (
              knowledge.visions.map((v, i) => (
                <span
                  key={i}
                  className={cn("chip", v.alignment === "evil" ? "tag-evil" : "tag-good")}
                  title={`Night ${v.day}: ${v.alignment === "evil" ? "werewolf" : "innocent"}`}
                >
                  {nameOf(v.targetId)} {v.alignment === "evil" ? "🐺" : "✓"}
                </span>
              ))
            )}
          </Row>
        )}

        {knowledge.potions && (
          <Row label="Potions">
            <span className={cn("chip", knowledge.potions.heal ? "tag-good" : "line-through opacity-50")}>
              🧪 Heal
            </span>
            <span className={cn("chip", knowledge.potions.poison ? "tag-evil" : "line-through opacity-50")}>
              ☠ Poison
            </span>
          </Row>
        )}

        {meta.you.role === "doctor" && (
          <Row label="Last guarded">
            <span className="text-[12px] text-[var(--text)]">
              {knowledge.lastProtectedId === null ? (
                <span className="text-[var(--muted)]">No one yet</span>
              ) : (
                nameOf(knowledge.lastProtectedId)
              )}
            </span>
          </Row>
        )}

        <div className="pt-2.5 border-t border-[var(--border)] text-[11.5px] text-[var(--muted)] flex flex-wrap gap-x-2.5 gap-y-1">
          <span className="uppercase tracking-wider font-semibold text-[10px] self-center">At the table</span>
          {ROLE_ORDER.filter((r) => meta.roleCounts[r] > 0).map((r) => (
            <span key={r} title={ROLE_META[r].label}>
              {meta.roleCounts[r]} {ROLE_META[r].emoji}
            </span>
          ))}
        </div>
      </div>
    </motion.section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wider font-semibold text-[var(--muted)] w-[86px] shrink-0">
        {label}
      </span>
      {children}
    </div>
  );
}
