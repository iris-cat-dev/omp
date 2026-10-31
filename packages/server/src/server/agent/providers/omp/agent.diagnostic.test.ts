import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { OmpAgentClient, resolveOmpDiagnosticPaths } from "./agent.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("OMP diagnostics", () => {
  test("follows native profile, agent override, and XDG path precedence", async () => {
    const home = await makeTempDir();
    const xdgData = path.join(home, "xdg-data");
    const xdgState = path.join(home, "xdg-state");
    const xdgCache = path.join(home, "xdg-cache");
    await Promise.all([
      mkdir(path.join(xdgData, "omp", "profiles", "work"), { recursive: true }),
      mkdir(path.join(xdgState, "omp", "profiles", "work"), { recursive: true }),
      mkdir(path.join(xdgCache, "omp", "profiles", "work"), { recursive: true }),
    ]);

    const profiled = resolveOmpDiagnosticPaths(
      {
        OMP_PROFILE: "work",
        PI_PROFILE: "ignored",
        PI_CONFIG_DIR: ".omp-custom",
        PI_CODING_AGENT_DIR: path.join(home, "ignored-agent-override"),
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
        XDG_CACHE_HOME: xdgCache,
      },
      home,
      "linux",
    );

    expect(profiled).toEqual({
      profile: "work",
      configRoot: path.join(home, ".omp-custom", "profiles", "work"),
      agentDir: path.join(home, ".omp-custom", "profiles", "work", "agent"),
      agentDb: path.join(xdgData, "omp", "profiles", "work", "agent.db"),
      xdgDataRoot: path.join(xdgData, "omp", "profiles", "work"),
      xdgStateRoot: path.join(xdgState, "omp", "profiles", "work"),
      xdgCacheRoot: path.join(xdgCache, "omp", "profiles", "work"),
    });

    const overridden = resolveOmpDiagnosticPaths(
      { PI_CODING_AGENT_DIR: path.join(home, "custom-agent"), XDG_DATA_HOME: xdgData },
      home,
      "linux",
    );
    expect(overridden.agentDir).toBe(path.join(home, "custom-agent"));
    expect(overridden.agentDb).toBe(path.join(home, "custom-agent", "agent.db"));
    expect(overridden.xdgDataRoot).toBe(path.join(home, ".omp"));
  });

  test("reports an overridden command and OMP-only paths and caveats", async () => {
    const dir = await makeTempDir();
    const script = path.join(dir, "fake-omp.cjs");
    await writeFile(script, 'process.stdout.write("omp 16.3.9\\n");\n', "utf8");
    const agentDir = path.join(dir, "agent");
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, "agent.db"), "", "utf8");

    const client = new OmpAgentClient({
      logger: createTestLogger(),
      runtimeSettings: {
        command: { mode: "replace", argv: [process.execPath, script] },
        env: {
          OMP_PROFILE: "default",
          PI_CODING_AGENT_DIR: agentDir,
        },
      },
    });
    const { diagnostic } = await client.getDiagnostic();

    expect(diagnostic).toContain("Oh My Pi (OMP)");
    expect(diagnostic).toContain(`Configured command: ${process.execPath} ${script}`);
    expect(diagnostic).toContain(`Resolved path: ${process.execPath}`);
    expect(diagnostic).toContain("Version: omp 16.3.9");
    expect(diagnostic).toContain("Active profile: default");
    expect(diagnostic).toContain(`Agent directory: ${agentDir}`);
    expect(diagnostic).toContain(`Agent database: ${path.join(agentDir, "agent.db")} (found)`);
    expect(diagnostic).toContain("npm-installed OMP requires Bun >= 1.3.14");
    expect(diagnostic).not.toContain("auth.json");
    expect(diagnostic).not.toContain(".pi/agent");
  });

  test("reports the actual SDK package without resolving or executing an OMP CLI", async () => {
    const dir = await makeTempDir();
    const sdkRoot = path.join(dir, "sdk-package");
    await mkdir(path.join(sdkRoot, "dist", "node"), { recursive: true });
    await writeFile(
      path.join(sdkRoot, "package.json"),
      JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "19.2.3" }),
    );
    for (const entry of ["sdk.mjs", "rpc.mjs", "host.mjs", "modules.json"]) {
      await writeFile(path.join(sdkRoot, "dist", "node", entry), "");
    }
    const client = new OmpAgentClient({
      logger: createTestLogger(),
      runtimeSettings: {
        ompBackend: "sdk",
        ompSdkPath: sdkRoot,
        env: { PATH: "", PI_CODING_AGENT_DIR: path.join(dir, "agent") },
      },
    });

    await expect(client.isAvailable()).resolves.toBe(true);
    const { diagnostic } = await client.getDiagnostic();
    expect(diagnostic).toContain("Backend: Node SDK");
    expect(diagnostic).toContain(`SDK package: ${sdkRoot}`);
    expect(diagnostic).toContain("Version: 19.2.3");
    expect(diagnostic).toContain(`Node runtime: ${process.versions.node}`);
    expect(diagnostic).not.toContain("Bun");
    expect(diagnostic).not.toContain("Configured command:");
    await expect(client.getOmpInstallationStatus({ checkForUpdates: true })).resolves.toMatchObject(
      {
        installed: true,
        supported: true,
        source: "sdk",
        version: "19.2.3",
        installPath: sdkRoot,
      },
    );
    await expect(client.installOmp()).rejects.toThrow("not managed by the CLI installer");
    await expect(client.cancelOmpInstall()).rejects.toThrow("No CLI installation is managed");
  });

  test("does not report an unavailable SDK package as an available CLI installation", async () => {
    const dir = await makeTempDir();
    const client = new OmpAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { ompBackend: "sdk", ompSdkPath: path.join(dir, "missing-sdk") },
    });

    await expect(client.isAvailable()).resolves.toBe(false);
    await expect(client.getOmpInstallationStatus()).rejects.toThrow();
    expect((await client.getDiagnostic()).diagnostic).toContain("missing-sdk");
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-omp-diagnostic-"));
  tempDirs.push(dir);
  return dir;
}
