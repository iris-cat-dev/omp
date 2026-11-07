import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Query, QueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type { OmpProviderManagement } from "@omp-desktop/protocol/messages";
import { isOmpQuotaStale } from "@/components/omp-provider-quota";
import { useOmpProviderAccountNotes } from "@/hooks/use-omp-provider-account-notes";
import { resolveOmpModelProviderNamespace } from "@/provider-selection/omp-model-provider";
import { useSessionStore } from "@/stores/session-store";

type OmpAccountQuotaAccount = NonNullable<
  OmpProviderManagement["loginProviders"][number]["accounts"]
>[number];

export type OmpAccountQuotaDisplayAccount = OmpAccountQuotaAccount & { note?: string };

export const OMP_PROVIDER_MANAGEMENT_STALE_TIME_MS = 300_000;
export const OMP_PROVIDER_MANAGEMENT_GC_TIME_MS = 1_800_000;
const CODEX_QUOTA_RECOVERY_INTERVALS_MS = [30_000, 60_000] as const;

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
      queryFn: () => fetchOmpAccountQuotaManagement(client),
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
  return codex.accounts.some((account) => account.quota === undefined);
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

function retryableCodexQuotas(management: OmpProviderManagement | undefined) {
  const codex = management?.loginProviders.find((provider) => provider.id === "openai-codex");
  if (!codex?.authenticated) return [];
  return (codex.accounts ?? []).flatMap((account) => {
    const quota = account.quota;
    if (quota?.status !== "error") return [];
    const kind = quota.queryError?.kind;
    const retryable =
      kind === undefined ||
      kind === "network" ||
      kind === "timeout" ||
      kind === "rate_limited" ||
      (kind === "http" && (quota.queryError?.httpStatus ?? 0) >= 500);
    return retryable ? [quota] : [];
  });
}

export function ompProviderManagementStaleTime(
  management: OmpProviderManagement | undefined,
): number {
  const quotas = retryableCodexQuotas(management);
  if (quotas.length === 0) return OMP_PROVIDER_MANAGEMENT_STALE_TIME_MS;
  return quotas.reduce(
    (staleTime, quota) =>
      Math.max(
        staleTime,
        (Date.parse(quota.queryError?.retryAt ?? "") || 0) -
          (Date.parse(quota.fetchedAt ?? "") || Date.now()),
      ),
    CODEX_QUOTA_RECOVERY_INTERVALS_MS[0] as number,
  );
}

const quotaRecoveryRuns = new WeakMap<
  Pick<Query<OmpProviderManagement>, "state">,
  { dataUpdateCount: number; errorUpdateCount: number; failures: number }
>();

export function ompProviderManagementRefetchInterval(
  query: Pick<Query<OmpProviderManagement>, "state">,
): number {
  const quotas = retryableCodexQuotas(query.state.data);
  let run = quotaRecoveryRuns.get(query);
  if (!run) {
    run = { dataUpdateCount: -1, errorUpdateCount: -1, failures: 0 };
    quotaRecoveryRuns.set(query, run);
  }
  // Multiple mounted surfaces share one burst, rather than each resetting its retry budget.
  if (
    run.dataUpdateCount !== query.state.dataUpdateCount ||
    run.errorUpdateCount !== query.state.errorUpdateCount
  ) {
    run.dataUpdateCount = query.state.dataUpdateCount;
    run.errorUpdateCount = query.state.errorUpdateCount;
    run.failures = quotas.length > 0 ? run.failures + 1 : 0;
  }
  const interval =
    quotas.length > 0
      ? (CODEX_QUOTA_RECOVERY_INTERVALS_MS[run.failures - 1] ??
        OMP_PROVIDER_MANAGEMENT_STALE_TIME_MS)
      : OMP_PROVIDER_MANAGEMENT_STALE_TIME_MS;
  const retryAt = quotas.reduce(
    (latest, quota) => Math.max(latest, Date.parse(quota.queryError?.retryAt ?? "") || 0),
    0,
  );
  return Math.max(interval, retryAt - Date.now());
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
  const queryKey = ompProviderManagementQueryKey(serverId ?? "");
  const client = useSessionStore((state) => state.sessions[serverId ?? ""]?.client ?? null);
  const supportsOmpProviderManagement = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.ompProviderManagement === true,
  );
  const canFetch = Boolean(client && supportsOmpProviderManagement);
  const active =
    enabled && canFetch && (providerId === "openai-codex" || providerId === "anthropic");
  const accountNotes = useOmpProviderAccountNotes(active ? serverId : null);
  const query = useFetchQuery({
    queryKey,
    dataShape: "value",
    queryFn: async () => {
      if (!client) throw new Error("OMP provider management is unavailable");
      return fetchOmpAccountQuotaManagement(client);
    },
    enabled: active,
    staleTimeMs: ompProviderManagementStaleTime(
      queryClient.getQueryData<OmpProviderManagement>(queryKey),
    ),
    refetchOnMount: true,
    gcTime: OMP_PROVIDER_MANAGEMENT_GC_TIME_MS,
    refetchInterval: ompProviderManagementRefetchInterval,
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
  const resetTimes = accounts.flatMap((account) => {
    if (isOmpQuotaStale(account.quota)) return [];
    return [
      account.quota?.weeklyResetsAt,
      account.quota?.fiveHourResetsAt,
      account.quota?.modelRateLimit?.resetsAt,
      ...(account.quota?.modelWindows ?? []).map((window) => window.resetsAt),
    ];
  });
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
