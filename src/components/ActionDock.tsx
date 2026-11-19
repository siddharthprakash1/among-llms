"use client";

// The human seat's controls: one form per pending prompt, with the countdown
// the server is running for it. Target selection is shared with the table
// through selectedId / onSelect, so a seat can be picked in either place.

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { PromptKind, SeatAnswer, SeatMeta, SeatPrompt } from "@/lib/human/types";
import { seerClaimText } from "@/lib/human/sanitize";
import { textKeyAction } from "@/lib/human/clientState";
import type { ReplaySeat, ReplayState } from "@/lib/replay";
import { adminHeaders, cn, plural, roleNoun } from "@/lib/ui";

interface Props {
  gameId: string;
  prompt: SeatPrompt | null;
  deadline: number | null;
  seats: ReplaySeat[];
  you: SeatMeta["you"];
  alive: boolean;
  finished: boolean;
  selectedId: number | null;
  onSelect(id: number | null): void;
  lastBanner: ReplayState["banner"];
  ghost?: boolean;
  /** Called with a prompt's id once its form is in the DOM, i.e. after the previous view has animated out. */
  onPromptShown?(promptId: string): void;
}

const CONFIRM_VERB: Partial<Record<PromptKind, string>> = {
  night_kill: "Kill",
  night_check: "Investigate",
  night_protect: "Protect",
  hunter_shot: "Shoot",
  vote: "Vote for",
};

export default function ActionDock({
  gameId,
  prompt,
  deadline,
  seats,
  you,
  alive,
  finished,
  selectedId,
  onSelect,
  lastBanner,
  ghost,
  onPromptShown,
}: Props) {
  const reduce = useReducedMotion();
  // What happened to the prompt on this side, until the next `seat` event replaces it.
  const [settled, setSettled] = useState<{ id: string; how: "sent" | "stale" } | null>(null);

  if (finished) return null;

  const mine = prompt && settled?.id === prompt.id ? settled.how : null;
  const open = prompt && !mine ? prompt : null;
  const view = open ? `prompt-${open.id}` : mine === "sent" ? "sent" : !alive ? "dead" : "idle";

  return (
    <div className={cn("dock", open?.kind === "hunter_shot" && "dock-blood")} aria-live="polite">
      {/* Clipped: the slide-in offset would otherwise flash a scrollbar on the dock. */}
      <div className="overflow-clip">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            initial={{ opacity: 0, y: reduce ? 0 : 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : -6 }}
            transition={{ duration: 0.2 }}
            className="px-4 py-3.5 sm:px-5 sm:py-4"
          >
            {open ? (
              <PromptForm
                gameId={gameId}
                prompt={open}
                deadline={deadline}
                seats={seats}
                selectedId={selectedId}
                onSelect={onSelect}
                onShown={onPromptShown}
                onSettled={(how) => {
                  setSettled({ id: open.id, how });
                  onSelect(null);
                }}
              />
            ) : mine === "sent" ? (
              <div className="text-center text-sm text-[var(--good)] font-medium py-1">Sent ✓</div>
            ) : !alive ? (
              <div className="text-center py-1">
                <div className="text-sm text-[var(--blood)] font-medium">
                  ☠ You are dead. You were {roleNoun(you.role)}.
                </div>
                {ghost && (
                  <div className="text-xs text-[var(--muted)] mt-1">👻 You now see everything.</div>
                )}
              </div>
            ) : (
              <div className="dock-idle text-center text-sm text-[var(--muted)] py-1">
                {lastBanner?.phase === "day" ? "The table is talking…" : "🌙 The village sleeps…"}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function readDraft(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, text: string) {
  try {
    if (text) window.sessionStorage.setItem(key, text);
    else window.sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable (private mode): drafts are a nicety */
  }
}

interface FormProps {
  gameId: string;
  prompt: SeatPrompt;
  deadline: number | null;
  seats: ReplaySeat[];
  selectedId: number | null;
  onSelect(id: number | null): void;
  onSettled(how: "sent" | "stale"): void;
  onShown?(promptId: string): void;
}

function PromptForm({
  gameId,
  prompt,
  deadline,
  seats,
  selectedId,
  onSelect,
  onSettled,
  onShown,
}: FormProps) {
  const draftKey = `al_draft_${gameId}_${prompt.id}`;
  const [text, setText] = useState(() => readDraft(draftKey));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [poisoning, setPoisoning] = useState(false);
  const [claimId, setClaimId] = useState<number | null>(null);

  useEffect(() => {
    writeDraft(draftKey, text);
  }, [draftKey, text]);

  useEffect(() => {
    onShown?.(prompt.id);
  }, [onShown, prompt.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onSelect(null);
      setPoisoning(false);
      setClaimId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect]);

  const nameOf = (id: number | null | undefined) =>
    id === null || id === undefined ? "" : seats.find((s) => s.id === id)?.name ?? `Seat ${id}`;
  const picked = selectedId !== null && prompt.legalTargets.includes(selectedId) ? selectedId : null;

  const submit = async (answer: SeatAnswer) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/games/${gameId}/seat/act`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ ...answer, promptId: prompt.id }),
      });
      if (res.ok) {
        writeDraft(draftKey, "");
        onSettled("sent");
        return;
      }
      if (res.status === 409) {
        onSettled("stale");
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(data?.error ?? "That move was not accepted.");
    } catch {
      setError("Could not reach the table. Try again.");
    }
    setBusy(false);
  };

  const sendText = () => {
    if (text.trim()) void submit({ kind: "text", text });
  };
  // Text is single-line: Enter sends, Shift+Enter does nothing.
  const onTextKey = (e: React.KeyboardEvent, send: () => void, allowBlank = false) => {
    const action = textKeyAction(
      { key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing },
      text,
      allowBlank
    );
    if (action === "ignore") return;
    e.preventDefault();
    if (action === "send") send();
  };
  const onText = (v: string) => setText(v.replace(/[\r\n]+/g, " "));

  const targets = (
    <TargetChips
      ids={prompt.legalTargets}
      seats={seats}
      selectedId={picked}
      onSelect={onSelect}
      disabled={busy}
    />
  );
  const counter = (
    <span
      // Inside the dock's live region: unhidden, every keystroke would be announced.
      aria-hidden
      className={cn(
        "text-[11px] tabular-nums shrink-0",
        text.length >= prompt.maxChars ? "text-[var(--blood)]" : "text-[var(--muted)]"
      )}
    >
      {text.length}/{prompt.maxChars}
    </span>
  );

  let title = "";
  let note: string | null = null;
  let body: React.ReactNode = null;

  switch (prompt.kind) {
    case "night_kill":
    case "night_check":
    case "night_protect":
    case "hunter_shot":
    case "vote": {
      title =
        prompt.kind === "night_kill"
          ? `Night ${prompt.day} — choose who the pack kills`
          : prompt.kind === "night_check"
          ? `Night ${prompt.day} — whose soul do you read?`
          : prompt.kind === "night_protect"
          ? `Night ${prompt.day} — who do you shield?`
          : prompt.kind === "hunter_shot"
          ? "Your dying breath — take someone with you"
          : "Cast your vote";
      if (prompt.kind === "night_kill") note = "Plurality of the pack decides.";
      const blood = prompt.kind === "hunter_shot" || prompt.kind === "night_kill";
      body = (
        <>
          {targets}
          <div className="flex flex-wrap gap-2">
            <button
              className={cn("btn", blood ? "btn-blood" : "btn-primary")}
              disabled={busy || picked === null}
              onClick={() => picked !== null && submit({ kind: "target", targetId: picked })}
            >
              {picked === null ? "Choose a player" : `${CONFIRM_VERB[prompt.kind]} ${nameOf(picked)}`}
            </button>
            {prompt.kind === "vote" && (
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => submit({ kind: "target", targetId: null })}
              >
                Abstain
              </button>
            )}
          </div>
        </>
      );
      break;
    }

    case "wolf_chat":
      title = `Pack chat — round ${prompt.round ?? 1} of 2`;
      note = "Only the pack hears this.";
      body = (
        <>
          <div className="flex items-center gap-2">
            <input
              className="field"
              autoFocus
              value={text}
              maxLength={prompt.maxChars}
              placeholder="Whisper to the pack…"
              aria-label="Message to the pack"
              onChange={(e) => onText(e.target.value)}
              onKeyDown={(e) => onTextKey(e, sendText)}
            />
            {counter}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={sendText}>
              Send
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => submit({ kind: "text", text: "" })}
            >
              Stay silent
            </button>
          </div>
        </>
      );
      break;

    case "witch": {
      const victim = prompt.wolfTargetId ?? null;
      const potions = prompt.potions ?? { heal: false, poison: false };
      const pickingPoison = potions.poison && (poisoning || picked !== null);
      title =
        victim !== null ? `The wolves attacked ${nameOf(victim)}.` : "The wolves attack no one tonight.";
      note = "You may use at most one potion tonight.";
      body = pickingPoison ? (
        <>
          {targets}
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-blood"
              disabled={busy || picked === null}
              onClick={() =>
                picked !== null && submit({ kind: "witch", heal: false, poisonTargetId: picked })
              }
            >
              {picked === null ? "Choose who to poison" : `☠ Poison ${nameOf(picked)}`}
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => {
                setPoisoning(false);
                onSelect(null);
              }}
            >
              Back
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          {potions.heal && victim !== null && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => submit({ kind: "witch", heal: true, poisonTargetId: null })}
            >
              🧪 Heal {nameOf(victim)}
            </button>
          )}
          {potions.poison && (
            <button className="btn btn-ghost" disabled={busy} onClick={() => setPoisoning(true)}>
              ☠ Poison…
            </button>
          )}
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => submit({ kind: "witch", heal: false, poisonTargetId: null })}
          >
            Do nothing
          </button>
        </div>
      );
      break;
    }

    case "statement": {
      title = `Day ${prompt.day} — speak to the table`;
      const claimable = prompt.claimableWolves ?? [];
      body =
        claimId !== null ? (
          <>
            <div className="field !border-[color-mix(in_srgb,var(--gold)_50%,transparent)] text-[var(--gold)]">
              {seerClaimText(nameOf(claimId))}
            </div>
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              A formal declaration, sent word for word. The table treats it as a true Seer&apos;s
              vision, and the wolves will know who you are.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => submit({ kind: "seer_claim", targetId: claimId })}
              >
                Declare
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setClaimId(null)}>
                Back
              </button>
            </div>
          </>
        ) : (
          <>
            <div>
              <textarea
                className="field"
                autoFocus
                rows={2}
                value={text}
                maxLength={prompt.maxChars}
                placeholder="Make your case. Bluff, accuse, deflect…"
                aria-label="Your statement"
                onChange={(e) => onText(e.target.value)}
                onKeyDown={(e) => onTextKey(e, sendText)}
              />
              <div className="flex justify-end">{counter}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={sendText}>
                Send
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => submit({ kind: "text", text: "" })}
              >
                Say nothing
              </button>
              {claimable.map((id) => (
                <button
                  key={id}
                  className="btn btn-gold-outline"
                  disabled={busy}
                  onClick={() => setClaimId(id)}
                >
                  🔮 Reveal vision: {nameOf(id)} is a werewolf
                </button>
              ))}
            </div>
          </>
        );
      break;
    }

    case "accuse": {
      title = "Formally accuse someone?";
      const accuse = () => {
        if (picked !== null) void submit({ kind: "accuse", targetId: picked, text: text || undefined });
      };
      body = (
        <>
          {targets}
          <div className="flex items-center gap-2">
            <input
              className="field"
              value={text}
              maxLength={prompt.maxChars}
              placeholder="Your reason (optional)"
              aria-label="Reason for the accusation"
              onChange={(e) => onText(e.target.value)}
              onKeyDown={(e) => onTextKey(e, accuse, true)}
            />
            {counter}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={busy || picked === null} onClick={accuse}>
              {picked === null ? "Choose a player" : `Accuse ${nameOf(picked)}`}
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => submit({ kind: "accuse", targetId: null })}
            >
              Pass
            </button>
          </div>
        </>
      );
      break;
    }

    case "defend":
      title = "You stand accused";
      body = (
        <>
          {(prompt.against ?? []).length > 0 && (
            <div className="space-y-1.5 max-h-28 overflow-y-auto scrollbar-thin pr-1">
              {(prompt.against ?? []).map((a, i) => (
                <div
                  key={i}
                  className="text-[13px] leading-snug border-l-2 border-[color-mix(in_srgb,var(--gold)_55%,transparent)] pl-3"
                >
                  <span className="text-[var(--gold)] font-semibold">⚖️ {nameOf(a.from)}</span>{" "}
                  <span className="text-[var(--muted)]">“{a.text}”</span>
                </div>
              ))}
            </div>
          )}
          <div>
            <textarea
              className="field"
              autoFocus
              rows={2}
              value={text}
              maxLength={prompt.maxChars}
              placeholder="Answer the charge…"
              aria-label="Your defense"
              onChange={(e) => onText(e.target.value)}
              onKeyDown={(e) => onTextKey(e, sendText)}
            />
            <div className="flex justify-end">{counter}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={sendText}>
              Send
            </button>
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => submit({ kind: "text", text: "" })}
            >
              Say nothing
            </button>
          </div>
        </>
      );
      break;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-[var(--gold)]">
            Your turn
          </div>
          <h2 className={cn("display text-2xl", prompt.kind === "hunter_shot" && "text-[var(--blood)]")}>
            {title}
          </h2>
          {note && <div className="text-xs text-[var(--muted)] mt-0.5">{note}</div>}
        </div>
        <Countdown deadline={deadline} budgetMs={prompt.budgetMs} />
      </div>
      {body}
      {error && (
        <div role="alert" className="text-sm text-[var(--blood)]">
          {error}
        </div>
      )}
    </div>
  );
}

function TargetChips({
  ids,
  seats,
  selectedId,
  onSelect,
  disabled,
}: {
  ids: number[];
  seats: ReplaySeat[];
  selectedId: number | null;
  onSelect(id: number | null): void;
  disabled: boolean;
}) {
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Choose a player">
      {ids.map((id) => {
        const seat = seats.find((s) => s.id === id);
        const on = selectedId === id;
        return (
          <button
            key={id}
            type="button"
            className="target-chip"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onSelect(on ? null : id)}
          >
            <span className="text-[17px] leading-none">{seat?.avatar ?? "❓"}</span>
            {seat?.name ?? `Seat ${id}`}
          </button>
        );
      })}
    </div>
  );
}

function Countdown({ deadline, budgetMs }: { deadline: number | null; budgetMs: number }) {
  const barRef = useRef<HTMLSpanElement>(null);
  const [secs, setSecs] = useState<number | null>(null);

  useEffect(() => {
    if (deadline === null) {
      setSecs(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      const left = Math.max(0, deadline - performance.now());
      if (barRef.current) {
        barRef.current.style.width = `${Math.min(100, (left / budgetMs) * 100)}%`;
      }
      setSecs(Math.ceil(left / 1000));
      if (left > 0) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [deadline, budgetMs]);

  if (secs === null) return null;
  const low = secs <= 10;
  const label = secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;

  return (
    <div className="w-full sm:w-44 shrink-0 sm:pt-1.5" role="timer" aria-label={`${plural(secs, "second")} left`}>
      <div
        className={cn(
          "text-[11px] font-semibold tabular-nums text-right mb-1",
          low ? "text-[var(--blood)]" : "text-[var(--muted)]"
        )}
      >
        ⏳ {label}
      </div>
      <div className="dock-bar">
        <span ref={barRef} style={{ background: low ? "var(--blood)" : undefined }} />
      </div>
    </div>
  );
}
