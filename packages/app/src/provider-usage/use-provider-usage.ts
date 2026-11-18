import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { ProviderUsageView } from "./types";

export const PROVIDER_USAGE_QUERY_PREFIX = "providerUsage";
export const PROVIDER_USAGE_STALE_TIME_MS = 5 * 60 * 1000;

export function providerUsageQueryKey(serverId: string | null | undefined, providerId?: string) {
  return [PROVIDER_USAGE_QUERY_PREFIX, serverId ?? "", providerId ?? ""] as const;
}

interface UseProviderUsageOptions {
  enabled?: boolean;
  providerId?: string;
}

export function useProviderUsage(
  serverId: string | null | undefined,
  options: UseProviderUsageOptions = {},
): {
  view: ProviderUsageView;
  refresh: () => Promise<void>;
  canFetch: boolean;
} {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsProviderUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageList === true,
  );
  const queryKey = useMemo(
    () => providerUsageQueryKey(serverId, options.providerId),
    [options.providerId, serverId],
  );
  const canFetch = Boolean(serverId && client && isConnected && supportsProviderUsage);
  const enabled = Boolean((options.enabled ?? true) && canFetch);

  const fetchUsage = useCallback(
    async (forceRefresh = false) => {
      if (!client) {
        throw new Error(t("providerUsage.clientUnavailable"));
      }
      return client.listProviderUsage(
        options.providerId || forceRefresh
          ? {
              ...(options.providerId ? { providerId: options.providerId } : {}),
              ...(forceRefresh ? { forceRefresh: true } : {}),
            }
          : undefined,
      );
    },
    [client, options.providerId, t],
  );

  const query = useQuery({
    queryKey,
    queryFn: () => fetchUsage(false),
    enabled,
    staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const refresh = useCallback(async () => {
    if (!canFetch) return;
    await queryClient.cancelQueries({ queryKey, exact: true });
    await queryClient.fetchQuery({
      queryKey,
      queryFn: () => fetchUsage(true),
      staleTime: PROVIDER_USAGE_STALE_TIME_MS,
    });
  }, [canFetch, fetchUsage, queryClient, queryKey]);

  const view = useMemo<ProviderUsageView>(() => {
    if (!serverId || !client || !isConnected) {
      return { kind: "error", message: t("providerUsage.hostUnavailable") };
    }
    if (!supportsProviderUsage) {
      return { kind: "error", message: t("providerUsage.hostUpgradeRequired") };
    }
    if (query.data) {
      return {
        kind: "ready",
        payload: query.data,
        isRefreshing: query.isFetching,
      };
    }
    if (query.isError) {
      return {
        kind: "error",
        message: query.error instanceof Error ? query.error.message : String(query.error),
      };
    }
    return { kind: "loading" };
  }, [
    client,
    isConnected,
    query.data,
    query.error,
    query.isError,
    query.isFetching,
    serverId,
    supportsProviderUsage,
    t,
  ]);

  return { view, refresh, canFetch };
}
