import { useCallback, useMemo, useReducer, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FlatList,
  Platform,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { BottomSheetFlatList, BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AlertTriangle, Check, ChevronRight, Search } from "lucide-react-native";
import type { AgentProvider } from "@omp-desktop/protocol/agent-types";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getProviderIcon } from "@/components/provider-icons";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import {
  buildProviderQualifiedDescription,
  buildSelectedTriggerLabel,
  filterAndRankModelRows,
  getAllProviderModelRows,
  getProviderModelRows,
  resolveSelectedModelLabel,
  type ProviderSelectionModelRow,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import {
  resolveInitialModelBrowserView,
  resolveModelBrowserAllView,
  type ModelBrowserView,
} from "@/components/model-browser-view";
import { isModelBrowserRowSelected } from "@/composer/agent-controls/model-sheet-flow";
import {
  IndependentScrollGestureContext,
  ModelBrowserPressable,
  ModelUsageHistory,
  type ModelUsageHistoryProps,
} from "@/components/model-usage-history";

const DESKTOP_PROVIDER_VIEW_MIN_HEIGHT = 220;
const DESKTOP_PROVIDER_VIEW_MAX_HEIGHT = 560;
const DESKTOP_PROVIDER_VIEW_BASE_HEIGHT = 188;
const DESKTOP_MODEL_ROW_HEIGHT = 34;

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedCheck = withUnistyles(Check);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedSearch = withUnistyles(Search);
const accentMapping = (theme: Theme) => ({ color: theme.colors.accent });

const foregroundMutedMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface ModelBrowserInput {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  isLoading: boolean;
  autoFocusSearch?: boolean;
  /** Keep provider navigation outside this browser and open the selected provider directly. */
  browseProviders?: boolean;
}

export interface ModelBrowserState {
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  view: ModelBrowserView;
  searchQuery: string;
  isSearchFocused: boolean;
  header: SheetHeader;
  selectedModelLabel: string;
  triggerLabel: string;
  desktopFixedHeight: number | undefined;
  isProviderView: boolean;
  prepareToOpen: () => void;
  showAll: () => void;
  reset: () => void;
  drillDown: (providerId: string, providerLabel: string) => void;
}

interface ModelBrowserProps {
  state: ModelBrowserState;
  onSelect: (provider: string, modelId: string) => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider?: boolean;
  scrolling?: "sheet" | "independent";
  /** Empty focused search shows all model rows instead of the browse root. */
  searchAllOnFocus?: boolean;
  /** Replaces provider rows only while the all-provider search is empty. */
  rootBrowseContent?: React.ReactNode;
  history?: ModelUsageHistoryProps;
}

interface ModelBrowserContentProps extends Omit<ModelBrowserProps, "state" | "scrolling"> {
  view: ModelBrowserView;
  providers: ProviderSelectorProvider[];
  selectedProvider: string;
  selectedModel: string;
  searchQuery: string;
  isSearchFocused: boolean;
  onDrillDown: (providerId: string, providerLabel: string) => void;
  scrolling: "sheet" | "independent";
  searchAllOnFocus: boolean;
  rootBrowseContent?: React.ReactNode;
}

type ProviderGlyphTone = "muted" | "foreground";

export function ModelProviderGlyph({
  provider,
  size,
  tone = "muted",
}: {
  provider: string;
  size: number;
  tone?: ProviderGlyphTone;
}) {
  const Icon = getProviderIcon(provider);
  const color =
    tone === "foreground" ? styles.providerIconForeground.color : styles.providerIconMuted.color;
  return <Icon size={size} color={color} />;
}

function countModelsInView(view: ModelBrowserView, providers: ProviderSelectorProvider[]): number {
  if (view.kind === "all") {
    return getAllProviderModelRows(providers).length;
  }
  const provider = providers.find((entry) => entry.id === view.providerId);
  return provider?.modelSelection.kind === "models" ? getProviderModelRows(provider).length : 0;
}

function resolveDesktopFixedHeight(
  view: ModelBrowserView,
  providers: ProviderSelectorProvider[],
): number {
  const modelCount = countModelsInView(view, providers);
  return Math.min(
    Math.max(
      DESKTOP_PROVIDER_VIEW_MIN_HEIGHT,
      DESKTOP_PROVIDER_VIEW_BASE_HEIGHT + modelCount * DESKTOP_MODEL_ROW_HEIGHT,
    ),
    DESKTOP_PROVIDER_VIEW_MAX_HEIGHT,
  );
}

export function useModelBrowser({
  providers,
  selectedProvider,
  selectedModel,
  isLoading,
  autoFocusSearch = isWeb,
  browseProviders = true,
}: ModelBrowserInput): ModelBrowserState {
  const { t } = useTranslation();
  const [view, setView] = useState<ModelBrowserView>({ kind: "all" });
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [searchResetKey, bumpSearchResetKey] = useReducer((key: number) => key + 1, 0);

  const initialView = useMemo(() => {
    if (!browseProviders) {
      const provider = providers.find((entry) => entry.id === selectedProvider);
      if (provider) {
        return {
          kind: "provider" as const,
          providerId: provider.id,
          providerLabel: provider.label,
        };
      }
    }
    return resolveInitialModelBrowserView({
      providers,
      selectedProvider,
      selectedModel,
    });
  }, [browseProviders, providers, selectedModel, selectedProvider]);

  const prepareToOpen = useCallback(() => {
    setView(initialView);
  }, [initialView]);

  const reset = useCallback(() => {
    setSearchQuery("");
    setIsSearchFocused(false);
    bumpSearchResetKey();
  }, []);

  const showAll = useCallback(() => {
    setView({ kind: "all" });
    reset();
  }, [reset]);

  const drillDown = useCallback(
    (providerId: string, providerLabel: string) => {
      setView({ kind: "provider", providerId, providerLabel });
      reset();
    },
    [reset],
  );

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

  const singleProviderView = providers.length === 1;
  const header = useMemo<SheetHeader>(() => {
    if (view.kind === "all") {
      return {
        title: t("modelSelector.title"),
        search: {
          onChange: handleSearchQueryChange,
          onFocus: () => setIsSearchFocused(true),
          onBlur: () => setIsSearchFocused(false),
          resetKey: `all:${searchResetKey}`,
          placeholder: t("modelSelector.searchAllPlaceholder"),
          autoFocus: autoFocusSearch,
          testID: "model-search-all-input",
        },
      };
    }
    return {
      title:
        providers.find((provider) => provider.id === view.providerId)?.label ?? view.providerLabel,
      leading: (
        <ModelProviderGlyph provider={view.providerId} size={ICON_SIZE.md} tone="foreground" />
      ),
      back: browseProviders && !singleProviderView ? { onPress: showAll } : undefined,
      search: {
        onChange: handleSearchQueryChange,
        onFocus: () => setIsSearchFocused(true),
        onBlur: () => setIsSearchFocused(false),
        resetKey: `${view.providerId}:${searchResetKey}`,
        placeholder: t("modelSelector.searchPlaceholder"),
        autoFocus: autoFocusSearch,
        testID: "model-search-input",
      },
    };
  }, [
    autoFocusSearch,
    browseProviders,
    handleSearchQueryChange,
    providers,
    searchResetKey,
    singleProviderView,
    showAll,
    t,
    view,
  ]);

  const selectedModelLabel = useMemo(
    () =>
      resolveSelectedModelLabel({
        providers,
        selectedProvider,
        selectedModel,
        isLoading,
      }),
    [isLoading, providers, selectedModel, selectedProvider],
  );

  const triggerLabel = useMemo(() => {
    const isPlaceholder =
      selectedModelLabel === t("modelSelector.loading") ||
      selectedModelLabel === t("modelSelector.selectModel");
    return isPlaceholder ? selectedModelLabel : buildSelectedTriggerLabel(selectedModelLabel);
  }, [selectedModelLabel, t]);

  const desktopFixedHeight = useMemo(
    () => resolveDesktopFixedHeight(view, providers),
    [providers, view],
  );

  return {
    providers,
    selectedProvider,
    selectedModel,
    view,
    searchQuery,
    isSearchFocused,
    header,
    selectedModelLabel,
    triggerLabel,
    desktopFixedHeight,
    isProviderView: view.kind === "provider",
    prepareToOpen,
    showAll,
    reset,
    drillDown,
  };
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function ModelBrowserRow({
  label,
  leadingSlot,
  trailingSlot,
  onPress,
  testID,
}: {
  label: string;
  leadingSlot: React.ReactNode;
  trailingSlot?: React.ReactNode;
  onPress: () => void;
  testID?: string;
}) {
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.browserRow,
      Boolean(hovered) && styles.browserRowHovered,
      pressed && styles.browserRowPressedElevated,
    ],
    [],
  );

  return (
    <ModelBrowserPressable onPress={onPress} style={pressableStyle} testID={testID}>
      <View style={styles.browserRowContent}>
        <View style={styles.browserRowLeading}>{leadingSlot}</View>
        <View style={styles.browserRowText}>
          <Text numberOfLines={1} style={styles.browserRowLabel}>
            {label}
          </Text>
        </View>
        {trailingSlot ? <View style={styles.browserRowTrailing}>{trailingSlot}</View> : null}
      </View>
    </ModelBrowserPressable>
  );
}

function ModelRow({
  row,
  isSelected,
  showProviderLabel = false,
  onPress,
  disabled = false,
}: {
  row: ProviderSelectionModelRow;
  isSelected: boolean;
  showProviderLabel?: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  const description = showProviderLabel ? buildProviderQualifiedDescription(row) : undefined;
  const contextWindowLabel =
    row.contextWindowMaxTokens !== undefined ? formatTokenCount(row.contextWindowMaxTokens) : null;
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.browserRow,
      isSelected && styles.browserRowSelected,
      Boolean(hovered) && styles.browserRowHovered,
      pressed && styles.browserRowPressed,
    ],
    [isSelected],
  );

  return (
    <ModelBrowserPressable
      onPress={onPress}
      style={pressableStyle}
      accessibilitySelected={isSelected}
      accessibilityDisabled={disabled}
      testID={`model-row-${row.provider}-${row.modelId}`}
    >
      <View style={styles.browserRowContent}>
        <View style={[styles.browserRowText, description && styles.browserRowTextInline]}>
          <Text numberOfLines={1} style={styles.browserRowLabel}>
            {row.modelLabel}
          </Text>
          {description ? (
            <Text numberOfLines={1} style={styles.browserRowDescription}>
              {description}
            </Text>
          ) : null}
        </View>
        <View style={styles.browserRowTrailing}>
          {contextWindowLabel ? (
            <Text style={styles.modelContextWindow}>{contextWindowLabel}</Text>
          ) : null}
          {isSelected ? <ThemedCheck size={ICON_SIZE.sm} uniProps={accentMapping} /> : null}
        </View>
      </View>
    </ModelBrowserPressable>
  );
}

function SelectableModelRow({
  row,
  isSelected,
  showProviderLabel,
  onSelect,
  disabled = false,
}: {
  row: ProviderSelectionModelRow;
  isSelected: boolean;
  showProviderLabel?: boolean;
  onSelect: (provider: string, modelId: string) => void;
  disabled?: boolean;
}) {
  const handlePress = useCallback(() => {
    if (!disabled) onSelect(row.provider, row.modelId);
  }, [disabled, onSelect, row.modelId, row.provider]);
  return (
    <ModelRow
      row={row}
      isSelected={isSelected}
      showProviderLabel={showProviderLabel}
      onPress={handlePress}
      disabled={disabled}
    />
  );
}

function GroupProviderButton({
  provider,
  onDrillDown,
}: {
  provider: ProviderSelectorProvider;
  onDrillDown: (providerId: string, providerLabel: string) => void;
}) {
  const { t } = useTranslation();
  const selection = provider.modelSelection;
  const handlePress = useCallback(() => {
    onDrillDown(provider.id, provider.label);
  }, [onDrillDown, provider.id, provider.label]);

  const stateNode = useMemo(() => {
    if (selection.kind === "models") {
      const count = selection.rows.length;
      const countNode = (
        <Text style={styles.drillDownCount}>
          {t(count === 1 ? "modelSelector.modelCount" : "modelSelector.modelCountPlural", {
            count,
          })}
        </Text>
      );
      return selection.error ? (
        <View style={styles.rowStateInline}>
          <ThemedAlertTriangle size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
          {countNode}
        </View>
      ) : (
        countNode
      );
    }
    if (selection.kind === "loading") {
      return (
        <View style={styles.rowStateInline}>
          <View style={styles.rowSpinner}>
            <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
          </View>
          <Text style={styles.drillDownCount}>{t("modelSelector.loadingShort")}</Text>
        </View>
      );
    }
    return (
      <View style={styles.rowStateInline}>
        <ThemedAlertTriangle size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
        <Text style={styles.drillDownCount}>{t("modelSelector.error")}</Text>
      </View>
    );
  }, [selection, t]);
  const leadingSlot = useMemo(
    () => <ModelProviderGlyph provider={provider.id} size={ICON_SIZE.sm} />,
    [provider.id],
  );
  const trailingSlot = useMemo(
    () => (
      <View style={styles.drillDownTrailing}>
        {stateNode}
        <ThemedChevronRight size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      </View>
    ),
    [stateNode],
  );

  return (
    <ModelBrowserRow
      label={provider.label}
      leadingSlot={leadingSlot}
      trailingSlot={trailingSlot}
      onPress={handlePress}
      testID={`model-provider-${provider.id}`}
    />
  );
}

function GroupedProviderRows({
  providers,
  onDrillDown,
}: {
  providers: ProviderSelectorProvider[];
  onDrillDown: (providerId: string, providerLabel: string) => void;
}) {
  return (
    <View>
      {providers.map((provider, index) => (
        <View key={provider.id}>
          {index > 0 ? <View style={styles.separator} /> : null}
          <GroupProviderButton provider={provider} onDrillDown={onDrillDown} />
        </View>
      ))}
    </View>
  );
}

function IndependentScrollBoundary({ children }: { children: React.ReactElement }) {
  // Prevent the parent sheet from cancelling Android's native scroll when the
  // finger crosses this viewport; receiving ACTION_UP is what preserves fling.
  const nativeScrollGesture = useMemo(
    () =>
      Gesture.Native()
        .shouldActivateOnStart(true)
        .shouldCancelWhenOutside(false)
        .disallowInterruption(true),
    [],
  );

  if (Platform.OS !== "android") {
    return children;
  }

  return (
    <IndependentScrollGestureContext.Provider value={nativeScrollGesture}>
      <GestureDetector gesture={nativeScrollGesture}>{children}</GestureDetector>
    </IndependentScrollGestureContext.Provider>
  );
}

function IndependentModelList({
  rows,
  renderItem,
  header,
}: {
  rows: ProviderSelectionModelRow[];
  renderItem: ({ item }: { item: ProviderSelectionModelRow }) => React.ReactElement;
  header?: React.ReactElement;
}) {
  return (
    <IndependentScrollBoundary>
      <FlatList
        data={rows}
        renderItem={renderItem}
        ListHeaderComponent={header}
        keyExtractor={getModelRowKey}
        style={styles.virtualizedModelList}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.virtualizedModelListContent}
        nestedScrollEnabled
        testID="compact-model-list"
      />
    </IndependentScrollBoundary>
  );
}

function getModelRowKey(row: ProviderSelectionModelRow): string {
  return row.favoriteKey;
}

function IndependentProviderList({ children }: { children: React.ReactNode }) {
  return (
    <IndependentScrollBoundary>
      <ScrollView
        style={styles.virtualizedModelList}
        contentContainerStyle={[
          styles.virtualizedModelListContent,
          styles.virtualizedProviderListContent,
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        testID="compact-provider-list"
      >
        {children}
      </ScrollView>
    </IndependentScrollBoundary>
  );
}

function ModelRowList({
  rows,
  selectedProvider,
  selectedModel,
  onSelect,
  showProviderLabel = false,
  header,
  scrolling,
  disabled = false,
}: {
  rows: ProviderSelectionModelRow[];
  selectedProvider: string;
  selectedModel: string;
  onSelect: (provider: string, modelId: string) => void;
  showProviderLabel?: boolean;
  header?: React.ReactElement;
  scrolling: "sheet" | "independent";
  disabled?: boolean;
}) {
  const isCompact = useIsCompactFormFactor();
  const renderItem = useCallback(
    ({ item }: { item: ProviderSelectionModelRow }) => (
      <SelectableModelRow
        row={item}
        isSelected={isModelBrowserRowSelected(
          item.provider,
          item.modelId,
          selectedProvider,
          selectedModel,
        )}
        showProviderLabel={showProviderLabel}
        onSelect={onSelect}
        disabled={disabled}
      />
    ),
    [disabled, onSelect, selectedModel, selectedProvider, showProviderLabel],
  );
  const keyExtractor = useCallback((row: ProviderSelectionModelRow) => row.favoriteKey, []);

  if (scrolling === "independent") {
    return <IndependentModelList rows={rows} renderItem={renderItem} header={header} />;
  }

  if (isCompact && isNative) {
    return (
      <BottomSheetFlatList
        data={rows}
        renderItem={renderItem}
        ListHeaderComponent={header}
        keyExtractor={keyExtractor}
        style={styles.virtualizedModelList}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.virtualizedModelListContent}
      />
    );
  }

  return (
    <View>
      {header}
      {rows.map((row) => (
        <View key={row.favoriteKey}>{renderItem({ item: row })}</View>
      ))}
    </View>
  );
}

function ProviderErrorEmptyState({
  providerId,
  message,
  onRetryProvider,
  isRetryingProvider,
}: {
  providerId: string;
  message: string;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
}) {
  const { t } = useTranslation();
  const handleRetry = useCallback(() => {
    onRetryProvider?.(providerId);
  }, [onRetryProvider, providerId]);
  return (
    <View style={styles.emptyState}>
      <ThemedAlertTriangle size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
      <Text style={styles.emptyStateText}>{message}</Text>
      {onRetryProvider ? (
        <Button variant="default" size="sm" onPress={handleRetry} disabled={isRetryingProvider}>
          {isRetryingProvider ? t("modelSelector.retrying") : t("modelSelector.retry")}
        </Button>
      ) : null}
    </View>
  );
}

function ProviderErrorNotice({
  providerId,
  message,
  onRetryProvider,
  isRetryingProvider,
}: {
  providerId: string;
  message: string;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
}) {
  const { t } = useTranslation();
  const handleRetry = useCallback(() => {
    onRetryProvider?.(providerId);
  }, [onRetryProvider, providerId]);
  return (
    <View style={styles.providerErrorNotice} testID={`model-provider-error-${providerId}`}>
      <ThemedAlertTriangle size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
      <Text style={styles.providerErrorNoticeText} numberOfLines={2}>
        {message}
      </Text>
      {onRetryProvider ? (
        <Button variant="ghost" size="sm" onPress={handleRetry} disabled={isRetryingProvider}>
          {isRetryingProvider ? t("modelSelector.retrying") : t("modelSelector.retry")}
        </Button>
      ) : null}
    </View>
  );
}

function ModelSearchEmptyState() {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState}>
      <ThemedSearch size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
      <Text style={styles.emptyStateText}>{t("modelSelector.noMatches")}</Text>
    </View>
  );
}

function ProviderModelBrowserContent({
  view,
  provider,
  selectedProvider,
  selectedModel,
  normalizedQuery,
  onSelect,
  onRetryProvider,
  isRetryingProvider,
  scrolling,
  historyHeader,
  disabled = false,
}: {
  view: Extract<ModelBrowserView, { kind: "provider" }>;
  provider: ProviderSelectorProvider | null;
  selectedProvider: string;
  selectedModel: string;
  normalizedQuery: string;
  onSelect: (provider: string, modelId: string) => void;
  onRetryProvider?: (provider: AgentProvider) => void;
  isRetryingProvider: boolean;
  scrolling: "sheet" | "independent";
  historyHeader?: React.ReactElement;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const visibleRows = useMemo(
    () => (provider ? filterAndRankModelRows(getProviderModelRows(provider), normalizedQuery) : []),
    [normalizedQuery, provider],
  );
  const errorMessage =
    provider?.modelSelection.kind === "models" ? provider.modelSelection.error : undefined;
  const listHeader = useMemo(
    () => (
      <View>
        {historyHeader}
        {errorMessage ? (
          <ProviderErrorNotice
            providerId={view.providerId}
            message={errorMessage}
            onRetryProvider={onRetryProvider}
            isRetryingProvider={isRetryingProvider}
          />
        ) : null}
      </View>
    ),
    [errorMessage, historyHeader, isRetryingProvider, onRetryProvider, view.providerId],
  );
  const emptyListHeader = useMemo(
    () => (
      <View>
        {listHeader}
        <ModelSearchEmptyState />
      </View>
    ),
    [listHeader],
  );

  if (!provider) return <ModelSearchEmptyState />;
  const selection = provider.modelSelection;
  if (selection.kind === "loading") {
    return (
      <View style={styles.emptyState}>
        <View style={styles.rowSpinner}>
          <ThemedLoadingSpinner size={ICON_SIZE.sm} uniProps={foregroundMutedMapping} />
        </View>
        <Text style={styles.emptyStateText}>{t("modelSelector.loadingShort")}</Text>
      </View>
    );
  }
  if (selection.kind === "error") {
    return (
      <ProviderErrorEmptyState
        providerId={view.providerId}
        message={selection.message}
        onRetryProvider={onRetryProvider}
        isRetryingProvider={isRetryingProvider}
      />
    );
  }
  if (visibleRows.length === 0) {
    return (
      <ModelRowList
        rows={[]}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        onSelect={onSelect}
        disabled={disabled}
        scrolling={scrolling}
        header={emptyListHeader}
      />
    );
  }
  return (
    <ModelRowList
      rows={visibleRows}
      selectedProvider={selectedProvider}
      selectedModel={selectedModel}
      onSelect={onSelect}
      disabled={disabled}
      header={listHeader}
      scrolling={scrolling}
    />
  );
}

function ModelBrowserContent({
  view,
  providers,
  selectedProvider,
  selectedModel,
  searchQuery,
  isSearchFocused,
  onSelect,
  onDrillDown,
  onRetryProvider,
  isRetryingProvider = false,
  scrolling,
  searchAllOnFocus,
  rootBrowseContent,
  history,
}: ModelBrowserContentProps) {
  const { t } = useTranslation();
  const normalizedQuery = useMemo(() => normalizeSearchQuery(searchQuery), [searchQuery]);
  const selectedViewProvider = useMemo(
    () =>
      view.kind === "provider"
        ? (providers.find((provider) => provider.id === view.providerId) ?? null)
        : null,
    [providers, view],
  );
  const allView = useMemo(
    () =>
      resolveModelBrowserAllView({
        providers,
        normalizedQuery,
        isSearchFocused: searchAllOnFocus && isSearchFocused,
      }),
    [isSearchFocused, normalizedQuery, providers, searchAllOnFocus],
  );
  const hasResults = providers.length > 0 || rootBrowseContent != null;
  const historyRows = useMemo(() => {
    if (view.kind === "all") return getAllProviderModelRows(providers);
    return selectedViewProvider ? getProviderModelRows(selectedViewProvider) : [];
  }, [providers, selectedViewProvider, view.kind]);
  const historyHeader = useMemo(
    () =>
      history ? (
        <ModelUsageHistory
          {...history}
          rows={historyRows}
          searchQuery={normalizedQuery}
          showProviderLabel={view.kind === "all"}
        />
      ) : undefined,
    [history, historyRows, normalizedQuery, view.kind],
  );
  const emptyListHeader = useMemo(
    () => (
      <View>
        {historyHeader}
        <View style={styles.emptyState} testID="model-search-empty">
          <ThemedSearch size={ICON_SIZE.md} uniProps={foregroundMutedMapping} />
          <Text style={styles.emptyStateText}>
            {t("modelSelector.noMatchesForQuery", { query: searchQuery.trim() })}
          </Text>
        </View>
      </View>
    ),
    [historyHeader, searchQuery, t],
  );

  if (view.kind === "provider") {
    return (
      <ProviderModelBrowserContent
        view={view}
        provider={selectedViewProvider}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        normalizedQuery={normalizedQuery}
        onSelect={onSelect}
        onRetryProvider={onRetryProvider}
        isRetryingProvider={isRetryingProvider}
        scrolling={scrolling}
        historyHeader={historyHeader}
        disabled={history?.disabled}
      />
    );
  }

  if (allView.kind === "noSearchMatches") {
    return (
      <ModelRowList
        rows={[]}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        onSelect={onSelect}
        disabled={history?.disabled}
        scrolling={scrolling}
        header={emptyListHeader}
      />
    );
  }

  if (allView.kind === "searchResults") {
    return (
      <ModelRowList
        rows={allView.rows}
        selectedProvider={selectedProvider}
        selectedModel={selectedModel}
        onSelect={onSelect}
        disabled={history?.disabled}
        showProviderLabel
        header={historyHeader}
        scrolling={scrolling}
      />
    );
  }

  const allProvidersContent = (
    <View>
      {historyHeader}
      {rootBrowseContent ??
        (providers.length > 0 ? (
          <GroupedProviderRows providers={providers} onDrillDown={onDrillDown} />
        ) : null)}
      {!hasResults ? <ModelSearchEmptyState /> : null}
    </View>
  );

  return scrolling === "independent" ? (
    <IndependentProviderList>{allProvidersContent}</IndependentProviderList>
  ) : (
    <BottomSheetScrollView
      style={styles.virtualizedModelList}
      contentContainerStyle={[
        styles.virtualizedModelListContent,
        styles.virtualizedProviderListContent,
      ]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      showsVerticalScrollIndicator={false}
      testID="compact-provider-list"
    >
      {allProvidersContent}
    </BottomSheetScrollView>
  );
}

export function ModelBrowser({
  state,
  onSelect,
  onRetryProvider,
  isRetryingProvider = false,
  scrolling = "sheet",
  searchAllOnFocus = false,
  rootBrowseContent,
  history,
}: ModelBrowserProps) {
  return (
    <ModelBrowserContent
      view={state.view}
      providers={state.providers}
      selectedProvider={state.selectedProvider}
      selectedModel={state.selectedModel}
      searchQuery={state.searchQuery}
      isSearchFocused={state.isSearchFocused}
      onSelect={onSelect}
      onDrillDown={state.drillDown}
      onRetryProvider={onRetryProvider}
      isRetryingProvider={isRetryingProvider}
      scrolling={scrolling}
      searchAllOnFocus={searchAllOnFocus}
      rootBrowseContent={rootBrowseContent}
      history={history}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  browserRow: {
    flexDirection: "row",
    paddingVertical: 5,
    minHeight: 32,
  },
  browserRowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  browserRowPressed: {
    backgroundColor: theme.colors.surface1,
  },
  browserRowPressedElevated: {
    backgroundColor: theme.colors.surface2,
  },
  browserRowSelected: {
    backgroundColor: theme.colors.surface1,
  },
  browserRowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: isWeb ? theme.spacing[3] : theme.spacing[6],
  },
  browserRowLeading: {
    width: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  browserRowText: {
    flex: 1,
    flexShrink: 1,
  },
  browserRowTextInline: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
  },
  browserRowLabel: {
    fontSize: 13,
    color: theme.colors.foreground,
    flexShrink: 0,
  },
  browserRowDescription: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  browserRowTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: "auto",
  },
  modelContextWindow: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  drillDownTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  drillDownCount: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  rowStateInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
    minWidth: 0,
  },
  rowSpinner: {
    transform: [{ scale: 0.7 }],
  },
  emptyState: {
    paddingVertical: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyStateText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  providerErrorNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: isWeb ? theme.spacing[3] : theme.spacing[6],
    marginVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  providerErrorNoticeText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  virtualizedModelList: {
    flex: 1,
  },
  virtualizedModelListContent: {
    paddingTop: 2,
    paddingBottom: theme.spacing[4],
  },
  virtualizedProviderListContent: {
    paddingTop: 0,
  },
  providerIconMuted: {
    color: theme.colors.foregroundMuted,
  },
  providerIconForeground: {
    color: theme.colors.foreground,
  },
}));
