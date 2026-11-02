import type { AgentFeature } from "@omp-desktop/protocol/agent-types";
import type { SupportedLocale } from "@/i18n/locales";

export const WORKFLOW_MODE_FEATURE_ID = "workflow_mode";
export const WORKFLOW_LOCALE_FEATURE_ID = "workflow_locale";

const DRAFT_FEATURE_COMPANION_IDS: Record<string, true> = {
  [WORKFLOW_MODE_FEATURE_ID]: true,
  [WORKFLOW_LOCALE_FEATURE_ID]: true,
  goal_objective: true,
  goal_status: true,
};

export function retainDraftWorkflowValues(
  featureValues: Record<string, unknown>,
): Record<string, unknown> {
  const retained: Record<string, unknown> = {};
  for (const featureId of Object.keys(DRAFT_FEATURE_COMPANION_IDS)) {
    if (Object.prototype.hasOwnProperty.call(featureValues, featureId)) {
      retained[featureId] = featureValues[featureId];
    }
  }
  return retained;
}

export function pruneFeatureValues(
  featureValues: Record<string, unknown>,
  features: AgentFeature[],
): Record<string, unknown> {
  const allowedFeatureIds = new Set(features.map((feature) => feature.id));
  let changed = false;
  const next: Record<string, unknown> = {};

  for (const [featureId, value] of Object.entries(featureValues)) {
    if (!allowedFeatureIds.has(featureId) && DRAFT_FEATURE_COMPANION_IDS[featureId] !== true) {
      changed = true;
      continue;
    }
    next[featureId] = value;
  }

  return changed ? next : featureValues;
}

export function applyWorkflowLocale(
  featureValues: Record<string, unknown>,
  locale: SupportedLocale,
): Record<string, unknown> {
  if (featureValues[WORKFLOW_LOCALE_FEATURE_ID] === locale) {
    return featureValues;
  }
  return {
    ...featureValues,
    [WORKFLOW_LOCALE_FEATURE_ID]: locale,
  };
}

export function applyFeatureValues(
  features: AgentFeature[],
  featureValues: Record<string, unknown>,
): AgentFeature[] {
  if (Object.keys(featureValues).length === 0) {
    return features;
  }

  return features.map((feature) => {
    if (!Object.prototype.hasOwnProperty.call(featureValues, feature.id)) {
      return feature;
    }

    const value = featureValues[feature.id];
    return {
      ...feature,
      value,
      ...(feature.type === "select" && !Object.is(feature.value, value)
        ? { effectiveValue: null }
        : {}),
    } as AgentFeature;
  });
}

export function resolveFeatureValues(args: {
  features: AgentFeature[];
  persistedFeatureValues: Record<string, unknown>;
  localFeatureValues: Record<string, unknown>;
}): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  for (const feature of args.features) {
    if (Object.prototype.hasOwnProperty.call(args.localFeatureValues, feature.id)) {
      next[feature.id] = args.localFeatureValues[feature.id];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(args.persistedFeatureValues, feature.id)) {
      next[feature.id] = args.persistedFeatureValues[feature.id];
    }
  }
  const supportsWorkflow = args.features.some((feature) => feature.id === "workflow_mode");
  if (supportsWorkflow) {
    for (const featureId of Object.keys(DRAFT_FEATURE_COMPANION_IDS)) {
      if (Object.prototype.hasOwnProperty.call(args.localFeatureValues, featureId)) {
        next[featureId] = args.localFeatureValues[featureId];
      }
    }
  }

  return next;
}
