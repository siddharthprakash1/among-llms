"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ModelInfo } from "@/lib/agents/registry";
import { cn, modelLabel } from "@/lib/ui";

const SIZES = [5, 6, 7, 8, 9, 10, 11, 12];
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const disabledRoles = Object.keys(specials).filter((r) => !specials[r]);
      const res = await fetch("/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ numPlayers, seatModels: selected, disabledRoles }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start match");
      router.push(`/game/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setLoading(false);
    }
  };

  const onlyMock = models.length <= 1;

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

      <button className="btn btn-primary w-full py-3 text-base" onClick={run} disabled={loading}>
        {loading ? "Dealing roles…" : "▶  Run a match"}
      </button>
      {loading && (
        <p className="text-xs text-[var(--muted)] text-center">
          Real models think in real time — a full game can take a minute.
        </p>
      )}
    </div>
  );
}
