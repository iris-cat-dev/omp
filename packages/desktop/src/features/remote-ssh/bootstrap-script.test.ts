import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRemoteInstallScript } from "./bootstrap-script.js";

async function withInstallFixture(run: (upload: string, home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "omp-remote-sdk-install-"));
  const token = "sdkinstallfixture";
  const runtime = path.join(home, ".omp-desktop", "remote-runtime");
  const upload = path.join(runtime, "uploads", token);
  const packages = path.join(upload, "packages");
  try {
    await mkdir(packages, { recursive: true });
    for (const [name, files] of [
      [
        "backend",
        {
          "package.json": JSON.stringify({
            name: "@fixture/backend",
            version: "1.0.0",
            main: "index.cjs",
          }),
          "index.cjs": 'module.exports = "backend";',
        },
      ],
      [
        "omp-sdk",
        {
          "package.json": JSON.stringify({
            name: "@oh-my-pi/pi-coding-agent",
            version: "1.0.0",
            main: "index.cjs",
            dependencies: { "@fixture/bundled": "1.0.0" },
            bundledDependencies: ["@fixture/bundled"],
          }),
          "index.cjs": 'module.exports = require("@fixture/bundled") + "-sdk";',
          "node_modules/@fixture/bundled/package.json": JSON.stringify({
            name: "@fixture/bundled",
            version: "1.0.0",
            main: "index.cjs",
          }),
          "node_modules/@fixture/bundled/index.cjs": 'module.exports = "bundled";',
        },
      ],
    ] as const) {
      const source = path.join(home, name);
      for (const [relative, contents] of Object.entries(files)) {
        const file = path.join(source, "package", relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, contents);
      }
      const packed = spawnSync(
        "tar",
        ["-czf", path.join(packages, `${name}.tgz`), "-C", source, "package"],
        { encoding: "utf8" },
      );
      expect(packed.status, packed.stderr).toBe(0);
    }
    await writeFile(
      path.join(upload, "package.json"),
      JSON.stringify({
        name: "remote-install-fixture",
        version: "1.0.0",
        private: true,
        dependencies: { "@fixture/backend": "file:packages/backend.tgz" },
      }),
    );
    const locked = spawnSync(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: upload, encoding: "utf8" },
    );
    expect(locked.status, locked.stderr).toBe(0);
    const nodeBin = path.join(runtime, "node", `v${process.versions.node}`, "bin");
    await mkdir(nodeBin, { recursive: true });
    await symlink(process.execPath, path.join(nodeBin, "node"));
    const npm = spawnSync("which", ["npm"], { encoding: "utf8" });
    expect(npm.status, npm.stderr).toBe(0);
    await symlink(npm.stdout.trim(), path.join(nodeBin, "npm"));
    await run(upload, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function install(home: string) {
  return spawnSync("/bin/sh", [], {
    input: buildRemoteInstallScript({
      token: "sdkinstallfixture",
      backendVersion: "1.0.0",
      nodeVersion: process.versions.node,
      bundleHash: "a".repeat(64),
    }),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("buildRemoteInstallScript", () => {
  it("produces a valid POSIX shell program", () => {
    const script = buildRemoteInstallScript({
      token: "8f61b165-56ff-405d-a20f-01f2f35f9003",
      backendVersion: "0.3.0",
      nodeVersion: "22.20.0",
      bundleHash: "a".repeat(64),
      relayAddress: "wss://relay.example.test/ws",
    });
    const shell = process.platform === "win32" ? "sh.exe" : "/bin/sh";
    const result = spawnSync(shell, ["-n"], { input: script, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe.skipIf(process.platform === "win32")("standalone remote SDK installation", () => {
  it("installs the SDK's bundled dependencies without replacing npm-installed backend packages", async () => {
    await withInstallFixture(async (upload, home) => {
      // No CLI is supplied: the installer must stop before managing any daemon.
      const result = install(home);
      expect(result.status).toBe(1);
      const probe = spawnSync(
        process.execPath,
        [
          "-e",
          'console.log(require("@fixture/backend") + ":" + require("@oh-my-pi/pi-coding-agent"))',
        ],
        { cwd: upload, encoding: "utf8" },
      );
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stdout.trim()).toBe("backend:bundled-sdk");
    });
  });

  it("does not switch an existing release when the SDK archive cannot be extracted", async () => {
    await withInstallFixture(async (upload, home) => {
      const runtime = path.join(home, ".omp-desktop", "remote-runtime");
      const previous = path.join(runtime, "releases", "previous");
      await mkdir(previous, { recursive: true });
      await writeFile(path.join(previous, "state"), "previous-release");
      await symlink(previous, path.join(runtime, "current"));
      await writeFile(path.join(upload, "packages", "omp-sdk.tgz"), "invalid archive");
      expect(install(home).status).toBe(1);
      expect(await readlink(path.join(runtime, "current"))).toBe(previous);
      expect(await readFile(path.join(previous, "state"), "utf8")).toBe("previous-release");
    });
  });
});
