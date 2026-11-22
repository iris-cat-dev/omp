import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@omp-desktop/protocol/agent-types";
import { compactProviderSnapshot } from "@omp-desktop/protocol/provider-snapshot-codec";
import type { CachedProviderSnapshot, ProviderSnapshotCache } from "@/data/provider-snapshot-cache";
import { draftAgentCommandsQueryKey } from "@/hooks/agent-commands-query";
import { applyProvidersSnapshotUpdate, type ProvidersSnapshotUpdate } from "@/data/push-router";
import { providerFeaturesQueryRoot } from "@/data/provider-features";
import {
  fetchProvidersSnapshot,
  providersSnapshotQueryKey,
  refreshAndApplyProvidersSnapshot,
  selectorOpenRefetchDecision,
  type ProvidersSnapshotClient,
} from "./use-providers-snapshot";

type GetProvidersSnapshotResult = Awaited<ReturnType<DaemonClient["getProvidersSnapshot"]>>;
type RefreshProvidersSnapshotResult = Awaited<ReturnType<DaemonClient["refreshProvidersSnapshot"]>>;
type GetProvidersSnapshotOptions = Parameters<DaemonClient["getProvidersSnapshot"]>[0];
type RefreshProvidersSnapshotOptions = Parameters<DaemonClient["refreshProvidersSnapshot"]>[0];

interface FakeProvidersSnapshotClient extends ProvidersSnapshotClient {
  getCalls: GetProvidersSnapshotOptions[];
  refreshCalls: RefreshProvidersSnapshotOptions[];
}

function createClient(
  input: {
    snapshots?: GetProvidersSnapshotResult[];
    refreshResult?: RefreshProvidersSnapshotResult;
  } = {},
): FakeProvidersSnapshotClient {
  const snapshots = [...(input.snapshots ?? [])];
  const refreshResult: RefreshProvidersSnapshotResult = input.refreshResult ?? {
    acknowledged: true,
    requestId: "refresh-1",
  };

  const getCalls: GetProvidersSnapshotOptions[] = [];
  const refreshCalls: RefreshProvidersSnapshotOptions[] = [];

  return {
    getCalls,
    refreshCalls,
    async getProvidersSnapshot(options) {
      getCalls.push(options ?? {});
      const next = snapshots.shift();
      if (!next) {
        throw new Error("No snapshot configured for getProvidersSnapshot call");
      }
      return next;
    },
    async refreshProvidersSnapshot(options) {
      refreshCalls.push(options ?? {});
      return refreshResult;
    },
  };
}

function providersSnapshot(entries: ProviderSnapshotEntry[]): GetProvidersSnapshotResult {
  return {
    entries,
    generatedAt: "2026-01-01T00:00:00.000Z",
    requestId: "snapshot",
  };
}

function codexEntry(
  status: ProviderSnapshotEntry["status"],
  models?: ProviderSnapshotEntry["models"],
): ProviderSnapshotEntry {
  return {
    provider: "codex",
    status,
    enabled: true,
    ...(models ? { models } : {}),
  };
}

const readyCodexModel = { provider: "codex", id: "gpt-5.4", label: "GPT-5.4" } as const;
const serverId = "server-1";

function createCache(initial: CachedProviderSnapshot | null = null): ProviderSnapshotCache & {
  writes: Parameters<ProviderSnapshotCache["write"]>[0][];
} {
  const writes: Parameters<ProviderSnapshotCache["write"]>[0][] = [];
  return {
    writes,
    async read() {
      return initial;
    },
    async write(input) {
      writes.push(input);
    },
  };
}

describe("providersSnapshotQueryKey", () => {
  it("uses one catalog key per host", () => {
    expect(providersSnapshotQueryKey(serverId)).toEqual(["providersSnapshot", serverId]);
    expect(providersSnapshotQueryKey("server-2")).not.toEqual(providersSnapshotQueryKey(serverId));
  });
});

describe("fetchProvidersSnapshot", () => {
  it("requests the global catalog without a workspace cwd", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });

    await fetchProvidersSnapshot({ client, serverId, cache: createCache() });

    expect(client.getCalls).toEqual([{}]);
  });

  it("reuses a cached snapshot when the daemon reports its hash unchanged", async () => {
    const entries = [codexEntry("ready", [readyCodexModel])];
    const compactSnapshot = compactProviderSnapshot(entries);
    const cache = createCache({
      version: 1,
      hash: "snapshot-hash",
      generatedAt: "2026-01-01T00:00:00.000Z",
      compactSnapshot,
      entries,
    });
    const client = createClient({
      snapshots: [
        {
          entries: [],
          snapshotHash: "snapshot-hash",
          notModified: true,
          generatedAt: "2026-01-02T00:00:00.000Z",
          requestId: "snapshot-2",
        },
      ],
    });

    const snapshot = await fetchProvidersSnapshot({
      client,
      serverId,
      cache,
    });

    expect(client.getCalls).toEqual([{ ifNoneMatch: "snapshot-hash" }]);
    expect(snapshot.entries).toBe(entries);
    expect(cache.writes).toEqual([]);
  });

  it("persists a changed compact snapshot for the next launch", async () => {
    const entries = [codexEntry("ready", [readyCodexModel])];
    const compactSnapshot = compactProviderSnapshot(entries);
    const cache = createCache();
    const client = createClient({
      snapshots: [
        {
          entries,
          compactSnapshot,
          snapshotHash: "next-hash",
          generatedAt: "2026-01-02T00:00:00.000Z",
          requestId: "snapshot-2",
        },
      ],
    });

    await fetchProvidersSnapshot({ client, serverId, cache });

    expect(cache.writes).toEqual([
      {
        serverId,
        hash: "next-hash",
        generatedAt: "2026-01-02T00:00:00.000Z",
        compactSnapshot,
      },
    ]);
  });

  it("shows cached models while a cold daemon snapshot is still loading", async () => {
    const entries = [codexEntry("ready", [readyCodexModel])];
    const cache = createCache({
      version: 1,
      hash: "ready-hash",
      generatedAt: "2026-01-01T00:00:00.000Z",
      compactSnapshot: compactProviderSnapshot(entries),
      entries,
    });
    const client = createClient({
      snapshots: [providersSnapshot([codexEntry("loading")])],
    });

    const snapshot = await fetchProvidersSnapshot({
      client,
      serverId,
      cache,
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        provider: "codex",
        status: "loading",
        models: [readyCodexModel],
      }),
    ]);
    expect(cache.writes).toEqual([]);
  });

  it("keeps the successful disk cache when refresh fails", async () => {
    const entries = [codexEntry("ready", [readyCodexModel])];
    const cache = createCache({
      version: 1,
      hash: "ready-hash",
      generatedAt: "2026-01-01T00:00:00.000Z",
      compactSnapshot: compactProviderSnapshot(entries),
      entries,
    });
    const failed = {
      ...codexEntry("error"),
      error: "network timeout",
    };
    const compactSnapshot = compactProviderSnapshot([failed]);
    const client = createClient({
      snapshots: [
        {
          ...providersSnapshot([failed]),
          compactSnapshot,
          snapshotHash: "failed-hash",
        },
      ],
    });

    const snapshot = await fetchProvidersSnapshot({
      client,
      serverId,
      cache,
    });

    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        status: "error",
        error: "network timeout",
        models: [readyCodexModel],
      }),
    ]);
    expect(cache.writes).toEqual([]);
  });
});

describe("refreshAndApplyProvidersSnapshot", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  it("refreshes then writes the global catalog used by every project", async () => {
    const client = createClient({
      snapshots: [providersSnapshot([codexEntry("ready", [readyCodexModel])])],
    });

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      providers: ["codex"],
      cache: createCache(),
    });

    expect(client.refreshCalls).toEqual([{ providers: ["codex"] }]);
    expect(client.getCalls).toEqual([{}]);
    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId))).toEqual(
      providersSnapshot([codexEntry("ready", [readyCodexModel])]),
    );
  });

  it("refreshes only the selected host without invalidating the applied catalog", async () => {
    const client = createClient({
      snapshots: [providersSnapshot([codexEntry("ready", [readyCodexModel])])],
    });
    const otherHostKey = providersSnapshotQueryKey("server-2");
    queryClient.setQueryData(otherHostKey, providersSnapshot([]));

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cache: createCache(),
    });

    expect(client.refreshCalls).toEqual([{}]);
    expect(client.getCalls).toEqual([{}]);
    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId))).toEqual(
      providersSnapshot([codexEntry("ready", [readyCodexModel])]),
    );
    expect(queryClient.getQueryState(providersSnapshotQueryKey(serverId))?.isInvalidated).toBe(
      false,
    );
    expect(queryClient.getQueryData(otherHostKey)).toEqual(providersSnapshot([]));
    expect(queryClient.getQueryState(otherHostKey)?.isInvalidated).toBe(false);
  });

  it("invalidates cached agent commands when refreshing providers", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });
    const commandsKey = draftAgentCommandsQueryKey({
      serverId,
      draftConfig: { provider: "codex", cwd: "/repo-a" },
    });
    queryClient.setQueryData(commandsKey, [{ name: "compact", description: "", argumentHint: "" }]);

    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      cache: createCache(),
    });

    expect(queryClient.getQueryState(commandsKey)?.isInvalidated).toBe(true);
  });

  it("rechecks explicitly refreshed provider capabilities without invalidating another provider or host", async () => {
    const client = createClient({ snapshots: [providersSnapshot([])] });
    const ompKey = [...providerFeaturesQueryRoot(serverId, "omp"), "/repo"];
    const codexKey = [...providerFeaturesQueryRoot(serverId, "codex"), "/repo"];
    const otherHostKey = [...providerFeaturesQueryRoot("server-2", "omp"), "/repo"];
    for (const key of [ompKey, codexKey, otherHostKey]) queryClient.setQueryData(key, []);
    await refreshAndApplyProvidersSnapshot({
      client,
      queryClient,
      serverId,
      providers: ["omp"],
      cache: createCache(),
    });
    expect(queryClient.getQueryState(ompKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(codexKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(otherHostKey)?.isInvalidated).toBe(false);
  });
});

describe("applyProvidersSnapshotUpdate", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient();
  });

  function updateMessage(entries: ProviderSnapshotEntry[], cwd?: string): ProvidersSnapshotUpdate {
    return {
      type: "providers_snapshot_update",
      payload: {
        ...(cwd ? { cwd } : {}),
        entries,
        generatedAt: "2026-01-01T00:00:01.000Z",
      },
    };
  }

  it("routes global pushes to the catalog shared by every project", () => {
    applyProvidersSnapshotUpdate({
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])]),
    });

    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId))).toEqual({
      entries: [codexEntry("ready", [readyCodexModel])],
      generatedAt: "2026-01-01T00:00:01.000Z",
      requestId: "providers_snapshot_update",
    });
  });

  it("uses the host catalog even when the protocol payload contains a cwd", () => {
    const otherHostKey = providersSnapshotQueryKey("server-2");
    queryClient.setQueryData(otherHostKey, providersSnapshot([]));

    applyProvidersSnapshotUpdate({
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])], "/repo-a"),
    });

    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId))).toEqual({
      entries: [codexEntry("ready", [readyCodexModel])],
      generatedAt: "2026-01-01T00:00:01.000Z",
      requestId: "providers_snapshot_update",
    });
    expect(queryClient.getQueryData(otherHostKey)).toEqual(providersSnapshot([]));
  });

  it("persists compact push updates", () => {
    const entries = [codexEntry("ready", [readyCodexModel])];
    const compactSnapshot = compactProviderSnapshot(entries);
    const cache = createCache();
    const message = updateMessage(entries, "/repo-a");
    message.payload.compactSnapshot = compactSnapshot;
    message.payload.snapshotHash = "push-hash";

    applyProvidersSnapshotUpdate({ serverId, queryClient, message, cache });

    expect(cache.writes).toEqual([
      {
        serverId,
        hash: "push-hash",
        generatedAt: "2026-01-01T00:00:01.000Z",
        compactSnapshot,
      },
    ]);
  });

  it("keeps visible models across loading and failed push updates", () => {
    const queryKey = providersSnapshotQueryKey(serverId);
    queryClient.setQueryData(queryKey, providersSnapshot([codexEntry("ready", [readyCodexModel])]));

    applyProvidersSnapshotUpdate({
      serverId,
      queryClient,
      message: updateMessage([codexEntry("loading")], "/repo-a"),
    });
    applyProvidersSnapshotUpdate({
      serverId,
      queryClient,
      message: updateMessage([{ ...codexEntry("error"), error: "network timeout" }], "/repo-a"),
    });

    expect(queryClient.getQueryData(queryKey)).toEqual({
      entries: [
        expect.objectContaining({
          status: "error",
          error: "network timeout",
          models: [readyCodexModel],
        }),
      ],
      generatedAt: "2026-01-01T00:00:01.000Z",
      requestId: "providers_snapshot_update",
    });
  });

  it("applies Windows project pushes to the same global catalog", () => {
    queryClient.setQueryData(
      providersSnapshotQueryKey(serverId),
      providersSnapshot([codexEntry("loading")]),
    );

    applyProvidersSnapshotUpdate({
      serverId,
      queryClient,
      message: updateMessage(
        [codexEntry("ready", [readyCodexModel])],
        "C:\\Users\\Ezekiel Bulver\\project",
      ),
    });

    expect(queryClient.getQueryData(providersSnapshotQueryKey(serverId))).toEqual({
      entries: [codexEntry("ready", [readyCodexModel])],
      generatedAt: "2026-01-01T00:00:01.000Z",
      requestId: "providers_snapshot_update",
    });
  });

  it("invalidates cached agent commands when a provider snapshot update arrives", () => {
    const commandsKey = draftAgentCommandsQueryKey({
      serverId,
      draftConfig: { provider: "codex", cwd: "/repo-a" },
    });
    queryClient.setQueryData(commandsKey, [{ name: "compact", description: "", argumentHint: "" }]);

    applyProvidersSnapshotUpdate({
      serverId,
      queryClient,
      message: updateMessage([codexEntry("ready", [readyCodexModel])], "/repo-a"),
    });

    expect(queryClient.getQueryState(commandsKey)?.isInvalidated).toBe(true);
  });
});

describe("selectorOpenRefetchDecision", () => {
  it("refetches stale entries when no provider is selected", () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [readyCodexModel])],
        selectedProvider: null,
      }),
    ).toBe("refetch-stale");
  });

  it("forces a refetch when the selected provider has no entry", () => {
    expect(selectorOpenRefetchDecision({ entries: [], selectedProvider: "codex" })).toBe(
      "refetch-always",
    );
  });

  it("forces a refetch when the selected provider is still loading", () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("loading")],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-always");
  });

  it("keeps a stale-only refetch when the selected provider is ready with no models", () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [])],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-stale");
  });

  it("keeps a stale-only refetch when the selected provider is ready with models", () => {
    expect(
      selectorOpenRefetchDecision({
        entries: [codexEntry("ready", [readyCodexModel])],
        selectedProvider: "codex",
      }),
    ).toBe("refetch-stale");
  });
});
