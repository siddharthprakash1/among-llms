// Core domain types for the Among LLMs Werewolf engine.
// The engine is deterministic given a seed and is decoupled from any UI or LLM:
// it talks to "brains" through the Brain interface and emits a Transcript of events.

export type Role = "werewolf" | "seer" | "doctor" | "villager";
export type Alignment = "good" | "evil";
export type Phase = "night" | "day";

export const ALIGNMENT_OF: Record<Role, Alignment> = {
  werewolf: "evil",
  seer: "good",
  doctor: "good",
  villager: "good",
};

export interface Player {
  id: number; // seat index, 0-based
  name: string; // display name
  avatar: string; // emoji
  model: string; // brain / model id occupying this seat (e.g. "mock", "gpt-4o-mini")
  role: Role;
  alignment: Alignment;
  alive: boolean;
}

export interface GameConfig {
  /** Number of seats at the table (5–12). */
  numPlayers: number;
  /** Model/brain id per seat. Length must equal numPlayers. */
  seatModels: string[];
  /** PRNG seed — same seed + same brains ⇒ identical transcript. */
  seed: number;
  /** Optional explicit role counts; derived from numPlayers when omitted. */
  roleCounts?: Partial<Record<Role, number>>;
  /** Safety cap on day cycles; defaults to numPlayers + 3. */
  maxDays?: number;
}

// ---------------------------------------------------------------------------
// What a brain is allowed to see when it makes a decision (role-redacted).
// ---------------------------------------------------------------------------

export interface PublicPlayer {
  id: number;
  name: string;
  avatar: string;
  alive: boolean;
}

export interface DeathRecord {
  day: number;
  playerId: number;
  cause: "wolves" | "vote";
  role: Role; // revealed on death
}

export interface StatementRecord {
  day: number;
  playerId: number;
  text: string;
}

export interface VoteRecord {
  day: number;
  voterId: number;
  targetId: number | null; // null = abstain
}

export interface SeerResult {
  day: number;
  targetId: number;
  alignment: Alignment;
}

export interface PlayerView {
  self: { id: number; name: string; role: Role; alignment: Alignment; model: string };
  day: number;
  phase: Phase;
  players: PublicPlayer[];
  aliveIds: number[];
  // Private knowledge (populated only when the role legitimately has it):
  knownWolves: number[]; // wolves know their packmates (all wolf seats); others: []
  seerResults: SeerResult[]; // seer only
  lastProtectedId: number | null; // doctor only
  // Public history visible to everyone:
  deaths: DeathRecord[];
  statements: StatementRecord[];
  votes: VoteRecord[];
}

export interface NightDecision {
  targetId: number | null;
  /** Optional private reasoning, surfaced in spoiler views. */
  note?: string;
}

export interface VoteDecision {
  targetId: number | null;
  note?: string;
}

export interface Brain {
  readonly id: string;
  nightAction(view: PlayerView): Promise<NightDecision>;
  dayStatement(view: PlayerView): Promise<string>;
  dayVote(view: PlayerView): Promise<VoteDecision>;
}

export type BrainFactory = (modelId: string, seatId: number) => Brain;

// ---------------------------------------------------------------------------
// The transcript: an ordered, replayable record of everything that happened.
// ---------------------------------------------------------------------------

export type GameEvent =
  | { kind: "game_start"; day: 0 }
  | { kind: "phase"; phase: Phase; day: number; label: string; sublabel?: string }
  | { kind: "wolf_kill"; day: number; actorIds: number[]; targetId: number }
  | { kind: "seer_check"; day: number; seerId: number; targetId: number; result: Alignment }
  | { kind: "doctor_save"; day: number; doctorId: number; targetId: number }
  | { kind: "death"; day: number; playerId: number; cause: "wolves" | "vote"; role: Role }
  | { kind: "saved"; day: number; targetId: number }
  | { kind: "statement"; day: number; playerId: number; text: string }
  | { kind: "vote"; day: number; voterId: number; targetId: number | null }
  | {
      kind: "vote_result";
      day: number;
      tally: Record<number, number>;
      eliminatedId: number | null;
      tie: boolean;
    }
  | { kind: "game_over"; winner: Alignment; reason: string; survivorIds: number[] };

export interface SeatOutcome {
  seatId: number;
  model: string;
  role: Role;
  alignment: Alignment;
  won: boolean;
  survived: boolean;
}

export interface GameResult {
  winner: Alignment;
  reason: string;
  survivorIds: number[];
  days: number;
}

export interface Transcript {
  id: string;
  createdAt: string; // ISO timestamp, injected by caller (engine never reads the clock)
  config: GameConfig;
  players: Player[]; // full info (god view)
  events: GameEvent[];
  result: GameResult;
  outcomes: SeatOutcome[];
}
