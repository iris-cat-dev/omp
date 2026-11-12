import { describe, expect, it } from "vitest";
import { validatePluginContribution } from "./contribution-validation";

describe("plugin contribution identifier boundary", () => {
  it.each(["addon..settings", ".addon", "addon.", "addon/settings", "addon:settings", "addon settings"])("rejects malformed or path-like contribution id %s", id => {
    expect(() => validatePluginContribution("settings", { id, title: "Account", Component: () => null })).toThrow("Invalid plugin settings id");
  });

  it.each(["settings", "folder-addon.settings.account"])("accepts external plugin contribution id %s", id => {
    const Component = () => null;
    expect(validatePluginContribution("settings", { id, title: "Account", Component })).toEqual({ id, title: "Account", Component });
  });
});
