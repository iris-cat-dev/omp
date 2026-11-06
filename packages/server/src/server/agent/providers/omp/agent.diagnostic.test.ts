import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { parse } from "yaml";

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
      mkdir(path.join(xdgState, "omp", "profiles", "work"), {
        recursive: true,
      }),
      mkdir(path.join(xdgCache, "omp", "profiles", "work"), {
        recursive: true,
      }),
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
      {
        PI_CODING_AGENT_DIR: path.join(home, "custom-agent"),
        XDG_DATA_HOME: xdgData,
      },
      home,
      "linux",
    );
    expect(overridden.agentDir).toBe(path.join(home, "custom-agent"));
    expect(overridden.agentDb).toBe(path.join(home, "custom-agent", "agent.db"));
    expect(overridden.xdgDataRoot).toBe(path.join(home, ".omp"));
  });

  test("reports the actual SDK package without resolving or executing an OMP CLI", async () => {
    const dir = await makeTempDir();
    const sdkRoot = await makeSdkPackage(dir);
    const client = new OmpAgentClient({
      logger: createTestLogger(),
      runtimeSettings: {
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
      runtimeSettings: {
        ompBackend: "sdk",
        ompSdkPath: path.join(dir, "missing-sdk"),
      },
    });

    await expect(client.isAvailable()).resolves.toBe(false);
    await expect(client.getOmpInstallationStatus()).rejects.toThrow();
    expect((await client.getDiagnostic()).diagnostic).toContain("missing-sdk");
  });

  test("saves the native local memory preset only for a positively identified full SDK without starting a session", async () => {
    const dir = await makeTempDir();
    const sdkRoot = await makeSdkPackage(dir, "full");
    const client = makeMemoryClient(dir, sdkRoot);
    const configPath = path.join(dir, "agent", "config.yml");
    const initial = await client.getOmpMemorySettings();
    expect(initial.runtime?.profile).toBe("full");
    expect(initial.mnemopi.localModelsConfigured).toBe(false);
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const saved = await client.updateOmpMemorySettings(initial.revision, {
      backend: "mnemopi",
      mnemopi: { useLocalModels: true },
    });
    expect(saved).toMatchObject({
      runtime: { profile: "full" },
      backend: "mnemopi",
      mnemopi: { localModelsConfigured: true, noEmbeddings: false, llmMode: "smol" },
    });
    const native = parse(await readFile(configPath, "utf8"));
    expect(native.modelRoles.memory).toMatch(/^local\//);
    expect(native.retry.fallbackChains.memory).toEqual([]);
    expect(native.mnemopi).not.toHaveProperty("useLocalModels");
    expect((await client.getOmpMemorySettings()).revision).toBe(saved.revision);
  });

  test.each(["core", "unknown"] as const)(
    "refuses the preset on %s SDK without changing disk or blocking ordinary memory settings",
    async (profile) => {
      const dir = await makeTempDir();
      const sdkRoot = await makeSdkPackage(dir, profile === "unknown" ? undefined : profile);
      const client = makeMemoryClient(dir, sdkRoot);
      const initial = await client.getOmpMemorySettings();
      const configPath = path.join(dir, "agent", "config.yml");
      expect(initial.runtime?.profile).toBe(profile);
      await expect(
        client.updateOmpMemorySettings(initial.revision, {
          backend: "mnemopi",
          mnemopi: { useLocalModels: true },
        }),
      ).rejects.toThrow("full OMP SDK");
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect((await client.getOmpMemorySettings()).revision).toBe(initial.revision);

      const ordinary = await client.updateOmpMemorySettings(initial.revision, {
        backend: "mnemopi",
        mnemopi: { noEmbeddings: true, llmMode: "none", autoRetain: false },
      });
      const raw = await readFile(configPath, "utf8");
      await expect(
        client.updateOmpMemorySettings(ordinary.revision, {
          mnemopi: { useLocalModels: true },
        }),
      ).rejects.toThrow("full OMP SDK");
      await expect(readFile(configPath, "utf8")).resolves.toBe(raw);
      expect((await client.getOmpMemorySettings()).revision).toBe(ordinary.revision);
      expect(ordinary).toMatchObject({
        runtime: { profile },
        backend: "mnemopi",
        mnemopi: { noEmbeddings: true, llmMode: "none", autoRetain: false },
      });
    },
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-omp-diagnostic-"));
  tempDirs.push(dir);
  return dir;
}

async function makeSdkPackage(dir: string, profile?: "core" | "full"): Promise<string> {
  const sdkRoot = path.join(dir, "sdk-package");
  await mkdir(path.join(sdkRoot, "dist", "node"), { recursive: true });
  await writeFile(
    path.join(sdkRoot, "package.json"),
    JSON.stringify({
      name: "@oh-my-pi/pi-coding-agent",
      version: "19.2.3",
      ...(profile ? { ompNodeSdk: { profile } } : {}),
    }),
  );
  for (const entry of ["sdk.mjs", "rpc.mjs", "host.mjs", "plugins.mjs", "modules.json"]) {
    await writeFile(path.join(sdkRoot, "dist", "node", entry), "");
  }
  return sdkRoot;
}

function makeMemoryClient(dir: string, sdkRoot: string): OmpAgentClient {
  return new OmpAgentClient({
    logger: createTestLogger(),
    runtimeSettings: {
      ompBackend: "sdk",
      ompSdkPath: sdkRoot,
      env: {
        PATH: "",
        OMP_PROFILE: "",
        PI_PROFILE: "",
        PI_CODING_AGENT_DIR: path.join(dir, "agent"),
        MNEMOPI_EMBEDDING_API_URL: "",
        MNEMOPI_EMBEDDINGS_VIA_API: "",
        OPENROUTER_BASE_URL: "",
      },
    },
  });
}
