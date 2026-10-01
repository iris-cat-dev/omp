import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentClient, OmpProviderManagement } from "./agent-sdk-types.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

function createOmpClient(
  getOmpProviderManagement: () => Promise<OmpProviderManagement>,
): AgentClient {
  return {
    provider: "omp",
    capabilities: TEST_CAPABILITIES,
    async createSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
    async fetchCatalog() {
      return { models: [], modes: [] };
    },
    async isAvailable() {
      return true;
    },
    getOmpProviderManagement,
  };
}

describe("ProviderSnapshotManager OMP management", () => {
  test("coalesces concurrent reads without caching completed results", async () => {
    const management: OmpProviderManagement = {
      configPath: "/tmp/models.yml",
      configYaml: "providers: {}\n",
      providerModels: [],
      loginProviders: [],
    };
    const pending = Promise.withResolvers<OmpProviderManagement>();
    const getOmpProviderManagement = vi.fn(() => pending.promise);
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: {
        omp: createOmpClient(getOmpProviderManagement),
      },
    });

    try {
      const first = manager.getOmpProviderManagement();
      const second = manager.getOmpProviderManagement();
      expect(getOmpProviderManagement).toHaveBeenCalledOnce();

      pending.resolve(management);
      await expect(Promise.all([first, second])).resolves.toEqual([management, management]);

      await expect(manager.getOmpProviderManagement()).resolves.toBe(management);
      expect(getOmpProviderManagement).toHaveBeenCalledTimes(2);
    } finally {
      manager.destroy();
    }
  });
  test("refreshes reset cards and usage after consumption instead of reusing a pre-consumption read", async () => {
    const stale = Promise.withResolvers<OmpProviderManagement>();
    const before: OmpProviderManagement = {
      configPath: "/tmp/models.yml",
      configYaml: "providers: {}\n",
      providerModels: [],
      loginProviders: [
        {
          id: "openai-codex",
          name: "Codex",
          available: true,
          authenticated: true,
          accounts: [
            {
              credentialId: 1,
              quota: {
                status: "available",
                weeklyUsedPct: 100,
                resetCredits: { status: "available", availableCount: 1, credits: [] },
              },
            },
          ],
        },
      ],
    };
    const after: OmpProviderManagement = {
      ...before,
      loginProviders: [
        {
          ...before.loginProviders[0]!,
          accounts: [
            {
              credentialId: 1,
              quota: {
                status: "available",
                weeklyUsedPct: 0,
                resetCredits: { status: "available", availableCount: 0, credits: [] },
              },
            },
          ],
        },
      ],
    };
    let consumed = false;
    const client = createOmpClient(async () => (consumed ? after : stale.promise));
    client.consumeOmpCodexResetCredit = async () => {
      consumed = true;
      return { code: "reset", windowsReset: 2 };
    };
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      extraClients: { omp: client },
    });
    try {
      const previousRead = manager.getOmpProviderManagement();
      await manager.consumeOmpCodexResetCredit(1, "card", "stable-request");
      expect(await manager.getOmpProviderManagement()).toEqual(after);
      stale.resolve(before);
      expect(await previousRead).toEqual(before);
      expect(await manager.getOmpProviderManagement()).toEqual(after);
    } finally {
      manager.destroy();
    }
  });
});
