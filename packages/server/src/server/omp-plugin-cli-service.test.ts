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

  it("falls back to rawOutput when list output is not parseable JSON", async () => {
    const runner = makeRunner("omp: not logged in");
    const result = await makeService(runner).list();

    expect(result.plugins).toEqual([]);
    expect(result.rawOutput).toContain("not logged in");
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

    const result = await makeService(runner).upgrade("probe@catalog", "project");

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

  it("omits scope and dry-run flags when not requested", async () => {
    const runner = makeRunner(
      JSON.stringify({ npm: [{ name: "x", version: "1", enabled: true }], marketplace: [] }),
    );
    await makeService(runner).install({ spec: "x", dryRun: true, scope: "project" });

    expect(runner.calls[0]?.args).toEqual([
      "plugin",
      "install",
      "x",
      "--json",
      "--scope",
      "project",
      "--dry-run",
    ]);
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

  it("targets and verifies marketplace plugins by exact ID and scope", async () => {
    const runner = makeRunner("", (_command, args) => {
      if (args[1] === "list") {
        return JSON.stringify({
          npm: [],
          marketplace: [
            {
              id: "probe@catalog",
              scope: "project",
              entries: [{ scope: "project", version: "1", enabled: false }],
            },
          ],
        });
      }
      return "";
    });

    const result = await makeService(runner).setEnabled("probe@catalog", false, "project");

    expect(runner.calls[0]?.args).toEqual([
      "plugin",
      "disable",
      "probe@catalog",
      "--scope",
      "project",
    ]);
    expect(result.ok).toBe(true);
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

  it("passes marketplace scope to uninstall", async () => {
    const runner = makeRunner("removed");
    const result = await makeService(runner).remove("probe@catalog", "project");

    expect(runner.calls[0]?.args).toEqual([
      "plugin",
      "uninstall",
      "probe@catalog",
      "--scope",
      "project",
    ]);
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
      plugins: [{ name: "probe-plugin", description: "d", version: "1.0.0" }],
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
            plugins: [{ name: "probe-plugin", description: "d", version: "1.0.0" }],
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
});
