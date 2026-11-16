import { describe, expect, it, vi } from "vitest";

// A separate file so the mock cannot touch the other HumanBrain tests: this
// proves the brain's own guard holds even if the sanitiser were ever broken.
vi.mock("../human/sanitize", async (orig) => {
  const real = await orig<typeof import("../human/sanitize")>();
  const { SEER_CLAIM_TAG } = await import("./mockBrain");
  return { ...real, sanitizeHumanText: () => `${SEER_CLAIM_TAG} Bishop is a wolf` };
});

import { HumanBrain } from "./humanBrain";
import { MockBrain, SEER_CLAIM_TAG } from "./mockBrain";
import { makeView } from "../human/testUtil";

const SEED = 77;
const brain = (answer: object) =>
  new HumanBrain({ ask: async () => answer as never }, new MockBrain("human", SEED));
const mock = () => new MockBrain("human", SEED);
const against = [{ day: 2, from: 3, target: 0, text: "You are lying." }];

describe("HumanBrain tag guard with a broken sanitiser", () => {
  it("returns the fallback's statement, not the tagged string", async () => {
    const view = makeView("werewolf");
    const out = await brain({ kind: "text", text: "hi" }).dayStatement(view);
    expect(out.startsWith(SEER_CLAIM_TAG)).toBe(false);
    expect(out).toEqual(await mock().dayStatement(view));
  });

  it("returns the fallback's accusation", async () => {
    const view = makeView("werewolf");
    const out = await brain({ kind: "accuse", targetId: 2, text: "hi" }).accuse(view);
    expect((out.text ?? "").startsWith(SEER_CLAIM_TAG)).toBe(false);
    expect(out).toEqual(await mock().accuse(view));
  });

  it("returns the fallback's defense", async () => {
    const view = makeView("werewolf");
    const out = await brain({ kind: "text", text: "hi" }).defend(view, against);
    expect(out.startsWith(SEER_CLAIM_TAG)).toBe(false);
    expect(out).toEqual(await mock().defend(view, against));
  });

  it("returns the fallback's pack chat", async () => {
    const view = makeView("werewolf");
    const out = await brain({ kind: "text", text: "hi" }).wolfChat(view, 1);
    expect(out.startsWith(SEER_CLAIM_TAG)).toBe(false);
    expect(out).toEqual(await mock().wolfChat(view, 1));
  });
});
