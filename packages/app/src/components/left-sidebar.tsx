import { router, usePathname, type Href } from "expo-router";
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleUserRound,
  GitBranch,
  History,
  Home,
  Import as ImportIcon,
  LockKeyhole,
  Plus,
  Search,
  Server,
  Settings,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type RefObject,
  type ReactNode,
} from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { resolveDesktopSidebarWidth } from "@/components/desktop-sidebar-layout";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { HostPicker } from "@/components/hosts/host-picker";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/display-preferences/menu";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import {
  formatOmpAccountIdentity,
  formatOmpAccountSelectionLabel,
  isOmpAutomaticAccountOption,
  resolveOmpAccountFeatureSelection,
  resolveOmpAccountSelectorOptions,
} from "@/components/omp-provider-accounts";
import {
  resolveOmpRemainingQuotaPct,
  shouldShowOmpFiveHourQuota,
} from "@/components/omp-provider-quota";
import { OmpQuotaCountdown } from "@/components/omp-codex-quota-details";
import { ProviderUsageBalanceBar } from "@/provider-usage/balance-bar";
import type { ProviderUsageView } from "@/provider-usage/types";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { ProviderUsageWindowBar } from "@/provider-usage/window-bar";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useActiveAgentControls } from "@/command-center/provider";
import type { AgentControlCommandCenterSource } from "@/command-center/agent-control-registration";
import {
  groupOmpModelsByProviderNamespace,
  resolveProviderSwitchModel,
  resolveModelBrowserProviderId,
  resolveModelBrowserProviderNamespaceId,
} from "@/composer/agent-controls/model-sheet-flow";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useOpenProject } from "@/hooks/use-open-project";
import type { OpenProjectResult } from "@/hooks/open-project";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { type SidebarGroupMode, useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import {
  useOmpAccountQuota,
  useOmpQuotaClock,
  useOmpQuotaReachedRefresh,
  type OmpAccountQuotaDisplayAccount,
} from "@/hooks/use-omp-account-quota";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { usePanelStore } from "@/stores/panel-store";
import { useOwnsWindowChromeCorner, WindowChromeSafeArea } from "@/utils/desktop-window";
import { useCloseAgentListGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { useIsMobilePanelPresented } from "@/mobile-panels/provider";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import {
  buildHostAgentDetailRoute,
  buildOpenProjectRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
  buildSettingsAddHostRoute,
  buildSettingsRoute,
} from "@/utils/host-routes";
import { openHostOverview } from "@/navigation/settings-navigation";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { ImportSessionSheet } from "@/components/import-session-sheet";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";
import { SidebarProjectDropZone } from "./sidebar-project-drop-zone";

type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

type SidebarAccount = OmpAccountQuotaDisplayAccount;
type SidebarAccountFeature = Extract<
  NonNullable<AgentControlCommandCenterSource["features"]["list"]>[number],
  { type: "select" }
>;

const DEV_BUILD_LABEL = process.env.EXPO_PUBLIC_PASEO_DEV_BUILD_LABEL?.trim() || null;
const EXPANDED_ACCESSIBILITY_STATE = { expanded: true } as const;
const COLLAPSED_ACCESSIBILITY_STATE = { expanded: false } as const;

interface SidebarSharedProps {
  theme: SidebarTheme;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  projects: SidebarProjectEntry[];
  hasProjectsBeforeFilter: boolean;
  hasHiddenProjects: boolean;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isManualRefresh: boolean;
  groupMode: SidebarGroupMode;
  collapsedProjectKeys: ReadonlySet<string>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  handleRefresh: () => void;
  handleOpenProject: () => void;
  handleOpenImportSession: () => void;
  handleHome: () => void;
  handleSettings: () => void;
  labels: SidebarLabels;
  newWorkspaceKeys: ShortcutKey[][] | null;
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
}

interface SidebarLabels {
  newWorkspace: string;
  importSession: string;
  hosts: string;
  home: string;
  settings: string;
  sessions: string;
  schedules: string;
  closeSidebar: string;
  projectDropHint: string;
  projectDropFailed: string;
}

interface MobileSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  insetsBottom: number;
  closeSidebar: () => void;
  handleViewMoreNavigate: () => void;
  handleViewSchedulesNavigate: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  active: boolean;
  localServerId: string | null;
  openLocalProject: (path: string) => Promise<OpenProjectResult>;
  handleViewMore: () => void;
  handleViewSchedules: () => void;
}

export const LeftSidebar = memo(function LeftSidebar({ active }: { active: boolean }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);

  const {
    projects,
    hasProjectsBeforeFilter,
    hasHiddenProjects,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    refreshAll,
    workspaceGroups,
    projectIconTargets,
    collapsedProjectKeys,
    toggleProjectCollapsed,
    groupMode,
    shortcutModel,
  } = useSidebarModel();
  const { shortcutIndexByWorkspaceKey } = shortcutModel;

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const openProjectPicker = useOpenAddProject();
  const localServerId = useLocalDaemonServerId();
  const importClient = useHostRuntimeClient(localServerId ?? "");
  const openImportedProject = useOpenProject(localServerId);
  const [isImportSheetOpen, setIsImportSheetOpen] = useState(false);

  const handleOpenImportSessionDesktop = useCallback(() => {
    if (!localServerId) return;
    setIsImportSheetOpen(true);
  }, [localServerId]);

  const handleOpenImportSessionMobile = useCallback(() => {
    if (!localServerId) return;
    showMobileAgent();
    setIsImportSheetOpen(true);
  }, [localServerId, showMobileAgent]);

  const handleCloseImportSession = useCallback(() => setIsImportSheetOpen(false), []);

  const handleImported = useCallback(
    (agent: { id: string; cwd: string }) => {
      if (!localServerId) return;
      void (async () => {
        const result = await openImportedProject(agent.cwd);
        if (result.ok) {
          router.push(buildHostAgentDetailRoute(localServerId, agent.id) as Href);
        }
      })();
    },
    [localServerId, openImportedProject],
  );

  const handleOpenProjectMobile = useCallback(() => {
    showMobileAgent();
    void openProjectPicker();
  }, [showMobileAgent, openProjectPicker]);

  const handleOpenProjectDesktop = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleSettingsMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsRoute());
  }, [showMobileAgent]);

  const handleSettingsDesktop = useCallback(() => {
    router.push(buildSettingsRoute());
  }, []);

  const handleAddHostMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsAddHostRoute(Date.now()));
  }, [showMobileAgent]);

  const handleAddHostDesktop = useCallback(() => {
    router.push(buildSettingsAddHostRoute(Date.now()));
  }, []);

  const handleOpenHostSettingsMobile = useCallback(
    (serverId: string) => {
      showMobileAgent();
      openHostOverview(serverId);
    },
    [showMobileAgent],
  );

  const handleOpenHostSettingsDesktop = useCallback((serverId: string) => {
    openHostOverview(serverId);
  }, []);

  const handleHomeMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildOpenProjectRoute());
  }, [showMobileAgent]);

  const handleHomeDesktop = useCallback(() => {
    router.push(buildOpenProjectRoute());
  }, []);

  const handleViewMoreNavigate = useCallback(() => {
    router.push(buildSessionsRoute());
  }, []);

  const handleViewSchedulesNavigate = useCallback(() => {
    router.push(buildSchedulesRoute());
  }, []);

  const newWorkspaceKeys = useShortcutKeys("new-workspace");
  const labels = useMemo(
    (): SidebarLabels => ({
      newWorkspace: t("sidebar.actions.newWorkspace"),
      importSession: t("importSession.title"),
      hosts: t("sidebar.actions.hosts"),
      home: t("sidebar.actions.home"),
      settings: t("sidebar.actions.settings"),
      sessions: t("sidebar.sections.sessions"),
      schedules: t("sidebar.sections.schedules"),
      closeSidebar: t("sidebar.actions.closeSidebar"),
      projectDropHint: t("sidebar.project.drop.hint"),
      projectDropFailed: t("sidebar.project.drop.failed"),
    }),
    [t],
  );

  const sharedProps = {
    theme,
    workspaceGroups,
    projectIconTargets,
    projects,
    hasProjectsBeforeFilter,
    hasHiddenProjects,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    isManualRefresh,
    groupMode,
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
    handleRefresh,
    labels,
    newWorkspaceKeys,
  };

  const sidebar = isCompactLayout ? (
    <RetainedPanelActivity active={active}>
      <MobileSidebar
        {...sharedProps}
        insetsTop={insets.top}
        insetsBottom={insets.bottom}
        closeSidebar={showMobileAgent}
        handleOpenProject={handleOpenProjectMobile}
        handleOpenImportSession={handleOpenImportSessionMobile}
        handleHome={handleHomeMobile}
        handleSettings={handleSettingsMobile}
        handleAddHost={handleAddHostMobile}
        handleOpenHostSettings={handleOpenHostSettingsMobile}
        handleViewMoreNavigate={handleViewMoreNavigate}
        handleViewSchedulesNavigate={handleViewSchedulesNavigate}
      />
    </RetainedPanelActivity>
  ) : (
    <RetainedPanelActivity active={active}>
      <DesktopSidebar
        {...sharedProps}
        insetsTop={insets.top}
        active={active}
        handleOpenProject={handleOpenProjectDesktop}
        handleOpenImportSession={handleOpenImportSessionDesktop}
        handleHome={handleHomeDesktop}
        handleSettings={handleSettingsDesktop}
        handleAddHost={handleAddHostDesktop}
        handleOpenHostSettings={handleOpenHostSettingsDesktop}
        handleViewMore={handleViewMoreNavigate}
        localServerId={localServerId}
        openLocalProject={openImportedProject}
        handleViewSchedules={handleViewSchedulesNavigate}
      />
    </RetainedPanelActivity>
  );

  return (
    <>
      {sidebar}
      <ImportSessionSheet
        visible={isImportSheetOpen}
        client={importClient}
        serverId={localServerId}
        onClose={handleCloseImportSession}
        onImported={handleImported}
      />
    </>
  );
});

function sidebarHostOptionTestID(serverId: string): string {
  return `sidebar-host-row-${serverId}`;
}

function resolveFooterButtonAccessibilityState(expanded?: boolean) {
  if (expanded === undefined) return undefined;
  return expanded ? EXPANDED_ACCESSIBILITY_STATE : COLLAPSED_ACCESSIBILITY_STATE;
}

function FooterIconButton({
  buttonRef,
  onPress,
  testID,
  label,
  icon: Icon,
  iconSize,
  shortcutKeys,
  expanded,
  theme,
}: {
  onPress: () => void;
  testID: string;
  label: string;
  icon: typeof Server;
  iconSize?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  expanded?: boolean;
  theme: SidebarTheme;
  buttonRef?: RefObject<View | null>;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          style={styles.footerIconButton}
          testID={testID}
          nativeID={testID}
          collapsable={false}
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          accessibilityState={resolveFooterButtonAccessibilityState(expanded)}
          onPress={onPress}
        >
          {({ hovered }) => (
            <Icon
              size={iconSize ?? theme.iconSize.md}
              color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
            />
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <IconTooltipContent label={label} shortcutKeys={shortcutKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarHostPicker({
  theme,
  label,
  onAddHost,
  onOpenHostSettings,
}: {
  theme: SidebarTheme;
  label: string;
  onAddHost: () => void;
  onOpenHostSettings: (serverId: string) => void;
}) {
  const hosts = useHosts();
  const triggerRef = useRef<View | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleSelect = useCallback(
    (id: string) => {
      onOpenHostSettings(id);
    },
    [onOpenHostSettings],
  );

  const handleOpen = useCallback(() => setIsOpen(true), []);

  return (
    <HostPicker
      hosts={hosts}
      value=""
      onSelect={handleSelect}
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={triggerRef}
      includeAddHost
      onAddHost={onAddHost}
      showActiveConnection
      onOpenHostSettings={onOpenHostSettings}
      searchable
      desktopPlacement="top-start"
      desktopMinWidth={240}
      addHostTestID="sidebar-host-add"
      hostOptionTestID={sidebarHostOptionTestID}
    >
      <FooterIconButton
        buttonRef={triggerRef}
        onPress={handleOpen}
        testID="sidebar-hosts-trigger"
        label={label}
        icon={Server}
        iconSize={theme.iconSize.sm}
        theme={theme}
      />
    </HostPicker>
  );
}

function IconTooltipContent({
  label,
  shortcutKeys,
}: {
  label: string;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
    </View>
  );
}

const SidebarNewWorkspaceHeaderRow = memo(function SidebarNewWorkspaceHeaderRow({
  label,
  testID,
  variant,
  shortcutKeys,
  onPress,
}: {
  label: string;
  testID: string;
  variant: "header" | "compact";
  shortcutKeys: ShortcutKey[][] | null;
  onPress: () => void;
}) {
  return (
    <SidebarHeaderRow
      icon={Plus}
      label={label}
      onPress={onPress}
      testID={testID}
      variant={variant}
      shortcutKeys={shortcutKeys}
    />
  );
});

function SidebarQuotaMeter({
  label,
  usedPct,
  limitReached,
  resetsAt,
}: {
  label: string;
  usedPct: number | null | undefined;
  limitReached?: boolean | null;
  resetsAt?: string | null;
}) {
  const { theme } = useUnistyles();
  const remainingPct = resolveOmpRemainingQuotaPct(usedPct);
  const reached = limitReached === true || remainingPct === 0;
  const accessibilityValue = useMemo(
    () => (remainingPct === null ? undefined : { min: 0, max: 100, now: Math.round(remainingPct) }),
    [remainingPct],
  );
  let color = theme.colors.foregroundMuted;
  if (reached) {
    color = theme.colors.destructive;
  } else if (remainingPct !== null && remainingPct <= 30) {
    color = theme.colors.palette.amber[500];
  } else if (remainingPct !== null) {
    color = theme.colors.palette.green[500];
  }
  const percentage = remainingPct === null ? "—" : `${Math.round(remainingPct)}%`;

  return (
    <View style={styles.sidebarQuotaMeter}>
      <View style={styles.sidebarQuotaHeader}>
        <Text style={styles.sidebarQuotaLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.sidebarQuotaPercentage, { color }]} numberOfLines={1}>
          {percentage}
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityValue={accessibilityValue}
        style={styles.sidebarQuotaTrack}
      >
        {remainingPct !== null ? (
          <View
            style={[styles.sidebarQuotaFill, { width: `${remainingPct}%`, backgroundColor: color }]}
          />
        ) : null}
      </View>
      <OmpQuotaCountdown resetsAt={resetsAt} />
    </View>
  );
}
function SidebarProviderUsageDetails({
  providerId,
  view,
  loadingLabel,
}: {
  providerId: string;
  view: ProviderUsageView;
  loadingLabel: string;
}) {
  const { t } = useTranslation();
  if (view.kind === "loading") {
    return <Text style={styles.sidebarQuotaLoading}>{loadingLabel}</Text>;
  }
  if (view.kind === "error") {
    return <Text style={styles.sidebarQuotaLoading}>{view.message}</Text>;
  }

  const usage =
    view.payload.providers.find(
      (candidate) => candidate.providerId.toLowerCase() === providerId.toLowerCase(),
    ) ?? null;
  if (!usage) {
    return <Text style={styles.sidebarQuotaLoading}>{t("providerUsage.empty")}</Text>;
  }
  if (usage.status !== "available") {
    return (
      <Text style={styles.sidebarQuotaLoading}>{usage.error ?? t("providerUsage.errorTitle")}</Text>
    );
  }

  const balances = usage.balances ?? [];
  if (usage.windows.length === 0 && balances.length === 0) {
    return <Text style={styles.sidebarQuotaLoading}>{t("providerUsage.empty")}</Text>;
  }

  return (
    <>
      {usage.windows.map((window) => (
        <ProviderUsageWindowBar key={window.id} window={window} showReset={false} />
      ))}
      {balances.map((balance) => (
        <ProviderUsageBalanceBar key={balance.id} balance={balance} showReset={false} />
      ))}
    </>
  );
}

function SidebarAccountTriggerContent({
  primary,
  secondary,
  locked,
  canSwitch,
  theme,
}: {
  primary: string;
  secondary: string;
  locked: boolean;
  canSwitch: boolean;
  theme: SidebarTheme;
}) {
  let trailing: ReactNode = null;
  if (locked) {
    trailing = (
      <View
        style={styles.sidebarAccountLock}
        testID="sidebar-account-reply-lock"
        accessible={false}
      >
        <LockKeyhole size={13} color={theme.colors.foregroundMuted} />
      </View>
    );
  } else if (canSwitch) {
    trailing = <ChevronDown size={14} color={theme.colors.foregroundMuted} />;
  }

  return (
    <>
      <CircleUserRound size={16} color={theme.colors.foregroundMuted} />
      <View style={styles.sidebarAccountCopy}>
        <Text style={styles.sidebarAccountName} numberOfLines={1}>
          {primary}
        </Text>
        {secondary ? (
          <Text style={styles.sidebarAccountSecondary} numberOfLines={1}>
            {secondary}
          </Text>
        ) : null}
      </View>
      {trailing}
    </>
  );
}

function SidebarProviderSelector({
  compact,
  anchorRef,
  canSwitch,
  onToggle,
  triggerStyle,
  label,
  theme,
  options,
  value,
  onSelect,
  open,
  onOpenChange,
}: {
  compact: boolean;
  anchorRef: RefObject<View | null>;
  canSwitch: boolean;
  onToggle: () => void;
  triggerStyle: ComponentProps<typeof ComboboxTrigger>["style"];
  label: string;
  theme: SidebarTheme;
  options: ComboboxOption[];
  value: string;
  onSelect: (providerId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const selector = (
    <>
      <ComboboxTrigger
        ref={anchorRef}
        collapsable={false}
        disabled={!canSwitch}
        onPress={onToggle}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("agentControls.provider.select")}
        testID="sidebar-provider-selector"
        chevron={null}
      >
        <View style={compact ? styles.sidebarProviderCopyCompact : styles.sidebarProviderCopy}>
          <Text style={styles.sidebarProviderName} numberOfLines={1}>
            {label}
          </Text>
        </View>
        {canSwitch ? (
          <ChevronDown size={compact ? 12 : 14} color={theme.colors.foregroundMuted} />
        ) : null}
      </ComboboxTrigger>
      <Combobox
        options={options}
        value={value}
        onSelect={onSelect}
        searchable={options.length > 6}
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={240}
      />
    </>
  );
  if (!compact) return selector;
  return <View style={styles.footerProviderSelector}>{selector}</View>;
}

function SidebarProviderAccountPanel({
  controls,
  detailsExpanded,
  onToggleDetails,
  detailsToggleLabel,
  children,
}: {
  controls: AgentControlCommandCenterSource;
  detailsExpanded: boolean;
  onToggleDetails: () => void;
  detailsToggleLabel: string;
  children: ReactNode;
}) {
  return (
    <SidebarProviderAccountPanelContent
      controls={controls}
      detailsExpanded={detailsExpanded}
      onToggleDetails={onToggleDetails}
      detailsToggleLabel={detailsToggleLabel}
    >
      {children}
    </SidebarProviderAccountPanelContent>
  );
}

function useSidebarProviderModel(controls: AgentControlCommandCenterSource) {
  const selectedModelId = controls.models.selectedModelId ?? "";
  const providers = useMemo(
    () => groupOmpModelsByProviderNamespace([...controls.models.providers]),
    [controls.models.providers],
  );
  const selectedProviderId = useMemo(
    () =>
      resolveModelBrowserProviderId(
        controls.models.selectedProvider ?? controls.provider ?? "",
        selectedModelId,
        providers,
      ),
    [controls, providers, selectedModelId],
  );
  const selectedProviderUsageId = resolveModelBrowserProviderNamespaceId(
    selectedProviderId,
    selectedModelId,
  );
  const isOmpProviderSelected =
    selectedProviderId.startsWith("omp:") ||
    controls.provider === "omp" ||
    controls.provider === "pi" ||
    controls.provider === "codex";
  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId) ?? null;
  const rememberedModelByProviderRef = useRef(new Map<string, string>());
  const providerOptions = useMemo<ComboboxOption[]>(
    () => providers.map((provider) => ({ id: provider.id, label: provider.label })),
    [providers],
  );
  useEffect(() => {
    if (!selectedProvider || !selectedModelId) return;
    if (
      selectedProvider.modelSelection.kind === "models" &&
      selectedProvider.modelSelection.rows.some((row) => row.modelId === selectedModelId)
    ) {
      rememberedModelByProviderRef.current.set(selectedProvider.id, selectedModelId);
    }
  }, [selectedModelId, selectedProvider]);

  return {
    selectedModelId,
    providers,
    selectedProviderId,
    selectedProviderUsageId,
    isOmpProviderSelected,
    selectedProvider,
    rememberedModelByProviderRef,
    providerOptions,
  };
}

function shouldShowSidebarProviderUsage({
  selectableAccountCount,
  canFetchProviderUsage,
  selectedProviderUsageId,
  isOmpProviderSelected,
  hasSelectedProviderUsage,
}: {
  selectableAccountCount: number;
  canFetchProviderUsage: boolean;
  selectedProviderUsageId: string;
  isOmpProviderSelected: boolean;
  hasSelectedProviderUsage: boolean;
}): boolean {
  if (selectableAccountCount > 0 || !canFetchProviderUsage) return false;
  if (selectedProviderUsageId === "cursor") return true;
  return isOmpProviderSelected && hasSelectedProviderUsage;
}

function selectSidebarAccount(
  accountFeature: SidebarAccountFeature | undefined,
  selectableAccounts: SidebarAccount[],
  selectedAccountId: string,
): SidebarAccount | null {
  const selected =
    selectableAccounts.find((account) => String(account.credentialId) === selectedAccountId) ??
    null;
  if (selected) return selected;
  if (!accountFeature && selectableAccounts.length === 1) return selectableAccounts[0] ?? null;
  return null;
}

function resolveSidebarAccountCopy({
  accountSelection,
  selectedAccount,
  accountOptions,
  selectedAccountId,
  t,
}: {
  accountSelection: { isAutomatic: boolean } | null;
  selectedAccount: SidebarAccount | null;
  accountOptions: ComboboxOption[];
  selectedAccountId: string;
  t: TFunction;
}) {
  const accountIdentity = formatOmpAccountIdentity(selectedAccount?.identityKey);
  const accountNote = selectedAccount?.note?.trim();
  const accountSelectionLabel =
    accountNote ||
    accountIdentity.primary ||
    accountOptions.find((option) => option.id === selectedAccountId)?.label ||
    t("agentControls.features.oauthAccount.title");
  const accountPlan = selectedAccount?.quota?.planLabel?.trim();
  if (accountSelection?.isAutomatic === true) {
    return {
      primary: [t("agentControls.quota.automatic"), accountPlan].filter(Boolean).join(" · "),
      secondary: selectedAccount
        ? [accountSelectionLabel, accountIdentity.secondary].filter(Boolean).join(" · ")
        : t("agentControls.quota.automaticSelecting"),
    };
  }
  return {
    primary: accountSelectionLabel,
    secondary: [accountNote ? null : accountIdentity.secondary, accountPlan]
      .filter(Boolean)
      .join(" · "),
  };
}

function useSidebarSelectedAccountQuotaRefresh(
  serverId: AgentControlCommandCenterSource["serverId"],
  selectedAccount: SidebarAccount | null,
) {
  const quotaNow = useOmpQuotaClock(Boolean(selectedAccount));
  useOmpQuotaReachedRefresh(
    serverId,
    [
      selectedAccount?.quota?.weeklyResetsAt,
      shouldShowOmpFiveHourQuota(selectedAccount?.quota?.planLabel)
        ? selectedAccount?.quota?.fiveHourResetsAt
        : null,
    ],
    quotaNow,
    Boolean(selectedAccount),
  );
}

function useSidebarAccountModel({
  controls,
  selectedModelId,
  selectedProviderUsageId,
  isOmpProviderSelected,
}: {
  controls: AgentControlCommandCenterSource;
  selectedModelId: string;
  selectedProviderUsageId: string;
  isOmpProviderSelected: boolean;
}) {
  const { t } = useTranslation();
  const accountFeature = controls.features.list?.find(
    (feature): feature is SidebarAccountFeature =>
      feature.id === "oauth_account_credential" && feature.type === "select",
  );
  const { accounts, loading } = useOmpAccountQuota(
    controls.serverId,
    controls.provider,
    selectedModelId,
  );
  const { view: providerUsageView, canFetch: canFetchProviderUsage } = useProviderUsage(
    controls.serverId,
    {
      enabled: selectedProviderUsageId === "cursor" || isOmpProviderSelected,
      providerId: isOmpProviderSelected ? selectedProviderUsageId : undefined,
    },
  );
  const hasSelectedProviderUsage =
    providerUsageView.kind === "ready" &&
    providerUsageView.payload.providers.some(
      (provider) => provider.providerId.toLowerCase() === selectedProviderUsageId.toLowerCase(),
    );
  const selectableAccounts = useMemo(() => {
    if (!accountFeature || accountFeature.type !== "select") return accounts;
    const ids = new Set(accountFeature.options.map((option) => option.id));
    return accounts.filter((account) => ids.has(String(account.credentialId)));
  }, [accountFeature, accounts]);
  const showProviderUsage = shouldShowSidebarProviderUsage({
    selectableAccountCount: selectableAccounts.length,
    canFetchProviderUsage,
    selectedProviderUsageId,
    isOmpProviderSelected,
    hasSelectedProviderUsage,
  });
  const accountSelection =
    accountFeature?.type === "select" ? resolveOmpAccountFeatureSelection(accountFeature) : null;
  const selectedAccountId = accountSelection?.effectiveValue ?? "";
  const selectedAccount = selectSidebarAccount(
    accountFeature,
    selectableAccounts,
    selectedAccountId,
  );
  useSidebarSelectedAccountQuotaRefresh(controls.serverId, selectedAccount);
  const accountSelectorOptions = useMemo(
    () =>
      resolveOmpAccountSelectorOptions(
        accountFeature?.type === "select" ? accountFeature.options : undefined,
        selectableAccounts,
      ),
    [accountFeature, selectableAccounts],
  );
  const accountOptions = useMemo<ComboboxOption[]>(() => {
    let accountNumber = 0;
    return accountSelectorOptions.map((option) => {
      if (isOmpAutomaticAccountOption(option)) {
        return {
          id: option.id,
          label: t("agentControls.quota.automatic"),
          description: option.description,
        };
      }
      accountNumber += 1;
      const account = selectableAccounts.find(
        (candidate) => String(candidate.credentialId) === option.id,
      );
      if (!account) {
        return {
          id: option.id,
          label: option.label,
          description: option.description,
        };
      }
      const identity = formatOmpAccountSelectionLabel({
        note: account.note,
        identityKey: account.identityKey,
        fallback: t("agentControls.quota.account", { number: accountNumber }),
      });
      const weeklyRemaining = resolveOmpRemainingQuotaPct(account.quota?.weeklyUsedPct);
      const fiveHourRemaining = resolveOmpRemainingQuotaPct(account.quota?.fiveHourUsedPct);
      const quotaParts = [
        account.quota?.planLabel?.trim(),
        weeklyRemaining === null
          ? null
          : `${t("agentControls.quota.weekly")} ${Math.round(weeklyRemaining)}%`,
        shouldShowOmpFiveHourQuota(account.quota?.planLabel) && fiveHourRemaining !== null
          ? `${t("agentControls.quota.fiveHour")} ${Math.round(fiveHourRemaining)}%`
          : null,
      ].filter((part): part is string => Boolean(part));
      return {
        id: option.id,
        label: [identity, ...quotaParts].join(" · "),
      };
    });
  }, [accountSelectorOptions, selectableAccounts, t]);
  const accountCopy = resolveSidebarAccountCopy({
    accountSelection,
    selectedAccount,
    accountOptions,
    selectedAccountId,
    t,
  });
  const hasAccountSwitcher =
    Boolean(controls.features.set && accountFeature?.type === "select") &&
    accountOptions.length > 1;
  const canSwitchAccount = hasAccountSwitcher && controls.isRunning !== true;
  const accountLocked = hasAccountSwitcher && controls.isRunning === true;

  return {
    accountFeature,
    loading,
    providerUsageView,
    selectableAccounts,
    showProviderUsage,
    accountSelection,
    selectedAccount,
    accountOptions,
    accountPrimary: accountCopy.primary,
    accountSecondary: accountCopy.secondary,
    canSwitchAccount,
    hasAccountSwitcher,
    accountLocked,
  };
}

function resolveSidebarAccountSections(
  showProviderUsage: boolean,
  loading: boolean,
  selectableAccountCount: number,
  accountOptionCount: number,
) {
  const showAccountLoading = !showProviderUsage && loading && selectableAccountCount === 0;
  return {
    showAccountLoading,
    showAccountSelector: !showProviderUsage && !showAccountLoading && accountOptionCount > 0,
  };
}

function canSwitchSidebarProvider(
  selectedProvider: ProviderSelectorProvider | null,
  optionCount: number,
): boolean {
  return optionCount > (selectedProvider ? 1 : 0);
}

function SidebarProviderAccountDetails({
  visible,
  showProviderUsage,
  selectedProviderUsageId,
  providerUsageView,
  showAccountLoading,
  showAccountSelector,
  accountLocked,
  accountSwitchHint,
  accountAnchorRef,
  hasAccountSwitcher,
  onAccountToggle,
  accountAccessibilityState,
  accountTriggerStyle,
  accountPrimary,
  accountSecondary,
  canSwitchAccount,
  theme,
  accountOptions,
  accountValue,
  onAccountSelect,
  renderAccountOption,
  accountOpen,
  onAccountOpenChange,
  selectedAccount,
}: {
  visible: boolean;
  showProviderUsage: boolean;
  selectedProviderUsageId: string;
  providerUsageView: ProviderUsageView;
  showAccountLoading: boolean;
  showAccountSelector: boolean;
  accountLocked: boolean;
  accountSwitchHint: string;
  accountAnchorRef: RefObject<View | null>;
  hasAccountSwitcher: boolean;
  onAccountToggle: () => void;
  accountAccessibilityState: { disabled: boolean };
  accountTriggerStyle: ComponentProps<typeof ComboboxTrigger>["style"];
  accountPrimary: string;
  accountSecondary: string;
  canSwitchAccount: boolean;
  theme: SidebarTheme;
  accountOptions: ComboboxOption[];
  accountValue: string;
  onAccountSelect: (credentialId: string) => void;
  renderAccountOption: (args: {
    option: ComboboxOption;
    selected: boolean;
    active: boolean;
    onPress: () => void;
  }) => ReactElement;
  accountOpen: boolean;
  onAccountOpenChange: (open: boolean) => void;
  selectedAccount: SidebarAccount | null | undefined;
}) {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <>
      {showProviderUsage ? (
        <>
          <View style={styles.sidebarProviderDivider} />
          <View style={styles.sidebarQuota}>
            <SidebarProviderUsageDetails
              providerId={selectedProviderUsageId}
              view={providerUsageView}
              loadingLabel={t("agentControls.quota.loading")}
            />
          </View>
        </>
      ) : null}
      {showAccountLoading ? (
        <View style={styles.sidebarAccountLoading}>
          <CircleUserRound size={16} color={theme.colors.foregroundMuted} />
          <Text style={styles.sidebarQuotaLoading} numberOfLines={1}>
            {t("agentControls.quota.loading")}
          </Text>
        </View>
      ) : null}
      {showAccountSelector ? (
        <>
          <View style={styles.sidebarProviderDivider} />
          <Tooltip delayDuration={300} enabledOnDesktop={accountLocked}>
            <TooltipTrigger asChild>
              <View
                style={styles.sidebarAccountTriggerContainer}
                collapsable={false}
                testID="sidebar-account-tooltip-trigger"
              >
                <ComboboxTrigger
                  ref={accountAnchorRef}
                  block={accountLocked}
                  collapsable={false}
                  disabled={!hasAccountSwitcher}
                  onPress={onAccountToggle}
                  accessibilityState={accountAccessibilityState}
                  style={accountTriggerStyle}
                  accessibilityRole="button"
                  accessibilityLabel={
                    accountLocked
                      ? `${t("agentControls.features.oauthAccount.title")}. ${accountSwitchHint}`
                      : t("agentControls.features.oauthAccount.title")
                  }
                  testID="sidebar-account-selector"
                  chevron={null}
                >
                  <SidebarAccountTriggerContent
                    primary={accountPrimary}
                    secondary={accountSecondary}
                    locked={accountLocked}
                    canSwitch={canSwitchAccount}
                    theme={theme}
                  />
                </ComboboxTrigger>
              </View>
            </TooltipTrigger>
            <TooltipContent side="top" align="end" offset={8}>
              <IconTooltipContent label={accountSwitchHint} />
            </TooltipContent>
          </Tooltip>
          <Combobox
            options={accountOptions}
            value={accountValue}
            onSelect={onAccountSelect}
            renderOption={renderAccountOption}
            searchable={false}
            open={accountOpen}
            onOpenChange={onAccountOpenChange}
            anchorRef={accountAnchorRef}
            desktopPlacement="top-start"
            desktopMinWidth={240}
          />
          {selectedAccount ? (
            <View style={styles.sidebarQuota}>
              <SidebarQuotaMeter
                label={t("agentControls.quota.weekly")}
                usedPct={selectedAccount.quota?.weeklyUsedPct}
                resetsAt={selectedAccount.quota?.weeklyResetsAt}
              />
              {shouldShowOmpFiveHourQuota(selectedAccount.quota?.planLabel) ? (
                <SidebarQuotaMeter
                  label={t("agentControls.quota.fiveHour")}
                  usedPct={selectedAccount.quota?.fiveHourUsedPct}
                  resetsAt={selectedAccount.quota?.fiveHourResetsAt}
                  limitReached={selectedAccount.quota?.fiveHourLimitReached}
                />
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function SidebarProviderAccountPanelContent({
  controls,
  detailsExpanded,
  onToggleDetails,
  detailsToggleLabel,
  children,
}: {
  controls: AgentControlCommandCenterSource;
  detailsExpanded: boolean;
  onToggleDetails: () => void;
  detailsToggleLabel: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const providerAnchorRef = useRef<View>(null);
  const accountAnchorRef = useRef<View>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const {
    selectedModelId,
    providers,
    selectedProviderId,
    selectedProviderUsageId,
    isOmpProviderSelected,
    selectedProvider,
    rememberedModelByProviderRef,
    providerOptions,
  } = useSidebarProviderModel(controls);
  const {
    accountFeature,
    loading,
    providerUsageView,
    selectableAccounts,
    showProviderUsage,
    accountSelection,
    selectedAccount,
    accountOptions,
    accountPrimary,
    accountSecondary,
    canSwitchAccount,
    hasAccountSwitcher,
    accountLocked,
  } = useSidebarAccountModel({
    controls,
    selectedModelId,
    selectedProviderUsageId,
    isOmpProviderSelected,
  });
  const canSwitchProvider = canSwitchSidebarProvider(selectedProvider, providerOptions.length);
  const { showAccountLoading, showAccountSelector } = resolveSidebarAccountSections(
    showProviderUsage,
    loading,
    selectableAccounts.length,
    accountOptions.length,
  );
  const accountAccessibilityState = useMemo(() => ({ disabled: accountLocked }), [accountLocked]);

  const providerTriggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      detailsExpanded ? styles.sidebarProviderTrigger : styles.sidebarProviderTriggerCompact,
      (hovered || pressed || providerOpen) && styles.sidebarProviderTriggerActive,
    ],
    [detailsExpanded, providerOpen],
  );
  const accountTriggerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.sidebarAccountTrigger,
      accountLocked && styles.sidebarAccountTriggerLocked,
      (hovered || pressed || accountOpen) && styles.sidebarProviderTriggerActive,
    ],
    [accountLocked, accountOpen],
  );
  const handleProviderSelect = useCallback(
    (providerId: string) => {
      const target = providers.find((provider) => provider.id === providerId);
      const model = target
        ? resolveProviderSwitchModel(target, rememberedModelByProviderRef.current.get(providerId))
        : null;
      if (!model) return;
      void controls.models.select(model.provider, model.modelId);
      setProviderOpen(false);
    },
    [controls, providers, rememberedModelByProviderRef],
  );
  const handleAccountSelect = useCallback(
    (credentialId: string) => {
      if (controls.isRunning || !controls.features.set || accountFeature?.type !== "select") {
        return;
      }
      void controls.features.set(accountFeature.id, credentialId);
      setAccountOpen(false);
    },
    [accountFeature, controls],
  );
  const renderAccountOption = useCallback(
    ({
      option,
      selected,
      active: optionActive,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => (
      <View>
        <ComboboxItem
          label={option.label}
          description={option.description}
          selected={selected}
          active={optionActive}
          onPress={onPress}
          testID={`sidebar-account-option-${option.id}`}
        />
        {option.id === accountSelection?.automaticOptionId ? (
          <View
            style={styles.sidebarAccountOptionDivider}
            testID="sidebar-account-option-divider"
          />
        ) : null}
      </View>
    ),
    [accountSelection?.automaticOptionId],
  );
  const handleProviderToggle = useCallback(() => {
    setProviderOpen((open) => !open);
  }, []);
  const handleAccountToggle = useCallback(() => {
    if (controls.isRunning) return;
    setAccountOpen((open) => !open);
  }, [controls.isRunning]);
  useEffect(() => {
    setProviderOpen(false);
    if (controls.isRunning || !detailsExpanded) setAccountOpen(false);
  }, [controls.isRunning, detailsExpanded]);

  const accountSwitchHint = t("agentControls.quota.switchAfterTurn");
  const selector =
    providers.length === 0 ? null : (
      <SidebarProviderSelector
        compact={!detailsExpanded}
        anchorRef={providerAnchorRef}
        canSwitch={canSwitchProvider}
        onToggle={handleProviderToggle}
        triggerStyle={providerTriggerStyle}
        label={selectedProvider?.label ?? t("agentControls.provider.fallback")}
        theme={theme}
        options={providerOptions}
        value={selectedProviderId}
        onSelect={handleProviderSelect}
        open={providerOpen}
        onOpenChange={setProviderOpen}
      />
    );

  return (
    <View style={styles.sidebarFooterPanel} testID="sidebar-provider-account-panel">
      {detailsExpanded && selector ? (
        <View style={styles.sidebarProviderCard}>
          {selector}
          <SidebarProviderAccountDetails
            visible
            showProviderUsage={showProviderUsage}
            selectedProviderUsageId={selectedProviderUsageId}
            providerUsageView={providerUsageView}
            showAccountLoading={showAccountLoading}
            showAccountSelector={showAccountSelector}
            accountLocked={accountLocked}
            accountSwitchHint={accountSwitchHint}
            accountAnchorRef={accountAnchorRef}
            hasAccountSwitcher={hasAccountSwitcher}
            onAccountToggle={handleAccountToggle}
            accountAccessibilityState={accountAccessibilityState}
            accountTriggerStyle={accountTriggerStyle}
            accountPrimary={accountPrimary}
            accountSecondary={accountSecondary}
            canSwitchAccount={canSwitchAccount}
            theme={theme}
            accountOptions={accountOptions}
            accountValue={accountSelection?.configuredValue ?? ""}
            onAccountSelect={handleAccountSelect}
            renderAccountOption={renderAccountOption}
            accountOpen={accountOpen}
            onAccountOpenChange={setAccountOpen}
            selectedAccount={selectedAccount}
          />
        </View>
      ) : null}
      <View style={[styles.footerIconRow, styles.footerIconRowInPanel]}>
        {children}
        <View style={styles.footerCollapseSlot}>
          {!detailsExpanded ? selector : null}
          <FooterIconButton
            onPress={onToggleDetails}
            testID="sidebar-provider-panel-toggle"
            label={detailsToggleLabel}
            icon={detailsExpanded ? ChevronDown : ChevronUp}
            expanded={detailsExpanded}
            theme={theme}
          />
        </View>
      </View>
    </View>
  );
}

function SidebarFooter({
  theme,
  handleHome,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
}: {
  theme: SidebarTheme;
  handleHome: () => void;
  handleSettings: () => void;
  labels: {
    hosts: string;
    home: string;
    settings: string;
  };
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
}) {
  const { t } = useTranslation();
  const settingsKeys = useShortcutKeys("toggle-settings");
  const active = useActiveAgentControls();
  const lastActiveRef = useRef(active);
  if (active) lastActiveRef.current = active;
  const visibleActive = active ?? lastActiveRef.current;
  const [providerPanelExpanded, setProviderPanelExpanded] = useState(false);
  const toggleProviderPanel = useCallback(
    () => setProviderPanelExpanded((expanded) => !expanded),
    [],
  );
  const providerPanelToggleLabel = providerPanelExpanded
    ? t("providerUsage.collapseDetails")
    : t("providerUsage.expandDetails");

  const footerIcons = (
    <>
      <SidebarHostPicker
        theme={theme}
        label={labels.hosts}
        onAddHost={handleAddHost}
        onOpenHostSettings={handleOpenHostSettings}
      />
      <FooterIconButton
        onPress={handleHome}
        testID="sidebar-home"
        label={labels.home}
        icon={Home}
        theme={theme}
      />
      <FooterIconButton
        onPress={handleSettings}
        testID="sidebar-settings"
        label={labels.settings}
        icon={Settings}
        shortcutKeys={settingsKeys}
        theme={theme}
      />
    </>
  );

  return (
    <View style={styles.sidebarFooter}>
      {visibleActive ? (
        <SidebarProviderAccountPanel
          controls={visibleActive.controls}
          detailsExpanded={providerPanelExpanded}
          onToggleDetails={toggleProviderPanel}
          detailsToggleLabel={providerPanelToggleLabel}
        >
          {footerIcons}
        </SidebarProviderAccountPanel>
      ) : (
        <View style={styles.footerIconRow}>{footerIcons}</View>
      )}
    </View>
  );
}

function MobileSidebar({
  theme,
  workspaceGroups,
  projectIconTargets,
  projects,
  hasProjectsBeforeFilter,
  hasHiddenProjects,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  newWorkspaceKeys,
  handleOpenProject,
  handleOpenImportSession,
  handleHome,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  insetsTop,
  insetsBottom,
  closeSidebar,
  handleViewMoreNavigate,
  handleViewSchedulesNavigate,
}: MobileSidebarProps) {
  const pathname = usePathname();
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const isSessionsActive = pathname.includes("/sessions");
  const isSchedulesActive = pathname.includes("/schedules");
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture();
  const dragGestureHostPresented = useIsMobilePanelPresented("agent-list");

  const handleViewMore = useCallback(() => {
    closeSidebar();
    handleViewMoreNavigate();
  }, [closeSidebar, handleViewMoreNavigate]);

  const handleViewSchedules = useCallback(() => {
    closeSidebar();
    handleViewSchedulesNavigate();
  }, [closeSidebar, handleViewSchedulesNavigate]);

  const handleWorkspacePress = useCallback(() => {
    closeSidebar();
  }, [closeSidebar]);

  const mobileSidebarInsetStyle = useMemo(
    () => ({
      paddingTop: insetsTop,
      paddingBottom: insetsBottom,
      backgroundColor: theme.colors.surfaceSidebar,
    }),
    [insetsTop, insetsBottom, theme.colors.surfaceSidebar],
  );

  return (
    <MobilePanelOverlay
      panel="agent-list"
      closeGesture={closeGesture}
      panelStyle={mobileSidebarInsetStyle}
    >
      <View style={styles.sidebarContent} pointerEvents="auto">
        <WindowChromeSafeArea placement="below" />
        <View style={styles.sidebarHeaderGroup}>
          <SidebarNewWorkspaceHeaderRow
            label={labels.newWorkspace}
            testID="sidebar-global-new-workspace"
            variant="compact"
            shortcutKeys={newWorkspaceKeys}
            onPress={handleOpenProject}
          />
          <SidebarHeaderRow
            icon={ImportIcon}
            label={labels.importSession}
            onPress={handleOpenImportSession}
            testID="sidebar-import-session"
            variant="compact"
          />
          <SidebarHeaderRow
            icon={History}
            label={labels.sessions}
            onPress={handleViewMore}
            isActive={isSessionsActive}
            testID="sidebar-sessions"
            variant="compact"
          />
          <SidebarHeaderRow
            icon={CalendarClock}
            label={labels.schedules}
            onPress={handleViewSchedules}
            isActive={isSchedulesActive}
            testID="sidebar-schedules"
            variant="compact"
          />
        </View>
        <WindowChromeSafeArea placement="inline" style={styles.mobileCloseButtonRow}>
          <Pressable
            style={styles.mobileCloseButton}
            onPress={closeSidebar}
            testID="sidebar-close"
            nativeID="sidebar-close"
            accessible
            accessibilityRole="button"
            accessibilityLabel={labels.closeSidebar}
            hitSlop={8}
          >
            {({ hovered, pressed }) => (
              <X
                size={theme.iconSize.md}
                color={hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        </WindowChromeSafeArea>

        {isInitialLoad && !hasActiveHostFilter ? (
          <SidebarAgentListSkeleton />
        ) : (
          <SidebarWorkspaceList
            collapsedProjectKeys={collapsedProjectKeys}
            onToggleProjectCollapsed={toggleProjectCollapsed}
            shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
            groupMode={groupMode}
            workspaceGroups={workspaceGroups}
            projectIconTargets={projectIconTargets}
            projects={projects}
            hasProjectsBeforeFilter={hasProjectsBeforeFilter}
            hasHiddenProjects={hasHiddenProjects}
            workspaceEntriesByKey={workspaceEntriesByKey}
            isRefreshing={isManualRefresh && isRevalidating}
            onRefresh={handleRefresh}
            onWorkspacePress={handleWorkspacePress}
            parentGestureRef={closeGestureRef}
            dragGestureHostPresented={dragGestureHostPresented}
            listHeaderComponent={workspacesSectionHeaderElement}
          />
        )}

        <SidebarFooter
          theme={theme}
          handleHome={handleHome}
          handleSettings={handleSettings}
          labels={labels}
          handleAddHost={handleAddHost}
          handleOpenHostSettings={handleOpenHostSettings}
        />
      </View>
    </MobilePanelOverlay>
  );
}

function DesktopSidebar({
  theme,
  workspaceGroups,
  projectIconTargets,
  projects,
  hasProjectsBeforeFilter,
  hasHiddenProjects,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  newWorkspaceKeys,
  handleOpenProject,
  handleOpenImportSession,
  handleHome,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  insetsTop,
  active,
  localServerId,
  openLocalProject,
  handleViewMore,
  handleViewSchedules,
}: DesktopSidebarProps) {
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const pathname = usePathname();
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const isSessionsActive = pathname.includes("/sessions");
  const isSchedulesActive = pathname.includes("/schedules");
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const visibleSidebarWidth = resolveDesktopSidebarWidth({
    requestedWidth: sidebarWidth,
    viewportWidth,
  });

  const startWidthRef = useRef(visibleSidebarWidth);
  const resizeWidth = useSharedValue(visibleSidebarWidth);
  const [resizePressed, setResizePressed] = useState(false);
  const showResizeGrip = useCallback(() => setResizePressed(true), []);
  const hideResizeGrip = useCallback(() => setResizePressed(false), []);

  useEffect(() => {
    resizeWidth.value = visibleSidebarWidth;
  }, [resizeWidth, visibleSidebarWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onBegin(() => {
          scheduleOnRN(showResizeGrip);
        })
        // Horizontal intent only, so a finger dragging down the touch grip scrolls
        // the workspace list instead of resizing. Anchoring the start width to the
        // activation translation keeps the extra threshold from jumping the edge.
        .activeOffsetX([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetY([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onStart((event) => {
          startWidthRef.current = visibleSidebarWidth - event.translationX;
          resizeWidth.value = visibleSidebarWidth;
        })
        .onUpdate((event) => {
          // Dragging right (positive translationX) increases width
          const newWidth = startWidthRef.current + event.translationX;
          resizeWidth.value = resolveDesktopSidebarWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setSidebarWidth)(resizeWidth.value);
        })
        .onFinalize(() => {
          scheduleOnRN(hideResizeGrip);
        }),
    [
      hideResizeGrip,
      resizeWidth,
      setSidebarWidth,
      showResizeGrip,
      viewportWidth,
      visibleSidebarWidth,
    ],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  const desktopSidebarStyle = useMemo(
    () => [
      staticStyles.desktopSidebar,
      !active && staticStyles.desktopSidebarHidden,
      resizeAnimatedStyle,
    ],
    [active, resizeAnimatedStyle],
  );
  const desktopSidebarBorderStyle = useMemo(
    () => [styles.desktopSidebarBorder, { flex: 1, paddingTop: insetsTop }],
    [insetsTop],
  );
  const sidebarHeaderGroupStyle = useMemo(
    () => [styles.sidebarHeaderGroup, ownsTopLeft && styles.sidebarHeaderGroupBelowChrome],
    [ownsTopLeft],
  );
  return (
    <Animated.View
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      pointerEvents={active ? "auto" : "none"}
      style={desktopSidebarStyle}
    >
      <SidebarProjectDropZone
        disabled={!active}
        localServerId={localServerId}
        hint={labels.projectDropHint}
        failedMessage={labels.projectDropFailed}
        openProject={openLocalProject}
        style={desktopSidebarBorderStyle}
      >
        <View style={styles.sidebarDragArea}>
          {ownsTopLeft || DEV_BUILD_LABEL ? (
            <View style={styles.desktopChromeRow}>
              <TitlebarDragRegion />
              {DEV_BUILD_LABEL ? (
                <View
                  pointerEvents="none"
                  style={styles.devBuildBadge}
                  testID="dev-build-label"
                  accessibilityLabel={`Development build: ${DEV_BUILD_LABEL}`}
                >
                  <GitBranch size={12} color={theme.colors.accentForeground} />
                  <Text numberOfLines={1} ellipsizeMode="tail" style={styles.devBuildBadgeText}>
                    {DEV_BUILD_LABEL}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : (
            <TitlebarDragRegion />
          )}
          <View style={sidebarHeaderGroupStyle}>
            <SidebarNewWorkspaceHeaderRow
              label={labels.newWorkspace}
              testID="sidebar-global-new-workspace"
              variant="compact"
              shortcutKeys={newWorkspaceKeys}
              onPress={handleOpenProject}
            />
            <SidebarHeaderRow
              icon={ImportIcon}
              label={labels.importSession}
              onPress={handleOpenImportSession}
              testID="sidebar-import-session"
              variant="compact"
            />
            <SidebarHeaderRow
              icon={History}
              label={labels.sessions}
              onPress={handleViewMore}
              isActive={isSessionsActive}
              testID="sidebar-sessions"
              variant="compact"
            />
            <SidebarHeaderRow
              icon={CalendarClock}
              label={labels.schedules}
              onPress={handleViewSchedules}
              isActive={isSchedulesActive}
              testID="sidebar-schedules"
              variant="compact"
            />
          </View>
        </View>

        {isInitialLoad && !hasActiveHostFilter ? (
          <SidebarAgentListSkeleton />
        ) : (
          <SidebarWorkspaceList
            collapsedProjectKeys={collapsedProjectKeys}
            onToggleProjectCollapsed={toggleProjectCollapsed}
            shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
            groupMode={groupMode}
            workspaceGroups={workspaceGroups}
            projectIconTargets={projectIconTargets}
            projects={projects}
            hasProjectsBeforeFilter={hasProjectsBeforeFilter}
            hasHiddenProjects={hasHiddenProjects}
            workspaceEntriesByKey={workspaceEntriesByKey}
            isRefreshing={isManualRefresh && isRevalidating}
            onRefresh={handleRefresh}
            listHeaderComponent={workspacesSectionHeaderElement}
          />
        )}

        <SidebarCalloutSlot />

        <SidebarFooter
          theme={theme}
          handleHome={handleHome}
          handleSettings={handleSettings}
          labels={labels}
          handleAddHost={handleAddHost}
          handleOpenHostSettings={handleOpenHostSettings}
        />

        <SidebarResizeHandle
          edge="right"
          gesture={resizeGesture}
          pressed={resizePressed}
          testID="left-sidebar-resize-handle"
        />
      </SidebarProjectDropZone>
    </Animated.View>
  );
}

function WorkspacesSectionHeader() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const commandCenterKeys = useShortcutKeys("toggle-command-center");
  const handleSearchPress = useCallback(() => setCommandCenterOpen(true), [setCommandCenterOpen]);
  const searchButtonStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.workspacesHeaderIconButton,
      (hovered || pressed) && styles.workspacesHeaderIconButtonHovered,
    ],
    [],
  );

  return (
    <View style={styles.workspacesSectionHeader}>
      <Text style={styles.workspacesSectionTitle}>{t("sidebar.sections.workspaces")}</Text>
      <View style={styles.workspacesSectionActions}>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open command center"
              testID="sidebar-command-center-search"
              style={searchButtonStyle}
              onPress={handleSearchPress}
            >
              {({ hovered, pressed }) => (
                <Search
                  size={14}
                  color={
                    hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted
                  }
                />
              )}
            </Pressable>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <IconTooltipContent label="Search" shortcutKeys={commandCenterKeys} />
          </TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <View>
              <SidebarDisplayPreferencesMenu />
            </View>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <IconTooltipContent label="Display preferences" />
          </TooltipContent>
        </Tooltip>
      </View>
    </View>
  );
}

// Stable element so the sidebar list's listHeaderComponent prop keeps identity across
// renders (WorkspacesSectionHeader takes no props).
const workspacesSectionHeaderElement = <WorkspacesSectionHeader />;

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
  },
  desktopSidebarHidden: {
    display: "none",
  },
});

const styles = StyleSheet.create((theme) => ({
  sidebarHeaderGroup: {
    paddingTop: theme.spacing[2],
    gap: 0,
    paddingBottom: theme.spacing[2],
    userSelect: "none",
  },
  sidebarHeaderGroupBelowChrome: {
    paddingTop: 0,
  },
  workspacesSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    // Rendered inside the scroll's listContent (paddingHorizontal spacing[2]). The title
    // lands at spacing[2] left to align with project icons. Settings2's painted path stops
    // inside its 14px SVG, so 4px aligns the ink rather than the SVG box to the row rail.
    paddingLeft: theme.spacing[2],
    paddingRight: 4,
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  workspacesSectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  workspacesSectionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  workspacesHeaderIconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  workspacesHeaderIconButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  mobileCloseButtonRow: {
    position: "absolute",
    top: theme.spacing[3],
    left: 0,
    right: 0,
    zIndex: 2,
    alignItems: "flex-end",
    pointerEvents: "box-none",
  },
  mobileCloseButton: {
    // The 16px X paints farther inside its 32px hit target than the 14px Settings2 glyph.
    // This optical inset puts their painted right edges on the same sidebar rail.
    marginRight: theme.spacing[2] + 1.5,
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  desktopSidebarBorder: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  sidebarDragArea: {
    position: "relative",
  },
  desktopChromeRow: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
  devBuildBadge: {
    maxWidth: "60%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  devBuildBadgeText: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  sidebarFooter: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  sidebarFooterPanel: {
    width: "100%",
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  footerIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  footerIconRowInPanel: {
    padding: theme.spacing[1],
  },
  footerCollapseSlot: {
    marginLeft: "auto",
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    gap: theme.spacing[1],
  },
  footerProviderSelector: {
    minWidth: 0,
    flexShrink: 1,
    maxWidth: 148,
  },
  sidebarProviderCard: {
    width: "100%",
    padding: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  sidebarProviderTrigger: {
    minWidth: 0,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  sidebarProviderTriggerCompact: {
    minWidth: 0,
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  sidebarProviderTriggerActive: {
    backgroundColor: theme.colors.surfaceSidebarSelected,
  },
  sidebarProviderCopy: {
    minWidth: 0,
    flex: 1,
  },
  sidebarProviderCopyCompact: {
    minWidth: 0,
    flexShrink: 1,
  },
  sidebarProviderName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  sidebarProviderDivider: {
    height: 1,
    marginHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.border,
  },
  sidebarAccountTrigger: {
    minWidth: 0,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  sidebarAccountTriggerLocked: {
    width: "100%",
  },
  sidebarAccountTriggerContainer: {
    alignSelf: "stretch",
  },
  sidebarAccountLock: {
    width: 14,
    marginLeft: "auto",
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  sidebarAccountCopy: {
    minWidth: 0,
    flex: 1,
    gap: 1,
  },
  sidebarAccountName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  sidebarAccountSecondary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sidebarAccountOptionDivider: {
    height: 1,
    marginHorizontal: theme.spacing[2],
    marginVertical: theme.spacing[1],
    backgroundColor: theme.colors.borderAccent,
  },
  sidebarAccountLoading: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  sidebarQuota: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  sidebarQuotaMeter: {
    gap: theme.spacing[1],
  },
  sidebarQuotaHeader: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  sidebarQuotaLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sidebarQuotaPercentage: {
    flexShrink: 0,
    textAlign: "right",
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  sidebarQuotaTrack: {
    height: 4,
    overflow: "hidden",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.border,
  },
  sidebarQuotaFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
  },
  sidebarQuotaLoading: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footerIconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
