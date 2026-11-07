import { memo, useMemo, useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { resolveSidebarWorkspacePrimaryLabel } from "@/components/sidebar/sidebar-workspace-title";
import { Text, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleAlert, Folder, FolderGit2, Monitor, Pin } from "lucide-react-native";
import { ProjectStatusIndicator } from "@/components/sidebar/project-leading-visual";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";
import {
  WorkspaceMetaRow,
  type WorkspaceServiceSummary,
} from "@/components/sidebar/workspace-meta-row";
import { WorkspaceHoverCard } from "@/components/workspace-hover-card";
import type { HostBadgeModel } from "@/hosts/appearance";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { SIDEBAR_LIST_INSET } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import {
  STATUS_INDICATOR_ALERT_SIZE,
  STATUS_INDICATOR_DOT_SIZE,
  STATUS_INDICATOR_FILLED_DOT_SIZE,
} from "@/utils/status-indicator-geometry";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";
import { StatusRing } from "@/components/status-ring";
import { TrailingActionScrim } from "@/components/ui/trailing-action-scrim";
import { useWorkspaceLabelDefinitions } from "@/workspace-labels";
import {
  SidebarWorkspaceInlineRename,
  type SidebarWorkspaceRename,
} from "@/components/sidebar/sidebar-workspace-inline-rename";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const needsInputColorMapping = (theme: Theme) => ({
  color: theme.colors.surface0,
  fill: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
});

const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedFolder = withUnistyles(Folder);
const ThemedFolderGit2 = withUnistyles(FolderGit2);
const ThemedPin = withUnistyles(Pin);

export function SidebarWorkspaceRowFrame({
  workspace,
  isDragging = false,
  children,
}: {
  workspace: SidebarWorkspaceEntry;
  isDragging?: boolean;
  children: (input: {
    isHovered: boolean;
    contextMenuOpen: boolean;
    onContextMenuOpenChange: (open: boolean) => void;
    hoverHandlers: {
      onPointerEnter: () => void;
      onPointerLeave: () => void;
      onFocus: () => void;
      onBlur: () => void;
    };
  }) => ReactNode;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const handlePointerEnter = useCallback(() => {
    if (!contextMenuOpen) setIsHovered(true);
  }, [contextMenuOpen]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleFocus = useCallback(() => setIsFocused(true), []);
  const handleBlur = useCallback(() => setIsFocused(false), []);
  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    setContextMenuOpen(open);
    if (open) setIsHovered(false);
  }, []);
  const hoverHandlers = useMemo(
    () => ({
      onPointerEnter: handlePointerEnter,
      onPointerLeave: handlePointerLeave,
      onFocus: handleFocus,
      onBlur: handleBlur,
    }),
    [handlePointerEnter, handlePointerLeave, handleFocus, handleBlur],
  );

  return (
    <WorkspaceHoverCard
      workspace={workspace}
      prHint={workspace.prHint}
      isDragging={isDragging}
      disabled={contextMenuOpen}
    >
      {children({
        isHovered: (isHovered || isFocused) && !contextMenuOpen && !isDragging,
        contextMenuOpen,
        onContextMenuOpenChange: handleContextMenuOpenChange,
        hoverHandlers,
      })}
    </WorkspaceHoverCard>
  );
}

export const SidebarWorkspaceRowContent = memo(function SidebarWorkspaceRowContent({
  workspace,
  hostBadge,
  leadingProjectName = null,
  leadingProjectIconDataUri = null,
  serviceSummary = null,
  backdrop,
  isHovered,
  selected,
  isLoading,
  isCreating = false,
  shortcutNumber = null,
  showShortcutBadge = false,
  reserveIdleStatusIndicatorSpace = true,
  rename,
  children,
}: {
  workspace: SidebarWorkspaceEntry;
  hostBadge?: HostBadgeModel | null;
  /** Hoisted rows use their project icon as the leading visual because no project row contains them. */
  leadingProjectName?: string | null;
  leadingProjectIconDataUri?: string | null;
  serviceSummary?: WorkspaceServiceSummary | null;
  /** The row's current background, so the project status badge can knock out of it. */
  backdrop: SidebarSurfaceBackdrop;
  selected: boolean;
  isHovered: boolean;
  isLoading: boolean;
  isCreating?: boolean;
  shortcutNumber?: number | null;
  showShortcutBadge?: boolean;
  /** Keep the empty leading slot when the workspace has no active status. */
  reserveIdleStatusIndicatorSpace?: boolean;
  rename?: SidebarWorkspaceRename;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  // The workspace carries label names; their colors live in its host's catalog, so the row is
  // where the two meet — the meta line is handed finished definitions.
  const labels = useWorkspaceLabelDefinitions(workspace.serverId, workspace.labels);
  const workspaceTitleTextStyle = useMemo(
    () => [
      styles.workspaceTitleText,
      (selected || isHovered) && styles.workspaceTitleTextHighlighted,
      isCreating && styles.workspaceTitleTextCreating,
    ],
    [selected, isHovered, isCreating],
  );

  return (
    <View style={styles.workspaceRowContent}>
      <View style={styles.workspaceRowMain}>
        {leadingProjectName ? (
          <ProjectStatusIndicator
            iconDataUri={leadingProjectIconDataUri}
            displayName={leadingProjectName}
            projectViewKey={workspace.projectViewKey}
            statusBucket={workspace.statusBucket}
            backdrop={backdrop}
            loading={isLoading}
            testID={`sidebar-row-project-icon-${workspace.workspaceKey}`}
          />
        ) : (
          <WorkspaceStatusIndicator
            bucket={workspace.statusBucket}
            workspaceKind={workspace.workspaceKind}
            loading={isLoading}
            reserveIdleSpace={reserveIdleStatusIndicatorSpace}
          />
        )}
        <View style={styles.workspaceContentColumn}>
          <View style={styles.workspaceTitleRow}>
            {workspace.pinnedAt != null ? (
              <ThemedPin
                size={12}
                uniProps={foregroundMutedColorMapping}
                accessibilityLabel="Pinned"
              />
            ) : null}
            {rename ? (
              <SidebarWorkspaceInlineRename workspaceKey={workspace.workspaceKey} rename={rename} />
            ) : (
              <Text style={workspaceTitleTextStyle} numberOfLines={1}>
                {resolveSidebarWorkspacePrimaryLabel(workspace, t("sidebar.workspace.status.unstarted"))}
              </Text>
            )}
            {!rename ? <View style={sidebarWorkspaceRowStyles.rowRight}>{children}</View> : null}
          </View>
          <WorkspaceMetaRow
            currentBranch={workspace.isUnstarted ? workspace.currentBranch : null}
            projectName={leadingProjectName}
            hostBadge={hostBadge ?? null}
            prHint={workspace.prHint}
            serviceSummary={serviceSummary}
            labels={labels}
          />
        </View>
      </View>
      {!rename && showShortcutBadge && shortcutNumber !== null ? (
        <View style={styles.shortcutBadgeOverlay} pointerEvents="none">
          <SidebarWorkspaceShortcutBadge number={shortcutNumber} />
        </View>
      ) : null}
    </View>
  );
});

function WorkspaceStatusIndicator({
  bucket,
  workspaceKind,
  loading = false,
  reserveIdleSpace = true,
}: {
  bucket: SidebarWorkspaceEntry["statusBucket"];
  workspaceKind: SidebarWorkspaceEntry["workspaceKind"];
  loading?: boolean;
  reserveIdleSpace?: boolean;
}) {
  // Busy is the only status that moves, and it is the ring rather than a dot for the same
  // reason it is a dot elsewhere: every status in the sidebar sits in this one slot, so busy
  // has to fill it without displacing anything. A row starting up and a row working are both
  // busy, so they share the ring and differ only in testID.
  if (loading) {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-loading">
        <StatusRing />
      </View>
    );
  }

  if (shouldRenderSyncedStatusLoader({ bucket })) {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-running">
        <StatusRing />
      </View>
    );
  }

  if (bucket === "needs_input") {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-needs_input">
        <ThemedCircleAlert size={STATUS_INDICATOR_ALERT_SIZE} uniProps={needsInputColorMapping} />
      </View>
    );
  }

  if (bucket === "attention") {
    return (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-attention">
        <View style={styles.standaloneStatusDot} />
      </View>
    );
  }

  if (bucket === "done") {
    // An idle row still gets a dot rather than an empty slot. Nested rows are marked as
    // workspaces by indentation alone, and with nothing in the leading slot the rail has no
    // edge to read against — a workspace carrying its own glyph starts looking like a project
    // header. The dot is muted to half opacity so it holds the rail without reporting status.
    return reserveIdleSpace ? (
      <View style={styles.workspaceStatusDot} testID="workspace-status-indicator-done">
        <View style={styles.idleStatusDot} />
      </View>
    ) : null;
  }

  let KindIcon: typeof ThemedMonitor;
  if (workspaceKind === "local_checkout") KindIcon = ThemedMonitor;
  else if (workspaceKind === "worktree") KindIcon = ThemedFolderGit2;
  else KindIcon = ThemedFolder;

  const dotColorStyle = getStatusDotColorStyle(bucket);
  return (
    <View style={styles.workspaceStatusDot} testID={`workspace-status-indicator-${bucket}`}>
      <KindIcon size={14} uniProps={foregroundMutedColorMapping} />
      {dotColorStyle ? <StatusDotOverlay dotColorStyle={dotColorStyle} /> : null}
    </View>
  );
}

function StatusDotOverlay({ dotColorStyle }: { dotColorStyle: ViewStyle }) {
  return <View style={[styles.statusDotOverlay, dotColorStyle]} />;
}

function getStatusDotColorStyle(bucket: SidebarStateBucket) {
  switch (bucket) {
    case "needs_input":
      return styles.statusDotNeedsInput;
    case "failed":
      return styles.statusDotFailed;
    case "running":
      return styles.statusDotRunning;
    case "attention":
      return styles.statusDotAttention;
    case "done":
      return null;
  }
}

export const sidebarWorkspaceRowStyles = StyleSheet.create((theme) => ({
  // How far a workspace row sits inside the group header above it — a project row or a
  // status group header. Both groupings share this one indent, so every grouped workspace row
  // in the sidebar sits on the same rail regardless of how the list is grouped. Pinned rows
  // are not grouped and stay flush.
  //
  // It is row padding rather than a margin on the list, because the row's hover and selected
  // backgrounds have to keep spanning the group's full width. Indenting the container instead
  // pulls the highlight in with the content and the row stops lining up with its header.
  rowIndented: {
    paddingLeft: theme.spacing[2] + theme.spacing[2] + SIDEBAR_LIST_INSET,
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  shortcutBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
    flexShrink: 0,
  },
  shortcutBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    lineHeight: 14,
  },
  hidden: { opacity: 0 },
  // Stays position:relative at zero width so the absolutely-positioned kebab keeps
  // anchoring to the same right edge whether or not the slot holds anything.
  trailingActionSlot: {
    position: "relative",
    minHeight: 20,
    flexShrink: 0,
    alignItems: "flex-end",
    justifyContent: "flex-start",
  },
  trailingActionSlotReserved: {
    position: "relative",
    minWidth: 18,
    minHeight: 20,
    flexShrink: 0,
    alignItems: "flex-end",
    justifyContent: "flex-start",
  },
  trailingActionOverlay: {
    position: "absolute",
    top: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    right: 0,
  },
}));

export function SidebarWorkspaceShortcutBadge({ number }: { number: number }) {
  return (
    <View style={sidebarWorkspaceRowStyles.shortcutBadge}>
      <Text style={sidebarWorkspaceRowStyles.shortcutBadgeText}>{number}</Text>
    </View>
  );
}

/**
 * Activity timestamp and hover actions, shared by the project-mode and status-mode rows.
 *
 * The trailing content survives the kebab on hover and fades under the scrim instead of
 * blinking out. Touch has no hover, so its permanent kebab still hides the content outright
 * rather than scrimming an unhovered row whose background doesn't match the gradient.
 */
export function resolveTrailingActionVisibility({
  workspace,
  hasArchiveAction,
  isHovered,
  isTouchPlatform,
  showPersistentActions = false,
  showShortcut,
}: {
  workspace: SidebarWorkspaceEntry;
  hasArchiveAction: boolean;
  isHovered: boolean;
  isTouchPlatform: boolean;
  showPersistentActions?: boolean;
  showShortcut: boolean;
}): {
  showTrailing: boolean;
  showKebab: boolean;
  showScrim: boolean;
  renderSlot: boolean;
  reserveSlotWidth: boolean;
} {
  const hasTrailing = workspace.statusEnteredAt !== null;
  const persistent = isTouchPlatform || showPersistentActions;
  const showKebab =
    Boolean(hasArchiveAction && (isHovered || persistent)) && (!showShortcut || isHovered);
  const showTrailing = hasTrailing && !showShortcut && (isHovered || !showKebab);
  return {
    showTrailing,
    showKebab,
    // The scrim paints the row's own hover background, so it can only be drawn on a hovered
    // row — over an unhovered one the gradient fades to the wrong color. That is also why
    // touch, which shows the kebab without ever hovering, never gets one.
    showScrim: showKebab && isHovered,
    renderSlot: hasArchiveAction || hasTrailing,
    // Reserve space when the action stays visible, including hybrid and keyboard-only input.
    reserveSlotWidth: hasTrailing || (hasArchiveAction && persistent),
  };
}

export function SidebarWorkspaceTrailingActionSlot({
  reserveWidth,
  children,
}: {
  reserveWidth: boolean;
  children: ReactNode;
}) {
  return (
    <View
      style={
        reserveWidth
          ? sidebarWorkspaceRowStyles.trailingActionSlotReserved
          : sidebarWorkspaceRowStyles.trailingActionSlot
      }
    >
      {children}
    </View>
  );
}

export function SidebarWorkspaceTrailingActionBase({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  if (!children) return null;
  return <View style={visible ? undefined : sidebarWorkspaceRowStyles.hidden}>{children}</View>;
}

export function SidebarWorkspaceTrailingActionOverlay({
  visible,
  scrimBackdrop,
  children,
}: {
  visible: boolean;
  /** Fade the row into the kebab while the activity timestamp remains behind it. */
  scrimBackdrop?: SidebarSurfaceBackdrop;
  children: ReactNode;
}) {
  const [actionWidth, setActionWidth] = useState(0);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setActionWidth(event.nativeEvent.layout.width);
  }, []);
  if (!visible || !children) return null;
  return (
    <View style={sidebarWorkspaceRowStyles.trailingActionOverlay} onLayout={handleLayout}>
      {scrimBackdrop ? (
        <TrailingActionScrim
          backdrop={scrimBackdrop}
          width={actionWidth + 32}
          testID="sidebar-workspace-trailing-scrim"
        />
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  workspaceRowContent: {
    position: "relative",
  },
  workspaceRowMain: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    width: "100%",
  },
  workspaceContentColumn: {
    flex: 1,
    minWidth: 0,
  },
  workspaceTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  shortcutBadgeOverlay: {
    position: "absolute",
    top: 1,
    right: 0,
  },
  workspaceStatusDot: {
    position: "relative",
    width: theme.iconSize.md,
    height: 20,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  statusDotOverlay: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: STATUS_INDICATOR_DOT_SIZE,
    height: STATUS_INDICATOR_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  standaloneStatusDot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
  },
  idleStatusDot: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
    opacity: 0.3,
  },
  // The title owns the first line outright now that the host, change request and CI moved
  // to the meta row, so it takes the full width the trailing slot leaves behind.
  workspaceTitleText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 20,
    opacity: 0.76,
    flex: 1,
    minWidth: 0,
  },
  workspaceTitleTextCreating: {
    opacity: 0.92,
  },
  workspaceTitleTextHighlighted: {
    opacity: 1,
  },
  statusDotNeedsInput: {
    backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined,
    borderColor: theme.colors.surface0,
  },
  statusDotFailed: {
    backgroundColor: getStatusDotColor({ theme, bucket: "failed" }) ?? undefined,
    borderColor: theme.colors.surface0,
  },
  statusDotRunning: {
    backgroundColor: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
    borderColor: theme.colors.surface0,
  },
  statusDotAttention: {
    backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
    borderColor: theme.colors.surface0,
  },
}));
