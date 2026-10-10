import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import {
  View,
  Text,
  Pressable,
  Keyboard,
  useWindowDimensions,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { ListTodo, Settings2, SlidersHorizontal, Sparkles, Target, Zap } from "lucide-react-native";
import { getAgentFeatureIcon } from "@/agent-controls/icons";
import {
  formatAgentFeatureLabel,
  formatAgentFeatureOptionLabel,
  formatThinkingOptionLabel,
} from "@/agent-controls/labels";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import {
  buildProviderSelectorProviders,
  buildSelectableProviderSelectorProviders,
  getAllProviderModelRows,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { useSessionStore } from "@/stores/session-store";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { resolveProviderDefinition } from "@/utils/provider-definitions";
import { mergeProviderPreferences, useFormPreferences } from "@/hooks/use-form-preferences";
import { shouldPersistAgentFeatureValue } from "@/create-agent-preferences/preferences";
import {
  ENHANCED_WORKFLOW_MODE,
  WORKFLOW_LOCALE_FEATURE_ID,
  WORKFLOW_MODE_FEATURE_ID,
} from "@/hooks/feature-preferences";
import type { SupportedLocale } from "@/i18n/locales";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import {
  AgentModeControl,
  useLiveAgentModeControl,
  type AgentModeControlValue,
} from "@/composer/agent-controls/mode-control";
import { groupOmpModelsByProviderNamespace } from "@/composer/agent-controls/model-sheet-flow";
import {
  formatOmpAccountSelectionLabel,
  resolveOmpAccountControlLabels,
} from "@/components/omp-provider-accounts";
import {
  useOmpAccountQuota,
  type OmpAccountQuotaDisplayAccount,
} from "@/hooks/use-omp-account-quota";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  AgentFeature,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "@omp-desktop/protocol/agent-types";
import type { AgentProviderDefinition } from "@omp-desktop/protocol/provider-manifest";
import {
  getFeatureHighlightColor,
  getFeatureTooltip,
  getAgentControlHintKey,
  isComposerFeatureVisible,
  resolveAgentModelSelection,
} from "@/composer/agent-controls/utils";
import { useIsCompactFormFactor } from "@/constants/layout";
import { readMeasuredWidth } from "@/hooks/use-container-width";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import {
  useAgentControlCommandCenterActions,
  type AgentControlCommandCenterSource,
} from "@/command-center/agent-control-registration";
import { useActiveAgentControlRegistration } from "@/command-center/provider";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { isNative } from "@/constants/platform";
import {
  resolveComposerControlDensity,
  resolveComposerControlPresentation,
  resolveComposerToolbarGlyphSize,
  type ComposerControlDensity,
  type ComposerControlPresentation,
} from "@/composer/agent-controls/layout";
import { ComposerControlLayoutProvider } from "@/composer/agent-controls/layout-context";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { CompactModelSheet } from "@/composer/agent-controls/model-sheet";
import { ModelSettingsPanel } from "@/composer/agent-controls/model-settings-panel";
import { partitionModelFeatures } from "@/composer/agent-controls/utils";
import { ModelContextWindowControl } from "@/composer/agent-controls/model-context-window-control";
import {
  useAgentProfileEditor,
  useAgentProfilePicker,
  type AgentProfileApplyTarget,
  type AgentProfileEditorControls,
  type AgentProfilePicker,
  type AgentProfileSeed,
  type DraftAgentProfileControls,
} from "@/agent-profiles";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

const OMP_OAUTH_ACCOUNT_FEATURE_ID = "oauth_account_credential";

interface AgentControlOption {
  id: string;
  label: string;
}
type OmpWorkflowQuotaDisplayAccount = OmpAccountQuotaDisplayAccount;
function formatFeatureOptionLabel(
  featureId: string,
  option: AgentControlOption,
  oauthAccounts: readonly OmpWorkflowQuotaDisplayAccount[] = [],
): string {
  if (featureId === OMP_OAUTH_ACCOUNT_FEATURE_ID) {
    const account = oauthAccounts.find((candidate) => String(candidate.credentialId) === option.id);
    if (account) {
      return formatOmpAccountSelectionLabel({
        note: account.note,
        identityKey: account.identityKey,
        fallback: option.label,
      });
    }
  }
  return formatAgentFeatureOptionLabel(featureId, option);
}

type AgentControlSelector = "provider" | "mode" | "model" | `feature-${string}`;

const EMPTY_AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [];

interface ControlledAgentControlsProps {
  provider: string;
  providerOptions?: AgentControlOption[];
  selectedProviderId?: string;
  onSelectProvider?: (providerId: string) => void;
  modelOptions?: AgentControlOption[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void | Promise<void>;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void | Promise<void>;
  thinkingOptions?: AgentControlOption[];
  selectedThinkingOptionId?: string;
  onSelectThinkingOption?: (thinkingOptionId: string) => void;
  disabled?: boolean;
  accountSelectionDisabled?: boolean;
  isModelLoading?: boolean;
  modelSelectorProviders?: ProviderSelectorProvider[];
  agentProfiles?: AgentProfilePicker | null;
  onApplyAgentProfile?: (profileId: string) => void;
  onEditAgentProfiles?: () => void;
  onCreateAgentProfile?: (seed: AgentProfileSeed) => void;
  onEditAgentProfile?: (profileId: string) => void;
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  workflowQuotaAccounts?: OmpWorkflowQuotaDisplayAccount[];
  isRetryingModelProvider?: boolean;
  modeControl?: AgentModeControlValue | null;
  modelSelectorServerId?: string | null;
  isCompactLayout?: boolean;
}

export interface DraftAgentControlsProps {
  providerDefinitions: AgentProviderDefinition[];
  selectedProvider: AgentProvider | null;
  modeOptions: AgentMode[];
  selectedMode: string;
  onSelectMode: (modeId: string) => void;
  models: AgentModelDefinition[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  isModelLoading: boolean;
  modelSelectorProviders: ProviderSelectorProvider[];
  isAllModelsLoading: boolean;
  onSelectProviderAndModel: (provider: AgentProvider, modelId: string) => void;
  thinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
  selectedThinkingOptionId: string;
  onSelectThinkingOption: (thinkingOptionId: string) => void;
  onApplyAgentProfile: DraftAgentProfileControls["applyProfile"];
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider?: boolean;
  disabled?: boolean;
  modelSelectorServerId?: string | null;
  isCompactLayout?: boolean;
}

interface AgentControlsProps {
  agentId: string;
  serverId: string;
  onDropdownClose?: () => void;
  isCompactLayout?: boolean;
}

function AgentControlCommandCenterRegistration({
  sourceId,
  enabled,
  controls,
}: {
  sourceId: string;
  enabled: boolean;
  controls: AgentControlCommandCenterSource;
}) {
  const { isActiveComposer } = useComposerKeyboardScope();
  useAgentControlCommandCenterActions({
    sourceId,
    enabled: enabled && isActiveComposer,
    controls,
  });
  return null;
}

function findOptionLabel(
  options: AgentControlOption[] | undefined,
  selectedId: string | undefined,
  fallback: string,
) {
  if (!options || options.length === 0) {
    return fallback;
  }
  const selected = options.find((option) => option.id === selectedId);
  return selected?.label ?? fallback;
}

function toCommandCenterModes(modeControl: AgentModeControlValue | null) {
  if (!modeControl) return undefined;
  return {
    options: modeControl.modeOptions,
    selectedId: modeControl.selectedModeId,
    select: modeControl.onSelectMode,
  };
}

function getModeProviderDefinitions(modeControl: AgentModeControlValue | null) {
  return modeControl?.providerDefinitions ?? EMPTY_AGENT_PROVIDER_DEFINITIONS;
}

function getFeatureIconColor(
  featureId: string,
  enabled: boolean,
  palette: {
    blue: { 400: string };
    green: { 400: string };
    yellow: { 400: string };
  },
  foregroundMuted: string,
): string {
  if (!enabled) {
    return foregroundMuted;
  }

  switch (getFeatureHighlightColor(featureId)) {
    case "blue":
      return palette.blue[400];
    case "green":
      return palette.green[400];
    case "yellow":
      return palette.yellow[400];
    default:
      return foregroundMuted;
  }
}

type ActiveSheet = "features" | null;

function resolveHasAnyControl({
  providerOptions,
  canSelectModel,
  thinkingOptions,
  features,
  hasMode,
}: {
  providerOptions: AgentControlOption[] | undefined;
  canSelectModel: boolean;
  thinkingOptions: AgentControlOption[] | undefined;
  features: AgentFeature[] | undefined;
  hasMode: boolean;
}) {
  return (
    Boolean(providerOptions?.length) ||
    canSelectModel ||
    Boolean(thinkingOptions?.length) ||
    Boolean(features?.length) ||
    hasMode
  );
}

function toComboboxOptions(options: AgentControlOption[] | undefined): ComboboxOption[] {
  return (options ?? []).map((o) => ({ id: o.id, label: o.label }));
}

function toThinkingControlOptions(options: AgentControlOption[] | undefined): AgentControlOption[] {
  return (options ?? []).map((option) => ({
    id: option.id,
    label: formatThinkingOptionLabel(option),
  }));
}

/**
 * The picker's edit shortcut. Agent profiles are host config, so it lands on the
 * host settings section that owns the list.
 */
function useEditAgentProfilesNavigation(
  serverId: string | null,
  isSupported: boolean,
): (() => void) | undefined {
  const handleEdit = useCallback(() => {
    if (!serverId) return;
    router.push(buildSettingsHostSectionRoute(serverId, "agents"));
  }, [serverId]);
  return serverId && isSupported ? handleEdit : undefined;
}

function resolveAgentProfileEditorActions(
  isSupported: boolean,
  editor: AgentProfileEditorControls,
): {
  create?: (seed: AgentProfileSeed) => void;
  edit?: (profileId: string) => void;
} {
  if (!isSupported) {
    return {};
  }
  return {
    create: editor.openCreateFromModel,
    edit: editor.openEdit,
  };
}

function buildFallbackModelSelectorProviders(
  provider: string,
  modelOptions: AgentControlOption[] | undefined,
): ProviderSelectorProvider[] {
  if (!modelOptions || modelOptions.length === 0) {
    return [];
  }
  return [
    {
      id: provider,
      label: provider,
      modelSelection: {
        kind: "models",
        rows: modelOptions.map((option) => ({
          favoriteKey: `${provider}:${option.id}`,
          provider,
          providerLabel: provider,
          modelId: option.id,
          modelLabel: option.label,
        })),
      },
    },
  ];
}

function makeBadgePressableStyle(
  baseStyle: StyleProp<ViewStyle>,
  disabledStyle: StyleProp<ViewStyle>,
  disabled: boolean,
  isOpen: boolean,
) {
  return ({ pressed, hovered }: PressableStateCallbackType) => [
    baseStyle,
    hovered && styles.modeBadgeHovered,
    (pressed || isOpen) && styles.modeBadgePressed,
    disabled && disabledStyle,
  ];
}

async function pickSheetModel({
  nextProviderId,
  modelId,
  currentProvider,
  onSelectProviderAndModel,
  onSelectProvider,
  onSelectModel,
}: {
  nextProviderId: string;
  modelId: string;
  currentProvider: string;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void | Promise<void>;
  onSelectProvider?: (providerId: string) => void;
  onSelectModel?: (modelId: string) => void | Promise<void>;
}): Promise<void> {
  if (onSelectProviderAndModel) {
    await onSelectProviderAndModel(nextProviderId, modelId);
    if (nextProviderId === currentProvider) await onSelectModel?.(modelId);
    return;
  }
  if (nextProviderId !== currentProvider) {
    onSelectProvider?.(nextProviderId);
  }
  await onSelectModel?.(modelId);
}

async function pickDesktopModel({
  nextProviderId,
  modelId,
  currentProvider,
  onSelectModel,
  onSelectProviderAndModel,
}: {
  nextProviderId: string;
  modelId: string;
  currentProvider: string;
  onSelectModel?: (modelId: string) => void | Promise<void>;
  onSelectProviderAndModel?: (provider: string, modelId: string) => void | Promise<void>;
}): Promise<void> {
  if (onSelectProviderAndModel) {
    await onSelectProviderAndModel(nextProviderId, modelId);
    if (nextProviderId === currentProvider) await onSelectModel?.(modelId);
    return;
  }
  if (nextProviderId === currentProvider) {
    await onSelectModel?.(modelId);
  }
}

type AgentControlsSlice = {
  provider: string;
  cwd: string | null;
  runtimeModelId: string | null;
  model: string | null | undefined;
  features: AgentFeature[] | undefined;
  thinkingOptionId: string | null | undefined;
  status: string;
  lastUsage: unknown;
} | null;

function selectAgentControlsSlice(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string,
  agentId: string,
): AgentControlsSlice {
  const currentAgent = state.sessions[serverId]?.agents?.get(agentId) ?? null;
  if (!currentAgent) {
    return null;
  }
  return {
    provider: currentAgent.provider,
    cwd: currentAgent.cwd,
    runtimeModelId: currentAgent.runtimeInfo?.model ?? null,
    model: currentAgent.model,
    features: currentAgent.features,
    thinkingOptionId: currentAgent.thinkingOptionId,
    status: currentAgent.status,
    lastUsage: currentAgent.lastUsage,
  };
}

function resolveSnapshotSelectedEntry(
  snapshotEntries: ReturnType<typeof useProvidersSnapshot>["entries"],
  agentProvider: string | undefined,
) {
  if (!snapshotEntries || !agentProvider) {
    return null;
  }
  return snapshotEntries.find((e) => e.provider === agentProvider) ?? null;
}

function resolveSnapshotModeIds(
  entry: ReturnType<typeof resolveSnapshotSelectedEntry>,
): string[] | null {
  if (entry?.status !== "ready" || !entry.modes) {
    return null;
  }
  return entry.modes.map((mode) => mode.id);
}

function buildAgentProviderDefinitions(
  agentProvider: string | undefined,
  snapshotEntries: ReturnType<typeof useProvidersSnapshot>["entries"],
): AgentProviderDefinition[] {
  const definition = agentProvider
    ? resolveProviderDefinition(agentProvider, snapshotEntries)
    : undefined;
  return definition ? [definition] : [];
}

function buildAgentProviderModels(
  agentProvider: string | undefined,
  models: AgentModelDefinition[] | null,
): Map<string, AgentModelDefinition[]> {
  const map = new Map<string, AgentModelDefinition[]>();
  if (agentProvider && models) {
    map.set(agentProvider, models);
  }
  return map;
}

function buildOpenChangeHandler(
  selector: AgentControlSelector,
  setOpenSelector: (next: AgentControlSelector | null) => void,
  onDropdownClose?: () => void,
) {
  return (nextOpen: boolean) => {
    setOpenSelector(nextOpen ? selector : null);
    if (!nextOpen) {
      onDropdownClose?.();
    }
  };
}

// This component resolves responsive presentation across provider, model, mode, and feature controls.
// eslint-disable-next-line complexity
function ControlledAgentControls({
  provider,
  providerOptions,
  selectedProviderId,
  onSelectProvider,
  modelOptions,
  selectedModelId,
  onSelectModel,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  disabled = false,
  accountSelectionDisabled = false,
  isModelLoading = false,
  modelSelectorProviders,
  agentProfiles = null,
  onApplyAgentProfile,
  onEditAgentProfiles,
  onCreateAgentProfile,
  onEditAgentProfile,
  features,
  onSetFeature,
  onDropdownClose,
  onModelSelectorOpen,
  onRetryModelProvider,
  isRetryingModelProvider = false,
  modeControl,
  modelSelectorServerId = null,
  isCompactLayout,
  workflowQuotaAccounts,
}: ControlledAgentControlsProps) {
  const { t } = useTranslation();
  const isCompactFormFactor = useIsCompactFormFactor();
  const isCompact = isCompactLayout ?? isCompactFormFactor;
  const { fontScale } = useWindowDimensions();
  const [activeSheet, setActiveSheet] = useState<ActiveSheet>(null);
  const [openSelector, setOpenSelector] = useState<AgentControlSelector | null>(null);
  const [modelSelectionPending, setModelSelectionPending] = useState(false);
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const initialDensity: ComposerControlDensity = isCompact ? "tight" : "full";
  const [density, setDensity] = useState<ComposerControlDensity>(initialDensity);
  const densityRef = useRef<ComposerControlDensity>(initialDensity);
  const availableWidthRef = useRef(0);

  useEffect(() => {
    if (accountSelectionDisabled && openSelector === `feature-${OMP_OAUTH_ACCOUNT_FEATURE_ID}`) {
      setOpenSelector(null);
    }
  }, [accountSelectionDisabled, openSelector]);

  const providerAnchorRef = useRef<View>(null);

  const canSelectProvider = Boolean(
    onSelectProvider && providerOptions && providerOptions.length > 0,
  );
  const canSelectModel = Boolean(onSelectModel);
  const canSelectThinking = Boolean(
    onSelectThinkingOption && thinkingOptions && thinkingOptions.length > 1,
  );

  const displayProvider = findOptionLabel(
    providerOptions,
    selectedProviderId,
    t("agentControls.provider.fallback"),
  );
  const formattedThinkingOptions = useMemo(
    () => toThinkingControlOptions(thinkingOptions),
    [thinkingOptions],
  );
  const displayThinking = findOptionLabel(
    formattedThinkingOptions,
    selectedThinkingOptionId,
    formattedThinkingOptions[0]?.label ?? t("agentControls.thinking.unknown"),
  );
  const partitionedFeatures = useMemo(() => partitionModelFeatures(features), [features]);

  const hasAnyControl = resolveHasAnyControl({
    providerOptions,
    canSelectModel,
    thinkingOptions,
    features,
    hasMode: modeControl !== null && modeControl !== undefined,
  });
  const featureControls = useMemo(
    () =>
      partitionedFeatures.remaining.map((feature) => {
        if (feature.type === "toggle") return { type: "toggle" as const };
        const selectedOption = feature.options.find((option) => option.id === feature.value);
        return {
          type: "select" as const,
          label: selectedOption
            ? formatFeatureOptionLabel(feature.id, selectedOption, workflowQuotaAccounts)
            : formatAgentFeatureLabel(feature),
        };
      }),
    [partitionedFeatures.remaining, workflowQuotaAccounts],
  );
  const controlPresence = useMemo(
    () => ({
      hasModel: canSelectModel,
      hasThinking: false,
      hasMode: modeControl !== null && modeControl !== undefined,
      features: featureControls,
      fontScale,
    }),
    [canSelectModel, featureControls, fontScale, modeControl],
  );
  const presentation = useMemo(() => resolveComposerControlPresentation(density), [density]);
  const layoutContextValue = useMemo(
    () => ({
      glyphSize: resolveComposerToolbarGlyphSize(isNative ? "native" : "web"),
      presentation,
    }),
    [presentation],
  );

  const updateDensityForWidth = useCallback(
    (availableWidth: number) => {
      const nextDensity = resolveComposerControlDensity({
        availableWidth,
        currentDensity: densityRef.current,
        controls: controlPresence,
      });
      if (nextDensity === densityRef.current) return;
      densityRef.current = nextDensity;
      setDensity(nextDensity);
    },
    [controlPresence],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const availableWidth = readMeasuredWidth(event);
      if (availableWidth === null) return;
      availableWidthRef.current = availableWidth;
      updateDensityForWidth(availableWidth);
    },
    [updateDensityForWidth],
  );

  useEffect(() => {
    if (availableWidthRef.current > 0) {
      updateDensityForWidth(availableWidthRef.current);
    }
  }, [updateDensityForWidth]);

  const modelDisabled = disabled || !provider;

  const comboboxProviderOptions = useMemo<ComboboxOption[]>(
    () => toComboboxOptions(providerOptions),
    [providerOptions],
  );
  const fallbackModelSelectorProviders = useMemo(
    () => buildFallbackModelSelectorProviders(provider, modelOptions),
    [modelOptions, provider],
  );
  const rawModelSelectorProviders = modelSelectorProviders ?? fallbackModelSelectorProviders;
  const effectiveModelSelectorProviders = useMemo(
    () => groupOmpModelsByProviderNamespace(rawModelSelectorProviders),
    [rawModelSelectorProviders],
  );
  const normalizedSelectedModelId = selectedModelId ?? "";
  const selectedModelRow = getAllProviderModelRows(effectiveModelSelectorProviders).find(
    (row) => row.modelId === normalizedSelectedModelId,
  );
  const selectedContextWindowMaxTokens = selectedModelRow?.contextWindowMaxTokens;

  const handleOpenChange = useCallback(
    (selector: AgentControlSelector) =>
      buildOpenChangeHandler(selector, setOpenSelector, onDropdownClose),
    [onDropdownClose],
  );
  const handleModelSelectorOpened = useCallback(() => {
    setModelSelectorOpen(true);
    onModelSelectorOpen?.();
  }, [onModelSelectorOpen]);
  const handleModelSelectorClosed = useCallback(() => {
    setModelSelectorOpen(false);
    onDropdownClose?.();
  }, [onDropdownClose]);
  const handleSheetOpenChange = useCallback(
    (selector: AgentControlSelector) => (nextOpen: boolean) => {
      setOpenSelector(nextOpen ? selector : null);
    },
    [],
  );

  const handleProviderPress = useCallback(() => {
    handleOpenChange("provider")(openSelector !== "provider");
  }, [handleOpenChange, openSelector]);

  const handleProviderOpenChange = useMemo(() => handleOpenChange("provider"), [handleOpenChange]);

  const handleProviderSelect = useCallback(
    (id: string) => onSelectProvider?.(id),
    [onSelectProvider],
  );

  const handleDesktopModelSelect = useCallback(
    async (nextProviderId: string, modelId: string) => {
      setModelSelectionPending(true);
      try {
        await pickDesktopModel({
          nextProviderId,
          modelId,
          currentProvider: provider,
          onSelectModel,
          onSelectProviderAndModel,
        });
      } finally {
        setModelSelectionPending(false);
      }
    },
    [onSelectModel, onSelectProviderAndModel, provider],
  );

  const providerPressableStyle = useMemo(
    () =>
      makeBadgePressableStyle(
        styles.modeBadge,
        styles.disabledBadge,
        disabled || !canSelectProvider,
        openSelector === "provider",
      ),
    [canSelectProvider, disabled, openSelector],
  );

  const handleOpenSheet = useCallback((sheet: Exclude<ActiveSheet, null>) => {
    Keyboard.dismiss();
    setActiveSheet(sheet);
  }, []);

  const handleCloseSheet = useCallback(() => {
    setActiveSheet(null);
    if (!isCompact) onDropdownClose?.();
  }, [isCompact, onDropdownClose]);

  const handleSheetModelSelect = useCallback(
    async (nextProviderId: string, modelId: string) => {
      setModelSelectionPending(true);
      try {
        await pickSheetModel({
          nextProviderId,
          modelId,
          currentProvider: provider,
          onSelectProviderAndModel,
          onSelectProvider,
          onSelectModel,
        });
      } finally {
        setModelSelectionPending(false);
      }
    },
    [onSelectModel, onSelectProvider, onSelectProviderAndModel, provider],
  );
  const hasModelSettings =
    canSelectThinking ||
    partitionedFeatures.fastMode !== null ||
    normalizedSelectedModelId.length > 0;
  /* Memoized panels are intentionally passed through the shared model-selector shell. */
  /* eslint-disable react-perf/jsx-no-jsx-as-prop */
  const desktopModelSettings = hasModelSettings ? (
    <ModelSettingsPanel
      thinkingOptions={formattedThinkingOptions}
      selectedThinkingOptionId={selectedThinkingOptionId}
      onSelectThinkingOption={onSelectThinkingOption}
      fastMode={partitionedFeatures.fastMode}
      onSetFeature={onSetFeature}
      contextControl={
        <ModelContextWindowControl
          serverId={modelSelectorServerId}
          provider={provider}
          modelId={normalizedSelectedModelId}
          catalogContextWindowMaxTokens={selectedContextWindowMaxTokens}
          enabled={modelSelectorOpen}
          disabled={disabled || modelSelectionPending}
        />
      }
      disabled={disabled}
      pending={modelSelectionPending}
    />
  ) : null;
  const compactModelSettings = hasModelSettings ? (
    <ModelSettingsPanel
      thinkingOptions={formattedThinkingOptions}
      selectedThinkingOptionId={selectedThinkingOptionId}
      onSelectThinkingOption={onSelectThinkingOption}
      fastMode={partitionedFeatures.fastMode}
      onSetFeature={onSetFeature}
      contextControl={
        <ModelContextWindowControl
          serverId={modelSelectorServerId}
          provider={provider}
          modelId={normalizedSelectedModelId}
          catalogContextWindowMaxTokens={selectedContextWindowMaxTokens}
          enabled={modelSelectorOpen}
          disabled={disabled || modelSelectionPending}
          compact
        />
      }
      disabled={disabled}
      pending={modelSelectionPending}
      compact
    />
  ) : null;
  /* eslint-enable react-perf/jsx-no-jsx-as-prop */

  if (!hasAnyControl) {
    return null;
  }

  return (
    <ComposerControlLayoutProvider value={layoutContextValue}>
      <View style={styles.container} onLayout={handleLayout}>
        {!isCompact ? (
          <DesktopAgentControlsContent
            provider={provider}
            providerOptions={providerOptions}
            selectedProviderId={selectedProviderId}
            selectedModelId={selectedModelId}
            features={partitionedFeatures.remaining}
            onSetFeature={onSetFeature}
            onApplyAgentProfile={onApplyAgentProfile}
            onEditAgentProfiles={onEditAgentProfiles}
            onCreateAgentProfile={onCreateAgentProfile}
            onEditAgentProfile={onEditAgentProfile}
            onDropdownClose={handleModelSelectorClosed}
            onModelSelectorOpen={handleModelSelectorOpened}
            onRetryModelProvider={onRetryModelProvider}
            isRetryingModelProvider={isRetryingModelProvider}
            agentProfiles={agentProfiles}
            disabled={disabled}
            accountSelectionDisabled={accountSelectionDisabled}
            isModelLoading={isModelLoading}
            canSelectProvider={canSelectProvider}
            canSelectModel={canSelectModel}
            modelSelectorProviders={effectiveModelSelectorProviders}
            modelDisabled={modelDisabled}
            comboboxProviderOptions={comboboxProviderOptions}
            displayProvider={displayProvider}
            displayThinking={canSelectThinking ? displayThinking : null}
            fastModeEnabled={partitionedFeatures.fastMode?.value === true}
            modelSettings={desktopModelSettings}
            modelSelectorOpen={modelSelectorOpen}
            openSelector={openSelector}
            providerAnchorRef={providerAnchorRef}
            providerPressableStyle={providerPressableStyle}
            handleProviderPress={handleProviderPress}
            handleProviderSelect={handleProviderSelect}
            handleDesktopModelSelect={handleDesktopModelSelect}
            handleProviderOpenChange={handleProviderOpenChange}
            handleOpenChange={handleOpenChange}
            handleNestedOpenChange={handleSheetOpenChange}
            modeControl={modeControl}
            presentation={presentation}
            glyphSize={layoutContextValue.glyphSize}
            activeSheet={activeSheet}
            handleOpenSheet={handleOpenSheet}
            handleCloseSheet={handleCloseSheet}
            modelSelectorServerId={modelSelectorServerId}
            workflowQuotaAccounts={workflowQuotaAccounts}
          />
        ) : (
          <SheetAgentControlsContent
            provider={provider}
            selectedModelId={selectedModelId}
            features={partitionedFeatures.remaining}
            oauthAccounts={workflowQuotaAccounts}
            onSetFeature={onSetFeature}
            onApplyAgentProfile={onApplyAgentProfile}
            onEditAgentProfiles={onEditAgentProfiles}
            onCreateAgentProfile={onCreateAgentProfile}
            onEditAgentProfile={onEditAgentProfile}
            onDropdownClose={handleModelSelectorClosed}
            onModelSelectorOpen={handleModelSelectorOpened}
            onRetryModelProvider={onRetryModelProvider}
            isRetryingModelProvider={isRetryingModelProvider}
            agentProfiles={agentProfiles}
            disabled={disabled}
            accountSelectionDisabled={accountSelectionDisabled}
            isModelLoading={isModelLoading}
            canSelectModel={canSelectModel}
            modelSelectorProviders={effectiveModelSelectorProviders}
            modelDisabled={modelDisabled}
            openSelector={openSelector}
            displayThinking={canSelectThinking ? displayThinking : null}
            fastModeEnabled={partitionedFeatures.fastMode?.value === true}
            modelSettings={compactModelSettings}
            handleSheetModelSelect={handleSheetModelSelect}
            handleOpenChange={handleSheetOpenChange}
            modeControl={modeControl}
            glyphSize={layoutContextValue.glyphSize}
            modelSelectorServerId={modelSelectorServerId}
            canSwitchProvider={false}
          />
        )}
      </View>
    </ComposerControlLayoutProvider>
  );
}

interface DesktopAgentControlsContentProps {
  provider: string;
  providerOptions?: AgentControlOption[];
  selectedProviderId?: string;
  selectedModelId?: string;
  features?: AgentFeature[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onApplyAgentProfile?: (profileId: string) => void;
  onEditAgentProfiles?: () => void;
  onCreateAgentProfile?: (seed: AgentProfileSeed) => void;
  onEditAgentProfile?: (profileId: string) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider: boolean;
  agentProfiles: AgentProfilePicker | null;
  disabled: boolean;
  accountSelectionDisabled: boolean;
  isModelLoading: boolean;
  canSelectProvider: boolean;
  canSelectModel: boolean;
  modelSelectorProviders: ProviderSelectorProvider[];
  modelDisabled: boolean;
  comboboxProviderOptions: ComboboxOption[];
  displayProvider: string;
  displayThinking: string | null;
  fastModeEnabled: boolean;
  modelSettings: ReactNode;
  modelSelectorOpen: boolean;
  openSelector: AgentControlSelector | null;
  providerAnchorRef: RefObject<View | null>;
  providerPressableStyle: (state: PressableStateCallbackType) => StyleProp<ViewStyle>;
  handleProviderPress: () => void;
  handleProviderSelect: (id: string) => void;
  handleDesktopModelSelect: (providerId: string, modelId: string) => void | Promise<void>;
  handleProviderOpenChange: (open: boolean) => void;
  handleOpenChange: (selector: AgentControlSelector) => (nextOpen: boolean) => void;
  handleNestedOpenChange: (selector: AgentControlSelector) => (nextOpen: boolean) => void;
  modeControl?: AgentModeControlValue | null;
  presentation: ComposerControlPresentation;
  glyphSize: number;
  activeSheet: ActiveSheet;
  handleOpenSheet: (sheet: Exclude<ActiveSheet, null>) => void;
  handleCloseSheet: () => void;
  modelSelectorServerId: string | null;
  workflowQuotaAccounts?: OmpWorkflowQuotaDisplayAccount[];
}

const DESKTOP_SEARCH_THRESHOLD = 6;

function DesktopAgentControlsContent(props: DesktopAgentControlsContentProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const {
    provider,
    providerOptions,
    selectedProviderId,
    selectedModelId,
    features,
    onSetFeature,
    onApplyAgentProfile,
    onEditAgentProfiles,
    onCreateAgentProfile,
    onEditAgentProfile,
    onDropdownClose,
    onModelSelectorOpen,
    onRetryModelProvider,
    isRetryingModelProvider,
    agentProfiles,
    disabled,
    accountSelectionDisabled,
    isModelLoading,
    canSelectProvider,
    canSelectModel,
    modelSelectorProviders,
    modelDisabled,
    comboboxProviderOptions,
    displayProvider,
    displayThinking,
    fastModeEnabled,
    modelSettings,
    modelSelectorOpen,
    openSelector,
    providerAnchorRef,
    providerPressableStyle,
    handleProviderPress,
    handleProviderSelect,
    handleDesktopModelSelect,
    handleProviderOpenChange,
    handleOpenChange,
    handleNestedOpenChange,
    modeControl,
    presentation,
    glyphSize,
    activeSheet,
    handleOpenSheet,
    handleCloseSheet,
    workflowQuotaAccounts,
  } = props;
  const visibleFeatures = useMemo(() => features?.filter(isComposerFeatureVisible), [features]);
  const modelToolbar = useMemo(
    () => ({ glyphSize, showCaret: presentation.showCarets }),
    [glyphSize, presentation.showCarets],
  );
  const featuresSheetHeader = useMemo<SheetHeader>(
    () => ({ title: t("agentControls.features.title") }),
    [t],
  );
  const handleOpenFeatures = useCallback(() => handleOpenSheet("features"), [handleOpenSheet]);
  const triggerAccessory =
    (displayThinking && presentation.showThinkingLabel) || fastModeEnabled ? (
      <>
        {displayThinking && presentation.showThinkingLabel ? (
          <Text style={styles.modelAccessoryText}>{displayThinking}</Text>
        ) : null}
        {fastModeEnabled ? <Zap size={14} color={theme.colors.palette.yellow[400]} /> : null}
      </>
    ) : null;
  return (
    <>
      {providerOptions && providerOptions.length > 1 ? (
        <>
          <ComboboxTrigger
            ref={providerAnchorRef}
            collapsable={false}
            disabled={disabled || !canSelectProvider}
            onPress={handleProviderPress}
            style={providerPressableStyle}
            accessibilityRole="button"
            accessibilityLabel={t("agentControls.provider.select")}
            testID="agent-provider-selector"
          >
            <Text style={styles.modeBadgeText}>{displayProvider}</Text>
          </ComboboxTrigger>
          <Combobox
            options={comboboxProviderOptions}
            value={selectedProviderId ?? ""}
            onSelect={handleProviderSelect}
            searchable={comboboxProviderOptions.length > DESKTOP_SEARCH_THRESHOLD}
            open={openSelector === "provider"}
            onOpenChange={handleProviderOpenChange}
            anchorRef={providerAnchorRef}
            desktopPlacement="top-start"
          />
        </>
      ) : null}

      {canSelectModel ? (
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="ref">
            <View style={styles.modelControl}>
              <CombinedModelSelector
                providers={modelSelectorProviders}
                selectedProvider={provider}
                selectedModel={selectedModelId ?? ""}
                onSelect={handleDesktopModelSelect}
                browseProviders={false}
                profiles={agentProfiles}
                onApplyProfile={onApplyAgentProfile}
                onEditProfiles={onEditAgentProfiles}
                onCreateProfile={onCreateAgentProfile}
                onEditProfile={onEditAgentProfile}
                isLoading={isModelLoading}
                disabled={modelDisabled}
                onOpen={onModelSelectorOpen}
                onClose={onDropdownClose}
                onRetryProvider={onRetryModelProvider}
                isRetryingProvider={isRetryingModelProvider}
                desktopPlacement="top-start"
                desktopMinWidth={400}
                toolbar={modelToolbar}
                footer={modelSettings}
                triggerAccessory={triggerAccessory}
                dismissOnSelect={false}
                open={modelSelectorOpen}
              />
            </View>
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <Text style={styles.tooltipText}>{t(getAgentControlHintKey("model"))}</Text>
          </TooltipContent>
        </Tooltip>
      ) : null}

      {modeControl ? <AgentModeControl {...modeControl} onClose={onDropdownClose} /> : null}

      {presentation.aggregateFeatures && visibleFeatures?.length ? (
        <>
          <Pressable
            onPress={handleOpenFeatures}
            disabled={disabled}
            style={styles.modeIconBadge}
            accessibilityRole="button"
            accessibilityLabel={t("agentControls.features.open")}
            testID="agent-controls-features"
          >
            <ComposerToolbarGlyph size={glyphSize}>
              <Settings2 size={glyphSize} color={theme.colors.foregroundMuted} />
            </ComposerToolbarGlyph>
          </Pressable>
          <AdaptiveModalSheet
            header={featuresSheetHeader}
            visible={activeSheet === "features"}
            onClose={handleCloseSheet}
            testID="agent-features-sheet"
          >
            {visibleFeatures.map((feature) => (
              <SheetFeatureItem
                key={`feature-${feature.id}`}
                feature={feature}
                oauthAccounts={workflowQuotaAccounts}
                disabled={
                  disabled ||
                  (accountSelectionDisabled && feature.id === OMP_OAUTH_ACCOUNT_FEATURE_ID)
                }
                openSelector={openSelector}
                handleOpenChange={handleNestedOpenChange}
                onSetFeature={onSetFeature}
              />
            ))}
          </AdaptiveModalSheet>
        </>
      ) : (
        visibleFeatures?.map((feature) => (
          <DesktopFeatureItem
            key={`feature-${feature.id}`}
            feature={feature}
            oauthAccounts={workflowQuotaAccounts}
            disabled={
              disabled || (accountSelectionDisabled && feature.id === OMP_OAUTH_ACCOUNT_FEATURE_ID)
            }
            openSelector={openSelector}
            handleOpenChange={handleOpenChange}
            onSetFeature={onSetFeature}
            onActionComplete={onDropdownClose}
          />
        ))
      )}
    </>
  );
}

interface SheetAgentControlsContentProps {
  provider: string;
  selectedModelId?: string;
  features?: AgentFeature[];
  oauthAccounts?: OmpWorkflowQuotaDisplayAccount[];
  onSetFeature?: (featureId: string, value: unknown) => void;
  onApplyAgentProfile?: (profileId: string) => void;
  onEditAgentProfiles?: () => void;
  onCreateAgentProfile?: (seed: AgentProfileSeed) => void;
  onEditAgentProfile?: (profileId: string) => void;
  onDropdownClose?: () => void;
  onModelSelectorOpen?: () => void;
  onRetryModelProvider?: (provider: AgentProvider) => void;
  isRetryingModelProvider: boolean;
  agentProfiles: AgentProfilePicker | null;
  disabled: boolean;
  accountSelectionDisabled: boolean;
  isModelLoading: boolean;
  canSelectModel: boolean;
  modelSelectorProviders: ProviderSelectorProvider[];
  modelDisabled: boolean;
  openSelector: AgentControlSelector | null;
  displayThinking: string | null;
  fastModeEnabled: boolean;
  modelSettings: ReactNode;
  handleSheetModelSelect: (providerId: string, modelId: string) => void | Promise<void>;
  handleOpenChange: (selector: AgentControlSelector) => (nextOpen: boolean) => void;
  modeControl?: AgentModeControlValue | null;
  glyphSize: number;
  modelSelectorServerId: string | null;
  canSwitchProvider: boolean;
}

function SheetAgentControlsContent(props: SheetAgentControlsContentProps) {
  const {
    provider,
    selectedModelId,
    features,
    oauthAccounts,
    onSetFeature,
    onApplyAgentProfile,
    onEditAgentProfiles,
    onCreateAgentProfile,
    onEditAgentProfile,
    onDropdownClose,
    onModelSelectorOpen,
    onRetryModelProvider,
    isRetryingModelProvider,
    agentProfiles,
    disabled,
    accountSelectionDisabled,
    isModelLoading,
    canSelectModel,
    modelSelectorProviders,
    modelDisabled,
    openSelector,
    displayThinking,
    fastModeEnabled,
    modelSettings,
    handleSheetModelSelect,
    handleOpenChange,
    modeControl,
    glyphSize,
    canSwitchProvider,
  } = props;
  const visibleFeatures = useMemo(() => features?.filter(isComposerFeatureVisible), [features]);

  const sheetControls = (
    <View style={styles.combinedSheetControls} testID="agent-controls-combined-sheet-controls">
      {modelSettings}
      {modeControl ? <AgentModeControl {...modeControl} surface="sheet" /> : null}
      {(visibleFeatures ?? []).map((feature) => (
        <SheetFeatureItem
          key={`feature-${feature.id}`}
          feature={feature}
          oauthAccounts={oauthAccounts}
          disabled={
            disabled || (accountSelectionDisabled && feature.id === OMP_OAUTH_ACCOUNT_FEATURE_ID)
          }
          openSelector={openSelector}
          handleOpenChange={handleOpenChange}
          onSetFeature={onSetFeature}
        />
      ))}
    </View>
  );

  return canSelectModel ? (
    <CompactModelSheet
      providers={modelSelectorProviders}
      selectedProvider={provider}
      selectedModel={selectedModelId ?? ""}
      thinkingLabel={displayThinking}
      fastModeEnabled={fastModeEnabled}
      onSelect={handleSheetModelSelect}
      profiles={agentProfiles}
      onApplyProfile={onApplyAgentProfile}
      onEditProfiles={onEditAgentProfiles}
      onCreateProfile={onCreateAgentProfile}
      onEditProfile={onEditAgentProfile}
      isLoading={isModelLoading}
      disabled={modelDisabled}
      onOpen={onModelSelectorOpen}
      onClose={onDropdownClose}
      onRetryProvider={onRetryModelProvider}
      isRetryingProvider={isRetryingModelProvider}
      glyphSize={glyphSize}
      canSwitchProvider={canSwitchProvider}
    >
      {sheetControls}
    </CompactModelSheet>
  ) : null;
}

function FeatureSelectComboboxOption({
  option,
  selected,
  active,
  onPress,
  featureId,
  featureIcon,
  iconColor,
}: {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  featureId: string;
  featureIcon?: string;
  iconColor: string;
}) {
  let IconComponent = getAgentFeatureIcon(featureIcon);
  if (featureId === "workflow_mode") {
    if (option.id === "plan") IconComponent = ListTodo;
    else if (option.id === "goal") IconComponent = Target;
    else if (option.id === "enhanced") IconComponent = Sparkles;
    else IconComponent = SlidersHorizontal;
  }
  const leadingSlot = useMemo(
    () => <IconComponent size={16} color={iconColor} />,
    [IconComponent, iconColor],
  );
  return (
    <ComboboxItem
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function DesktopFeatureItem({
  feature,
  oauthAccounts,
  disabled,
  openSelector,
  handleOpenChange,
  onSetFeature,
  onActionComplete,
}: {
  feature: AgentFeature;
  disabled: boolean;
  oauthAccounts?: readonly OmpWorkflowQuotaDisplayAccount[];
  openSelector: AgentControlSelector | null;
  handleOpenChange: (selector: AgentControlSelector) => (nextOpen: boolean) => void;
  onSetFeature?: (featureId: string, value: unknown) => void;
  onActionComplete?: () => void;
}) {
  const { theme } = useUnistyles();
  const featureSelector: AgentControlSelector = `feature-${feature.id}`;
  const featureAnchorRef = useRef<View>(null);
  const featureLabel = formatAgentFeatureLabel(feature);

  const handleFeatureOpenChange = useMemo(
    () => handleOpenChange(featureSelector),
    [handleOpenChange, featureSelector],
  );
  const handleSelectPress = useCallback(
    () => handleFeatureOpenChange(openSelector !== featureSelector),
    [featureSelector, handleFeatureOpenChange, openSelector],
  );

  const handleTogglePress = useCallback(() => {
    if (feature.type === "toggle") {
      onSetFeature?.(feature.id, !feature.value);
      onActionComplete?.();
    }
  }, [feature, onActionComplete, onSetFeature]);

  const handleSelectOption = useCallback(
    (optionId: string) => {
      onSetFeature?.(feature.id, optionId);
    },
    [feature.id, onSetFeature],
  );
  const comboboxOptions = useMemo<ComboboxOption[]>(
    () =>
      feature.type === "select"
        ? feature.options.map((option) => ({
            id: option.id,
            label: formatFeatureOptionLabel(feature.id, option, oauthAccounts),
          }))
        : [],
    [feature, oauthAccounts],
  );
  const renderSelectOption = useCallback(
    (args: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }): ReactElement => (
      <FeatureSelectComboboxOption
        option={args.option}
        selected={args.selected}
        active={args.active}
        onPress={args.onPress}
        featureId={feature.id}
        featureIcon={feature.icon}
        iconColor={
          feature.id === "workflow_mode" && args.selected && args.option.id === "plan"
            ? theme.colors.accent
            : theme.colors.foreground
        }
      />
    ),
    [feature.icon, feature.id, theme.colors.accent, theme.colors.foreground],
  );

  if (feature.type === "toggle") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    return (
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <AgentControlTrigger
            icon={FeatureIcon}
            iconColor={getFeatureIconColor(
              feature.id,
              feature.value,
              theme.colors.palette,
              theme.colors.foregroundMuted,
            )}
            surface="toolbar"
            label={feature.label}
            showToolbarLabel={false}
            disabled={disabled}
            onPress={handleTogglePress}
            accessibilityLabel={getFeatureTooltip(feature)}
            testID={`agent-feature-${feature.id}`}
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{getFeatureTooltip(feature)}</Text>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (feature.type === "select") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    const selectedOption = feature.options.find((o) => o.id === feature.value);
    const selectedOptionValueLabel = selectedOption
      ? formatFeatureOptionLabel(feature.id, selectedOption, oauthAccounts)
      : null;
    const selectedOptionLabel = selectedOptionValueLabel ?? featureLabel;
    const accountControlLabels =
      feature.id === OMP_OAUTH_ACCOUNT_FEATURE_ID
        ? resolveOmpAccountControlLabels({
            featureLabel,
            accountLabel: selectedOptionValueLabel,
          })
        : null;
    const toolbarValueLabel = accountControlLabels?.buttonLabel ?? selectedOptionLabel;
    const tooltipLabel =
      accountControlLabels?.tooltipLabel ?? `${featureLabel}: ${selectedOptionLabel}`;
    return (
      <>
        <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="ref">
            <AgentControlTrigger
              ref={featureAnchorRef}
              icon={FeatureIcon}
              iconColor={
                feature.id === "workflow_mode" && feature.value === "plan"
                  ? theme.colors.accent
                  : undefined
              }
              surface="toolbar"
              label={featureLabel}
              value={toolbarValueLabel}
              open={openSelector === featureSelector}
              disabled={disabled}
              onPress={handleSelectPress}
              accessibilityLabel={tooltipLabel}
              testID={`agent-feature-${feature.id}`}
            />
          </TooltipTrigger>
          <TooltipContent side="top" align="center" offset={8}>
            <Text style={styles.tooltipText}>{tooltipLabel}</Text>
          </TooltipContent>
        </Tooltip>
        <Combobox
          options={comboboxOptions}
          value={String(feature.value)}
          onSelect={handleSelectOption}
          open={openSelector === featureSelector}
          onOpenChange={handleFeatureOpenChange}
          anchorRef={featureAnchorRef}
          desktopPlacement="top-start"
          searchable={false}
          renderOption={renderSelectOption}
        />
      </>
    );
  }

  return null;
}

function SheetFeatureItem({
  feature,
  oauthAccounts,
  disabled,
  openSelector,
  handleOpenChange,
  onSetFeature,
}: {
  feature: AgentFeature;
  disabled: boolean;
  oauthAccounts?: readonly OmpWorkflowQuotaDisplayAccount[];
  openSelector: AgentControlSelector | null;
  handleOpenChange: (selector: AgentControlSelector) => (nextOpen: boolean) => void;
  onSetFeature?: (featureId: string, value: unknown) => void;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const featureLabel = formatAgentFeatureLabel(feature);
  const featureSelector: AgentControlSelector = `feature-${feature.id}`;
  const featureAnchorRef = useRef<View>(null);

  const handleFeatureOpenChange = useMemo(
    () => handleOpenChange(featureSelector),
    [handleOpenChange, featureSelector],
  );
  const handleSelectPress = useCallback(
    () => handleFeatureOpenChange(openSelector !== featureSelector),
    [featureSelector, handleFeatureOpenChange, openSelector],
  );
  const sheetHeader = useMemo<SheetHeader>(() => ({ title: featureLabel }), [featureLabel]);

  const handleSelectOption = useCallback(
    (optionId: string) => {
      onSetFeature?.(feature.id, feature.type === "toggle" ? optionId === "true" : optionId);
    },
    [feature.id, feature.type, onSetFeature],
  );
  const comboboxOptions = useMemo<ComboboxOption[]>(() => {
    if (feature.type === "select") {
      return feature.options.map((option) => ({
        id: option.id,
        label: formatFeatureOptionLabel(feature.id, option, oauthAccounts),
      }));
    }
    return [
      { id: "true", label: t("agentControls.features.on") },
      { id: "false", label: t("agentControls.features.off") },
    ];
  }, [feature, oauthAccounts, t]);
  const renderSelectOption = useCallback(
    (args: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }): ReactElement => (
      <FeatureSelectComboboxOption
        option={args.option}
        selected={args.selected}
        active={args.active}
        onPress={args.onPress}
        featureId={feature.id}
        featureIcon={feature.icon}
        iconColor={
          feature.id === "workflow_mode" && args.selected && args.option.id === "plan"
            ? theme.colors.accent
            : theme.colors.foreground
        }
      />
    ),
    [feature.icon, feature.id, theme.colors.accent, theme.colors.foreground],
  );

  if (feature.type === "toggle") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    return (
      <>
        <AgentControlTrigger
          ref={featureAnchorRef}
          icon={FeatureIcon}
          iconColor={getFeatureIconColor(
            feature.id,
            feature.value,
            theme.colors.palette,
            theme.colors.foregroundMuted,
          )}
          surface="sheet"
          label={featureLabel}
          value={feature.value ? t("agentControls.features.on") : t("agentControls.features.off")}
          open={openSelector === featureSelector}
          disabled={disabled}
          onPress={handleSelectPress}
          accessibilityLabel={getFeatureTooltip(feature)}
          testID={`agent-feature-${feature.id}`}
        />
        <Combobox
          options={comboboxOptions}
          value={String(feature.value)}
          onSelect={handleSelectOption}
          open={openSelector === featureSelector}
          onOpenChange={handleFeatureOpenChange}
          anchorRef={featureAnchorRef}
          presentation="push"
          searchable={false}
          header={sheetHeader}
        />
      </>
    );
  }

  if (feature.type === "select") {
    const FeatureIcon = getAgentFeatureIcon(feature.icon);
    const selectedOption = feature.options.find((o) => o.id === feature.value);
    const selectedOptionLabel = selectedOption
      ? formatFeatureOptionLabel(feature.id, selectedOption, oauthAccounts)
      : featureLabel;
    return (
      <>
        <AgentControlTrigger
          ref={featureAnchorRef}
          icon={FeatureIcon}
          iconColor={
            feature.id === "workflow_mode" && feature.value === "plan"
              ? theme.colors.accent
              : undefined
          }
          surface="sheet"
          label={featureLabel}
          value={selectedOptionLabel}
          open={openSelector === featureSelector}
          disabled={disabled}
          onPress={handleSelectPress}
          accessibilityLabel={`${featureLabel}: ${selectedOptionLabel}`}
          testID={`agent-feature-${feature.id}`}
        />
        <Combobox
          options={comboboxOptions}
          value={String(feature.value)}
          onSelect={handleSelectOption}
          open={openSelector === featureSelector}
          onOpenChange={handleFeatureOpenChange}
          anchorRef={featureAnchorRef}
          presentation="push"
          header={sheetHeader}
          searchable={false}
          renderOption={renderSelectOption}
        />
      </>
    );
  }

  return null;
}

// This component coordinates persisted and live agent-control state across all providers.
// eslint-disable-next-line complexity
export const AgentControls = memo(function AgentControls({
  agentId,
  serverId,
  onDropdownClose,
  isCompactLayout,
}: AgentControlsProps) {
  const { t, i18n } = useTranslation();
  const { updatePreferences } = useFormPreferences();
  const agent = useSessionStore(
    useShallow((state) => selectAgentControlsSlice(state, serverId, agentId)),
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const toast = useToast();
  const modeControl = useLiveAgentModeControl(serverId, agentId);
  const commandCenterModes = toCommandCenterModes(modeControl);
  const modeProviderDefinitions = getModeProviderDefinitions(modeControl);

  const {
    entries: snapshotEntries,
    isLoading: snapshotIsLoading,
    isRefreshing: snapshotIsRefreshing,
    refresh: refreshSnapshot,
    refetchIfStale: refetchSnapshotIfStale,
  } = useProvidersSnapshot(serverId, { cwd: agent?.cwd });

  const snapshotSelectedEntry = useMemo(
    () => resolveSnapshotSelectedEntry(snapshotEntries, agent?.provider),
    [snapshotEntries, agent?.provider],
  );

  const models = filterSelectableModels(snapshotSelectedEntry?.models ?? null);
  const selectedProviderIsLoading = snapshotSelectedEntry?.status === "loading";

  const agentProviderDefinitions = useMemo(
    () => buildAgentProviderDefinitions(agent?.provider, snapshotEntries),
    [agent?.provider, snapshotEntries],
  );

  const agentProviderModels = useMemo(
    () => buildAgentProviderModels(agent?.provider, models),
    [agent?.provider, models],
  );
  const agentModelSelectorProviders = useMemo(() => {
    if (snapshotSelectedEntry) {
      return buildSelectableProviderSelectorProviders([snapshotSelectedEntry]);
    }
    return buildProviderSelectorProviders({
      providerDefinitions: agentProviderDefinitions,
      modelsByProvider: agentProviderModels,
    });
  }, [agentProviderDefinitions, agentProviderModels, snapshotSelectedEntry]);

  const modelSelection = resolveAgentModelSelection({
    models,
    runtimeModelId: agent?.runtimeModelId,
    configuredModelId: agent?.model,
    explicitThinkingOptionId: agent?.thinkingOptionId,
  });

  const modelOptions = useMemo<AgentControlOption[]>(() => {
    return (models ?? []).map((model) => ({ id: model.id, label: model.label }));
  }, [models]);

  const thinkingOptions = useMemo<AgentControlOption[]>(() => {
    return (modelSelection.thinkingOptions ?? []).map((option) => ({
      id: option.id,
      label: formatThinkingOptionLabel(option),
    }));
  }, [modelSelection.thinkingOptions]);

  const agentProvider = agent?.provider;
  const activeModelId = modelSelection.activeModelId;
  const { accounts: workflowQuotaAccounts } = useOmpAccountQuota(
    serverId,
    agentProvider,
    activeModelId,
  );
  const workflowMode = agent?.features?.find(
    (feature) => feature.id === WORKFLOW_MODE_FEATURE_ID,
  )?.value;
  const workflowLocale = (i18n.resolvedLanguage ?? i18n.language) as SupportedLocale;
  useEffect(() => {
    if (!client || agentProvider !== "omp" || workflowMode !== ENHANCED_WORKFLOW_MODE) {
      return;
    }
    void client
      .setAgentFeature(agentId, WORKFLOW_LOCALE_FEATURE_ID, workflowLocale)
      .catch((error) => {
        console.warn("[AgentControls] sync enhanced workflow locale failed", error);
      });
  }, [agentId, agentProvider, client, workflowLocale, workflowMode]);

  const handleSelectModel = useCallback(
    async (modelId: string) => {
      if (!client || !agentProvider) {
        return;
      }
      try {
        await client.setAgentModel(agentId, modelId);
        await updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agentProvider,
            updates: { model: modelId },
          }),
        );
      } catch (error) {
        console.warn("[AgentControls] setAgentModel or persist preference failed", error);
        toast.error(toErrorMessage(error));
      }
    },
    [agentId, agentProvider, client, toast, updatePreferences],
  );
  const handleSelectCommandCenterModel = useCallback(
    (_provider: AgentProvider, modelId: string) => handleSelectModel(modelId),
    [handleSelectModel],
  );

  // A running agent is one provider's process, so only that provider's profiles
  // can apply to it.
  const profileProviders = useMemo(() => (agentProvider ? [agentProvider] : []), [agentProvider]);
  const profileModeIds = useMemo(
    () => resolveSnapshotModeIds(snapshotSelectedEntry),
    [snapshotSelectedEntry],
  );
  const profileTarget = useMemo<AgentProfileApplyTarget>(
    () => ({ kind: "agent", agentId, availableModeIds: profileModeIds }),
    [agentId, profileModeIds],
  );
  const agentProfiles = useAgentProfilePicker({
    serverId,
    availableProviders: profileProviders,
    target: profileTarget,
  });
  const handleEditAgentProfiles = useEditAgentProfilesNavigation(serverId, agentProfiles !== null);
  const profileEditor = useAgentProfileEditor(serverId);
  const profileActions = resolveAgentProfileEditorActions(agentProfiles !== null, profileEditor);

  const handleSelectThinkingOption = useCallback(
    (thinkingOptionId: string) => {
      if (!client || !agentProvider) {
        return;
      }
      if (activeModelId) {
        void updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agentProvider,
            updates: {
              model: activeModelId,
              thinkingByModel: {
                [activeModelId]: thinkingOptionId,
              },
            },
          }),
        ).catch((error) => {
          console.warn("[AgentControls] persist thinking preference failed", error);
        });
      }
      void client
        .setAgentThinkingOption(agentId, thinkingOptionId)
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.warn("[AgentControls] setAgentThinkingOption failed", error);
          toast.error(toErrorMessage(error));
        });
    },
    [activeModelId, agentId, agentProvider, client, toast, updatePreferences],
  );

  const handleSetFeature = useCallback(
    async (featureId: string, value: unknown) => {
      if (!client || !agentProvider) {
        return;
      }
      if (featureId === OMP_OAUTH_ACCOUNT_FEATURE_ID && agent?.status === "running") {
        toast.error(t("agentControls.quota.switchAfterTurn"));
        return;
      }
      try {
        if (
          agentProvider === "omp" &&
          featureId === WORKFLOW_MODE_FEATURE_ID &&
          value === ENHANCED_WORKFLOW_MODE
        ) {
          await client.setAgentFeature(agentId, WORKFLOW_LOCALE_FEATURE_ID, workflowLocale);
        }
        await client.setAgentFeature(agentId, featureId, value);
        if (!shouldPersistAgentFeatureValue(featureId)) {
          return;
        }
        await updatePreferences((current) =>
          mergeProviderPreferences({
            preferences: current,
            provider: agentProvider,
            updates: {
              featureValues: {
                [featureId]: value,
              },
            },
          }),
        );
      } catch (error) {
        console.warn("[AgentControls] setAgentFeature failed", error);
        toast.error(toErrorMessage(error));
      }
    },
    [agent?.status, agentId, agentProvider, client, t, toast, updatePreferences, workflowLocale],
  );

  const commandCenterControls = useMemo<AgentControlCommandCenterSource>(
    () => ({
      serverId,
      ownerKey: agentId,
      provider: agentProvider,
      providerDefinitions: modeProviderDefinitions,
      isRunning: agent?.status === "running",
      models: {
        providers: agentModelSelectorProviders,
        selectedProvider: agentProvider,
        selectedModelId: activeModelId,
        select: handleSelectCommandCenterModel,
      },
      thinking: {
        options: modelSelection.thinkingOptions,
        selectedId: modelSelection.selectedThinkingId,
        select: handleSelectThinkingOption,
      },
      modes: commandCenterModes,
      features: {
        list: agent?.features,
        set: handleSetFeature,
      },
    }),
    [
      activeModelId,
      agent?.features,
      agentId,
      agent?.status,
      agentModelSelectorProviders,
      agentProvider,
      commandCenterModes,
      handleSelectCommandCenterModel,
      handleSelectThinkingOption,
      handleSetFeature,
      modeProviderDefinitions,
      modelSelection.selectedThinkingId,
      modelSelection.thinkingOptions,
      serverId,
    ],
  );

  const commandCenterRegistration = (
    <AgentControlCommandCenterRegistration
      sourceId={`agent:${serverId}:${agentId}`}
      enabled={Boolean(client)}
      controls={commandCenterControls}
    />
  );

  const handleModelSelectorOpen = useCallback(() => {
    refetchSnapshotIfStale(agentProvider);
  }, [agentProvider, refetchSnapshotIfStale]);

  const handleRetryModelProvider = useCallback(
    (provider: AgentProvider) => {
      void refreshSnapshot([provider]);
    },
    [refreshSnapshot],
  );

  if (!agent) {
    return null;
  }

  return (
    <>
      {commandCenterRegistration}
      {profileEditor.element}
      <ControlledAgentControls
        provider={agent.provider}
        modelSelectorProviders={agentModelSelectorProviders}
        modelOptions={modelOptions}
        selectedModelId={modelSelection.activeModelId ?? undefined}
        onSelectModel={handleSelectModel}
        agentProfiles={agentProfiles}
        onApplyAgentProfile={agentProfiles?.applyProfile}
        onEditAgentProfiles={handleEditAgentProfiles}
        onCreateAgentProfile={profileActions.create}
        onEditAgentProfile={profileActions.edit}
        thinkingOptions={thinkingOptions.length > 1 ? thinkingOptions : undefined}
        selectedThinkingOptionId={modelSelection.selectedThinkingId ?? undefined}
        onSelectThinkingOption={handleSelectThinkingOption}
        features={agent.features}
        onSetFeature={handleSetFeature}
        isModelLoading={snapshotIsLoading || selectedProviderIsLoading}
        onModelSelectorOpen={handleModelSelectorOpen}
        onRetryModelProvider={handleRetryModelProvider}
        isRetryingModelProvider={snapshotIsRefreshing}
        onDropdownClose={onDropdownClose}
        disabled={!client}
        accountSelectionDisabled={agent.status === "running"}
        modeControl={modeControl}
        modelSelectorServerId={serverId}
        workflowQuotaAccounts={workflowQuotaAccounts}
        isCompactLayout={isCompactLayout}
      />
    </>
  );
});

export function DraftAgentControls({
  providerDefinitions,
  selectedProvider,
  modeOptions,
  selectedMode,
  onSelectMode,
  models,
  selectedModel,
  onSelectModel,
  isModelLoading: _isModelLoading,
  modelSelectorProviders,
  isAllModelsLoading,
  onSelectProviderAndModel,
  thinkingOptions,
  selectedThinkingOptionId,
  onSelectThinkingOption,
  onApplyAgentProfile,
  features,
  onSetFeature,
  onDropdownClose,
  onModelSelectorOpen,
  onRetryModelProvider,
  isRetryingModelProvider = false,
  disabled = false,
  modelSelectorServerId = null,
  isCompactLayout,
}: DraftAgentControlsProps) {
  const activeControlSourceId = useId();
  const { isActiveComposer } = useComposerKeyboardScope();
  const mappedThinkingOptions = useMemo<AgentControlOption[]>(
    () => toThinkingControlOptions(thinkingOptions),
    [thinkingOptions],
  );

  const effectiveSelectedThinkingOption =
    selectedThinkingOptionId || mappedThinkingOptions[0]?.id || undefined;

  const modelOptions = useMemo<AgentControlOption[]>(
    () =>
      models.map((model) => ({
        id: model.id,
        label: model.label,
      })),
    [models],
  );
  const { accounts: workflowQuotaAccounts } = useOmpAccountQuota(
    modelSelectorServerId,
    selectedProvider,
    selectedModel,
  );

  // The draft form is the one surface that can switch provider, so every profile
  // the host can actually run is offered here.
  const profileProviders = useMemo(
    () => modelSelectorProviders.map((entry) => entry.id),
    [modelSelectorProviders],
  );
  const profileTarget = useMemo<AgentProfileApplyTarget>(
    () => ({
      kind: "draft",
      controls: {
        applyProfile: onApplyAgentProfile,
      },
    }),
    [onApplyAgentProfile],
  );
  const agentProfiles = useAgentProfilePicker({
    serverId: modelSelectorServerId,
    availableProviders: profileProviders,
    target: profileTarget,
  });
  const handleEditAgentProfiles = useEditAgentProfilesNavigation(
    modelSelectorServerId,
    agentProfiles !== null,
  );
  const profileEditor = useAgentProfileEditor(modelSelectorServerId);
  const profileActions = resolveAgentProfileEditorActions(agentProfiles !== null, profileEditor);

  const modeControl = useMemo<AgentModeControlValue | null>(
    () =>
      selectedProvider && modeOptions.length > 0
        ? {
            provider: selectedProvider,
            providerDefinitions,
            modeOptions,
            selectedModeId: selectedMode,
            onSelectMode,
            disabled,
          }
        : null,
    [selectedProvider, providerDefinitions, modeOptions, selectedMode, onSelectMode, disabled],
  );

  const activeControlSource = useMemo<AgentControlCommandCenterSource>(
    () => ({
      serverId: modelSelectorServerId ?? "",
      ownerKey: activeControlSourceId,
      provider: selectedProvider,
      providerDefinitions,
      models: {
        providers: modelSelectorProviders,
        selectedProvider,
        selectedModelId: selectedModel,
        select: onSelectProviderAndModel,
      },
      thinking: {
        options: thinkingOptions,
        selectedId: selectedThinkingOptionId,
        select: onSelectThinkingOption,
      },
      modes: {
        options: modeOptions,
        selectedId: selectedMode,
        select: onSelectMode,
      },
      features: {
        list: features,
        set: onSetFeature,
      },
    }),
    [
      activeControlSourceId,
      features,
      modeOptions,
      modelSelectorProviders,
      modelSelectorServerId,
      onSelectMode,
      onSelectProviderAndModel,
      onSelectThinkingOption,
      onSetFeature,
      providerDefinitions,
      selectedMode,
      selectedModel,
      selectedProvider,
      selectedThinkingOptionId,
      thinkingOptions,
    ],
  );
  useActiveAgentControlRegistration({
    sourceId: `draft-controls:${activeControlSourceId}`,
    enabled: isActiveComposer && !disabled,
    controls: activeControlSource,
  });
  return (
    <>
      {profileEditor.element}
      <ControlledAgentControls
        provider={selectedProvider ?? ""}
        modelSelectorProviders={modelSelectorProviders}
        modelOptions={modelOptions}
        selectedModelId={selectedModel}
        onSelectModel={onSelectModel}
        onSelectProviderAndModel={onSelectProviderAndModel}
        isModelLoading={isAllModelsLoading}
        agentProfiles={agentProfiles}
        onApplyAgentProfile={agentProfiles?.applyProfile}
        onEditAgentProfiles={handleEditAgentProfiles}
        onCreateAgentProfile={profileActions.create}
        onEditAgentProfile={profileActions.edit}
        thinkingOptions={mappedThinkingOptions.length > 0 ? mappedThinkingOptions : undefined}
        selectedThinkingOptionId={effectiveSelectedThinkingOption}
        onSelectThinkingOption={onSelectThinkingOption}
        features={features}
        onSetFeature={onSetFeature}
        onDropdownClose={onDropdownClose}
        onModelSelectorOpen={onModelSelectorOpen}
        onRetryModelProvider={onRetryModelProvider}
        isRetryingModelProvider={isRetryingModelProvider}
        disabled={disabled}
        modeControl={modeControl}
        modelSelectorServerId={modelSelectorServerId}
        workflowQuotaAccounts={workflowQuotaAccounts}
        isCompactLayout={isCompactLayout}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    overflow: "hidden",
  },
  modeBadge: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
  },
  modelControl: {
    minWidth: 0,
    flexShrink: 1,
  },
  modelAccessoryText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  toolbarCaret: {
    width: 14,
    height: 14,
    flexShrink: 0,
  },
  modeIconBadge: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 0,
    flexShrink: 0,
    backgroundColor: "transparent",
    borderRadius: theme.borderRadius.full,
  },
  modeBadgeHovered: {
    backgroundColor: theme.colors.surface2,
  },
  modeBadgePressed: {
    backgroundColor: theme.colors.surface0,
  },
  disabledBadge: {
    opacity: 0.5,
  },
  modeBadgeText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
  combinedSheetControls: {
    gap: theme.spacing[1],
  },
}));
