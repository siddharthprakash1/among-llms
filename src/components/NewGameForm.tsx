"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ModelInfo } from "@/lib/agents/registry";
import { defaultRoleCounts } from "@/lib/engine/roles";
import type { Role, ToggleableRole } from "@/lib/engine/types";
import { ROLE_META, cn, modelLabel } from "@/lib/ui";

const SIZES = [5, 6, 7, 8, 9, 10, 11, 12];
const SEAT_ROLES: Role[] = ["werewolf", "seer", "doctor", "hunter", "witch", "jester", "villager"];
const SPECIAL_ROLES = [
  { id: "hunter", label: "🏹 Hunter" },
  { id: "witch", label: "🧪 Witch" },
  { id: "jester", label: "🃏 Jester" },
];

export default function NewGameForm() {
  const router = useRouter();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selected, setSelected] = useState<string[]>(["mock"]);
  const [numPlayers, setNumPlayers] = useState(7);
  const [specials, setSpecials] = useState<Record<string, boolean>>({
    hunter: true,
    witch: true,
    jester: true,
  });
  const [pending, setPending] = useState<"run" | "live" | "seat" | null>(null);
  const loading = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const [seatError, setSeatError] = useState<string | null>(null);
  const [seatOpen, setSeatOpen] = useState(false);
  // null = surprise me
  const [seatRole, setSeatRole] = useState<Role | null>(null);
  const reduce = useReducedMotion();

  const disabledRoles = useMemo(() => Object.keys(specials).filter((r) => !specials[r]), [specials]);
  const dealtRoles = useMemo(() => {
    const counts = defaultRoleCounts(numPlayers, disabledRoles as ToggleableRole[]);
    return SEAT_ROLES.filter((r) => counts[r] > 0);
  }, [numPlayers, disabledRoles]);

  useEffect(() => {
    if (seatRole && !dealtRoles.includes(seatRole)) setSeatRole(null);
  }, [seatRole, dealtRoles]);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((d: { models: ModelInfo[] }) => setModels(d.models ?? []))
      .catch(() => setModels([{ id: "mock", label: "Mock bot (offline)", provider: "Mock", available: true }]));
  }, []);

  const toggle = (id: string) => {
    setSelected((cur) => {
      if (cur.includes(id)) {
        const next = cur.filter((m) => m !== id);
        return next.length ? next : ["mock"];
      }
      return [...cur, id];
    });
  };

  const toggleSpecial = (role: string) => {
    setSpecials((cur) => ({ ...cur, [role]: !cur[role] }));
  };

  const run = async (live: boolean) => {
    setPending(live ? "live" : "run");
    setError(null);
    setSeatError(null);
    try {
      const res = await fetch(live ? "/api/games/live" : "/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ numPlayers, seatModels: selected, disabledRoles }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start match");
      router.push(`/game/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setPending(null);
    }
  };

  const takeSeat = async () => {
    setPending("seat");
    setError(null);
    setSeatError(null);
    try {
      const res = await fetch("/api/games/human", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          numPlayers,
          seatModels: selected,
          disabledRoles,
          role: seatRole ?? undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not take a seat");
      router.push(`/play/${data.id}`);
    } catch (e) {
      setSeatError(e instanceof Error ? e.message : "Something went wrong");
      setPending(null);
    }
  };

  const onlyMock = models.length <= 1;
  const chip = (on: boolean) =>
    cn(
      "px-3 py-1.5 rounded-full border text-sm font-medium transition-colors",
      on
        ? "bg-[var(--panel-2)] border-[var(--gold)] text-[var(--gold)]"
        : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"
    );

  return (
    <div className="card p-5 sm:p-6 space-y-5">
      <div>
        <div className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">
          Players at the table
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SIZES.map((s) => (
            <button
              key={s}
              onClick={() => setNumPlayers(s)}
              className={cn(
                "w-10 h-10 rounded-xl border text-sm font-semibold transition-colors",
                numPlayers === s
                  ? "bg-[var(--gold)] text-[#2a1d04] border-transparent"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">
          Seat these models{" "}
          <span className="normal-case font-normal text-[var(--muted)]">
            (filled round-robin)
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => toggle(m.id)}
              className={cn(
                "px-3 py-1.5 rounded-full border text-sm font-medium transition-colors",
                selected.includes(m.id)
                  ? "bg-[var(--panel-2)] border-[var(--gold)] text-[var(--gold)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"
              )}
            >
              {modelLabel(m.id)}
              <span className="ml-1.5 text-[10px] opacity-70">{m.provider}</span>
            </button>
          ))}
        </div>
        {onlyMock && (
          <p className="text-xs text-[var(--muted)] mt-2 leading-relaxed">
            Only the offline bot is configured. Add an API key or Ollama in{" "}
            <code className="text-[var(--gold)]">.env</code> to seat real models like GPT, Claude,
            or Llama.
          </p>
        )}
      </div>

      <div>
        <div className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">
          Special roles
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SPECIAL_ROLES.map((role) => (
            <button
              key={role.id}
              onClick={() => toggleSpecial(role.id)}
              className={cn(
                "px-3 py-1.5 rounded-full border text-sm font-medium transition-colors",
                specials[role.id]
                  ? "bg-[var(--panel-2)] border-[var(--gold)] text-[var(--gold)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"
              )}
            >
              {role.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--muted)] mt-2 leading-relaxed">
          Hunter joins at 6+, Witch at 8+, Jester at 9+ players.
        </p>
      </div>

      {error && <div className="text-sm text-[var(--blood)]">{error}</div>}

      <div className="grid grid-cols-2 gap-2">
        <button className="btn btn-primary py-3 text-base" onClick={() => run(false)} disabled={loading}>
          {pending === "run" ? "Dealing…" : "▶ Run a match"}
        </button>
        <button className="btn btn-ghost py-3 text-base" onClick={() => run(true)} disabled={loading}>
          {pending === "live" ? "Dealing…" : "📡 Watch live"}
        </button>
      </div>

      <div>
        <button
          className="btn btn-ghost w-full py-3 text-base !border-[color-mix(in_srgb,var(--gold)_55%,transparent)]"
          onClick={() => setSeatOpen((o) => !o)}
          aria-expanded={seatOpen}
          aria-controls="take-a-seat"
          disabled={loading}
        >
          🎭 Play a seat yourself
          <span
            aria-hidden
            className={cn("text-xs text-[var(--muted)] transition-transform", seatOpen && "rotate-180")}
          >
            ▾
          </span>
        </button>
        <AnimatePresence initial={false}>
          {seatOpen && (
            <motion.div
              id="take-a-seat"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.25 }}
              className="overflow-hidden"
            >
              <div className="pt-4 space-y-3">
                <div>
                  <div className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">
                    Your role
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setSeatRole(null)}
                      aria-pressed={seatRole === null}
                      className={chip(seatRole === null)}
                    >
                      🎲 Surprise me
                    </button>
                    {dealtRoles.map((r) => (
                      <button
                        key={r}
                        onClick={() => setSeatRole(r)}
                        aria-pressed={seatRole === r}
                        className={chip(seatRole === r)}
                      >
                        {ROLE_META[r].emoji} {ROLE_META[r].label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-[var(--muted)] leading-relaxed">
                  You take 1 of {numPlayers} seats; the selected models fill the rest. Unrated — the
                  leaderboard only counts model-vs-model games.
                </p>
                {seatError && (
                  <div role="alert" className="text-sm text-[var(--blood)]">
                    {seatError}
                  </div>
                )}
                <button className="btn btn-primary w-full py-3 text-base" onClick={takeSeat} disabled={loading}>
                  {pending === "seat" ? "Dealing…" : "Take your seat →"}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {(pending === "run" || pending === "live") && (
        <p className="text-xs text-[var(--muted)] text-center">
          Real models think in real time — a full game can take a minute.
        </p>
      )}
    </div>
  );
}
