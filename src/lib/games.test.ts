import { describe, expect, it } from "vitest";
import { buildConfig } from "./games";

describe("buildConfig", () => {
  it("sanitizes disabledRoles to known toggleable roles only", () => {
    const config = buildConfig({
      numPlayers: 9,
      seatModels: [],
      seed: 1,
      disabledRoles: ["jester", "bogus"],
    });
    expect(config.disabledRoles).toEqual(["jester"]);
  });

  it("omits the disabledRoles key entirely when none are requested", () => {
    const config = buildConfig({ numPlayers: 9, seatModels: [], seed: 1 });
    expect(config).not.toHaveProperty("disabledRoles");
  });
});
