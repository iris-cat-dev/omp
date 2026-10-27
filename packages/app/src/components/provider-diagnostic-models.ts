import type { AgentModelDefinition } from "@omp-desktop/protocol/agent-types";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import {
  resolveOmpModelProviderLabel,
  resolveOmpModelProviderNamespace,
} from "@/provider-selection/omp-model-provider";

export interface ProviderDiscoveredModelsCache {
  serverId: string;
  provider: string;
  models: AgentModelDefinition[];
}

export interface OmpDiscoveredModelGroup {
  id: string;
  label: string;
  models: AgentModelDefinition[];
}

export function groupOmpDiscoveredModels(
  models: AgentModelDefinition[],
): OmpDiscoveredModelGroup[] {
  const grouped = new Map<string, AgentModelDefinition[]>();
  for (const model of models) {
    const providerId = resolveOmpModelProviderNamespace(model.id, model.metadata?.provider);
    const providerModels = grouped.get(providerId) ?? [];
    providerModels.push(model);
    grouped.set(providerId, providerModels);
  }
  return [...grouped]
    .map(([id, providerModels]) => ({
      id,
      label: resolveOmpModelProviderLabel(
        id,
        providerModels.find(
          (model) =>
            typeof model.metadata?.providerName === "string" && model.metadata.providerName.trim(),
        )?.metadata?.providerName,
      ),
      models: providerModels,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export interface ResolveProviderDiscoveredModelsInput {
  serverId: string;
  provider: string;
  currentModels: AgentModelDefinition[] | undefined;
  providerSnapshotRefreshing: boolean;
  previousCache: ProviderDiscoveredModelsCache | null;
}

export interface ResolveProviderDiscoveredModelsResult {
  models: AgentModelDefinition[];
  cache: ProviderDiscoveredModelsCache | null;
}

export function resolveProviderDiscoveredModels({
  serverId,
  provider,
  currentModels,
  providerSnapshotRefreshing,
  previousCache,
}: ResolveProviderDiscoveredModelsInput): ResolveProviderDiscoveredModelsResult {
  const selectableModels = filterSelectableModels(currentModels ?? null) ?? [];
  if (selectableModels.length > 0) {
    const cache = { serverId, provider, models: selectableModels };
    return { models: selectableModels, cache };
  }

  if (
    providerSnapshotRefreshing &&
    previousCache?.serverId === serverId &&
    previousCache.provider === provider
  ) {
    return { models: previousCache.models, cache: previousCache };
  }

  return { models: [], cache: previousCache };
}
