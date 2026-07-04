// Role-count derivation and seat assignment.

import { ALIGNMENT_OF, GameConfig, Player, Role } from "./types";
import { assignIdentities } from "./names";
import { Rng, shuffle } from "./rng";

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 12;

/** Default role distribution for a table of `n` players. */
export function defaultRoleCounts(n: number): Record<Role, number> {
  const clamped = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
  const werewolves = Math.max(1, Math.round(clamped / 4));
  const seer = 1;
  const doctor = 1;
  const villager = Math.max(0, clamped - werewolves - seer - doctor);
  return { werewolf: werewolves, seer, doctor, villager };
}

export function resolveRoleCounts(config: GameConfig): Record<Role, number> {
  const base = defaultRoleCounts(config.numPlayers);
  if (!config.roleCounts) return base;
  const merged: Record<Role, number> = { ...base, ...config.roleCounts } as Record<Role, number>;
  return merged;
}

/** Build the role list (one entry per seat) from counts, then validate the total. */
export function rolesFromCounts(counts: Record<Role, number>): Role[] {
  const roles: Role[] = [];
  (Object.keys(counts) as Role[]).forEach((role) => {
    for (let i = 0; i < counts[role]; i++) roles.push(role);
  });
  return roles;
}

/**
 * Create the seated players for a game: assign identities (name/avatar) by seat,
 * then shuffle the role list and deal one role per seat. Deterministic given rng.
 */
export function buildPlayers(config: GameConfig, rng: Rng): Player[] {
  const counts = resolveRoleCounts(config);
  const roleList = rolesFromCounts(counts);
  if (roleList.length !== config.numPlayers) {
    throw new Error(
      `Role counts (${roleList.length}) do not match numPlayers (${config.numPlayers}).`
    );
  }
  if (config.seatModels.length !== config.numPlayers) {
    throw new Error(
      `seatModels length (${config.seatModels.length}) does not match numPlayers (${config.numPlayers}).`
    );
  }
  const dealtRoles = shuffle(rng, roleList);
  const identities = assignIdentities(rng, config.numPlayers);

  return Array.from({ length: config.numPlayers }, (_, id) => {
    const role = dealtRoles[id];
    return {
      id,
      name: identities[id].name,
      avatar: identities[id].avatar,
      model: config.seatModels[id],
      role,
      alignment: ALIGNMENT_OF[role],
      alive: true,
    } satisfies Player;
  });
}
