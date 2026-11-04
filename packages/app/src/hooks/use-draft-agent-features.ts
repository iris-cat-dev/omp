import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  AgentFeature,
  AgentProvider,
  AgentSessionConfig,
} from "@omp-desktop/protocol/agent-types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { mergeProviderPreferences, useFormPreferences } from "./use-form-preferences";
import {
  sanitizePersistentAgentFeatureValues,
  shouldPersistAgentFeatureValue,
} from "@/create-agent-preferences/preferences";
import {
  applyWorkflowLocale,
  applyFeatureValues,
  pruneFeatureValues,
  retainDraftWorkflowValues,
  resolveFeatureValues,
} from "./feature-preferences";
import type { SupportedLocale } from "@/i18n/locales";
import { useProvidersSnapshot } from "./use-providers-snapshot";
import { findModelByReference, getModelDraftFeatures } from "@/provider-selection/model-catalog";

type DraftFeatureConfig = Pick<
  AgentSessionConfig,
  "provider" | "cwd" | "modeId" | "model" | "thinkingOptionId"
>;

export interface UseDraftAgentFeaturesResult {
  features: AgentFeature[];
  featureValues: Record<string, unknown> | undefined;
  isLoading: boolean;
  metadataError: string | undefined;
  setFeatureValue: (featureId: string, value: unknown) => void;
}

export function useDraftAgentFeatures(input: {
  serverId: string | null | undefined;
  provider: AgentProvider | null;
  cwd: string | null | undefined;
  modeId: string | null | undefined;
  modelId: string | null | undefined;
  thinkingOptionId: string | null | undefined;
  initialFeatureValues?: Record<string, unknown>;
  persistPreferences?: boolean;
}): UseDraftAgentFeaturesResult {
  const { t, i18n } = useTranslation();
  const { serverId, provider, cwd, modeId, modelId, thinkingOptionId, initialFeatureValues } =
    input;
  const [localFeatureValues, setLocalFeatureValues] = useState<Record<string, unknown>>(() =>
    sanitizePersistentAgentFeatureValues(initialFeatureValues ?? {}),
  );
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const { preferences, updatePreferences } = useFormPreferences();
  const normalizedCwd = cwd?.trim() || "";
  const normalizedProvider = provider ?? null;
  const previousProviderRef = useRef<AgentProvider | null>(normalizedProvider);
  const persistedFeatureValues = useMemo(
    () => (provider ? (preferences.providerPreferences?.[provider]?.featureValues ?? {}) : {}),
    [preferences.providerPreferences, provider],
  );

  const draftConfig = useMemo<DraftFeatureConfig | null>(() => {
    if (!normalizedProvider || !normalizedCwd) {
      return null;
    }

    return {
      provider: normalizedProvider,
      cwd: normalizedCwd,
      ...(modeId ? { modeId } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    };
  }, [modeId, modelId, normalizedCwd, normalizedProvider, thinkingOptionId]);

  // Subscribe to the form's existing catalog without initiating a refresh.
  const { entries: providerEntries } = useProvidersSnapshot(serverId ?? null, { enabled: false });
  const selectedModel = useMemo(
    () =>
      modelId
        ? findModelByReference(
            providerEntries?.find((entry) => entry.provider === provider)?.models ?? null,
            modelId,
          )
        : null,
    [modelId, provider, providerEntries],
  );
  const catalogFeatures = useMemo(() => getModelDraftFeatures(selectedModel), [selectedModel]);

  const featuresQuery = useQuery({
    queryKey: [
      "providerFeatures",
      serverId ?? null,
      normalizedProvider,
      normalizedCwd || null,
      modeId ?? null,
      modelId ?? null,
      thinkingOptionId ?? null,
    ],
    enabled: Boolean(serverId && client && isConnected && draftConfig),
    staleTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!client || !draftConfig) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.listProviderFeatures(draftConfig);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.features ?? [];
    },
  });
  const availableFeaturesRaw = useMemo(
    () => getModelDraftFeatures(selectedModel, featuresQuery.data),
    [featuresQuery.data, selectedModel],
  );
  const availableFeatures = useMemo(() => availableFeaturesRaw ?? [], [availableFeaturesRaw]);
  const featureValues = useMemo(
    () =>
      availableFeaturesRaw === undefined
        ? { ...persistedFeatureValues, ...localFeatureValues }
        : resolveFeatureValues({
            features: availableFeatures,
            persistedFeatureValues,
            localFeatureValues,
          }),
    [availableFeatures, availableFeaturesRaw, localFeatureValues, persistedFeatureValues],
  );

  const features = useMemo(() => {
    return applyFeatureValues(availableFeatures, featureValues);
  }, [availableFeatures, featureValues]);

  useEffect(() => {
    const previousProvider = previousProviderRef.current;
    previousProviderRef.current = normalizedProvider;
    if (previousProvider === null) {
      return;
    }
    if (previousProvider !== normalizedProvider) {
      setLocalFeatureValues((current) => retainDraftWorkflowValues(current));
    }
  }, [normalizedProvider]);

  useEffect(() => {
    if (availableFeaturesRaw === undefined) {
      return;
    }
    const next = pruneFeatureValues(localFeatureValues, availableFeatures);
    if (next !== localFeatureValues) {
      setLocalFeatureValues(next);
    }
  }, [availableFeatures, availableFeaturesRaw, localFeatureValues]);

  const localizedFeatureValues = useMemo(
    () =>
      normalizedProvider === "omp"
        ? applyWorkflowLocale(
            featureValues,
            (i18n.resolvedLanguage ?? i18n.language) as SupportedLocale,
          )
        : featureValues,
    [featureValues, i18n.language, i18n.resolvedLanguage, normalizedProvider],
  );
  const effectiveFeatureValues =
    Object.keys(localizedFeatureValues).length > 0 ? localizedFeatureValues : undefined;
  const setFeatureValue = useCallback(
    (featureId: string, value: unknown) => {
      setLocalFeatureValues((current) => {
        if (Object.is(current[featureId], value)) {
          return current;
        }

        return { ...current, [featureId]: value };
      });
      if (
        input.persistPreferences === false ||
        !provider ||
        !shouldPersistAgentFeatureValue(featureId)
      ) {
        return;
      }
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider,
          updates: {
            featureValues: {
              [featureId]: value,
            },
          },
        }),
      ).catch((error) => {
        console.warn("[useDraftAgentFeatures] persist feature preference failed", error);
      });
    },
    [provider, updatePreferences, input.persistPreferences],
  );

  return {
    features,
    featureValues: effectiveFeatureValues,
    isLoading: catalogFeatures === undefined && featuresQuery.isLoading,
    metadataError: catalogFeatures === undefined ? featuresQuery.error?.message : undefined,
    setFeatureValue,
  };
}
