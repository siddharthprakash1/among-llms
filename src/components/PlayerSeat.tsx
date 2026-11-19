"use client";

import { motion } from "framer-motion";
import { ReplaySeat, Highlight } from "@/lib/replay";
import { ROLE_META, cn, modelLabel } from "@/lib/ui";

export interface SeatMark {
  emoji: string;
  label: string;
}

interface Props {
  seat: ReplaySeat;
  highlight: Highlight;
  showRole: boolean;
  thinkingId?: number;
  style?: React.CSSProperties;
  you?: boolean;
  mark?: SeatMark;
  /** undefined = no target pick is open; false = a pick is open and this seat is not a legal target. */
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: number) => void;
}

const DIMMED = 0.45;

export default function PlayerSeat({
  seat,
  highlight,
  showRole,
  thinkingId,
  style,
  you,
  mark,
  selectable,
  selected,
  onSelect,
}: Props) {
  // While a target pick is open the gold ring means "selected", so the last speaker gives it up.
  const speaking = highlight.speakingId === seat.id && selectable === undefined;
  const killed = highlight.killId === seat.id;
  const saved = highlight.saveId === seat.id;
  const checked = highlight.checkId === seat.id;
  const eliminated = highlight.eliminatedId === seat.id;
  const thinking = thinkingId === seat.id;
  const reveal = showRole || seat.revealed;
  const meta = ROLE_META[seat.role];
  // A pick fades every seat that cannot be chosen. Your own seat fades only its
  // face: the YOU halo and your name stay lit so you never lose track of yourself.
  const outOfPick = selectable === false;

  const ringColor = selected
    ? "var(--gold)"
    : !seat.alive
    ? "transparent"
    : speaking
    ? "var(--gold)"
    : killed || eliminated
    ? "var(--blood)"
    : saved
    ? "var(--good)"
    : checked
    ? "var(--moon)"
    : thinking
    ? "var(--mind)"
    : reveal
    ? meta.align === "evil"
      ? "color-mix(in srgb, var(--evil) 65%, transparent)"
      : meta.align === "neutral"
      ? "color-mix(in srgb, var(--gold) 60%, transparent)"
      : "color-mix(in srgb, var(--good) 55%, transparent)"
    : "var(--border)";

  const Root = selectable ? "button" : "div";

  return (
    <Root
      {...(selectable
        ? {
            type: "button" as const,
            onClick: () => onSelect?.(seat.id),
            "aria-pressed": !!selected,
            "aria-label": `Choose ${seat.name}`,
          }
        : {})}
      style={{ ...style, opacity: outOfPick && !you ? DIMMED : undefined }}
      className={cn(
        "absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center w-[88px] transition-opacity",
        selectable && "seat-pick"
      )}
    >
      <div className="relative">
        <motion.div
          animate={{
            scale: speaking ? 1.08 : 1,
            opacity: seat.alive ? 1 : 0.4,
          }}
          transition={{ type: "spring", stiffness: 300, damping: 22 }}
          className={cn(
            "relative grid place-items-center rounded-full w-[58px] h-[58px] text-[28px] bg-[var(--panel-2)]",
            speaking && "ring-speaking",
            selectable && !selected && !speaking && "seat-pulse",
            selected && "seat-selected",
            you && !selected && "seat-you"
          )}
          style={{ border: `2.5px solid ${ringColor}` }}
        >
          <span
            className={cn(!seat.alive && "grayscale", you && "transition-opacity")}
            style={outOfPick && you ? { opacity: DIMMED } : undefined}
          >
            {seat.avatar}
          </span>
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
        {/* Outside the motion.div: a dead seat's 0.4 opacity must not dim the badge. */}
        {mark && (
          <span
            title={mark.label}
            aria-label={mark.label}
            className="absolute -top-1.5 -left-1.5 text-[12px] bg-[var(--bg)] rounded-full w-[22px] h-[22px] grid place-items-center border border-[var(--border)]"
          >
            {mark.emoji}
          </span>
        )}
        {thinking && (
          <span
            title="Deciding"
            className="absolute -top-1.5 -left-1.5 text-[13px] bg-[var(--bg)] rounded-full w-[22px] h-[22px] grid place-items-center border"
            style={{ borderColor: "var(--mind)" }}
          >
            💭
          </span>
        )}
        </div>
      <div className="mt-1.5 text-center leading-tight">
        <div className={cn("text-[13px] font-semibold", !seat.alive && "line-through opacity-60")}>
          {seat.name}
        </div>
        {you && (
          <div className="text-[9px] font-bold tracking-[0.14em] text-[var(--gold)] leading-none mt-0.5 mb-0.5">
            YOU
          </div>
        )}
        <div className="text-[10px] text-[var(--muted)] truncate max-w-[84px]">
          {modelLabel(seat.model)}
        </div>
      </div>
    </Root>
  );
}
