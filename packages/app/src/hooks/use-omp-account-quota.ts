import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type { OmpProviderManagement } from "@omp-desktop/protocol/messages";
import { useOmpProviderAccountNotes } from "@/hooks/use-omp-provider-account-notes";
import { resolveOmpModelProviderNamespace } from "@/provider-selection/omp-model-provider";
import { useSessionStore } from "@/stores/session-store";

type OmpAccountQuotaAccount = NonNullable<
  OmpProviderManagement["loginProviders"][number]["accounts"]
>[number];

export type OmpAccountQuotaDisplayAccount = OmpAccountQuotaAccount & { note?: string };

export const OMP_PROVIDER_MANAGEMENT_STALE_TIME_MS = 300_000;
export const OMP_PROVIDER_MANAGEMENT_GC_TIME_MS = 1_800_000;

export function ompProviderManagementQueryKey(serverId: string) {
  return ["ompProviderManagement", serverId] as const;
}

export function resolveOmpQuotaProviderId(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): "openai-codex" | "anthropic" | null {
  const namespace = provider === "omp" ? resolveOmpModelProviderNamespace(modelId ?? "") : provider;
  return namespace === "openai-codex" || namespace === "anthropic" ? namespace : null;
}

interface OmpProviderManagementClient {
  getOmpProviderManagement(): Promise<OmpProviderManagement>;
}

const managementRefreshes = new WeakMap<QueryClient, Map<string, Promise<OmpProviderManagement>>>();
const reachedRefreshes = new WeakMap<QueryClient, Map<string, number>>();

export function refreshOmpAccountQuotaManagement(
  queryClient: QueryClient,
  client: OmpProviderManagementClient,
  serverId: string,
  afterMutation = false,
): Promise<OmpProviderManagement> {
  let refreshes = managementRefreshes.get(queryClient);
  if (!refreshes) {
    refreshes = new Map();
    managementRefreshes.set(queryClient, refreshes);
  }
  const pending = refreshes.get(serverId);
  if (pending) {
    if (!afterMutation) return pending;
    return pending
      .catch(() => undefined)
      .then(() => refreshOmpAccountQuotaManagement(queryClient, client, serverId));
  }
  const queryKey = ompProviderManagementQueryKey(serverId);
  const refresh = (async () => {
    // Discard pre-reset reads so an old response cannot overwrite the refreshed quota/cards.
    await queryClient.cancelQueries({ queryKey, exact: true });
    return queryClient.fetchQuery({
      queryKey,
      queryFn: () => client.getOmpProviderManagement(),
      staleTime: 0,
      gcTime: OMP_PROVIDER_MANAGEMENT_GC_TIME_MS,
    });
  })().finally(() => refreshes.delete(serverId));
  refreshes.set(serverId, refresh);
  return refresh;
}

export function useOmpQuotaClock(enabled = true): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

export function useOmpQuotaReachedRefresh(
  serverId: string | null | undefined,
  resetsAt: Array<string | null | undefined>,
  now: number,
  enabled = true,
): void {
  const queryClient = useQueryClient();
  const client = useSessionStore((state) => state.sessions[serverId ?? ""]?.client ?? null);
  const reached = resetsAt.some((value) => value && Date.parse(value) <= now);
  useEffect(() => {
    if (!enabled || !serverId || !client || !reached) return;
    let refreshes = reachedRefreshes.get(queryClient);
    if (!refreshes) {
      refreshes = new Map();
      reachedRefreshes.set(queryClient, refreshes);
    }
    // One shared request per host per minute, even with multiple windows/surfaces mounted.
    const lastRefresh = refreshes.get(serverId);
    if (lastRefresh !== undefined && now - lastRefresh < 60_000) return;
    refreshes.set(serverId, now);
    void refreshOmpAccountQuotaManagement(queryClient, client, serverId).catch(() => undefined);
  }, [client, enabled, now, queryClient, reached, serverId]);
}

function needsInitialQuotaRetry(management: OmpProviderManagement): boolean {
  const codex = management.loginProviders.find((provider) => provider.id === "openai-codex");
  if (!codex?.authenticated) return false;
  if (!codex.accounts || codex.accounts.length === 0) return true;
  return codex.accounts.some((account) => account.quota?.status !== "available");
}

function waitForInitialQuotaRetry(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 750);
  return promise;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export async function fetchOmpAccountQuotaManagement(
  client: OmpProviderManagementClient,
  waitForRetry: () => Promise<void> = waitForInitialQuotaRetry,
): Promise<OmpProviderManagement> {
  const first = await client.getOmpProviderManagement();
  if (!needsInitialQuotaRetry(first)) return first;
  await waitForRetry();
  return client.getOmpProviderManagement().catch(() => first);
}

export interface OmpProviderAccountQuotaResult {
  accounts: OmpAccountQuotaDisplayAccount[];
  provider: OmpProviderManagement["loginProviders"][number] | null;
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
  refresh: () => Promise<void>;
}

export function useOmpProviderAccountQuota(
  serverId: string | null | undefined,
  providerId: string | null | undefined,
  enabled = true,
): OmpProviderAccountQuotaResult {
  const queryClient = useQueryClient();
  const client = useSessionStore((state) => state.sessions[serverId ?? ""]?.client ?? null);
  const supportsOmpProviderManagement = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.ompProviderManagement === true,
  );
  const canFetch = Boolean(client && supportsOmpProviderManagement);
  const active =
    enabled && canFetch && (providerId === "openai-codex" || providerId === "anthropic");
  const accountNotes = useOmpProviderAccountNotes(active ? serverId : null);
  const query = useFetchQuery({
    queryKey: ompProviderManagementQueryKey(serverId ?? ""),
    dataShape: "value",
    queryFn: async () => {
      if (!client) throw new Error("OMP provider management is unavailable");
      return fetchOmpAccountQuotaManagement(client);
    },
    enabled: active,
    staleTimeMs: OMP_PROVIDER_MANAGEMENT_STALE_TIME_MS,
    refetchOnMount: true,
    gcTime: OMP_PROVIDER_MANAGEMENT_GC_TIME_MS,
    refetchInterval: 300_000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
  });
  const refresh = useCallback(async () => {
    if (!active || !client || !serverId) return;
    await refreshOmpAccountQuotaManagement(queryClient, client, serverId);
  }, [active, client, queryClient, serverId]);
  const provider = active
    ? (query.data?.loginProviders.find((entry) => entry.id === providerId) ?? null)
    : null;
  const accounts = (provider?.accounts ?? []).map((account) =>
    Object.assign({}, account, {
      note: accountNotes.notes[String(account.credentialId)],
    }),
  );
  const resetTimes = accounts.flatMap((account) => [
    account.quota?.weeklyResetsAt,
    account.quota?.fiveHourResetsAt,
    ...(account.quota?.modelWindows ?? []).map((window) => window.resetsAt),
  ]);
  const now = useOmpQuotaClock(active && resetTimes.some(Boolean));
  useOmpQuotaReachedRefresh(serverId, resetTimes, now, active);
  const updatedAtMs = query.dataUpdatedAt || query.errorUpdatedAt;

  return {
    accounts,
    provider,
    loading: active && (query.isFetching || accountNotes.loading),
    error: active && query.isError ? errorMessage(query.error) : null,
    updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : null,
    refresh,
  };
}

export function useOmpAccountQuota(
  serverId: string | null | undefined,
  provider: string | null | undefined,
  modelId: string | null | undefined,
): { accounts: OmpAccountQuotaDisplayAccount[]; loading: boolean } {
  const providerId = resolveOmpQuotaProviderId(provider, modelId);
  const query = useOmpProviderAccountQuota(serverId, providerId);
  return {
    accounts: query.accounts,
    loading: query.loading,
  };
}
