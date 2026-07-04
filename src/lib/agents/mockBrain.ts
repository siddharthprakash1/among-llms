// The deterministic "mock" brain. No network, no API key — pure heuristics over
// a seeded PRNG. It plays a real game of Werewolf with a believable information
// flow, so offline replays are balanced and fun to watch with zero setup:
//
//   • The Seer publicly claims wolves it has confirmed (a tagged statement).
//   • The village rallies its votes behind Seer claims.
//   • The Doctor protects the revealed Seer; the wolves try to silence it.
//   • Once any wolf is exposed, the village uses voting-alignment ("who kept
//     buddying the wolf?") to chain-catch the remaining wolves.

import { Brain, NightDecision, PlayerView, VoteDecision } from "../engine/types";
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

export interface MockStyle {
  /** 0 = passive/quiet, 1 = aggressive accuser who rarely abstains. */
  aggression: number;
  /** 0 = reckless, 1 = strongly self-preserving (defends, self-protects). */
  selfPreserve: number;
}

export const DEFAULT_STYLE: MockStyle = { aggression: 0.5, selfPreserve: 0.5 };

export class MockBrain implements Brain {
  readonly id: string;
  private rng: Rng;
  private style: MockStyle;

  constructor(modelId: string, seed: number, style: MockStyle = DEFAULT_STYLE) {
    this.id = modelId;
    this.rng = makeRng(seed);
    this.style = style;
  }

  async nightAction(view: PlayerView): Promise<NightDecision> {
    if (view.self.role === "werewolf") {
      const others = aliveOthers(view);
      const nonWolves = view.aliveIds.filter((id) => !view.knownWolves.includes(id));
      if (nonWolves.length === 0) return { targetId: null };

      // Priority: silence a revealed Seer. It's the village's engine.
      const seers = seerClaimants(view).filter((id) => nonWolves.includes(id));
      if (seers.length > 0) return { targetId: pick(this.rng, seers), note: "Silence the Seer." };

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
      void others;
      return { targetId: best, note: "Eliminate the villager most dangerous to the pack." };
    }

    if (view.self.role === "seer") {
      const scanned = new Set(view.seerResults.map((r) => r.targetId));
      const unscanned = aliveOthers(view).filter((id) => !scanned.has(id));
      const pool = unscanned.length > 0 ? unscanned : aliveOthers(view);
      if (pool.length === 0) return { targetId: null };
      const suspect = primeSuspect(view, this.rng);
      const target = suspect !== null && pool.includes(suspect) ? suspect : pick(this.rng, pool);
      return { targetId: target, note: "Reveal the truth about a suspicious neighbor." };
    }

    if (view.self.role === "doctor") {
      const others = aliveOthers(view);
      if (others.length === 0) return { targetId: view.self.id };
      // Keep the revealed Seer alive above all else.
      const seers = seerClaimants(view).filter((id) => view.aliveIds.includes(id));
      if (seers.length > 0) return { targetId: pick(this.rng, seers), note: "Shield the Seer." };
      if (this.rng() < 0.15 + 0.3 * this.style.selfPreserve)
        return { targetId: view.self.id, note: "Guard myself tonight." };
      return { targetId: pick(this.rng, others), note: "Shield a likely target." };
    }

    return { targetId: null }; // villagers have no night action
  }

  async dayStatement(view: PlayerView): Promise<string> {
    const others = aliveOthers(view);
    if (others.length === 0) return "It's just the final few now. Choose carefully.";

    // The Seer reveals a confirmed wolf.
    if (view.self.role === "seer") {
      const wolf = knownLiveWolfForSeer(view);
      if (wolf !== null) return render(view, "seer-claim", wolf, this.rng);
    }

    const claim = leaderOf(activeSeerClaims(view), this.rng, others);

    if (view.self.alignment === "evil") {
      // If the Seer has fingered one of us, deflect onto a non-wolf.
      const nonWolves = others.filter((id) => !view.knownWolves.includes(id));
      const pool = nonWolves.length ? nonWolves : others;
      const target =
        leaderOf(buddySuspicion(view), this.rng, pool) ??
        primeSuspect(view, this.rng, view.knownWolves) ??
        pick(this.rng, pool);
      return render(view, "wolf-deflect", target, this.rng);
    }

    // Good, non-seer: rally behind the Seer, then behavioural evidence.
    const suspect = claim ?? leaderOf(buddySuspicion(view), this.rng, others);
    if (suspect !== null) return render(view, "accuse", suspect, this.rng);
    const iAmSuspect = (votesReceived(view).get(view.self.id) ?? 0) >= 2;
    if (iAmSuspect && this.rng() < 0.4 + 0.4 * this.style.selfPreserve)
      return render(view, "defend", null, this.rng);
    return render(view, "neutral", null, this.rng);
  }

  async dayVote(view: PlayerView): Promise<VoteDecision> {
    const others = aliveOthers(view);
    if (others.length === 0) return { targetId: null };

    if (view.self.role === "seer") {
      const wolf = knownLiveWolfForSeer(view);
      if (wolf !== null) return { targetId: wolf, note: "Vote the confirmed wolf." };
    }

    const claim = leaderOf(activeSeerClaims(view), this.rng, others);

    if (view.self.alignment === "evil") {
      // Never reinforce a mob that has (correctly) turned on the pack; steer it
      // onto a villager instead.
      const nonWolves = others.filter((id) => !view.knownWolves.includes(id));
      const pool = nonWolves.length ? nonWolves : others;
      const target =
        leaderOf(buddySuspicion(view), this.rng, pool) ??
        primeSuspect(view, this.rng, view.knownWolves) ??
        pick(this.rng, pool);
      return { targetId: target, note: "Thin the village." };
    }

    // Good: follow the Seer, then behavioural evidence. With no hard read,
    // abstain rather than risk lynching a fellow villager.
    const suspect = claim ?? leaderOf(buddySuspicion(view), this.rng, others);
    if (suspect !== null) return { targetId: suspect };
    if ((votesReceived(view).get(view.self.id) ?? 0) === 0 && this.style.aggression > 0.75) {
      // Aggressive bots still apply pressure on the standing suspect.
      const ps = primeSuspect(view, this.rng);
      if (ps !== null) return { targetId: ps };
    }
    return { targetId: null };
  }
}
