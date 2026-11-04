import type { AgentFeature, AgentModelDefinition } from "@omp-desktop/protocol/agent-types";
import { AgentFeatureSchema } from "@omp-desktop/protocol/messages";

export function findModelByReference(
  models: AgentModelDefinition[] | null,
  modelId: string,
): AgentModelDefinition | null {
  if (!models || models.length === 0) return null;
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) return null;
  return (
    models.find((model) => model.id === normalizedModelId) ??
    models.find((model) => model.aliases?.includes(normalizedModelId)) ??
    null
  );
}

export function filterSelectableModels(
  models: AgentModelDefinition[] | null,
): AgentModelDefinition[] | null {
  return models?.filter((model) => model.isSelectable !== false) ?? null;
}

/**
 * Catalog capabilities supersede old session snapshots, including removal of
 * Fast when the newly selected model does not support it. Other dynamic
 * features still come from the session metadata path.
 */
export function getModelDraftFeatures(
  model: AgentModelDefinition | null,
  sessionFeatures?: AgentFeature[],
): AgentFeature[] | undefined {
  if (!model) return sessionFeatures;
  const parsed = AgentFeatureSchema.array().safeParse(model.metadata?.draftFeatures);
  if (!parsed.success) return sessionFeatures;
  return [
    ...(sessionFeatures ?? []).filter(
      (feature) => feature.id !== "fast_mode" && feature.id !== "workflow_mode",
    ),
    ...parsed.data,
  ];
}
