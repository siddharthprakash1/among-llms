// Model profile aggregation: folds a model's ELO rating together with its
// historical transcripts into a single display-ready profile. Pure — callers
// supply the transcripts (and rating) and get back plain data to render.

import { Transcript, Player, SeatOutcome } from "./engine/types";
import { ModelRating, emptyRating } from "./elo";

export interface HeadToHead {
  opponent: string;
  games: number;
  wins: number;
  losses: number;
}

export interface ModelProfile {
  model: string;
  rating: ModelRating; // normalized (asJester/history defaulted)
  perRole: Record<string, { games: number; wins: number }>;
  voteAccuracy: { hits: number; total: number }; // village-aligned day votes that hit actual wolves
  survivalRate: { survived: number; games: number };
  headToHead: HeadToHead[]; // sorted by games desc
  recentGames: { id: string; createdAt: string; role: string; won: boolean; winner: string }[]; // newest first, cap 20
}

const RECENT_GAMES_CAP = 20;

/** Normalize a possibly-legacy rating (missing asJester/history). Exported for reuse. */
export function normalizeRating(model: string, r: Partial<ModelRating> | undefined): ModelRating {
  const base = emptyRating(model);
  return {
    ...base,
    ...(r ?? {}),
    model,
    asWolf: { ...base.asWolf, ...(r?.asWolf ?? {}) },
    asVillage: { ...base.asVillage, ...(r?.asVillage ?? {}) },
    asJester: { ...base.asJester, ...(r?.asJester ?? {}) },
    history: r?.history ?? [],
  };
}

/** All seats occupied by `model` in a transcript, in seatId order. */
function seatsFor(model: string, transcript: Transcript): Player[] {
  return transcript.players.filter((p) => p.model === model).sort((a, b) => a.id - b.id);
}

function outcomeFor(seatId: number, transcript: Transcript): SeatOutcome | undefined {
  return transcript.outcomes.find((o) => o.seatId === seatId);
}

/** Fold transcripts into a profile. Pure — caller supplies transcripts + rating. */
export function buildProfile(model: string, rating: Partial<ModelRating> | undefined, transcripts: Transcript[]): ModelProfile {
  const normalizedRating = normalizeRating(model, rating);

  const perRole: Record<string, { games: number; wins: number }> = {};
  let voteHits = 0;
  let voteTotal = 0;
  let survived = 0;
  let survivalGames = 0;
  const headToHeadMap = new Map<string, HeadToHead>();
  const recentGamesAll: { id: string; createdAt: string; role: string; won: boolean; winner: string }[] = [];

  for (const transcript of transcripts) {
    const mySeats = seatsFor(model, transcript);
    if (mySeats.length === 0) continue;

    // --- perRole + survivalRate -------------------------------------------
    for (const seat of mySeats) {
      const o = outcomeFor(seat.id, transcript);
      const won = o?.won ?? false;
      const role = seat.role;
      if (!perRole[role]) perRole[role] = { games: 0, wins: 0 };
      perRole[role].games += 1;
      if (won) perRole[role].wins += 1;

      survivalGames += 1;
      if (o?.survived) survived += 1;
    }

    // --- voteAccuracy -------------------------------------------------------
    // Only good-aligned seats of `model`; count that seat's vote events with
    // a non-null target; a hit = target seat's role is werewolf.
    const goodSeatIds = new Set(mySeats.filter((s) => s.alignment === "good").map((s) => s.id));
    if (goodSeatIds.size > 0) {
      for (const event of transcript.events) {
        if (event.kind !== "vote") continue;
        if (!goodSeatIds.has(event.voterId)) continue;
        if (event.targetId === null) continue;
        voteTotal += 1;
        const target = transcript.players.find((p) => p.id === event.targetId);
        if (target?.role === "werewolf") voteHits += 1;
      }
    }

    // --- headToHead -----------------------------------------------------
    // Opponent relationship: another model with a seat whose alignment
    // differs from one of `model`'s seats' alignments in this game. Jester
    // (neutral) seats never participate as either side.
    const myAlignments = new Set(mySeats.map((s) => s.alignment).filter((a) => a !== "neutral"));
    if (myAlignments.size > 0) {
      // Determine, for each opposing model present in this game, whether
      // "my side" (union of my alignments) won or lost. One increment per
      // opponent per game, regardless of how many opposing seats they hold.
      const opponentModels = new Map<string, "good" | "evil">(); // model -> their alignment (opposing one)
      for (const p of transcript.players) {
        if (p.model === model) continue;
        if (p.alignment === "neutral") continue;
        if (myAlignments.has(p.alignment)) continue; // same side, not an opponent
        if (!opponentModels.has(p.model)) opponentModels.set(p.model, p.alignment as "good" | "evil");
      }
      if (opponentModels.size > 0) {
        // Did "my side" win? Any of my seats with won=true means my side won.
        const mySideWon = mySeats.some((seat) => outcomeFor(seat.id, transcript)?.won);
        for (const [opponent] of opponentModels) {
          if (!headToHeadMap.has(opponent)) {
            headToHeadMap.set(opponent, { opponent, games: 0, wins: 0, losses: 0 });
          }
          const entry = headToHeadMap.get(opponent)!;
          entry.games += 1;
          if (mySideWon) entry.wins += 1;
          else entry.losses += 1;
        }
      }
    }

    // --- recentGames ------------------------------------------------------
    const firstSeat = mySeats[0];
    const won = mySeats.some((seat) => outcomeFor(seat.id, transcript)?.won);
    recentGamesAll.push({
      id: transcript.id,
      createdAt: transcript.createdAt,
      role: firstSeat.role,
      won,
      winner: transcript.result.winner,
    });
  }

  const headToHead = Array.from(headToHeadMap.values()).sort((a, b) => b.games - a.games);
  const recentGames = recentGamesAll
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, RECENT_GAMES_CAP);

  return {
    model,
    rating: normalizedRating,
    perRole,
    voteAccuracy: { hits: voteHits, total: voteTotal },
    survivalRate: { survived, games: survivalGames },
    headToHead,
    recentGames,
  };
}

// ---------------------------------------------------------------------------
// I/O helper — the only impure export in this module. Assembles a
// ModelProfile straight from the store, for use by the profile page/route.
// Kept separate from the pure fold functions above.
// ---------------------------------------------------------------------------

import { store } from "./store";

const SUMMARIES_SCAN_LIMIT = 200;
const TRANSCRIPTS_FOLD_CAP = 60;

/**
 * Assemble a model's profile from persisted data: scans the most recent
 * `SUMMARIES_SCAN_LIMIT` game summaries for ones involving `model`, loads at
 * most the `TRANSCRIPTS_FOLD_CAP` most recent of those transcripts, and folds
 * them together with the model's leaderboard rating via `buildProfile`.
 *
 * Returns null when the model has no games among the scanned summaries AND
 * no leaderboard entry (i.e. there's nothing to show).
 */
export async function assembleProfile(model: string): Promise<ModelProfile | null> {
  const [summaries, board] = await Promise.all([store.listSummaries(SUMMARIES_SCAN_LIMIT), store.getLeaderboard()]);

  const rating = board[model];
  const matching = summaries
    .filter((s) => s.models.includes(model))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, TRANSCRIPTS_FOLD_CAP);

  if (matching.length === 0 && !rating) return null;

  const transcripts = (
    await Promise.all(matching.map((s) => store.getTranscript(s.id)))
  ).filter((t): t is NonNullable<typeof t> => t !== null);

  return buildProfile(model, rating, transcripts);
}
