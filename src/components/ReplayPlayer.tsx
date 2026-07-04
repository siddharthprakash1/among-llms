"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Transcript } from "@/lib/engine/types";
import { deriveState, stepDelay, totalSteps } from "@/lib/replay";
import { ROLE_META, cn, modelLabel } from "@/lib/ui";
import GameTable from "./GameTable";
import EventFeed from "./EventFeed";

const SPEEDS = [1, 2, 4] as const;

export default function ReplayPlayer({ transcript }: { transcript: Transcript }) {
  const total = totalSteps(transcript);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [godView, setGodView] = useState(false);
  const [copied, setCopied] = useState(false);

  const state = useMemo(() => deriveState(transcript, step), [transcript, step]);

  useEffect(() => {
    if (!playing) return;
    if (step >= total) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => Math.min(s + 1, total)), stepDelay(transcript, step, speed));
    return () => clearTimeout(t);
  }, [playing, step, speed, total, transcript]);

  const seek = useCallback(
    (next: number) => {
      setPlaying(false);
      setStep(Math.max(0, Math.min(next, total)));
    },
    [total]
  );

  const restart = useCallback(() => {
    setStep(0);
    setPlaying(true);
  }, []);

  const togglePlay = useCallback(() => {
    if (step >= total) {
      restart();
    } else {
      setPlaying((p) => !p);
    }
  }, [step, total, restart]);

  const share = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  }, []);

  const tableModels = Array.from(new Set(transcript.players.map((p) => p.model)));

  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display text-3xl sm:text-4xl">
            Match <span className="text-[var(--muted)]">#{transcript.id.slice(0, 6)}</span>
          </h1>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {tableModels.map((m) => (
              <span key={m} className="chip tag-gold">
                {modelLabel(m)}
              </span>
            ))}
            <span className="chip">{transcript.config.numPlayers} players</span>
            <span className="chip">seed {transcript.config.seed}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-ghost" onClick={share}>
            {copied ? "Link copied ✓" : "🔗 Share"}
          </button>
          <Link href="/" className="btn btn-primary">
            New match
          </Link>
        </div>
      </div>

      {/* result banner */}
      {state.finished && state.winner && (
        <div
          className={cn(
            "card px-5 py-4 flex flex-wrap items-center justify-between gap-3 border-2",
            state.winner === "good"
              ? "!border-[color-mix(in_srgb,var(--good)_55%,transparent)]"
              : "!border-[color-mix(in_srgb,var(--evil)_55%,transparent)]"
          )}
        >
          <div>
            <div className="display text-2xl">
              {state.winner === "good" ? "🏡 The Village prevails" : "🐺 The Werewolves win"}
            </div>
            <div className="text-sm text-[var(--muted)]">{state.reason}</div>
          </div>
          <button className="btn btn-ghost" onClick={restart}>
            ↻ Replay
          </button>
        </div>
      )}

      {/* main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
        <div className="card p-4 sm:p-6">
          <GameTable
            seats={state.seats}
            highlight={state.highlight}
            banner={state.banner}
            phase={state.phase}
            day={state.day}
            showRole={godView || state.finished}
          />
        </div>
        <div className="h-[460px] lg:h-auto lg:min-h-[520px]">
          <EventFeed log={state.log} seats={state.seats} />
        </div>
      </div>

      {/* controls */}
      <div className="card px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <button className="btn btn-ghost px-3" onClick={restart} title="Restart">
            ⏮
          </button>
          <button className="btn btn-ghost px-3" onClick={() => seek(step - 1)} title="Back">
            ◀
          </button>
          <button className="btn btn-primary px-4 min-w-[52px]" onClick={togglePlay}>
            {step >= total ? "↻" : playing ? "⏸" : "▶"}
          </button>
          <button className="btn btn-ghost px-3" onClick={() => seek(step + 1)} title="Forward">
            ▶
          </button>
        </div>

        <input
          type="range"
          min={0}
          max={total}
          value={step}
          onChange={(e) => seek(Number(e.target.value))}
          className="flex-1 min-w-[140px] accent-[var(--gold)] cursor-pointer"
        />
        <span className="text-xs text-[var(--muted)] tabular-nums w-[64px] text-right">
          {step} / {total}
        </span>

        <button
          className="btn btn-ghost px-3"
          onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
          title="Playback speed"
        >
          {speed}×
        </button>
        <button
          className={cn("btn btn-ghost px-3", godView && "!text-[var(--gold)]")}
          onClick={() => setGodView((g) => !g)}
          title="Reveal all roles"
        >
          {godView ? "👁 Roles shown" : "🙈 Hide roles"}
        </button>
      </div>

      {/* reveal panel after the game */}
      {state.finished && (
        <div className="card p-5">
          <div className="display text-xl mb-3">The reveal</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
            {transcript.outcomes.map((o) => {
              const player = transcript.players[o.seatId];
              const meta = ROLE_META[o.role];
              return (
                <div
                  key={o.seatId}
                  className={cn(
                    "rounded-xl border px-3 py-2.5 flex items-center gap-2.5",
                    o.won
                      ? "border-[color-mix(in_srgb,var(--good)_40%,transparent)] bg-[color-mix(in_srgb,var(--good)_8%,transparent)]"
                      : "border-[var(--border)] bg-[var(--panel-2)]"
                  )}
                >
                  <span className="text-2xl">{player.avatar}</span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{player.name}</div>
                    <div className="text-[11px] text-[var(--muted)] truncate">
                      {meta.emoji} {meta.label} · {modelLabel(o.model)}
                    </div>
                  </div>
                  <span className={cn("ml-auto text-[11px] font-bold", o.won ? "text-[var(--good)]" : "text-[var(--muted)]")}>
                    {o.won ? "WON" : "LOST"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
