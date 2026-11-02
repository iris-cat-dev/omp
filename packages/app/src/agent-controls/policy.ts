import type { AgentFeature, AgentMode } from "@omp-desktop/protocol/agent-types";

export const PLAN_MODE_FEATURE_ID = "plan_mode";
export const FAST_MODE_FEATURE_ID = "fast_mode";

export type FastModeTier = "off" | "on" | "ultrafast";

export function normalizeFastModeFeatureValue(
  feature: AgentFeature,
  value: unknown,
): FastModeTier | boolean | undefined {
  let tier = value;
  if (typeof value === "boolean") tier = value ? "on" : "off";
  if (tier !== "off" && tier !== "on" && tier !== "ultrafast") return undefined;
  if (feature.type === "select") {
    return feature.options.some((option) => option.id === tier) ? tier : undefined;
  }
  // A saved Ultrafast preference must never become a truthy legacy Fast toggle.
  if (tier === "ultrafast") return undefined;
  return tier === "on";
}

export function isPlanningAgentMode(mode: Pick<AgentMode, "id" | "colorTier">): boolean {
  return mode.colorTier === "planning" || mode.id === "plan" || mode.id.endsWith("#plan");
}

export function resolveNonPlanningModeId(
  modes: readonly AgentMode[],
  defaultModeId: string | null,
): string | null {
  const defaultMode = modes.find((mode) => mode.id === defaultModeId);
  if (defaultMode && !isPlanningAgentMode(defaultMode)) {
    return defaultMode.id;
  }
  return modes.find((mode) => !isPlanningAgentMode(mode))?.id ?? null;
}
