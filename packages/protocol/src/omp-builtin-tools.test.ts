import { describe, expect, test } from "vitest";
import { getOmpBuiltinToolNames } from "./omp-builtin-tools.js";

describe("OMP built-in tool catalogs", () => {
  test("keeps release-specific tool choices for known catalogs", () => {
    expect(getOmpBuiltinToolNames("omp/18.3.0")).toContain("manage_skill");
    expect(getOmpBuiltinToolNames("omp/18.3.0")).not.toContain("python");
    expect(getOmpBuiltinToolNames("omp/18.2.10")).toContain("python");
    expect(getOmpBuiltinToolNames("omp/18.2.10")).not.toContain("manage_skill");
  });

  test.each(["omp/18.4.4", "omp/19.0.0", "custom-build", undefined])(
    "offers known tools without a version whitelist for %s",
    (version) => {
      const tools = getOmpBuiltinToolNames(version);
      expect(tools).toContain("write");
      expect(tools).toContain("manage_skill");
      expect(tools).toContain("python");
    },
  );
});
