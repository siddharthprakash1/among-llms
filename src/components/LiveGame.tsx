"use client";

// Live viewer: subscribes to the game's SSE stream, accumulates events, and
// renders the same table + feed as the replay — auto-following the live edge.
// When the game ends it offers the full (scrubbable, 3D) replay.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { GameConfig, GameEvent, Player, Transcript } from "@/lib/engine/types";
import { deriveState } from "@/lib/replay";
import { playCue } from "@/lib/sound";
import { modelLabel } from "@/lib/ui";
import GameTable from "./GameTable";
import EventFeed from "./EventFeed";

interface Meta {
  id: string;
  createdAt: string;
  config: GameConfig;
  players: Player[];
  status: string;
}

export default function LiveGame({ id }: { id: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [done, setDone] = useState(false);
  const seenCue = useRef(-1);

  useEffect(() => {
    const es = new EventSource(`/api/games/${id}/stream`);
    es.addEventListener("meta", (e) => {
      try {
        setMeta(JSON.parse((e as MessageEvent).data));
      } catch {
        /* ignore */
      }
    });
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as GameEvent;
        setEvents((cur) => [...cur, ev]);
        if (ev.kind === "game_over") {
          setDone(true);
          es.close();
        }
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [id]);

  const transcript = useMemo<Transcript | null>(() => {
    if (!meta) return null;
    return {
      id: meta.id,
      createdAt: meta.createdAt,
      config: meta.config,
      players: meta.players,
      events,
      result: { winner: "good", reason: "", survivorIds: [], days: 0 },
      outcomes: [],
    } as Transcript;
  }, [meta, events]);

  const state = useMemo(
    () => (transcript ? deriveState(transcript, events.length - 1, { revealPrivate: done }) : null),
    [transcript, events.length, done]
  );

  // ambience phase + a sound cue for the freshest live event
  useEffect(() => {
    if (!state) return;
    const p = state.phase;
    document.documentElement.dataset.phase = p === "day" ? "day" : p === "over" ? "over" : "night";
  }, [state?.phase]);
  useEffect(() => {
    return () => {
      document.documentElement.dataset.phase = "night";
    };
  }, []);
  useEffect(() => {
    const i = events.length - 1;
    if (i > seenCue.current) {
      seenCue.current = i;
      const ev = events[i];
      if (ev?.kind === "death") playCue(ev.cause === "vote" ? "gavel" : "kill");
      else if (ev?.kind === "phase") playCue(ev.phase === "night" ? "night" : "day");
      else if (ev?.kind === "game_over")
        playCue(ev.winner === "good" ? "win_village" : ev.winner === "evil" ? "win_wolves" : "win_jester");
    }
  }, [events]);

  if (!state || !meta) {
    return (
      <div className="glass p-12 text-center text-[var(--muted)]">Connecting to the table…</div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display text-3xl sm:text-4xl flex items-center gap-3">
            Live match <span className="text-[var(--muted)]">#{id.slice(0, 6)}</span>
            {!done && (
              <span className="chip tag-evil" style={{ animation: "twinkle 1.2s ease-in-out infinite" }}>
                ● LIVE
              </span>
            )}
          </h1>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {Array.from(new Set(meta.players.map((p) => p.model))).map((m) => (
              <span key={m} className="chip tag-gold">
                {modelLabel(m)}
              </span>
            ))}
            <span className="chip">{meta.config.numPlayers} players</span>
          </div>
        </div>
        {done && (
          <Link href={`/game/${id}`} className="btn btn-primary" prefetch={false}>
            ↻ Watch full replay
          </Link>
        )}
      </div>

      {state.finished && state.winner && (
        <div className="glass px-5 py-4">
          <div className="display text-2xl">
            {state.winner === "good"
              ? "🏡 The Village prevails"
              : state.winner === "evil"
              ? "🐺 The Werewolves win"
              : "🃏 The Jester wins alone"}
          </div>
          <div className="text-sm text-[var(--muted)]">{state.reason}</div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
        <div className="glass p-4 sm:p-6">
          <GameTable
            seats={state.seats}
            highlight={state.highlight}
            banner={state.banner}
            phase={state.phase}
            day={state.day}
            showRole={done}
          />
        </div>
        <div className="h-[460px] lg:h-auto lg:min-h-[520px]">
          <EventFeed log={state.log} seats={state.seats} />
        </div>
      </div>

      {!done && (
        <div className="text-center text-xs text-[var(--muted)]">
          Streaming live · {events.length} events · the models are thinking in real time…
        </div>
      )}
    </div>
  );
}
