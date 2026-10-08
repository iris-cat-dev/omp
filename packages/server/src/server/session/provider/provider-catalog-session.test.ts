import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  ProviderCatalogSession,
  type ProviderCatalogSessionHost,
} from "./provider-catalog-session.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";
import {
  GLOBAL_PROVIDER_SNAPSHOT_KEY,
  type ProviderSnapshotManager,
} from "../../agent/provider-snapshot-manager.js";
import type { ProviderSnapshotEntry } from "../../agent/agent-sdk-types.js";
import type { ProviderUsageService } from "../../../services/quota-fetcher/service.js";
import { expandProviderSnapshot } from "@omp-desktop/protocol/provider-snapshot-codec";

type SnapshotChangeHandler = (entries: ProviderSnapshotEntry[], cwd: string) => void;

interface MakeOptions {
  visibleProviders?: Set<string>;
  supportsCustomModeIcons?: boolean;
  supportsCompactProviderSnapshots?: boolean;
  snapshot?: { [K in keyof ProviderSnapshotManager]?: unknown };
  usage?: { [K in keyof ProviderUsageService]?: unknown };
  host?: Partial<ProviderCatalogSessionHost>;
}

// A codex entry whose two modes exercise both downgrade branches (unknown icon →
// "ShieldCheck", known icon → preserved) plus a claude entry the visibility gate drops.
function makeEntries(): ProviderSnapshotEntry[] {
  return [
    {
      provider: "codex",
      status: "ready",
      enabled: true,
      modes: [
        { id: "default", label: "Default", icon: "Sparkles" },
        { id: "safe", label: "Safe", icon: "ShieldCheck" },
      ],
    },
    { provider: "claude", status: "ready", enabled: true, modes: [] },
  ];
}

function makeSubsystem(options: MakeOptions = {}) {
  const emitted: SessionOutboundMessage[] = [];
  const visible = options.visibleProviders ?? new Set(["codex"]);
  let changeHandler: SnapshotChangeHandler | null = null;
  const host: ProviderCatalogSessionHost = {
    emit: (msg) => emitted.push(msg),
    isProviderVisibleToClient: (provider) => visible.has(provider),
    supportsCustomModeIcons: () => options.supportsCustomModeIcons ?? false,
    supportsCompactProviderSnapshots: () => options.supportsCompactProviderSnapshots ?? false,
    listProviderAvailability: async () => [],
    listDraftFeatures: async () => [],
    listActiveOmpAgentIds: () => [],
    stopOmpAgents: async () => {},
    ...options.host,
  };
  const providerSnapshotManager = createStub<ProviderSnapshotManager>({
    on: (_event: string, handler: SnapshotChangeHandler) => {
      changeHandler = handler;
    },
    off: () => {},
    onOmpProviderLoginCompleted: () => () => {},
    ...options.snapshot,
  });
  const subsystem = new ProviderCatalogSession({
    host,
    providerSnapshotManager,
    providerUsageService: createStub<ProviderUsageService>(options.usage ?? {}),
    logger: pino({ level: "silent" }),
  });
  function pushSnapshotChange(
    entries: ProviderSnapshotEntry[],
    cwd = GLOBAL_PROVIDER_SNAPSHOT_KEY,
  ): void {
    if (!changeHandler) throw new Error("start() must run before a snapshot change");
    changeHandler(entries, cwd);
  }
  return { subsystem, emitted, pushSnapshotChange };
}

describe("ProviderCatalogSession", () => {
  it("PUSH gates invisible providers and downgrades unknown mode icons for legacy clients", () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      visibleProviders: new Set(["codex"]),
      supportsCustomModeIcons: false,
    });

    subsystem.start();
    pushSnapshotChange(makeEntries());

    const push = findByType(emitted, "providers_snapshot_update");
    expect(push?.payload.entries.map((entry) => entry.provider)).toEqual(["codex"]);
    expect(push?.payload.entries[0]?.modes).toEqual([
      { id: "default", label: "Default", icon: "ShieldCheck" },
      { id: "safe", label: "Safe", icon: "ShieldCheck" },
    ]);
  });

  it("PUSH and PULL produce identical visible, downgraded entries for one client", async () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      visibleProviders: new Set(["codex"]),
      supportsCustomModeIcons: false,
      snapshot: { getSnapshot: () => makeEntries() },
    });

    subsystem.start();
    pushSnapshotChange(makeEntries());
    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "g1",
    });

    const push = findByType(emitted, "providers_snapshot_update");
    const pull = findByType(emitted, "get_providers_snapshot_response");
    expect(pull?.payload.entries).toEqual(push?.payload.entries);
  });

  it("returns the canonical cwd used by snapshot updates", async () => {
    const getSnapshot = vi.fn((_cwd?: string) => makeEntries());
    const { subsystem, emitted } = makeSubsystem({
      snapshot: { getSnapshot },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "canonical-cwd",
      cwd: "/repo/./sdk",
    });

    const canonicalCwd = getSnapshot.mock.calls[0]?.[0];
    expect(canonicalCwd).toEqual(expect.any(String));
    expect(findByType(emitted, "get_providers_snapshot_response")?.payload.cwd).toBe(canonicalCwd);
  });

  it("pushes the compact encoding to capable clients", () => {
    const { subsystem, emitted, pushSnapshotChange } = makeSubsystem({
      supportsCustomModeIcons: true,
      supportsCompactProviderSnapshots: true,
    });

    subsystem.start();
    pushSnapshotChange(makeEntries());

    const push = findByType(emitted, "providers_snapshot_update");
    expect(push?.payload.entries).toEqual([]);
    expect(push?.payload.snapshotHash).toEqual(expect.any(String));
    expect(expandProviderSnapshot(push!.payload.compactSnapshot!)).toEqual([makeEntries()[0]]);
  });

  it("preserves custom mode icons when the client supports them", async () => {
    const { subsystem, emitted } = makeSubsystem({
      supportsCustomModeIcons: true,
      snapshot: { getSnapshot: () => makeEntries() },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "g2",
    });

    const pull = findByType(emitted, "get_providers_snapshot_response");
    expect(pull?.payload.entries[0]?.modes?.[0]?.icon).toBe("Sparkles");
  });

  it("sends capable clients a compact snapshot and returns not-modified for its hash", async () => {
    const thinkingOptions = [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ];
    const entries: ProviderSnapshotEntry[] = [
      {
        provider: "codex",
        status: "ready",
        enabled: true,
        models: ["one", "two"].map((id) => ({
          provider: "codex",
          id,
          label: id,
          thinkingOptions,
          defaultThinkingOptionId: "high",
        })),
      },
    ];
    const { subsystem, emitted } = makeSubsystem({
      supportsCompactProviderSnapshots: true,
      snapshot: { getSnapshot: () => entries },
    });

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "compact-1",
    });

    const first = findByType(emitted, "get_providers_snapshot_response");
    expect(first?.payload.entries).toEqual([]);
    expect(first?.payload.snapshotHash).toEqual(expect.any(String));
    expect(first?.payload.compactSnapshot?.thinkingSets).toHaveLength(1);
    expect(expandProviderSnapshot(first!.payload.compactSnapshot!)).toEqual(entries);

    await subsystem.handleGetProvidersSnapshotRequest({
      type: "get_providers_snapshot_request",
      requestId: "compact-2",
      ifNoneMatch: first?.payload.snapshotHash,
    });

    const responses = emitted.filter(
      (message) => message.type === "get_providers_snapshot_response",
    );
    const second = responses[1];
    expect(second?.payload).toMatchObject({
      entries: [],
      snapshotHash: first?.payload.snapshotHash,
      notModified: true,
      requestId: "compact-2",
    });
    expect(second?.payload.compactSnapshot).toBeUndefined();
  });

  it("reports a disabled provider on list_provider_models without warming the snapshot", async () => {
    // warmUpSnapshotForCwd is intentionally unstubbed: createStub throws if it is called,
    // so the disabled short-circuit is proven by the absence of a throw.
    const { subsystem, emitted } = makeSubsystem({
      snapshot: { getSnapshot: () => [{ provider: "codex", status: "loading", enabled: false }] },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m1",
    });

    const res = findByType(emitted, "list_provider_models_response");
    expect(res?.payload.error).toBe("Provider codex is disabled");
  });

  it("hides compatibility-only entries from list_provider_models", async () => {
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        getSnapshot: () => [
          {
            provider: "codex",
            status: "ready",
            enabled: true,
            models: [
              { provider: "codex", id: "gpt-5.4", label: "GPT 5.4" },
              {
                provider: "codex",
                id: "gpt-5.4-legacy",
                label: "GPT 5.4 legacy",
                isSelectable: false,
              },
            ],
          },
        ],
      },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m-selectable",
    });

    const response = findByType(emitted, "list_provider_models_response");
    expect(response?.payload.models?.map((model) => model.id)).toEqual(["gpt-5.4"]);
  });

  it("preserves missing cwd as the semantic global snapshot for model list reads", async () => {
    const getSnapshot = vi.fn(() => [{ provider: "codex", status: "loading", enabled: true }]);
    const warmUpSnapshotForCwd = vi.fn(async () => {});
    const { subsystem } = makeSubsystem({
      snapshot: { getSnapshot, warmUpSnapshotForCwd },
    });

    await subsystem.handleListProviderModelsRequest({
      type: "list_provider_models_request",
      provider: "codex",
      requestId: "m-global",
    });

    expect(getSnapshot).toHaveBeenCalledWith(undefined);
    expect(warmUpSnapshotForCwd).toHaveBeenCalledWith({
      cwd: undefined,
      providers: ["codex"],
    });
  });
  it("acknowledges provider login cancellation after the runtime flow closes", async () => {
    const cancelOmpProviderLogin = vi.fn(async () => true);
    const { subsystem, emitted } = makeSubsystem({
      snapshot: { cancelOmpProviderLogin },
    });

    await subsystem.handleOmpProviderLoginCancelRequest({
      type: "omp.provider.login.cancel.request",
      flowId: "flow-openai-codex",
      requestId: "cancel-login",
    });

    expect(cancelOmpProviderLogin).toHaveBeenCalledWith("flow-openai-codex");
    expect(findByType(emitted, "omp.provider.login.cancel.response")?.payload).toEqual({
      requestId: "cancel-login",
      flowId: "flow-openai-codex",
      cancelled: true,
    });
  });

  it("queries the selected custom provider with its models.yml credentials", async () => {
    const fetchCustomUsage = vi.fn(async () => ({
      providerId: "mintcat",
      displayName: "mintcat",
      status: "available" as const,
      planLabel: "Wallet",
      windows: [],
      balances: [
        {
          id: "balance",
          label: "Balance",
          remaining: 12.5,
          unit: "usd" as const,
        },
      ],
    }));
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        getOmpProviderManagement: async () => ({
          configPath: "/tmp/models.yml",
          configYaml:
            "providers:\n  mintcat:\n    baseUrl: https://codex.mintcat.work\n    apiKey: secret\n",
          providerModels: [],
          loginProviders: [],
        }),
      },
      usage: { fetchCustomUsage },
    });

    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "custom-usage",
      providerId: "mintcat",
    });

    expect(fetchCustomUsage).toHaveBeenCalledWith({
      providerId: "mintcat",
      displayName: "mintcat",
      baseUrl: "https://codex.mintcat.work",
      apiKey: "secret",
    });
    expect(findByType(emitted, "provider.usage.list.response")?.payload.providers).toEqual([
      expect.objectContaining({ providerId: "mintcat", status: "available" }),
    ]);
  });

  it("merges every configured Zhipu provider ID into full usage without altering Cursor cache", async () => {
    const builtIn = {
      fetchedAt: "2026-06-19T00:00:00.000Z",
      providers: [
        {
          providerId: "cursor",
          displayName: "Cursor",
          status: "available" as const,
          windows: [],
          balances: [],
          details: [],
        },
      ],
    };
    const fetchCustomUsage = vi.fn(async (config: { providerId: string }) => ({
      providerId: config.providerId,
      displayName: config.providerId,
      status: "available" as const,
      windows: [{ id: "five-hour", label: "5 hours", usedPct: 20 }],
      balances: [],
      details: [],
    }));
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        getOmpProviderManagement: async () => ({
          configPath: "/tmp/models.yml",
          configYaml:
            "providers:\n  glm-cn:\n    baseUrl: https://open.bigmodel.cn/api/anthropic\n    apiKey: key-a\n  team-glm:\n    baseUrl: https://open.bigmodel.cn/api/anthropic\n    apiKey: key-b\n  other:\n    baseUrl: https://other.example\n    apiKey: other-key\n",
          providerModels: [],
          loginProviders: [],
        }),
      },
      usage: { listUsage: async () => builtIn, fetchCustomUsage },
    });

    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "all",
    });
    const result = findByType(emitted, "provider.usage.list.response");
    expect(result?.payload.providers.map((provider) => provider.providerId)).toEqual([
      "cursor",
      "glm-cn",
      "team-glm",
    ]);
    expect(fetchCustomUsage).toHaveBeenCalledTimes(2);
    expect(fetchCustomUsage).toHaveBeenCalledWith({
      providerId: "team-glm",
      displayName: "team-glm",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "key-b",
    });
    expect(builtIn.providers.map((provider) => provider.providerId)).toEqual(["cursor"]);
  });

  it("isolates Zhipu failures and missing credentials from Cursor and from other configured IDs", async () => {
    const fetchCustomUsage = vi.fn(async (config: { providerId: string }) => {
      if (config.providerId === "bad-glm") throw new Error("secret-in-error");
      return {
        providerId: config.providerId,
        displayName: config.providerId,
        status: "unavailable" as const,
        windows: [],
        balances: [],
        details: [],
      };
    });
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        getOmpProviderManagement: async () => ({
          configPath: "/tmp/models.yml",
          configYaml:
            "providers:\n  bad-glm:\n    baseUrl: https://open.bigmodel.cn/api/anthropic\n    apiKey: secret-in-error\n  empty-glm:\n    baseUrl: https://open.bigmodel.cn/api/anthropic\n",
          providerModels: [],
          loginProviders: [],
        }),
      },
      usage: {
        listUsage: async () => ({
          fetchedAt: "2026-06-19T00:00:00.000Z",
          providers: [
            {
              providerId: "cursor",
              displayName: "Cursor",
              status: "available",
              windows: [],
              balances: [],
              details: [],
            },
          ],
        }),
        fetchCustomUsage,
      },
    });
    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "all",
    });
    const providers = findByType(emitted, "provider.usage.list.response")?.payload.providers;
    expect(providers?.map((provider) => [provider.providerId, provider.status])).toEqual([
      ["cursor", "available"],
      ["bad-glm", "error"],
      ["empty-glm", "unavailable"],
    ]);
    expect(JSON.stringify(emitted)).not.toContain("secret-in-error");
    expect(fetchCustomUsage).toHaveBeenCalledWith({
      providerId: "empty-glm",
      displayName: "empty-glm",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "",
    });
    expect(findByType(emitted, "rpc_error")).toBeUndefined();
  });

  it("resolves a selected Zhipu ID without credentials as unavailable instead of falling through to Cursor", async () => {
    const listUsage = vi.fn();
    const fetchCustomUsage = vi.fn(async () => ({
      providerId: "glm-cn",
      displayName: "glm-cn",
      status: "unavailable" as const,
      windows: [],
      balances: [],
      details: [],
    }));
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        getOmpProviderManagement: async () => ({
          configPath: "/tmp/models.yml",
          configYaml:
            "providers:\n  glm-cn:\n    baseUrl: https://open.bigmodel.cn/api/anthropic\n",
          providerModels: [],
          loginProviders: [],
        }),
      },
      usage: { listUsage, fetchCustomUsage },
    });
    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "selected",
      providerId: "glm-cn",
    });
    expect(listUsage).not.toHaveBeenCalled();
    expect(fetchCustomUsage).toHaveBeenCalledWith({
      providerId: "glm-cn",
      displayName: "glm-cn",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      apiKey: "",
    });
    expect(findByType(emitted, "provider.usage.list.response")?.payload.providers[0]?.status).toBe(
      "unavailable",
    );
  });

  it("preserves Cursor usage when models.yml discovery fails and never reflects its contents", async () => {
    const { subsystem, emitted } = makeSubsystem({
      snapshot: {
        getOmpProviderManagement: async () => ({
          configPath: "/tmp/models.yml",
          configYaml: "providers:\n  bad-glm: [secret-from-config",
          providerModels: [],
          loginProviders: [],
        }),
      },
      usage: {
        listUsage: async () => ({
          fetchedAt: "2026-06-19T00:00:00.000Z",
          providers: [
            {
              providerId: "cursor",
              displayName: "Cursor",
              status: "available",
              windows: [],
              balances: [],
              details: [],
            },
          ],
        }),
      },
    });
    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "all",
    });
    expect(
      findByType(emitted, "provider.usage.list.response")?.payload.providers.map(
        (provider) => provider.providerId,
      ),
    ).toEqual(["cursor"]);
    expect(JSON.stringify(emitted)).not.toContain("secret-from-config");
    expect(findByType(emitted, "rpc_error")).toBeUndefined();
  });

  it("surfaces a usage-list failure as an rpc_error envelope", async () => {
    const { subsystem, emitted } = makeSubsystem({
      usage: {
        listUsage: async () => {
          throw new Error("quota service down");
        },
      },
    });

    await subsystem.handleProviderUsageListRequest({
      type: "provider.usage.list.request",
      requestId: "u1",
    });

    const err = findByType(emitted, "rpc_error");
    expect(err?.payload.code).toBe("provider_usage_list_failed");
    expect(err?.payload.requestId).toBe("u1");
  });

  it("surfaces a feature-list failure inline, not as an rpc_error", async () => {
    const { subsystem, emitted } = makeSubsystem({
      host: {
        listDraftFeatures: async () => {
          throw new Error("feature probe failed");
        },
      },
    });

    await subsystem.handleListProviderFeaturesRequest({
      type: "list_provider_features_request",
      requestId: "f1",
      draftConfig: { provider: "codex", cwd: "/tmp/project" },
    });

    expect(findByType(emitted, "rpc_error")).toBeUndefined();
    const res = findByType(emitted, "list_provider_features_response");
    expect(res?.payload.error).toBe("feature probe failed");
    expect(res?.payload.requestId).toBe("f1");
  });
  it("returns immediately when a Windows OMP Agent is using the executable", async () => {
    const installOmp = vi.fn();
    const getOmpInstallationStatus = vi.fn(async () => ({
      platform: "win32",
      arch: "x64",
      supported: true,
      installed: true,
      version: "omp/18.1.6",
      latestVersion: "18.1.8",
      updateAvailable: true,
      installPath: "C:\\Users\\test\\AppData\\Local\\omp\\omp.exe",
    }));
    const { subsystem, emitted } = makeSubsystem({
      host: { listActiveOmpAgentIds: () => ["agent-1"] },
      snapshot: { getOmpInstallationStatus, installOmp },
    });

    await subsystem.handleOmpInstallRequest({
      type: "omp.install.request",
      requestId: "omp-update",
    });

    expect(installOmp).not.toHaveBeenCalled();
    expect(findByType(emitted, "omp.install.response")?.payload).toMatchObject({
      requestId: "omp-update",
      updatePhase: "waiting-for-agents",
      activeAgentCount: 1,
    });
  });

  it("stops active OMP Agents before applying a Windows update", async () => {
    let activeAgentIds = ["agent-1"];
    const stopOmpAgents = vi.fn(async () => {
      activeAgentIds = [];
    });
    const installOmp = vi.fn(async () => ({
      platform: "win32",
      arch: "x64",
      supported: true,
      installed: true,
      version: "omp/18.1.8",
      installPath: "C:\\Users\\test\\AppData\\Local\\omp\\omp.exe",
      updatePhase: "complete" as const,
    }));
    const refreshSettingsSnapshot = vi.fn(async () => {});
    const { subsystem, emitted } = makeSubsystem({
      host: {
        listActiveOmpAgentIds: () => activeAgentIds,
        stopOmpAgents,
      },
      snapshot: { installOmp, refreshSettingsSnapshot },
    });

    await subsystem.handleOmpInstallRequest({
      type: "omp.install.request",
      strategy: "stop-agents",
      requestId: "omp-stop-update",
    });

    expect(stopOmpAgents).toHaveBeenCalledWith(["agent-1"]);
    expect(installOmp).toHaveBeenCalledWith({ defer: false });
    expect(findByType(emitted, "omp.install.response")?.payload.activeAgentCount).toBe(0);
  });

  it("stages a Windows update without stopping active Agents", async () => {
    const stopOmpAgents = vi.fn();
    const installOmp = vi.fn(async () => ({
      platform: "win32",
      arch: "x64",
      supported: true,
      installed: true,
      version: "omp/18.1.6",
      installPath: "C:\\Users\\test\\AppData\\Local\\omp\\omp.exe",
      updatePhase: "pending-restart" as const,
      pendingUpdate: true,
    }));
    const { subsystem } = makeSubsystem({
      host: {
        listActiveOmpAgentIds: () => ["agent-1"],
        stopOmpAgents,
      },
      snapshot: { installOmp },
    });

    await subsystem.handleOmpInstallRequest({
      type: "omp.install.request",
      strategy: "defer",
      requestId: "omp-deferred-update",
    });

    expect(stopOmpAgents).not.toHaveBeenCalled();
    expect(installOmp).toHaveBeenCalledWith({ defer: true });
  });

  it("forwards cancellation to the active OMP update", async () => {
    const cancelOmpInstall = vi.fn(async () => ({
      platform: "win32",
      arch: "x64",
      supported: true,
      installed: true,
      installPath: "C:\\Users\\test\\AppData\\Local\\omp\\omp.exe",
      updatePhase: "canceled" as const,
    }));
    const { subsystem } = makeSubsystem({
      snapshot: { cancelOmpInstall },
    });

    await subsystem.handleOmpInstallRequest({
      type: "omp.install.request",
      action: "cancel",
      requestId: "omp-cancel-update",
    });

    expect(cancelOmpInstall).toHaveBeenCalledOnce();
  });
});
