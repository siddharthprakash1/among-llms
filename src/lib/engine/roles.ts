// Role-count derivation and seat assignment.

import { ALIGNMENT_OF, GameConfig, Player, Role, ToggleableRole } from "./types";
import { assignIdentities } from "./names";
import { Rng, shuffle } from "./rng";

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 12;

const WOLVES_BY_SIZE: Record<number, number> = { 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 3, 11: 3, 12: 4 };

const SPECIALS_BY_SIZE: Record<number, Role[]> = {
  5: ["seer", "doctor"],
  6: ["seer", "doctor", "hunter"],
  7: ["seer", "doctor", "hunter"],
  8: ["seer", "doctor", "hunter", "witch"],
  9: ["seer", "doctor", "hunter", "witch", "jester"],
  10: ["seer", "doctor", "hunter", "witch", "jester"],
  11: ["seer", "doctor", "hunter", "witch", "jester"],
  12: ["seer", "doctor", "hunter", "witch", "jester"],
};

/** Default role distribution for a table of `n` players (spec §3.8). */
export function defaultRoleCounts(n: number, disabled: ToggleableRole[] = []): Record<Role, number> {
  const clamped = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, n));
  const counts: Record<Role, number> = {
    werewolf: WOLVES_BY_SIZE[clamped],
    seer: 0,
    doctor: 0,
    hunter: 0,
    witch: 0,
    jester: 0,
    villager: 0,
  };
  for (const role of SPECIALS_BY_SIZE[clamped]) {
    if ((disabled as Role[]).includes(role)) continue;
    counts[role] += 1;
  }
  const nonVillager = (Object.keys(counts) as Role[])
    .filter((r) => r !== "villager")
    .reduce((acc, r) => acc + counts[r], 0);
  counts.villager = Math.max(0, clamped - nonVillager);
  return counts;
}

export function resolveRoleCounts(config: GameConfig): Record<Role, number> {
  const base = defaultRoleCounts(config.numPlayers, config.disabledRoles ?? []);
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
