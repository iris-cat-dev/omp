import type { AgentProvider } from "@omp-desktop/protocol/agent-types";

export const PROVIDER_FEATURES_STALE_TIME_MS = 30 * 60_000;
export const PROVIDER_FEATURES_GC_TIME_MS = 60 * 60_000;

export function providerFeaturesQueryRoot(serverId: string | null, provider?: AgentProvider) {
  return provider
    ? (["providerFeatures", serverId, provider] as const)
    : (["providerFeatures", serverId] as const);
}
