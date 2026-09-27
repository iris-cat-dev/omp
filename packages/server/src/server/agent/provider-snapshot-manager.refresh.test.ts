import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentClient, ProviderCatalog, ProviderSnapshotEntry } from "./agent-sdk-types.js";
import {
  GLOBAL_PROVIDER_SNAPSHOT_KEY,
  ProviderSnapshotManager,
} from "./provider-snapshot-manager.js";

function createCatalogClient(
  provider: string,
  fetchCatalog: AgentClient["fetchCatalog"],
): AgentClient {
  return {
    provider,
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    async createSession() {
      throw new Error("Catalog tests do not create sessions");
    },
    async resumeSession() {
      throw new Error("Catalog tests do not resume sessions");
    },
    async isAvailable() {
      return true;
    },
    fetchCatalog,
  };
}

function catalog(modelId: string, provider = "omp"): ProviderCatalog {
  return { models: [{ provider, id: modelId, label: modelId }], modes: [] };
}

function observeSnapshots(manager: ProviderSnapshotManager) {
  const updates = new Map<string, ProviderSnapshotEntry[][]>();
  manager.on("change", (entries, cwd) => {
    const history = updates.get(cwd) ?? [];
    history.push(entries);
    updates.set(cwd, history);
  });
  return updates;
}

describe("ProviderSnapshotManager settings refresh", () => {
  test("publishes refreshed catalogs for every cached scope without another workspace read", async () => {
    const workspaces = [resolve("snapshot-project"), resolve(homedir())];
    let revision = 1;
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { codex: { enabled: false } },
      extraClients: {
        omp: createCatalogClient("omp", async (options) =>
          catalog(`${options.scope === "global" ? "global" : options.cwd}:${revision}`),
        ),
        pi: createCatalogClient("pi", async () => catalog(`import:${revision}`, "pi")),
      },
    });
    const updates = observeSnapshots(manager);

    try {
      for (const cwd of [undefined, ...workspaces]) {
        await manager.warmUpSnapshotForCwd({ cwd, providers: ["omp", "pi"] });
      }
      updates.clear();
      revision = 2;

      await manager.refreshSettingsSnapshot({ providers: ["omp"] });

      // Read only pushed snapshots: a getSnapshot/listModels call would warm a
      // stranded workspace and conceal the regression seen by existing clients.
      for (const cwd of [GLOBAL_PROVIDER_SNAPSHOT_KEY, ...workspaces]) {
        const history = updates.get(cwd) ?? [];
        expect(history[0]?.find((entry) => entry.provider === "omp")?.status).toBe("loading");
        const latest = history.at(-1);
        expect(latest?.find((entry) => entry.provider === "omp")).toMatchObject({
          status: "ready",
          models: [{ id: `${cwd === GLOBAL_PROVIDER_SNAPSHOT_KEY ? "global" : cwd}:2` }],
        });
        expect(latest?.find((entry) => entry.provider === "pi")).toMatchObject({
          status: "ready",
          models: [{ id: "import:1" }],
        });
      }
      expect([...updates.keys()].sort()).toEqual(
        [GLOBAL_PROVIDER_SNAPSHOT_KEY, ...workspaces].sort(),
      );
    } finally {
      manager.destroy();
    }
  });

  test("publishes a workspace failure without leaving it loading or blocking healthy scopes", async () => {
    const failedCwd = resolve("unavailable-snapshot-project");
    const healthyCwd = resolve("healthy-snapshot-project");
    let failWorkspace = false;
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { pi: { enabled: false }, codex: { enabled: false } },
      extraClients: {
        omp: createCatalogClient("omp", async (options) => {
          if (failWorkspace && options.scope === "workspace" && options.cwd === failedCwd) {
            throw new Error("Workspace catalog unavailable");
          }
          return catalog(failWorkspace ? "updated-model" : "original-model");
        }),
      },
    });
    const updates = observeSnapshots(manager);

    try {
      for (const cwd of [failedCwd, healthyCwd]) {
        await manager.warmUpSnapshotForCwd({ cwd, providers: ["omp"] });
      }
      updates.clear();
      failWorkspace = true;

      await manager.refreshSettingsSnapshot({ providers: ["omp"] });

      expect(
        updates
          .get(failedCwd)
          ?.at(-1)
          ?.find((entry) => entry.provider === "omp"),
      ).toMatchObject({
        status: "error",
        error: "Workspace catalog unavailable",
      });
      for (const cwd of [GLOBAL_PROVIDER_SNAPSHOT_KEY, healthyCwd]) {
        expect(
          updates
            .get(cwd)
            ?.at(-1)
            ?.find((entry) => entry.provider === "omp"),
        ).toMatchObject({
          status: "ready",
          models: [{ id: "updated-model" }],
        });
      }
    } finally {
      manager.destroy();
    }
  });

  test("replaces an in-flight workspace load and ignores its late catalog", async () => {
    const cwd = resolve("pending-snapshot-project");
    const started = Promise.withResolvers<void>();
    const oldCatalog = Promise.withResolvers<ProviderCatalog>();
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { pi: { enabled: false }, codex: { enabled: false } },
      extraClients: {
        omp: createCatalogClient("omp", async (options) => {
          if (options.scope === "workspace" && !options.force) {
            started.resolve();
            return oldCatalog.promise;
          }
          return catalog("updated-model");
        }),
      },
    });
    const updates = observeSnapshots(manager);
    const initialLoad = manager.warmUpSnapshotForCwd({ cwd, providers: ["omp"] });

    try {
      await started.promise;
      updates.clear();

      await manager.refreshSettingsSnapshot({ providers: ["omp"] });

      expect(
        updates
          .get(cwd)
          ?.at(-1)
          ?.find((entry) => entry.provider === "omp"),
      ).toMatchObject({
        status: "ready",
        models: [{ id: "updated-model" }],
      });
      oldCatalog.resolve(catalog("obsolete-model"));
      await initialLoad;
      expect(manager.getSnapshot(cwd).find((entry) => entry.provider === "omp")).toMatchObject({
        status: "ready",
        models: [{ id: "updated-model" }],
      });
    } finally {
      oldCatalog.resolve(catalog("obsolete-model"));
      await initialLoad;
      manager.destroy();
    }
  });
});
