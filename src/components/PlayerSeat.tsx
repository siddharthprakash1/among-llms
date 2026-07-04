"use client";

import { motion } from "framer-motion";
import { ReplaySeat, Highlight } from "@/lib/replay";
import { ROLE_META, cn, modelLabel } from "@/lib/ui";

interface Props {
  seat: ReplaySeat;
  highlight: Highlight;
  showRole: boolean;
  style?: React.CSSProperties;
}

export default function PlayerSeat({ seat, highlight, showRole, style }: Props) {
  const speaking = highlight.speakingId === seat.id;
  const killed = highlight.killId === seat.id;
  const saved = highlight.saveId === seat.id;
  const checked = highlight.checkId === seat.id;
  const eliminated = highlight.eliminatedId === seat.id;
  const reveal = showRole || seat.revealed;
  const meta = ROLE_META[seat.role];

  const ringColor = !seat.alive
    ? "transparent"
    : speaking
    ? "var(--gold)"
    : killed || eliminated
    ? "var(--blood)"
    : saved
    ? "var(--good)"
    : checked
    ? "var(--moon)"
    : reveal
    ? meta.align === "evil"
      ? "color-mix(in srgb, var(--evil) 65%, transparent)"
      : "color-mix(in srgb, var(--good) 55%, transparent)"
    : "var(--border)";

  return (
    <div
      style={style}
      className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center w-[88px]"
    >
      <motion.div
        animate={{
          scale: speaking ? 1.08 : 1,
          opacity: seat.alive ? 1 : 0.4,
        }}
        transition={{ type: "spring", stiffness: 300, damping: 22 }}
        className={cn(
          "relative grid place-items-center rounded-full w-[58px] h-[58px] text-[28px] bg-[var(--panel-2)]",
          speaking && "ring-speaking"
        )}
        style={{ border: `2.5px solid ${ringColor}` }}
      >
        <span className={cn(!seat.alive && "grayscale")}>{seat.avatar}</span>
        {!seat.alive && (
          <span className="absolute inset-0 grid place-items-center text-[26px]">💀</span>
        )}
        {reveal && (
          <span
            title={meta.label}
            className="absolute -bottom-1.5 -right-1.5 text-[15px] bg-[var(--bg)] rounded-full w-[24px] h-[24px] grid place-items-center border border-[var(--border)]"
          >
            {meta.emoji}
          </span>
        )}
      </motion.div>
      <div className="mt-1.5 text-center leading-tight">
        <div className={cn("text-[13px] font-semibold", !seat.alive && "line-through opacity-60")}>
          {seat.name}
        </div>
        <div className="text-[10px] text-[var(--muted)] truncate max-w-[84px]">
          {modelLabel(seat.model)}
        </div>
      </div>
    </div>
  );
}
