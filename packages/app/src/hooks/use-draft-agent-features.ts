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
import {
  PROVIDER_FEATURES_GC_TIME_MS,
  PROVIDER_FEATURES_STALE_TIME_MS,
  providerFeaturesQueryRoot,
} from "@/data/provider-features";

type DraftFeatureConfig = Pick<
  AgentSessionConfig,
  "provider" | "cwd" | "modeId" | "model" | "thinkingOptionId" | "featureValues"
>;

export interface DraftAgentFeaturesResult {
  features: AgentFeature[];
  featureValues: Record<string, unknown> | undefined;
  isLoading: boolean;
  metadataStatus: "loading" | "error" | "ready";
  ensureMetadata: () => void;
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
}): DraftAgentFeaturesResult {
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
  const account =
    localFeatureValues.oauth_account_credential ??
    persistedFeatureValues.oauth_account_credential ??
    "automatic";

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
      featureValues: { oauth_account_credential: account },
    };
  }, [account, modeId, modelId, normalizedCwd, normalizedProvider, thinkingOptionId]);

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
  const modelCapabilities = useMemo(
    () =>
      JSON.stringify([
        selectedModel?.metadata?.provider,
        selectedModel?.metadata?.modelId,
        selectedModel?.metadata?.serviceTiers,
        getModelDraftFeatures(selectedModel)?.map((feature) => [
          feature.id,
          feature.type,
          ...(feature.type === "select" ? [feature.options.map((option) => option.id)] : []),
        ]),
      ]),
    [selectedModel],
  );

  const featuresQuery = useQuery({
    queryKey: [
      ...providerFeaturesQueryRoot(serverId ?? null, normalizedProvider ?? undefined),
      normalizedCwd || null,
      modeId ?? null,
      modelId ?? null,
      thinkingOptionId ?? null,
      account,
      modelCapabilities,
    ],
    enabled: Boolean(serverId && client && isConnected && draftConfig),
    staleTime: PROVIDER_FEATURES_STALE_TIME_MS,
    gcTime: PROVIDER_FEATURES_GC_TIME_MS,
    refetchOnMount: true,
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
    () =>
      featuresQuery.isSuccess
        ? featuresQuery.data
        : getModelDraftFeatures(selectedModel, featuresQuery.data),
    [featuresQuery.data, featuresQuery.isSuccess, selectedModel],
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
    const applied = applyFeatureValues(availableFeatures, featureValues);
    return isConnected && featuresQuery.isSuccess && !featuresQuery.isFetching
      ? applied
      : applied.filter((feature) => feature.id !== "fast_mode");
  }, [
    availableFeatures,
    featureValues,
    isConnected,
    featuresQuery.isFetching,
    featuresQuery.isSuccess,
  ]);

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
    if (
      availableFeaturesRaw === undefined ||
      !featuresQuery.isSuccess ||
      featuresQuery.isFetching
    ) {
      return;
    }
    const next = pruneFeatureValues(localFeatureValues, availableFeatures);
    if (next !== localFeatureValues) {
      setLocalFeatureValues(next);
    }
  }, [
    availableFeatures,
    availableFeaturesRaw,
    localFeatureValues,
    featuresQuery.isSuccess,
    featuresQuery.isFetching,
  ]);

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
      if (
        featureId === "fast_mode" &&
        (!isConnected ||
          !featuresQuery.isSuccess ||
          featuresQuery.isFetching ||
          !features.some((feature) => feature.id === "fast_mode"))
      )
        return;
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
    [
      provider,
      updatePreferences,
      input.persistPreferences,
      features,
      isConnected,
      featuresQuery.isFetching,
      featuresQuery.isSuccess,
    ],
  );
  const refetchMetadata = featuresQuery.refetch;
  const ensureMetadata = useCallback(() => {
    if (
      isConnected &&
      draftConfig &&
      !featuresQuery.isFetching &&
      (featuresQuery.isStale || featuresQuery.isError)
    ) {
      void refetchMetadata();
    }
  }, [
    draftConfig,
    featuresQuery.isError,
    featuresQuery.isFetching,
    featuresQuery.isStale,
    isConnected,
    refetchMetadata,
  ]);
  const metadataStatus = useMemo<DraftAgentFeaturesResult["metadataStatus"]>(() => {
    if (!isConnected) return "error";
    if (featuresQuery.isFetching || featuresQuery.isPending) return "loading";
    if (featuresQuery.isError) return "error";
    return "ready";
  }, [isConnected, featuresQuery.isFetching, featuresQuery.isPending, featuresQuery.isError]);

  return {
    features,
    featureValues: effectiveFeatureValues,
    isLoading: featuresQuery.isLoading,
    metadataStatus,
    ensureMetadata,
    setFeatureValue,
  };
}
