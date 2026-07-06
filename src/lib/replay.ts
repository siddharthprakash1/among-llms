// Pure replay logic: fold a transcript's events up to a given step into the
// world state to render. The ReplayPlayer just advances `step` on a timer and
// renders deriveState(transcript, step). No side effects, client-safe.

import { Alignment, GameEvent, Role, Transcript, Winner } from "./engine/types";

export type ReplayPhase = "pregame" | "night" | "day" | "over";
export type LogTone =
  | "narration"
  | "speech"
  | "death"
  | "vote"
  | "system"
  | "night"
  | "wolfchat"
  | "accusation"
  | "defense";

export interface ReplaySeat {
  id: number;
  name: string;
  avatar: string;
  model: string;
  role: Role;
  alignment: Alignment;
  alive: boolean;
  revealed: boolean; // role known to spectators (died or game over)
}

export interface LogEntry {
  key: string;
  tone: LogTone;
  text: string;
  playerId?: number;
  day: number;
}

export interface Highlight {
  speakingId?: number;
  killId?: number;
  checkId?: number;
  checkEvil?: boolean;
  saveId?: number;
  eliminatedId?: number;
  accusedId?: number;
}

export interface ReplayState {
  step: number;
  total: number;
  day: number;
  phase: ReplayPhase;
  banner: { label: string; sublabel?: string; phase: "night" | "day" } | null;
  seats: ReplaySeat[];
  log: LogEntry[];
  highlight: Highlight;
  finished: boolean;
  winner?: Winner;
  reason?: string;
}

export function totalSteps(t: Transcript): number {
  return t.events.length - 1;
}

function nameIn(seats: ReplaySeat[], id: number): string {
  return seats.find((s) => s.id === id)?.name ?? `Seat ${id}`;
}

function highlightFor(ev: GameEvent): Highlight {
  switch (ev.kind) {
    case "wolf_kill":
      return { killId: ev.targetId };
    case "seer_check":
      return { checkId: ev.targetId, checkEvil: ev.result === "evil" };
    case "doctor_save":
      return { saveId: ev.targetId };
    case "statement":
      return { speakingId: ev.playerId };
    case "death":
      return ev.cause === "vote" ? { eliminatedId: ev.playerId } : {};
    case "accusation":
      return { speakingId: ev.from, accusedId: ev.target };
    case "defense":
      return { speakingId: ev.playerId };
    case "hunter_shot":
      return { killId: ev.targetId };
    default:
      return {};
  }
}

export function deriveState(
  t: Transcript,
  rawStep: number,
  opts: { revealPrivate?: boolean } = {}
): ReplayState {
  const total = totalSteps(t);
  const step = Math.max(0, Math.min(rawStep, total));

  const seats: ReplaySeat[] = t.players.map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    model: p.model,
    role: p.role,
    alignment: p.alignment,
    alive: true,
    revealed: false,
  }));
  const log: LogEntry[] = [];
  let day = 0;
  let phase: ReplayPhase = "pregame";
  let banner: ReplayState["banner"] = null;
  let finished = false;
  let winner: Winner | undefined;
  let reason: string | undefined;

  const seatOf = (id: number) => seats.find((s) => s.id === id)!;

  for (let i = 0; i <= step; i++) {
    const ev = t.events[i];
    const k = `${i}`;
    switch (ev.kind) {
      case "game_start":
        log.push({
          key: k,
          tone: "narration",
          day: 0,
          text: `${seats.length} players take their seats. Among them, the wolves hide in plain sight.`,
        });
        break;
      case "phase":
        day = ev.day;
        phase = ev.phase;
        banner = { label: ev.label, sublabel: ev.sublabel, phase: ev.phase };
        log.push({
          key: k,
          tone: "narration",
          day,
          text: `${ev.phase === "night" ? "🌙" : "☀️"} ${ev.label} — ${ev.sublabel ?? ""}`.trim(),
        });
        break;
      case "wolf_chat":
        if (opts.revealPrivate) {
          log.push({ key: k, tone: "wolfchat", day: ev.day, playerId: ev.wolfId,
            text: `🐺 ${nameIn(seats, ev.wolfId)} (pack): "${ev.text}"` });
        }
        break;
      case "wolf_kill":
        log.push({
          key: k,
          tone: "night",
          day: ev.day,
          text: `The pack closes in on ${nameIn(seats, ev.targetId)}…`,
        });
        break;
      case "seer_check":
        log.push({
          key: k,
          tone: "night",
          day: ev.day,
          text: `The Seer (${nameIn(seats, ev.seerId)}) reads ${nameIn(seats, ev.targetId)}: ${
            ev.result === "evil" ? "WEREWOLF." : "innocent."
          }`,
        });
        break;
      case "doctor_save":
        log.push({
          key: k,
          tone: "night",
          day: ev.day,
          text: `The Doctor (${nameIn(seats, ev.doctorId)}) quietly shields ${nameIn(
            seats,
            ev.targetId
          )}.`,
        });
        break;
      case "saved":
        log.push({
          key: k,
          tone: "narration",
          day: ev.day,
          text: `The wolves struck — but ${nameIn(seats, ev.targetId)} was ${("by" in ev && ev.by === "witch") ? "snatched back by the Witch" : "protected"}. No one died.`,
        });
        break;
      case "witch_action":
        if (opts.revealPrivate) {
          log.push({ key: k, tone: "night", day: ev.day,
            text: ev.action === "heal"
              ? `🧪 The Witch (${nameIn(seats, ev.witchId)}) pours the healing draught over ${nameIn(seats, ev.targetId)}.`
              : `🧪 The Witch (${nameIn(seats, ev.witchId)}) slips poison to ${nameIn(seats, ev.targetId)}.` });
        }
        break;
      case "hunter_shot":
        log.push({ key: k, tone: "death", day: ev.day,
          text: `🏹 With their dying breath, ${nameIn(seats, ev.hunterId)} shoots ${nameIn(seats, ev.targetId)}!` });
        break;
      case "death": {
        const seat = seatOf(ev.playerId);
        seat.alive = false;
        seat.revealed = true;
        log.push({
          key: k,
          tone: "death",
          day: ev.day,
          playerId: ev.playerId,
          text:
            ev.cause === "wolves" ? `☠️ ${seat.name} was found dead at dawn. They were a ${ev.role}.`
            : ev.cause === "poison" ? `☠️ ${seat.name} died frothing at dawn — poisoned. They were a ${ev.role}.`
            : ev.cause === "hunter" ? `☠️ ${seat.name} falls to the Hunter's last arrow. They were a ${ev.role}.`
            : `🗳️ The village voted out ${seat.name} — who was a ${ev.role}.`,
        });
        break;
      }
      case "statement":
        log.push({
          key: k,
          tone: "speech",
          day: ev.day,
          playerId: ev.playerId,
          text: ev.text,
        });
        break;
      case "accusation":
        log.push({ key: k, tone: "accusation", day: ev.day, playerId: ev.from,
          text: `⚖️ ${nameIn(seats, ev.from)} accuses ${nameIn(seats, ev.target)}: "${ev.text}"` });
        break;
      case "defense":
        log.push({ key: k, tone: "defense", day: ev.day, playerId: ev.playerId, text: ev.text });
        break;
      case "vote":
        log.push({
          key: k,
          tone: "vote",
          day: ev.day,
          playerId: ev.voterId,
          text:
            ev.targetId === null
              ? `${nameIn(seats, ev.voterId)} abstains.`
              : `${nameIn(seats, ev.voterId)} votes for ${nameIn(seats, ev.targetId)}.`,
        });
        break;
      case "vote_result":
        if (ev.tie) {
          log.push({
            key: k,
            tone: "narration",
            day: ev.day,
            text: "The vote is deadlocked. No one is eliminated today.",
          });
        }
        break;
      case "game_over":
        finished = true;
        phase = "over";
        winner = ev.winner;
        reason = ev.reason;
        banner = null;
        seats.forEach((s) => (s.revealed = true));
        log.push({
          key: k,
          tone: "system",
          day,
          text: `${ev.winner === "good" ? "🏡 The Village wins!" : ev.winner === "evil" ? "🐺 The Werewolves win!" : "🃏 The Jester wins!"} ${
            ev.reason
          }`,
        });
        break;
    }
  }

  const highlight = step >= 0 ? highlightFor(t.events[step]) : {};

  return { step, total, day, phase, banner, seats, log, highlight, finished, winner, reason };
}

/** Playback dwell time (ms) for the event at `step`, before advancing. */
export function stepDelay(t: Transcript, step: number, speed: number): number {
  const ev = t.events[Math.min(step, t.events.length - 1)];
  const base = (() => {
    switch (ev?.kind) {
      case "statement":
        return 2600;
      case "phase":
        return 2100;
      case "death":
        return 2500;
      case "seer_check":
      case "wolf_kill":
      case "doctor_save":
        return 1500;
      case "saved":
        return 2200;
      case "wolf_chat":
        return 1700;
      case "accusation":
        return 2300;
      case "defense":
        return 2400;
      case "witch_action":
        return 1500;
      case "hunter_shot":
        return 2300;
      case "vote":
        return 650;
      case "vote_result":
        return 1600;
      case "game_over":
        return 4000;
      default:
        return 1200;
    }
  })();
  return Math.max(120, base / speed);
}
