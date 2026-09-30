import { describe, expect, test } from "vitest";
import { resolveOmpBuiltinToolArgs, OmpProviderParamsSchema } from "./provider-config.js";
import {
  OMP_BUILTIN_TOOL_NAMES,
  OMP_LEGACY_BUILTIN_TOOL_NAMES,
} from "@omp-desktop/protocol/omp-builtin-tools";

const stockHelp =
  "  --tools <names>  Enable specified built-in tools\n  --no-tools  Disable built-in tools";

describe("OMP built-in tool policy", () => {
  test("rejects unknown/duplicated tool IDs before they become persistent configuration", () => {
    expect(() => resolveOmpBuiltinToolArgs(["custom_plugin"], "omp/18.3.0", stockHelp, [])).toThrow(
      "Unknown OMP built-in tools",
    );
    expect(() => resolveOmpBuiltinToolArgs(["read", "read"], "omp/18.3.0", stockHelp, [])).toThrow(
      "must not contain duplicates",
    );
    expect(OmpProviderParamsSchema.parse({ disabledBuiltInTools: ["bash"] })).toMatchObject({
      disabledBuiltInTools: ["bash"],
    });
  });

  test("uses the 18.2.10 catalog order and retains 18.3-only exclusions for later upgrades", () => {
    expect(
      resolveOmpBuiltinToolArgs(["write", "manage_skill"], "omp/18.2.10", stockHelp, []),
    ).toEqual([
      "--tools",
      OMP_LEGACY_BUILTIN_TOOL_NAMES.filter((name) => name !== "write").join(","),
    ]);
    expect(resolveOmpBuiltinToolArgs(["manage_skill"], "omp/18.2.10", stockHelp, [])).toEqual([]);
  });

  test("accepts stock 18.3.0 and passes only native allowlist or all-off flags", () => {
    expect(
      resolveOmpBuiltinToolArgs(["write", "manage_skill"], "omp/18.3.0", stockHelp, []),
    ).toEqual([
      "--tools",
      OMP_BUILTIN_TOOL_NAMES.filter((name) => name !== "write" && name !== "manage_skill").join(
        ",",
      ),
    ]);
    expect(resolveOmpBuiltinToolArgs(OMP_BUILTIN_TOOL_NAMES, "omp/18.3.0", stockHelp, [])).toEqual([
      "--no-tools",
    ]);
    expect(
      resolveOmpBuiltinToolArgs(OMP_LEGACY_BUILTIN_TOOL_NAMES, "omp/18.2.10", stockHelp, []),
    ).toEqual(["--no-tools"]);
    expect(resolveOmpBuiltinToolArgs([], "unknown", "", [])).toEqual([]);
  });

  test.each(["omp/18.4.4", "omp/19.0.0", "custom-build"])(
    "honors tool settings without restricting version %s",
    (version) => {
      const args = resolveOmpBuiltinToolArgs(["write", "python"], version, stockHelp, []);
      expect(args[0]).toBe("--tools");
      const enabled = args[1]!.split(",");
      expect(enabled).toContain("read");
      expect(enabled).toContain("manage_skill");
      expect(enabled).not.toContain("write");
      expect(enabled).not.toContain("python");
    },
  );

  test("rejects missing native flags and conflicting command flags", () => {
    expect(() => resolveOmpBuiltinToolArgs(["write"], "omp/18.3.0", "--no-tools", [])).toThrow(
      "does not support --tools and --no-tools",
    );
    expect(() =>
      resolveOmpBuiltinToolArgs(["write"], "omp/18.2.10", "--tools <names>", []),
    ).toThrow("does not support --tools and --no-tools");
    for (const flag of ["--tools=read", "--tools", "--no-tools"]) {
      expect(() => resolveOmpBuiltinToolArgs(["bash"], "omp/18.3.0", stockHelp, [flag])).toThrow(
        "conflict",
      );
    }
  });
});
