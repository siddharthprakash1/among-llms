"use client";

import { useEffect, useRef } from "react";
import { LogEntry, ReplaySeat } from "@/lib/replay";
import { cn, followFeedEnd, modelLabel, plural } from "@/lib/ui";

interface Props {
  log: LogEntry[];
  seats: ReplaySeat[];
  youId?: number;
  /** Omitted (replay, live): the newest line is brought into view with scrollIntoView,
   *  which may also scroll the page. Given, the caller owns the page layout. 0: nothing
   *  is pinned over the page, so only the list scrolls and a new line never moves the
   *  page. Above 0: the height in px of a dock pinned over the bottom of the viewport;
   *  the newest line is scrolled, page included, to rest above it. */
  endClearance?: number;
}

export default function EventFeed({ log, seats, youId, endClearance }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const seatOf = (id?: number) => seats.find((s) => s.id === id);

  useEffect(() => {
    followFeedEnd(listRef.current, endRef.current, endClearance);
  }, [log.length, endClearance]);

  return (
    <div className="card h-full flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
        <span className="display text-xl">The table talks</span>
        <span className="chip">{plural(log.filter((l) => l.tone === "speech").length, "statement")}</span>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4 space-y-2.5">
        {log.map((entry) => {
          if (entry.tone === "speech" || entry.tone === "defense") {
            const seat = seatOf(entry.playerId);
            const mine = youId !== undefined && entry.playerId === youId;
            return (
              <div key={entry.key} className="float-in flex gap-2.5">
                <span className="text-[22px] leading-none mt-0.5 shrink-0">
                  {seat?.avatar ?? "❓"}
                </span>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-semibold">{seat?.name}</span>
                    {mine && <span className="chip tag-gold !text-[10px] !py-0 !px-1.5">You</span>}
                    <span className="text-[10px] text-[var(--muted)]">
                      {modelLabel(seat?.model ?? "")}
                    </span>
                  </div>
                  {entry.tone === "defense" && (
                    <div className="text-[10px] text-[var(--gold)] mt-0.5">🛡 in their defense</div>
                  )}
                  <div
                    className={cn(
                      "text-[13.5px] text-[var(--text)] bg-[var(--panel-2)] border rounded-xl rounded-tl-sm px-3 py-1.5 mt-0.5",
                      mine
                        ? "border-[color-mix(in_srgb,var(--gold)_45%,transparent)]"
                        : "border-[var(--border)]"
                    )}
                  >
                    {entry.text}
                  </div>
                </div>
              </div>
            );
          }
          if (entry.tone === "system") {
            return (
              <div
                key={entry.key}
                className="float-in text-center display text-xl text-[var(--gold)] py-2"
              >
                {entry.text}
              </div>
            );
          }
          return (
            <div
              key={entry.key}
              className={cn(
                "float-in text-[12.5px] leading-snug px-1",
                entry.tone === "night" && "text-[var(--moon)] italic",
                entry.tone === "death" && "text-[var(--blood)] font-medium",
                entry.tone === "narration" && "text-[var(--muted)] text-center",
                entry.tone === "vote" && "text-[var(--muted)]",
                entry.tone === "wolfchat" && "text-[var(--evil)] italic",
                entry.tone === "accusation" && "text-[var(--gold)] font-medium"
              )}
            >
              {entry.text}
            </div>
          );
        })}
        <div ref={endRef} style={endClearance ? { scrollMarginBottom: endClearance } : undefined} />
      </div>
    </div>
  );
}
