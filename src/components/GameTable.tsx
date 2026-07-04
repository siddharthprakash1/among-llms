"use client";

import { AnimatePresence, motion } from "framer-motion";
import PlayerSeat from "./PlayerSeat";
import { Highlight, ReplaySeat, ReplayState } from "@/lib/replay";

interface Props {
  seats: ReplaySeat[];
  highlight: Highlight;
  banner: ReplayState["banner"];
  phase: ReplayState["phase"];
  day: number;
  showRole: boolean;
}

export default function GameTable({ seats, highlight, banner, phase, day, showRole }: Props) {
  const n = seats.length;
  const isNight = phase === "night";

  return (
    <div
      className="relative w-full mx-auto"
      style={{ maxWidth: 520, aspectRatio: "1 / 1" }}
    >
      {/* table felt */}
      <div
        className="absolute rounded-full"
        style={{
          inset: "16%",
          background: isNight
            ? "radial-gradient(circle at 50% 40%, #20284a 0%, #0e1124 70%)"
            : "radial-gradient(circle at 50% 40%, #2a2740 0%, #14121f 70%)",
          border: "1px solid var(--border)",
          boxShadow: "inset 0 0 60px rgba(0,0,0,0.5)",
          transition: "background 0.8s ease",
        }}
      />

      {/* center indicator */}
      <div className="absolute inset-0 grid place-items-center pointer-events-none">
        <AnimatePresence mode="wait">
          <motion.div
            key={banner ? banner.label : phase}
            initial={{ opacity: 0, scale: 0.9, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -8 }}
            transition={{ duration: 0.4 }}
            className="text-center px-6 max-w-[200px]"
          >
            <div className="text-4xl mb-1">
              {phase === "over" ? "🏁" : isNight ? "🌙" : "☀️"}
            </div>
            <div className="display text-2xl text-[var(--text)]">
              {phase === "over" ? "Game over" : banner?.label ?? `Day ${day}`}
            </div>
            {banner?.sublabel && (
              <div className="text-[11px] text-[var(--muted)] mt-1 leading-snug">
                {banner.sublabel}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* seats around the table */}
      {seats.map((seat, i) => {
        const angle = (-90 + (360 / n) * i) * (Math.PI / 180);
        const R = 46;
        const left = 50 + R * Math.cos(angle);
        const top = 50 + R * Math.sin(angle);
        return (
          <PlayerSeat
            key={seat.id}
            seat={seat}
            highlight={highlight}
            showRole={showRole}
            style={{ left: `${left}%`, top: `${top}%` }}
          />
        );
      })}
    </div>
  );
}
