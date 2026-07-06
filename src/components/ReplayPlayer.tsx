"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Transcript } from "@/lib/engine/types";
import { deriveState, stepDelay, totalSteps } from "@/lib/replay";
import { ROLE_META, cn, modelLabel } from "@/lib/ui";
import { playCue, SoundCue } from "@/lib/sound";
import { GameEvent } from "@/lib/engine/types";
import dynamic from "next/dynamic";
import GameTable from "./GameTable";
import EventFeed from "./EventFeed";

// The 3D stage is heavy and WebGL-only, so load it lazily on the client.
const Scene3D = dynamic(() => import("./Scene3D"), {
  ssr: false,
  loading: () => (
    <div className="grid place-items-center h-full min-h-[440px] text-[var(--muted)] text-sm">
      Summoning the village…
    </div>
  ),
});

const SPEEDS = [1, 2, 4] as const;

function cueFor(ev: GameEvent): SoundCue | null {
  switch (ev.kind) {
    case "phase":
      return ev.phase === "night" ? "night" : "day";
    case "seer_check":
      return "seer";
    case "saved":
      return "save";
    case "accusation":
      return "accuse";
    case "vote":
      return "vote";
    case "hunter_shot":
      return "kill";
    case "death":
      return ev.cause === "vote" ? "gavel" : "kill";
    case "game_over":
      return ev.winner === "good" ? "win_village" : ev.winner === "evil" ? "win_wolves" : "win_jester";
    default:
      return null;
  }
}

export default function ReplayPlayer({ transcript }: { transcript: Transcript }) {
  const total = totalSteps(transcript);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [godView, setGodView] = useState(false);
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"classic" | "cinema">("classic");
  const [can3d, setCan3d] = useState(false);

  const state = useMemo(
    () => deriveState(transcript, step, { revealPrivate: godView || step >= total }),
    [transcript, step, godView, total]
  );

  useEffect(() => {
    if (!playing) return;
    if (step >= total) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => Math.min(s + 1, total)), stepDelay(transcript, step, speed));
    return () => clearTimeout(t);
  }, [playing, step, speed, total, transcript]);

  // Drive the cinematic scene palette (moonlit night / lantern day) from the
  // current phase, and fire a synthesized sound cue for the current event.
  useEffect(() => {
    const p = state.phase;
    document.documentElement.dataset.phase = p === "day" ? "day" : p === "over" ? "over" : "night";
  }, [state.phase]);

  useEffect(() => {
    return () => {
      document.documentElement.dataset.phase = "night";
    };
  }, []);

  useEffect(() => {
    const ev = transcript.events[step];
    if (ev) {
      const cue = cueFor(ev);
      if (cue) playCue(cue);
    }
  }, [step, transcript]);

  // Prefer the 3D cinematic stage when WebGL is available and motion is allowed;
  // otherwise fall back to the Classic 2D table.
  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const ok = !!gl && !reduced;
      setCan3d(ok);
      if (ok) setView("cinema");
    } catch {
      setCan3d(false);
    }
  }, []);

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
              : state.winner === "evil"
              ? "!border-[color-mix(in_srgb,var(--evil)_55%,transparent)]"
              : "!border-[color-mix(in_srgb,var(--gold)_55%,transparent)]"
          )}
        >
          <div>
            <div className="display text-2xl">
              {state.winner === "good"
                ? "🏡 The Village prevails"
                : state.winner === "evil"
                ? "🐺 The Werewolves win"
                : "🃏 The Jester wins alone"}
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
        <div className="glass overflow-hidden relative min-h-[440px] lg:min-h-[560px]">
          {view === "cinema" && can3d ? (
            <>
              <Scene3D
                seats={state.seats}
                highlight={state.highlight}
                phase={state.phase}
                finished={state.finished}
                showRole={godView || state.finished}
                playing={playing}
              />
              {state.banner && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 text-center pointer-events-none px-4">
                  <div className="display text-2xl text-[var(--text)] drop-shadow-lg">
                    {state.banner.label}
                  </div>
                  {state.banner.sublabel && (
                    <div className="text-[11px] text-[var(--muted)]">{state.banner.sublabel}</div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="p-4 sm:p-6">
              <GameTable
                seats={state.seats}
                highlight={state.highlight}
                banner={state.banner}
                phase={state.phase}
                day={state.day}
                showRole={godView || state.finished}
              />
            </div>
          )}
        </div>
        <div className="h-[460px] lg:h-auto lg:min-h-[560px]">
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
        {can3d && (
          <button
            className={cn("btn btn-ghost px-3", view === "cinema" && "!text-[var(--gold)]")}
            onClick={() => setView((v) => (v === "cinema" ? "classic" : "cinema"))}
            title="Toggle the 3D cinematic stage"
          >
            {view === "cinema" ? "🎬 Cinematic" : "🎞 Classic"}
          </button>
        )}
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
