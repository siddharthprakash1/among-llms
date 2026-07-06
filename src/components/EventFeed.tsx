"use client";

import { useEffect, useRef } from "react";
import { LogEntry, ReplaySeat } from "@/lib/replay";
import { cn, modelLabel } from "@/lib/ui";

interface Props {
  log: LogEntry[];
  seats: ReplaySeat[];
}

export default function EventFeed({ log, seats }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const seatOf = (id?: number) => seats.find((s) => s.id === id);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log.length]);

  return (
    <div className="card h-full flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
        <span className="display text-xl">The table talks</span>
        <span className="chip">{log.filter((l) => l.tone === "speech").length} statements</span>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4 space-y-2.5">
        {log.map((entry) => {
          if (entry.tone === "speech" || entry.tone === "defense") {
            const seat = seatOf(entry.playerId);
            return (
              <div key={entry.key} className="float-in flex gap-2.5">
                <span className="text-[22px] leading-none mt-0.5 shrink-0">
                  {seat?.avatar ?? "❓"}
                </span>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-semibold">{seat?.name}</span>
                    <span className="text-[10px] text-[var(--muted)]">
                      {modelLabel(seat?.model ?? "")}
                    </span>
                  </div>
                  {entry.tone === "defense" && (
                    <div className="text-[10px] text-[var(--gold)] mt-0.5">🛡 in their defense</div>
                  )}
                  <div className="text-[13.5px] text-[var(--text)] bg-[var(--panel-2)] border border-[var(--border)] rounded-xl rounded-tl-sm px-3 py-1.5 mt-0.5">
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
        <div ref={endRef} />
      </div>
    </div>
  );
}
