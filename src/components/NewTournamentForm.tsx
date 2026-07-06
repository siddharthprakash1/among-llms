"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ModelInfo } from "@/lib/agents/registry";
import { cn, modelLabel } from "@/lib/ui";

export default function NewTournamentForm() {
  const router = useRouter();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<"round_robin" | "knockout">("round_robin");
  const [roster, setRoster] = useState<string[]>(["mock", "hunter-bot", "sentinel-bot"]);
  const [gamesPerRound, setGamesPerRound] = useState(4);
  const [numPlayers, setNumPlayers] = useState(7);
  const [concurrency, setConcurrency] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((d: { models: ModelInfo[] }) => setModels(d.models ?? []))
      .catch(() => setModels([]));
  }, []);

  const toggle = (id: string) =>
    setRoster((cur) => {
      if (cur.includes(id)) {
        const next = cur.filter((m) => m !== id);
        return next.length >= 2 ? next : cur;
      }
      return [...cur, id];
    });

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tournaments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          format,
          roster,
          gamesPerRound,
          numPlayers,
          concurrency,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to start tournament");
      router.push(`/tournaments/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setLoading(false);
    }
  };

  const chip = (active: boolean) =>
    cn(
      "px-3 py-1.5 rounded-full border text-sm font-medium transition-colors",
      active
        ? "bg-[var(--panel-2)] border-[var(--gold)] text-[var(--gold)]"
        : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"
    );

  return (
    <div className="card p-5 sm:p-6 space-y-5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Tournament name (optional)"
        className="w-full bg-[var(--panel-2)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm outline-none focus:border-[var(--gold)]"
      />

      <div>
        <div className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">Format</div>
        <div className="flex gap-1.5">
          <button className={chip(format === "round_robin")} onClick={() => setFormat("round_robin")}>
            Round robin
          </button>
          <button className={chip(format === "knockout")} onClick={() => setFormat("knockout")}>
            Knockout bracket
          </button>
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">
          Roster <span className="normal-case font-normal">(pick 2+)</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {models.map((m) => (
            <button key={m.id} className={chip(roster.includes(m.id))} onClick={() => toggle(m.id)}>
              {modelLabel(m.id)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <label className="space-y-1">
          <span className="text-xs text-[var(--muted)]">
            {format === "knockout" ? "Best-of / match" : "Rounds"}
          </span>
          <input
            type="number"
            min={1}
            max={7}
            value={gamesPerRound}
            onChange={(e) => setGamesPerRound(Number(e.target.value))}
            className="w-full bg-[var(--panel-2)] border border-[var(--border)] rounded-lg px-2 py-1.5 outline-none focus:border-[var(--gold)]"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-[var(--muted)]">Table size</span>
          <input
            type="number"
            min={5}
            max={12}
            value={numPlayers}
            onChange={(e) => setNumPlayers(Number(e.target.value))}
            className="w-full bg-[var(--panel-2)] border border-[var(--border)] rounded-lg px-2 py-1.5 outline-none focus:border-[var(--gold)]"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-[var(--muted)]">Concurrency</span>
          <input
            type="number"
            min={1}
            max={8}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            className="w-full bg-[var(--panel-2)] border border-[var(--border)] rounded-lg px-2 py-1.5 outline-none focus:border-[var(--gold)]"
          />
        </label>
      </div>
      <p className="text-xs text-[var(--muted)]">
        Concurrency &gt; 1 runs games in parallel — kind to API providers, but a single local Ollama box may thrash.
      </p>

      {error && <div className="text-sm text-[var(--blood)]">{error}</div>}
      <button className="btn btn-primary w-full py-3" onClick={run} disabled={loading}>
        {loading ? "Seeding the bracket…" : "🏆 Start tournament"}
      </button>
    </div>
  );
}
