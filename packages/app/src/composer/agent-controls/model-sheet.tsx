import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Bot } from "lucide-react-native";
import type { AgentProvider } from "@omp-desktop/protocol/agent-types";
import { getAgentFeatureOptionIcon } from "@/agent-controls/icons";
import { formatAgentFeatureOptionLabel } from "@/agent-controls/labels";
import { FAST_MODE_FEATURE_ID, type FastModeTier } from "@/agent-controls/policy";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { ModelBrowser, useModelBrowser } from "@/components/model-browser";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import {
  groupOmpModelsByProviderNamespace,
  resolveModelBrowserProviderId,
  resolveModelBrowserScrolling,
  resolveModelSheetOpening,
} from "@/composer/agent-controls/model-sheet-flow";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";

const SNAP_POINTS = ["80%", "90%"];
const MODEL_LIST_TOP_INSET = 4;
const MODEL_ROW_STRIDE = 44;
const MODEL_VIEWPORT_VISIBLE_ROWS = 4.5;
const FIXED_MODEL_VIEWPORT_HEIGHT =
  MODEL_LIST_TOP_INSET + MODEL_ROW_STRIDE * MODEL_VIEWPORT_VISIBLE_ROWS;

interface CompactModelSheetProps {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  thinkingLabel: string | null;
  fastModeTier: FastModeTier | null;
  onSelect: (provider: string, modelId: string) => void | Promise<void>;
  isLoading: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  disabled?: boolean;
  canSwitchProvider: boolean;
  children: ReactNode;
}

function shortModelLabel(label: string): string {
  const separatorIndex = label.lastIndexOf("/");
  return separatorIndex === -1 ? label : label.slice(separatorIndex + 1);
}

function resolveModelProviderNavigation(input: {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  canSwitchProvider: boolean;
}) {
  let baseProviders = input.providers;
  if (!input.canSwitchProvider) {
    const resolvedProviderId = resolveModelBrowserProviderId(
      input.selectedProvider,
      input.selectedModel,
      input.providers,
    );
    const fixedProvider =
      input.providers.find((entry) => entry.id === resolvedProviderId) ??
      input.providers.find((entry) => entry.id === input.selectedProvider) ??
      input.providers[0] ??
      null;
    baseProviders = fixedProvider ? [fixedProvider] : [];
  }
  const availableProviders = groupOmpModelsByProviderNamespace(baseProviders);
  const canBrowseProviders = input.canSwitchProvider || availableProviders.length > 1;
  return {
    availableProviders,
    canBrowseProviders,
    browserSelectedProvider: resolveModelBrowserProviderId(
      input.selectedProvider,
      input.selectedModel,
      availableProviders,
    ),
  };
}

function resolveGroupedModelLabel(
  providers: ProviderSelectorProvider[],
  selectedModel: string,
): string | null {
  for (const provider of providers) {
    if (provider.modelSelection.kind !== "models") continue;
    const row = provider.modelSelection.rows.find(
      (candidate) =>
        candidate.modelId === selectedModel || candidate.modelId.endsWith(`/${selectedModel}`),
    );
    if (row) return row.modelLabel;
  }
  return null;
}

export function CompactModelSheet({
  providers,
  selectedProvider,
  selectedModel,
  thinkingLabel,
  fastModeTier,
  onSelect,
  isLoading,
  onOpen,
  onClose,
  onRetryProvider,
  isRetryingProvider = false,
  disabled = false,
  canSwitchProvider,
  children,
}: CompactModelSheetProps) {
  const { t } = useTranslation();
  const usesBottomSheet = useIsCompactFormFactor();
  const modelBrowserScrolling = resolveModelBrowserScrolling(usesBottomSheet);
  const [isOpen, setIsOpen] = useState(false);
  const [isModelBrowserOpen, setIsModelBrowserOpen] = useState(false);
  const { availableProviders, canBrowseProviders, browserSelectedProvider } =
    resolveModelProviderNavigation({
      providers,
      selectedProvider,
      selectedModel,
      canSwitchProvider,
    });
  const rootBrowser = useModelBrowser({
    providers: availableProviders,
    selectedProvider: browserSelectedProvider,
    selectedModel,
    isLoading,
    autoFocusSearch: isWeb && !usesBottomSheet && !canBrowseProviders,
    browseProviders: usesBottomSheet,
  });
  const modelBrowser = useModelBrowser({
    providers: availableProviders,
    selectedProvider: browserSelectedProvider,
    selectedModel,
    isLoading,
    autoFocusSearch: isWeb && !usesBottomSheet,
    browseProviders: false,
  });
  const selectedProviderLabel =
    availableProviders.find((provider) => provider.id === browserSelectedProvider)?.label ??
    selectedProvider;
  const rootHeader = useMemo(
    () => ({
      ...rootBrowser.header,
      title: t("modelSelector.selectModel"),
      search:
        rootBrowser.header.search && !canBrowseProviders
          ? {
              ...rootBrowser.header.search,
              placeholder: t("modelSelector.searchPlaceholder"),
            }
          : rootBrowser.header.search,
    }),
    [canBrowseProviders, rootBrowser.header, t],
  );
  const displayModelLabel =
    resolveGroupedModelLabel(availableProviders, selectedModel) ?? rootBrowser.selectedModelLabel;
  const fastModeLabel = fastModeTier
    ? formatAgentFeatureOptionLabel(FAST_MODE_FEATURE_ID, { id: fastModeTier })
    : null;
  const fastModeActive = fastModeTier === "on" || fastModeTier === "ultrafast";
  const FastModeIcon = getAgentFeatureOptionIcon(FAST_MODE_FEATURE_ID, fastModeTier, "zap");
  const selectedModelAccessibilityLabel = t("modelSelector.selectedModel", {
    model: [`${selectedProviderLabel} · ${displayModelLabel}`, thinkingLabel, fastModeLabel]
      .filter(Boolean)
      .join(" · "),
  });

  const open = useCallback(() => {
    Keyboard.dismiss();
    if (usesBottomSheet) {
      rootBrowser.showAll();
    } else {
      rootBrowser.prepareToOpen();
    }
    setIsOpen(true);
    onOpen?.();
  }, [onOpen, rootBrowser, usesBottomSheet]);

  const close = useCallback(() => {
    setIsModelBrowserOpen(false);
    setIsOpen(false);
    rootBrowser.reset();
    modelBrowser.reset();
    onClose?.();
  }, [modelBrowser, onClose, rootBrowser]);

  const handleSearchSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      Keyboard.dismiss();
      rootBrowser.showAll();
    },
    [onSelect, rootBrowser],
  );

  const openModelBrowser = useCallback(() => {
    Keyboard.dismiss();
    const destination = resolveModelSheetOpening({
      canSwitchProvider: canBrowseProviders,
      providers: availableProviders,
      selectedProvider: browserSelectedProvider,
    });
    if (destination.kind === "all") {
      modelBrowser.showAll();
    } else {
      modelBrowser.drillDown(destination.providerId, destination.providerLabel);
    }
    setIsModelBrowserOpen(true);
  }, [availableProviders, browserSelectedProvider, canBrowseProviders, modelBrowser]);

  const closeModelBrowser = useCallback(() => {
    setIsModelBrowserOpen(false);
    modelBrowser.reset();
  }, [modelBrowser]);

  const handleBrowserSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      closeModelBrowser();
    },
    [closeModelBrowser, onSelect],
  );

  const handleDesktopSelect = useCallback(
    (provider: string, modelId: string) => {
      onSelect(provider, modelId);
      close();
    },
    [close, onSelect],
  );

  const toggle = useCallback(() => {
    if (isOpen) {
      close();
      return;
    }
    open();
  }, [close, isOpen, open]);

  const triggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType) => [
      styles.trigger,
      hovered && styles.triggerHovered,
      (pressed || isOpen) && styles.triggerPressed,
      disabled && styles.triggerDisabled,
    ],
    [disabled, isOpen],
  );
  const mobileRootContent = useMemo(
    () => (
      <View style={styles.mobileRootContent} testID="agent-controls-settings-list">
        <View style={styles.controlsContent}>
          <AgentControlTrigger
            icon={Bot}
            surface="sheet"
            label={t("modelSelector.model")}
            value={displayModelLabel}
            disabled={disabled}
            onPress={openModelBrowser}
            accessibilityLabel={selectedModelAccessibilityLabel}
            testID="agent-controls-model"
          />
          {children}
        </View>
      </View>
    ),
    [children, disabled, displayModelLabel, openModelBrowser, selectedModelAccessibilityLabel, t],
  );

  return (
    <>
      <ComboboxTrigger
        collapsable={false}
        disabled={disabled}
        onPress={toggle}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={selectedModelAccessibilityLabel}
        testID="combined-model-selector"
        chevron={null}
      >
        <View style={styles.triggerLabels}>
          <Text style={styles.triggerText} numberOfLines={1}>
            {shortModelLabel(displayModelLabel)}
          </Text>
          {thinkingLabel || fastModeActive ? (
            <View style={styles.triggerSummary}>
              {thinkingLabel ? (
                <Text style={styles.triggerThinking} numberOfLines={1}>
                  {thinkingLabel}
                </Text>
              ) : null}
              {fastModeActive ? (
                <FastModeIcon
                  size={12}
                  color={styles.fastModeIcon.color}
                  accessibilityLabel={fastModeLabel ?? undefined}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      </ComboboxTrigger>

      <AdaptiveModalSheet
        header={rootHeader}
        visible={isOpen}
        onClose={close}
        snapPoints={SNAP_POINTS}
        scrollable={false}
        sizeContentToCurrentSnapPoint={usesBottomSheet}
        contentStyle={styles.sheetBody}
        testID="agent-controls-model-sheet"
      >
        <View
          style={[
            styles.modelViewport,
            usesBottomSheet ? styles.flexibleModelViewport : styles.fixedModelViewport,
          ]}
          testID="agent-controls-model-viewport"
        >
          <ModelBrowser
            state={rootBrowser}
            onSelect={usesBottomSheet ? handleSearchSelect : handleDesktopSelect}
            onRetryProvider={onRetryProvider}
            isRetryingProvider={isRetryingProvider}
            scrolling={modelBrowserScrolling}
            searchAllOnFocus={usesBottomSheet}
            rootBrowseContent={usesBottomSheet ? mobileRootContent : undefined}
          />
        </View>
        {!usesBottomSheet ? (
          <>
            <View style={styles.modelViewportDivider} />
            <ScrollView
              style={styles.controlsScroll}
              contentContainerStyle={styles.controlsContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              testID="agent-controls-settings-list"
            >
              {children}
            </ScrollView>
          </>
        ) : null}
      </AdaptiveModalSheet>

      {usesBottomSheet ? (
        <AdaptiveModalSheet
          header={modelBrowser.header}
          visible={isModelBrowserOpen}
          onClose={closeModelBrowser}
          snapPoints={SNAP_POINTS}
          scrollable={false}
          sizeContentToCurrentSnapPoint
          presentation="push"
          contentStyle={styles.sheetBody}
          testID="agent-controls-model-browser-sheet"
        >
          <View
            style={[styles.modelViewport, styles.flexibleModelViewport]}
            testID="agent-controls-model-browser-viewport"
          >
            <ModelBrowser
              state={modelBrowser}
              onSelect={handleBrowserSelect}
              onRetryProvider={onRetryProvider}
              isRetryingProvider={isRetryingProvider}
              scrolling={modelBrowserScrolling}
              searchAllOnFocus
            />
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: "transparent",
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface0,
  },
  triggerDisabled: {
    opacity: 0.5,
  },
  triggerText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  triggerLabels: {
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  triggerThinking: {
    flexShrink: 0,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  triggerSummary: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  fastModeIcon: {
    color: theme.colors.palette.yellow[400],
  },
  sheetBody: {
    paddingHorizontal: 0,
    paddingTop: 0,
    paddingBottom: 0,
    gap: 0,
  },
  modelViewport: {
    overflow: "hidden",
    backgroundColor: theme.colors.surfaceSidebar,
  },
  flexibleModelViewport: {
    flex: 1,
    minHeight: 0,
  },
  fixedModelViewport: {
    height: FIXED_MODEL_VIEWPORT_HEIGHT,
    minHeight: FIXED_MODEL_VIEWPORT_HEIGHT,
  },
  modelViewportDivider: {
    height: 1,
    flexShrink: 0,
    backgroundColor: theme.colors.border,
  },
  controlsScroll: {
    flex: 1,
    minHeight: 0,
  },
  mobileRootContent: {
    backgroundColor: theme.colors.surfaceSidebar,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  controlsContent: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
}));
