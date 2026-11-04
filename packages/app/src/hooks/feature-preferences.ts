import type { AgentFeature } from "@omp-desktop/protocol/agent-types";
import { FAST_MODE_FEATURE_ID, normalizeFastModeFeatureValue } from "@/agent-controls/policy";
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
  const availableFeatures = new Map(features.map((feature) => [feature.id, feature]));
  let changed = false;
  const next: Record<string, unknown> = {};

  for (const [featureId, value] of Object.entries(featureValues)) {
    if (
      !availableFeatures.has(featureId) &&
      featureId !== FAST_MODE_FEATURE_ID &&
      DRAFT_FEATURE_COMPANION_IDS[featureId] !== true
    ) {
      changed = true;
      continue;
    }
    const feature = availableFeatures.get(featureId);
    const normalizedValue =
      featureId === FAST_MODE_FEATURE_ID && feature
        ? normalizeFastModeFeatureValue(feature, value)
        : value;
    // Retain an unsupported tier for when its model returns; never coerce it to Fast.
    const retainedValue = normalizedValue === undefined ? value : normalizedValue;
    if (!Object.is(retainedValue, value)) changed = true;
    next[featureId] = retainedValue;
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

  return features.flatMap<AgentFeature>((feature) => {
    if (!Object.prototype.hasOwnProperty.call(featureValues, feature.id)) {
      return feature;
    }

    const value =
      feature.id === FAST_MODE_FEATURE_ID
        ? normalizeFastModeFeatureValue(feature, featureValues[feature.id])
        : featureValues[feature.id];
    // A saved tier that this definition cannot represent is unavailable, not
    // the native default and never an implicit ordinary Fast selection.
    if (value === undefined) return feature.id === FAST_MODE_FEATURE_ID ? [] : [feature];
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
      const value = args.localFeatureValues[feature.id];
      const normalizedValue =
        feature.id === FAST_MODE_FEATURE_ID ? normalizeFastModeFeatureValue(feature, value) : value;
      if (normalizedValue !== undefined) next[feature.id] = normalizedValue;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(args.persistedFeatureValues, feature.id)) {
      const value = args.persistedFeatureValues[feature.id];
      const normalizedValue =
        feature.id === FAST_MODE_FEATURE_ID ? normalizeFastModeFeatureValue(feature, value) : value;
      if (normalizedValue !== undefined) next[feature.id] = normalizedValue;
    }
  }
  // An unavailable native tier is a retained preference, not permission to use
  // a different service. Send it unchanged when starting a later capable model.
  const fastPreference = Object.prototype.hasOwnProperty.call(
    args.localFeatureValues,
    FAST_MODE_FEATURE_ID,
  )
    ? args.localFeatureValues[FAST_MODE_FEATURE_ID]
    : args.persistedFeatureValues[FAST_MODE_FEATURE_ID];
  if (fastPreference !== undefined && next[FAST_MODE_FEATURE_ID] === undefined) {
    next[FAST_MODE_FEATURE_ID] = fastPreference;
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
