// Core domain types for the Among LLMs Werewolf engine.
// The engine is deterministic given a seed and is decoupled from any UI or LLM:
// it talks to "brains" through the Brain interface and emits a Transcript of events.

export type Role = "werewolf" | "seer" | "doctor" | "villager" | "hunter" | "witch" | "jester";
export type Alignment = "good" | "evil" | "neutral";
export type Winner = "good" | "evil" | "jester";
export type DeathCause = "wolves" | "vote" | "poison" | "hunter";
export type ToggleableRole = "hunter" | "witch" | "jester";
export type Phase = "night" | "day";

export const ALIGNMENT_OF: Record<Role, Alignment> = {
  werewolf: "evil",
  seer: "good",
  doctor: "good",
  villager: "good",
  hunter: "good",
  witch: "good",
  jester: "neutral",
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
  /** Special roles excluded from the default distribution (replaced by villagers). */
  disabledRoles?: ToggleableRole[];
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
  cause: DeathCause;
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

export interface AccusationRecord {
  day: number;
  from: number;
  target: number;
  text: string;
}

export interface DefenseRecord {
  day: number;
  playerId: number;
  text: string;
}

export interface WolfChatRecord {
  day: number;
  wolfId: number;
  text: string;
}

/** Which of the witch's single-use potions are still unspent. */
export interface WitchPotions {
  heal: boolean;
  poison: boolean;
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
  wolfChat: WolfChatRecord[]; // wolves only; [] for everyone else
  potions: WitchPotions | null; // witch only
  // Public history visible to everyone:
  deaths: DeathRecord[];
  statements: StatementRecord[];
  votes: VoteRecord[];
  accusations: AccusationRecord[];
  defenses: DefenseRecord[];
  /** Engine-built behavioral summary of the living players; "" until data exists. */
  dossier: string;
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

export interface AccuseDecision {
  targetId: number | null; // null = pass
  text?: string;
}

export interface WitchDecision {
  heal: boolean;
  poisonTargetId: number | null;
}

export interface Brain {
  readonly id: string;
  nightAction(view: PlayerView): Promise<NightDecision>;
  dayStatement(view: PlayerView): Promise<string>;
  dayVote(view: PlayerView): Promise<VoteDecision>;
  // Optional Phase-1 powers; the engine substitutes safe defaults when absent.
  wolfChat?(view: PlayerView, round: number): Promise<string>;
  accuse?(view: PlayerView): Promise<AccuseDecision>;
  defend?(view: PlayerView, against: AccusationRecord[]): Promise<string>;
  witchAction?(view: PlayerView, wolfTargetId: number | null): Promise<WitchDecision>;
  hunterShot?(view: PlayerView): Promise<{ targetId: number | null }>;
}

export type BrainFactory = (modelId: string, seatId: number) => Brain;

// ---------------------------------------------------------------------------
// The transcript: an ordered, replayable record of everything that happened.
// ---------------------------------------------------------------------------

export type GameEvent =
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
  | {
      kind: "vote_result";
      day: number;
      tally: Record<number, number>;
      eliminatedId: number | null;
      tie: boolean;
    }
  | { kind: "game_over"; winner: Winner; reason: string; survivorIds: number[] };

export interface SeatOutcome {
  seatId: number;
  model: string;
  role: Role;
  alignment: Alignment;
  won: boolean;
  survived: boolean;
}

export interface GameResult {
  winner: Winner;
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
