import { describe, expect, it, vi } from "vitest";
import { followFeedEnd } from "./ui";

function feed(scrollHeight = 1200) {
  const list = { scrollHeight, scrollTo: vi.fn() };
  const end = { scrollIntoView: vi.fn() };
  return { list, end };
}

describe("followFeedEnd", () => {
  it("scrolls only the list when nothing is pinned over the page, so a new line never moves the page", () => {
    const { list, end } = feed(1200);
    followFeedEnd(list, end, 0);
    expect(list.scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: "smooth" });
    expect(end.scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls the page past a pinned dock when there is one", () => {
    const { list, end } = feed();
    followFeedEnd(list, end, 260);
    expect(end.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(list.scrollTo).not.toHaveBeenCalled();
  });

  it("keeps the replay and live behaviour when the caller says nothing", () => {
    const { list, end } = feed();
    followFeedEnd(list, end, undefined);
    expect(end.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "end" });
    expect(list.scrollTo).not.toHaveBeenCalled();
  });

  it("does nothing before the feed is mounted", () => {
    expect(() => followFeedEnd(null, null, 0)).not.toThrow();
    expect(() => followFeedEnd(null, null, undefined)).not.toThrow();
  });
});
