"use client";

// The "Minds" card: what a seat privately thought when it acted, beside what it
// said aloud, with provenance. Presentational only — every decision about what
// to show is made by the pure helpers in lib/inspector.ts.

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DecisionRecord, GameEvent, Player } from "@/lib/engine/types";
import { InspectorModel, describeDecision, noReasoningText, sourceChip } from "@/lib/inspector";
import { ROLE_META, cn, modelLabel } from "@/lib/ui";

interface Props {
  model: InspectorModel;
  players: Player[];
  /** events[model.current.step], if it has arrived. */
  event: GameEvent | undefined;
  onJump: (rec: DecisionRecord) => void;
  onClose: () => void;
  /** LiveGame only. */
  live?: { following: boolean; onFollow: () => void; done: boolean };
}

/**
 * Ref for the inspector's wrapper. Below `lg` the card opens in normal flow, far
 * from the toggle that opened it, so bring it into view when it appears.
 */
export function useRevealOnOpen(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !window.matchMedia?.("(max-width: 1023px)").matches) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest" });
  }, [open]);
  return ref;
}

const ALIGN_TAG = { evil: "tag-evil", good: "tag-good", neutral: "tag-neutral" } as const;

const CHIP_TONE = { good: "tag-good", gold: "tag-gold", plain: "" } as const;

function Provenance({ rec, actorModel }: { rec: DecisionRecord; actorModel?: string }) {
  const source = sourceChip(rec, actorModel);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        <span className={cn("chip", CHIP_TONE[source.tone])} title={source.title}>
          {source.text}
        </span>
        {rec.ruling !== "accepted" && (
          <span className="chip tag-gold" title={rec.rulingNote}>
            ⚠ engine {rec.ruling}
          </span>
        )}
        {rec.latencyMs !== undefined && (
          <span className="chip tabular-nums">⏱ {(rec.latencyMs / 1000).toFixed(1)}s</span>
        )}
      </div>
      {rec.ruling !== "accepted" && rec.rulingNote && (
        <div className="text-[11px] text-[var(--muted)] mt-1.5 leading-snug">{rec.rulingNote}</div>
      )}
    </div>
  );
}

export default function MindInspector({ model, players, event, onJump, onClose, live }: Props) {
  const { current, siblings, prev, next } = model;
  const actor = current ? players.find((p) => p.id === current.playerId) : undefined;
  const role = actor ? ROLE_META[actor.role] : undefined;
  const described = current ? describeDecision(current, event, players) : null;
  const nextRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      className="card w-full flex flex-col overflow-hidden"
      style={{ borderLeft: "3px solid var(--mind)" }}
    >
      <div className="px-4 py-3 border-b border-[var(--border)] flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="display text-xl whitespace-nowrap">🧠 Inside the mind</span>
        <span className="chip tag-evil">SPOILERS</span>
        {live && !live.following && (
          <button
            type="button"
            className="chip tag-evil cursor-pointer"
            onClick={live.onFollow}
            title={live.done ? "Return to the final decision" : "Return to the live edge"}
          >
            {live.done ? "● Jump to latest" : "● Jump to live"}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            // aria-disabled, not disabled: a disabled button drops keyboard focus at either end.
            className={cn("btn btn-ghost !px-2.5 !py-1", !prev && "opacity-50 !cursor-not-allowed")}
            aria-disabled={!prev}
            onClick={() => prev && onJump(prev)}
            title="Previous decision ( [ )"
            aria-label="Previous decision"
          >
            ◀
          </button>
          <span className="text-xs text-[var(--muted)] tabular-nums whitespace-nowrap">
            {model.index === 0 ? "–" : model.index} / {model.total}
          </span>
          <button
            type="button"
            ref={nextRef}
            className={cn("btn btn-ghost !px-2.5 !py-1", !next && "opacity-50 !cursor-not-allowed")}
            aria-disabled={!next}
            onClick={() => next && onJump(next)}
            title="Next decision ( ] )"
            aria-label="Next decision"
          >
            ▶
          </button>
          <button
            type="button"
            className="btn btn-ghost !px-2.5 !py-1"
            onClick={onClose}
            title="Close"
            aria-label="Close the inspector"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 py-3" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current ? current.seq : "narrator"}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            // Capped at the body's height so a long thought scrolls in place and the
            // provenance chips below it never drop out of view.
            className="flex flex-col gap-2.5 max-h-full"
          >
            {!current || !described ? (
              <>
                <div className="text-sm text-[var(--muted)]">
                  Narrator moment — no decision on this step.
                </div>
                {next && (
                  <button
                    type="button"
                    className="btn btn-ghost self-start !px-3 !py-1.5 !text-sm"
                    onClick={() => {
                      onJump(next);
                      // This button unmounts with the narrator state; hand focus to the header's ▶.
                      nextRef.current?.focus();
                    }}
                  >
                    Next decision ▶
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="flex items-center gap-2.5 shrink-0">
                  <span className="text-2xl leading-none shrink-0">{actor?.avatar ?? "❓"}</span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-semibold">{actor?.name ?? `Seat ${current.playerId}`}</span>
                      {role && (
                        <span className={cn("chip", ALIGN_TAG[role.align])}>
                          {role.emoji} {role.label}
                        </span>
                      )}
                    </div>
                    {actor && (
                      <div className="text-[11px] text-[var(--muted)] truncate">{modelLabel(actor.model)}</div>
                    )}
                  </div>
                </div>

                <div className="text-[14px] font-semibold leading-snug shrink-0">
                  <span className="text-[var(--muted)] font-normal">
                    {current.phase === "night" ? "Night" : "Day"} {current.day} ·{" "}
                  </span>
                  {described.icon} {described.text}
                </div>

                {described.said && (
                  <div className="shrink-0">
                    <div className="text-[10px] text-[var(--muted)] tracking-wide font-semibold mb-1">
                      SAID ALOUD
                    </div>
                    <div className="text-[13.5px] bg-[var(--panel-2)] border border-[var(--border)] rounded-xl rounded-tl-sm px-3 py-1.5 break-words">
                      {described.said}
                    </div>
                  </div>
                )}

                <div
                  className={cn(
                    "flex flex-col",
                    // Room for two lines before the thought starts scrolling; a one-line
                    // thought would only gain an empty gap above the chips.
                    (current.reasoning?.length ?? 0) > 48 && "min-h-[4.25rem]"
                  )}
                >
                  <div className="text-[10px] tracking-wide font-semibold mb-1 text-[var(--mind)] shrink-0">
                    PRIVATELY THOUGHT
                  </div>
                  {current.reasoning ? (
                    <div
                      className="min-h-0 overflow-y-auto scrollbar-thin font-serif italic text-[17px] leading-snug whitespace-pre-wrap break-words border-l-2 pl-3"
                      style={{ borderColor: "var(--mind)" }}
                    >
                      {current.reasoning}
                    </div>
                  ) : (
                    <div className="text-sm text-[var(--muted)]">
                      {noReasoningText(current, actor?.model)}
                    </div>
                  )}
                </div>

                <div className="shrink-0">
                  <Provenance rec={current} actorModel={actor?.model} />
                </div>

                {siblings.length > 1 && (
                  <div className="flex flex-wrap items-center gap-2 pt-0.5 shrink-0">
                    <span className="text-[10px] text-[var(--muted)] tracking-wide font-semibold mr-0.5">
                      SAME MOMENT
                    </span>
                    {siblings.map((s) => {
                      const who = players.find((p) => p.id === s.playerId);
                      const active = s.seq === current.seq;
                      const label = `${who?.name ?? `Seat ${s.playerId}`} — ${
                        describeDecision(s, undefined, players).text
                      }`;
                      return (
                        <button
                          key={s.seq}
                          type="button"
                          onClick={() => onJump(s)}
                          title={label}
                          aria-label={label}
                          aria-pressed={active}
                          className={cn(
                            "grid place-items-center w-9 h-9 rounded-full text-[18px] leading-none bg-[var(--panel-2)] border border-[var(--border)] cursor-pointer transition-opacity",
                            !s.produced && "opacity-60"
                          )}
                          style={active ? { boxShadow: "0 0 0 2px var(--mind)" } : undefined}
                        >
                          {who?.avatar ?? "❓"}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
