"use client";

// Play screen for the human seat. Everything shown here comes from the per-seat
// stream, which carries only what this seat's role may know; the table and feed
// are the same components the spectator views use.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { seatKnowledge, seatTranscript } from "@/lib/human/clientState";
import type { SeatEvent, SeatMeta, SeatStatus } from "@/lib/human/types";
import { deriveState } from "@/lib/replay";
import { playCue } from "@/lib/sound";
import { adminHeaders, plural, roleNoun } from "@/lib/ui";
import ActionDock from "./ActionDock";
import EventFeed from "./EventFeed";
import GameTable from "./GameTable";
import type { SeatMark } from "./PlayerSeat";
import RoleCard from "./RoleCard";

type Gate = "ok" | "denied" | "lost";

const MAX_PROBE_RETRIES = 5;
const TOAST_MS = 4500;

// Tailwind's lg breakpoint: from here up the dock sits in the page under the
// table; below it, the dock is pinned over the bottom of the screen.
const WIDE_QUERY = "(min-width: 64rem)";

function subscribeWide(onChange: () => void) {
  const mql = window.matchMedia(WIDE_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
const isWide = () => window.matchMedia(WIDE_QUERY).matches;
const isWideOnServer = () => false;

export default function PlayGame({ id }: { id: string }) {
  const router = useRouter();
  const [meta, setMeta] = useState<SeatMeta | null>(null);
  const [items, setItems] = useState<(SeatEvent | undefined)[]>([]);
  const [status, setStatus] = useState<SeatStatus | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [gate, setGate] = useState<Gate>("ok");
  const [toast, setToast] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const seenCue = useRef(-1);
  const cuedPrompt = useRef<string | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(0);
  const revealedPrompt = useRef<string | null>(null);
  const wide = useSyncExternalStore(subscribeWide, isWide, isWideOnServer);

  useEffect(() => {
    let cancelled = false;
    let over = false;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // undefined until the first `seat` event: a timeout that happened before this
    // page load is old news and must not raise the toast.
    let lastTimeoutId: string | null | undefined;

    const closeStream = () => {
      esRef.current?.close();
      esRef.current = null;
    };
    const retry = () => {
      if (cancelled) return;
      if (retries++ >= MAX_PROBE_RETRIES) {
        setGate("lost");
        return;
      }
      retryTimer = setTimeout(() => void connect(), 1500);
    };

    // EventSource hides status codes, so the seat is probed with a plain fetch
    // first. Every await is followed by a cancelled check: strict mode runs this
    // effect twice, and a second stream must never be left open.
    async function connect() {
      let res: Response;
      try {
        res = await fetch(`/api/games/${id}/seat`, { cache: "no-store" });
      } catch {
        retry();
        return;
      }
      if (cancelled) return;
      if (res.status === 401) {
        setGate("denied");
        return;
      }
      if (res.status === 404) {
        let persisted = false;
        try {
          persisted = (await fetch(`/api/games/${id}`, { cache: "no-store" })).ok;
        } catch {
          /* treated as not persisted */
        }
        if (cancelled) return;
        if (persisted) router.replace(`/game/${id}`);
        else setGate("lost");
        return;
      }
      if (!res.ok) {
        retry();
        return;
      }

      closeStream();
      const es = new EventSource(`/api/games/${id}/seat/stream`);
      esRef.current = es;

      es.addEventListener("meta", (e) => {
        try {
          const m = JSON.parse((e as MessageEvent).data) as SeatMeta;
          retries = 0;
          setMeta(m);
          if (m.status === "abandoned") {
            over = true;
            closeStream();
            setGate("lost");
          }
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("seat", (e) => {
        try {
          const st = JSON.parse((e as MessageEvent).data) as SeatStatus;
          setStatus(st);
          setDeadline(st.remainingMs === null ? null : performance.now() + st.remainingMs);
          const timedOut = st.lastResolved?.outcome === "timeout" ? st.lastResolved.id : null;
          if (lastTimeoutId !== undefined && timedOut !== null && timedOut !== lastTimeoutId) {
            setToast("Time's up — your instincts took over.");
          }
          lastTimeoutId = timedOut;
        } catch {
          /* ignore */
        }
      });
      es.onmessage = (e) => {
        try {
          const seq = Number(e.lastEventId);
          if (e.lastEventId === "" || !Number.isInteger(seq) || seq < 0) return;
          const ev = JSON.parse(e.data) as SeatEvent;
          // Placed by sequence, so a reconnect that replays events changes nothing.
          setItems((cur) => {
            if (cur[seq] !== undefined) return cur;
            const next = cur.slice();
            next[seq] = ev;
            return next;
          });
          if (ev.kind === "game_over") {
            over = true;
            closeStream();
          }
        } catch {
          /* ignore */
        }
      };
      es.onerror = () => {
        // CONNECTING means the browser is already retrying by itself (with
        // Last-Event-ID). CLOSED means the server refused: find out why.
        if (cancelled || over || es.readyState !== EventSource.CLOSED) return;
        if (esRef.current === es) esRef.current = null;
        retry();
      };
    }

    void connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      closeStream();
    };
  }, [id, router]);

  // Events received without a gap. A prompt is shown only once everything that
  // was said before it has arrived.
  const received = useMemo(() => {
    let n = 0;
    while (n < items.length && items[n] !== undefined) n++;
    return n;
  }, [items]);

  const view = useMemo(() => {
    if (!meta || items[0] === undefined) return null;
    const { transcript, knownIds, empty } = seatTranscript(meta, items);
    if (empty) return null;
    const state = deriveState(transcript, transcript.events.length - 1, { revealPrivate: true });
    const seats = state.seats.map((s) => ({ ...s, revealed: s.revealed || knownIds.has(s.id) }));
    return { state, seats, knowledge: seatKnowledge(meta, items) };
  }, [meta, items]);

  const ghost = useMemo(
    () => items.slice(0, received).some((e) => e?.kind === "seat_reveal" && !e.final),
    [items, received]
  );

  const done = view?.state.finished ?? false;
  const prompt =
    !done && status?.prompt && status.prompt.afterSeq <= received ? status.prompt : null;
  const promptId = prompt?.id ?? null;
  const phase = view?.state.phase;

  useEffect(() => {
    setSelectedId(null);
  }, [promptId]);

  useEffect(() => {
    if (!phase) return;
    document.documentElement.dataset.phase = phase === "day" ? "day" : phase === "over" ? "over" : "night";
  }, [phase]);
  useEffect(() => {
    return () => {
      document.documentElement.dataset.phase = "night";
    };
  }, []);

  useEffect(() => {
    const i = received - 1;
    if (i <= seenCue.current) return;
    seenCue.current = i;
    const ev = items[i];
    if (ev?.kind === "death") playCue(ev.cause === "vote" ? "gavel" : "kill");
    else if (ev?.kind === "phase") playCue(ev.phase === "night" ? "night" : "day");
    else if (ev?.kind === "game_over")
      playCue(ev.winner === "good" ? "win_village" : ev.winner === "evil" ? "win_wolves" : "win_jester");
  }, [items, received]);

  useEffect(() => {
    if (promptId === null) return;
    if (cuedPrompt.current !== promptId) {
      cuedPrompt.current = promptId;
      playCue("vote");
    }
    const base = document.title;
    document.title = `⏳ Your turn · ${base}`;
    return () => {
      document.title = base;
    };
  }, [promptId]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  // Below lg the dock is pinned over the bottom of the screen, so the feed has to
  // know how much of the viewport it covers to keep its newest line readable.
  const dockReady = Boolean(meta && view);
  useEffect(() => {
    const el = dockRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setDockHeight(Math.round(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [dockReady]);

  // From lg up the dock sits under the table, often below the fold, so each new
  // prompt is scrolled into view once, when its form appears, and never for feed
  // events. Below lg the pinned dock is always on screen.
  const revealPrompt = useCallback((pid: string) => {
    if (revealedPrompt.current === pid) return;
    revealedPrompt.current = pid;
    if (!isWide()) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    dockRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
  }, []);

  const select = useCallback((sid: number | null) => setSelectedId(sid), []);
  const toggleSeat = useCallback((sid: number) => setSelectedId((cur) => (cur === sid ? null : sid)), []);

  const resume = async () => {
    setResuming(true);
    setResumeError(null);
    try {
      const res = await fetch(`/api/games/${id}/seat/act`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ resume: true }),
      });
      if (!res.ok) {
        // The banner stays up, so say why (the flood limit answers 429 here).
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setResumeError(data?.error ?? "Couldn't take back control. Try again.");
      }
    } catch {
      setResumeError("Couldn't reach the table. Try again.");
    }
    setResuming(false);
  };

  if (gate === "denied") {
    return (
      <div className="glass p-12 text-center space-y-3">
        <div className="text-4xl">🎭</div>
        <div className="display text-2xl">This seat belongs to another browser.</div>
        <div className="text-sm text-[var(--muted)]">
          Only the browser that took the seat can play it. Spectating opens when the game ends.
        </div>
        <Link href="/" className="btn btn-primary">
          Back to the arena
        </Link>
      </div>
    );
  }
  if (gate === "lost") {
    return (
      <div className="glass p-12 text-center space-y-3">
        <div className="text-4xl">🕯️</div>
        <div className="display text-2xl">The table was lost.</div>
        <div className="text-sm text-[var(--muted)]">
          Games in progress don&apos;t survive a server restart.
        </div>
        <Link href="/" className="btn btn-primary">
          Back to the arena
        </Link>
      </div>
    );
  }
  if (!meta || !view) {
    return <div className="glass p-12 text-center text-[var(--muted)]">Connecting to the table…</div>;
  }

  const { state, seats, knowledge } = view;
  const you = meta.you;
  const alive = seats.find((s) => s.id === you.seatId)?.alive ?? true;
  const won = state.winner ? (you.role === "jester" ? state.winner === "jester" : state.winner === you.alignment) : false;

  // A seat whose role badge is already showing needs no second badge.
  const marks: Record<number, SeatMark> = {};
  if (!done) {
    const shown = (sid: number) => seats.find((s) => s.id === sid)?.revealed;
    for (const sid of meta.packmates) if (!shown(sid)) marks[sid] = { emoji: "🐺", label: "Your packmate" };
    for (const v of knowledge.visions) {
      if (shown(v.targetId)) continue;
      marks[v.targetId] =
        v.alignment === "evil"
          ? { emoji: "🐺", label: "Your vision: a werewolf" }
          : { emoji: "✓", label: "Your vision: innocent" };
    }
  }

  const picking =
    prompt && prompt.legalTargets.length > 0 && (prompt.kind !== "witch" || prompt.potions?.poison);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="display text-3xl sm:text-4xl flex items-center gap-3">
            Your table <span className="text-[var(--muted)]">#{id.slice(0, 6)}</span>
            {!done && (
              <span className="chip tag-evil" style={{ animation: "twinkle 1.2s ease-in-out infinite" }}>
                ● LIVE
              </span>
            )}
          </h1>
          <div className="flex flex-wrap gap-1.5 mt-2">
            <span className="chip tag-gold">
              🎭 You are {you.avatar} {you.name}
            </span>
            {ghost && !done && <span className="chip tag-mind">👻 Ghost</span>}
            <span className="chip">{plural(meta.numPlayers, "player")}</span>
            <span className="chip">unrated</span>
          </div>
        </div>
        {done && (
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/game/${id}`} className="btn btn-primary whitespace-nowrap" prefetch={false}>
              ↻ Watch full replay
            </Link>
            <Link href="/" className="btn btn-ghost whitespace-nowrap">
              Play again
            </Link>
          </div>
        )}
      </div>

      {status?.autopilot && !done && (
        <div className="glass px-5 py-3 flex flex-wrap items-center justify-between gap-3 !border-[color-mix(in_srgb,var(--gold)_45%,transparent)]">
          <div className="text-sm">
            <span className="text-[var(--gold)] font-semibold">🤖 Autopilot is playing for you.</span>{" "}
            <span className="text-[var(--muted)]">You missed two turns in a row.</span>
            {resumeError && (
              <div role="alert" className="text-[var(--blood)] mt-1">
                {resumeError}
              </div>
            )}
          </div>
          <button className="btn btn-primary py-2" onClick={resume} disabled={resuming}>
            Take back control
          </button>
        </div>
      )}

      {state.finished && state.winner && (
        <div className="glass px-5 py-4 float-in">
          <div className="display text-2xl">
            {state.winner === "good"
              ? "🏡 The Village prevails"
              : state.winner === "evil"
              ? "🐺 The Werewolves win"
              : "🃏 The Jester wins alone"}
          </div>
          <div className="text-sm text-[var(--muted)]">{state.reason}</div>
          <div className={`text-sm font-semibold mt-1.5 ${won ? "text-[var(--gold)]" : "text-[var(--blood)]"}`}>
            {won ? "You won" : "You lost"} as {roleNoun(you.role)}.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">
        <div className="glass p-4 sm:p-6">
          <GameTable
            seats={seats}
            highlight={state.highlight}
            banner={state.banner}
            phase={state.phase}
            day={state.day}
            showRole={false}
            youId={you.seatId}
            marks={marks}
            selectableIds={picking ? prompt.legalTargets : undefined}
            selectedId={picking ? selectedId : null}
            onSelect={toggleSeat}
          />
        </div>
        {/* As tall as the table (520 + padding), no taller: the dock starts right under it, so
            revealing a prompt scrolls little and the top seat stays clear of the header. */}
        <div className="lg:relative lg:min-h-[570px]">
          <div className="flex flex-col gap-5 lg:absolute lg:inset-0">
            <div className="shrink-0">
              <RoleCard meta={meta} knowledge={knowledge} seats={seats} />
            </div>
            <div className="h-[420px] lg:h-auto lg:flex-1 lg:min-h-0">
              <EventFeed
                log={state.log}
                seats={seats}
                youId={you.seatId}
                endClearance={!wide && dockHeight > 0 ? dockHeight + 24 : 0}
              />
            </div>
          </div>
        </div>
      </div>

      <div ref={dockRef} className="sticky bottom-3 z-20 lg:static scroll-mt-20 scroll-mb-3">
        <ActionDock
          gameId={id}
          prompt={prompt}
          deadline={deadline}
          seats={seats}
          you={you}
          alive={alive}
          finished={done}
          selectedId={selectedId}
          onSelect={select}
          lastBanner={state.banner}
          ghost={ghost}
          onPromptShown={revealPrompt}
        />
      </div>

      <AnimatePresence>
        {toast && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed left-1/2 -translate-x-1/2 top-20 z-40 glass px-4 py-2.5 text-sm text-[var(--gold)] !border-[color-mix(in_srgb,var(--gold)_45%,transparent)] shadow-xl"
          >
            ⏳ {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
