// The deterministic "mock" brain. No network, no API key — pure heuristics over
// a seeded PRNG. It plays a real game of Werewolf with a believable information
// flow, so offline replays are balanced and fun to watch with zero setup:
//
//   • The Seer publicly claims wolves it has confirmed (a tagged statement).
//   • The village rallies its votes behind Seer claims.
//   • The Doctor protects the revealed Seer; the wolves try to silence it.
//   • Once any wolf is exposed, the village uses voting-alignment ("who kept
//     buddying the wolf?") to chain-catch the remaining wolves.

import {
  AccusationRecord,
  AccuseDecision,
  Brain,
  DecisionTrace,
  NightDecision,
  PlayerView,
  VoteDecision,
  WitchDecision,
} from "../engine/types";
import { makeRng, pick, Rng } from "../engine/rng";

const SEER_CLAIM_TAG = "🔮 SEER —";

function nameOf(view: PlayerView, id: number): string {
  return view.players.find((p) => p.id === id)?.name ?? `Seat ${id}`;
}

function aliveOthers(view: PlayerView): number[] {
  return view.aliveIds.filter((id) => id !== view.self.id);
}

/** How many votes each player has received across the whole game so far. */
function votesReceived(view: PlayerView): Map<number, number> {
  const m = new Map<number, number>();
  for (const v of view.votes) {
    if (v.targetId === null) continue;
    m.set(v.targetId, (m.get(v.targetId) ?? 0) + 1);
  }
  return m;
}

/** The living player the table currently suspects most (by votes received). */
function primeSuspect(view: PlayerView, rng: Rng, exclude: number[] = []): number | null {
  const received = votesReceived(view);
  const candidates = view.aliveIds.filter((id) => id !== view.self.id && !exclude.includes(id));
  if (candidates.length === 0) return null;
  let max = -1;
  for (const id of candidates) max = Math.max(max, received.get(id) ?? 0);
  if (max <= 0) return null;
  return pick(rng, candidates.filter((id) => (received.get(id) ?? 0) === max));
}

/** A wolf the seer has personally confirmed and who is still alive. */
function knownLiveWolfForSeer(view: PlayerView): number | null {
  const hit = view.seerResults.find(
    (r) => r.alignment === "evil" && view.aliveIds.includes(r.targetId)
  );
  return hit ? hit.targetId : null;
}

/** The (living, non-speaker) player a statement names, if any. */
function mentionedTarget(view: PlayerView, statement: { playerId: number; text: string }): number | null {
  for (const p of view.players) {
    if (p.id === statement.playerId) continue;
    if (new RegExp(`\\b${p.name}\\b`).test(statement.text)) return p.id;
  }
  return null;
}

function isSeerClaim(text: string): boolean {
  return text.startsWith(SEER_CLAIM_TAG);
}

/**
 * Wolves confirmed by a Seer claim that are still alive. Only the real Seer ever
 * emits the tagged claim, so this is trustworthy public information — it even
 * survives the Seer's death (the accusation stands).
 */
function activeSeerClaims(view: PlayerView): Map<number, number> {
  const m = new Map<number, number>();
  for (const s of view.statements) {
    if (!isSeerClaim(s.text)) continue;
    const t = mentionedTarget(view, s);
    if (t !== null && view.aliveIds.includes(t)) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

/** Living players who have publicly claimed to be the Seer (i.e. the Seer). */
function seerClaimants(view: PlayerView): number[] {
  const ids = new Set<number>();
  for (const s of view.statements) {
    if (isSeerClaim(s.text) && view.aliveIds.includes(s.playerId)) ids.add(s.playerId);
  }
  return [...ids];
}

/**
 * Behavioural suspicion: once a wolf has been revealed, living players who kept
 * voting the same targets as that wolf look like accomplices.
 */
function buddySuspicion(view: PlayerView): Map<number, number> {
  const scores = new Map<number, number>();
  const revealedWolves = new Set(
    view.deaths.filter((d) => d.role === "werewolf").map((d) => d.playerId)
  );
  if (revealedWolves.size === 0) return scores;

  const wolfVotesByDay = new Map<number, Set<number>>();
  for (const v of view.votes) {
    if (v.targetId === null || !revealedWolves.has(v.voterId)) continue;
    if (!wolfVotesByDay.has(v.day)) wolfVotesByDay.set(v.day, new Set());
    wolfVotesByDay.get(v.day)!.add(v.targetId);
  }
  for (const v of view.votes) {
    if (v.targetId === null || revealedWolves.has(v.voterId)) continue;
    if (v.voterId === view.self.id || !view.aliveIds.includes(v.voterId)) continue;
    if (wolfVotesByDay.get(v.day)?.has(v.targetId)) {
      scores.set(v.voterId, (scores.get(v.voterId) ?? 0) + 1);
    }
  }
  return scores;
}

/** Highest-scoring player among `allowed`, ties broken by the rng; null if none. */
function leaderOf(scores: Map<number, number>, rng: Rng, allowed: number[]): number | null {
  const entries = [...scores.entries()].filter(([id]) => allowed.includes(id));
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map(([, c]) => c));
  return pick(rng, entries.filter(([, c]) => c === max).map(([id]) => id));
}

type Stance = "accuse" | "defend" | "seer-claim" | "wolf-deflect" | "neutral";

const TEMPLATES: Record<Stance, string[]> = {
  accuse: [
    "{target} has been awfully quiet. That's exactly what a wolf hides behind.",
    "I don't buy {target}'s story — it keeps shifting. My vote's on them.",
    "The evidence points at {target}. Let's not lose our nerve now.",
    "Every night someone dies, and {target} always has a clean alibi. Convenient.",
    "I've made up my mind: {target} is the threat. We can't afford to wait.",
  ],
  defend: [
    "Pointing at me is exactly what the real wolf wants. Think about who started this.",
    "If you waste the vote on me, the wolves win by default. I'm village, I swear it.",
    "I get it, I look suspicious — but flip it: who benefits from burning me today?",
    "Lynch me and you'll see at dawn you were wrong. The wolf is still at this table.",
  ],
  "seer-claim": [
    "🔮 SEER — I scried {target} in the night. They are a WEREWOLF. Lynch {target} now.",
    "🔮 SEER — Believe me or die: {target} is a WEREWOLF. Put your vote on {target}.",
    "🔮 SEER — I've checked {target}. Werewolf. We end them today, no debate.",
  ],
  "wolf-deflect": [
    "We're wasting daylight. {target} is the obvious problem — let's move.",
    "I've been watching {target}. Too eager to accuse. Classic misdirection.",
    "Funny how {target} keeps steering us. I think they're hiding behind the noise.",
    "Stay focused, everyone. {target} is the one who doesn't add up.",
  ],
  neutral: [
    "I honestly don't have a read yet. Let's hear everyone before we swing the rope.",
    "Something's off today, but I can't place it. Keep talking — someone will slip.",
    "Quiet night, loud day. Let's not panic and hand the wolves a free kill.",
  ],
};

function render(view: PlayerView, stance: Stance, targetId: number | null, rng: Rng): string {
  const template = pick(rng, TEMPLATES[stance]);
  const target = targetId !== null ? nameOf(view, targetId) : "someone";
  return template.replace(/\{target\}/g, target).replace(/\{me\}/g, view.self.name);
}

const WOLF_CHAT_PROPOSE = [
  "I say we take {target} tonight — they're steering the village too well.",
  "{target} worries me. One bite and the problem is gone.",
  "Let's silence {target} before they put it together.",
];
const WOLF_CHAT_AGREE = [
  "Agreed. {target} doesn't see the dawn.",
  "Fine by me. {target} it is.",
  "Then it's settled — {target}.",
];
const ACCUSE_FORMAL = [
  "I formally accuse {target}. Their votes never add up.",
  "It has to be {target}. Watch who they defend.",
  "{target} has dodged every hard question. I accuse them.",
];
const JESTER_LINES = [
  "Strange, isn't it, how I always seem to know where the bodies are…",
  "Vote how you must. I was out walking by the mill last night, that's all.",
  "Honestly? I wouldn't even blame you for voting me out. Just saying.",
];
const REBUTTAL_TEMPLATES = [
  "Rich words from {target} — check whose votes always land beside the dead.",
  "Of course {target} points at me. Wolves always shout first.",
  "{target} accuses me to hide their own trail. Watch them tonight.",
];

function fillTarget(template: string, targetName: string): string {
  return template.replace(/\{target\}/g, targetName);
}

export interface MockStyle {
  /** 0 = passive/quiet, 1 = aggressive accuser who rarely abstains. */
  aggression: number;
  /** 0 = reckless, 1 = strongly self-preserving (defends, self-protects). */
  selfPreserve: number;
}

export const DEFAULT_STYLE: MockStyle = { aggression: 0.5, selfPreserve: 0.5 };

/**
 * Report why a move was made. Rationales are built ONLY from values the
 * heuristic already computed: nothing on this path may draw from the rng, or
 * every seeded mock game would change.
 */
function explain(trace: DecisionTrace | undefined, reasoning: string): void {
  if (!trace) return;
  trace.source = "bot";
  trace.reasoning = reasoning;
}

interface Choice {
  target: number;
  why: string;
}

export class MockBrain implements Brain {
  readonly id: string;
  private rng: Rng;
  private style: MockStyle;

  constructor(modelId: string, seed: number, style: MockStyle = DEFAULT_STYLE) {
    this.id = modelId;
    this.rng = makeRng(seed);
    this.style = style;
  }

  /**
   * Shared wolf target-picking heuristic: silence a revealed Seer first,
   * otherwise eliminate whoever looks most dangerous to the pack. Used by
   * both the night kill and wolf chat, so the pack's chatter matches its bite.
   */
  private wolfPick(view: PlayerView): Choice | null {
    const nonWolves = view.aliveIds.filter((id) => !view.knownWolves.includes(id));
    if (nonWolves.length === 0) return null;

    // Priority: silence a revealed Seer. It's the village's engine.
    const seers = seerClaimants(view).filter((id) => nonWolves.includes(id));
    if (seers.length > 0) {
      const target = pick(this.rng, seers);
      return {
        target,
        why: `${nameOf(view, target)} claimed Seer — silence them before they expose the pack.`,
      };
    }

    // Otherwise take out whoever is closing in on the pack.
    const threat = new Map<number, number>();
    for (const v of view.votes) {
      if (v.targetId !== null && view.knownWolves.includes(v.targetId)) {
        threat.set(v.voterId, (threat.get(v.voterId) ?? 0) + 1);
      }
    }
    let best = nonWolves[0];
    let bestScore = -1;
    for (const id of nonWolves) {
      const score = (threat.get(id) ?? 0) * 2 + this.rng();
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    }
    const n = threat.get(best) ?? 0;
    return {
      target: best,
      why:
        n > 0
          ? `${nameOf(view, best)} has voted against the pack ${n}× — the biggest threat to us.`
          : `Nobody is onto the pack yet; ${nameOf(view, best)} is as good a victim as any.`,
    };
  }

  /**
   * A wolf's daytime scapegoat. Sequential ifs (not a `??` chain) so each
   * branch can name its reason while short-circuiting in the same order.
   */
  private wolfFrame(view: PlayerView, others: number[]): Choice {
    const nonWolves = others.filter((id) => !view.knownWolves.includes(id));
    const pool = nonWolves.length ? nonWolves : others;
    const buddy = leaderOf(buddySuspicion(view), this.rng, pool);
    if (buddy !== null)
      return {
        target: buddy,
        why: `${nameOf(view, buddy)}'s votes lined up with a dead packmate — an easy frame.`,
      };
    const prime = primeSuspect(view, this.rng, view.knownWolves);
    if (prime !== null)
      return { target: prime, why: `The table already suspects ${nameOf(view, prime)}; pile on.` };
    const target = pick(this.rng, pool);
    return { target, why: `No heat on anyone yet; cast doubt on ${nameOf(view, target)}.` };
  }

  /** A villager's evidence-based read: a Seer claim first, then voting alignment. */
  private goodRead(
    view: PlayerView,
    claim: number | null,
    others: number[]
  ): { target: number; via: "claim" | "buddy" } | null {
    if (claim !== null) return { target: claim, via: "claim" };
    const buddy = leaderOf(buddySuspicion(view), this.rng, others);
    return buddy !== null ? { target: buddy, via: "buddy" } : null;
  }

  async nightAction(view: PlayerView, trace?: DecisionTrace): Promise<NightDecision> {
    if (view.self.role === "werewolf") {
      const choice = this.wolfPick(view);
      if (choice === null) {
        explain(trace, "No legal target tonight.");
        return { targetId: null };
      }
      explain(trace, choice.why);
      return { targetId: choice.target };
    }

    if (view.self.role === "seer") {
      const scanned = new Set(view.seerResults.map((r) => r.targetId));
      const unscanned = aliveOthers(view).filter((id) => !scanned.has(id));
      const pool = unscanned.length > 0 ? unscanned : aliveOthers(view);
      if (pool.length === 0) {
        explain(trace, "No one left to scan.");
        return { targetId: null };
      }
      const suspect = primeSuspect(view, this.rng);
      if (suspect !== null && pool.includes(suspect)) {
        explain(trace, `${nameOf(view, suspect)} is drawing the most votes — worth a look.`);
        return { targetId: suspect };
      }
      const target = pick(this.rng, pool);
      explain(
        trace,
        unscanned.length > 0
          ? `No strong lead; scanning ${nameOf(view, target)}, whom I haven't checked.`
          : `Everyone has been scanned; re-checking ${nameOf(view, target)}.`
      );
      return { targetId: target };
    }

    if (view.self.role === "doctor") {
      const others = aliveOthers(view);
      if (others.length === 0) {
        explain(trace, "Only I am left to guard.");
        return { targetId: view.self.id };
      }
      // Keep the revealed Seer alive above all else.
      const seers = seerClaimants(view).filter((id) => view.aliveIds.includes(id));
      if (seers.length > 0) {
        const target = pick(this.rng, seers);
        explain(trace, `Shield ${nameOf(view, target)}: a claimed Seer is the wolves' obvious target.`);
        return { targetId: target };
      }
      if (this.rng() < 0.15 + 0.3 * this.style.selfPreserve) {
        explain(trace, "No one worth the risk — guarding myself tonight.");
        return { targetId: view.self.id };
      }
      const target = pick(this.rng, others);
      explain(trace, `No Seer to protect; guessing the wolves go for ${nameOf(view, target)}.`);
      return { targetId: target };
    }

    explain(trace, "No night action for my role.");
    return { targetId: null }; // villagers have no night action
  }

  async dayStatement(view: PlayerView, trace?: DecisionTrace): Promise<string> {
    const others = aliveOthers(view);
    if (others.length === 0) {
      explain(trace, "Nobody left to persuade.");
      return "It's just the final few now. Choose carefully.";
    }

    // The Seer reveals a confirmed wolf.
    if (view.self.role === "seer") {
      const wolf = knownLiveWolfForSeer(view);
      if (wolf !== null) {
        explain(trace, `I've confirmed ${nameOf(view, wolf)} is a wolf — time to go public.`);
        return render(view, "seer-claim", wolf, this.rng);
      }
    }

    const claim = leaderOf(activeSeerClaims(view), this.rng, others);

    if (view.self.role === "jester") {
      explain(trace, "Look just guilty enough to draw the rope.");
      return this.rng() < 0.5 ? pick(this.rng, JESTER_LINES) : render(view, "neutral", null, this.rng);
    }

    if (view.self.alignment === "evil") {
      // If the Seer has fingered one of us, deflect onto a non-wolf.
      const frame = this.wolfFrame(view, others);
      explain(trace, frame.why);
      return render(view, "wolf-deflect", frame.target, this.rng);
    }

    // Good, non-seer: rally behind the Seer, then behavioural evidence.
    const read = this.goodRead(view, claim, others);
    if (read !== null) {
      explain(
        trace,
        read.via === "claim"
          ? `The Seer named ${nameOf(view, read.target)}. Rally behind it.`
          : `${nameOf(view, read.target)} kept voting alongside a revealed wolf.`
      );
      return render(view, "accuse", read.target, this.rng);
    }
    const votesOnMe = votesReceived(view).get(view.self.id) ?? 0;
    if (votesOnMe >= 2 && this.rng() < 0.4 + 0.4 * this.style.selfPreserve) {
      explain(trace, `I've drawn ${votesOnMe} votes — time to defend myself.`);
      return render(view, "defend", null, this.rng);
    }
    explain(trace, "No solid read yet; keep people talking.");
    return render(view, "neutral", null, this.rng);
  }

  async dayVote(view: PlayerView, trace?: DecisionTrace): Promise<VoteDecision> {
    const others = aliveOthers(view);
    if (others.length === 0) {
      explain(trace, "No one to vote for.");
      return { targetId: null };
    }

    if (view.self.role === "seer") {
      const wolf = knownLiveWolfForSeer(view);
      if (wolf !== null) {
        explain(trace, `Vote out ${nameOf(view, wolf)}, the wolf I confirmed.`);
        return { targetId: wolf };
      }
    }

    const claim = leaderOf(activeSeerClaims(view), this.rng, others);

    if (view.self.role === "jester") {
      const ps = primeSuspect(view, this.rng);
      if (ps !== null) {
        explain(trace, `Vote with the crowd on ${nameOf(view, ps)} so I blend in.`);
        return { targetId: ps };
      }
      const target = pick(this.rng, others);
      explain(trace, `No crowd to follow; a throwaway vote on ${nameOf(view, target)}.`);
      return { targetId: target };
    }

    if (view.self.alignment === "evil") {
      // Never reinforce a mob that has (correctly) turned on the pack; steer it
      // onto a villager instead.
      const frame = this.wolfFrame(view, others);
      explain(trace, frame.why);
      return { targetId: frame.target };
    }

    // Good: follow the Seer, then behavioural evidence. With no hard read,
    // abstain rather than risk lynching a fellow villager.
    const read = this.goodRead(view, claim, others);
    if (read !== null) {
      explain(
        trace,
        read.via === "claim"
          ? `The Seer named ${nameOf(view, read.target)}. Rally behind it.`
          : `${nameOf(view, read.target)} kept voting alongside a revealed wolf.`
      );
      return { targetId: read.target };
    }
    if ((votesReceived(view).get(view.self.id) ?? 0) === 0 && this.style.aggression > 0.75) {
      // Aggressive bots still apply pressure on the standing suspect.
      const ps = primeSuspect(view, this.rng);
      if (ps !== null) {
        explain(
          trace,
          `No hard read, but ${nameOf(view, ps)} is the standing suspect — keep the pressure on.`
        );
        return { targetId: ps };
      }
    }
    explain(trace, "No hard read — abstaining beats lynching a villager.");
    return { targetId: null };
  }

  async wolfChat(view: PlayerView, round: number, trace?: DecisionTrace): Promise<string> {
    const choice = this.wolfPick(view);
    if (choice === null) {
      explain(trace, "No one left to hunt.");
      return "";
    }
    const name = nameOf(view, choice.target);
    explain(
      trace,
      (round === 1 ? `Propose ${name}: ` : `Back the pack's pick, ${name}: `) + choice.why
    );
    const pool = round === 1 ? WOLF_CHAT_PROPOSE : WOLF_CHAT_AGREE;
    return fillTarget(pick(this.rng, pool), name);
  }

  async accuse(view: PlayerView, trace?: DecisionTrace): Promise<AccuseDecision> {
    const others = aliveOthers(view);
    if (others.length === 0) {
      explain(trace, "No one to accuse.");
      return { targetId: null };
    }
    if (view.self.role === "jester") {
      // Draw a little fire without being obvious.
      if (this.rng() < 0.4) {
        explain(trace, "Stay quiet this round — don't overplay it.");
        return { targetId: null };
      }
      const target = pick(this.rng, others);
      explain(trace, `A loose accusation at ${nameOf(view, target)} keeps eyes on me.`);
      return { targetId: target, text: fillTarget(pick(this.rng, ACCUSE_FORMAL), nameOf(view, target)) };
    }
    if (view.self.alignment === "evil") {
      const frame = this.wolfFrame(view, others);
      explain(trace, frame.why);
      return {
        targetId: frame.target,
        text: fillTarget(pick(this.rng, ACCUSE_FORMAL), nameOf(view, frame.target)),
      };
    }
    if (view.self.role === "seer") {
      const wolf = knownLiveWolfForSeer(view);
      if (wolf !== null) {
        explain(trace, `Put the wolf I confirmed, ${nameOf(view, wolf)}, on the record.`);
        return { targetId: wolf, text: fillTarget(pick(this.rng, ACCUSE_FORMAL), nameOf(view, wolf)) };
      }
    }
    const read = this.goodRead(view, leaderOf(activeSeerClaims(view), this.rng, others), others);
    if (read === null) {
      explain(trace, "Nothing solid enough to accuse on.");
      return { targetId: null };
    }
    const name = nameOf(view, read.target);
    if (this.rng() > 0.35 + 0.5 * this.style.aggression) {
      explain(trace, `Holding fire on ${name} for now.`);
      return { targetId: null };
    }
    explain(
      trace,
      read.via === "claim"
        ? `The Seer named ${name} — put it on the record.`
        : `${name} voted with a revealed wolf — put it on the record.`
    );
    return { targetId: read.target, text: fillTarget(pick(this.rng, ACCUSE_FORMAL), name) };
  }

  async defend(view: PlayerView, against: AccusationRecord[], trace?: DecisionTrace): Promise<string> {
    if (against.length > 0) {
      const accuser = nameOf(view, against[0].from);
      explain(trace, `Turn it back on ${accuser}, who accused me first.`);
      return fillTarget(pick(this.rng, REBUTTAL_TEMPLATES), accuser);
    }
    explain(trace, "Plead my case to the table.");
    return render(view, "defend", null, this.rng);
  }

  async witchAction(
    view: PlayerView,
    wolfTargetId: number | null,
    trace?: DecisionTrace
  ): Promise<WitchDecision> {
    const claimants = seerClaimants(view);
    if (
      view.potions?.heal &&
      wolfTargetId !== null &&
      (wolfTargetId === view.self.id || claimants.includes(wolfTargetId))
    ) {
      explain(
        trace,
        wolfTargetId === view.self.id
          ? "The wolves are coming for me — drink the heal."
          : `The wolves hit ${nameOf(view, wolfTargetId)}, our claimed Seer — worth the heal.`
      );
      return { heal: true, poisonTargetId: null };
    }
    if (view.potions?.poison) {
      const confirmed = leaderOf(activeSeerClaims(view), this.rng, aliveOthers(view));
      if (confirmed !== null) {
        explain(trace, `The Seer confirmed ${nameOf(view, confirmed)}; poison settles it.`);
        return { heal: false, poisonTargetId: confirmed };
      }
    }
    explain(trace, "Nothing worth a potion tonight.");
    return { heal: false, poisonTargetId: null };
  }

  async hunterShot(view: PlayerView, trace?: DecisionTrace): Promise<{ targetId: number | null }> {
    const others = view.aliveIds.filter((id) => id !== view.self.id);
    if (others.length === 0) {
      explain(trace, "No one left to shoot.");
      return { targetId: null };
    }
    const confirmed = leaderOf(activeSeerClaims(view), this.rng, others);
    if (confirmed !== null) {
      explain(trace, `Taking the Seer-confirmed wolf ${nameOf(view, confirmed)} with me.`);
      return { targetId: confirmed };
    }
    const prime = primeSuspect(view, this.rng);
    if (prime !== null) {
      explain(trace, `${nameOf(view, prime)} is the table's top suspect — my last arrow.`);
      return { targetId: prime };
    }
    const target = pick(this.rng, others);
    explain(trace, `No read — a blind shot at ${nameOf(view, target)}.`);
    return { targetId: target };
  }
}
