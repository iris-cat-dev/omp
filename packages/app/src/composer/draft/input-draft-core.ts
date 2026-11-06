import equal from "fast-deep-equal";
import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { UseAgentFormStateResult } from "@/hooks/use-agent-form-state";

export interface DraftKeyContext {
  selectedServerId: string | null;
}

export type DraftKeyInput = string | ((context: DraftKeyContext) => string);

export function resolveDraftKey(input: {
  draftKey: DraftKeyInput;
  selectedServerId: string | null;
}): string {
  if (typeof input.draftKey === "function") {
    return input.draftKey({ selectedServerId: input.selectedServerId });
  }
  return input.draftKey;
}

export function buildDraftAgentControls(input: {
  formState: UseAgentFormStateResult;
  features?: DraftAgentControlsProps["features"];
  onSetFeature?: DraftAgentControlsProps["onSetFeature"];
  onDropdownClose?: DraftAgentControlsProps["onDropdownClose"];
  featureMetadataStatus?: DraftAgentControlsProps["featureMetadataStatus"];
  onRetryFeatureMetadata?: DraftAgentControlsProps["onRetryFeatureMetadata"];
}): DraftAgentControlsProps {
  const { formState, features, onSetFeature, onDropdownClose } = input;
  return {
    providerDefinitions: formState.providerDefinitions,
    selectedProvider: formState.selectedProvider,
    modeOptions: formState.modeOptions,
    selectedMode: formState.selectedMode,
    onSelectMode: formState.setModeFromUser,
    models: formState.availableModels,
    selectedModel: formState.selectedModel,
    onSelectModel: formState.setModelFromUser,
    isModelLoading: formState.isModelLoading,
    modelSelectorProviders: formState.modelSelectorProviders,
    isAllModelsLoading: formState.isAllModelsLoading,
    onSelectProviderAndModel: formState.setProviderAndModelFromUser,
    thinkingOptions: formState.availableThinkingOptions,
    selectedThinkingOptionId: formState.selectedThinkingOptionId,
    onSelectThinkingOption: formState.setThinkingOptionFromUser,
    features,
    onSetFeature,
    featureMetadataStatus: input.featureMetadataStatus,
    onRetryFeatureMetadata: input.onRetryFeatureMetadata,
    onDropdownClose,
    onModelSelectorOpen: formState.refetchProviderModelsIfStale,
    onRetryModelProvider: formState.refreshProviderModels,
    isRetryingModelProvider: formState.isProviderModelsRefreshing,
    modelSelectorServerId: formState.selectedServerId,
  };
}

export function hasDraftContent(input: {
  text: string;
  attachments: UserComposerAttachment[];
}): boolean {
  return input.text.length > 0 || input.attachments.length > 0;
}

export function areAttachmentsEqual(input: {
  left: readonly ComposerAttachment[];
  right: readonly ComposerAttachment[];
}): boolean {
  return equal(input.left, input.right);
}
