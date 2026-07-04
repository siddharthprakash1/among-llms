// Deterministic per-player behavioral summary injected into prompts so agents
// can cite history ("you voted with the dead wolf on day 2") without the
// engine shipping full verbatim history every day.

import { AccusationRecord, DeathRecord, VoteRecord } from "./types";

interface DossierPlayer {
  id: number;
  name: string;
  alive: boolean;
}

export function buildDossier(
  players: DossierPlayer[],
  votes: VoteRecord[],
  accusations: AccusationRecord[],
  deaths: DeathRecord[]
): string {
  if (votes.length === 0 && accusations.length === 0) return "";
  const name = (id: number) => players.find((p) => p.id === id)?.name ?? `Seat ${id}`;
  const revealedInnocents = new Set(
    deaths.filter((d) => d.role !== "werewolf").map((d) => d.playerId)
  );
  const lines: string[] = [];
  for (const p of players) {
    if (!p.alive) continue;
    const cast = votes.filter((v) => v.voterId === p.id && v.targetId !== null);
    const made = accusations.filter((a) => a.from === p.id);
    const received = accusations.filter((a) => a.target === p.id).length;
    const badVotes = cast.filter((v) => revealedInnocents.has(v.targetId!)).length;
    const parts: string[] = [];
    if (cast.length)
      parts.push(`voted: ${cast.map((v) => `${name(v.targetId!)}(D${v.day})`).join(", ")}`);
    if (made.length)
      parts.push(`accused: ${made.map((a) => `${name(a.target)}(D${a.day})`).join(", ")}`);
    if (received) parts.push(`accused by ${received}`);
    if (badVotes) parts.push(`${badVotes} vote(s) against players revealed innocent`);
    if (parts.length) lines.push(`${p.name}: ${parts.join("; ")}`);
  }
  return lines.join("\n");
}
