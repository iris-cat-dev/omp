import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { importSdkArtifact } from "../../../scripts/packaging/sdk-artifact.mjs";
import { resolveOmpSdkBuildConfig } from "../../../scripts/omp-sdk-build-config.mjs";

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
