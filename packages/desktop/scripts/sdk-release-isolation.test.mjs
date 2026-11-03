import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { resolveOmpSdkBuildConfig } from "../../../scripts/omp-sdk-build-config.mjs";
import { createQualifiedPackager } from "./run-electron-builder.mjs";

async function createPackagingFixture({ failure, buildMode, nested = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omp-release-mode-"));
  try {
    const { source, profile } = resolveOmpSdkBuildConfig();
    const runtimeDist = path.join(directory, "runtime");
    const executable = "Electron.app/Contents/MacOS/Electron";
    const executableBytes = Buffer.from("genuine-runtime qualification fixture");
    const runtime = {
      platform: "darwin",
      arch: "arm64",
      runtimeVersion: "99.0.0",
      electronApiVersion: "41.2.0",
      installerProtocol: 1,
      files: { [executable]: createHash("sha256").update(executableBytes).digest("hex") },
    };
    const packageRoot = "node_modules/@oh-my-pi/pi-coding-agent";
    const stage = path.join(directory, "sdk-dist");
    const nativeRoot = nested
      ? `${packageRoot}/node_modules/@oh-my-pi/pi-natives/native`
      : "node_modules/@oh-my-pi/pi-natives/native";
    const addon = "pi_natives.darwin-arm64.node";
    const files = {
      "package.json": JSON.stringify({
        name: "release-mode-packaging-fixture",
        version: "1.0.0",
        description: "Release mode isolation fixture",
        author: "OMP Desktop",
      }),
      "electron-builder.yml": "directories:\n  output: release\n",
      [`runtime/${executable}`]: executableBytes,
      "release/ready": "previous application",
      "sdk-dist/manifest.json": JSON.stringify({
        schemaVersion: 1,
        packageName: "@oh-my-pi/pi-coding-agent",
        packageRoot,
        platform: runtime.platform,
        arch: runtime.arch,
        buildTarget: "desktop",
        profile,
        buildMode: failure === "manifest" ? "development" : buildMode,
      }),
      "sdk-dist/source.json": JSON.stringify({ packageRoot: await realpath(source) }),
      [`sdk-dist/${packageRoot}/package.json`]: JSON.stringify({
        name: "@oh-my-pi/pi-coding-agent",
        ompNodeSdk: {
          target: "desktop",
          profile,
          buildMode: failure === "package" ? "development" : buildMode,
        },
      }),
      ...Object.fromEntries(
        ["sdk.mjs", "rpc.mjs", "host.mjs", "plugins.mjs", "modules.json"].map((file) => [
          `sdk-dist/${packageRoot}/dist/node/${file}`,
          "export {};\n",
        ]),
      ),
    };
    if (failure === "sidecar" || buildMode === "release") {
      files[`sdk-dist/${nativeRoot}/${addon}`] = "native addon fixture";
      files[`sdk-dist/${nativeRoot}/${addon}.json`] = JSON.stringify({
        schemaVersion: 1,
        buildTarget: "desktop",
        profile: failure === "sidecar" ? "local" : "release",
      });
    }
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(directory, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    return { directory, stage, runtimeDist, runtime };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const packagingArgs = ["--mac", "--arm64", "--publish", "never"];

test.each([
  { failure: "manifest" },
  { failure: "package" },
  { failure: "sidecar", nested: false },
  { failure: "sidecar", nested: true },
])("production packaging rejects development $failure (nested: $nested)", async (options) => {
  vi.stubEnv("OMP_DESKTOP_SDK_TARGET", "desktop");
  const fixture = await createPackagingFixture({ ...options, buildMode: "release" });
  try {
    const previousManifest = await readFile(path.join(fixture.stage, "manifest.json"), "utf8");
    await expect(
      createQualifiedPackager(
        fixture.runtimeDist,
        fixture.runtime,
        packagingArgs,
        fixture.directory,
      ),
    ).rejects.toThrow(
      options.failure === "sidecar" ? /sidecar.*release profile/ : /not a release build/,
    );
    expect(await readFile(path.join(fixture.directory, "release/ready"), "utf8")).toBe(
      "previous application",
    );
    expect(await readFile(path.join(fixture.stage, "manifest.json"), "utf8")).toBe(
      previousManifest,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
});

test.each([undefined, "release"])(
  "production packaging accepts release mode %s",
  async (buildMode) => {
    vi.stubEnv("OMP_DESKTOP_SDK_TARGET", "desktop");
    const fixture = await createPackagingFixture({ buildMode });
    try {
      const packager = await createQualifiedPackager(
        fixture.runtimeDist,
        fixture.runtime,
        packagingArgs,
        fixture.directory,
      );
      expect(packager.config.extraResources).toContainEqual({
        from: path.join(fixture.stage, "manifest.json"),
        to: "omp-sdk/manifest.json",
      });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  },
);
