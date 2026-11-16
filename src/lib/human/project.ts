// The redaction core: what one seat may see of one engine event.
// Every case rebuilds the event field by field (never spread `ev`), so unknown
// kinds and unknown fields (private reasoning, notes) are dropped by construction.

import type { GameEvent } from "../engine/types";
import type { SeatEvent, SeatViewer } from "./types";

export function projectEvent(ev: GameEvent, v: SeatViewer, ghost: boolean): SeatEvent | null {
  switch (ev.kind) {
    case "game_start":
      return { kind: "game_start", day: 0 };
    case "phase":
      return ev.sublabel === undefined
        ? { kind: "phase", phase: ev.phase, day: ev.day, label: ev.label }
        : { kind: "phase", phase: ev.phase, day: ev.day, label: ev.label, sublabel: ev.sublabel };
    case "wolf_chat":
      if (!ghost && v.alignment !== "evil") return null;
      return { kind: "wolf_chat", day: ev.day, wolfId: ev.wolfId, text: ev.text };
    case "wolf_kill":
      if (!ghost && v.alignment !== "evil") return null;
      return { kind: "wolf_kill", day: ev.day, actorIds: [...ev.actorIds], targetId: ev.targetId };
    case "seer_check":
      if (!ghost && ev.seerId !== v.seatId) return null;
      return { kind: "seer_check", day: ev.day, seerId: ev.seerId, targetId: ev.targetId, result: ev.result };
    case "doctor_save":
      if (!ghost && ev.doctorId !== v.seatId) return null;
      return { kind: "doctor_save", day: ev.day, doctorId: ev.doctorId, targetId: ev.targetId };
    case "witch_action":
      if (!ghost && ev.witchId !== v.seatId) return null;
      return { kind: "witch_action", day: ev.day, witchId: ev.witchId, action: ev.action, targetId: ev.targetId };
    case "saved":
      // Names the wolves' target; no PlayerView gives that to anybody.
      if (!ghost) return null;
      return { kind: "saved", day: ev.day, targetId: ev.targetId, by: ev.by };
    case "hunter_shot":
      return { kind: "hunter_shot", day: ev.day, hunterId: ev.hunterId, targetId: ev.targetId };
    case "death":
      return { kind: "death", day: ev.day, playerId: ev.playerId, cause: ev.cause, role: ev.role };
    case "statement":
      return { kind: "statement", day: ev.day, playerId: ev.playerId, text: ev.text };
    case "accusation":
      return { kind: "accusation", day: ev.day, from: ev.from, target: ev.target, text: ev.text };
    case "defense":
      return { kind: "defense", day: ev.day, playerId: ev.playerId, text: ev.text };
    case "vote":
      return { kind: "vote", day: ev.day, voterId: ev.voterId, targetId: ev.targetId };
    case "vote_result":
      return {
        kind: "vote_result",
        day: ev.day,
        tally: { ...ev.tally },
        eliminatedId: ev.eliminatedId,
        tie: ev.tie,
      };
    case "game_over":
      return { kind: "game_over", winner: ev.winner, reason: ev.reason, survivorIds: [...ev.survivorIds] };
    default:
      return null;
  }
}
