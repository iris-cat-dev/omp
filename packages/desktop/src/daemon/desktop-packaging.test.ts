import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { assertNativeKeyringBinding, assertNativeKoffiBinding, prepareBundledOmp, pruneKoffi } =
  require("../../scripts/after-pack.js") as {
    assertNativeKeyringBinding: (resourcesDir: string, platform: string, arch: string) => void;
    assertNativeKoffiBinding: (resourcesDir: string, platform: string, arch: string) => void;
    prepareBundledOmp: (resourcesDir: string, platform: string, arch: string) => void;
    pruneKoffi: (nodeModules: string, platform: string, arch: string) => void;
  };

const koffiRuntimeFiles = [
  "koffi/package.json",
  "koffi/index.cjs",
  "koffi/src/koffi/index.cjs",
  "koffi/src/koffi/src/static.cjs",
  "@koromix/koffi-win32-x64/package.json",
  "@koromix/koffi-win32-x64/index.js",
  "@koromix/koffi-win32-x64/win32_x64/koffi.node",
];

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

  it.each(koffiRuntimeFiles)(
    "rejects Windows packages missing Koffi runtime file %s",
    (missing) => {
      const resourcesDir = mkdtempSync(join(tmpdir(), "omp-koffi-package-test-"));
      try {
        for (const relativePath of koffiRuntimeFiles) {
          if (relativePath === missing) continue;
          const filePath = join(resourcesDir, "app", "node_modules", relativePath);
          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, "");
        }

        expect(() => assertNativeKoffiBinding(resourcesDir, "win32", "x64")).toThrow(
          join(resourcesDir, "app", "node_modules", missing),
        );
      } finally {
        rmSync(resourcesDir, { recursive: true, force: true });
      }
    },
  );

  it("accepts Koffi's complete unpacked runtime and requires the target architecture", () => {
    const resourcesDir = mkdtempSync(join(tmpdir(), "omp-koffi-package-test-"));
    try {
      for (const relativePath of koffiRuntimeFiles) {
        const filePath = join(resourcesDir, "app", "node_modules", relativePath);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, "");
      }

      expect(() => assertNativeKoffiBinding(resourcesDir, "win32", "x64")).not.toThrow();
      expect(() => assertNativeKoffiBinding(resourcesDir, "win32", "arm64")).toThrow(
        "Packaged Windows Koffi runtime is missing for arm64",
      );
      expect(() => assertNativeKoffiBinding(resourcesDir, "darwin", "arm64")).not.toThrow();
    } finally {
      rmSync(resourcesDir, { recursive: true, force: true });
    }
  });

  it.each([
    { platform: "win32", arch: "x64", keep: ["koffi-win32-x64"] },
    { platform: "darwin", arch: "universal", keep: ["koffi-darwin-arm64", "koffi-darwin-x64"] },
  ])("prunes only other Koffi platforms for $platform-$arch", ({ platform, arch, keep }) => {
    const nodeModules = mkdtempSync(join(tmpdir(), "omp-koffi-pruning-test-"));
    const nativeDir = join(nodeModules, "@koromix");
    try {
      for (const name of [
        "koffi-win32-x64",
        "koffi-win32-arm64",
        "koffi-darwin-x64",
        "koffi-darwin-arm64",
        "unrelated",
      ]) {
        mkdirSync(join(nativeDir, name), { recursive: true });
      }

      pruneKoffi(nodeModules, platform, arch);

      expect(readdirSync(nativeDir).sort()).toEqual([...keep, "unrelated"].sort());
    } finally {
      rmSync(nodeModules, { recursive: true, force: true });
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
