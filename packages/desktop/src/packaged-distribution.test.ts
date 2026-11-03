import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPackagedDesktopDistribution } from "./packaged-distribution";

const roots: string[] = [];

function makeApp(privatePlugins: boolean) {
  const resources = mkdtempSync(path.join(tmpdir(), "omp-distribution-policy-"));
  roots.push(resources);
  const appRoot = path.join(resources, "app");
  mkdirSync(appRoot);
  writeFileSync(
    path.join(appRoot, "package.json"),
    JSON.stringify(privatePlugins ? { ompDesktopDistribution: "private-three-plugins" } : {}),
  );
  return { resources, appRoot };
}

function writeHost(resources: string, content: string) {
  const hostPath = path.join(resources, "bin", process.platform === "win32" ? "omp.exe" : "omp");
  mkdirSync(path.dirname(hostPath), { recursive: true });
  writeFileSync(hostPath, content);
  return createHash("sha256").update(content).digest("hex");
}

function writeManifest(resources: string, sha256: unknown) {
  const payload = path.join(resources, "bundled-omp-plugins");
  mkdirSync(payload, { recursive: true });
  writeFileSync(
    path.join(payload, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, host: { platform: "win32", arch: "x64", sha256 } }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packaged distribution policy", () => {
  it("does not enable private provisioning from leftover payload files in a public app", () => {
    const { resources, appRoot } = makeApp(false);
    writeManifest(resources, writeHost(resources, "sealed fixture host"));
    const distribution = readPackagedDesktopDistribution(appRoot);
    expect(distribution.identity).toBe("public");
  });

  it("keeps a public SDK-only app independent of any OMP executable", () => {
    const { appRoot } = makeApp(false);
    expect(readPackagedDesktopDistribution(appRoot)).toEqual({
      identity: "public",
    });
  });

  it("rejects CLI-bound private mode even with a qualified external host", () => {
    const { resources, appRoot } = makeApp(true);
    const error = "CLI-bound private plugin distributions are not supported";
    expect(() => readPackagedDesktopDistribution(appRoot)).toThrow(error);
    writeManifest(resources, writeHost(resources, "private fixture host"));
    expect(() => readPackagedDesktopDistribution(appRoot)).toThrow(error);
  });
});
