"use client";

// Live viewer: subscribes to the game's SSE stream, accumulates events, and
// renders the same table + feed as the replay — auto-following the live edge.
// When the game ends it offers the full (scrubbable, 3D) replay.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DecisionRecord, GameConfig, GameEvent, Player, Transcript } from "@/lib/engine/types";
import { deriveState } from "@/lib/replay";
import { playCue } from "@/lib/sound";
import { decisionShortcut, inspect, thinkingSeat } from "@/lib/inspector";
import { cn, modelLabel, plural } from "@/lib/ui";
import GameTable from "./GameTable";
import EventFeed from "./EventFeed";
import MindInspector, { useRevealOnOpen } from "./MindInspector";

interface Meta {
  id: string;
  createdAt: string;
  config: GameConfig;
  players: Player[];
  status: string;
  /** A running game with a human seat: the stream sends nothing but this meta. */
  sealed?: boolean;
}

export default function LiveGame({ id }: { id: string }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [done, setDone] = useState(false);
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [minds, setMinds] = useState(false);
  // null = the inspector follows the live edge
  const [pinnedSeq, setPinnedSeq] = useState<number | null>(null);
  const [notFound, setNotFound] = useState(false);
  // "error": the game stopped in a server that is still up. "restart": the
  // server no longer knows a game this viewer had already been shown.
  const [interrupted, setInterrupted] = useState<"error" | "restart" | null>(null);
  // The id whose meta this viewer has seen. Outlives the stream re-opens the
  // sealed card triggers, so a restart is not mistaken for a wrong link.
  const sawMetaFor = useRef<string | null>(null);
  const [sealed, setSealed] = useState(false);
  // Bumped to re-open the stream while the sealed card is up.
  const [retry, setRetry] = useState(0);
  const [ownsSeat, setOwnsSeat] = useState(false);
  const router = useRouter();
  const seenCue = useRef(-1);
  const inspectorRef = useRevealOnOpen(minds);
  const mindsBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const es = new EventSource(`/api/games/${id}/stream`);
    let gotMeta = false;
    // If no meta arrives quickly, the game doesn't exist (or already scrolled
    // out of the live registry) — show a not-found state instead of spinning.
    const timeout = setTimeout(() => {
      if (!gotMeta) {
        setSealed(false);
        setNotFound(true);
        es.close();
      }
    }, 5000);
    es.addEventListener("meta", (e) => {
      gotMeta = true;
      sawMetaFor.current = id;
      try {
        const m = JSON.parse((e as MessageEvent).data) as Meta;
        if (m.sealed) {
          // The server closes a sealed stream right after this; closing here
          // stops the browser from reconnecting in a loop.
          clearTimeout(timeout);
          es.close();
          setSealed(true);
          return;
        }
        setSealed(false);
        setMeta(m);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener("decision", (e) => {
      try {
        const rec = JSON.parse((e as MessageEvent).data) as DecisionRecord;
        setDecisions((cur) => (cur.some((d) => d.seq === rec.seq) ? cur : [...cur, rec]));
      } catch {
        /* ignore */
      }
    });
    // Terminal frame: without it the browser would reconnect forever to a game
    // that no longer exists after a server restart.
    es.addEventListener("end", (e) => {
      clearTimeout(timeout);
      es.close();
      let reason = "";
      try {
        reason = (JSON.parse((e as MessageEvent).data) as { reason?: string }).reason ?? "";
      } catch {
        /* treated as interrupted */
      }
      setSealed(false);
      if (reason !== "not_found") setInterrupted("error");
      else if (sawMetaFor.current === id) setInterrupted("restart");
      else setNotFound(true);
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
    return () => {
      clearTimeout(timeout);
      es.close();
    };
  }, [id, retry]);

  // Once the human game is persisted the page itself can render the replay. If
  // it ended without being saved (a failed write, an abandoned game) the stream
  // is no longer sealed, so it is re-opened: still sealed means the card stays.
  useEffect(() => {
    if (!sealed) return;
    let cancelled = false;
    const poll = setInterval(async () => {
      // Asking for the transcript of a game that is still being played is a 404
      // every time, which fills the console; the live list answers 200.
      try {
        const res = await fetch("/api/games/live", { cache: "no-store" });
        const body = (await res.json()) as { games?: { id: string }[] };
        if (cancelled || body.games?.some((g) => g.id === id)) return;
      } catch {
        /* fall through to the transcript check */
      }
      let persisted = false;
      try {
        persisted = (await fetch(`/api/games/${id}`, { cache: "no-store" })).ok;
      } catch {
        /* treated as not persisted */
      }
      if (cancelled) return;
      if (persisted) router.refresh();
      else setRetry((n) => n + 1);
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [sealed, id, router]);

  // Only the browser holding the seat cookie is offered the way back to it.
  useEffect(() => {
    if (!sealed) return;
    let cancelled = false;
    fetch(`/api/games/${id}/seat`, { cache: "no-store" })
      .then((res) => {
        if (!cancelled) setOwnsSeat(res.ok);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sealed, id]);

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
    () => (transcript ? deriveState(transcript, events.length - 1, { revealPrivate: done || minds }) : null),
    [transcript, events.length, done, minds]
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

  const pinned = pinnedSeq !== null ? decisions.find((d) => d.seq === pinnedSeq) : undefined;
  const model = pinned
    ? inspect(decisions, pinned.step, pinned.seq)
    : inspect(decisions, events.length - 1, null);
  const prevDecision = model.prev;
  const nextDecision = model.next;
  useEffect(() => {
    if (!minds) return;
    const onKey = (e: KeyboardEvent) => {
      const dir = decisionShortcut(e);
      if (dir === "prev" && prevDecision) setPinnedSeq(prevDecision.seq);
      else if (dir === "next" && nextDecision) setPinnedSeq(nextDecision.seq);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [minds, prevDecision, nextDecision]);

  if (sealed) {
    return (
      <div className="glass p-12 text-center space-y-3">
        <div className="text-4xl">🎭</div>
        <div className="display text-2xl">A human is playing this table.</div>
        <div className="text-sm text-[var(--muted)]">
          Spectating opens when the game ends. This page will open by itself.
        </div>
        {ownsSeat ? (
          <Link href={`/play/${id}`} className="btn btn-primary" prefetch={false}>
            Return to your seat
          </Link>
        ) : (
          <Link href="/" className="btn btn-primary">
            Back to the arena
          </Link>
        )}
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="glass p-12 text-center space-y-3">
        <div className="display text-2xl">Game not found</div>
        <div className="text-sm text-[var(--muted)]">
          This match doesn&apos;t exist or has already scrolled out of the live buffer.
        </div>
        <Link href="/" className="btn btn-primary">
          Back to the arena
        </Link>
      </div>
    );
  }

  if (interrupted) {
    return (
      <div className="glass p-12 text-center space-y-3">
        <div className="display text-2xl">Match interrupted</div>
        <div className="text-sm text-[var(--muted)]">
          {interrupted === "restart"
            ? "The server restarted mid-game, so this match wasn't finished or rated."
            : "This match hit an error and stopped, so it wasn't finished or rated."}
        </div>
        <Link href="/" className="btn btn-primary">
          Back to the arena
        </Link>
      </div>
    );
  }

  if (!state || !meta) {
    return (
      <div className="glass p-12 text-center text-[var(--muted)]">Connecting to the table…</div>
    );
  }

  const thinkingId = thinkingSeat(model, minds && !pinned);
  const canInspect = decisions.length > 0;

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
            <span className="chip">{plural(meta.config.numPlayers, "player")}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            ref={mindsBtnRef}
            className={cn("btn btn-ghost whitespace-nowrap", minds && "!text-[var(--mind)]")}
            onClick={() => setMinds((m) => !m)}
            disabled={!canInspect}
            aria-pressed={minds}
            title={
              canInspect
                ? "Show each player's private reasoning (spoilers: reveals all roles)"
                : done
                ? "Recorded before reasoning capture"
                : "No decisions recorded yet"
            }
          >
            🧠 Minds<span className="hidden sm:inline">&nbsp;(spoilers)</span>
          </button>
          {done && (
            <Link href={`/game/${id}`} className="btn btn-primary whitespace-nowrap" prefetch={false}>
              ↻ Watch full replay
            </Link>
          )}
        </div>
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
            showRole={done || minds}
            thinkingId={thinkingId}
          />
        </div>
        <div className="lg:relative lg:min-h-[520px]">
          <div className="flex flex-col gap-5 lg:absolute lg:inset-0">
            {minds && (
              <div ref={inspectorRef} className="shrink-0 h-[400px] lg:h-[68%] flex scroll-mt-20">
                <MindInspector
                  model={model}
                  players={meta.players}
                  event={model.current ? events[model.current.step] : undefined}
                  onJump={(rec) => setPinnedSeq(rec.seq)}
                  onClose={() => {
                    setMinds(false);
                    mindsBtnRef.current?.focus();
                  }}
                  live={{ following: pinnedSeq === null, onFollow: () => setPinnedSeq(null), done }}
                />
              </div>
            )}
            <div className="h-[460px] lg:h-auto lg:flex-1 lg:min-h-0">
              <EventFeed log={state.log} seats={state.seats} />
            </div>
          </div>
        </div>
      </div>

      {!done && (
        <div className="text-center text-xs text-[var(--muted)]">
          Streaming live · {plural(events.length, "event")} · the models are thinking in real time…
        </div>
      )}
    </div>
  );
}
