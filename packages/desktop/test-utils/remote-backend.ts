import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RemoteBackendManifest, RemoteBackendTarget } from "../src/features/remote-ssh/bundle.js";

export const targets: RemoteBackendTarget[] = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");


export interface RemoteBackendFixture {
  manifest: Omit<RemoteBackendManifest, "directory">;
  sdkByTarget: Record<RemoteBackendTarget, Buffer>;
}

export async function writeRemoteBackendFixture(directory: string): Promise<RemoteBackendFixture> {
  await mkdir(path.join(directory, "packages"), { recursive: true });
  const commonFiles: Record<string, string> = {};
  const dependencies: Record<string, string> = {};
  for (const name of ["highlight", "protocol", "relay", "client", "server", "cli"]) {
    const relativePath = `packages/${name}.tgz`;
    const archive = Buffer.from(`Workspace package: ${name}`);
    await writeFile(path.join(directory, relativePath), archive);
    commonFiles[relativePath] = sha256(archive);
    dependencies[`@omp-desktop/${name}`] = `file:${relativePath}`;
  }
  const manifest: RemoteBackendFixture["manifest"] = {
    schemaVersion: 2,
    backendVersion: "0.5.3",
    nodeVersion: "24.14.0",
    sdk: {
      packageName: "@oh-my-pi/pi-coding-agent",
      version: "18.14.0",
      repository: "iris-cat-dev/omp-sdk",
      releaseTag: "sdk-v18.14.0-desktop-core.1",
      buildTarget: "desktop",
      profile: "core",
    },
    files: commonFiles as RemoteBackendManifest["files"],
    targets: {} as RemoteBackendManifest["targets"],
  };
  const sdkByTarget = {} as Record<RemoteBackendTarget, Buffer>;
  for (const target of targets) {
    const sdk = Buffer.from(`SDK payload for ${target}`);
    sdkByTarget[target] = sdk;
    const targetDirectory = path.join(directory, "targets", target);
    await mkdir(targetDirectory, { recursive: true });
    const packageJson = JSON.stringify({ name: "omp-desktop-remote-backend", version: "0.0.0", private: true, dependencies });
    const lockJson = JSON.stringify({ lockfileVersion: 3, target });
    await writeFile(path.join(targetDirectory, "package.json"), packageJson);
    await writeFile(path.join(targetDirectory, "package-lock.json"), lockJson);
    manifest.targets[target] = {
      bundleHash: sha256(target),
      sdk: {
        url: `https://github.com/iris-cat-dev/omp-sdk/releases/download/sdk-v18.14.0-desktop-core.1/omp-sdk-desktop-core-${target}.tgz`,
        sha256: sha256(sdk),
        size: sdk.length,
      },
      files: { "package.json": sha256(packageJson), "package-lock.json": sha256(lockJson) },
    };
  }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return { manifest, sdkByTarget };
}
