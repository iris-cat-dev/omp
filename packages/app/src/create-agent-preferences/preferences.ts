import { z } from "zod";
import type { AgentProvider } from "@omp-desktop/protocol/agent-types";

const featureValuesSchema = z.record(z.string(), z.union([z.boolean(), z.string(), z.null()]));
const TRANSIENT_FEATURE_IDS: Record<string, true> = {
  workflow_mode: true,
  workflow_locale: true,
  oauth_account_credential: true,
  goal_objective: true,
  goal_status: true,
};

export function shouldPersistAgentFeatureValue(featureId: string): boolean {
  return TRANSIENT_FEATURE_IDS[featureId] !== true;
}

export function sanitizePersistentAgentFeatureValues(
  values: Record<string, unknown>,
): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  for (const featureId of Object.keys(values)) {
    if (shouldPersistAgentFeatureValue(featureId)) continue;
    next ??= { ...values };
    delete next[featureId];
  }
  return next ?? values;
}

export interface ProviderPreferences {
  model?: string;
  mode?: string;
  thinkingByModel?: Record<string, string>;
  featureValues?: Record<string, unknown>;
}

export type LaunchTarget = { kind: "chat" } | { kind: "terminal"; profileId: string };

export interface FormPreferences {
  provider?: string;
  providerPreferences?: Record<string, ProviderPreferences>;
  isolation?: "local" | "worktree";
  launchTarget?: LaunchTarget;
}

const providerPreferencesSchema: z.ZodType<ProviderPreferences> = z.strictObject({
  model: z.string().optional(),
  mode: z.string().optional(),
  thinkingByModel: z.record(z.string(), z.string()).optional(),
  featureValues: featureValuesSchema.optional(),
});

const launchTargetSchema: z.ZodType<LaunchTarget> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chat") }),
  z.strictObject({ kind: z.literal("terminal"), profileId: z.string() }),
]);

export const FormPreferencesSchema = z.strictObject({
  provider: z.string().optional(),
  providerPreferences: z.record(z.string(), providerPreferencesSchema).optional(),
  isolation: z.enum(["local", "worktree"]).optional(),
  // Keep previously saved launch targets readable until persisted preferences
  // are migrated; current draft tabs no longer use this setting.
  launchTarget: launchTargetSchema.optional(),
}) satisfies z.ZodType<FormPreferences>;

const LegacyProviderPreferencesSchema = z.strictObject({
  model: z.string().optional(),
  mode: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});

const LegacyFormPreferencesSchema = z
  .strictObject({
    workingDir: z.string().optional(),
    provider: z.string().optional(),
    serverId: z.string().optional(),
    providerPreferences: z.record(z.string(), LegacyProviderPreferencesSchema).optional(),
  })
  .transform(({ provider, providerPreferences }): FormPreferences => {
    const migratedProviderPreferences: Record<string, ProviderPreferences> = {};
    for (const [providerId, legacy] of Object.entries(providerPreferences ?? {})) {
      const model = legacy.model;
      migratedProviderPreferences[providerId] = {
        ...(model !== undefined ? { model } : {}),
        ...(legacy.mode !== undefined ? { mode: legacy.mode } : {}),
        ...(model !== undefined && legacy.thinkingOptionId !== undefined
          ? { thinkingByModel: { [model]: legacy.thinkingOptionId } }
          : {}),
      };
    }
    return {
      ...(provider !== undefined ? { provider } : {}),
      ...(providerPreferences !== undefined
        ? { providerPreferences: migratedProviderPreferences }
        : {}),
    };
  });

export const StoredFormPreferencesSchema: z.ZodType<FormPreferences> = z.preprocess(
  (value) => {
    if (typeof value !== "object" || value === null || !("favoriteModels" in value)) {
      return value;
    }
    const preferences: Record<string, unknown> = { ...value };
    delete preferences.favoriteModels;
    return preferences;
  },
  z.union([FormPreferencesSchema, LegacyFormPreferencesSchema]),
);

export const DEFAULT_FORM_PREFERENCES: FormPreferences = {};

export function parseFormPreferences(value: unknown): FormPreferences {
  const result = StoredFormPreferencesSchema.safeParse(value);
  if (!result.success || !result.data.providerPreferences) {
    return result.success ? result.data : DEFAULT_FORM_PREFERENCES;
  }

  let nextProviderPreferences: Record<string, ProviderPreferences> | null = null;
  for (const [provider, providerPreferences] of Object.entries(result.data.providerPreferences)) {
    if (!providerPreferences.featureValues) continue;
    const featureValues = sanitizePersistentAgentFeatureValues(providerPreferences.featureValues);
    if (featureValues === providerPreferences.featureValues) continue;
    nextProviderPreferences ??= { ...result.data.providerPreferences };
    nextProviderPreferences[provider] = {
      ...providerPreferences,
      ...(Object.keys(featureValues).length > 0 ? { featureValues } : {}),
    };
    if (Object.keys(featureValues).length === 0) {
      delete nextProviderPreferences[provider].featureValues;
    }
  }

  return nextProviderPreferences
    ? { ...result.data, providerPreferences: nextProviderPreferences }
    : result.data;
}

function mergeDefinedRecord<T>(
  existing: Record<string, T> | undefined,
  updates: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (updates === undefined) {
    return existing;
  }
  return {
    ...existing,
    ...updates,
  };
}

function applyProviderPreferenceUpdates(
  existing: ProviderPreferences,
  updates: Omit<Partial<ProviderPreferences>, "mode"> & { mode?: string | null },
): ProviderPreferences {
  const next: ProviderPreferences = { ...existing };
  const nextThinkingByModel = mergeDefinedRecord(existing.thinkingByModel, updates.thinkingByModel);
  const mergedFeatureValues = mergeDefinedRecord(existing.featureValues, updates.featureValues);
  const nextFeatureValues = mergedFeatureValues
    ? sanitizePersistentAgentFeatureValues(mergedFeatureValues)
    : undefined;
  if (updates.model !== undefined) {
    next.model = updates.model;
  }
  if (updates.mode === null) {
    delete next.mode;
  } else if (updates.mode !== undefined) {
    next.mode = updates.mode;
  }
  if (nextThinkingByModel !== undefined) {
    next.thinkingByModel = nextThinkingByModel;
  }
  if (
    nextFeatureValues &&
    (Object.keys(nextFeatureValues).length > 0 || nextFeatureValues === mergedFeatureValues)
  ) {
    next.featureValues = nextFeatureValues;
  } else {
    delete next.featureValues;
  }

  return next;
}

export function mergeProviderPreferences(args: {
  preferences: FormPreferences;
  provider: AgentProvider;
  updates: Omit<Partial<ProviderPreferences>, "mode"> & { mode?: string | null };
}): FormPreferences {
  const { preferences, provider, updates } = args;
  const existingProviderPreferences = preferences.providerPreferences ?? {};
  const existing = existingProviderPreferences[provider] ?? {};

  return {
    ...preferences,
    provider,
    providerPreferences: {
      ...existingProviderPreferences,
      [provider]: applyProviderPreferenceUpdates(existing, updates),
    },
  };
}
