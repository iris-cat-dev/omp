import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { OmpPluginCliService, type OmpPluginRunner } from "./omp-plugin-cli-service.js";

function makeRunner(
  stdout: string,
  impl?: (command: string, args: string[]) => string,
): OmpPluginRunner & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner = vi.fn(async (command: string, args: string[]) => {
    calls.push({ command, args });
    return { stdout: impl ? impl(command, args) : stdout, stderr: "" };
  }) as unknown as OmpPluginRunner & { calls: Array<{ command: string; args: string[] }> };
  runner.calls = calls;
  return runner;
}

function makeService(runner: OmpPluginRunner, ompCommand = "C:/bin/omp.cmd") {
  return new OmpPluginCliService({
    logger: createTestLogger(),
    runner,
    resolveOmpCommand: async () => ompCommand,
  });
}

const LIST_JSON = JSON.stringify({
  npm: [
    { name: "pi-memory", version: "0.4.2", enabled: true, path: "C:/plugins/pi-memory" },
    { name: "other", version: "1.0.0", enabled: false, path: "C:/plugins/other" },
  ],
  marketplace: [
    {
      id: "mkt-plugin@probe-mkt",
      scope: "project",
      entries: [
        {
          scope: "project",
          version: "2.0.0",
          installPath: "C:/plugins/mkt-plugin",
          enabled: false,
        },
      ],
    },
  ],
});

describe("OmpPluginCliService", () => {
  it("uses live provider command/profile/env for GUI and cold-CLI management", async () => {
    let profile = "first";
    const runner = vi.fn<OmpPluginRunner>().mockResolvedValue({ stdout: LIST_JSON, stderr: "" });
    const service = new OmpPluginCliService({
      logger: createTestLogger(),
      runner,
      resolveOmpCommand: async () => "unused-default",
      getProviderConfig: () => ({
        command: ["configured-omp", "--profile", profile],
        env: { OMP_PROFILE: "persisted-env" },
      }),
    });
    await service.list();
    profile = "second";
    await service.list();
    expect(
      runner.mock.calls.map(([command, args, options]) => ({
        command,
        args,
        cwd: options.cwd,
        profile: options.env?.OMP_PROFILE,
      })),
    ).toEqual([
      {
        command: "configured-omp",
        args: ["--profile", "first", "plugin", "list", "--json"],
        cwd: process.cwd(),
        profile: "persisted-env",
      },
      {
        command: "configured-omp",
        args: ["--profile", "second", "plugin", "list", "--json"],
        cwd: process.cwd(),
        profile: "persisted-env",
      },
    ]);
  });

  it("reads marketplace catalogs beside the authoritative native plugins root", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-profile-marketplace-"));
    try {
      await writeFile(
        join(root, "marketplaces.json"),
        JSON.stringify({
          marketplaces: [
            {
              name: "profile-only",
              sourceUri: "local-fixture",
              catalogPath: join(root, "catalog.json"),
            },
          ],
        }),
      );
      await writeFile(join(root, "catalog.json"), JSON.stringify({ plugins: [] }));
      const runner = makeRunner(
        JSON.stringify({
          npm: [],
          marketplace: [],
          paths: { dataRoot: root, pluginsRoot: join(root, "plugins") },
        }),
      );
      const service = makeService(runner);
      expect((await service.marketplaceList()).marketplaces).toEqual([
        { name: "profile-only", source: "local-fixture", plugins: [] },
      ]);
      expect(runner.calls[0]?.args).toEqual(["plugin", "list", "--json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists plugins and marketplace entries from omp plugin list --json", async () => {
    const runner = makeRunner(LIST_JSON);
    const result = await makeService(runner).list();

    expect(runner.calls[0]?.args).toEqual(["plugin", "list", "--json"]);
    expect(result.plugins).toHaveLength(3);
    expect(result.plugins[0]?.name).toBe("pi-memory");
    expect(result.plugins[2]).toMatchObject({
      name: "mkt-plugin",
      id: "mkt-plugin@probe-mkt",
      version: "2.0.0",
      scope: "project",
      enabled: false,
    });
    expect(result.marketplace[0]?.id).toBe("mkt-plugin@probe-mkt");
    expect(result.rawOutput).toBeUndefined();
  });

  it("does not forward unparseable native metadata that may contain secrets", async () => {
    const runner = makeRunner("omp: secret-token-value");
    const result = await makeService(runner).list();

    expect(result.plugins).toEqual([]);
    expect(result.rawOutput).toBe("The selected OMP runtime returned invalid plugin metadata.");
  });

  it("extracts the trailing JSON object when progress lines precede it", async () => {
    const runner = makeRunner(`resolving...\n${LIST_JSON}`);
    const result = await makeService(runner).list();

    expect(result.plugins).toHaveLength(3);
  });

  it("serializes a second operation queued while one is in flight", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const slowRunner: OmpPluginRunner = async (command, args) => {
      calls.push(args.join(" "));
      if (calls.length === 1) await firstGate;
      return { stdout: LIST_JSON, stderr: "" };
    };
    const service = makeService(slowRunner);
    const first = service.list();
    const second = service.list();
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.plugins).toHaveLength(3);
    expect(secondResult.plugins).toHaveLength(3);
    // Serialization order preserved: both ran, one after the other.
    expect(calls).toHaveLength(2);
    const third = await service.list();
    expect(third.plugins).toHaveLength(3);
  });

  it("reports ok:false with the CLI error message when install fails", async () => {
    const runner: OmpPluginRunner = async () => {
      const error = new Error("boom") as Error & { stdout?: string; stderr?: string };
      error.stdout = "npm error 404";
      throw error;
    };
    const result = await makeService(runner).install({ spec: "nope" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("404");
  });

  it("returns upgrade failures with CLI diagnostics instead of reporting success", async () => {
    const runner: OmpPluginRunner = async () => {
      throw Object.assign(new Error("Command exited with code 1"), {
        stdout: "Resolving probe@catalog",
        stderr: 'Failed to upgrade: Plugin "probe@catalog" is not installed in project scope',
      });
    };

    const result = await makeService(runner).upgrade("probe@catalog", "project", tmpdir());

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Resolving probe@catalog");
    expect(result.output).toContain("not installed in project scope");
    expect(result.output).toContain("Command exited with code 1");
  });

  it("returns an upgrade failure when the runtime is unavailable", async () => {
    const service = new OmpPluginCliService({
      logger: createTestLogger(),
      runner: makeRunner(""),
      resolveOmpCommand: async () => null,
    });

    const result = await service.upgrade("probe@catalog", "user");

    expect(result.ok).toBe(false);
    expect(result.output).toContain("OMP CLI is not available");
  });

  it("matches the installed plugin by name derived from the spec", async () => {
    const runner = makeRunner(
      `installing pi-memory...\n${JSON.stringify({ npm: [{ name: "pi-memory", version: "0.4.2", enabled: true }], marketplace: [] })}`,
    );
    const result = await makeService(runner).install({ spec: "pi-memory" });

    expect(runner.calls[0]?.args).toEqual(["plugin", "install", "pi-memory", "--json"]);
    expect(result.ok).toBe(true);
    expect(result.plugin?.name).toBe("pi-memory");
  });

  it("parses install responses that print the plugin object itself", async () => {
    const runner = makeRunner(
      JSON.stringify({
        name: "@omp/plugin-memory",
        version: "0.0.0-dryrun",
        path: "",
        enabled: true,
      }),
    );
    const result = await makeService(runner).install({ spec: "@omp/plugin-memory", dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.plugin?.name).toBe("@omp/plugin-memory");
  });

  it("refuses every project mutation without explicit cwd before invoking the CLI", async () => {
    const runner = makeRunner("");
    const service = makeService(runner);
    const results = await Promise.all([
      service.install({ spec: "probe@catalog", scope: "project" }),
      service.upgrade("probe@catalog", "project"),
      service.remove("probe@catalog", "project"),
      service.setEnabled("probe@catalog", false, "project"),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.output).toContain("explicit project cwd");
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects relative, nonexistent and file contexts without invoking the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-plugin-context-"));
    try {
      const file = join(root, "not-a-directory");
      await writeFile(file, "");
      const runner = makeRunner(LIST_JSON);
      const service = makeService(runner);
      for (const cwd of ["relative-project", join(root, "missing"), file]) {
        const installed = await service.install({ spec: "probe@catalog", scope: "project", cwd });
        expect(installed.ok).toBe(false);
        expect(installed.output).toContain("directory");
        const listed = await service.list(cwd);
        expect(listed.plugins).toEqual([]);
        expect(listed.rawOutput).toContain("directory");
        const doctor = await service.doctor({ cwd });
        expect(doctor.checks).toEqual([]);
        expect(doctor.rawOutput).toContain("directory");
      }
      expect(runner.calls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies setEnabled against a fresh list instead of trusting exit code", async () => {
    let enabled = false;
    const runner = makeRunner("", () =>
      JSON.stringify({
        npm: [{ name: "p1", version: "1", enabled, path: "x" }],
        marketplace: [],
      }),
    );
    const service = makeService(runner);
    const result = await service.setEnabled("p1", true);

    expect(result.ok).toBe(false);

    enabled = true;
    const retry = await service.setEnabled("p1", true);
    expect(retry.ok).toBe(true);
  });

  it("does not verify a user toggle using the same ID's project state", async () => {
    const runner = makeRunner(
      JSON.stringify({
        npm: [],
        marketplace: [
          {
            id: "probe@catalog",
            scope: "project",
            entries: [{ scope: "project", enabled: false }],
          },
          { id: "probe@catalog", scope: "user", entries: [{ scope: "user" }] },
        ],
      }),
    );
    const result = await makeService(runner).setEnabled("probe@catalog", false, "user");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("did not confirm");
  });

  it("verifies the exact project entry even when the same ID's user entry appears first", async () => {
    const runner = makeRunner(
      JSON.stringify({
        npm: [],
        marketplace: [
          {
            id: "probe@catalog",
            scope: "project",
            entries: [{ scope: "user" }, { scope: "project", enabled: false }],
          },
        ],
      }),
    );
    const service = makeService(runner);
    expect((await service.setEnabled("probe@catalog", false, "project", tmpdir())).ok).toBe(true);
    expect((await service.setEnabled("probe@catalog", true, "project", tmpdir())).ok).toBe(false);
  });

  it("keeps same-ID scoped copies, shadowing, metadata and native default enabled state", async () => {
    const marketplace = [
      {
        id: "probe@catalog",
        scope: "user",
        shadowedBy: "project",
        entries: [{ scope: "user", version: "1", installedAt: "2026-10-19" }],
      },
      {
        id: "probe@catalog",
        scope: "project",
        entries: [{ scope: "project", version: "2", enabled: false }],
      },
      { id: "unknown@catalog", scope: "user" },
    ];
    const result = await makeService(makeRunner(JSON.stringify({ npm: [], marketplace }))).list();
    expect(result.marketplace).toEqual(marketplace);
    expect(result.plugins).toEqual([
      expect.objectContaining({
        id: "probe@catalog",
        scope: "user",
        version: "1",
        enabled: true,
        shadowedBy: "project",
        installedAt: "2026-10-19",
      }),
      expect.objectContaining({
        id: "probe@catalog",
        scope: "project",
        version: "2",
        enabled: false,
      }),
      expect.objectContaining({ id: "unknown@catalog", scope: "user", enabled: undefined }),
    ]);
  });

  it("does not confirm enabled state from a summary without an installed entry", async () => {
    const service = makeService(
      makeRunner(
        JSON.stringify({
          npm: [],
          marketplace: [{ id: "probe@catalog", scope: "user" }],
        }),
      ),
    );
    expect((await service.setEnabled("probe@catalog", true, "user")).ok).toBe(false);
  });

  it("returns doctor checks parsed from CLI output", async () => {
    const checks = [{ name: "plugins_directory", status: "ok", message: "Found" }];
    const runner = makeRunner(JSON.stringify(checks));
    const result = await makeService(runner).doctor();

    expect(runner.calls[0]?.args).toEqual(["plugin", "doctor", "--json"]);
    expect(result.checks).toEqual(checks);
  });

  it("returns an immediate diagnostic when omp cannot be resolved", async () => {
    const runner = makeRunner("");
    const service = new OmpPluginCliService({
      logger: createTestLogger(),
      runner,
      resolveOmpCommand: async () => null,
    });

    const result = await service.list();
    expect(result.plugins).toEqual([]);
    expect(result.rawOutput).toContain("OMP CLI is not available");
    expect(runner.calls).toHaveLength(0);
  });

  it("removes plugins via omp plugin uninstall", async () => {
    const runner = makeRunner("removed");
    const result = await makeService(runner).remove("pi-memory");

    expect(runner.calls[0]?.args).toEqual(["plugin", "uninstall", "pi-memory"]);
    expect(result.ok).toBe(true);
  });

  describe("marketplaces", () => {
    const REGISTRY_CATALOG_PATH = join(tmpdir(), "omp-mkt-registry-fixture", "probe-mkt.json");
    const REGISTRY_JSON = JSON.stringify({
      version: 1,
      marketplaces: [
        {
          name: "probe-mkt",
          sourceType: "local",
          sourceUri: "D:/mp",
          catalogPath: REGISTRY_CATALOG_PATH,
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const CATALOG_JSON = JSON.stringify({
      name: "probe-mkt",
      plugins: [
        {
          name: "probe-plugin",
          description: "d",
          version: "1.0.0",
          source: { type: "git", url: "https://example.com/plugin.git" },
          author: { name: "Catalog publisher" },
          homepage: "https://example.com/plugin",
          repository: { url: "https://example.com/source" },
        },
      ],
    });

    async function withRegistry(files: Record<string, string>) {
      const dir = await mkdtemp(join(tmpdir(), "omp-mkt-"));
      // REGISTRY_JSON points its catalogPath at a shared tmp location; seed it
      // whenever the caller includes the cache-relative catalog file.
      const catalogFile = files["cache/probe-mkt/marketplace.json"];
      if (catalogFile !== undefined) {
        await mkdir(dirname(REGISTRY_CATALOG_PATH), { recursive: true });
        await writeFile(REGISTRY_CATALOG_PATH, catalogFile, "utf8");
      }
      for (const [relative, content] of Object.entries(files)) {
        const target = join(dir, relative);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }
      const dispose = async () => {
        await rm(dir, { recursive: true, force: true });
        if (catalogFile !== undefined) {
          await rm(REGISTRY_CATALOG_PATH, { force: true });
        }
      };
      return { registryPath: join(dir, "marketplaces.json"), dispose };
    }

    function makeServiceWithRegistry(
      runner: OmpPluginRunner,
      registryPath: string,
    ): OmpPluginCliService {
      return new OmpPluginCliService({
        logger: createTestLogger(),
        runner,
        resolveOmpCommand: async () => "C:/bin/omp.cmd",
        marketplacesRegistryPath: registryPath,
      });
    }

    it("reads marketplaces and catalogs from the registry instead of the CLI", async () => {
      const { registryPath, dispose } = await withRegistry({
        "marketplaces.json": REGISTRY_JSON,
        "cache/probe-mkt/marketplace.json": CATALOG_JSON,
      });
      try {
        const runner = makeRunner("");
        const result = await makeServiceWithRegistry(runner, registryPath).marketplaceList();

        expect(runner.calls).toHaveLength(0);
        expect(result.marketplaces).toEqual([
          {
            name: "probe-mkt",
            source: "D:/mp",
            plugins: [
              {
                name: "probe-plugin",
                description: "d",
                version: "1.0.0",
                source: { type: "git", url: "https://example.com/plugin.git" },
                author: { name: "Catalog publisher" },
                homepage: "https://example.com/plugin",
                repository: { url: "https://example.com/source" },
              },
            ],
          },
        ]);
      } finally {
        await dispose();
      }
    });

    it("returns empty list when the registry does not exist", async () => {
      const { registryPath, dispose } = await withRegistry({});
      try {
        const runner = makeRunner("");
        const result = await makeServiceWithRegistry(runner, registryPath).marketplaceList();

        expect(result.marketplaces).toEqual([]);
        expect(result.rawOutput).toBeUndefined();
      } finally {
        await dispose();
      }
    });

    it("adds a marketplace via CLI and extracts the new registry entry", async () => {
      const { registryPath, dispose } = await withRegistry({ "marketplaces.json": REGISTRY_JSON });
      try {
        const runner = makeRunner("Added marketplace: ./x");
        // Simulate the CLI writing the registry + cache catalog during add.
        const runner2: OmpPluginRunner = async (command, args, options) => {
          const result = await runner(command, args, options);
          const updated = JSON.parse(REGISTRY_JSON) as {
            marketplaces: Array<Record<string, string>>;
          };
          const catalogPath = join(dirname(registryPath), "cache/new-mkt/marketplace.json");
          updated.marketplaces.push({
            name: "new-mkt",
            sourceType: "github",
            sourceUri: "owner/repo",
            catalogPath,
            addedAt: "2026-01-02T00:00:00.000Z",
          });
          await mkdir(dirname(catalogPath), { recursive: true });
          await writeFile(registryPath, JSON.stringify(updated), "utf8");
          await writeFile(catalogPath, CATALOG_JSON, "utf8");
          return result;
        };
        const service = new OmpPluginCliService({
          logger: createTestLogger(),
          runner: runner2,
          resolveOmpCommand: async () => "C:/bin/omp.cmd",
          marketplacesRegistryPath: registryPath,
        });
        const result = await service.marketplaceAdd({ source: "owner/repo" });

        expect(runner.calls[0]?.args).toEqual([
          "plugin",
          "marketplace",
          "add",
          "owner/repo",
          "--json",
        ]);
        expect(result.ok).toBe(true);
        expect(result.marketplace?.name).toBe("new-mkt");
        expect(result.marketplace?.plugins).toHaveLength(1);
      } finally {
        await dispose();
      }
    });

    it("reports ok:false with CLI output when add fails", async () => {
      const { registryPath, dispose } = await withRegistry({});
      try {
        const runner: OmpPluginRunner = async () => {
          const error = new Error("clone failed") as Error & { stdout?: string };
          error.stdout = "fatal: unable to access";
          throw error;
        };
        const result = await makeServiceWithRegistry(runner, registryPath).marketplaceAdd({
          source: "owner/repo",
        });

        expect(result.ok).toBe(false);
        expect(result.output).toContain("unable to access");
      } finally {
        await dispose();
      }
    });

    it("does not report successful refresh when the native marketplace update fails", async () => {
      const runner = vi.fn<OmpPluginRunner>().mockRejectedValue(
        Object.assign(new Error("update failed"), {
          stdout: "Fetching catalog",
          stderr: "remote repository unavailable",
        }),
      );
      const service = makeService(runner);
      const result = await service.marketplaceUpdate({ name: "probe-mkt" });
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Fetching catalog");
      expect(result.output).toContain("remote repository unavailable");
      expect(result.output).toContain("update failed");
    });

    it("removes a marketplace via CLI", async () => {
      const { registryPath, dispose } = await withRegistry({});
      try {
        const runner = makeRunner("Removed");
        const result = await makeServiceWithRegistry(runner, registryPath).marketplaceRemove({
          name: "probe-mkt",
        });

        expect(runner.calls[0]?.args).toEqual([
          "plugin",
          "marketplace",
          "remove",
          "probe-mkt",
          "--json",
        ]);
        expect(result.ok).toBe(true);
      } finally {
        await dispose();
      }
    });
  });
  it("refuses marketplace discovery when the selected runtime omits authoritative paths", async () => {
    await expect(makeService(makeRunner(LIST_JSON)).marketplaceList()).rejects.toThrow("authoritative marketplace paths");
  });

  it("redacts native secret defaults in list metadata", async () => {
    const runner = makeRunner(JSON.stringify({ npm: [{ name: "fixture", version: "1", manifest: { settings: { token: { type: "string", secret: true, default: "private-default" } } } }], marketplace: [] }));
    expect(JSON.stringify(await makeService(runner).list())).not.toContain("private-default");
  });

  it("preserves exact management identity and null versus empty feature patches", async () => {
    const state = { name: "fixture@market", scope: "user", schema: { token: { type: "string", secret: true }, count: { type: "number" } }, settings: { count: 3 }, secretConfigured: { token: true }, enabledFeatures: null, availableFeatures: {}, effectiveFeatures: [], overriddenSettings: [], featuresOverridden: false, secretInput: "unavailable", appliesTo: "new-or-resumed-sessions" };
    const runner = makeRunner(JSON.stringify(state));
    const service = makeService(runner);
    await service.updateManagement({ name: state.name, scope: "user", patch: { enabledFeatures: [] } });
    await service.updateManagement({ name: state.name, scope: "user", patch: { enabledFeatures: null } });
    expect(runner.calls[1]?.args).toEqual(["plugin", "manage", "fixture@market", "--json", "--scope", "user", "--set", '{"enabledFeatures":[]}']);
    expect(runner.calls[3]?.args).toEqual(["plugin", "manage", "fixture@market", "--json", "--scope", "user", "--set", '{"enabledFeatures":null}']);
    await expect(service.updateManagement({ name: state.name, scope: "user", patch: { settings: { token: "never-spawn-this-secret" } } })).rejects.toThrow("Secret input is unavailable");
    expect(JSON.stringify(runner.calls)).not.toContain("never-spawn-this-secret");
  });

  it("never exposes raw CLI configuration output on unsupported management runtimes", async () => {
    const service = makeService(makeRunner('{"token":"raw-secret"}'));
    await expect(service.getManagement({ name: "fixture" })).rejects.toThrow("safe Desktop configuration");
    const throwing = makeService(async () => { throw new Error("raw-secret"); });
    await expect(throwing.getManagement({ name: "fixture" })).rejects.toThrow("Native management failed or is unsupported");
  });
});
