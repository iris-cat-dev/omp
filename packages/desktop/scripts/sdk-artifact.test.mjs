import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, test } from "vitest";
import { importSdkArtifact } from "../../../scripts/packaging/sdk-artifact.mjs";
import { resolveOmpSdkBuildConfig } from "../../../scripts/omp-sdk-build-config.mjs";

const require = createRequire(import.meta.url);
const tar = createRequire(require.resolve("app-builder-lib"))("tar");

test.each(["target", "version", "revision", "checksum"])(
  "rejects an SDK artifact with a mismatched %s without replacing the ready SDK",
  async (failure) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "omp-sdk-rejection-"));
    try {
      const { source, buildTarget, profile } = resolveOmpSdkBuildConfig();
      const sdk = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
      const revision = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: await realpath(source),
        encoding: "utf8",
      });
      if (revision.status !== 0) throw new Error("SDK checkout revision is unavailable");
      const artifact = path.join(temporary, "artifact");
      const destination = path.join(temporary, "ready-sdk");
      await mkdir(artifact);
      await mkdir(destination);
      await writeFile(path.join(destination, "ready"), "previous working SDK");
      const archive = Buffer.from("corrupted SDK archive, never extracted");
      const manifest = {
        schemaVersion: 1,
        packageName: sdk.name,
        version: sdk.version,
        minimumNodeVersion: "24.14.0",
        platform: process.platform,
        arch: process.arch,
        buildTarget,
        profile,
        packageRoot: `node_modules/${sdk.name}`,
      };
      const provenance = {
        schemaVersion: 1,
        archive: "omp-sdk.tgz",
        sdkCommit: revision.stdout.trim(),
        packageName: sdk.name,
        version: sdk.version,
        platform: process.platform,
        arch: process.arch,
        buildTarget,
        profile,
        sha256: createHash("sha256").update(archive).digest("hex"),
        size: archive.length,
      };
      if (failure === "target")
        manifest.platform = process.platform === "win32" ? "darwin" : "win32";
      if (failure === "version") manifest.version = "0.0.0-mismatched";
      if (failure === "revision") provenance.sdkCommit = "0".repeat(40);
      if (failure === "checksum") provenance.sha256 = "0".repeat(64);
      await writeFile(path.join(artifact, "manifest.json"), JSON.stringify(manifest));
      await writeFile(path.join(artifact, "provenance.json"), JSON.stringify(provenance));
      await writeFile(path.join(artifact, "omp-sdk.tgz"), archive);
      await expect(importSdkArtifact(artifact, destination)).rejects.toThrow(
        failure === "checksum"
          ? /checksum/
          : failure === "revision"
            ? /provenance/
            : /does not match/,
      );
      expect(await readFile(path.join(destination, "ready"), "utf8")).toBe("previous working SDK");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

test("rejects a modern-only Windows SDK without replacing the ready SDK", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "omp-sdk-baseline-"));
  try {
    const { source, buildTarget, profile } = resolveOmpSdkBuildConfig();
    const sdk = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
    const revision = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: await realpath(source),
      encoding: "utf8",
    });
    if (revision.status !== 0) throw new Error("SDK checkout revision is unavailable");
    const artifact = path.join(temporary, "artifact");
    const destination = path.join(temporary, "ready-sdk");
    const packageDir = path.join(temporary, "package");
    const nativeName = "@oh-my-pi/pi-natives";
    const utilsName = "@oh-my-pi/pi-utils";
    const files = {
      "package.json": JSON.stringify({
        name: sdk.name,
        version: sdk.version,
        ompNodeSdk: { target: buildTarget, profile },
        dependencies: { [nativeName]: sdk.version, [utilsName]: sdk.version },
      }),
      "dist/node/modules.json": JSON.stringify({
        version: 1,
        buildTarget,
        modules: { sdk: "sdk.mjs" },
      }),
      "dist/node/runtime-dependencies.json": JSON.stringify({
        version: 1,
        buildTarget,
        packages: { [sdk.name]: { files: ["package.json"] } },
        optionalCapabilities: { voice: ["unused-voice-package"] },
      }),
      ...Object.fromEntries(
        [
          "sdk.mjs",
          "rpc.mjs",
          "host.mjs",
          "plugins.mjs",
          "chunks/runtime.mjs",
          "modules/sdk.mjs",
        ].map((file) => [`dist/node/${file}`, "export {};\n"]),
      ),
      [`node_modules/${nativeName}/package.json`]: JSON.stringify({
        name: nativeName,
        version: sdk.version,
      }),
      [`node_modules/${nativeName}/native/pi_natives.win32-x64-modern.node`]: "modern addon",
      [`node_modules/${utilsName}/package.json`]: JSON.stringify({
        name: utilsName,
        version: sdk.version,
      }),
      ...Object.fromEntries(
        ["runtime.mjs", "runtime-image.mjs", "sqlite-driver.mjs"].map((file) => [
          `node_modules/${utilsName}/dist/node/${file}`,
          "export {};\n",
        ]),
      ),
    };
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(packageDir, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await mkdir(artifact);
    await mkdir(destination);
    await writeFile(path.join(destination, "ready"), "previous working SDK");
    const archiveFile = path.join(artifact, "omp-sdk.tgz");
    await tar.c({ gzip: true, file: archiveFile, cwd: temporary }, ["package"]);
    const archive = await readFile(archiveFile);
    const manifest = {
      schemaVersion: 1,
      packageName: sdk.name,
      version: sdk.version,
      minimumNodeVersion: "24.14.0",
      platform: "win32",
      arch: "x64",
      buildTarget,
      profile,
      packageRoot: `node_modules/${sdk.name}`,
    };
    await writeFile(path.join(artifact, "manifest.json"), JSON.stringify(manifest));
    await writeFile(
      path.join(artifact, "provenance.json"),
      JSON.stringify({
        schemaVersion: 1,
        archive: "omp-sdk.tgz",
        sdkCommit: revision.stdout.trim(),
        packageName: sdk.name,
        version: sdk.version,
        platform: "win32",
        arch: "x64",
        buildTarget,
        profile,
        sha256: createHash("sha256").update(archive).digest("hex"),
        size: archive.length,
      }),
    );
    await expect(
      importSdkArtifact(artifact, destination, { platform: "win32", arch: "x64" }),
    ).rejects.toThrow(/baseline/);
    expect(await readFile(path.join(destination, "ready"), "utf8")).toBe("previous working SDK");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
