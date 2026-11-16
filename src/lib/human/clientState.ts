// Pure client helpers: turn what a seat stream delivered into the Transcript
// shape the replay reducer understands, and into the seat's private knowledge.

import { ALIGNMENT_OF, type GameEvent, type Player, type Transcript } from "../engine/types";
import type { SeatEvent, SeatKnowledge, SeatMeta, SeatRevealEvent } from "./types";

/** Reconnects that skip ids can leave holes; only the gapless start is trustworthy. */
function contiguousPrefix(items: (SeatEvent | undefined)[]): SeatEvent[] {
  const out: SeatEvent[] = [];
  for (let i = 0; i < items.length; i++) {
    const ev = items[i];
    if (ev === undefined || ev === null) break;
    out.push(ev);
  }
  return out;
}

export function seatTranscript(
  meta: SeatMeta,
  items: (SeatEvent | undefined)[]
): { transcript: Transcript; knownIds: Set<number>; empty: boolean } {
  const prefix = contiguousPrefix(items);

  let revealAt = -1;
  for (let i = prefix.length - 1; i >= 0; i--) {
    if (prefix[i].kind === "seat_reveal") {
      revealAt = i;
      break;
    }
  }
  const reveal = revealAt >= 0 ? (prefix[revealAt] as SeatRevealEvent) : null;

  const notReveal = (e: SeatEvent | GameEvent): e is GameEvent => e.kind !== "seat_reveal";
  const events: GameEvent[] =
    reveal?.final && reveal.events
      ? [...reveal.events, ...prefix.slice(revealAt + 1).filter(notReveal)]
      : prefix.filter(notReveal);

  // Placeholder roles are never rendered: a seat shows a role only once it is in knownIds.
  const players: Player[] = meta.players.map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    model: p.model,
    role: "villager",
    alignment: "good",
    alive: true,
  }));
  const knownIds = new Set<number>();
  const fill = (id: number, role: Player["role"], alignment: Player["alignment"]) => {
    const p = players[id];
    if (!p) return;
    p.role = role;
    p.alignment = alignment;
    knownIds.add(id);
  };
  fill(meta.you.seatId, meta.you.role, meta.you.alignment);
  for (const id of meta.packmates) fill(id, "werewolf", "evil");
  for (const ev of prefix) if (ev.kind === "death") fill(ev.playerId, ev.role, ALIGNMENT_OF[ev.role]);
  if (reveal) for (const p of reveal.players) fill(p.id, p.role, p.alignment);

  const transcript: Transcript = {
    id: meta.id,
    createdAt: meta.createdAt,
    config: { numPlayers: meta.numPlayers, seatModels: players.map((p) => p.model), seed: 0 },
    players,
    events,
    result: { winner: "good", reason: "", survivorIds: [], days: 0 },
    outcomes: [],
  };
  return { transcript, knownIds, empty: events.length === 0 };
}

/** Reads only the seat's own events, so it stays correct in ghost view. */
export function seatKnowledge(meta: SeatMeta, items: (SeatEvent | undefined)[]): SeatKnowledge {
  const me = meta.you.seatId;
  const knowledge: SeatKnowledge = {
    visions: [],
    lastProtectedId: null,
    potions: meta.you.role === "witch" ? { heal: true, poison: true } : null,
  };
  for (const ev of contiguousPrefix(items)) {
    if (ev.kind === "seer_check" && ev.seerId === me) {
      knowledge.visions.push({ day: ev.day, targetId: ev.targetId, alignment: ev.result });
    } else if (ev.kind === "doctor_save" && ev.doctorId === me) {
      knowledge.lastProtectedId = ev.targetId;
    } else if (ev.kind === "witch_action" && ev.witchId === me && knowledge.potions) {
      knowledge.potions[ev.action] = false;
    }
  }
  return knowledge;
}

/**
 * What Enter does in one of the dock's single-line text fields. Blank text is
 * never sent this way: the fields are auto-focused, so a stray Enter would
 * otherwise forfeit the turn. Passing is done with its own button.
 */
export function textKeyAction(
  e: { key: string; shiftKey?: boolean; isComposing?: boolean },
  text: string,
  allowBlank = false
): "send" | "swallow" | "ignore" {
  // Enter that confirms an IME composition belongs to the IME.
  if (e.key !== "Enter" || e.isComposing) return "ignore";
  if (e.shiftKey) return "swallow";
  return allowBlank || text.trim() !== "" ? "send" : "swallow";
}
