import type { GameEvent } from "./engine/types";

// Paced emission so mock games (which simulate instantly) still feel live, and
// real-model games stream at their natural thinking speed.
export function delayFor(ev: GameEvent): number {
  switch (ev.kind) {
    case "statement":
      return 1500;
    case "accusation":
    case "defense":
      return 1200;
    case "phase":
      return 900;
    case "death":
      return 1300;
    case "wolf_chat":
      return 900;
    case "seer_check":
    case "doctor_save":
    case "witch_action":
      return 800;
    case "wolf_kill":
      return 700;
    case "vote":
      return 350;
    case "vote_result":
      return 900;
    case "game_over":
      return 500;
    default:
      return 600;
  }
}
