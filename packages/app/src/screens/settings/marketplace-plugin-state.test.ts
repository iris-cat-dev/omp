import { describe, expect, it } from "vitest";
import { getMarketplacePluginState, hasNewerMarketplaceVersion } from "./marketplace-plugin-state";

describe("marketplace updates", () => {
  it.each([
    ["1.9.0", "1.10.0", true],
    ["1.0.0", "2.0.0", true],
    ["2.0.0", "1.0.0", false],
    ["1.0.0", "1.0.0", false],
    ["1.0.0+old", "1.0.0+new", false],
    ["1.0.0-beta.2", "1.0.0-beta.10", true],
    ["1.0.0-beta", "1.0.0", true],
    ["1.0.0", "1.0.0-beta", false],
    ["1.0.0-1", "1.0.0-alpha", true],
    ["1.0.0-alpha", "1.0.0-alpha.1", true],
    ["", "1.0.0", false],
    ["1.0.0", "unknown", false],
    ["1.0.0", "01.0.0", false],
    ["1.0.0", "1.0.1-01", false],
  ])("compares %s to %s", (installed, available, expected) => {
    expect(hasNewerMarketplaceVersion(installed, available)).toBe(expected);
  });

  it("does not confuse npm or another marketplace's same-name plugin with this installation", () => {
    const state = getMarketplacePluginState({ name: "cloudbase", version: "2.0.0" }, "official", [
      { name: "cloudbase", version: "1.0.0" },
      { name: "cloudbase", id: "cloudbase@other", version: "1.0.0" },
    ]);
    expect(state.installed).toBeUndefined();
    expect(state.updateAvailable).toBe(false);
  });

  it("updates the effective project installation rather than the shadowed user installation", () => {
    const user = {
      name: "cloudbase",
      id: "cloudbase@official",
      version: "1.0.0",
      scope: "user" as const,
    };
    const project = { ...user, scope: "project" as const, version: "2.0.0", enabled: false };
    const state = getMarketplacePluginState({ name: "cloudbase", version: "2.1.0" }, "official", [
      user,
      project,
    ]);
    expect(state.installed).toBe(project);
    expect(state.updateAvailable).toBe(true);
    expect(
      getMarketplacePluginState({ name: "cloudbase", version: "2.0.0" }, "official", [
        user,
        project,
      ]).updateAvailable,
    ).toBe(false);
  });
});
