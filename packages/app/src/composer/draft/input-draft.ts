import { useCallback, useEffect, useMemo, useState } from "react";
import type { UserComposerAttachment } from "@/attachments/types";
import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { DraftCommandConfig } from "@/hooks/use-agent-commands-query";
import {
  useAgentFormState,
  type CreateAgentInitialValues,
  type UseAgentFormStateResult,
} from "@/hooks/use-agent-form-state";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";
import {
  buildDraftAgentControls,
  hasDraftContent,
  resolveDraftKey,
  type DraftKeyInput,
} from "@/composer/draft/input-draft-core";
import {
  buildDraftCommandConfig,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  type ProviderSelectionState,
} from "@/provider-selection/provider-selection";
import { useDraftStore } from "@/stores/draft-store";
import { toDraftInputIfReady } from "@/stores/draft-store/state";
import { AfterPaintPublication } from "@/composer/after-paint-publication";
import { isWeb } from "@/constants/platform";

const EMPTY_ATTACHMENTS: readonly UserComposerAttachment[] = [];

type AttachmentUpdater =
  | UserComposerAttachment[]
  | ((prev: UserComposerAttachment[]) => UserComposerAttachment[]);

interface AgentInputDraftComposerOptions {
  initialServerId: string | null;
  initialValues?: CreateAgentInitialValues;
  initialFeatureValues?: Record<string, unknown>;
  isVisible?: boolean;
  onlineServerIds?: string[];
  lockedWorkingDir?: string;
  persistPreferences?: boolean;
}

interface UseAgentInputDraftInput {
  draftKey: DraftKeyInput;
  composer?: AgentInputDraftComposerOptions;
}

type DraftComposerState = UseAgentFormStateResult & {
  workingDir: string;
  effectiveModelId: string;
  effectiveThinkingOptionId: string;
  featureValues: Record<string, unknown> | undefined;
  agentControls: DraftAgentControlsProps;
  commandDraftConfig: DraftCommandConfig | undefined;
};

export interface AgentInputDraft {
  text: string;
  editText: (text: string) => void;
  replaceText: (text: string) => void;
  textReplacementKey: string;
  getSnapshot: () => {
    text: string;
    attachments: readonly UserComposerAttachment[];
  } | null;
  attachments: UserComposerAttachment[];
  setAttachments: (updater: AttachmentUpdater) => void;
  restoreIfEmpty: (draft: { text: string; attachments: UserComposerAttachment[] }) => void;
  clear: (lifecycle: "sent" | "abandoned") => void;
  isHydrated: boolean;
  attachmentFocusRequestId: number;
  composerState: DraftComposerState | null;
}

export function useAgentInputDraft(input: UseAgentInputDraftInput): AgentInputDraft {
  const composerOptions = input.composer ?? null;
  const persistPreferences = composerOptions?.persistPreferences;
  const formState = useAgentFormState({
    initialServerId: composerOptions?.initialServerId ?? null,
    initialValues: composerOptions?.initialValues,
    isVisible: composerOptions?.isVisible ?? false,
    isCreateFlow: true,
    onlineServerIds: composerOptions?.onlineServerIds ?? [],
    persistPreferences,
  });
  const draftKey = useMemo(
    () =>
      resolveDraftKey({
        draftKey: input.draftKey,
        selectedServerId: formState.selectedServerId,
      }),
    [formState.selectedServerId, input.draftKey],
  );
  const draftRecord = useDraftStore((state) => state.drafts[draftKey]);
  const draft = useMemo(() => toDraftInputIfReady(draftRecord), [draftRecord]);
  const attachmentFocusRequestId = useDraftStore(
    (state) => state.attachmentFocusRequestByDraftKey[draftKey] ?? 0,
  );
  const [hydratedDraftKey, setHydratedDraftKey] = useState<string | null>(null);
  const [textReplacementRevision, setTextReplacementRevision] = useState(0);
  const text = draft?.text ?? "";
  const attachments = draft?.attachments ?? [];
  const isHydrated = hydratedDraftKey === draftKey;

  const saveDraft = useCallback(
    (
      update: (draft: { text: string; attachments: UserComposerAttachment[] }) => {
        text: string;
        attachments: UserComposerAttachment[];
      },
    ) => {
      const store = useDraftStore.getState();
      const current = store.getDraftInput(draftKey) ?? { text: "", attachments: [] };
      const next = update(current);
      if (!hasDraftContent(next)) {
        store.clearDraftInput({ draftKey, lifecycle: "abandoned" });
        return;
      }
      store.saveDraftInput({ draftKey, draft: next });
    },
    [draftKey],
  );

  const textPublication = useMemo(
    () =>
      new AfterPaintPublication<string>((nextText) => {
        saveDraft((current) => ({ ...current, text: nextText }));
      }),
    [saveDraft],
  );

  const getSnapshot = useCallback(() => {
    const current = useDraftStore.getState().getDraftInput(draftKey);
    const pendingText = textPublication.peek();
    if (pendingText === null || pendingText === current?.text) return current ?? null;
    return { text: pendingText, attachments: current?.attachments ?? EMPTY_ATTACHMENTS };
  }, [draftKey, textPublication]);

  const editText = useCallback(
    (nextText: string) => {
      if (isWeb) {
        textPublication.stage(nextText);
      } else {
        saveDraft((current) => ({ ...current, text: nextText }));
      }
    },
    [saveDraft, textPublication],
  );

  const replaceText = useCallback(
    (nextText: string) => {
      textPublication.cancel();
      saveDraft((current) => ({ ...current, text: nextText }));
      setTextReplacementRevision((revision) => revision + 1);
    },
    [saveDraft, textPublication],
  );

  const setAttachments = useCallback(
    (updater: AttachmentUpdater) => {
      saveDraft((current) => ({
        ...current,
        attachments: typeof updater === "function" ? updater(current.attachments) : updater,
      }));
    },
    [saveDraft],
  );

  const restoreIfEmpty = useCallback(
    (rewound: { text: string; attachments: UserComposerAttachment[] }) => {
      textPublication.cancel();
      let restored = false;
      saveDraft((current) => {
        if (hasDraftContent(current)) {
          return current;
        }
        restored = hasDraftContent(rewound);
        return rewound;
      });
      if (restored && rewound.text.length > 0) {
        setTextReplacementRevision((revision) => revision + 1);
      }
    },
    [saveDraft, textPublication],
  );

  const clear = useCallback(
    (lifecycle: "sent" | "abandoned") => {
      textPublication.cancel();
      useDraftStore.getState().clearDraftInput({ draftKey, lifecycle });
    },
    [draftKey, textPublication],
  );

  useEffect(() => {
    if (composerOptions?.isVisible === false) {
      textPublication.flush();
    }
  }, [composerOptions?.isVisible, textPublication]);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") textPublication.flush();
    };
    const flush = () => textPublication.flush();
    const canListenForPageHide =
      isWeb && typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (isWeb && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", flushWhenHidden);
    }
    if (canListenForPageHide) {
      window.addEventListener("pagehide", flush);
    }
    return () => {
      if (isWeb && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", flushWhenHidden);
      }
      if (canListenForPageHide) {
        window.removeEventListener("pagehide", flush);
      }
      const lifecycle = useDraftStore.getState().drafts[draftKey]?.lifecycle;
      if (lifecycle === "abandoned" || lifecycle === "sent") {
        textPublication.cancel();
      } else {
        textPublication.flush();
      }
    };
  }, [draftKey, textPublication]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await useDraftStore.getState().hydrateDraftInput({ draftKey });
      if (!cancelled) {
        setTextReplacementRevision((revision) => revision + 1);
        setHydratedDraftKey(draftKey);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftKey]);

  const lockedWorkingDir = composerOptions?.lockedWorkingDir?.trim() ?? "";
  useEffect(() => {
    if (!composerOptions || !lockedWorkingDir) {
      return;
    }
    if (formState.workingDir.trim() === lockedWorkingDir) {
      return;
    }
    formState.setWorkingDir(lockedWorkingDir);
  }, [composerOptions, formState, lockedWorkingDir]);

  const providerSelection = useMemo<ProviderSelectionState>(
    () => ({
      provider: formState.selectedProvider,
      modelId: formState.selectedModel,
      modeId: formState.selectedMode,
      thinkingOptionId: formState.selectedThinkingOptionId,
      availableModels: formState.availableModels,
      modeOptions: formState.modeOptions,
    }),
    [
      formState.availableModels,
      formState.modeOptions,
      formState.selectedMode,
      formState.selectedModel,
      formState.selectedProvider,
      formState.selectedThinkingOptionId,
    ],
  );

  const effectiveModelId = useMemo(
    () => resolveEffectiveComposerModelId(providerSelection),
    [providerSelection],
  );

  const effectiveThinkingOptionId = useMemo(
    () => resolveEffectiveComposerThinkingOptionId(providerSelection, effectiveModelId),
    [effectiveModelId, providerSelection],
  );

  const workingDir = lockedWorkingDir || formState.workingDir;
  const {
    features: draftFeatures,
    featureValues: draftFeatureValues,
    setFeatureValue: setDraftFeatureValue,
    metadataStatus: featureMetadataStatus,
    retryMetadata: retryFeatureMetadata,
  } = useDraftAgentFeatures({
    serverId: formState.selectedServerId,
    provider: formState.selectedProvider,
    persistPreferences,
    cwd: workingDir,
    modeId: formState.selectedMode,
    modelId: effectiveModelId,
    thinkingOptionId: effectiveThinkingOptionId,
    initialFeatureValues: composerOptions?.initialFeatureValues,
  });

  const commandDraftConfig = useMemo(
    () =>
      composerOptions
        ? buildDraftCommandConfig({
            selection: providerSelection,
            cwd: workingDir,
            effectiveModelId,
            effectiveThinkingOptionId,
            featureValues: draftFeatureValues,
          })
        : undefined,
    [
      composerOptions,
      effectiveModelId,
      effectiveThinkingOptionId,
      draftFeatureValues,
      providerSelection,
      workingDir,
    ],
  );

  const composerState = useMemo<DraftComposerState | null>(() => {
    if (!composerOptions) {
      return null;
    }

    return {
      ...formState,
      workingDir,
      effectiveModelId,
      effectiveThinkingOptionId,
      featureValues: draftFeatureValues,
      agentControls: buildDraftAgentControls({
        formState,
        features: draftFeatures,
        onSetFeature: setDraftFeatureValue,
        featureMetadataStatus,
        onRetryFeatureMetadata: retryFeatureMetadata,
      }),
      commandDraftConfig,
    };
  }, [
    commandDraftConfig,
    composerOptions,
    effectiveModelId,
    effectiveThinkingOptionId,
    draftFeatures,
    featureMetadataStatus,
    retryFeatureMetadata,
    draftFeatureValues,
    formState,
    setDraftFeatureValue,
    workingDir,
  ]);

  return {
    text,
    getSnapshot,
    editText,
    replaceText,
    textReplacementKey: `${draftKey}:${textReplacementRevision}`,
    attachments,
    setAttachments,
    restoreIfEmpty,
    clear,
    isHydrated,
    attachmentFocusRequestId,
    composerState,
  };
}

export const __private__ = {
  resolveDraftKey,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  buildDraftCommandConfig,
  buildDraftComposerCommandConfig: buildDraftCommandConfig,
  buildDraftAgentControls,
};
