"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Tournament } from "@/lib/tournaments/types";
import { standings, matchWinner } from "@/lib/tournaments/schedule";
import { cn, modelLabel } from "@/lib/ui";

export default function TournamentView({ id }: { id: string }) {
  const [t, setT] = useState<Tournament | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/tournaments/${id}`);
        if (res.status === 404) {
          if (alive) setMissing(true);
          return;
        }
        const data = await res.json();
        if (alive) setT(data.tournament);
      } catch {
        /* keep last state */
      }
    };
    poll();
    const iv = setInterval(() => {
      if (t?.status === "running" || !t) poll();
    }, 2000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [id, t?.status]);

  if (missing) return <div className="glass p-10 text-center text-[var(--muted)]">Tournament not found.</div>;
  if (!t) return <div className="glass p-10 text-center text-[var(--muted)]">Loading tournament…</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="display text-4xl sm:text-5xl flex items-center gap-3">
          {t.config.name}
          {t.status === "running" && (
            <span className="chip tag-evil" style={{ animation: "twinkle 1.2s ease-in-out infinite" }}>
              ● running
            </span>
          )}
          {t.status === "finished" && <span className="chip tag-good">✓ finished</span>}
        </h1>
        <div className="flex flex-wrap gap-1.5 mt-2">
          <span className="chip tag-gold">
            {t.config.format === "round_robin" ? "Round robin" : "Knockout"}
          </span>
          <span className="chip">{t.config.roster.length} models</span>
          <span className="chip">{t.config.numPlayers}-player tables</span>
        </div>
      </div>

      {t.config.format === "round_robin" ? (
        <Standings t={t} />
      ) : (
        <Bracket t={t} />
      )}
    </div>
  );
}

function Standings({ t }: { t: Tournament }) {
  const rows = standings(t);
  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-[28px_1fr_64px_64px_80px] gap-3 px-4 py-3 border-b border-[var(--border)] text-[11px] uppercase tracking-wider text-[var(--muted)] font-semibold">
        <span>#</span>
        <span>Model</span>
        <span className="text-right">Games</span>
        <span className="text-right">Wins</span>
        <span className="text-right">Seat wins</span>
      </div>
      {rows.map((r, i) => (
        <div
          key={r.model}
          className={cn(
            "grid grid-cols-[28px_1fr_64px_64px_80px] gap-3 px-4 py-3 items-center border-b border-[var(--border)] last:border-0",
            i % 2 ? "bg-[color-mix(in_srgb,var(--panel-2)_40%,transparent)]" : ""
          )}
        >
          <span className="text-sm">{["🥇", "🥈", "🥉"][i] ?? i + 1}</span>
          <Link href={`/models/${encodeURIComponent(r.model)}`} className="font-semibold text-sm truncate link !text-[var(--text)] hover:!text-[var(--gold)]">
            {modelLabel(r.model)}
          </Link>
          <span className="text-right text-sm text-[var(--muted)] tabular-nums">{r.games}</span>
          <span className="text-right font-bold text-[var(--gold)] tabular-nums">{r.wins}</span>
          <span className="text-right text-sm text-[var(--muted)] tabular-nums">{r.seatWins}</span>
        </div>
      ))}
    </div>
  );
}

function Bracket({ t }: { t: Tournament }) {
  const bracket = t.bracket ?? [];
  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {bracket.map((round, ri) => (
        <div key={ri} className="min-w-[220px] space-y-3">
          <div className="text-xs uppercase tracking-wider text-[var(--muted)] font-semibold">
            {ri === bracket.length - 1 ? "Final" : `Round ${ri + 1}`}
          </div>
          {round.map((m) => {
            const winner = matchWinner(m);
            const side = (model: string | null) => (
              <div
                className={cn(
                  "flex items-center justify-between px-3 py-1.5 rounded-lg text-sm",
                  model && winner === model
                    ? "bg-[color-mix(in_srgb,var(--good)_14%,transparent)] text-[var(--good)] font-semibold"
                    : "text-[var(--text)]"
                )}
              >
                <span className="truncate">{model ? modelLabel(model) : "— TBD —"}</span>
              </div>
            );
            return (
              <div key={m.key} className="card p-1.5 space-y-1">
                {side(m.a)}
                {side(m.b)}
                {m.games.length > 0 && (
                  <div className="flex flex-wrap gap-1 px-2 pt-1">
                    {m.games.map((g) =>
                      g.gameId ? (
                        <Link
                          key={g.key}
                          href={`/game/${g.gameId}`}
                          className="chip !text-[10px] hover:border-[var(--gold)]"
                        >
                          game
                        </Link>
                      ) : (
                        <span key={g.key} className="chip !text-[10px] opacity-50">
                          {g.status}
                        </span>
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
