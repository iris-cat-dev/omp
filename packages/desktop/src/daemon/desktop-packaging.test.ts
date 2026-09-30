import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { assertNativeKeyringBinding, prepareBundledOmp } =
  require("../../scripts/after-pack.js") as {
    assertNativeKeyringBinding: (resourcesDir: string, platform: string, arch: string) => void;
    prepareBundledOmp: (resourcesDir: string, platform: string, arch: string) => void;
  };

describe("desktop packaging", () => {
  it("rejects Windows packages without the target keyring binding", () => {
    const resourcesDir = mkdtempSync(join(tmpdir(), "omp-keyring-package-test-"));
    try {
      expect(() => assertNativeKeyringBinding(resourcesDir, "win32", "x64")).toThrow(
        "Packaged Windows keyring binding is missing for x64",
      );
    } finally {
      rmSync(resourcesDir, { recursive: true, force: true });
    }
  });

  it("removes OMP from packages built with bundling disabled", () => {
    const resourcesDir = mkdtempSync(join(tmpdir(), "omp-unbundled-package-test-"));
    const executablePath = join(resourcesDir, "bin", "omp.exe");
    const previous = process.env.OMP_DESKTOP_BUNDLE_OMP;
    try {
      mkdirSync(dirname(executablePath), { recursive: true });
      writeFileSync(executablePath, "not bundled");
      process.env.OMP_DESKTOP_BUNDLE_OMP = "0";

      prepareBundledOmp(resourcesDir, "win32", "x64");

      expect(() => readFileSync(executablePath)).toThrow();
    } finally {
      if (previous === undefined) delete process.env.OMP_DESKTOP_BUNDLE_OMP;
      else process.env.OMP_DESKTOP_BUNDLE_OMP = previous;
      rmSync(resourcesDir, { recursive: true, force: true });
    }
  });
});
