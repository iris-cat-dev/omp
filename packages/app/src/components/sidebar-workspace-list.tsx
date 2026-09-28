import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Pressable,
  ScrollView,
  StyleSheet as RNStyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useMutation } from "@tanstack/react-query";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type ReactElement,
  type MutableRefObject,
  type Ref,
  type ComponentProps,
  type PropsWithChildren,
} from "react";
import { useTranslation } from "react-i18next";
import { router, usePathname, type Href } from "expo-router";
import {
  navigateToSidebarWorkspace,
  navigateToWorkspace,
  useActiveWorkspaceSelection,
  useSidebarActiveWorkspaceSelection,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { SidebarSurfaceBackdrop } from "@/styles/surface-backdrop";
import { getSidebarRowBackdrop } from "@/components/sidebar/sidebar-row-backdrop";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import { type GestureType } from "react-native-gesture-handler";
import * as Clipboard from "expo-clipboard";
import {
  Copy,
  EyeOff,
  ExternalLink,
  GitPullRequest,
  Settings,
  MoreVertical,
  Plus,
  Trash2,
} from "lucide-react-native";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { DraggableList, type DraggableRenderItemInfo } from "./draggable-list";
import type { DraggableListDragHandleProps } from "./draggable-list.types";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import {
  useSidebarWorkspacePinController,
  type ToggleSidebarWorkspacePin,
} from "@/hooks/use-sidebar-workspace-pin";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProjectIcons } from "@/projects/icons";
import {
  buildProjectSettingsRoute,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import {
  shouldShowSidebarHostLabels,
  useSidebarProjectStatusBucket,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import {
  hasActiveSidebarLabelFilter,
  useSidebarViewStore,
  type SidebarGroupMode,
} from "@/stores/sidebar-view-store";
import { useShowShortcutBadges } from "@/hooks/use-show-shortcut-badges";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  useContextMenu,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ProjectLeadingVisual } from "@/components/sidebar/project-leading-visual";
import { useToast } from "@/contexts/toast-context";
import { getForgePresentation, normalizeForge } from "@/git/forge";
import { toWorktreeArchiveRisk } from "@/git/worktree-archive-warning";
import { hasVisibleOrderChanged, mergeWithRemainder } from "@/utils/sidebar-reorder";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { SidebarStatusWorkspaceList } from "@/components/sidebar/sidebar-status-list";
import type { SidebarWorkspaceGroup } from "@/components/sidebar/sidebar-labels";
import {
  SidebarWorkspaceContextMenu,
  SidebarWorkspaceMenu,
} from "@/components/sidebar/sidebar-workspace-menu";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import { SidebarGroupToggleRow } from "@/components/sidebar/sidebar-group-toggle-row";
import { useLimitedSidebarGroup } from "@/components/sidebar/use-limited-sidebar-group";
import {
  SidebarWorkspaceRowFrame,
  SidebarWorkspaceRowContent,
  SidebarWorkspaceShortcutBadge,
  resolveTrailingActionVisibility,
  SidebarWorkspaceTrailingActionBase,
  SidebarWorkspaceTrailingActionOverlay,
  SidebarWorkspaceTrailingActionSlot,
} from "@/components/sidebar/sidebar-workspace-row-content";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { SidebarFilterEmptyState } from "@/components/sidebar/empty-states";
import { selectWorkspaceServiceSummary } from "@/components/sidebar/workspace-meta-row";
import {
  SidebarWorkspaceTrailingContent,
  useSidebarWorkspaceTrailing,
} from "@/components/sidebar/workspace-trailing";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shortcut } from "@/components/ui/shortcut";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useClearWorkspaceAttention } from "@/hooks/use-clear-workspace-attention";
import type { PrHint } from "@/git/use-pr-status-query";
import {
  buildSidebarProjectRowModel,
  resolveSidebarProjectLocalPath,
  type SidebarProjectHostTarget,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { openExternalUrl } from "@/utils/open-external-url";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";
import { useWorkspaceArchive } from "@/workspace/use-workspace-archive";
import { deleteWorkspaceWithCleanup } from "@/workspace/workspace-delete";
import {
  getCurrentProjectRemoveReadiness,
  removeProjectFromHosts,
} from "@/projects/project-remove";
import { isWeb as platformIsWeb, isNative as platformIsNative } from "@/constants/platform";
import { OpenInFileManagerMenuItem } from "@/workspace/open-in-file-manager/menu-item";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import type { HostBadgeModel } from "@/hosts/appearance";
import { useHostBadges } from "@/hosts/use-host-badges";
import { useSidebarRowItems } from "@/components/sidebar/display-preferences/model";
import { openProjectWorkspaceDraft } from "@/utils/open-project-workspace-draft";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { groupSidebarAgentDrafts, type SidebarAgentDraft } from "@/components/sidebar-agent-drafts";

const workspaceKeyExtractor = (workspace: SidebarWorkspacePlacement) => workspace.workspaceKey;

const projectViewKeyExtractor = (project: SidebarProjectEntry) => project.viewKey;

const WORKSPACE_STATUS_DOT_WIDTH = 14;
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedPlus = withUnistyles(Plus);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedSettings = withUnistyles(Settings);
const ThemedCopy = withUnistyles(Copy);
const ThemedEyeOff = withUnistyles(EyeOff);
const EMPTY_AGENT_DRAFTS: readonly SidebarAgentDraft[] = [];

const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const redColorMapping = (theme: Theme) => ({
  color: theme.colors.statusDanger,
});
const greenColorMapping = (theme: Theme) => ({
  color: theme.colors.statusSuccess,
});
const purpleColorMapping = (theme: Theme) => ({
  color: theme.colors.statusMerged,
});

function getPrIconUniMapping(state: PrHint["state"]) {
  switch (state) {
    case "merged":
      return purpleColorMapping;
    case "open":
      return greenColorMapping;
    case "closed":
      return redColorMapping;
  }
}

function isWorkspaceSelected(input: {
  selection: ActiveWorkspaceSelection | null;
  serverId: string | null;
  workspaceId: string;
  enabled: boolean;
}): boolean {
  return (
    input.enabled &&
    input.selection?.serverId === input.serverId &&
    input.selection.workspaceId === input.workspaceId
  );
}

function isProjectSelectedByRoute(input: {
  selection: ActiveWorkspaceSelection | null;
  project: SidebarProjectEntry;
  enabled: boolean;
}): boolean {
  return (
    input.enabled &&
    input.project.workspaces.some(
      (workspace) =>
        workspace.serverId === input.selection?.serverId &&
        workspace.workspaceId === input.selection.workspaceId,
    )
  );
}

function activeWorkspaceSelectionKey(selection: ActiveWorkspaceSelection | null): string {
  return selection ? `${selection.serverId}:${selection.workspaceId}` : "";
}

interface SidebarWorkspaceListProps {
  workspaceGroups: SidebarWorkspaceGroup[];
  /** What `useProjectIcons` is asked for, straight from the projection. See `SidebarProjection`. */
  projectIconTargets: SidebarProjectIconTarget[];
  projects: SidebarProjectEntry[];
  hasProjectsBeforeFilter: boolean;
  /** Keeps the display controls reachable when every project is hidden. */
  hasHiddenProjects: boolean;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  collapsedProjectKeys: ReadonlySet<string>;
  onToggleProjectCollapsed: (projectViewKey: string) => void;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  groupMode: SidebarGroupMode;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  onWorkspacePress?: () => void;
  listFooterComponent?: ReactElement | null;
  // Rendered inside the scroll area above the workspace list.
  listHeaderComponent?: ReactElement | null;
  /** Gesture ref for coordinating with parent gestures (e.g., sidebar close) */
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  dragGestureHostPresented?: boolean;
}

interface ProjectHeaderRowProps {
  project: SidebarProjectEntry;
  displayName: string;
  iconDataUri: string | null;
  statusBucket: SidebarStateBucket | null;
  selected?: boolean;
  chevron: "expand" | "collapse" | null;
  onPress: () => void;
  workspaceTarget: SidebarProjectHostTarget | null;
  onBeginWorkspaceSetup: () => void;
  isProjectActive?: boolean;
  shortcutNumber?: number | null;
  showShortcutBadge?: boolean;
  drag: () => void;
  isDragging: boolean;
  isArchiving?: boolean;
  menuController: ReturnType<typeof useContextMenu> | null;
  onRemoveProject?: () => void;
  removeProjectStatus?: "idle" | "pending";
  dragHandleProps?: DraggableListDragHandleProps;
}

interface WorkspaceRowInnerProps {
  workspace: SidebarWorkspaceEntry;
  hostBadge?: HostBadgeModel | null;
  leadingProjectName?: string | null;
  leadingProjectIconDataUri?: string | null;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  drag: () => void;
  isDragging: boolean;
  isArchiving: boolean;
  isCreating?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  menuController: ReturnType<typeof useContextMenu> | null;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  onArchive?: () => void;
  onDelete?: () => void;
  deleteStatus?: "idle" | "pending" | "success";
  deletePendingLabel?: string;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onRename?: () => void;
  onMarkAsRead?: () => void;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  isPinned?: boolean;
  onTogglePin?: () => void;
  reserveIdleStatusIndicatorSpace?: boolean;
}

type SidebarConversationDraftSource = {
  serverId: string;
  sourceDirectory: string;
  projectId: string;
};
export function PrBadge({ hint, style }: { hint: PrHint; style?: StyleProp<ViewStyle> }) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);

  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(hint.url);
    },
    [hint.url],
  );

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  // Callers that place the badge in a list of icon+text rows pass that row's layout in, so the
  // icon and text land on the same rails as their neighbors instead of on the badge's tighter
  // inline spacing.
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      prBadgeStyles.badge,
      style,
      pressed && prBadgeStyles.badgePressed,
    ],
    [style],
  );

  const textStyle = isHovered
    ? [prBadgeStyles.text, prBadgeStyles.textHovered]
    : prBadgeStyles.text;
  const iconUniProps = isHovered ? foregroundColorMapping : getPrIconUniMapping(hint.state);
  const presentation = getForgePresentation(normalizeForge(hint.forge));

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t("workspace.git.pr.accessibility.pullRequest", {
        number: hint.number,
        context: presentation.changeRequestContext,
      })}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={pressableStyle}
    >
      {isHovered ? (
        <ThemedExternalLink size={12} uniProps={iconUniProps} />
      ) : (
        <ThemedGitPullRequest size={12} uniProps={iconUniProps} />
      )}
      <Text style={textStyle} numberOfLines={1}>
        {hint.number}
      </Text>
    </Pressable>
  );
}

function projectKebabStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.projectKebabButton, hovered && styles.projectKebabButtonHovered];
}

function getProjectWorkspaceRowStyle({
  isDragging,
  isPressed,
  selected,
  isHovered,
}: {
  isDragging: boolean;
  isPressed: boolean;
  selected: boolean;
  isHovered: boolean;
}) {
  return [
    styles.workspaceRow,
    isHovered && styles.workspaceRowHovered,
    selected && styles.sidebarRowSelected,
    isDragging && styles.workspaceRowDragging,
    isPressed && styles.workspaceRowPressed,
  ];
}

function noop() {}

const prBadgeStyles = StyleSheet.create((theme) => ({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  badgePressed: {
    opacity: 0.82,
  },
  text: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 14,
    color: theme.colors.foregroundMuted,
  },
  textHovered: {
    color: theme.colors.foreground,
  },
}));

function ProjectRowTrailingActions({
  projectViewKey,
  displayName,
  workspaceTarget,
  settingsTarget,
  projectPath,
  isHovered,
  isMobileBreakpoint,
  isProjectActive,
  onBeginWorkspaceSetup,
  onRemoveProject,
  removeProjectStatus,
}: {
  projectViewKey: string;
  displayName: string;
  workspaceTarget: SidebarProjectHostTarget | null;
  settingsTarget: { serverId: string; projectId: string } | null;
  projectPath: string;
  isHovered: boolean;
  isMobileBreakpoint: boolean;
  isProjectActive: boolean;
  onBeginWorkspaceSetup: () => void;
  onRemoveProject?: () => void;
  removeProjectStatus: "idle" | "pending" | "success";
}) {
  const actionsVisible = isHovered || platformIsNative || isMobileBreakpoint;
  return (
    <View style={styles.projectTrailingActions}>
      {workspaceTarget ? (
        <NewWorkspaceButton
          displayName={displayName}
          onPress={onBeginWorkspaceSetup}
          visible={actionsVisible}
          showShortcutHint={isProjectActive}
          testID={`sidebar-project-new-workspace-${projectViewKey}`}
        />
      ) : null}
      {onRemoveProject ? (
        <View
          style={!actionsVisible && styles.projectKebabButtonHidden}
          pointerEvents={actionsVisible ? "auto" : "none"}
        >
          <ProjectKebabMenu
            projectViewKey={projectViewKey}
            settingsTarget={settingsTarget}
            projectPath={projectPath}
            onRemoveProject={onRemoveProject}
            removeProjectStatus={removeProjectStatus}
          />
        </View>
      ) : null}
    </View>
  );
}

const trash2LeadingIcon = <ThemedTrash2 size={14} uniProps={foregroundMutedColorMapping} />;
const settingsLeadingIcon = <ThemedSettings size={14} uniProps={foregroundMutedColorMapping} />;
const copyLeadingIcon = <ThemedCopy size={14} uniProps={foregroundMutedColorMapping} />;
const hideLeadingIcon = <ThemedEyeOff size={14} uniProps={foregroundMutedColorMapping} />;

function renderKebabTriggerIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical
      size={14}
      uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

function ProjectKebabMenu({
  projectViewKey,
  settingsTarget,
  projectPath,
  onRemoveProject,
  removeProjectStatus,
}: {
  projectViewKey: string;
  settingsTarget: { serverId: string; projectId: string } | null;
  projectPath: string;
  onRemoveProject: () => void;
  removeProjectStatus: "idle" | "pending" | "success";
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        hitSlop={8}
        style={projectKebabStyle}
        accessibilityRole={platformIsWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.project.actions.menu")}
        testID={`sidebar-project-kebab-${projectViewKey}`}
      >
        {renderKebabTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220} sheetTitle={t("sidebar.project.actions.menu")}>
        <ProjectMenuItems
          surface="dropdown"
          projectViewKey={projectViewKey}
          settingsTarget={settingsTarget}
          projectPath={projectPath}
          onRemoveProject={onRemoveProject}
          removeProjectStatus={removeProjectStatus}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ProjectMenuSurface = "context" | "dropdown";

function ProjectMenuItem({
  surface,
  children,
  ...props
}: PropsWithChildren<
  Omit<ComponentProps<typeof DropdownMenuItem>, "children"> & { surface: ProjectMenuSurface }
>) {
  if (surface === "context") {
    return <ContextMenuItem {...props}>{children}</ContextMenuItem>;
  }
  return <DropdownMenuItem {...props}>{children}</DropdownMenuItem>;
}

function ProjectMenuItems({
  surface,
  projectViewKey,
  settingsTarget,
  projectPath,
  onRemoveProject,
  removeProjectStatus,
}: {
  surface: ProjectMenuSurface;
  projectViewKey: string;
  settingsTarget: { serverId: string; projectId: string } | null;
  projectPath: string;
  onRemoveProject: () => void;
  removeProjectStatus: "idle" | "pending" | "success";
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const hideProject = useSidebarViewStore((state) => state.hideProject);
  const handleOpenProjectSettings = useCallback(() => {
    if (!settingsTarget) return;
    router.navigate(buildProjectSettingsRoute(settingsTarget.serverId, settingsTarget.projectId));
  }, [settingsTarget]);
  const handleCopyProjectPath = useCallback(() => {
    void Clipboard.setStringAsync(projectPath);
    toast.copied(t("sidebar.project.toasts.pathCopied"));
  }, [projectPath, t, toast]);
  const handleHideProject = useCallback(() => {
    hideProject(projectViewKey);
  }, [hideProject, projectViewKey]);

  return (
    <>
      {settingsTarget ? (
        <ProjectMenuItem
          surface={surface}
          testID={`sidebar-project-menu-open-settings-${projectViewKey}`}
          leading={settingsLeadingIcon}
          onSelect={handleOpenProjectSettings}
        >
          {t("sidebar.project.actions.openSettings")}
        </ProjectMenuItem>
      ) : null}
      <OpenInFileManagerMenuItem
        surface={surface}
        path={projectPath}
        testID={`sidebar-project-menu-open-folder-${projectViewKey}`}
      />
      <ProjectMenuItem
        surface={surface}
        testID={`sidebar-project-menu-copy-path-${projectViewKey}`}
        leading={copyLeadingIcon}
        onSelect={handleCopyProjectPath}
      >
        {t("sidebar.project.actions.copyPath")}
      </ProjectMenuItem>
      <ProjectMenuItem
        surface={surface}
        testID={`sidebar-project-menu-hide-${projectViewKey}`}
        leading={hideLeadingIcon}
        onSelect={handleHideProject}
      >
        {t("sidebar.project.actions.hide")}
      </ProjectMenuItem>
      <ProjectMenuItem
        surface={surface}
        testID={`sidebar-project-menu-remove-${projectViewKey}`}
        leading={trash2LeadingIcon}
        status={removeProjectStatus}
        pendingLabel={t("sidebar.project.actions.removing")}
        onSelect={onRemoveProject}
      >
        {t("sidebar.project.actions.remove")}
      </ProjectMenuItem>
    </>
  );
}

function WorkspaceRowRightGroup({
  workspace,
  backdrop,
  isHovered,
  isTouchPlatform,
  isCreating,
  showShortcutBadge,
  shortcutNumber,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  onArchive,
  onMarkAsRead,
  onDelete,
  deleteStatus,
  deletePendingLabel,
  onCopyBranchName,
  onCopyPath,
  onRename,
  isPinned,
  onTogglePin,
}: {
  workspace: SidebarWorkspaceEntry;
  backdrop: SidebarSurfaceBackdrop;
  isHovered: boolean;
  isTouchPlatform: boolean;
  isCreating: boolean;
  showShortcutBadge: boolean;
  shortcutNumber: number | null;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  onArchive?: () => void;
  onMarkAsRead?: () => void;
  onDelete?: () => void;
  deleteStatus?: "idle" | "pending" | "success";
  deletePendingLabel?: string;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onRename?: () => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
}) {
  const workspacePath = workspace.workspaceDirectory ?? workspace.projectRootPath;
  const { t } = useTranslation();
  const trailingPreference = useSidebarWorkspaceTrailing();
  const trailing = trailingPreference === "diff" ? "none" : trailingPreference;
  const showShortcut = showShortcutBadge && shortcutNumber !== null;
  const {
    showTrailing,
    showKebab: showKebabInSlot,
    showScrim,
    renderSlot,
    reserveSlotWidth,
  } = resolveTrailingActionVisibility({
    workspace,
    trailing,
    hasArchiveAction: Boolean(onArchive),
    isHovered,
    isTouchPlatform,
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
            <SidebarWorkspaceTrailingContent workspace={workspace} trailing={trailing} />
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
                openInFileManagerPath={workspacePath}
              />
            ) : null}
          </SidebarWorkspaceTrailingActionOverlay>
        </SidebarWorkspaceTrailingActionSlot>
      ) : null}
    </>
  );
}

function NewWorkspaceButton({
  displayName,
  onPress,
  visible,
  loading = false,
  testID,
  showShortcutHint = false,
}: {
  displayName: string;
  onPress: () => void;
  visible: boolean;
  loading?: boolean;
  testID: string;
  showShortcutHint?: boolean;
}) {
  const { t } = useTranslation();
  const newWorkspaceKeys = useShortcutKeys("new-workspace");

  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.projectIconActionButton,
      !visible && styles.projectIconActionButtonHidden,
      (Boolean(hovered) || pressed) && !loading && styles.projectIconActionButtonHovered,
    ],
    [visible, loading],
  );

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onPress();
    },
    [onPress],
  );

  return (
    <View style={styles.projectTrailingControlSlot} pointerEvents={visible ? "auto" : "none"}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild disabled={!visible}>
          <Pressable
            style={pressableStyle}
            onPress={handlePress}
            disabled={loading}
            accessibilityRole={platformIsWeb ? undefined : "button"}
            accessibilityLabel={t("sidebar.workspace.actions.createWorkspaceFor", {
              projectName: displayName,
            })}
            testID={testID}
          >
            {({ hovered, pressed }) =>
              loading ? (
                <ThemedLoadingSpinner size={14} uniProps={foregroundMutedColorMapping} />
              ) : (
                <ThemedPlus
                  size={15}
                  uniProps={
                    hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping
                  }
                />
              )
            }
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <View style={styles.projectActionTooltipRow}>
            <Text style={styles.projectActionTooltipText}>
              {t("sidebar.workspace.actions.newWorkspace")}
            </Text>
            {showShortcutHint && newWorkspaceKeys ? (
              <Shortcut chord={newWorkspaceKeys} style={styles.projectActionTooltipShortcut} />
            ) : null}
          </View>
        </TooltipContent>
      </Tooltip>
    </View>
  );
}

function SidebarAgentDraftRow({
  serverId,
  workspaceId,
  tabHostWorkspaceId,
  draftId,
  selected,
  onWorkspacePress,
}: {
  serverId: string;
  workspaceId: string;
  tabHostWorkspaceId: string;
  draftId: string;
  selected: boolean;
  onWorkspacePress?: () => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onWorkspacePress?.();
    navigateToWorkspace({
      serverId,
      workspaceId: tabHostWorkspaceId,
      target: { kind: "draft", draftId, workspaceId },
    });
  }, [draftId, onWorkspacePress, serverId, tabHostWorkspaceId, workspaceId]);
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.agentDraftRow,
      selected && styles.sidebarRowSelected,
      hovered && !pressed && styles.workspaceRowHovered,
      pressed && styles.workspaceRowPressed,
    ],
    [selected],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("newWorkspace.title")}
      accessibilityState={{ selected }}
      onPress={handlePress}
      style={rowStyle}
      testID={`sidebar-agent-draft-${draftId}`}
    >
      <View style={styles.agentDraftStatusSlot}>
        <View style={styles.agentDraftStatusDot} />
      </View>
      <Text style={styles.agentDraftText} numberOfLines={1}>
        {t("newWorkspace.title")}
      </Text>
    </Pressable>
  );
}

function ProjectHeaderRow({
  project,
  displayName,
  iconDataUri,
  statusBucket,
  selected = false,
  chevron,
  onPress,
  workspaceTarget,
  onBeginWorkspaceSetup,
  isProjectActive = false,
  shortcutNumber = null,
  showShortcutBadge = false,
  drag,
  isDragging,
  isArchiving = false,
  menuController,
  onRemoveProject,
  removeProjectStatus = "idle",
  dragHandleProps,
}: ProjectHeaderRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const isMobileBreakpoint = useIsCompactFormFactor();
  const localDaemonServerId = useLocalDaemonServerId();
  const projectPath = resolveSidebarProjectLocalPath(project, localDaemonServerId);
  const settingsTarget = project.hosts[0] ?? null;

  const interaction = useLongPressDragInteraction({
    drag,
    menuController,
  });
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

  const handlePress = useCallback(() => {
    if (interaction.didLongPressRef.current) {
      interaction.didLongPressRef.current = false;
      return;
    }
    onPress();
  }, [interaction.didLongPressRef, onPress]);

  const handlePointerEnter = useCallback(() => {
    if (!contextMenuOpen) setIsHovered(true);
  }, [contextMenuOpen]);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    setContextMenuOpen(open);
    if (open) setIsHovered(false);
  }, []);
  const handleProjectPressIn = useCallback(
    (event: GestureResponderEvent) => {
      setIsPressed(true);
      interaction.handlePressIn(event);
    },
    [interaction],
  );
  const handleProjectPressOut = useCallback(() => {
    setIsPressed(false);
    interaction.handlePressOut();
  }, [interaction]);

  const projectRowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.projectRow,
      isDragging && styles.projectRowDragging,
      selected && styles.sidebarRowSelected,
      isHovered && styles.projectRowHovered,
      pressed && styles.projectRowPressed,
    ],
    [isDragging, selected, isHovered],
  );

  const rowChildren = (
    <>
      <View style={styles.projectRowLeft}>
        <ProjectLeadingVisual
          displayName={displayName}
          iconDataUri={iconDataUri}
          statusBucket={statusBucket}
          projectViewKey={project.viewKey}
          backdrop={getSidebarRowBackdrop({ isDragging, isPressed, selected, isHovered })}
          chevron={chevron}
          showChevron={isHovered && chevron !== null}
          isArchiving={isArchiving}
        />

        <View style={styles.projectTitleGroup}>
          <Text style={styles.projectTitle} numberOfLines={1}>
            {displayName}
          </Text>
        </View>
      </View>
      <ProjectRowTrailingActions
        projectViewKey={project.viewKey}
        displayName={displayName}
        workspaceTarget={workspaceTarget}
        settingsTarget={settingsTarget}
        projectPath={projectPath}
        isHovered={isHovered}
        isMobileBreakpoint={isMobileBreakpoint}
        isProjectActive={isProjectActive}
        onBeginWorkspaceSetup={onBeginWorkspaceSetup}
        onRemoveProject={onRemoveProject}
        removeProjectStatus={removeProjectStatus}
      />
      {showShortcutBadge && shortcutNumber !== null ? (
        <View style={styles.projectShortcutBadgeOverlay} pointerEvents="none">
          <SidebarWorkspaceShortcutBadge number={shortcutNumber} />
        </View>
      ) : null}
    </>
  );

  if (!onRemoveProject) {
    return (
      <View
        {...dragAttributes}
        {...dragHandleProps?.listeners}
        ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <PressHighlight
          accessibilityRole="button"
          style={projectRowStyle}
          highlightStyle={styles.projectRowPressed}
          onPressIn={handleProjectPressIn}
          onTouchMove={interaction.handleTouchMove}
          onPressOut={handleProjectPressOut}
          onPress={handlePress}
          testID={`sidebar-project-row-${project.viewKey}`}
        >
          {rowChildren}
        </PressHighlight>
      </View>
    );
  }

  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={handleContextMenuOpenChange}>
      <View
        {...dragAttributes}
        {...dragHandleProps?.listeners}
        ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <ContextMenuTrigger
          enabledOnMobile={false}
          accessibilityRole="button"
          style={projectRowStyle}
          highlightStyle={styles.projectRowPressed}
          onPressIn={handleProjectPressIn}
          onTouchMove={interaction.handleTouchMove}
          onPressOut={handleProjectPressOut}
          onPress={handlePress}
          testID={`sidebar-project-row-${project.viewKey}`}
        >
          {rowChildren}
        </ContextMenuTrigger>
      </View>
      <ContextMenuContent
        align="start"
        width={220}
        testID={`sidebar-project-context-menu-${project.viewKey}`}
      >
        <ProjectMenuItems
          surface="context"
          projectViewKey={project.viewKey}
          settingsTarget={settingsTarget}
          projectPath={projectPath}
          onRemoveProject={onRemoveProject}
          removeProjectStatus={removeProjectStatus}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function WorkspaceRowInner({
  workspace,
  hostBadge,
  leadingProjectName,
  leadingProjectIconDataUri,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
  isDragging,
  isArchiving,
  isCreating = false,
  dragHandleProps,
  menuController,
  archiveLabel,
  archiveStatus = "idle",
  archivePendingLabel,
  onArchive,
  onDelete,
  deleteStatus,
  deletePendingLabel,
  onCopyBranchName,
  onCopyPath,
  onRename,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  reserveIdleStatusIndicatorSpace = true,
}: WorkspaceRowInnerProps) {
  const isCompact = useIsCompactFormFactor();
  const [isPressed, setIsPressed] = useState(false);
  const isTouchPlatform = platformIsNative || isCompact;
  const interaction = useLongPressDragInteraction({
    drag,
    menuController,
  });
  const {
    role: _dragRole,
    tabIndex: _dragTabIndex,
    "aria-roledescription": _dragRoleDescription,
    ...dragAttributes
  } = dragHandleProps?.attributes ?? {};

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
      interaction.handlePressIn(event);
    },
    [interaction],
  );
  const handleWorkspacePressOut = useCallback(() => {
    setIsPressed(false);
    interaction.handlePressOut();
  }, [interaction]);

  const accessibilityState = useMemo(() => ({ selected }), [selected]);

  return (
    <SidebarWorkspaceRowFrame workspace={workspace} isDragging={isDragging}>
      {({ isHovered, contextMenuOpen, onContextMenuOpenChange, hoverHandlers }) => {
        const isDesktop = !isTouchPlatform;
        const serviceSummary = isDesktop ? selectWorkspaceServiceSummary(workspace.scripts) : null;
        const workspaceRowStyle = getProjectWorkspaceRowStyle({
          isDragging,
          isPressed,
          selected,
          isHovered,
        });
        const backdrop = getSidebarRowBackdrop({ isDragging, isPressed, selected, isHovered });
        return (
          <View
            {...dragAttributes}
            {...dragHandleProps?.listeners}
            ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
            style={styles.workspaceRowContainer}
            {...hoverHandlers}
          >
            <SidebarWorkspaceContextMenu
              contextMenuOpen={contextMenuOpen}
              onContextMenuOpenChange={onContextMenuOpenChange}
              workspace={workspace}
              leadingProjectName={leadingProjectName}
              hostBadgeLabel={hostBadge?.label}
              workspaceKey={workspace.workspaceKey}
              onCopyPath={onCopyPath}
              onCopyBranchName={onCopyBranchName}
              onRename={onRename}
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
              disabled={isArchiving}
              aria-selected={selected}
              accessibilityRole="button"
              accessibilityState={accessibilityState}
              style={workspaceRowStyle}
              highlightStyle={styles.workspaceRowPressed}
              onPressIn={handleWorkspacePressIn}
              onTouchMove={interaction.handleTouchMove}
              onPressOut={handleWorkspacePressOut}
              onPress={handlePress}
              testID={`sidebar-workspace-row-${workspace.workspaceKey}`}
            >
              <SidebarWorkspaceRowContent
                workspace={workspace}
                hostBadge={hostBadge}
                leadingProjectName={leadingProjectName}
                leadingProjectIconDataUri={leadingProjectIconDataUri}
                serviceSummary={serviceSummary}
                backdrop={backdrop}
                selected={selected}
                isHovered={isHovered}
                isLoading={isArchiving || isCreating}
                isCreating={isCreating}
                shortcutNumber={shortcutNumber}
                showShortcutBadge={showShortcutBadge}
                reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
              >
                <WorkspaceRowRightGroup
                  workspace={workspace}
                  backdrop={backdrop}
                  isHovered={isHovered}
                  isTouchPlatform={isTouchPlatform}
                  isCreating={isCreating}
                  showShortcutBadge={showShortcutBadge}
                  shortcutNumber={shortcutNumber}
                  archiveLabel={archiveLabel}
                  archiveStatus={archiveStatus}
                  archivePendingLabel={archivePendingLabel}
                  archiveShortcutKeys={archiveShortcutKeys}
                  onArchive={onArchive}
                  onDelete={onDelete}
                  deleteStatus={deleteStatus}
                  deletePendingLabel={deletePendingLabel}
                  onCopyBranchName={onCopyBranchName}
                  onCopyPath={onCopyPath}
                  onRename={onRename}
                  isPinned={isPinned}
                  onTogglePin={onTogglePin}
                />
              </SidebarWorkspaceRowContent>
            </SidebarWorkspaceContextMenu>
          </View>
        );
      }}
    </SidebarWorkspaceRowFrame>
  );
}

function WorkspaceRowWithMenu({
  workspace,
  hostBadge,
  leadingProjectName,
  leadingProjectIconDataUri,
  selected,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
  isDragging,
  dragHandleProps,
  canCopyBranchName,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  isCreating = false,
}: {
  workspace: SidebarWorkspaceEntry;
  hostBadge?: HostBadgeModel | null;
  leadingProjectName?: string | null;
  leadingProjectIconDataUri?: string | null;
  selected: boolean;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  canCopyBranchName: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  isCreating?: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const activeRouteWorkspaceSelection = useActiveWorkspaceSelection();
  const [isHidingWorkspace, setIsHidingWorkspace] = useState(false);
  const [isRenameOpen, setIsRenameOpen] = useState(false);
  const isArchiving = workspace.archivingAt !== null || isHidingWorkspace;
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

  const archiveController = useWorkspaceArchive({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
    workspaceKind: workspace.workspaceKind,
    name: workspace.name,
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

  const handleDelete = useCallback(async () => {
    if (isArchiving || isDeleting) {
      return;
    }
    const confirmed = await confirmDialog({
      title: t("sidebar.workspace.confirmations.deleteTitle", {
        name: workspace.title ?? workspace.name,
      }),
      message: t("sidebar.workspace.confirmations.deleteMessage"),
      confirmLabel: t("sidebar.workspace.actions.delete"),
      cancelLabel: t("workspace.tabs.confirmations.cancel"),
      destructive: true,
    });
    if (confirmed) {
      deleteMutation.mutate();
    }
  }, [deleteMutation, isArchiving, isDeleting, t, workspace.name, workspace.title]);

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
    enabled: selected && !isArchiving,
    priority: 0,
    handle: () => {
      handleArchive();
      return true;
    },
  });

  return (
    <>
      <WorkspaceRowInner
        workspace={workspace}
        hostBadge={hostBadge}
        leadingProjectName={leadingProjectName}
        leadingProjectIconDataUri={leadingProjectIconDataUri}
        selected={selected}
        shortcutNumber={shortcutNumber}
        showShortcutBadge={showShortcutBadge}
        onPress={onPress}
        drag={drag}
        isDragging={isDragging}
        isArchiving={isArchiving}
        isCreating={isCreating}
        dragHandleProps={dragHandleProps}
        menuController={null}
        archiveLabel={t("sidebar.workspace.actions.archive")}
        archiveStatus={isArchiving ? "pending" : "idle"}
        archivePendingLabel={t("sidebar.workspace.actions.archiving")}
        onArchive={handleArchive}
        onDelete={handleDelete}
        deleteStatus={isDeleting ? "pending" : "idle"}
        deletePendingLabel={t("sidebar.workspace.actions.deleting")}
        onCopyBranchName={canCopyBranchName ? handleCopyBranchName : undefined}
        onCopyPath={handleCopyPath}
        onRename={handleOpenRename}
        onMarkAsRead={hasClearableAttention ? handleMarkAsRead : undefined}
        archiveShortcutKeys={selected ? archiveShortcutKeys : null}
        isPinned={isPinned}
        onTogglePin={onTogglePin}
        reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
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

interface WorkspaceRowItemProps {
  workspace: SidebarWorkspacePlacement;
  workspaceEntry: SidebarWorkspaceEntry | null;
  hostBadge?: HostBadgeModel | null;
  leadingProjectName?: string | null;
  leadingProjectIconDataUri?: string | null;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  canCopyBranchName: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  isCreating?: boolean;
  selectionEnabled: boolean;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  onWorkspacePress?: () => void;
  drag?: () => void;
  isDragging?: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
}

function WorkspaceRowItem({
  workspace,
  workspaceEntry,
  hostBadge,
  leadingProjectName,
  leadingProjectIconDataUri,
  shortcutNumber,
  showShortcutBadge,
  canCopyBranchName,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  isCreating = false,
  selectionEnabled,
  activeWorkspaceSelection,
  onWorkspacePress,
  drag,
  isDragging = false,
  dragHandleProps,
}: WorkspaceRowItemProps) {
  const tabHostSelection = useActiveWorkspaceSelection();
  const handlePress = useCallback(() => {
    if (!workspace.serverId) {
      return;
    }
    onWorkspacePress?.();
    void navigateToSidebarWorkspace({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      tabHost: tabHostSelection,
    });
  }, [onWorkspacePress, tabHostSelection, workspace.serverId, workspace.workspaceId]);

  return (
    <WorkspaceRow
      workspaceEntry={workspaceEntry}
      hostBadge={hostBadge}
      leadingProjectName={leadingProjectName}
      leadingProjectIconDataUri={leadingProjectIconDataUri}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      canCopyBranchName={canCopyBranchName}
      canPin={canPin}
      onToggleWorkspacePin={onToggleWorkspacePin}
      reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
      isCreating={isCreating}
      selected={isWorkspaceSelected({
        selection: activeWorkspaceSelection,
        serverId: workspace.serverId,
        workspaceId: workspace.workspaceId,
        enabled: selectionEnabled,
      })}
      onPress={handlePress}
      drag={drag ?? noop}
      isDragging={isDragging}
      dragHandleProps={dragHandleProps}
    />
  );
}

function areWorkspaceRowItemPropsEqual(
  previous: WorkspaceRowItemProps,
  next: WorkspaceRowItemProps,
): boolean {
  const previousSelected = isWorkspaceSelected({
    selection: previous.activeWorkspaceSelection,
    serverId: previous.workspace.serverId,
    workspaceId: previous.workspace.workspaceId,
    enabled: previous.selectionEnabled,
  });
  const nextSelected = isWorkspaceSelected({
    selection: next.activeWorkspaceSelection,
    serverId: next.workspace.serverId,
    workspaceId: next.workspace.workspaceId,
    enabled: next.selectionEnabled,
  });
  return (
    previous.workspace === next.workspace &&
    previous.workspaceEntry === next.workspaceEntry &&
    previous.hostBadge === next.hostBadge &&
    previous.leadingProjectName === next.leadingProjectName &&
    previous.leadingProjectIconDataUri === next.leadingProjectIconDataUri &&
    previous.shortcutNumber === next.shortcutNumber &&
    previous.showShortcutBadge === next.showShortcutBadge &&
    previous.canCopyBranchName === next.canCopyBranchName &&
    previous.canPin === next.canPin &&
    previous.onToggleWorkspacePin === next.onToggleWorkspacePin &&
    previous.reserveIdleStatusIndicatorSpace === next.reserveIdleStatusIndicatorSpace &&
    previous.isCreating === next.isCreating &&
    previous.onWorkspacePress === next.onWorkspacePress &&
    previous.drag === next.drag &&
    previous.isDragging === next.isDragging &&
    previous.dragHandleProps === next.dragHandleProps &&
    previousSelected === nextSelected
  );
}

const MemoWorkspaceRowItem = memo(WorkspaceRowItem, areWorkspaceRowItemPropsEqual);

function WorkspaceRow({
  workspaceEntry,
  hostBadge,
  leadingProjectName,
  leadingProjectIconDataUri,
  shortcutNumber,
  showShortcutBadge,
  onPress,
  drag,
  isDragging,
  dragHandleProps,
  canCopyBranchName,
  canPin,
  onToggleWorkspacePin,
  reserveIdleStatusIndicatorSpace = true,
  isCreating = false,
  selected,
}: {
  workspaceEntry: SidebarWorkspaceEntry | null;
  hostBadge?: HostBadgeModel | null;
  leadingProjectName?: string | null;
  leadingProjectIconDataUri?: string | null;
  shortcutNumber: number | null;
  showShortcutBadge: boolean;
  onPress: () => void;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  canCopyBranchName: boolean;
  canPin: boolean;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  reserveIdleStatusIndicatorSpace?: boolean;
  isCreating?: boolean;
  selected: boolean;
}) {
  if (!workspaceEntry) {
    return null;
  }

  return (
    <WorkspaceRowWithMenu
      workspace={workspaceEntry}
      hostBadge={hostBadge}
      leadingProjectName={leadingProjectName}
      leadingProjectIconDataUri={leadingProjectIconDataUri}
      selected={selected}
      shortcutNumber={shortcutNumber}
      showShortcutBadge={showShortcutBadge}
      onPress={onPress}
      drag={drag}
      isDragging={isDragging}
      dragHandleProps={dragHandleProps}
      canCopyBranchName={canCopyBranchName}
      canPin={canPin}
      onToggleWorkspacePin={onToggleWorkspacePin}
      reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
      isCreating={isCreating}
    />
  );
}

function ProjectBlock({
  project,
  agentDrafts,
  workspaceEntriesByKey,
  collapsed,
  displayName,
  iconDataUri,
  selectionEnabled,
  showShortcutBadges,
  shortcutIndexByWorkspaceKey,
  parentGestureRef,
  onToggleCollapsed,
  onWorkspacePress,
  onWorkspaceReorder,
  onCreateConversationDraft,
  drag,
  isDragging,
  dragHandleProps,
  useNestable,
  dragGestureHostPresented,
  activeWorkspaceSelection,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
}: {
  project: SidebarProjectEntry;
  agentDrafts: readonly SidebarAgentDraft[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  collapsed: boolean;
  displayName: string;
  iconDataUri: string | null;
  selectionEnabled: boolean;
  showShortcutBadges: boolean;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  onToggleCollapsed: (projectViewKey: string) => void;
  onWorkspacePress?: () => void;
  onWorkspaceReorder: (projectViewKey: string, workspaces: SidebarWorkspacePlacement[]) => void;
  onCreateConversationDraft: (draft: SidebarConversationDraftSource) => void;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  useNestable: boolean;
  dragGestureHostPresented?: boolean;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
}) {
  const rowModel = useMemo(
    () => buildSidebarProjectRowModel({ project, collapsed }),
    [collapsed, project],
  );
  const visibleAgentDrafts = collapsed ? EMPTY_AGENT_DRAFTS : agentDrafts;
  const workspaceRows = useMemo(() => {
    const draftWorkspaceKeys = new Set(
      visibleAgentDrafts.map((draft) => `${draft.serverId}:${draft.workspaceId}`),
    );
    return project.workspaces.filter(
      (workspace) => !draftWorkspaceKeys.has(workspace.workspaceKey),
    );
  }, [project.workspaces, visibleAgentDrafts]);
  const {
    visibleItems: visibleWorkspaces,
    expanded: workspacesExpanded,
    canToggle: canToggleWorkspaces,
    toggleExpanded: toggleWorkspacesExpanded,
  } = useLimitedSidebarGroup(workspaceRows);

  // Collapsed rows hide their workspace rows, so the project row carries the most urgent
  // status among them; expanded rows leave the signal to the child rows themselves.
  const aggregateStatusBucket = useSidebarProjectStatusBucket({
    workspaces: project.workspaces,
    enabled: collapsed,
  });

  const active = isProjectSelectedByRoute({
    selection: activeWorkspaceSelection,
    project,
    enabled: selectionEnabled,
  });
  const handleBeginWorkspaceSetup = useCallback(() => {
    if (rowModel.trailingAction.kind !== "new_agent") {
      return;
    }
    if (collapsed) {
      onToggleCollapsed(project.viewKey);
    }
    onCreateConversationDraft({
      serverId: rowModel.trailingAction.target.serverId,
      sourceDirectory: rowModel.trailingAction.target.iconWorkingDir,
      projectId: rowModel.trailingAction.target.projectId,
    });
  }, [
    collapsed,
    onCreateConversationDraft,
    onToggleCollapsed,
    project.viewKey,
    rowModel.trailingAction,
  ]);

  const renderWorkspaceRow = useCallback(
    (
      item: SidebarWorkspacePlacement,
      input?: {
        drag?: () => void;
        isDragging?: boolean;
        dragHandleProps?: DraggableListDragHandleProps;
      },
    ) => {
      return (
        <MemoWorkspaceRowItem
          workspace={item}
          workspaceEntry={workspaceEntriesByKey.get(item.workspaceKey) ?? null}
          hostBadge={hostBadgeByServerId.get(item.serverId) ?? null}
          shortcutNumber={shortcutIndexByWorkspaceKey.get(item.workspaceKey) ?? null}
          showShortcutBadge={showShortcutBadges}
          canCopyBranchName={project.projectKind === "git"}
          canPin={supportsPinningByServerId.get(item.serverId) === true}
          onToggleWorkspacePin={onToggleWorkspacePin}
          selectionEnabled={selectionEnabled}
          activeWorkspaceSelection={activeWorkspaceSelection}
          onWorkspacePress={onWorkspacePress}
          drag={input?.drag}
          isDragging={input?.isDragging}
          dragHandleProps={input?.dragHandleProps}
        />
      );
    },
    [
      project.projectKind,
      onToggleWorkspacePin,
      supportsPinningByServerId,
      activeWorkspaceSelection,
      hostBadgeByServerId,
      onWorkspacePress,
      selectionEnabled,
      shortcutIndexByWorkspaceKey,
      showShortcutBadges,
      workspaceEntriesByKey,
    ],
  );

  const renderWorkspace = useCallback(
    ({
      item,
      drag: workspaceDrag,
      isActive,
      dragHandleProps: workspaceDragHandleProps,
    }: DraggableRenderItemInfo<SidebarWorkspacePlacement>) => {
      return renderWorkspaceRow(item, {
        drag: workspaceDrag,
        isDragging: isActive,
        dragHandleProps: workspaceDragHandleProps,
      });
    },
    [renderWorkspaceRow],
  );

  const handleWorkspaceDragEnd = useCallback(
    (workspaces: SidebarWorkspacePlacement[]) => {
      onWorkspaceReorder(project.viewKey, workspaces);
    },
    [onWorkspaceReorder, project.viewKey],
  );

  const toast = useToast();
  const { t } = useTranslation();
  const [isRemovingProject, setIsRemovingProject] = useState(false);

  const handleRemoveProject = useCallback(() => {
    if (isRemovingProject) {
      return;
    }

    void (async () => {
      const confirmed = await confirmDialog({
        title: t("sidebar.project.confirmations.removeTitle"),
        message: t("sidebar.project.confirmations.removeMessage", { projectName: displayName }),
        confirmLabel: t("sidebar.project.confirmations.removeConfirm"),
        cancelLabel: t("sidebar.project.confirmations.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      setIsRemovingProject(true);
      const readiness = getCurrentProjectRemoveReadiness({
        hosts: project.hosts,
      });
      if (readiness.kind === "needs_host_update") {
        toast.error(t("sidebar.project.toasts.updateHostToRemove"));
        setIsRemovingProject(false);
        return;
      }

      void removeProjectFromHosts({
        targets: readiness.targets,
        getClient: (serverId) => getHostRuntimeStore().getClient(serverId),
      })
        .then((outcome) => {
          if (outcome.kind === "host_disconnected") {
            toast.error(t("sidebar.project.toasts.hostDisconnected"));
            return null;
          }
          if (outcome.kind === "failed") {
            toast.error(t("sidebar.project.toasts.removeFailed"));
          }
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("sidebar.project.toasts.removeFailed"),
          );
        })
        .finally(() => {
          setIsRemovingProject(false);
        });
    })();
  }, [isRemovingProject, displayName, t, toast, project.hosts]);

  const handleToggleCollapsed = useCallback(() => {
    onToggleCollapsed(project.viewKey);
  }, [onToggleCollapsed, project.viewKey]);

  let projectChildren = null;
  if (!collapsed && project.workspaces.length > 0) {
    projectChildren = (
      <>
        {visibleAgentDrafts.map((draft) => (
          <SidebarAgentDraftRow
            key={draft.draftId}
            {...draft}
            onWorkspacePress={onWorkspacePress}
          />
        ))}
        <DraggableList
          testID={`sidebar-workspace-list-${project.viewKey}`}
          data={visibleWorkspaces}
          keyExtractor={workspaceKeyExtractor}
          renderItem={renderWorkspace}
          onDragEnd={handleWorkspaceDragEnd}
          extraData={activeWorkspaceSelectionKey(activeWorkspaceSelection)}
          scrollEnabled={false}
          useDragHandle
          nestable={useNestable}
          simultaneousGestureRef={parentGestureRef}
          gestureHostPresented={dragGestureHostPresented}
          containerStyle={styles.workspaceListContainer}
        />
        {canToggleWorkspaces ? (
          <SidebarGroupToggleRow
            expanded={workspacesExpanded}
            onPress={toggleWorkspacesExpanded}
            testID={`sidebar-project-show-more-${project.viewKey}`}
          />
        ) : null}
      </>
    );
  }

  return (
    <View
      role="group"
      accessibilityLabel={displayName}
      style={projectChildren ? styles.projectBlockExpanded : undefined}
    >
      <ProjectHeaderRow
        project={project}
        displayName={displayName}
        iconDataUri={iconDataUri}
        statusBucket={aggregateStatusBucket}
        selected={false}
        chevron={rowModel.chevron}
        onPress={handleToggleCollapsed}
        workspaceTarget={
          rowModel.trailingAction.kind === "new_agent" ? rowModel.trailingAction.target : null
        }
        onBeginWorkspaceSetup={handleBeginWorkspaceSetup}
        isProjectActive={active}
        drag={drag}
        isDragging={isDragging}
        isArchiving={isRemovingProject}
        menuController={null}
        onRemoveProject={handleRemoveProject}
        removeProjectStatus={isRemovingProject ? "pending" : "idle"}
        dragHandleProps={dragHandleProps}
      />

      {projectChildren}
    </View>
  );
}

type ProjectBlockProps = Parameters<typeof ProjectBlock>[0];

// oxlint-disable-next-line complexity
function areProjectBlockPropsEqual(previous: ProjectBlockProps, next: ProjectBlockProps): boolean {
  return (
    previous.project === next.project &&
    previous.workspaceEntriesByKey === next.workspaceEntriesByKey &&
    previous.agentDrafts === next.agentDrafts &&
    previous.collapsed === next.collapsed &&
    previous.displayName === next.displayName &&
    previous.iconDataUri === next.iconDataUri &&
    previous.selectionEnabled === next.selectionEnabled &&
    previous.showShortcutBadges === next.showShortcutBadges &&
    previous.shortcutIndexByWorkspaceKey === next.shortcutIndexByWorkspaceKey &&
    previous.hostBadgeByServerId === next.hostBadgeByServerId &&
    previous.supportsPinningByServerId === next.supportsPinningByServerId &&
    previous.onToggleWorkspacePin === next.onToggleWorkspacePin &&
    previous.parentGestureRef === next.parentGestureRef &&
    previous.onToggleCollapsed === next.onToggleCollapsed &&
    previous.onWorkspacePress === next.onWorkspacePress &&
    previous.onWorkspaceReorder === next.onWorkspaceReorder &&
    previous.onCreateConversationDraft === next.onCreateConversationDraft &&
    previous.drag === next.drag &&
    previous.isDragging === next.isDragging &&
    previous.dragHandleProps === next.dragHandleProps &&
    previous.useNestable === next.useNestable &&
    previous.dragGestureHostPresented === next.dragGestureHostPresented &&
    areProjectBlockSelectionsEqual(previous, next)
  );
}

function areProjectBlockSelectionsEqual(
  previous: ProjectBlockProps,
  next: ProjectBlockProps,
): boolean {
  const previousActive = isProjectSelectedByRoute({
    selection: previous.activeWorkspaceSelection,
    project: previous.project,
    enabled: previous.selectionEnabled,
  });
  const nextActive = isProjectSelectedByRoute({
    selection: next.activeWorkspaceSelection,
    project: next.project,
    enabled: next.selectionEnabled,
  });
  if (previousActive !== nextActive) {
    return false;
  }
  if (!previousActive) {
    return true;
  }
  return (
    activeWorkspaceSelectionKey(previous.activeWorkspaceSelection) ===
    activeWorkspaceSelectionKey(next.activeWorkspaceSelection)
  );
}

const MemoProjectBlock = memo(ProjectBlock, areProjectBlockPropsEqual);

export function SidebarWorkspaceList({
  workspaceGroups,
  projectIconTargets,
  projects,
  hasProjectsBeforeFilter,
  hasHiddenProjects,
  workspaceEntriesByKey,
  collapsedProjectKeys,
  onToggleProjectCollapsed,
  shortcutIndexByWorkspaceKey,
  groupMode,
  isRefreshing: _isRefreshing = false,
  onRefresh: _onRefresh,
  onWorkspacePress,
  listFooterComponent,
  listHeaderComponent,
  parentGestureRef,
  dragGestureHostPresented,
}: SidebarWorkspaceListProps) {
  const pathname = usePathname();
  const hosts = useHosts();
  const rowItems = useSidebarRowItems();
  // Host badge visibility is a lattice, not three competing switches: this gate is the global
  // "off", `shouldShowSidebarHostLabels` is the automatic "there is only one host so it says
  // nothing", and each host's own `badgeDisplay` decides name vs icon vs hidden. Turning the
  // item off here removes the badge everywhere; leaving it on defers to the per-host setting.
  const hostBadgeByServerId = useHostBadges({
    enabled: rowItems.host && shouldShowSidebarHostLabels(projects),
  });
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supportsPinningByServerId = useHostFeatureMap(serverIds, "workspacePinning");
  const onToggleWorkspacePin = useSidebarWorkspacePinController();
  const hasActiveLabelFilter = useSidebarViewStore((state) =>
    hasActiveSidebarLabelFilter(state.labelFilter),
  );
  // One fetch, one map, every mode — project mode paints icons on its headers and status mode
  // paints them on each row, all keyed by `projectViewKey`. The targets come from the projection
  // that produced the rows, so the question "what is on screen" is answered once.
  const projectIconByProjectViewKey = useProjectIcons({ projects: projectIconTargets });

  // A filter that matches nothing swaps the list's body and nothing above it. It used to replace
  // this whole subtree, which unmounted the header — and the header is where the display menu's
  // trigger lives, so filtering the last row away closed the menu you were filtering from.
  //
  // Project visibility is handled separately: a fully hidden list is intentional, and the header
  // remains available below so projects can be shown again.
  const sidebarFilterEmpty =
    hasActiveLabelFilter && hasProjectsBeforeFilter && projects.length === 0;

  // Project mode is the one that keeps its project headers; every other grouping mode is a flat
  // list of grouped rows, so a new mode lands in the grouped branch rather than silently in this
  // one's `else`.
  const content =
    groupMode !== "project" ? (
      <SidebarGroupedModeList
        workspaceGroups={workspaceGroups}
        projectIconByProjectViewKey={projectIconByProjectViewKey}
        shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
        onWorkspacePress={onWorkspacePress}
        hostBadgeByServerId={hostBadgeByServerId}
        supportsPinningByServerId={supportsPinningByServerId}
        onToggleWorkspacePin={onToggleWorkspacePin}
        listHeaderComponent={listHeaderComponent}
        sidebarFilterEmpty={sidebarFilterEmpty}
      />
    ) : (
      <ProjectModeList
        projects={projects}
        workspaceEntriesByKey={workspaceEntriesByKey}
        projectIconByProjectViewKey={projectIconByProjectViewKey}
        collapsedProjectKeys={collapsedProjectKeys}
        onToggleProjectCollapsed={onToggleProjectCollapsed}
        shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
        onWorkspacePress={onWorkspacePress}
        listFooterComponent={listFooterComponent}
        listHeaderComponent={listHeaderComponent}
        sidebarFilterEmpty={sidebarFilterEmpty}
        hasHiddenProjects={hasHiddenProjects}
        parentGestureRef={parentGestureRef}
        dragGestureHostPresented={dragGestureHostPresented}
        pathname={pathname}
        hostBadgeByServerId={hostBadgeByServerId}
        supportsPinningByServerId={supportsPinningByServerId}
        onToggleWorkspacePin={onToggleWorkspacePin}
      />
    );

  return content;
}

/**
 * Every grouping mode except project: the rows are grouped by something that is not a project, so
 * each row carries its own project icon. Named for what it does rather than for the first mode
 * that needed it — `SidebarStatusModeWrapper` is what made a label-mode reader believe the data
 * above it was status-only.
 */
function SidebarGroupedModeList({
  workspaceGroups,
  projectIconByProjectViewKey,
  shortcutIndexByWorkspaceKey: _projectShortcutIndex,
  onWorkspacePress,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
  listHeaderComponent,
  sidebarFilterEmpty,
}: {
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  onWorkspacePress?: () => void;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
  listHeaderComponent?: ReactElement | null;
  sidebarFilterEmpty: boolean;
}) {
  const showShortcutBadges = useShowShortcutBadges();

  return (
    <SidebarStatusWorkspaceList
      groups={workspaceGroups}
      projectIconByProjectViewKey={projectIconByProjectViewKey}
      shortcutIndexByWorkspaceKey={_projectShortcutIndex}
      showShortcutBadges={showShortcutBadges}
      onWorkspacePress={onWorkspacePress}
      hostBadgeByServerId={hostBadgeByServerId}
      supportsPinningByServerId={supportsPinningByServerId}
      onToggleWorkspacePin={onToggleWorkspacePin}
      listHeaderComponent={listHeaderComponent}
      sidebarFilterEmpty={sidebarFilterEmpty}
    />
  );
}

function ProjectModeList({
  projects,
  workspaceEntriesByKey,
  projectIconByProjectViewKey,
  collapsedProjectKeys,
  onToggleProjectCollapsed,
  shortcutIndexByWorkspaceKey,
  onWorkspacePress,
  listFooterComponent,
  listHeaderComponent,
  sidebarFilterEmpty,
  hasHiddenProjects,
  parentGestureRef,
  dragGestureHostPresented,
  pathname,
  hostBadgeByServerId,
  supportsPinningByServerId,
  onToggleWorkspacePin,
}: Omit<
  SidebarWorkspaceListProps,
  | "workspaceGroups"
  | "projectIconTargets"
  | "groupMode"
  | "hasProjectsBeforeFilter"
  | "isRefreshing"
  | "onRefresh"
> & {
  /** Swaps the list body for the label filter's empty state. Never the header above it. */
  sidebarFilterEmpty: boolean;
  projectIconByProjectViewKey: ReadonlyMap<string, string | null>;
  pathname: string;
  hostBadgeByServerId: ReadonlyMap<string, HostBadgeModel>;
  supportsPinningByServerId: ReadonlyMap<string, boolean>;
  onToggleWorkspacePin: ToggleSidebarWorkspacePin;
}) {
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const toast = useToast();
  const showShortcutBadges = useShowShortcutBadges();
  const activeRouteWorkspaceSelection = useActiveWorkspaceSelection();
  const workspaceLayouts = useWorkspaceLayoutStore((state) => state.layoutByWorkspace);
  const agentDraftsByProjectViewKey = useMemo(
    () =>
      groupSidebarAgentDrafts({
        projects,
        workspaceLayouts,
        activeRouteSelection: activeRouteWorkspaceSelection,
      }),
    [activeRouteWorkspaceSelection, projects, workspaceLayouts],
  );

  const getProjectOrder = useSidebarOrderStore((state) => state.getProjectOrder);
  const setProjectOrder = useSidebarOrderStore((state) => state.setProjectOrder);
  const getWorkspaceOrder = useSidebarOrderStore((state) => state.getWorkspaceOrder);
  const setWorkspaceOrder = useSidebarOrderStore((state) => state.setWorkspaceOrder);

  const isWorkspaceRoute = useMemo(
    () => Boolean(pathname && parseHostWorkspaceRouteFromPathname(pathname)),
    [pathname],
  );
  const selectionEnabled = isWorkspaceRoute;
  const activeWorkspaceSelection = useSidebarActiveWorkspaceSelection();
  const nativeScrollGestureProps = useMemo(
    () =>
      parentGestureRef
        ? ({
            // NestableScrollContainer forwards props to RNGH ScrollView. Keep
            // vertical scroll and sidebar close pan simultaneous: vertical
            // intent scrolls immediately, clear horizontal intent can still
            // activate close from inside the list.
            simultaneousHandlers: parentGestureRef,
          } as object)
        : undefined,
    [parentGestureRef],
  );

  const handleCreateConversationDraft = useCallback(
    (source: SidebarConversationDraftSource) => {
      onWorkspacePress?.();
      void openProjectWorkspaceDraft({
        serverId: source.serverId,
        projectId: source.projectId,
        projectRootPath: source.sourceDirectory,
        tabHost: activeRouteWorkspaceSelection,
      }).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [activeRouteWorkspaceSelection, onWorkspacePress, toast],
  );
  const handleProjectDragEnd = useCallback(
    (reorderedProjects: SidebarProjectEntry[]) => {
      const reorderedProjectKeys = reorderedProjects.map((project) => project.viewKey);
      const currentProjectOrder = getProjectOrder();
      if (
        !hasVisibleOrderChanged({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        })
      ) {
        return;
      }

      setProjectOrder(
        mergeWithRemainder({
          currentOrder: currentProjectOrder,
          reorderedVisibleKeys: reorderedProjectKeys,
        }),
      );
    },
    [getProjectOrder, setProjectOrder],
  );

  const handleWorkspaceReorder = useCallback(
    (projectViewKey: string, reorderedWorkspaces: SidebarWorkspacePlacement[]) => {
      const reorderedWorkspaceKeys = reorderedWorkspaces.map((workspace) => workspace.workspaceKey);
      const currentWorkspaceOrder = getWorkspaceOrder(projectViewKey);
      if (
        !hasVisibleOrderChanged({
          currentOrder: currentWorkspaceOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        })
      ) {
        return;
      }

      setWorkspaceOrder(
        projectViewKey,
        mergeWithRemainder({
          currentOrder: currentWorkspaceOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        }),
      );
    },
    [getWorkspaceOrder, setWorkspaceOrder],
  );

  const renderProjectBlock = useCallback(
    (
      item: SidebarProjectEntry,
      dragState: {
        drag: () => void;
        isDragging: boolean;
        dragHandleProps?: DraggableRenderItemInfo<SidebarProjectEntry>["dragHandleProps"];
      },
    ) => {
      return (
        <MemoProjectBlock
          key={item.viewKey}
          project={item}
          agentDrafts={agentDraftsByProjectViewKey.get(item.viewKey) ?? EMPTY_AGENT_DRAFTS}
          workspaceEntriesByKey={workspaceEntriesByKey}
          collapsed={collapsedProjectKeys.has(item.viewKey)}
          displayName={item.projectName}
          iconDataUri={projectIconByProjectViewKey.get(item.viewKey) ?? null}
          selectionEnabled={selectionEnabled}
          showShortcutBadges={showShortcutBadges}
          shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
          parentGestureRef={parentGestureRef}
          onToggleCollapsed={onToggleProjectCollapsed}
          onWorkspacePress={onWorkspacePress}
          onWorkspaceReorder={handleWorkspaceReorder}
          onCreateConversationDraft={handleCreateConversationDraft}
          drag={dragState.drag}
          isDragging={dragState.isDragging}
          dragHandleProps={dragState.dragHandleProps}
          useNestable={platformIsNative}
          dragGestureHostPresented={dragGestureHostPresented}
          activeWorkspaceSelection={activeWorkspaceSelection}
          hostBadgeByServerId={hostBadgeByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
        />
      );
    },
    [
      collapsedProjectKeys,
      activeWorkspaceSelection,
      agentDraftsByProjectViewKey,
      onWorkspacePress,
      handleCreateConversationDraft,
      handleWorkspaceReorder,
      hostBadgeByServerId,
      supportsPinningByServerId,
      onToggleWorkspacePin,
      onToggleProjectCollapsed,
      parentGestureRef,
      dragGestureHostPresented,
      projectIconByProjectViewKey,
      selectionEnabled,
      shortcutIndexByWorkspaceKey,
      showShortcutBadges,
      workspaceEntriesByKey,
    ],
  );

  const renderProject = useCallback(
    ({ item, drag, isActive, dragHandleProps }: DraggableRenderItemInfo<SidebarProjectEntry>) =>
      renderProjectBlock(item, { drag, isDragging: isActive, dragHandleProps }),
    [renderProjectBlock],
  );

  const projectBody =
    projects.length === 0 ? null : (
      <DraggableList
        testID="sidebar-project-list"
        data={projects}
        keyExtractor={projectViewKeyExtractor}
        renderItem={renderProject}
        onDragEnd={handleProjectDragEnd}
        extraData={activeWorkspaceSelectionKey(activeWorkspaceSelection)}
        scrollEnabled={false}
        useDragHandle
        nestable={platformIsNative}
        simultaneousGestureRef={parentGestureRef}
        gestureHostPresented={dragGestureHostPresented}
        containerStyle={styles.projectListContainer}
      />
    );

  const content = (
    <>
      {/* The header carries the display menu, including the way to show hidden projects again. */}
      {projects.length > 0 || hasActiveHostFilter || hasHiddenProjects || sidebarFilterEmpty
        ? listHeaderComponent
        : null}
      {sidebarFilterEmpty ? <SidebarFilterEmptyState /> : projectBody}
      {listFooterComponent}
    </>
  );

  return (
    <View style={styles.container}>
      {platformIsNative ? (
        <NestableScrollContainer
          {...nativeScrollGestureProps}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-project-workspace-list-scroll"
        >
          {content}
        </NestableScrollContainer>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          testID="sidebar-project-workspace-list-scroll"
        >
          {content}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    // Optical inset aligns section glyphs with the schedules icon across the divider.
    paddingTop: 2,
    paddingBottom: theme.spacing[4],
  },
  projectListContainer: {
    width: "100%",
  },
  // Three times the gap a row keeps from its neighbour, so the break between two groups reads as
  // a break rather than as one more row of pitch. Kept equal to `statusGroupBlockExpanded` — the
  // two groupings are the same list under a different heading and must not breathe differently.
  //
  // Padding on the block rather than margin, and only while it has children: the gap belongs to
  // the rows underneath the header, so a collapsed project gives it back and a column of collapsed
  // headers closes up to the pitch of a list instead of staying spaced for content that is gone.
  projectBlockExpanded: {
    paddingBottom: theme.spacing[2],
  },
  workspaceListContainer: {},
  agentDraftRow: {
    minHeight: buttonControlHeight.xs,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  agentDraftStatusSlot: {
    width: theme.iconSize.md,
    alignItems: "center",
  },
  agentDraftStatusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  agentDraftText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    flexShrink: 1,
  },
  projectRow: {
    position: "relative",
    minHeight: 32,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    marginBottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  projectRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  projectRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  projectRowDragging: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    transform: [{ scale: 1.02 }],
    zIndex: 3,
    ...theme.shadow.md,
  },
  projectRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  projectTitleGroup: {
    flex: 1,
    minWidth: 0,
    gap: 0,
  },
  projectTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    fontWeight: "400",
    minWidth: 0,
    flexShrink: 1,
  },
  projectActionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  projectActionButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  projectActionButtonText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  projectIconActionButton: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  projectIconActionButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  projectIconActionButtonHidden: {
    opacity: 0,
  },
  projectTrailingActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    flexShrink: 0,
    // MoreVertical paints only around the center of its 14px SVG. Keep the 24px controls,
    // but pull their painted edge through the unused view-box space onto the row rail.
    marginRight: -6,
  },
  projectKebabButton: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  projectKebabButtonHidden: {
    opacity: 0,
  },
  projectKebabButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  projectTrailingControlSlot: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  projectActionTooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  projectActionTooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  projectActionTooltipShortcut: {},
  projectShortcutBadgeOverlay: {
    position: "absolute",
    top: theme.spacing[2] + 1,
    right: theme.spacing[2],
  },
  workspaceRow: {
    minHeight: buttonControlHeight.xs,
    marginBottom: 0,
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "center",
    gap: theme.spacing[0.5],
    userSelect: "none",
  },
  workspaceRowMain: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    width: "100%",
  },
  workspaceRowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  workspaceRowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
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
  workspaceRowContainer: {
    position: "relative",
  },
  workspaceStatusDot: {
    position: "relative",
    width: WORKSPACE_STATUS_DOT_WIDTH,
    height: 16,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  workspaceArchivingOverlay: {
    ...RNStyleSheet.absoluteFillObject,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: `${theme.colors.surface0}cc`,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    zIndex: 1,
  },
  workspaceArchivingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  workspaceBranchText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
    opacity: 0.76,
    flex: 1,
    minWidth: 0,
  },
  workspaceBranchTextCreating: {
    opacity: 0.92,
  },
  workspaceBranchTextHovered: {
    opacity: 1,
  },
  workspacePrBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: WORKSPACE_STATUS_DOT_WIDTH + theme.spacing[2],
  },
  workspaceCreatingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  kebabButton: {
    padding: 2,
    borderRadius: 4,
    marginLeft: 2,
  },
  kebabButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
