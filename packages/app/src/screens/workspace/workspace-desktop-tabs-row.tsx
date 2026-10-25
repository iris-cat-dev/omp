import { LoadingSpinner } from "@/components/ui/loading-spinner";
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  Pressable,
  Text,
  View,
  type LayoutChangeEvent,
  type PressableStateCallbackType,
} from "react-native";
import {
  CopyX,
  ArrowLeftToLine,
  ArrowRightToLine,
  Copy,
  FolderTree,
  Pencil,
  Plus,
  RotateCw,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  X,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type AnimatedStyle,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { SortableInlineList } from "@/components/sortable-inline-list";
import type {
  DraggableListDragHandleProps,
  DraggableRenderItemInfo,
} from "@/components/draggable-list.types";
import { TITLEBAR_DRAG_REGION_DATASET } from "@/components/desktop/titlebar-drag-region";
import { isNative, isWeb } from "@/constants/platform";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  useContextMenu,
} from "@/components/ui/context-menu";
import { measureElement } from "@/components/ui/menu/menu-anchor";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useShowPersistentActions } from "@/hooks/use-fine-pointer";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import { useWorkspaceTabLayout } from "@/screens/workspace/use-workspace-tab-layout";
import {
  resolveMeasuredWorkspaceTabs,
  retainWorkspaceTabMeasuredWidth,
} from "@/screens/workspace/workspace-tab-layout";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import {
  buildWorkspaceDesktopTabActions,
  type WorkspaceDesktopTabActions,
  type WorkspaceTabMenuEntry,
  type WorkspaceTabMenuLabels,
} from "@/screens/workspace/workspace-tab-menu";
import { openTabInSidePanel } from "@/workspace-tabs/side-panel";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";
import { buildWorkspaceExplorerStateKey } from "@/file-explorer/state-key";
import { resolveProjectLayoutKey } from "@/workspace-tabs/project-scope";
import { usePanelStore } from "@/stores/panel-store";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import type { Theme } from "@/styles/theme";
import { RenderProfile } from "@/utils/render-profiler";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { buildWorkspaceKeyboardHandlerId } from "@/keyboard/handler-id";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import { OpenInFileManagerMenuItem } from "@/workspace/open-in-file-manager/menu-item";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useNewTabLauncher } from "@/workspace-tabs/launcher";

const DROPDOWN_WIDTH = 220;
// Keep the strip's rendered geometry and its overflow measurements in sync.
const TAB_CHIP_HORIZONTAL_PADDING = 12;
const TAB_CHIP_GAP = 0;
const TAB_ROW_PADDING_HORIZONTAL = 0;
const TAB_ICON_WIDTH = 14;
const TAB_CONTENT_GAP = 8;
const TAB_DROP_INDICATOR_WIDTH = 4;
const TAB_MODIFIED_DOT_SIZE = 8;
const TAB_MIN_WIDTH = 120;
const TAB_MAX_WIDTH = 240;
const TAB_CLOSE_BUTTON_RESERVED_WIDTH = 24;
const TAB_LABEL_LAYOUT_ALLOWANCE = 4;
const TAB_SCROLL_SHADE_WIDTH = 24;
const TAB_SCROLL_EDGE_EPSILON = 1;

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedX = withUnistyles(X);
const ThemedPlus = withUnistyles(Plus);
const ThemedCopy = withUnistyles(Copy);
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);

function WorkspaceTabScrollShadeSvg({ side, color }: { side: "left" | "right"; color: string }) {
  const gradientId = `workspace-tab-scroll-shade-${side}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <Svg width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient
          id={gradientId}
          x1={side === "left" ? "100%" : "0%"}
          y1="0%"
          x2={side === "left" ? "0%" : "100%"}
          y2="0%"
        >
          <Stop offset="0%" stopColor={color} stopOpacity={0} />
          <Stop offset="100%" stopColor={color} stopOpacity={1} />
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
    </Svg>
  );
}

const ThemedWorkspaceTabScrollShadeSvg = withUnistyles(WorkspaceTabScrollShadeSvg);
const tabScrollShadeColorMapping = (theme: Theme) => ({ color: theme.colors.surfaceSidebar });

function WorkspaceTabScrollShades({
  visible,
  leftStyle,
  rightStyle,
}: {
  visible: boolean;
  leftStyle: AnimatedStyle<{ opacity: number }>;
  rightStyle: AnimatedStyle<{ opacity: number }>;
}) {
  if (!visible) return null;

  return (
    <>
      <Animated.View
        pointerEvents="none"
        testID="workspace-tabs-scroll-shade-left"
        style={[styles.tabScrollShade, styles.tabScrollShadeLeft, leftStyle]}
      >
        <ThemedWorkspaceTabScrollShadeSvg side="left" uniProps={tabScrollShadeColorMapping} />
      </Animated.View>
      <Animated.View
        pointerEvents="none"
        testID="workspace-tabs-scroll-shade-right"
        style={[styles.tabScrollShade, styles.tabScrollShadeRight, rightStyle]}
      >
        <ThemedWorkspaceTabScrollShadeSvg side="right" uniProps={tabScrollShadeColorMapping} />
      </Animated.View>
    </>
  );
}

const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedArrowLeftToLine = withUnistyles(ArrowLeftToLine);
const ThemedArrowRightToLine = withUnistyles(ArrowRightToLine);
const ThemedCopyX = withUnistyles(CopyX);
const ThemedPencil = withUnistyles(Pencil);
const ThemedMaximize2 = withUnistyles(Maximize2);
const ThemedMinimize2 = withUnistyles(Minimize2);
const ThemedFolderTree = withUnistyles(FolderTree);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

function inlineAddActionButtonStyle({
  hovered,
  pressed,
  open = false,
}: PressableStateCallbackType & { open?: boolean }) {
  return [
    styles.inlineAddActionButton,
    (hovered || pressed || open) && styles.newTabActionButtonHovered,
  ];
}

function updateMeasuredWidth(
  setWidth: React.Dispatch<React.SetStateAction<number>>,
  event: LayoutChangeEvent,
) {
  const nextWidth = Math.round(event.nativeEvent.layout.width);
  setWidth((current) => retainWorkspaceTabMeasuredWidth(current, nextWidth));
}

function TabLabelMeasurement({
  tabKey,
  label,
  onMeasure,
}: {
  tabKey: string;
  label: string;
  onMeasure: (tabKey: string, label: string, event: LayoutChangeEvent) => void;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onMeasure(tabKey, label, event),
    [label, onMeasure, tabKey],
  );

  return (
    <Text
      style={[styles.tabLabel, styles.tabLabelMeasurement]}
      numberOfLines={1}
      onLayout={handleLayout}
    >
      {label}
    </Text>
  );
}

function WorkspaceNewTerminalButton({
  paneId,
  onLayout,
}: {
  paneId?: string;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  const launcher = useNewTabLauncher();
  const label = t("workspace.tabs.actions.newTerminal");
  const handlePress = useCallback(() => {
    if (launcher.terminalDisabled) return;
    launcher.launch({ kind: "terminal" }, { kind: "open", paneId });
  }, [launcher, paneId]);

  return (
    <View style={styles.inlineAddButton} onLayout={onLayout}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          testID="workspace-new-terminal"
          accessibilityRole="button"
          accessibilityLabel={label}
          disabled={launcher.terminalDisabled}
          onPress={handlePress}
          style={inlineAddActionButtonStyle}
        >
          <ThemedPlus size={14} uniProps={extraMutedColorMapping} />
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <Text style={styles.newTabTooltipText}>{label}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

function WorkspacePaneMaximizeButton({
  visible,
  maximized,
  onPress,
  onLayout,
}: {
  visible: boolean;
  maximized: boolean;
  onPress?: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  const maximizePaneKeys = useShortcutKeys("workspace-explorer-maximize");
  if (!visible || !onPress) {
    return null;
  }
  const label = t(
    maximized ? "workspace.tabs.actions.restorePane" : "workspace.tabs.actions.maximizePane",
  );

  return (
    <View style={[styles.inlineAddButton, styles.paneMaximizeButtonSlot]} onLayout={onLayout}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          testID={maximized ? "workspace-restore-pane" : "workspace-maximize-pane"}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={label}
          style={inlineAddActionButtonStyle}
        >
          {maximized ? (
            <ThemedMinimize2 size={14} uniProps={extraMutedColorMapping} />
          ) : (
            <ThemedMaximize2 size={14} uniProps={extraMutedColorMapping} />
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <View style={styles.newTabTooltipRow}>
            <Text style={styles.newTabTooltipText}>{label}</Text>
            {maximizePaneKeys ? <Shortcut chord={maximizePaneKeys} /> : null}
          </View>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

function WorkspaceExitFocusModeButton({
  visible,
  onPress,
  onLayout,
}: {
  visible: boolean;
  onPress: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  const focusModeKeys = useShortcutKeys("toggle-focus");
  if (!visible) {
    return null;
  }

  return (
    <View style={styles.exitFocusModeSlot} onLayout={onLayout}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger
          testID="workspace-exit-focus-mode"
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={t("workspace.tabs.actions.exitFocusMode")}
          style={inlineAddActionButtonStyle}
        >
          <ThemedX size={14} uniProps={mutedColorMapping} />
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <View style={styles.newTabTooltipRow}>
            <Text style={styles.newTabTooltipText}>
              {t("workspace.tabs.actions.exitFocusMode")}
            </Text>
            {focusModeKeys ? (
              <Shortcut chord={focusModeKeys} style={styles.newTabTooltipShortcut} />
            ) : null}
          </View>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

function resolvePaneMaximizeReservedWidth(visible: boolean, measuredWidth: number): number {
  return visible ? measuredWidth : 0;
}

function TabContextMenuItem({
  entry,
}: {
  entry: Extract<WorkspaceTabMenuEntry, { kind: "item" }>;
}) {
  const leading = useMemo(() => {
    switch (entry.icon) {
      case "copy":
        return <ThemedCopy size={16} uniProps={mutedColorMapping} />;
      case "folder-tree":
        return <ThemedFolderTree size={16} uniProps={mutedColorMapping} />;
      case "rotate-cw":
        return <ThemedRotateCw size={16} uniProps={mutedColorMapping} />;
      case "arrow-left-to-line":
        return <ThemedArrowLeftToLine size={16} uniProps={mutedColorMapping} />;
      case "arrow-right-to-line":
        return <ThemedArrowRightToLine size={16} uniProps={mutedColorMapping} />;
      case "copy-x":
        return <ThemedCopyX size={16} uniProps={mutedColorMapping} />;
      case "pencil":
        return <ThemedPencil size={16} uniProps={mutedColorMapping} />;
      case "x":
        return <ThemedX size={16} uniProps={mutedColorMapping} />;
      default:
        return undefined;
    }
  }, [entry.icon]);
  const trailing = useMemo(
    () => (entry.hint ? <Text style={styles.menuItemHint}>{entry.hint}</Text> : undefined),
    [entry.hint],
  );
  return (
    <ContextMenuItem
      testID={entry.testID}
      disabled={entry.disabled}
      destructive={entry.destructive}
      onSelect={entry.onSelect}
      tooltip={entry.tooltip}
      leading={leading}
      trailing={trailing}
    >
      {entry.label}
    </ContextMenuItem>
  );
}

function tabKeyExtractor(tab: WorkspaceDesktopTabRowItem) {
  return `${tab.tab.key}:${tab.tab.kind}`;
}

export interface WorkspaceDesktopTabRowItem {
  tab: WorkspaceTabDescriptor;
  isActive: boolean;
  isCloseHovered: boolean;
  isClosingTab: boolean;
  /** Static surfaces can provide their own presentation without mounting a panel resolver. */
  presentation?: WorkspaceTabPresentation;
}

interface ResolvedWorkspaceDesktopTabRowItem extends WorkspaceDesktopTabRowItem {
  presentation: WorkspaceTabPresentation;
}

interface WorkspaceTabLabel {
  key: string;
  label: string;
  modified: boolean;
}

interface WorkspaceTabLabelMeasurement {
  label: string;
  width: number;
}

interface WorkspaceTabTrackSnapshot {
  signature: string;
  tabs: ResolvedWorkspaceDesktopTabRowItem[];
  labels: WorkspaceTabLabel[];
  labelWidths: number[];
}

function workspaceTabLabelSignature(labels: WorkspaceTabLabel[]): string {
  return JSON.stringify(labels);
}

function completeWorkspaceTabLabelWidths(
  labels: WorkspaceTabLabel[],
  measurements: Map<string, WorkspaceTabLabelMeasurement>,
): number[] | null {
  const widths: number[] = [];
  for (const { key, label, modified } of labels) {
    const measurement = measurements.get(key);
    if (!measurement || measurement.label !== label || measurement.width <= 0) {
      return null;
    }
    // The modified dot sits in the content row, so a modified tab needs that much more width
    // before its label starts truncating.
    const modifiedAllowance = modified ? TAB_CONTENT_GAP + TAB_MODIFIED_DOT_SIZE : 0;
    widths.push(measurement.width + TAB_LABEL_LAYOUT_ALLOWANCE + modifiedAllowance);
  }
  return widths;
}

function sameWidths(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((width, index) => width === right[index]);
}

interface WorkspaceDesktopTabsRowProps {
  paneId?: string;
  isFocused?: boolean;
  newTabShortcutEnabled?: boolean;
  tabs: WorkspaceDesktopTabRowItem[];
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTabsToLeft: (tabId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
  onCreateNewTab: (input: { paneId?: string }) => void;
  onReorderTabs: (nextTabs: WorkspaceTabDescriptor[]) => void;
  externalDndContext?: boolean;
  activeDragTabId?: string | null;
  tabDropPreviewIndex?: number | null;
  showNewTerminalAction?: boolean;
  showPaneMaximizeAction?: boolean;
  paneMaximized?: boolean;
  onTogglePaneMaximized?: () => void;
  focusModeEnabled: boolean;
  onExitFocusMode: () => void;
}

interface ResolvedWorkspaceDesktopTabsRowProps extends Omit<WorkspaceDesktopTabsRowProps, "tabs"> {
  tabs: ResolvedWorkspaceDesktopTabRowItem[];
}

interface WorkspaceDesktopTabPresentationSlotProps {
  tab: WorkspaceTabDescriptor;
  serverId: string;
  workspaceId: string;
  onResolve: (tabKey: string, presentation: WorkspaceTabPresentation) => void;
}

const EMPTY_RESOLVED_TAB_ROWS: ResolvedWorkspaceDesktopTabRowItem[] = [];

function WorkspaceDesktopTabPresentationSlot({
  tab,
  serverId,
  workspaceId,
  onResolve,
}: WorkspaceDesktopTabPresentationSlotProps) {
  return (
    <WorkspaceTabPresentationResolver tab={tab} serverId={serverId} workspaceId={workspaceId}>
      {(presentation) => (
        <WorkspaceDesktopTabPresentationCommit
          tabKey={tab.key}
          presentation={presentation}
          onResolve={onResolve}
        />
      )}
    </WorkspaceTabPresentationResolver>
  );
}

function WorkspaceDesktopTabPresentationCommit({
  tabKey,
  presentation,
  onResolve,
}: {
  tabKey: string;
  presentation: WorkspaceTabPresentation;
  onResolve: (tabKey: string, presentation: WorkspaceTabPresentation) => void;
}) {
  useLayoutEffect(() => {
    onResolve(tabKey, presentation);
  }, [onResolve, presentation, tabKey]);
  return null;
}

function getFallbackTabLabel(
  tab: WorkspaceTabDescriptor,
  labels: {
    newTab: string;
    newAgent: string;
    setup: string;
    workspace: string;
    terminal: string;
    agent: string;
    changes: string;
    files: string;
    pullRequest: string;
  },
): string {
  if (tab.target.kind === "new_tab") {
    return labels.newTab;
  }
  if (tab.target.kind === "draft") {
    return labels.newAgent;
  }
  if (tab.target.kind === "setup") {
    return labels.setup;
  }
  if (tab.target.kind === "workspace_overview") {
    return labels.workspace;
  }
  if (tab.target.kind === "terminal" || tab.target.kind === "background_process") {
    return labels.terminal;
  }
  if (tab.target.kind === "file") {
    return tab.target.path.split("/").findLast(Boolean) ?? tab.target.path;
  }
  if (tab.target.kind === "local_file") {
    return tab.target.name;
  }
  if (tab.target.kind === "working_diff") {
    const path = tab.target.focusPath;
    return path ? (path.split("/").findLast(Boolean) ?? path) : labels.changes;
  }
  if (tab.target.kind === "files") {
    return labels.files;
  }
  if (tab.target.kind === "pull_request") {
    return labels.pullRequest;
  }
  return labels.agent;
}

function useMiddleClickClose(onClose: () => void) {
  const ref = useRef<View>(null);

  useEffect(() => {
    if (isNative) return;
    const node = ref.current as unknown as HTMLElement | null;
    if (!node) return;

    function handleAuxClick(event: MouseEvent) {
      if (event.button === 1) {
        event.preventDefault();
        onClose();
      }
    }

    node.addEventListener("auxclick", handleAuxClick);
    return () => node.removeEventListener("auxclick", handleAuxClick);
  }, [onClose]);

  return ref;
}

/** Match the tab fill so status rings knock out of the correct surface. */
function resolveChipBackdrop({
  isActive,
  isHovered,
}: {
  isActive: boolean;
  isHovered: boolean;
}): SurfaceBackdrop {
  if (isActive) return "surface0";
  return isHovered ? "surface1" : "surfaceSidebar";
}

function TabHandleContent({
  presentation,
  isHighlighted,
  showLabel,
  backdrop,
  tabLabelSkeletonStyle,
  tabLabelStyle,
  modifiedTestId,
}: {
  presentation: WorkspaceTabPresentation;
  isHighlighted: boolean;
  showLabel: boolean;
  backdrop: SurfaceBackdrop;
  tabLabelSkeletonStyle: React.ComponentProps<typeof View>["style"];
  tabLabelStyle: React.ComponentProps<typeof Text>["style"];
  modifiedTestId: string;
}) {
  const { t } = useTranslation();
  const tabHandleDataSet = useMemo(
    () => ({ statusBucket: presentation.statusBucket ?? "none" }),
    [presentation.statusBucket],
  );

  return (
    <View style={styles.tabHandle} dataSet={tabHandleDataSet}>
      <View style={styles.tabIcon}>
        <WorkspaceTabIcon presentation={presentation} active={isHighlighted} backdrop={backdrop} />
      </View>
      {showLabel && presentation.titleState === "loading" ? (
        <View style={tabLabelSkeletonStyle} />
      ) : null}
      {showLabel && presentation.titleState !== "loading" ? (
        <Text style={tabLabelStyle} selectable={false} numberOfLines={1} ellipsizeMode="tail">
          {presentation.label}
        </Text>
      ) : null}
      {/* The dot is a laid-out sibling of the label, not an overlay, so a truncated label ends
          before it instead of running underneath it. */}
      {presentation.modified ? (
        <View
          style={styles.tabModifiedDot}
          accessibilityLabel={t("workspace.tabs.modified")}
          testID={modifiedTestId}
        />
      ) : null}
    </View>
  );
}

function stopTabActionPropagation(event: { stopPropagation?: () => void }) {
  event.stopPropagation?.();
}

const tabActionDragBlockers = isWeb
  ? {
      onPointerDown: stopTabActionPropagation,
      onMouseDown: stopTabActionPropagation,
    }
  : undefined;

function TabMenuMoreButton({
  testID,
  dragBlockers,
}: {
  testID: string;
  dragBlockers?: {
    onPointerDown: (event: { stopPropagation?: () => void }) => void;
    onMouseDown: (event: { stopPropagation?: () => void }) => void;
  };
}) {
  const { t } = useTranslation();
  const menu = useContextMenu();
  const buttonRef = useRef<View>(null);
  const openMenu = useCallback(
    async (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      if (!buttonRef.current) return;
      const rect = await measureElement(buttonRef.current);
      menu.setAnchorRect(rect);
      menu.setOpen(true);
    },
    [menu],
  );
  const stopRowPress = useCallback((event: { stopPropagation?: () => void }) => {
    event.stopPropagation?.();
  }, []);
  const accessibilityState = useMemo(() => ({ expanded: menu.open }), [menu.open]);

  return (
    <View pointerEvents="box-none" style={styles.tabTrailingOverlay}>
      <Pressable
        {...(dragBlockers as object | undefined)}
        ref={buttonRef}
        testID={testID}
        onPressIn={stopRowPress}
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel={t("workspace.fileActions.moreActions")}
        accessibilityState={accessibilityState}
        style={styles.tabMenuButton}
      >
        <ThemedMoreHorizontal size={16} uniProps={mutedColorMapping} />
      </Pressable>
    </View>
  );
}

function TabChip({
  tab,
  isActive,
  revealWorkspacePath,
  isDragging,
  resolvedTabWidth,
  showLabel,
  showCloseButton,
  isCloseHovered,
  isClosingTab,
  presentation,
  tooltipLabel,
  resolvedTab,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  dragHandleProps,
}: {
  tab: WorkspaceTabDescriptor;
  revealWorkspacePath: string | null;
  isActive: boolean;
  isDragging: boolean;
  resolvedTabWidth: number;
  showLabel: boolean;
  showCloseButton: boolean;
  isCloseHovered: boolean;
  isClosingTab: boolean;
  presentation: WorkspaceTabPresentation;
  tooltipLabel: string;
  resolvedTab: WorkspaceDesktopTabActions;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  dragHandleProps: DraggableListDragHandleProps | undefined;
}) {
  const { t } = useTranslation();
  const showPersistentActions = useShowPersistentActions();
  const { closeButtonTestId, contextMenuTestId, menuEntries } = resolvedTab;
  const middleClickRef = useMiddleClickClose(
    useCallback(() => void onCloseTab(tab.tabId), [onCloseTab, tab.tabId]),
  );
  const [hovered, setHovered] = useState(false);
  const isHovered = hovered || isCloseHovered;
  const isHighlighted = isActive || isHovered;
  const chipBackdrop: SurfaceBackdrop = resolveChipBackdrop({
    isActive,
    isHovered,
  });
  const closeButtonDragBlockers = tabActionDragBlockers;

  const tabChipStyle = useCallback(
    () => [
      styles.tab,
      isActive && styles.tabActive,
      !isActive && isHovered && styles.tabHovered,
      isWeb && isDragging && ({ cursor: "grabbing" } as object),
      {
        minWidth: resolvedTabWidth,
        width: resolvedTabWidth,
        maxWidth: resolvedTabWidth,
      },
    ],
    [isActive, isDragging, isHovered, resolvedTabWidth],
  );

  const handleTabPointerEnter = useCallback(() => {
    setHovered(true);
  }, []);

  const handleTabPointerLeave = useCallback(() => {
    setHovered(false);
  }, []);

  const handleNavigateTab = useCallback(() => {
    onNavigateTab(tab.tabId);
  }, [onNavigateTab, tab.tabId]);

  const handleCloseButtonPressIn = useCallback((event: { stopPropagation?: () => void }) => {
    event.stopPropagation?.();
  }, []);

  const handleCloseButtonHoverIn = useCallback(() => {
    setHoveredCloseTabKey(tab.key);
  }, [setHoveredCloseTabKey, tab.key]);

  const handleCloseButtonHoverOut = useCallback(() => {
    setHoveredCloseTabKey((current) => (current === tab.key ? null : current));
  }, [setHoveredCloseTabKey, tab.key]);

  const handleCloseButtonPress = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      void onCloseTab(tab.tabId);
    },
    [onCloseTab, tab.tabId],
  );

  const tabAccessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  const testIdentity =
    tab.target.kind === "new_tab" ? tab.tabId : buildDeterministicWorkspaceTabId(tab.target);
  const tabLabelSkeletonStyle = styles.tabLabelSkeleton;
  const tabLabelStyle = useMemo(
    () => [styles.tabLabel, isHighlighted && styles.tabLabelActive],
    [isHighlighted],
  );

  return (
    <View
      ref={middleClickRef}
      style={styles.tabHoverFrame}
      onPointerEnter={handleTabPointerEnter}
      onPointerLeave={handleTabPointerLeave}
    >
      <ContextMenu key={tab.key}>
        <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
          <TooltipTrigger asChild triggerRefProp="triggerRef">
            <ContextMenuTrigger
              {...(dragHandleProps?.attributes as object | undefined)}
              {...(dragHandleProps?.listeners as object | undefined)}
              testID={`workspace-tab-${testIdentity}`}
              triggerRef={dragHandleProps?.setActivatorNodeRef as unknown as undefined}
              enabledOnMobile={false}
              style={tabChipStyle}
              onPressIn={handleNavigateTab}
              onPress={handleNavigateTab}
              accessibilityRole="button"
              accessibilityLabel={tooltipLabel}
              accessibilityState={tabAccessibilityState}
              aria-selected={isActive}
            >
              <TabHandleContent
                presentation={presentation}
                isHighlighted={isHighlighted}
                showLabel={showLabel}
                backdrop={chipBackdrop}
                tabLabelSkeletonStyle={tabLabelSkeletonStyle}
                tabLabelStyle={tabLabelStyle}
                modifiedTestId={`workspace-tab-modified-${testIdentity}`}
              />
            </ContextMenuTrigger>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="center"
            offset={8}
            maxWidth={720}
            testID={`workspace-tab-tooltip-${testIdentity}`}
          >
            {tab.target.kind === "agent" ? (
              <View style={styles.tooltipAgentRow}>
                <Text style={styles.newTabTooltipText}>{tooltipLabel}</Text>
                <Text style={styles.tooltipAgentId}>{tab.target.agentId.slice(0, 7)}</Text>
              </View>
            ) : (
              <Text style={styles.newTabTooltipText}>{tooltipLabel}</Text>
            )}
          </TooltipContent>
        </Tooltip>

        {showPersistentActions ? (
          <TabMenuMoreButton
            testID={`workspace-tab-more-${testIdentity}`}
            dragBlockers={closeButtonDragBlockers}
          />
        ) : null}
        {!showPersistentActions && showCloseButton && (isActive || isHovered || isClosingTab) ? (
          <View pointerEvents="box-none" style={styles.tabTrailingOverlay}>
            <Pressable
              {...(closeButtonDragBlockers as object | undefined)}
              testID={closeButtonTestId}
              disabled={isClosingTab}
              onPressIn={handleCloseButtonPressIn}
              onHoverIn={handleCloseButtonHoverIn}
              onHoverOut={handleCloseButtonHoverOut}
              onPress={handleCloseButtonPress}
              accessibilityRole="button"
              accessibilityLabel={t("workspace.tabs.menu.close")}
              style={styles.tabCloseButton}
            >
              {({ hovered: closeHovered, pressed }) => {
                const highlighted = closeHovered || pressed;
                if (isClosingTab) {
                  return (
                    <ThemedLoadingSpinner
                      size={12}
                      uniProps={highlighted ? foregroundColorMapping : mutedColorMapping}
                    />
                  );
                }
                return (
                  <ThemedX
                    size={12}
                    uniProps={highlighted ? foregroundColorMapping : mutedColorMapping}
                  />
                );
              }}
            </Pressable>
          </View>
        ) : null}

        <ContextMenuContent align="start" width={DROPDOWN_WIDTH} testID={contextMenuTestId}>
          {menuEntries.map((entry) =>
            entry.kind === "separator" ? (
              <ContextMenuSeparator key={entry.key} />
            ) : (
              <React.Fragment key={entry.key}>
                <TabContextMenuItem entry={entry} />
                {entry.key === "copy-file-path" && tab.target.kind === "file" ? (
                  <OpenInFileManagerMenuItem
                    surface="context"
                    path={revealWorkspacePath}
                    filePath={tab.target.path}
                    testID={`${contextMenuTestId}-reveal-file`}
                  />
                ) : null}
              </React.Fragment>
            ),
          )}
        </ContextMenuContent>
      </ContextMenu>
    </View>
  );
}

export function WorkspaceDesktopTabsRow(props: WorkspaceDesktopTabsRowProps) {
  const [presentations, setPresentations] = useState(
    () => new Map<string, WorkspaceTabPresentation>(),
  );
  const handlePresentation = useCallback(
    (tabKey: string, presentation: WorkspaceTabPresentation) => {
      setPresentations((current) => {
        if (current.get(tabKey) === presentation) {
          return current;
        }
        const next = new Map(current);
        next.set(tabKey, presentation);
        return next;
      });
    },
    [],
  );
  const currentTabKeys = useMemo(
    () => new Set(props.tabs.map((item) => item.tab.key)),
    [props.tabs],
  );
  useEffect(() => {
    setPresentations((current) => {
      const removedKeys = [...current.keys()].filter((key) => !currentTabKeys.has(key));
      if (removedKeys.length === 0) {
        return current;
      }
      const next = new Map(current);
      for (const key of removedKeys) {
        next.delete(key);
      }
      return next;
    });
  }, [currentTabKeys]);
  const resolvedTabs = useMemo(
    () =>
      props.tabs.flatMap((item) => {
        const presentation = item.presentation ?? presentations.get(item.tab.key);
        return presentation ? [{ ...item, presentation }] : [];
      }),
    [presentations, props.tabs],
  );

  return (
    <>
      <ResolvedWorkspaceDesktopTabsRow {...props} tabs={resolvedTabs} />
      {props.tabs.map((item) =>
        item.presentation ? null : (
          <WorkspaceDesktopTabPresentationSlot
            key={`${item.tab.key}:${item.tab.kind}`}
            tab={item.tab}
            serverId={props.normalizedServerId}
            workspaceId={props.normalizedWorkspaceId}
            onResolve={handlePresentation}
          />
        ),
      )}
    </>
  );
}

function ResolvedWorkspaceDesktopTabsRow({
  paneId,
  isFocused = false,
  newTabShortcutEnabled = true,
  tabs,
  normalizedServerId,
  normalizedWorkspaceId,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCreateNewTab,
  onReorderTabs,
  externalDndContext = false,
  activeDragTabId = null,
  tabDropPreviewIndex = null,
  showNewTerminalAction = false,
  showPaneMaximizeAction = false,
  paneMaximized = false,
  onTogglePaneMaximized,
  focusModeEnabled,
  onExitFocusMode,
}: ResolvedWorkspaceDesktopTabsRowProps) {
  const { t } = useTranslation();
  const isLocalDaemon = useIsLocalDaemon(normalizedServerId);
  const [tabsContainerWidth, setTabsContainerWidth] = useState<number>(0);
  const [paneMaximizeButtonWidth, setPaneMaximizeButtonWidth] = useState<number>(0);
  const [newTerminalButtonWidth, setNewTerminalButtonWidth] = useState<number>(0);
  const [, setExitFocusModeWidth] = useState<number>(0);
  const tabScrollOffset = useSharedValue(0);
  const tabScrollViewportWidth = useSharedValue(0);
  const tabScrollContentWidth = useSharedValue(0);
  const [labelMeasurements, setLabelMeasurements] = useState(
    () => new Map<string, WorkspaceTabLabelMeasurement>(),
  );
  const [trackSnapshot, setTrackSnapshot] = useState<WorkspaceTabTrackSnapshot | null>(null);

  const handleTabsContainerLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setTabsContainerWidth, event);
  }, []);

  const handleExitFocusModeLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setExitFocusModeWidth, event);
  }, []);

  const handlePaneMaximizeButtonLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setPaneMaximizeButtonWidth, event);
  }, []);

  const handleNewTerminalButtonLayout = useCallback((event: LayoutChangeEvent) => {
    updateMeasuredWidth(setNewTerminalButtonWidth, event);
  }, []);

  const handleTabScrollLayout = useCallback(
    (event: LayoutChangeEvent) => {
      tabScrollViewportWidth.value = event.nativeEvent.layout.width;
    },
    [tabScrollViewportWidth],
  );

  const handleTabScrollContentSizeChange = useCallback(
    (width: number) => {
      tabScrollContentWidth.value = width;
    },
    [tabScrollContentWidth],
  );

  const handleTabScroll = useAnimatedScrollHandler((event) => {
    tabScrollOffset.value = event.contentOffset.x;
    tabScrollViewportWidth.value = event.layoutMeasurement.width;
    tabScrollContentWidth.value = event.contentSize.width;
  });

  const leftTabScrollShadeStyle = useAnimatedStyle(() => ({
    opacity: Number(tabScrollOffset.value > TAB_SCROLL_EDGE_EPSILON),
  }));
  const rightTabScrollShadeStyle = useAnimatedStyle(() => ({
    opacity: Number(
      tabScrollOffset.value + tabScrollViewportWidth.value <
        tabScrollContentWidth.value - TAB_SCROLL_EDGE_EPSILON,
    ),
  }));

  const layoutMetrics = useMemo(
    () => ({
      rowHorizontalInset: 0,
      actionsReservedWidth:
        resolvePaneMaximizeReservedWidth(showPaneMaximizeAction, paneMaximizeButtonWidth) +
        (showNewTerminalAction ? newTerminalButtonWidth : 0),
      rowPaddingHorizontal: TAB_ROW_PADDING_HORIZONTAL,
      tabGap: TAB_CHIP_GAP,
      minTabWidth: TAB_MIN_WIDTH,
      maxTabWidth: TAB_MAX_WIDTH,
      tabIconWidth: TAB_ICON_WIDTH,
      tabContentGap: TAB_CONTENT_GAP,
      tabHorizontalPadding: TAB_CHIP_HORIZONTAL_PADDING,
      closeButtonWidth: TAB_CLOSE_BUTTON_RESERVED_WIDTH,
    }),
    [
      newTerminalButtonWidth,
      paneMaximizeButtonWidth,
      showNewTerminalAction,
      showPaneMaximizeAction,
    ],
  );

  const fallbackTabLabels = useMemo(
    () => ({
      newTab: t("workspace.tabs.actions.newTab"),
      newAgent: t("workspace.tabs.fallback.newAgent"),
      setup: t("workspace.tabs.fallback.setup"),
      workspace: t("workspace.tabs.fallback.workspace"),
      terminal: t("workspace.tabs.fallback.terminal"),
      agent: t("workspace.tabs.fallback.agent"),
      changes: t("panels.diff.changesLabel"),
      files: t("panels.files.label"),
      pullRequest: t("panels.pullRequest.label"),
    }),
    [t],
  );
  const tabMenuLabels = useMemo<WorkspaceTabMenuLabels>(
    () => ({
      copyResumeCommand: t("workspace.tabs.menu.copyResumeCommand"),
      copyAgentId: t("workspace.tabs.menu.copyAgentId"),
      copyTerminalId: t("workspace.tabs.menu.copyTerminalId"),
      copyFilePath: t("workspace.tabs.menu.copyFilePath"),
      revealInFiles: t("workspace.tabs.menu.revealInFiles"),
      revealOutsideWorkspace: t("workspace.tabs.menu.revealOutsideWorkspace"),
      rename: t("workspace.tabs.menu.rename"),
      closeAbove: t("workspace.tabs.menu.closeAbove"),
      closeBelow: t("workspace.tabs.menu.closeBelow"),
      closeLeft: t("workspace.tabs.menu.closeLeft"),
      closeRight: t("workspace.tabs.menu.closeRight"),
      closeOthers: t("workspace.tabs.menu.closeOthers"),
      reloadAgent: t("workspace.tabs.menu.reloadAgent"),
      reloadAgentTooltip: t("workspace.tabs.menu.reloadAgentTooltip"),
      close: t("workspace.tabs.menu.close"),
    }),
    [t],
  );
  const tabLabels = useMemo(
    () =>
      tabs.map((tab) => {
        const label =
          tab.presentation.titleState === "loading"
            ? getFallbackTabLabel(tab.tab, fallbackTabLabels)
            : tab.presentation.label;
        return { key: tab.tab.key, label, modified: tab.presentation.modified };
      }),
    [fallbackTabLabels, tabs],
  );
  const tabLabelSignature = useMemo(() => workspaceTabLabelSignature(tabLabels), [tabLabels]);
  const currentTabLabelKeys = useMemo(() => new Set(tabLabels.map(({ key }) => key)), [tabLabels]);
  useEffect(() => {
    setLabelMeasurements((current) => {
      const removedKeys = [...current.keys()].filter((key) => !currentTabLabelKeys.has(key));
      if (removedKeys.length === 0) {
        return current;
      }
      const next = new Map(current);
      for (const key of removedKeys) {
        next.delete(key);
      }
      return next;
    });
  }, [currentTabLabelKeys]);
  const publishMeasuredTrack = useCallback(() => {
    if (tabsContainerWidth <= 0) {
      return;
    }
    const labelWidths = completeWorkspaceTabLabelWidths(tabLabels, labelMeasurements);
    if (!labelWidths) {
      return;
    }

    setTrackSnapshot((current) => {
      if (
        current?.signature === tabLabelSignature &&
        sameWidths(current.labelWidths, labelWidths)
      ) {
        return current;
      }
      return {
        signature: tabLabelSignature,
        tabs,
        labels: tabLabels,
        labelWidths,
      };
    });
  }, [labelMeasurements, tabLabelSignature, tabLabels, tabs, tabsContainerWidth]);

  useLayoutEffect(() => {
    publishMeasuredTrack();
  }, [publishMeasuredTrack]);

  const handleTabLabelLayout = useCallback(
    (key: string, label: string, event: LayoutChangeEvent) => {
      const width = Math.ceil(event.nativeEvent.layout.width);
      if (width <= 0) {
        return;
      }
      setLabelMeasurements((current) => {
        const measurement = current.get(key);
        if (measurement?.label === label && measurement.width === width) {
          return current;
        }
        const next = new Map(current);
        next.set(key, { label, width });
        return next;
      });
    },
    [],
  );

  const displayedTabs = useMemo(() => {
    if (!trackSnapshot) {
      return EMPTY_RESOLVED_TAB_ROWS;
    }
    return resolveMeasuredWorkspaceTabs(trackSnapshot.tabs, tabs);
  }, [tabs, trackSnapshot]);

  const { layout } = useWorkspaceTabLayout({
    tabLabelWidths: trackSnapshot?.labelWidths ?? [],
    viewportWidthOverride: tabsContainerWidth > 0 ? tabsContainerWidth : null,
    metrics: layoutMetrics,
  });

  const handleDragEnd = useCallback(
    (nextTabs: ResolvedWorkspaceDesktopTabRowItem[]) => {
      onReorderTabs(nextTabs.map((tab) => tab.tab));
    },
    [onReorderTabs],
  );

  const getTabDragData = useMemo(() => {
    if (!paneId) return undefined;
    return (tab: ResolvedWorkspaceDesktopTabRowItem) => ({
      kind: "workspace-tab" as const,
      paneId,
      tabId: tab.tab.tabId,
    });
  }, [paneId]);

  const createNewTab = useCallback(() => onCreateNewTab({ paneId }), [onCreateNewTab, paneId]);

  const handleNewTabKeyboardAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (!isFocused || !newTabShortcutEnabled) return false;
      if (action.id === "workspace.tab.menu.open") {
        createNewTab();
        return true;
      }
      return false;
    },
    [createNewTab, isFocused, newTabShortcutEnabled],
  );

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-new-tab",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      paneId,
    }),
    actions: ["workspace.tab.menu.open"],
    enabled: isFocused && newTabShortcutEnabled,
    priority: 200,
    handle: handleNewTabKeyboardAction,
  });

  const renderTab = useCallback(
    ({
      item,
      index,
      dragHandleProps,
      isActive,
    }: DraggableRenderItemInfo<ResolvedWorkspaceDesktopTabRowItem>) => {
      const shouldShowCloseButton = layout.closeButtonPolicy === "all";
      const layoutItem = layout.items[index] ?? null;
      const resolvedTabWidth = layoutItem?.width ?? 150;
      const showLabel = layoutItem?.showLabel ?? true;
      const showDropIndicatorBefore = activeDragTabId !== null && tabDropPreviewIndex === index;
      const showDropIndicatorAfter =
        activeDragTabId !== null &&
        tabDropPreviewIndex === displayedTabs.length &&
        index === displayedTabs.length - 1;

      return (
        <ResolvedDesktopTabChip
          key={`${item.tab.key}:${item.tab.kind}`}
          item={item}
          serverId={normalizedServerId}
          fallbackWorkspaceId={normalizedWorkspaceId}
          isLocalDaemon={isLocalDaemon}
          isDragging={isActive}
          index={index}
          tabCount={displayedTabs.length}
          onCopyResumeCommand={onCopyResumeCommand}
          onCopyAgentId={onCopyAgentId}
          onCopyTerminalId={onCopyTerminalId}
          onCopyFilePath={onCopyFilePath}
          onReloadAgent={onReloadAgent}
          onRenameTab={onRenameTab}
          onCloseTabsToLeft={onCloseTabsToLeft}
          onCloseTabsToRight={onCloseTabsToRight}
          onCloseOtherTabs={onCloseOtherTabs}
          resolvedTabWidth={resolvedTabWidth}
          showLabel={showLabel}
          showCloseButton={shouldShowCloseButton}
          setHoveredCloseTabKey={setHoveredCloseTabKey}
          onNavigateTab={onNavigateTab}
          onCloseTab={onCloseTab}
          labels={tabMenuLabels}
          dragHandleProps={dragHandleProps}
          showDropIndicatorBefore={showDropIndicatorBefore}
          showDropIndicatorAfter={showDropIndicatorAfter}
        />
      );
    },
    [
      activeDragTabId,
      isLocalDaemon,
      normalizedServerId,
      normalizedWorkspaceId,
      layout.closeButtonPolicy,
      layout.items,
      onCloseOtherTabs,
      onCloseTab,
      onCloseTabsToLeft,
      onCloseTabsToRight,
      onCopyAgentId,
      onCopyTerminalId,
      onCopyFilePath,
      onCopyResumeCommand,
      onNavigateTab,
      onReloadAgent,
      onRenameTab,
      setHoveredCloseTabKey,
      tabMenuLabels,
      tabDropPreviewIndex,
      displayedTabs.length,
    ],
  );

  const tabsScrollStyle = useMemo(
    () => [
      styles.tabsScroll,
      layout.requiresHorizontalScrollFallback
        ? styles.tabsScrollOverflow
        : styles.tabsScrollFitContent,
    ],
    [layout.requiresHorizontalScrollFallback],
  );

  const row = (
    <View
      style={styles.tabsContainer}
      testID="workspace-tabs-row"
      onLayout={handleTabsContainerLayout}
    >
      <View pointerEvents="none" style={styles.tabsBottomBorder} />
      <View
        style={styles.tabLabelMeasurements}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {tabLabels.map(({ key, label }) => (
          <TabLabelMeasurement
            key={`${key}:${label}`}
            tabKey={key}
            label={label}
            onMeasure={handleTabLabelLayout}
          />
        ))}
      </View>
      <WorkspaceExitFocusModeButton
        visible={focusModeEnabled}
        onPress={onExitFocusMode}
        onLayout={handleExitFocusModeLayout}
      />
      <View
        style={[
          styles.tabsScrollContainer,
          showNewTerminalAction && [
            styles.terminalTabsScrollContainer,
            { width: layout.items.reduce((width, item) => width + item.width, 0) },
          ],
        ]}
      >
        <Animated.ScrollView
          horizontal
          scrollEnabled={layout.requiresHorizontalScrollFallback}
          testID="workspace-tabs-scroll"
          style={tabsScrollStyle}
          dataSet={TITLEBAR_DRAG_REGION_DATASET}
          contentContainerStyle={styles.tabsContent}
          showsHorizontalScrollIndicator={false}
          onLayout={handleTabScrollLayout}
          onContentSizeChange={handleTabScrollContentSizeChange}
          onScroll={handleTabScroll}
          scrollEventThrottle={16}
        >
          <SortableInlineList
            data={displayedTabs}
            keyExtractor={tabKeyExtractor}
            useDragHandle
            disabled={!externalDndContext && displayedTabs.length < 2}
            onDragEnd={handleDragEnd}
            externalDndContext={externalDndContext}
            activeId={activeDragTabId}
            getItemData={getTabDragData}
            renderItem={renderTab}
          />
        </Animated.ScrollView>
        <WorkspaceTabScrollShades
          visible={layout.requiresHorizontalScrollFallback}
          leftStyle={leftTabScrollShadeStyle}
          rightStyle={rightTabScrollShadeStyle}
        />
      </View>
      {showNewTerminalAction ? (
        <WorkspaceNewTerminalButton paneId={paneId} onLayout={handleNewTerminalButtonLayout} />
      ) : null}
      <WorkspacePaneMaximizeButton
        visible={showPaneMaximizeAction}
        maximized={paneMaximized}
        onPress={onTogglePaneMaximized}
        onLayout={handlePaneMaximizeButtonLayout}
      />
    </View>
  );

  return <RenderProfile id="WorkspaceDesktopTabsRow">{row}</RenderProfile>;
}
function ResolvedDesktopTabChip({
  item,
  serverId,
  fallbackWorkspaceId,
  isLocalDaemon,
  isDragging,
  index,
  tabCount,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseOtherTabs,
  resolvedTabWidth,
  showLabel,
  showCloseButton,
  setHoveredCloseTabKey,
  onNavigateTab,
  onCloseTab,
  labels,
  dragHandleProps,
  showDropIndicatorBefore,
  showDropIndicatorAfter,
}: {
  item: ResolvedWorkspaceDesktopTabRowItem;
  serverId: string;
  fallbackWorkspaceId: string;
  isLocalDaemon: boolean;
  isDragging: boolean;
  index: number;
  tabCount: number;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTabsToLeft: (tabId: string) => Promise<void> | void;
  onCloseTabsToRight: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
  resolvedTabWidth: number;
  showLabel: boolean;
  showCloseButton: boolean;
  setHoveredCloseTabKey: Dispatch<SetStateAction<string | null>>;
  onNavigateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  labels: WorkspaceTabMenuLabels;
  dragHandleProps: DraggableListDragHandleProps | undefined;
  showDropIndicatorBefore: boolean;
  showDropIndicatorAfter: boolean;
}) {
  const { t } = useTranslation();
  const ownerWorkspaceId = item.tab.target.workspaceId?.trim() || fallbackWorkspaceId;
  const ownerWorkspace = useWorkspace(serverId, ownerWorkspaceId);
  const workspaceRoot = ownerWorkspace?.workspaceDirectory ?? "";
  const revealWorkspacePath = isLocalDaemon ? workspaceRoot || null : null;
  const revealExplorerFile = usePanelStore((state) => state.revealExplorerFile);
  const canRevealFileInExplorer = useCallback(
    (path: string) =>
      Boolean(
        resolveProjectLayoutKey({ serverId, workspaceId: ownerWorkspaceId }) &&
        resolveWorkspaceFilePaths({ path, workspaceRoot })?.relativePath,
      ),
    [ownerWorkspaceId, serverId, workspaceRoot],
  );
  const onRevealFileInExplorer = useCallback(
    (path: string) => {
      const relativePath = resolveWorkspaceFilePaths({ path, workspaceRoot })?.relativePath;
      const workspaceKey = buildWorkspaceExplorerStateKey({
        workspaceId: ownerWorkspaceId,
        workspaceRoot,
      });
      const projectKey = resolveProjectLayoutKey({ serverId, workspaceId: ownerWorkspaceId });
      if (!relativePath || !workspaceKey || !projectKey) return;
      revealExplorerFile({ serverId, workspaceKey, path: relativePath });
      openTabInSidePanel({
        isCompact: false,
        workspaceKey: projectKey,
        checkout: null,
        target: { kind: "files", workspaceId: ownerWorkspaceId },
      });
    },
    [ownerWorkspaceId, revealExplorerFile, serverId, workspaceRoot],
  );
  const presentation = item.presentation;
  const resolvedTab = useMemo(
    () =>
      buildWorkspaceDesktopTabActions({
        tab: item.tab,
        index,
        tabCount,
        onCopyResumeCommand,
        onCopyAgentId,
        onCopyTerminalId,
        onCopyFilePath,
        onReloadAgent,
        onRenameTab,
        onRevealFileInExplorer,
        canRevealFileInExplorer,
        onCloseTab,
        onCloseTabsToLeft,
        onCloseTabsToRight,
        onCloseOtherTabs,
        labels,
      }),
    [
      index,
      item.tab,
      onCloseOtherTabs,
      onCloseTab,
      onCloseTabsToLeft,
      onCloseTabsToRight,
      onCopyAgentId,
      onCopyTerminalId,
      onCopyFilePath,
      onCopyResumeCommand,
      labels,
      onReloadAgent,
      onRevealFileInExplorer,
      canRevealFileInExplorer,
      onRenameTab,
      tabCount,
    ],
  );

  const tooltipLabel =
    presentation.titleState === "loading"
      ? t("workspace.tabs.loadingAgentTitle")
      : presentation.tooltip;

  return (
    <View style={styles.tabSlot}>
      {showDropIndicatorBefore ? (
        <View style={[styles.tabDropIndicator, styles.tabDropIndicatorBefore]} />
      ) : null}
      <TabChip
        tab={item.tab}
        revealWorkspacePath={revealWorkspacePath}
        isActive={item.isActive}
        isDragging={isDragging}
        resolvedTabWidth={resolvedTabWidth}
        showLabel={showLabel}
        showCloseButton={showCloseButton}
        isCloseHovered={item.isCloseHovered}
        isClosingTab={item.isClosingTab}
        presentation={presentation}
        tooltipLabel={tooltipLabel}
        resolvedTab={resolvedTab}
        setHoveredCloseTabKey={setHoveredCloseTabKey}
        onNavigateTab={onNavigateTab}
        onCloseTab={onCloseTab}
        dragHandleProps={dragHandleProps}
      />
      {showDropIndicatorAfter ? (
        <View style={[styles.tabDropIndicator, styles.tabDropIndicatorAfter]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabsContainer: {
    minWidth: 0,
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    backgroundColor: theme.colors.surfaceSidebar,
    flexDirection: "row",
    alignItems: "center",
    overflow: "visible",
  },
  tabsBottomBorder: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  tabsScroll: {
    minWidth: 0,
  },
  tabsScrollContainer: {
    minWidth: 0,
    flex: 1,
    alignSelf: "stretch",
  },
  terminalTabsScrollContainer: {
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: "auto",
  },
  tabsScrollFitContent: {
    flex: 1,
  },
  tabsScrollOverflow: {
    flex: 1,
  },
  tabsContent: {
    flexDirection: "row",
    minHeight: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    alignItems: "center",
    paddingHorizontal: TAB_ROW_PADDING_HORIZONTAL,
  },
  tabScrollShade: {
    position: "absolute",
    top: 0,
    bottom: 1,
    width: TAB_SCROLL_SHADE_WIDTH,
  },
  tabScrollShadeLeft: {
    left: 0,
  },
  tabScrollShadeRight: {
    right: 0,
  },
  exitFocusModeSlot: {
    alignSelf: "stretch",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  inlineAddButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
  },
  paneMaximizeButtonSlot: {
    // Keep the glyph centered in its hit target while placing that glyph on the trailing rail.
    marginRight: theme.spacing[2],
  },
  tab: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    paddingHorizontal: TAB_CHIP_HORIZONTAL_PADDING,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
    flexDirection: "row",
    alignItems: "center",
    gap: TAB_CONTENT_GAP,
    userSelect: "none",
  },
  tabHovered: {
    backgroundColor: theme.colors.surface1,
  },
  tabActive: {
    backgroundColor: theme.colors.surface0,
    borderBottomColor: theme.colors.surface0,
  },
  tabHoverFrame: {
    position: "relative",
  },
  tabSlot: {
    position: "relative",
    overflow: "visible",
  },
  tabHandle: {
    flexDirection: "row",
    alignItems: "center",
    gap: TAB_CONTENT_GAP,
    flex: 1,
    minWidth: 0,
    paddingRight: TAB_CLOSE_BUTTON_RESERVED_WIDTH,
    userSelect: "none",
  },
  tabIcon: {
    width: TAB_ICON_WIDTH,
    height: TAB_ICON_WIDTH,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  // Center the insertion marker on the shared border between adjacent tabs.
  tabDropIndicator: {
    position: "absolute",
    top: theme.spacing[0.5],
    bottom: theme.spacing[0.5],
    width: TAB_DROP_INDICATOR_WIDTH,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    zIndex: 10,
    pointerEvents: "none",
  },
  tabDropIndicatorBefore: {
    left: -TAB_CHIP_GAP / 2 - TAB_DROP_INDICATOR_WIDTH / 2,
  },
  tabDropIndicatorAfter: {
    right: -TAB_CHIP_GAP / 2 - TAB_DROP_INDICATOR_WIDTH / 2,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundTabInactive,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 20,
    userSelect: "none",
  },
  tabLabelMeasurements: {
    position: "absolute",
    top: 0,
    left: 0,
    opacity: 0,
    alignItems: "flex-start",
    pointerEvents: "none",
  },
  tabLabelMeasurement: {
    flexShrink: 0,
  },
  tabLabelSkeleton: {
    width: 96,
    maxWidth: "100%",
    flexShrink: 1,
    minWidth: 0,
    height: 10,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.9,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  tabTrailingOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: TAB_CLOSE_BUTTON_RESERVED_WIDTH + TAB_CHIP_HORIZONTAL_PADDING,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
    overflow: "hidden",
  },
  tabCloseButton: {
    position: "absolute",
    right: TAB_CHIP_HORIZONTAL_PADDING,
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  tabMenuButton: {
    position: "absolute",
    right: theme.spacing[1],
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  tabModifiedDot: {
    width: TAB_MODIFIED_DOT_SIZE,
    height: TAB_MODIFIED_DOT_SIZE,
    flexShrink: 0,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  inlineAddActionButton: {
    width: buttonControlHeight.xs,
    height: buttonControlHeight.xs,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  newTabActionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  newTabTooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  newTabTooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  newTabTooltipShortcut: {},
  tooltipAgentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipAgentId: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  menuItemHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
