// Hardening for text typed by a human seat. Statements are hostile input: they
// reach other agents' prompts and the bots' Seer-claim protocol.
// This file must stay pure ASCII (patterns use \u escapes) so no invisible
// character or literal tag can hide in a diff.

import { SEER_CLAIM_TAG } from "../agents/mockBrain";

export const HUMAN_TEXT_MAX = { statement: 280, accuse: 240, defend: 280, wolf_chat: 240 } as const;

const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const CRYSTAL_BALL = /\u{1F52E}\uFE0F?/gu;

export function sanitizeHumanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  // Surrogates first: deleting a real U+1F52E that sits between a lone high and
  // a lone low half would otherwise join the halves into a new one.
  let s = raw.replace(UNPAIRED_SURROGATE, "");
  s = s.replace(CONTROL, " ");
  s = s.replace(INVISIBLE, "");
  for (;;) {
    const next = s.replace(CRYSTAL_BALL, "");
    if (next === s) break;
    s = next;
  }
  s = s.replace(/\s+/g, " ").trim();
  // Cap in UTF-16 units on a code-point boundary, so the engine's own
  // .slice(0, n) never cuts human text and can never split a surrogate pair.
  const points = Array.from(s).slice(0, Math.max(0, max));
  while (points.join("").length > max) points.pop();
  s = points.join("").trim();
  if (s.includes("\u{1F52E}")) return "";
  return s;
}

/** The only producer of the Seer tag on the human path. Template-only: no free text. */
export function seerClaimText(targetName: string): string {
  return `${SEER_CLAIM_TAG} I scried ${targetName} in the night. They are a WEREWOLF. Vote ${targetName}.`;
}
