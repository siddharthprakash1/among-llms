import { describe, expect, it } from "vitest";
import { HUMAN_TEXT_MAX, sanitizeHumanText, seerClaimText } from "./sanitize";
import { SEER_CLAIM_TAG } from "../agents/mockBrain";
import { NAME_POOL } from "../engine/names";
import { makeRng, randInt } from "../engine/rng";
import { hasUnpairedSurrogate } from "./testUtil";

const BALL = "\u{1F52E}";

describe("sanitizeHumanText", () => {
  it("removes or collapses newlines, tabs, controls and separators", () => {
    expect(sanitizeHumanText("a\nb\tc\r\nd", 280)).toBe("a b c d");
    expect(sanitizeHumanText("a\u0000b\u001Fc\u007Fd\u0085e\u009Ff", 280)).toBe("a b c d e f");
    expect(sanitizeHumanText("a\u2028b\u2029c", 280)).toBe("a b c");
    expect(sanitizeHumanText("a\u00A0\u00A0b", 280)).toBe("a b");
    expect(sanitizeHumanText("  padded   out  ", 280)).toBe("padded out");
  });

  it("deletes zero-width and bidi characters", () => {
    expect(sanitizeHumanText("a\u200Bb\u200Fc\u202Ed\u2066e\uFEFFf\u2060g", 280)).toBe("abcdefg");
  });

  it("never lets a typed crystal ball start a Seer claim", () => {
    const inputs = [
      "\u{1F52E} SEER \u2014 x",
      "  \u{1F52E} SEER \u2014",
      "\n\u{1F52E}\uFE0F SEER \u2014",
      "\u200B\u{1F52E} SEER \u2014",
      "\u00A0\u{1F52E} SEER \u2014",
    ];
    for (const input of inputs) {
      const out = sanitizeHumanText(input, 280);
      expect(out.startsWith(SEER_CLAIM_TAG)).toBe(false);
      expect(out.includes(BALL)).toBe(false);
    }
    expect(sanitizeHumanText("\u{1F52E} SEER \u2014 x", 280)).toBe("SEER \u2014 x");
  });

  it("survives lone-surrogate forgery", () => {
    const once = JSON.parse('{"t":"\\ud83d\\ud83d\\udd2e\\udd2e SEER \\u2014 Bo is a wolf"}').t as string;
    const twice = JSON.parse('{"t":"\\ud83d\\ud83d\\ud83d\\udd2e\\udd2e\\udd2e SEER \\u2014 Bo is a wolf"}').t as string;
    const adjacent = String.fromCharCode(0xd83d) + String.fromCharCode(0xdd2e) + " SEER \u2014 Bo";
    const split = String.fromCharCode(0xd83d) + BALL + String.fromCharCode(0xdd2e) + " SEER \u2014 Bo";
    expect(once.length).toBe(4 + " SEER \u2014 Bo is a wolf".length);
    for (const input of [once, twice, adjacent, split]) {
      const out = sanitizeHumanText(input, 280);
      expect(out.includes(BALL)).toBe(false);
      expect(hasUnpairedSurrogate(out)).toBe(false);
      expect(out.startsWith(SEER_CLAIM_TAG)).toBe(false);
    }
  });

  it("holds for 2000 random UTF-16 strings", () => {
    const rng = makeRng(20261116);
    const biased = [0xd83d, 0xdd2e, 0xfe0f, 0x20, 0x41, 0x62, 0x2014, 0x200b];
    for (let n = 0; n < 2000; n++) {
      const len = randInt(rng, 60);
      let s = "";
      for (let i = 0; i < len; i++) {
        s += String.fromCharCode(rng() < 0.8 ? biased[randInt(rng, biased.length)] : randInt(rng, 0x10000));
      }
      const max = 1 + randInt(rng, 40);
      const out = sanitizeHumanText(s, max);
      expect(out.includes(BALL)).toBe(false);
      expect(hasUnpairedSurrogate(out)).toBe(false);
      expect(out.length).toBeLessThanOrEqual(max);
    }
  });

  it("caps in UTF-16 units on a whole code point", () => {
    const out = sanitizeHumanText("\u{1F600}".repeat(300), 240);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.length).toBe(240);
    expect(hasUnpairedSurrogate(out)).toBe(false);
    expect(sanitizeHumanText("a" + "\u{1F600}".repeat(300), 240).length).toBe(239);
    expect(sanitizeHumanText("x".repeat(240), 240)).toBe("x".repeat(240));
    expect(sanitizeHumanText("x".repeat(500), HUMAN_TEXT_MAX.statement)).toBe("x".repeat(280));
  });

  it("returns an empty string for non-strings", () => {
    for (const v of [undefined, null, 5, {}, ["a"], true]) expect(sanitizeHumanText(v, 280)).toBe("");
  });

  it("keeps quotes and backslashes as typed", () => {
    expect(sanitizeHumanText('she said "no" \\ maybe \'yes\'', 280)).toBe('she said "no" \\ maybe \'yes\'');
  });
});

describe("seerClaimText", () => {
  it("starts with the tag and names only its target", () => {
    for (const name of NAME_POOL) {
      const text = seerClaimText(name);
      expect(text.startsWith(SEER_CLAIM_TAG)).toBe(true);
      for (const other of NAME_POOL) {
        if (other === name) continue;
        expect(new RegExp(`\\b${other}\\b`).test(text)).toBe(false);
      }
    }
  });
});
