import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeFastModeFeatureValue } from "@/agent-controls/policy";
import type { ModelUsageHistoryProps } from "@/components/model-usage-history";
import { useToast } from "@/contexts/toast-context";
import {
  getModelUsageKey,
  useModelUsageStore,
  type ModelUsageEntry,
  type ModelUsageSelection,
} from "@/stores/model-usage-store";
import { toErrorMessage } from "@/utils/error-messages";
import { getFastModeTier, type FastModeFeature } from "./utils";

type RestorePhase = "model" | "thinking" | "speed" | "confirm";
interface RestoreRequest {
  entry: ModelUsageEntry;
  phase: RestorePhase;
}

function areSavedOptionsAvailable(
  entry: ModelUsageSelection,
  selection: ModelUsageSelection,
  thinkingOptions: readonly { id: string }[] | undefined,
  fastMode: FastModeFeature | null,
): boolean {
  const thinkingAvailable =
    entry.thinkingOptionId === null
      ? selection.thinkingOptionId === null
      : thinkingOptions?.some((option) => option.id === entry.thinkingOptionId) === true;
  const speedAvailable =
    entry.speed === null
      ? fastMode === null
      : fastMode !== null && normalizeFastModeFeatureValue(fastMode, entry.speed) !== undefined;
  return thinkingAvailable && speedAvailable;
}

export function useModelUsageHistory(input: {
  serverId: string | null;
  provider: string;
  modelId: string;
  thinkingOptionId?: string;
  thinkingOptions?: readonly { id: string }[];
  fastMode: FastModeFeature | null;
  metadataStatus?: "loading" | "error" | "ready";
  open: boolean;
  pending: boolean;
  disabled: boolean;
  onSelectModel: (provider: string, modelId: string) => void | Promise<void>;
  onSelectThinkingOption?: (id: string) => void | Promise<void>;
  onSetFeature?: (id: string, value: unknown) => void | Promise<void>;
  onApplyConfiguration?: (selection: ModelUsageSelection) => Promise<void>;
}) {
  const { onSelectModel, onSelectThinkingOption, onSetFeature, onApplyConfiguration } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const entries = useModelUsageStore((state) => state.entries);
  const recordUsage = useModelUsageStore((state) => state.recordUsage);
  const removeUsage = useModelUsageStore((state) => state.removeUsage);
  const [restore, setRestore] = useState<RestoreRequest | null>(null);
  const [dirty, setDirty] = useState(false);
  const interactionStartKey = useRef<string | null>(null);
  const interactionServerId = useRef<string | null>(null);
  const modelIntent = useRef<{ provider: string; modelId: string } | null>(null);
  const inFlight = useRef<RestoreRequest | null>(null);
  const selection = useMemo<ModelUsageSelection | null>(
    () =>
      input.serverId && input.provider && input.modelId
        ? {
            serverId: input.serverId,
            provider: input.provider,
            modelId: input.modelId,
            thinkingOptionId: input.thinkingOptionId || null,
            speed: getFastModeTier(input.fastMode),
          }
        : null,
    [input.serverId, input.provider, input.modelId, input.thinkingOptionId, input.fastMode],
  );
  const selectionKey = selection ? getModelUsageKey(selection) : null;

  const markInteraction = useCallback(() => {
    if (!dirty) {
      interactionStartKey.current = selectionKey;
      interactionServerId.current = input.serverId;
    }
    setDirty(true);
  }, [dirty, input.serverId, selectionKey]);
  const markModelSelection = useCallback(
    (provider: string, modelId: string) => {
      markInteraction();
      modelIntent.current = { provider, modelId };
    },
    [markInteraction],
  );
  const markSettingsChange = useCallback(() => {
    markInteraction();
    modelIntent.current = null;
  }, [markInteraction]);

  // A menu visit contributes its final configuration once, never intermediate settings.
  useEffect(() => {
    if (
      !dirty ||
      input.open ||
      input.pending ||
      restore ||
      !selection ||
      input.metadataStatus === "loading" ||
      input.metadataStatus === "error"
    )
      return;
    const intent = modelIntent.current;
    if (
      interactionServerId.current !== selection.serverId ||
      (intent && (intent.provider !== selection.provider || intent.modelId !== selection.modelId))
    ) {
      setDirty(false);
      modelIntent.current = null;
      return;
    }
    if (intent || selectionKey !== interactionStartKey.current) recordUsage(selection);
    setDirty(false);
    modelIntent.current = null;
  }, [
    dirty,
    input.open,
    input.pending,
    input.metadataStatus,
    restore,
    selection,
    selectionKey,
    recordUsage,
  ]);

  const failRestore = useCallback(
    (error: unknown) => {
      setRestore(null);
      setDirty(false);
      toast.error(toErrorMessage(error));
    },
    [toast],
  );
  const onSelect = useCallback(
    async (entry: ModelUsageEntry) => {
      if (input.disabled || input.pending || restore) return;
      setDirty(false);
      modelIntent.current = null;
      setRestore({ entry, phase: "model" });
      try {
        if (onApplyConfiguration) {
          await onApplyConfiguration(entry);
          setRestore({ entry, phase: "confirm" });
        } else {
          await onSelectModel(entry.provider, entry.modelId);
          setRestore({ entry, phase: "thinking" });
        }
      } catch (error) {
        failRestore(error);
      }
    },
    [input.disabled, input.pending, onApplyConfiguration, onSelectModel, restore, failRestore],
  );

  useEffect(() => {
    if (!restore || restore.phase === "model" || input.pending) return;
    const { entry, phase } = restore;
    if (input.serverId !== entry.serverId) {
      setRestore(null);
      return;
    }
    if (!selection) return;
    if (selection.provider !== entry.provider || selection.modelId !== entry.modelId) return;
    if (phase === "confirm") {
      if (input.metadataStatus === "loading") return;
      if (
        input.metadataStatus === "error" ||
        !areSavedOptionsAvailable(entry, selection, input.thinkingOptions, input.fastMode)
      ) {
        failRestore(new Error(t("modelSelector.historyUnavailable")));
        return;
      }
      if (selectionKey !== entry.key) return;
      if (entries.some((candidate) => candidate.key === entry.key)) {
        modelIntent.current = { provider: entry.provider, modelId: entry.modelId };
        interactionStartKey.current = selectionKey;
        interactionServerId.current = entry.serverId;
        setDirty(true);
      }
      setRestore(null);
      return;
    }
    if (inFlight.current === restore) return;
    if (phase === "speed" && input.metadataStatus === "loading") return;
    inFlight.current = restore;
    void (async () => {
      if (phase === "thinking") {
        if (
          entry.thinkingOptionId !== null &&
          entry.thinkingOptionId !== selection.thinkingOptionId
        ) {
          if (
            !onSelectThinkingOption ||
            !input.thinkingOptions?.some((option) => option.id === entry.thinkingOptionId)
          ) {
            throw new Error(t("modelSelector.historyUnavailable"));
          }
          await onSelectThinkingOption(entry.thinkingOptionId);
        }
        setRestore({ entry, phase: "speed" });
        return;
      }
      if (selection.thinkingOptionId !== entry.thinkingOptionId) {
        throw new Error(t("modelSelector.historyUnavailable"));
      }
      if (input.metadataStatus === "error") throw new Error(t("modelSelector.historyUnavailable"));
      if (entry.speed !== null && selection.speed !== entry.speed) {
        const value = input.fastMode
          ? normalizeFastModeFeatureValue(input.fastMode, entry.speed)
          : undefined;
        if (value === undefined || !onSetFeature)
          throw new Error(t("modelSelector.historyUnavailable"));
        await onSetFeature(input.fastMode!.id, value);
      } else if (entry.speed === null && selection.speed !== null) {
        throw new Error(t("modelSelector.historyUnavailable"));
      }
      setRestore({ entry, phase: "confirm" });
    })().catch(failRestore);
  }, [
    restore,
    input.serverId,
    input.pending,
    input.metadataStatus,
    input.thinkingOptions,
    input.fastMode,
    onSelectThinkingOption,
    onSetFeature,
    selection,
    selectionKey,
    entries,
    failRestore,
    t,
  ]);

  const onRemove = useCallback(
    (key: string) => {
      removeUsage(key);
      // Deleting the active entry must not recreate it when this menu closes.
      if (key === selectionKey) {
        setDirty(false);
        modelIntent.current = null;
      }
    },
    [removeUsage, selectionKey],
  );
  const history = useMemo<ModelUsageHistoryProps>(
    () => ({
      entries: entries.filter((entry) => entry.serverId === input.serverId),
      selection,
      onSelect,
      onRemove,
      disabled: input.disabled || input.pending || restore !== null,
    }),
    [
      entries,
      input.serverId,
      input.disabled,
      input.pending,
      selection,
      onSelect,
      onRemove,
      restore,
    ],
  );
  return { history, restoring: restore !== null, markModelSelection, markSettingsChange };
}
