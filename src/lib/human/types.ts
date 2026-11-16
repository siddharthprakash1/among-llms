// Shared types for the human seat. Client-safe: type-only imports from the engine.

import type {
  Alignment, DeathCause, GameEvent, Phase, Player, Role, SeerResult, Winner, WitchPotions,
} from "../engine/types";

export const HUMAN_MODEL_ID = "human";

/** Seat-only pseudo-event: tells the client which roles are now known. */
export interface SeatRevealEvent {
  kind: "seat_reveal";
  /** false = ghost view started (the seat died); true = game over. */
  final: boolean;
  players: Player[];
  /** final only: the full raw event log up to (not including) game_over. */
  events?: GameEvent[];
}

/** What a seat may receive. Every member lists its fields explicitly; nothing else is ever sent. */
export type SeatEvent =
  | { kind: "game_start"; day: 0 }
  | { kind: "phase"; phase: Phase; day: number; label: string; sublabel?: string }
  | { kind: "wolf_chat"; day: number; wolfId: number; text: string }
  | { kind: "wolf_kill"; day: number; actorIds: number[]; targetId: number }
  | { kind: "seer_check"; day: number; seerId: number; targetId: number; result: Alignment }
  | { kind: "doctor_save"; day: number; doctorId: number; targetId: number }
  | { kind: "witch_action"; day: number; witchId: number; action: "heal" | "poison"; targetId: number }
  | { kind: "hunter_shot"; day: number; hunterId: number; targetId: number }
  | { kind: "death"; day: number; playerId: number; cause: DeathCause; role: Role }
  | { kind: "saved"; day: number; targetId: number; by: "doctor" | "witch" }
  | { kind: "statement"; day: number; playerId: number; text: string }
  | { kind: "accusation"; day: number; from: number; target: number; text: string }
  | { kind: "defense"; day: number; playerId: number; text: string }
  | { kind: "vote"; day: number; voterId: number; targetId: number | null }
  | { kind: "vote_result"; day: number; tally: Record<number, number>; eliminatedId: number | null; tie: boolean }
  | { kind: "game_over"; winner: Winner; reason: string; survivorIds: number[] }
  | SeatRevealEvent;

export interface SeatViewer { seatId: number; role: Role; alignment: Alignment }

export interface SeatPlayer { id: number; name: string; avatar: string; model: string }

export interface SeatMeta {
  id: string;
  createdAt: string;
  status: "running" | "finished" | "abandoned";
  numPlayers: number;
  players: SeatPlayer[];                  // no role, no alignment
  roleCounts: Record<Role, number>;       // public setup (derivable from the form)
  you: { seatId: number; name: string; avatar: string; role: Role; alignment: Alignment };
  packmates: number[];                    // other wolf seat ids; [] unless you are evil
}

export type PromptKind =
  | "night_kill" | "night_check" | "night_protect" | "wolf_chat" | "witch"
  | "hunter_shot" | "statement" | "accuse" | "defend" | "vote";

/** Built by HumanBrain from the PlayerView (allow-listed fields only). */
export interface PromptSpec {
  kind: PromptKind;
  day: number;
  phase: Phase;
  legalTargets: number[];                 // [] for text-only prompts
  allowPass: boolean;                     // null target / empty text / "do nothing" accepted
  maxChars: number;                       // 0 when the prompt takes no text
  round?: number;                         // wolf_chat
  wolfTargetId?: number | null;           // witch
  potions?: WitchPotions;                 // witch
  against?: { from: number; text: string }[]; // defend
  claimableWolves?: number[];             // statement, seer only: living players with an evil result
}

export interface SeatPrompt extends PromptSpec {
  id: string;                             // "1", "2", … monotonic per game
  budgetMs: number;
  afterSeq: number;                       // seat buffer length when issued
}

export type SeatAnswer =
  | { kind: "target"; targetId: number | null }
  | { kind: "text"; text: string }
  | { kind: "accuse"; targetId: number | null; text?: string }
  | { kind: "witch"; heal: boolean; poisonTargetId: number | null }
  | { kind: "seer_claim"; targetId: number };

/** POST body of /seat/act. */
export type SeatActBody = (SeatAnswer & { promptId: string }) | { resume: true };

/** Payload of the SSE `seat` event. */
export interface SeatStatus {
  prompt: SeatPrompt | null;
  remainingMs: number | null;             // null when prompt is null
  autopilot: boolean;
  lastResolved: { id: string; outcome: "submitted" | "timeout" } | null;
}

/** Derived on the client from the seat's own events. */
export interface SeatKnowledge {
  visions: SeerResult[];
  lastProtectedId: number | null;
  potions: WitchPotions | null;
}
