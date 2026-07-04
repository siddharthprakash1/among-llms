// Display names + emoji avatars for table seats. Picked deterministically from
// the game seed so a given game always shows the same characters.

import { Rng, shuffle } from "./rng";

export const NAME_POOL = [
  "Aria",
  "Bishop",
  "Cleo",
  "Dax",
  "Echo",
  "Fable",
  "Gray",
  "Hazel",
  "Indigo",
  "Juno",
  "Kit",
  "Lux",
  "Mira",
  "Nox",
  "Onyx",
  "Pax",
  "Quinn",
  "Reza",
  "Sage",
  "Tahoe",
  "Vesper",
  "Wren",
];

export const AVATAR_POOL = [
  "🦊",
  "🐼",
  "🦉",
  "🐺",
  "🦝",
  "🐯",
  "🦁",
  "🐸",
  "🐙",
  "🦄",
  "🐲",
  "🦅",
  "🐱",
  "🐰",
  "🐻",
  "🦓",
  "🦔",
  "🐹",
  "🐨",
  "🦇",
  "🦌",
  "🐧",
];

export function assignIdentities(rng: Rng, count: number): { name: string; avatar: string }[] {
  const names = shuffle(rng, NAME_POOL);
  const avatars = shuffle(rng, AVATAR_POOL);
  const out: { name: string; avatar: string }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      name: names[i % names.length],
      avatar: avatars[i % avatars.length],
    });
  }
  return out;
}
