import { memo, useCallback, useMemo, useState, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import {
  navigateToSidebarWorkspace,
  useActiveWorkspaceSelection,
  useSidebarActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { type SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { StatusBucket } from "@/hooks/sidebar-status-view-model";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import { SidebarFilterEmptyState } from "@/components/sidebar/empty-states";
import type { HostBadgeModel } from "@/hosts/appearance";
import { isWeb as platformIsWeb, isNative as platformIsNative } from "@/constants/platform";
import { SIDEBAR_LIST_INSET } from "@/constants/layout";
import { useShowPersistentActions, useTouchInteraction } from "@/hooks/use-fine-pointer";
import { isMousePointerEvent } from "@/utils/device-input";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";
import { buttonControlHeight, TOUCH_LIST_ROW_HEIGHT } from "@/components/ui/control-geometry";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
} from "lucide-react-native";
import { useToast } from "@/contexts/toast-context";
import { useMutation } from "@tanstack/react-query";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import { deleteWorkspaceWithCleanup } from "@/workspace/workspace-delete";
import { toWorktreeArchiveRisk } from "@/git/worktree-archive-warning";
import * as Clipboard from "expo-clipboard";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useClearWorkspaceAttention } from "@/hooks/use-clear-workspace-attention";
import {
  SidebarWorkspaceRowFrame,
  SidebarWorkspaceRowContent,
  resolveTrailingActionVisibility,
  SidebarWorkspaceTrailingActionBase,
  SidebarWorkspaceTrailingActionOverlay,
  SidebarWorkspaceTrailingActionSlot,
  sidebarWorkspaceRowStyles,
} from "@/components/sidebar/sidebar-workspace-row-content";
import type { SidebarWorkspaceRename } from "@/components/sidebar/sidebar-workspace-inline-rename";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { SidebarWorkspaceQuickActions } from "@/components/sidebar/sidebar-workspace-quick-actions";
import { useSidebarWorkspaceFork } from "@/components/sidebar/use-sidebar-workspace-fork";
import { getSidebarRowBackdrop } from "@/components/sidebar/sidebar-row-backdrop";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { selectWorkspaceServiceSummary } from "@/components/sidebar/workspace-meta-row";
import { SidebarWorkspaceTrailingContent } from "@/components/sidebar/workspace-trailing";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import {
  SidebarWorkspaceContextMenu,
  SidebarWorkspaceMenu,
} from "@/components/sidebar/sidebar-workspace-menu";
import { sidebarWorkspaceArchiveLabelKey } from "@/components/sidebar/sidebar-workspace-title";
import { SidebarGroupToggleRow } from "@/components/sidebar/sidebar-group-toggle-row";
import { useLimitedSidebarGroup } from "@/components/sidebar/use-limited-sidebar-group";
import type { ToggleSidebarWorkspacePin } from "@/hooks/use-sidebar-workspace-pin";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import { useReferenceWorkspaceContent } from "@/components/sidebar/use-reference-workspace-content";

// Themed icon wrappers
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
// One mapping per bucket, resolved through the status-dot producer so a group header and
// the rows under it cannot disagree about what "failed" looks like.
const needsInputColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
});
const failedColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
});
const attentionColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
});
const runningColorMapping = (theme: Theme) => ({
  color: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
});

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);
const EMPTY_SHORTCUT_INDEX = new Map<string, number>();

interface StatusWorkspaceListProps {
  groups: SidebarWorkspaceGroup[];
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  listHeaderComponent?: ReactNode;
  /** Swaps the group list for the label filter's empty state. Never the header above it. */
  sidebarFilterEmpty?: boolean;
}

export function SidebarStatusWorkspaceList({
  groups,
  projectIconByProjectViewKey,
  shortcutIndexByWorkspaceKey,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  listHeaderComponent,
  sidebarFilterEmpty = false,
}: StatusWorkspaceListProps) {
  const collapsedWorkspaceGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceGroupKeys,
  );

  const statusShortcutIndex = showShortcutBadges
    ? shortcutIndexByWorkspaceKey
    : EMPTY_SHORTCUT_INDEX;
  const content = (
    <>
      {listHeaderComponent}
      {sidebarFilterEmpty ? (
        <SidebarFilterEmptyState />
      ) : (
        <StatusGroupList
          groups={groups}
          collapsedWorkspaceGroupKeys={collapsedWorkspaceGroupKeys}
          projectIconByProjectViewKey={projectIconByProjectViewKey}
          shortcutIndex={statusShortcutIndex}
          showShortcutBadges={showShortcutBadges}
          onWorkspacePress={onWorkspacePress}
          hostBadgeByServerId={hostBadgeByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
        />
      )}
    </>
  );

  return (
    <View style={styles.container}>
      {platformIsNative ? (
        <NestableScrollContainer
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator
          testID="sidebar-status-list-scroll"
        >
          {content}
        </NestableScrollContainer>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator
          testID="sidebar-status-list-scroll"
        >
          {content}
        </ScrollView>
      )}
    </View>
  );
}

function StatusGroupList({
  groups,
  collapsedWorkspaceGroupKeys,
  projectIconByProjectViewKey,
  shortcutIndex,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
}: {
  groups: SidebarWorkspaceGroup[];
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndex: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
}) {
  // A completed conversation stays in Ready to review until its notification is read.
  const unreadCompletions = groups.find((group) => group.leading.bucket === "attention")?.rows;
  const { t } = useTranslation();
  const toast = useToast();
  const markAllAsRead = useMutation({
    mutationFn: async (rows: readonly SidebarWorkspaceEntry[]) => {
      const workspaceIdsByHost = new Map<string, string[]>();
      for (const { serverId, workspaceId } of rows) {
        const workspaceIds = workspaceIdsByHost.get(serverId);
        if (workspaceIds) workspaceIds.push(workspaceId);
        else workspaceIdsByHost.set(serverId, [workspaceId]);
      }
      const results = await Promise.allSettled(
        [...workspaceIdsByHost].map(async ([serverId, workspaceIds]) => {
          const client = getHostRuntimeStore().getClient(serverId);
          if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
          await client.clearWorkspaceAttention(workspaceIds);
        }),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
    onError: (error) => toast.error(`${t("sidebar.status.markAllAsReadFailed")}: ${error.message}`),
  });

  const doneMarkAllAsRead = useMemo<MarkAllAsReadAction>(
    () => ({
      disabled: markAllAsRead.isPending || !unreadCompletions?.length,
      select: () => {
        if (unreadCompletions?.length) markAllAsRead.mutate(unreadCompletions);
      },
    }),
    [markAllAsRead, unreadCompletions],
  );

  return (
    <>
      {groups.map((group) => (
        <StatusGroupRows
          key={group.key}
          group={group}
          collapsed={collapsedWorkspaceGroupKeys.has(group.key)}
          markAllAsRead={group.leading.bucket === "done" ? doneMarkAllAsRead : undefined}
          projectIconByProjectViewKey={projectIconByProjectViewKey}
          shortcutIndex={shortcutIndex}
          showShortcutBadges={showShortcutBadges}
          onWorkspacePress={onWorkspacePress}
          hostBadgeByServerId={hostBadgeByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
        />
      ))}
    </>
  );
}

interface MarkAllAsReadAction {
  disabled: boolean;
  select: () => void;
}

function StatusGroupRows({
  group,
  collapsed,
  markAllAsRead,
  projectIconByProjectViewKey,
  shortcutIndex,
  showShortcutBadges,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
}: {
  group: SidebarWorkspaceGroup;
  collapsed: boolean;
  markAllAsRead?: MarkAllAsReadAction;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndex: Map<string, number>;
  showShortcutBadges: boolean;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
}) {
  const {
    visibleItems: visibleWorkspaces,
    expanded: workspacesExpanded,
    canToggle: canToggleWorkspaces,
    toggleExpanded: toggleWorkspacesExpanded,
  } = useLimitedSidebarGroup(group.rows);

  return (
    <View style={collapsed ? undefined : styles.statusGroupBlockExpanded}>
      <StatusGroupHeader group={group} collapsed={collapsed} markAllAsRead={markAllAsRead} />
      {!collapsed ? (
        <View
          style={styles.statusWorkspaceListContainer}
          testID={`sidebar-status-group-rows-${group.key}`}
        >
          {visibleWorkspaces.map((workspace) => (
            <StatusWorkspaceRow
              key={workspace.workspaceKey}
              workspace={workspace}
              {...buildStatusRowProjectPresentation({
                workspace,
                projectIconByProjectViewKey,
                hostBadgeByServerId,
              })}
              shortcutNumber={shortcutIndex.get(workspace.workspaceKey) ?? null}
              showShortcutBadge={showShortcutBadges}
              canPin={supportsPinningByServerId.get(workspace.serverId) === true}
              onToggleWorkspacePin={onToggleWorkspacePin}
              onWorkspacePress={onWorkspacePress}
            />
          ))}
          {canToggleWorkspaces ? (
            <SidebarGroupToggleRow
              expanded={workspacesExpanded}
              onPress={toggleWorkspacesExpanded}
              indented
              testID={`sidebar-status-group-show-more-${group.key}`}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

interface StatusRowProjectPresentation {
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
}

function buildStatusRowProjectPresentation({
  workspace,
  projectIconByProjectViewKey,
  hostBadgeByServerId,
}: {
  workspace: SidebarWorkspaceEntry;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
}): StatusRowProjectPresentation {
  return {
    hostBadge: hostBadgeByServerId.get(workspace.serverId) ?? null,
    projectName: workspace.projectName,
    projectIconDataUri: projectIconByProjectViewKey.get(workspace.projectViewKey) ?? null,
  };
}

function StatusGroupHeader({
  group,
  collapsed,
  markAllAsRead,
}: {
  group: SidebarWorkspaceGroup;
  collapsed: boolean;
  markAllAsRead?: MarkAllAsReadAction;
}) {
  const { t } = useTranslation();
  const isTouchInteraction = useTouchInteraction();
  const [isHovered, setIsHovered] = useState(false);
  const toggleWorkspaceGroupCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleWorkspaceGroupCollapsed,
  );
  const handlePress = useCallback(() => {
    toggleWorkspaceGroupCollapsed(group.key);
  }, [group.key, toggleWorkspaceGroupCollapsed]);
  const handleHoverIn = useCallback(
    (event?: unknown) => {
      if (isTouchInteraction || !isMousePointerEvent(event)) return;
      setIsHovered(true);
    },
    [isTouchInteraction],
  );
  const handleHoverOut = useCallback((event?: unknown) => {
    if (!isMousePointerEvent(event)) return;
    setIsHovered(false);
  }, []);
  const effectiveHovered = !isTouchInteraction && isHovered;
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.statusGroupRow,
      isTouchInteraction && styles.statusGroupRowTouch,
      effectiveHovered && styles.statusGroupRowHovered,
      pressed && styles.statusGroupRowPressed,
    ],
    [effectiveHovered, isTouchInteraction],
  );
  const triggerProps = {
    accessibilityLabel: `${group.label} group`,
    "aria-expanded": !collapsed,
    style: rowStyle,
    onPress: handlePress,
    testID: `sidebar-status-group-${group.key}`,
  };
  const content = (
    <View style={styles.statusGroupRowLeft}>
      <View style={styles.statusGroupLeadingVisualSlot}>
        <StatusGroupLeadingVisual
          leading={group.leading}
          collapsed={collapsed}
          showChevron={effectiveHovered}
        />
      </View>
      <View style={styles.statusGroupTitleGroup}>
        <Text style={styles.statusGroupTitle} numberOfLines={1}>
          {group.label}
        </Text>
      </View>
    </View>
  );

  const markAllAsReadLeadingIcon = useMemo(
    () => <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />,
    [],
  );

  return (
    <View onPointerEnter={handleHoverIn} onPointerLeave={handleHoverOut}>
      {markAllAsRead ? (
        <ContextMenu>
          <ContextMenuTrigger
            {...triggerProps}
            enabledOnMobile={isTouchInteraction}
            enableTouchLongPress={isTouchInteraction}
            accessibilityRole="button"
          >
            {content}
          </ContextMenuTrigger>
          <ContextMenuContent align="start" width={220}>
            <ContextMenuItem
              disabled={markAllAsRead.disabled}
              leading={markAllAsReadLeadingIcon}
              onSelect={markAllAsRead.select}
              testID="sidebar-status-mark-all-as-read"
            >
              {t("sidebar.status.markAllAsRead")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        <Pressable {...triggerProps} accessibilityRole={platformIsWeb ? undefined : "button"}>
          {content}
        </Pressable>
      )}
    </View>
  );
}

function StatusGroupLeadingVisual({
  leading,
  collapsed,
  showChevron,
}: {
  leading: SidebarWorkspaceGroup["leading"];
  collapsed: boolean;
  showChevron: boolean;
}) {
  if (!showChevron) {
    return <StatusGroupIcon bucket={leading.bucket} />;
  }
  if (collapsed) {
    return <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />;
  }
  return <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />;
}

function StatusGroupIcon({ bucket }: { bucket: StatusBucket }) {
  switch (bucket) {
    case "needs_input":
      return <ThemedCircleAlert size={14} uniProps={needsInputColorMapping} />;
    case "failed":
      return <ThemedCircleX size={14} uniProps={failedColorMapping} />;
    case "attention":
      return <ThemedCircleCheck size={14} uniProps={attentionColorMapping} />;
    case "running":
      return <ThemedCircleDot size={14} uniProps={runningColorMapping} />;
    case "done":
      return <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />;
  }
}

const StatusWorkspaceRow = memo(function StatusWorkspaceRow({
  workspace,
  hostBadge,
  projectName,
  projectIconDataUri,
  shortcutNumber,
  showShortcutBadge,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  inStatusGroup = true,
  onWorkspacePress,
  drag,
  isDragging = false,
  dragHandleProps,
}: {
  workspace: SidebarWorkspaceEntry;
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  /**
   * Whether the row sits under a status header, which is what it indents from. Pinned rows
   * are a flat list under their own header and sit flush.
   */
  inStatusGroup?: boolean;
  onWorkspacePress?: () => void;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const tabHostSelection = useActiveWorkspaceSelection();
  const activeWorkspaceSelection = useSidebarActiveWorkspaceSelection();
  const selected =
    activeWorkspaceSelection?.serverId === workspace.serverId &&
    activeWorkspaceSelection?.workspaceId === workspace.workspaceId;

  const handlePress = useCallback(() => {
    if (!workspace.serverId) return;
    onWorkspacePress?.();
    void navigateToSidebarWorkspace({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      tabHost: tabHostSelection,
    });
  }, [onWorkspacePress, tabHostSelection, workspace.serverId, workspace.workspaceId]);

  return (
    <StatusWorkspaceRowWithMenu
      workspace={workspace}
      hostBadge={hostBadge}
      projectName={projectName}
      projectIconDataUri={projectIconDataUri}
      selected={selected}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      canPin={canPin}
      onToggleWorkspacePin={onToggleWorkspacePin}
      reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
      inStatusGroup={inStatusGroup}
      onPress={handlePress}
      drag={drag}
      isDragging={isDragging}
      dragHandleProps={dragHandleProps}
    />
  );
});

function StatusWorkspaceRowWithMenu({
  workspace,
  hostBadge,
  projectName,
  projectIconDataUri,
  selected,
  shortcutNumber,
  showShortcutBadge,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  inStatusGroup = true,
  onPress,
  drag,
  isDragging = false,
  dragHandleProps,
}: {
  workspace: SidebarWorkspaceEntry;
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  /**
   * Whether the row sits under a status header, which is what it indents from. Pinned rows
   * are a flat list under their own header and sit flush.
   */
  inStatusGroup?: boolean;
  onPress: () => void;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const isTouchInteraction = useTouchInteraction();
  const activeRouteWorkspaceSelection = useActiveWorkspaceSelection();
  const [isHidingWorkspace, setIsHidingWorkspace] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const isArchiving = workspace.archivingAt !== null || isHidingWorkspace;
  const { canFork, isForking, fork } = useSidebarWorkspaceFork(workspace);
  const {
    canReferenceContent,
    isPending: isReferencingContent,
    referenceContent,
  } = useReferenceWorkspaceContent(workspace);

  const redirectAfterArchive = useCallback(() => {
    redirectIfArchivingActiveWorkspace({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      activeWorkspaceSelection: activeRouteWorkspaceSelection,
    });
  }, [activeRouteWorkspaceSelection, workspace.serverId, workspace.workspaceId]);
  const deleteMutation = useMutation({
    mutationFn: async () => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      await deleteWorkspaceWithCleanup(client, {
        serverId: workspace.serverId,
        workspaceId: workspace.workspaceId,
      });
    },
    onSuccess: redirectAfterArchive,
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.deleteFailed"),
      );
    },
  });
  const isDeleting = deleteMutation.isPending;
  const isBusy = isArchiving || isDeleting || isForking;

  const archiveController = useWorkspaceArchive({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
    workspaceKind: workspace.workspaceKind,
    name: workspace.name,
    onlyIfEmpty: workspace.isUnstarted,
    hideEmptyWorktree: workspace.isUnstartedWorktree,
    ...toWorktreeArchiveRisk(workspace),
    onArchiveStarted: redirectAfterArchive,
    onSetHiding: setIsHidingWorkspace,
  });

  const handleArchive = useCallback(() => {
    if (isBusy) return;
    archiveController.archive();
  }, [archiveController, isBusy]);

  const handleDelete = useCallback(async () => {
    if (isBusy) return;
    const confirmed = await confirmDialog({
      title: t("sidebar.workspace.confirmations.deleteTitle", {
        name: workspace.title ?? workspace.name,
      }),
      message: t("sidebar.workspace.confirmations.deleteMessage"),
      confirmLabel: t("sidebar.workspace.actions.delete"),
      cancelLabel: t("workspace.tabs.confirmations.cancel"),
      destructive: true,
    });
    if (confirmed) deleteMutation.mutate();
  }, [deleteMutation, isBusy, t, workspace.name, workspace.title]);

  const handleFork = useCallback(() => {
    if (!isBusy && canFork) void fork();
  }, [canFork, fork, isBusy]);

  const handleCopyPath = useCallback(() => {
    let copyTargetDirectory: string;
    try {
      copyTargetDirectory = requireWorkspaceDirectory({
        workspaceId: workspace.workspaceId,
        workspaceDirectory: workspace.workspaceDirectory,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Workspace path not available");
      return;
    }
    void Clipboard.setStringAsync(copyTargetDirectory);
    toast.copied("Path copied");
  }, [toast, workspace.workspaceDirectory, workspace.workspaceId]);

  const handleCopyBranchName = useCallback(() => {
    void Clipboard.setStringAsync(workspace.name);
    toast.copied("Branch name copied");
  }, [toast, workspace.name]);

  const renameMutation = useMutation({
    mutationFn: async (title: string) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      await client.setWorkspaceTitle(workspace.workspaceId, title.length === 0 ? null : title);
    },
  });

  const handleOpenRename = useCallback(() => setIsRenaming(true), []);
  const handleCloseRename = useCallback(() => setIsRenaming(false), []);
  const handleSubmitRename = useCallback(
    async (value: string) => {
      await renameMutation.mutateAsync(value.trim());
    },
    [renameMutation],
  );
  const rename = useMemo<SidebarWorkspaceRename | undefined>(
    () =>
      isRenaming && !isTouchInteraction
        ? {
            initialValue: workspace.title ?? workspace.name,
            placeholder: workspace.name,
            onSubmit: handleSubmitRename,
            onCancel: handleCloseRename,
          }
        : undefined,
    [
      handleCloseRename,
      handleSubmitRename,
      isRenaming,
      isTouchInteraction,
      workspace.name,
      workspace.title,
    ],
  );
  const isPinned = workspace.pinnedAt != null;
  const handleTogglePin = useCallback(() => {
    onToggleWorkspacePin(workspace);
  }, [onToggleWorkspacePin, workspace]);
  const onTogglePin = canPin ? handleTogglePin : undefined;

  const archiveShortcutKeys = useShortcutKeys("archive-workspace");
  const { hasClearableAttention, clearAttention } = useClearWorkspaceAttention({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
  });
  const handleMarkAsRead = useCallback(() => {
    void clearAttention().catch((error) => {
      toast.error(error instanceof Error ? error.message : "Failed to mark workspace as read");
    });
  }, [clearAttention, toast]);

  useKeyboardActionHandler({
    handlerId: `workspace-archive-${workspace.workspaceKey}`,
    actions: ["workspace.archive"],
    enabled: selected && !isBusy,
    priority: 0,
    handle: () => {
      handleArchive();
      return true;
    },
  });

  return (
    <>
      <StatusWorkspaceRowInner
        workspace={workspace}
        hostBadge={hostBadge}
        projectName={projectName}
        projectIconDataUri={projectIconDataUri}
        selected={selected}
        shortcutNumber={shortcutNumber}
        showShortcutBadge={showShortcutBadge}
        onPress={onPress}
        rename={rename}
        isArchiving={isArchiving}
        isDeleting={isDeleting}
        isForking={isForking}
        canFork={canFork}
        archiveLabel={t(sidebarWorkspaceArchiveLabelKey(workspace))}
        archiveStatus={isArchiving ? "pending" : "idle"}
        archivePendingLabel={t("sidebar.workspace.actions.archiving")}
        onArchive={handleArchive}
        onDelete={workspace.isUnstarted || workspace.isUnstartedWorktree ? undefined : handleDelete}
        deleteStatus={isDeleting ? "pending" : "idle"}
        deletePendingLabel={t("sidebar.workspace.actions.deleting")}
        onFork={handleFork}
        onCopyBranchName={workspace.projectKind === "git" ? handleCopyBranchName : undefined}
        onCopyPath={handleCopyPath}
        onReferenceContent={canReferenceContent ? referenceContent : undefined}
        referenceContentStatus={isReferencingContent ? "pending" : "idle"}
        onRename={handleOpenRename}
        onMarkAsRead={hasClearableAttention ? handleMarkAsRead : undefined}
        archiveShortcutKeys={selected ? archiveShortcutKeys : null}
        isPinned={isPinned}
        onTogglePin={onTogglePin}
        reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
        inStatusGroup={inStatusGroup}
        drag={drag}
        isDragging={isDragging}
        dragHandleProps={dragHandleProps}
      />
      {isTouchInteraction ? (
        <AdaptiveRenameModal
          visible={isRenaming}
          title={t("sidebar.workspace.rename.title")}
          initialValue={workspace.title ?? workspace.name}
          placeholder={workspace.name}
          submitLabel={t("sidebar.workspace.rename.submit")}
          onClose={handleCloseRename}
          onSubmit={handleSubmitRename}
          testID={`sidebar-workspace-rename-modal-${workspace.workspaceKey}`}
        />
      ) : null}
    </>
  );
}

interface StatusWorkspaceRowInnerProps {
  workspace: SidebarWorkspaceEntry;
  hostBadge: HostBadgeModel | null;
  projectName: string;
  projectIconDataUri: string | null;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  rename?: SidebarWorkspaceRename;
  isArchiving: boolean;
  isDeleting: boolean;
  isForking: boolean;
  canFork: boolean;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  onArchive?: () => void;
  onDelete?: () => void;
  deleteStatus?: "idle" | "pending" | "success";
  deletePendingLabel?: string;
  onFork?: () => void;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onReferenceContent?: () => void;
  referenceContentStatus?: "idle" | "pending" | "success";
  onRename?: () => void;
  onMarkAsRead?: () => void;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  isPinned?: boolean;
  onTogglePin?: () => void;
  reserveIdleStatusIndicatorSpace?: boolean;
  /** Pinned rows are flat under their own header; status-group rows indent from theirs. */
  inStatusGroup?: boolean;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

function StatusWorkspaceRowInner(props: StatusWorkspaceRowInnerProps) {
  if (props.drag) {
    return <DraggableStatusWorkspaceRowInner {...props} drag={props.drag} />;
  }
  return <StatusWorkspaceRowInnerContent {...props} />;
}

function DraggableStatusWorkspaceRowInner(
  props: StatusWorkspaceRowInnerProps & { drag: () => void },
) {
  const isTouchInteraction = useTouchInteraction();
  const dragInteraction = useLongPressDragInteraction({
    drag: props.drag,
    menuController: null,
    enabled: !isTouchInteraction,
  });
  return <StatusWorkspaceRowInnerContent {...props} dragInteraction={dragInteraction} />;
}

function StatusWorkspaceRowInnerContent({
  workspace,
  hostBadge,
  projectName,
  projectIconDataUri,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  rename,
  isArchiving,
  isDeleting,
  isForking,
  canFork,
  archiveLabel,
  archiveStatus = "idle",
  archivePendingLabel,
  onArchive,
  onDelete,
  deleteStatus = "idle",
  deletePendingLabel,
  onFork,
  onCopyBranchName,
  onCopyPath,
  onReferenceContent,
  referenceContentStatus,
  onRename,
  onMarkAsRead,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  reserveIdleStatusIndicatorSpace = true,
  inStatusGroup = true,
  isDragging = false,
  dragHandleProps,
  dragInteraction,
}: StatusWorkspaceRowInnerProps & {
  dragInteraction?: ReturnType<typeof useLongPressDragInteraction>;
}) {
  const isTouchInteraction = useTouchInteraction();
  const showPersistentActions = useShowPersistentActions();
  const [isPressed, setIsPressed] = useState(false);
  const rowDragEnabled = !isTouchInteraction;
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

  const isDesktop = !isTouchInteraction;
  const serviceSummary = isDesktop ? selectWorkspaceServiceSummary(workspace.scripts) : null;

  const showShortcut = showShortcutBadge && shortcutNumber !== null;
  const touchTrailingVisibility = resolveTrailingActionVisibility({
    workspace,
    hasArchiveAction: Boolean(onArchive),
    selected,
    isHovered: false,
    isTouchInteraction: true,
    showShortcut,
  });
  const touchKebab = useOpenKebabMenuVisibility(
    isTouchInteraction && touchTrailingVisibility.showKebab,
  );

  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const didLongPressRef = dragInteraction?.didLongPressRef;
  const startDragPress = dragInteraction?.handlePressIn;
  const moveDragPress = dragInteraction?.handleTouchMove;
  const endDragPress = dragInteraction?.handlePressOut;
  const handlePress = useCallback(() => {
    if (didLongPressRef?.current) {
      didLongPressRef.current = false;
      return;
    }
    if (rename) return;
    onPress();
  }, [didLongPressRef, onPress, rename]);
  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      if (rename) return;
      setIsPressed(true);
      startDragPress?.(event);
    },
    [rename, startDragPress],
  );
  const handlePressOut = useCallback(() => {
    setIsPressed(false);
    endDragPress?.();
  }, [endDragPress]);

  const touchTrailingAccessory = useMemo(
    () =>
      isTouchInteraction && touchKebab.showKebab && onArchive ? (
        <SidebarWorkspaceMenu
          {...touchKebab.menuProps}
          workspaceKey={workspace.workspaceKey}
          serverId={workspace.serverId}
          workspaceId={workspace.workspaceId}
          workspaceLabels={workspace.labels}
          rootAgents={workspace.rootAgents}
          onCopyPath={onCopyPath}
          onCopyBranchName={onCopyBranchName}
          onReferenceContent={onReferenceContent}
          referenceContentStatus={referenceContentStatus}
          onFork={canFork ? onFork : undefined}
          forkPending={isForking}
          openInFileManagerPath={workspace.workspaceDirectory}
          onRename={onRename}
          onMarkAsRead={onMarkAsRead}
          onArchive={onArchive}
          onDelete={onDelete}
          deleteStatus={deleteStatus}
          deletePendingLabel={deletePendingLabel}
          archiveLabel={archiveLabel}
          archiveStatus={archiveStatus}
          archivePendingLabel={archivePendingLabel}
          archiveShortcutKeys={archiveShortcutKeys}
          isPinned={isPinned}
          onTogglePin={onTogglePin}
        />
      ) : null,
    [
      archiveLabel,
      archivePendingLabel,
      archiveShortcutKeys,
      archiveStatus,
      canFork,
      deletePendingLabel,
      deleteStatus,
      isForking,
      isPinned,
      isTouchInteraction,
      onArchive,
      onCopyBranchName,
      onCopyPath,
      onDelete,
      onFork,
      onMarkAsRead,
      onReferenceContent,
      onRename,
      onTogglePin,
      referenceContentStatus,
      touchKebab.menuProps,
      touchKebab.showKebab,
      workspace.labels,
      workspace.rootAgents,
      workspace.serverId,
      workspace.workspaceDirectory,
      workspace.workspaceId,
      workspace.workspaceKey,
    ],
  );

  return (
    <SidebarWorkspaceRowFrame workspace={workspace} isDragging={isDragging}>
      {({ isHovered, contextMenuOpen, onContextMenuOpenChange, hoverHandlers }) => {
        const {
          showTrailing,
          showKebab: showKebabInSlot,
          showScrim,
          renderSlot,
          reserveSlotWidth,
        } = resolveTrailingActionVisibility({
          workspace,
          hasArchiveAction: Boolean(onArchive),
          selected,
          isHovered,
          isTouchInteraction: false,
          showPersistentActions,
          showShortcut,
        });
        const workspaceRowStyle = getStatusWorkspaceRowStyle({
          isPressed,
          selected,
          isHovered,
          inStatusGroup,
          isDragging,
          isTouchInteraction,
        });
        const backdrop = getSidebarRowBackdrop({ isDragging, isPressed, selected, isHovered });
        const trailingContent = (() => {
          if (isTouchInteraction) {
            return touchTrailingVisibility.showTrailing ? (
              <SidebarWorkspaceTrailingContent workspace={workspace} />
            ) : null;
          }
          if (!renderSlot) return null;
          return (
            <StatusWorkspaceActionSlot
              workspace={workspace}
              backdrop={backdrop}
              showBase={showTrailing}
              showKebab={showKebabInSlot}
              showScrim={showScrim}
              isHovered={isHovered}
              disabled={isArchiving || isDeleting || isForking}
              isForking={isForking}
              canFork={canFork}
              reserveSlotWidth={reserveSlotWidth}
              isPinned={isPinned}
              onTogglePin={onTogglePin}
              onCopyPath={onCopyPath}
              onCopyBranchName={onCopyBranchName}
              onReferenceContent={onReferenceContent}
              referenceContentStatus={referenceContentStatus}
              onRename={onRename}
              onMarkAsRead={onMarkAsRead}
              onArchive={onArchive}
              onDelete={onDelete}
              deleteStatus={deleteStatus}
              deletePendingLabel={deletePendingLabel}
              onFork={onFork}
              archiveLabel={archiveLabel}
              archiveStatus={archiveStatus}
              archivePendingLabel={archivePendingLabel}
              archiveShortcutKeys={archiveShortcutKeys}
            />
          );
        })();
        return (
          <View
            {...(rowDragEnabled ? dragAttributes : undefined)}
            {...(rowDragEnabled && !rename ? dragHandleProps?.listeners : undefined)}
            ref={
              rowDragEnabled
                ? (dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>)
                : undefined
            }
            style={styles.workspaceRowContainer}
            {...hoverHandlers}
          >
            <SidebarWorkspaceContextMenu
              contextMenuOpen={contextMenuOpen}
              onContextMenuOpenChange={onContextMenuOpenChange}
              enableTouchLongPress={isTouchInteraction}
              workspace={workspace}
              leadingProjectName={projectName}
              hostBadgeLabel={hostBadge?.label}
              serviceSummary={serviceSummary}
              workspaceKey={workspace.workspaceKey}
              onCopyPath={onCopyPath}
              onCopyBranchName={onCopyBranchName}
              onReferenceContent={onReferenceContent}
              referenceContentStatus={referenceContentStatus}
              onRename={onRename}
              onMarkAsRead={onMarkAsRead}
              onFork={canFork ? onFork : undefined}
              forkPending={isForking}
              onArchive={onArchive}
              onDelete={onDelete}
              deleteStatus={deleteStatus}
              deletePendingLabel={deletePendingLabel}
              archiveLabel={archiveLabel}
              archiveStatus={archiveStatus}
              archivePendingLabel={archivePendingLabel}
              archiveShortcutKeys={archiveShortcutKeys}
              isPinned={isPinned}
              onTogglePin={onTogglePin}
              openInFileManagerPath={workspace.workspaceDirectory}
              disabled={isArchiving || isDeleting || isForking}
              accessibilityRole="button"
              accessibilityState={accessibilityState}
              style={workspaceRowStyle}
              highlightStyle={styles.workspaceRowPressed}
              onPressIn={handlePressIn}
              onTouchMove={rowDragEnabled && !rename ? moveDragPress : undefined}
              onPressOut={handlePressOut}
              onPress={handlePress}
              testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
            >
              <SidebarWorkspaceRowContent
                workspace={workspace}
                hostBadge={hostBadge}
                leadingProjectName={projectName}
                leadingProjectIconDataUri={projectIconDataUri}
                serviceSummary={serviceSummary}
                backdrop={backdrop}
                selected={selected}
                isHovered={isHovered}
                isLoading={isArchiving || isDeleting || isForking}
                shortcutNumber={shortcutNumber}
                showShortcutBadge={showShortcutBadge}
                rename={rename}
                reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
                trailingAccessory={touchTrailingAccessory}
              >
                {trailingContent}
              </SidebarWorkspaceRowContent>
            </SidebarWorkspaceContextMenu>
          </View>
        );
      }}
    </SidebarWorkspaceRowFrame>
  );
}

function StatusWorkspaceActionSlot({
  workspace,
  backdrop,
  showBase,
  showKebab,
  showScrim,
  isHovered,
  disabled,
  isForking,
  canFork,
  reserveSlotWidth,
  isPinned,
  onTogglePin,
  onCopyPath,
  onCopyBranchName,
  onReferenceContent,
  referenceContentStatus,
  onRename,
  onMarkAsRead,
  onArchive,
  onDelete,
  deleteStatus,
  deletePendingLabel,
  onFork,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
}: {
  workspace: SidebarWorkspaceEntry;
  backdrop: SidebarSurfaceBackdrop;
  showBase: boolean;
  showKebab: boolean;
  showScrim: boolean;
  reserveSlotWidth: boolean;
  isHovered: boolean;
  disabled: boolean;
  isForking: boolean;
  canFork: boolean;
  isPinned?: boolean;
  onTogglePin?: () => void;
  onCopyPath?: () => void;
  onCopyBranchName?: () => void;
  onReferenceContent?: () => void;
  referenceContentStatus?: "idle" | "pending" | "success";
  onRename?: () => void;
  onMarkAsRead?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  deleteStatus?: "idle" | "pending" | "success";
  deletePendingLabel?: string;
  onFork?: () => void;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
}) {
  const kebab = useOpenKebabMenuVisibility(showKebab);
  return (
    <SidebarWorkspaceTrailingActionSlot reserveWidth={reserveSlotWidth}>
      <SidebarWorkspaceTrailingActionBase visible={showBase}>
        <SidebarWorkspaceTrailingContent workspace={workspace} />
      </SidebarWorkspaceTrailingActionBase>
      <SidebarWorkspaceTrailingActionOverlay
        visible={kebab.showKebab}
        scrimBackdrop={showScrim ? backdrop : undefined}
      >
        <SidebarWorkspaceQuickActions
          workspaceKey={workspace.workspaceKey}
          onDelete={onDelete}
          onArchive={onArchive}
          archiveLabel={archiveLabel}
          deleteStatus={deleteStatus}
          archiveStatus={archiveStatus}
          disabled={disabled || isForking}
          visible={isHovered}
        />
        {kebab.showKebab && onArchive ? (
          <SidebarWorkspaceMenu
            {...kebab.menuProps}
            workspaceKey={workspace.workspaceKey}
            serverId={workspace.serverId}
            workspaceId={workspace.workspaceId}
            workspaceLabels={workspace.labels}
            rootAgents={workspace.rootAgents}
            onCopyPath={onCopyPath}
            onCopyBranchName={onCopyBranchName}
            onReferenceContent={onReferenceContent}
            referenceContentStatus={referenceContentStatus}
            onFork={canFork ? onFork : undefined}
            forkPending={isForking}
            openInFileManagerPath={workspace.workspaceDirectory}
            onRename={onRename}
            onMarkAsRead={onMarkAsRead}
            onArchive={onArchive}
            onDelete={onDelete}
            deleteStatus={deleteStatus}
            deletePendingLabel={deletePendingLabel}
            archiveLabel={archiveLabel}
            archiveStatus={archiveStatus}
            archivePendingLabel={archivePendingLabel}
            archiveShortcutKeys={archiveShortcutKeys}
            isPinned={isPinned}
            onTogglePin={onTogglePin}
          />
        ) : null}
      </SidebarWorkspaceTrailingActionOverlay>
    </SidebarWorkspaceTrailingActionSlot>
  );
}

function getStatusWorkspaceRowStyle({
  isPressed,
  selected,
  isHovered,
  inStatusGroup,
  isDragging,
  isTouchInteraction,
}: {
  isPressed: boolean;
  selected: boolean;
  isHovered: boolean;
  inStatusGroup: boolean;
  isDragging: boolean;
  isTouchInteraction: boolean;
}) {
  return [
    styles.workspaceRow,
    isTouchInteraction && styles.workspaceRowTouch,
    inStatusGroup && sidebarWorkspaceRowStyles.rowIndented,
    !isTouchInteraction && isHovered && styles.workspaceRowHovered,
    selected && styles.sidebarRowSelected,
    isDragging && styles.workspaceRowDragging,
    isPressed && styles.workspaceRowPressed,
  ];
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: SIDEBAR_LIST_INSET,
    // Keep status mode's section boundary identical to project mode.
    paddingTop: 2,
    paddingBottom: theme.spacing[4],
  },
  statusGroupBlockExpanded: {
    paddingBottom: theme.spacing[2],
  },
  statusWorkspaceListContainer: {},
  statusGroupRow: {
    minHeight: 32,
    paddingVertical: theme.spacing[1.5],
    marginHorizontal: -SIDEBAR_LIST_INSET,
    paddingHorizontal: theme.spacing[2] + SIDEBAR_LIST_INSET,
    marginBottom: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  statusGroupRowTouch: {
    minHeight: TOUCH_LIST_ROW_HEIGHT,
    paddingVertical: theme.spacing[0.5],
  },
  statusGroupRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  statusGroupRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  statusGroupRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  statusGroupLeadingVisualSlot: {
    position: "relative",
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  statusGroupTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  statusGroupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
  workspaceRowContainer: {
    position: "relative",
  },
  workspaceRow: {
    minHeight: buttonControlHeight.xs,
    marginBottom: 0,
    marginHorizontal: -SIDEBAR_LIST_INSET,
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[2] + SIDEBAR_LIST_INSET,
    paddingRight: theme.spacing[2] + SIDEBAR_LIST_INSET,
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "flex-start",
    gap: theme.spacing[0.5],
    userSelect: "none",
  },
  workspaceRowTouch: {
    minHeight: TOUCH_LIST_ROW_HEIGHT,
    paddingVertical: theme.spacing[0.5],
    justifyContent: "center",
  },
  workspaceRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  workspaceRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  workspaceRowDragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    transform: [{ scale: 1.02 }],
    zIndex: 3,
    ...theme.shadow.md,
  },
  sidebarRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
}));
