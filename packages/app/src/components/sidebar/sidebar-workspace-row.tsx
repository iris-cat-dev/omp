import { memo, useCallback, useMemo, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { View, Text, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import type { HostBadgeModel } from "@/hosts/appearance";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { toWorktreeArchiveRisk } from "@/git/worktree-archive-warning";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useClearWorkspaceAttention } from "@/hooks/use-clear-workspace-attention";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";
import { SIDEBAR_LIST_INSET } from "@/constants/layout";
import { useShowPersistentActions, useTouchInteraction } from "@/hooks/use-fine-pointer";
import { buttonControlHeight, TOUCH_LIST_ROW_HEIGHT } from "@/components/ui/control-geometry";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import {
  SidebarWorkspaceContextMenu,
  SidebarWorkspaceMenu,
} from "@/components/sidebar/sidebar-workspace-menu";
import { sidebarWorkspaceArchiveLabelKey } from "@/components/sidebar/sidebar-workspace-title";
import {
  SidebarWorkspaceRowFrame,
  SidebarWorkspaceRowContent,
  resolveTrailingActionVisibility,
  SidebarWorkspaceTrailingActionBase,
  SidebarWorkspaceTrailingActionOverlay,
  SidebarWorkspaceTrailingActionSlot,
} from "@/components/sidebar/sidebar-workspace-row-content";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { getSidebarRowBackdrop } from "@/components/sidebar/sidebar-row-backdrop";
import { selectWorkspaceServiceSummary } from "@/components/sidebar/workspace-meta-row";
import { SidebarWorkspaceTrailingContent } from "@/components/sidebar/workspace-trailing";
import { useReferenceWorkspaceContent } from "@/components/sidebar/use-reference-workspace-content";

function noop() {}

interface SidebarWorkspaceRowProps {
  workspace: SidebarWorkspaceEntry;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canCopyBranchName: boolean;
  onPress: () => void;
  /** The host pill after the title. Absent → the sidebar spans one host, or this one is hidden. */
  hostBadge?: HostBadgeModel | null;
  /** Project grouping only: shows a transient "creating" affordance. */
  isCreating?: boolean;
  /** Project grouping only: drag-to-reorder wiring. Absent → not draggable. */
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

export function SidebarWorkspaceRow({
  workspace,
  selected,
  shortcutNumber,
  showShortcutBadge,
  canCopyBranchName,
  onPress,
  hostBadge,
  isCreating = false,
  drag,
  isDragging = false,
  dragHandleProps,
}: SidebarWorkspaceRowProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const activeRouteWorkspaceSelection = useActiveWorkspaceSelection();
  const [isHidingWorkspace, setIsHidingWorkspace] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const isArchiving = workspace.archivingAt !== null || isHidingWorkspace;
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
    if (isArchiving) {
      return;
    }
    archiveController.archive();
  }, [archiveController, isArchiving]);

  const handleCopyPath = useCallback(() => {
    let copyTargetDirectory: string;
    try {
      copyTargetDirectory = requireWorkspaceDirectory({
        workspaceId: workspace.workspaceId,
        workspaceDirectory: workspace.workspaceDirectory,
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("sidebar.workspace.toasts.workspacePathUnavailable"),
      );
      return;
    }
    void Clipboard.setStringAsync(copyTargetDirectory);
    toast.copied(t("sidebar.workspace.toasts.pathCopied"));
  }, [t, toast, workspace.workspaceDirectory, workspace.workspaceId]);

  const handleCopyBranchName = useCallback(() => {
    if (!workspace.currentBranch) {
      return;
    }
    void Clipboard.setStringAsync(workspace.currentBranch);
    toast.copied(t("sidebar.workspace.toasts.branchNameCopied"));
  }, [t, toast, workspace.currentBranch]);

  const renameMutation = useMutation({
    mutationFn: async (title: string) => {
      const client = getHostRuntimeStore().getClient(workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      await client.setWorkspaceTitle(workspace.workspaceId, title.length === 0 ? null : title);
    },
  });

  const handleOpenRename = useCallback(() => {
    setIsRenameOpen(true);
  }, []);

  const handleCloseRename = useCallback(() => {
    setIsRenameOpen(false);
  }, []);

  const handleSubmitRename = useCallback(
    async (value: string) => {
      await renameMutation.mutateAsync(value.trim());
    },
    [renameMutation],
  );

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
    enabled: selected && !isArchiving,
    priority: 0,
    handle: () => {
      handleArchive();
      return true;
    },
  });

  return (
    <>
      <WorkspaceRowBody
        workspace={workspace}
        selected={selected}
        shortcutNumber={shortcutNumber}
        showShortcutBadge={showShortcutBadge}
        hostBadge={hostBadge}
        isCreating={isCreating}
        isArchiving={isArchiving}
        onPress={onPress}
        drag={drag}
        isDragging={isDragging}
        dragHandleProps={dragHandleProps}
        archiveLabel={t(sidebarWorkspaceArchiveLabelKey(workspace))}
        archiveStatus={isArchiving ? "pending" : "idle"}
        archivePendingLabel={t("sidebar.workspace.actions.archiving")}
        onArchive={handleArchive}
        onCopyBranchName={canCopyBranchName ? handleCopyBranchName : undefined}
        onCopyPath={handleCopyPath}
        onReferenceContent={canReferenceContent ? referenceContent : undefined}
        referenceContentStatus={isReferencingContent ? "pending" : "idle"}
        onRename={handleOpenRename}
        onMarkAsRead={hasClearableAttention ? handleMarkAsRead : undefined}
        archiveShortcutKeys={selected ? archiveShortcutKeys : null}
      />
      <AdaptiveRenameModal
        visible={isRenameOpen}
        title={t("sidebar.workspace.rename.title")}
        initialValue={workspace.title ?? workspace.name}
        placeholder={workspace.name}
        submitLabel={t("sidebar.workspace.rename.submit")}
        onClose={handleCloseRename}
        onSubmit={handleSubmitRename}
        testID={`sidebar-workspace-rename-modal-${workspace.workspaceKey}`}
      />
    </>
  );
}

interface WorkspaceRowBodyProps {
  workspace: SidebarWorkspaceEntry;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  hostBadge?: HostBadgeModel | null;
  isCreating: boolean;
  isArchiving: boolean;
  onPress: () => void;
  drag?: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  onArchive?: () => void;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onReferenceContent?: () => void;
  referenceContentStatus?: "idle" | "pending" | "success";
  onRename?: () => void;
  onMarkAsRead?: () => void;
  archiveShortcutKeys?: ShortcutKey[][] | null;
}

function WorkspaceRowBody({
  workspace,
  selected,
  shortcutNumber,
  showShortcutBadge,
  hostBadge,
  isCreating,
  isArchiving,
  onPress,
  drag,
  isDragging,
  dragHandleProps,
  archiveLabel,
  archiveStatus = "idle",
  archivePendingLabel,
  onArchive,
  onCopyBranchName,
  onCopyPath,
  onReferenceContent,
  referenceContentStatus,
  onRename,
  onMarkAsRead,
  archiveShortcutKeys,
}: WorkspaceRowBodyProps) {
  const { t } = useTranslation();
  const isTouchInteraction = useTouchInteraction();
  const [isPressed, setIsPressed] = useState(false);
  const rowDragEnabled = Boolean(drag) && !isTouchInteraction;
  const interaction = useLongPressDragInteraction({
    drag: drag ?? noop,
    menuController: null,
    enabled: rowDragEnabled,
  });
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

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

  const handlePress = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    onPress();
  }, [interaction.didLongPressRef, onPress]);
  const handleWorkspacePressIn = useCallback(
    (event: GestureResponderEvent) => {
      setIsPressed(true);
      if (rowDragEnabled) interaction.handlePressIn(event);
    },
    [interaction, rowDragEnabled],
  );
  const handleWorkspacePressOut = useCallback(() => {
    setIsPressed(false);
    if (rowDragEnabled) interaction.handlePressOut();
  }, [interaction, rowDragEnabled]);

  const accessibilityState = useMemo(() => ({ selected }), [selected]);

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
          openInFileManagerPath={workspace.workspaceDirectory}
          onRename={onRename}
          onMarkAsRead={onMarkAsRead}
          onArchive={onArchive}
          archiveLabel={archiveLabel}
          archiveStatus={archiveStatus}
          archivePendingLabel={archivePendingLabel}
          archiveShortcutKeys={archiveShortcutKeys}
        />
      ) : null,
    [
      archiveLabel,
      archivePendingLabel,
      archiveShortcutKeys,
      archiveStatus,
      isTouchInteraction,
      onArchive,
      onCopyBranchName,
      onCopyPath,
      onMarkAsRead,
      onReferenceContent,
      onRename,
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
        const isDesktop = !isTouchInteraction;
        const serviceSummary = isDesktop ? selectWorkspaceServiceSummary(workspace.scripts) : null;
        const workspaceRowStyle = getWorkspaceRowStyle({
          isDragging,
          isPressed,
          selected,
          isHovered,
          isTouchInteraction,
        });
        const backdrop = getSidebarRowBackdrop({ isDragging, isPressed, selected, isHovered });
        return (
          <View
            {...(rowDragEnabled ? dragAttributes : {})}
            {...(rowDragEnabled ? dragHandleProps?.listeners : {})}
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
              hostBadgeLabel={hostBadge?.label}
              serviceSummary={serviceSummary}
              workspaceKey={workspace.workspaceKey}
              onCopyPath={onCopyPath}
              onCopyBranchName={onCopyBranchName}
              onReferenceContent={onReferenceContent}
              referenceContentStatus={referenceContentStatus}
              onRename={onRename}
              onMarkAsRead={onMarkAsRead}
              onArchive={onArchive}
              archiveLabel={archiveLabel}
              archiveStatus={archiveStatus}
              archivePendingLabel={archivePendingLabel}
              archiveShortcutKeys={archiveShortcutKeys}
              openInFileManagerPath={workspace.workspaceDirectory}
              disabled={isArchiving}
              aria-selected={selected}
              accessibilityRole="button"
              accessibilityState={accessibilityState}
              style={workspaceRowStyle}
              highlightStyle={styles.workspaceRowPressed}
              onPressIn={handleWorkspacePressIn}
              onTouchMove={rowDragEnabled ? interaction.handleTouchMove : undefined}
              onPressOut={handleWorkspacePressOut}
              onPress={handlePress}
              testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
            >
              <SidebarWorkspaceRowContent
                workspace={workspace}
                hostBadge={hostBadge}
                serviceSummary={serviceSummary}
                backdrop={backdrop}
                selected={selected}
                isHovered={isHovered}
                isLoading={isArchiving || isCreating}
                isCreating={isCreating}
                shortcutNumber={shortcutNumber}
                showShortcutBadge={showShortcutBadge}
                trailingAccessory={touchTrailingAccessory}
              >
                {isTouchInteraction ? (
                  <>
                    {isCreating ? (
                      <Text style={styles.workspaceCreatingText}>
                        {t("sidebar.workspace.status.creating")}
                      </Text>
                    ) : null}
                    {touchTrailingVisibility.showTrailing ? (
                      <SidebarWorkspaceTrailingContent workspace={workspace} />
                    ) : null}
                  </>
                ) : (
                  <WorkspaceRowTrailingActions
                    workspace={workspace}
                    backdrop={backdrop}
                    selected={selected}
                    isHovered={isHovered}
                    isCreating={isCreating}
                    showShortcutBadge={showShortcutBadge}
                    shortcutNumber={shortcutNumber}
                    archiveLabel={archiveLabel}
                    archiveStatus={archiveStatus}
                    archivePendingLabel={archivePendingLabel}
                    archiveShortcutKeys={archiveShortcutKeys}
                    onArchive={onArchive}
                    onCopyBranchName={onCopyBranchName}
                    onCopyPath={onCopyPath}
                    onReferenceContent={onReferenceContent}
                    referenceContentStatus={referenceContentStatus}
                    onRename={onRename}
                    onMarkAsRead={onMarkAsRead}
                  />
                )}
              </SidebarWorkspaceRowContent>
            </SidebarWorkspaceContextMenu>
          </View>
        );
      }}
    </SidebarWorkspaceRowFrame>
  );
}

function WorkspaceRowTrailingActions({
  workspace,
  backdrop,
  selected,
  isHovered,
  isCreating,
  showShortcutBadge,
  shortcutNumber,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  onArchive,
  onMarkAsRead,
  onCopyBranchName,
  onCopyPath,
  onReferenceContent,
  referenceContentStatus,
  onRename,
}: {
  workspace: SidebarWorkspaceEntry;
  backdrop: SidebarSurfaceBackdrop;
  selected: boolean;
  isHovered: boolean;
  isCreating: boolean;
  showShortcutBadge: boolean;
  shortcutNumber: number | null;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  onArchive?: () => void;
  onMarkAsRead?: () => void;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onReferenceContent?: () => void;
  referenceContentStatus?: "idle" | "pending" | "success";
  onRename?: () => void;
}) {
  const { t } = useTranslation();
  const showPersistentActions = useShowPersistentActions();
  const showShortcut = showShortcutBadge && shortcutNumber !== null;
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
  const kebab = useOpenKebabMenuVisibility(showKebabInSlot);

  return (
    <>
      {isCreating ? (
        <Text style={styles.workspaceCreatingText}>{t("sidebar.workspace.status.creating")}</Text>
      ) : null}
      {renderSlot ? (
        <SidebarWorkspaceTrailingActionSlot reserveWidth={reserveSlotWidth}>
          <SidebarWorkspaceTrailingActionBase visible={showTrailing}>
            <SidebarWorkspaceTrailingContent workspace={workspace} />
          </SidebarWorkspaceTrailingActionBase>
          <SidebarWorkspaceTrailingActionOverlay
            visible={kebab.showKebab}
            scrimBackdrop={showScrim ? backdrop : undefined}
          >
            {onArchive ? (
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
                openInFileManagerPath={workspace.workspaceDirectory}
                onRename={onRename}
                onMarkAsRead={onMarkAsRead}
                onArchive={onArchive}
                archiveLabel={archiveLabel}
                archiveStatus={archiveStatus}
                archivePendingLabel={archivePendingLabel}
                archiveShortcutKeys={archiveShortcutKeys}
              />
            ) : null}
          </SidebarWorkspaceTrailingActionOverlay>
        </SidebarWorkspaceTrailingActionSlot>
      ) : null}
    </>
  );
}

function getWorkspaceRowStyle({
  isDragging,
  isPressed,
  selected,
  isHovered,
  isTouchInteraction,
}: {
  isDragging: boolean;
  isPressed: boolean;
  selected: boolean;
  isHovered: boolean;
  isTouchInteraction: boolean;
}) {
  return [
    styles.workspaceRow,
    isTouchInteraction && styles.workspaceRowTouch,
    !isTouchInteraction && isHovered && styles.workspaceRowHovered,
    selected && styles.sidebarRowSelected,
    isDragging && styles.workspaceRowDragging,
    isPressed && styles.workspaceRowPressed,
  ];
}

export const MemoSidebarWorkspaceRow = memo(SidebarWorkspaceRow);

const styles = StyleSheet.create((theme) => ({
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
    justifyContent: "center",
    gap: theme.spacing[0.5],
    userSelect: "none",
  },
  workspaceRowTouch: {
    minHeight: TOUCH_LIST_ROW_HEIGHT,
    paddingVertical: theme.spacing[0.5],
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
  workspaceCreatingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
}));
