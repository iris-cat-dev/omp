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
import type { SidebarWorkspaceRename } from "@/components/sidebar/sidebar-workspace-inline-rename";
import {
  memo,
  Fragment,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type MutableRefObject,
  type Ref,
  type ComponentProps,
  type PropsWithChildren,
} from "react";
import { useTranslation } from "react-i18next";
import { router, usePathname } from "expo-router";
import {
  navigateToSidebarWorkspace,
  navigateToWorkspace,
  navigateToProject,
  useActiveProjectSelection,
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
import { SIDEBAR_LIST_INSET, useIsCompactFormFactor } from "@/constants/layout";
import { useShowPersistentActions } from "@/hooks/use-fine-pointer";
import { useProjectIcons } from "@/projects/icons";
import {
  buildHostProjectRoute,
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
import { SidebarWorkspaceQuickActions } from "@/components/sidebar/sidebar-workspace-quick-actions";
import { useSidebarWorkspaceFork } from "@/components/sidebar/use-sidebar-workspace-fork";
import { useReferenceWorkspaceContent } from "@/components/sidebar/use-reference-workspace-content";
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
import { SidebarWorkspaceTrailingContent } from "@/components/sidebar/workspace-trailing";
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
import { useSessionStore } from "@/stores/session-store";
import { useSidebarRowItems } from "@/components/sidebar/display-preferences/model";
import { openProjectWorkspaceDraft } from "@/utils/open-project-workspace-draft";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { groupSidebarAgentDrafts, type SidebarAgentDraft } from "@/components/sidebar-agent-drafts";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { archiveEmptyWorkspace } from "@/workspace/workspace-archive";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { shouldFocusProjectOnPress } from "@/utils/project-row-interaction";
import { resolveProjectLayoutKey } from "@/workspace-tabs/project-scope";
import { isWorkspaceSidePanelToolTarget } from "@/workspace-tabs/side-panel-target";

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
  selection: { serverId: string; projectId: string } | null;
  project: SidebarProjectEntry;
  enabled: boolean;
}): boolean {
  return (
    input.enabled &&
    input.project.hosts.some(
      (host) =>
        host.serverId === input.selection?.serverId && host.projectId === input.selection.projectId,
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
  chevron: "expand" | "collapse" | null;
  onPress: (event: GestureResponderEvent) => void;
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
  onFork?: () => void;
  forkPending?: boolean;
  onDelete?: () => void;
  deleteStatus?: "idle" | "pending" | "success";
  deletePendingLabel?: string;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onReferenceContent?: () => void;
  referenceContentStatus?: "idle" | "pending" | "success";
  onRename?: () => void;
  rename?: SidebarWorkspaceRename;
  onMarkAsRead?: () => void;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  isPinned?: boolean;
  onTogglePin?: () => void;
  reserveIdleStatusIndicatorSpace?: boolean;
}

interface SidebarConversationDraftSource {
  serverId: string;
  sourceDirectory: string;
  projectId: string;
}
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

function stopRowActionPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

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
  const showPersistentActions = useShowPersistentActions();
  const actionsVisible =
    isHovered || showPersistentActions || platformIsNative || isMobileBreakpoint;
  const kebab = useOpenKebabMenuVisibility(actionsVisible);
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
          style={!kebab.showKebab && styles.projectKebabButtonHidden}
          pointerEvents={kebab.showKebab ? "auto" : "none"}
        >
          <ProjectKebabMenu
            {...kebab.menuProps}
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
  open,
  onOpenChange,
}: {
  projectViewKey: string;
  settingsTarget: { serverId: string; projectId: string } | null;
  projectPath: string;
  onRemoveProject: () => void;
  removeProjectStatus: "idle" | "pending" | "success";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        hitSlop={8}
        style={projectKebabStyle}
        accessibilityRole="button"
        onPressIn={stopRowActionPropagation}
        {...(platformIsWeb ? { onPointerDown: stopRowActionPropagation } : {})}
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
  onFork,
  forkPending,
  onMarkAsRead,
  onDelete,
  deleteStatus,
  deletePendingLabel,
  onCopyBranchName,
  onCopyPath,
  onReferenceContent,
  referenceContentStatus,
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
  onFork?: () => void;
  forkPending?: boolean;
  onMarkAsRead?: () => void;
  onDelete?: () => void;
  deleteStatus?: "idle" | "pending" | "success";
  deletePendingLabel?: string;
  onCopyBranchName?: () => void;
  onCopyPath?: () => void;
  onReferenceContent?: () => void;
  referenceContentStatus?: "idle" | "pending" | "success";
  onRename?: () => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
}) {
  const workspacePath = workspace.workspaceDirectory ?? workspace.projectRootPath;
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
    isHovered,
    isTouchPlatform,
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
            <SidebarWorkspaceQuickActions
              workspaceKey={workspace.workspaceKey}
              onDelete={onDelete}
              onArchive={onArchive}
              deleteStatus={deleteStatus}
              archiveStatus={archiveStatus}
              disabled={
                isCreating ||
                deleteStatus === "pending" ||
                archiveStatus === "pending" ||
                forkPending
              }
              visible={isHovered && !isTouchPlatform}
            />
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
                onFork={onFork}
                forkPending={forkPending}
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
            onPressIn={stopRowActionPropagation}
            {...(platformIsWeb ? { onPointerDown: stopRowActionPropagation } : {})}
            disabled={loading}
            accessibilityRole="button"
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
  tabId,
  selected,
  onWorkspacePress,
}: SidebarAgentDraft & { onWorkspacePress?: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const activeRouteWorkspaceSelection = useActiveWorkspaceSelection();
  const routeActive =
    activeRouteWorkspaceSelection?.serverId === serverId &&
    activeRouteWorkspaceSelection.workspaceId === tabHostWorkspaceId;
  const showPersistentActions = useShowPersistentActions();
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const handlePress = useCallback(() => {
    onWorkspacePress?.();
    navigateToWorkspace({
      serverId,
      workspaceId: tabHostWorkspaceId,
      target: { kind: "draft", draftId, workspaceId },
    });
  }, [draftId, onWorkspacePress, serverId, tabHostWorkspaceId, workspaceId]);
  const handleDelete = useCallback(() => {
    const layoutStore = useWorkspaceLayoutStore.getState();
    const hostKey = resolveProjectLayoutKey({ serverId, workspaceId });
    if (!hostKey) return;
    const tab = layoutStore.getWorkspaceTabs(hostKey).find((entry) => entry.tabId === tabId);
    if (
      tab?.target.kind !== "draft" ||
      tab.target.draftId !== draftId ||
      (tab.target.workspaceId?.trim() || tabHostWorkspaceId) !== workspaceId
    ) {
      return;
    }

    const result = layoutStore.closeTab(hostKey, tabId);
    if (!result) return;
    useDraftStore.getState().clearDraftInput({
      draftKey: buildDraftStoreKey({ serverId, agentId: tabId, draftId }),
      lifecycle: "abandoned",
    });
    useWorkspaceAttachmentsStore.getState().clearWorkspaceAttachments({
      scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
    });
    useWorkspaceDraftSubmissionStore.getState().consumePending({
      serverId,
      workspaceId,
      draftId,
    });

    const remainingLayouts = useWorkspaceLayoutStore.getState().layoutByWorkspace;
    const hasRemainingTabsForWorkspace = Object.entries(remainingLayouts).some(
      ([key, layout]) =>
        key.startsWith(`${serverId}:project:`) &&
        collectAllTabs(layout.root).some(
          (entry) =>
            entry.target.workspaceId?.trim() === workspaceId &&
            !isWorkspaceSidePanelToolTarget(entry.target),
        ),
    );
    // Keep in-flight create attempts: the server request can complete after the tab is closed,
    // and archiveEmptyWorkspace uses them to protect workspaces from premature archival.
    const archiveIfUnused = (candidateId: string) => {
      const candidateLayoutKey = resolveProjectLayoutKey({ serverId, workspaceId: candidateId });
      const hasOtherDraft = Object.entries(remainingLayouts).some(
        ([key, layout]) =>
          key.startsWith(`${serverId}:project:`) &&
          collectAllTabs(layout.root).some(
            (entry) =>
              entry.target.kind === "draft" &&
              (entry.target.workspaceId?.trim() === candidateId ||
                (!entry.target.workspaceId && key === candidateLayoutKey)),
          ),
      );
      if (hasOtherDraft) return;
      if (result !== "workspace-empty") {
        redirectIfArchivingActiveWorkspace({
          serverId,
          workspaceId: candidateId,
          activeWorkspaceSelection: routeActive
            ? { serverId, workspaceId: tabHostWorkspaceId }
            : null,
        });
      }
      void archiveEmptyWorkspace({
        client: getHostRuntimeStore().getClient(serverId),
        workspace: { serverId, workspaceId: candidateId },
        closedDraftId: draftId,
        hasPendingTerminalCreate: false,
        preserveDrafts: true,
      }).catch((error: unknown) => {
        toast.error(
          t("sidebar.workspace.toasts.emptyArchiveFailed", {
            reason:
              error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
          }),
        );
      });
    };

    // Companion tools do not keep a deleted draft alive; content tabs still do.
    // The server re-verifies emptiness before retiring the workspace record.
    if (!hasRemainingTabsForWorkspace) {
      archiveIfUnused(workspaceId);
    }
    if (result === "workspace-empty" && routeActive) {
      const projectId = useSessionStore
        .getState()
        .sessions[serverId]?.workspaces.get(workspaceId)?.projectId;
      if (projectId) router.replace(buildHostProjectRoute(serverId, projectId));
    }
  }, [draftId, routeActive, serverId, t, tabHostWorkspaceId, tabId, toast, workspaceId]);
  const handleDeletePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      handleDelete();
    },
    [handleDelete],
  );
  const handleContextMenuOpenChange = useCallback((open: boolean) => {
    setContextMenuOpen(open);
    if (open) setIsHovered(false);
  }, []);
  const rowStyle = [
    styles.agentDraftRow,
    selected && styles.sidebarRowSelected,
    isHovered && !isPressed && styles.workspaceRowHovered,
    isPressed && styles.workspaceRowPressed,
  ];
  const handleRowBlur = useCallback((event: { currentTarget: unknown }) => {
    if (platformIsWeb && (event.currentTarget as HTMLElement).contains(document.activeElement))
      return;
    setIsFocused(false);
  }, []);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleRowFocus = useCallback(() => setIsFocused(true), []);
  const handlePressIn = useCallback(() => setIsPressed(true), []);
  const handlePressOut = useCallback(() => setIsPressed(false), []);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const deleteLabel = t("newWorkspace.deleteDraft");

  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={handleContextMenuOpenChange}>
      <View
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
        style={rowStyle}
        onFocus={handleRowFocus}
        onBlur={handleRowBlur}
      >
        <ContextMenuTrigger
          enabledOnMobile={false}
          accessibilityRole="button"
          accessibilityLabel={t("newWorkspace.title")}
          accessibilityState={accessibilityState}
          onPress={handlePress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          style={styles.agentDraftRowMain}
          testID={`sidebar-agent-draft-${draftId}`}
        >
          <View style={styles.agentDraftStatusSlot}>
            <View style={styles.agentDraftStatusDot} />
          </View>
          <Text style={styles.agentDraftText} numberOfLines={1}>
            {t("newWorkspace.title")}
          </Text>
        </ContextMenuTrigger>
        <View
          style={styles.agentDraftDeleteSlot}
          pointerEvents={
            showPersistentActions || isFocused || isHovered || contextMenuOpen ? "auto" : "none"
          }
        >
          <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
            <TooltipTrigger asChild>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={deleteLabel}
                onPress={handleDeletePress}
                onPressIn={stopRowActionPropagation}
                style={[
                  styles.agentDraftDeleteButton,
                  !showPersistentActions &&
                    !isFocused &&
                    !isHovered &&
                    !contextMenuOpen &&
                    styles.agentDraftDeleteHidden,
                ]}
                testID={`sidebar-agent-draft-delete-${draftId}`}
              >
                <ThemedTrash2 size={15} uniProps={foregroundMutedColorMapping} />
              </Pressable>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center" offset={8}>
              <Text style={styles.projectActionTooltipText}>{deleteLabel}</Text>
            </TooltipContent>
          </Tooltip>
        </View>
      </View>
      <ContextMenuContent align="start" width={220}>
        <ContextMenuItem
          leading={trash2LeadingIcon}
          onSelect={handleDelete}
          testID={`sidebar-agent-draft-menu-delete-${draftId}`}
        >
          {deleteLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ProjectHeaderRow({
  project,
  displayName,
  iconDataUri,
  statusBucket,
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
  const [isFocused, setIsFocused] = useState(false);
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

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      if (interaction.didLongPressRef.current) {
        interaction.didLongPressRef.current = false;
        return;
      }
      onPress(event);
    },
    [interaction.didLongPressRef, onPress],
  );

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

  const projectRowStyle = [
    styles.projectRow,
    isDragging && styles.projectRowDragging,
    isHovered && styles.projectRowHovered,
    isPressed && styles.projectRowPressed,
  ];
  const handleRowBlur = useCallback((event: { currentTarget: unknown }) => {
    if (platformIsWeb && (event.currentTarget as HTMLElement).contains(document.activeElement))
      return;
    setIsFocused(false);
  }, []);
  const handleRowFocus = useCallback(() => setIsFocused(true), []);

  const rowChildren = (
    <View style={styles.projectRowLeft}>
      <ProjectLeadingVisual
        displayName={displayName}
        iconDataUri={iconDataUri}
        statusBucket={statusBucket}
        projectViewKey={project.viewKey}
        backdrop={getSidebarRowBackdrop({ isDragging, isPressed, isHovered })}
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
  );
  const trailingActions = (
    <>
      <ProjectRowTrailingActions
        projectViewKey={project.viewKey}
        displayName={displayName}
        workspaceTarget={workspaceTarget}
        settingsTarget={settingsTarget}
        projectPath={projectPath}
        isHovered={isHovered || isFocused}
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

  const row = (
    <View
      {...dragAttributes}
      {...dragHandleProps?.listeners}
      ref={dragHandleProps?.setActivatorNodeRef as unknown as Ref<View>}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      style={projectRowStyle}
      onFocus={handleRowFocus}
      onBlur={handleRowBlur}
    >
      {onRemoveProject ? (
        <ContextMenuTrigger
          enabledOnMobile={false}
          accessibilityRole="button"
          style={styles.projectRowPressTarget}
          highlightStyle={styles.projectRowPressed}
          onPressIn={handleProjectPressIn}
          onTouchMove={interaction.handleTouchMove}
          onPressOut={handleProjectPressOut}
          onPress={handlePress}
          testID={`sidebar-project-row-${project.viewKey}`}
        >
          {rowChildren}
        </ContextMenuTrigger>
      ) : (
        <PressHighlight
          accessibilityRole="button"
          style={styles.projectRowPressTarget}
          highlightStyle={styles.projectRowPressed}
          onPressIn={handleProjectPressIn}
          onTouchMove={interaction.handleTouchMove}
          onPressOut={handleProjectPressOut}
          onPress={handlePress}
          testID={`sidebar-project-row-${project.viewKey}`}
        >
          {rowChildren}
        </PressHighlight>
      )}
      {trailingActions}
    </View>
  );

  if (!onRemoveProject) return row;

  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={handleContextMenuOpenChange}>
      {row}
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
  onFork,
  forkPending,
  onDelete,
  deleteStatus,
  deletePendingLabel,
  onCopyBranchName,
  onCopyPath,
  onReferenceContent,
  referenceContentStatus,
  onRename,
  onMarkAsRead,
  rename,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  reserveIdleStatusIndicatorSpace = true,
}: WorkspaceRowInnerProps) {
  const isCompact = useIsCompactFormFactor();
  const [isPressed, setIsPressed] = useState(false);
  const isTouchPlatform = platformIsNative || isCompact;
  const handleDrag = useCallback(() => {
    if (!rename) drag();
  }, [drag, rename]);
  const interaction = useLongPressDragInteraction({
    drag: handleDrag,
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
    if (!rename) onPress();
  }, [interaction.didLongPressRef, onPress, rename]);
  const handleWorkspacePressIn = useCallback(
    (event: GestureResponderEvent) => {
      if (rename) return;
      setIsPressed(true);
      interaction.handlePressIn(event);
    },
    [interaction, rename],
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
            {...(!rename ? dragHandleProps?.listeners : undefined)}
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
              onReferenceContent={onReferenceContent}
              referenceContentStatus={referenceContentStatus}
              onFork={onFork}
              forkPending={forkPending}
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
                rename={rename}
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
                  onFork={onFork}
                  forkPending={forkPending}
                  deleteStatus={deleteStatus}
                  deletePendingLabel={deletePendingLabel}
                  onCopyBranchName={onCopyBranchName}
                  onCopyPath={onCopyPath}
                  onReferenceContent={onReferenceContent}
                  referenceContentStatus={referenceContentStatus}
                  onRename={onRename}
                  onMarkAsRead={onMarkAsRead}
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
  const [isRenaming, setIsRenaming] = useState(false);
  const deleteConfirmationOpenRef = useRef(false);
  const { canFork, isForking, fork } = useSidebarWorkspaceFork(workspace);
  const {
    canReferenceContent,
    isPending: isReferencingContent,
    referenceContent,
  } = useReferenceWorkspaceContent(workspace);
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
    if (isCreating || isArchiving || isDeleting || isForking) {
      return;
    }
    archiveController.archive();
  }, [archiveController, isCreating, isArchiving, isDeleting, isForking]);

  const handleDelete = useCallback(async () => {
    if (isCreating || isArchiving || isDeleting || isForking || deleteConfirmationOpenRef.current) {
      return;
    }
    deleteConfirmationOpenRef.current = true;
    try {
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
    } finally {
      deleteConfirmationOpenRef.current = false;
    }
  }, [
    deleteMutation,
    isCreating,
    isArchiving,
    isDeleting,
    isForking,
    t,
    workspace.name,
    workspace.title,
  ]);

  const handleFork = useCallback(() => {
    if (isCreating || isArchiving || isDeleting || isForking || !canFork) {
      return;
    }
    void fork();
  }, [canFork, fork, isCreating, isArchiving, isDeleting, isForking]);

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
    setIsRenaming(true);
  }, []);

  const handleCloseRename = useCallback(() => {
    setIsRenaming(false);
  }, []);

  const handleSubmitRename = useCallback(
    async (value: string) => {
      await renameMutation.mutateAsync(value.trim());
    },
    [renameMutation],
  );
  const rename = useMemo<SidebarWorkspaceRename | undefined>(
    () =>
      isRenaming
        ? {
            initialValue: workspace.title ?? workspace.name,
            placeholder: workspace.name,
            onSubmit: handleSubmitRename,
            onCancel: handleCloseRename,
          }
        : undefined,
    [handleCloseRename, handleSubmitRename, isRenaming, workspace.name, workspace.title],
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
      onFork={canFork ? handleFork : undefined}
      forkPending={isForking}
      onDelete={handleDelete}
      deleteStatus={isDeleting ? "pending" : "idle"}
      deletePendingLabel={t("sidebar.workspace.actions.deleting")}
      onCopyBranchName={canCopyBranchName ? handleCopyBranchName : undefined}
      onCopyPath={handleCopyPath}
      onReferenceContent={canReferenceContent ? referenceContent : undefined}
      referenceContentStatus={isReferencingContent ? "pending" : "idle"}
      onRename={handleOpenRename}
      rename={rename}
      onMarkAsRead={hasClearableAttention ? handleMarkAsRead : undefined}
      archiveShortcutKeys={selected ? archiveShortcutKeys : null}
      isPinned={isPinned}
      onTogglePin={onTogglePin}
      reserveIdleStatusIndicatorSpace={reserveIdleStatusIndicatorSpace}
    />
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
  onPinnedWorkspaceReorder,
  pinnedWorkspaceReorderEnabled,
  onCreateConversationDraft,
  drag,
  isDragging,
  dragHandleProps,
  useNestable,
  dragGestureHostPresented,
  activeWorkspaceSelection,
  activeProjectSelection,
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
  onPinnedWorkspaceReorder: (workspaces: SidebarWorkspacePlacement[]) => void;
  pinnedWorkspaceReorderEnabled: boolean;
  onCreateConversationDraft: (draft: SidebarConversationDraftSource) => void;
  drag: () => void;
  isDragging: boolean;
  dragHandleProps?: DraggableListDragHandleProps;
  useNestable: boolean;
  dragGestureHostPresented?: boolean;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  activeProjectSelection: { serverId: string; projectId: string } | null;
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
  const visiblePinnedWorkspaces = useMemo(
    () =>
      visibleWorkspaces.filter(
        (workspace) => workspaceEntriesByKey.get(workspace.workspaceKey)?.pinnedAt != null,
      ),
    [visibleWorkspaces, workspaceEntriesByKey],
  );
  const visibleUnpinnedWorkspaces = useMemo(
    () =>
      visibleWorkspaces.filter(
        (workspace) => workspaceEntriesByKey.get(workspace.workspaceKey)?.pinnedAt == null,
      ),
    [visibleWorkspaces, workspaceEntriesByKey],
  );

  // Collapsed rows hide their workspace rows, so the project row carries the most urgent
  // status among them; expanded rows leave the signal to the child rows themselves.
  const aggregateStatusBucket = useSidebarProjectStatusBucket({
    workspaces: project.workspaces,
    enabled: collapsed,
  });

  const active = isProjectSelectedByRoute({
    selection: activeProjectSelection,
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
  const handlePinnedWorkspaceDragEnd = useCallback(
    (workspaces: SidebarWorkspacePlacement[]) => {
      onPinnedWorkspaceReorder(workspaces);
    },
    [onPinnedWorkspaceReorder],
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

  const handleProjectPress = useCallback(
    (event: GestureResponderEvent) => {
      const nativeEvent: unknown = event.nativeEvent;
      const metaKey =
        !!nativeEvent &&
        typeof nativeEvent === "object" &&
        "metaKey" in nativeEvent &&
        nativeEvent.metaKey === true;
      if (
        shouldFocusProjectOnPress({
          metaKey,
          isMacDesktop:
            platformIsWeb &&
            getShortcutOs() === "mac" &&
            (typeof navigator === "undefined" || navigator.maxTouchPoints < 2),
        })
      ) {
        const host =
          project.hosts.find(
            (candidate) => candidate.serverId === activeProjectSelection?.serverId,
          ) ?? project.hosts[0];
        if (host) {
          onWorkspacePress?.();
          navigateToProject({ serverId: host.serverId, projectId: host.projectId });
        }
        return;
      }
      onToggleCollapsed(project.viewKey);
    },
    [
      activeProjectSelection?.serverId,
      onToggleCollapsed,
      onWorkspacePress,
      project.hosts,
      project.viewKey,
    ],
  );

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
        {pinnedWorkspaceReorderEnabled && visiblePinnedWorkspaces.length > 1 ? (
          <DraggableList
            testID={`sidebar-pinned-workspace-list-${project.viewKey}`}
            data={visiblePinnedWorkspaces}
            keyExtractor={workspaceKeyExtractor}
            renderItem={renderWorkspace}
            onDragEnd={handlePinnedWorkspaceDragEnd}
            extraData={activeWorkspaceSelectionKey(activeWorkspaceSelection)}
            scrollEnabled={false}
            useDragHandle
            nestable={useNestable}
            simultaneousGestureRef={parentGestureRef}
            gestureHostPresented={dragGestureHostPresented}
            containerStyle={styles.workspaceListContainer}
          />
        ) : (
          visiblePinnedWorkspaces.map((workspace) => (
            <Fragment key={workspace.workspaceKey}>{renderWorkspaceRow(workspace)}</Fragment>
          ))
        )}
        <DraggableList
          testID={`sidebar-workspace-list-${project.viewKey}`}
          data={visibleUnpinnedWorkspaces}
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
        chevron={rowModel.chevron}
        onPress={handleProjectPress}
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
    previous.onPinnedWorkspaceReorder === next.onPinnedWorkspaceReorder &&
    previous.pinnedWorkspaceReorderEnabled === next.pinnedWorkspaceReorderEnabled &&
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
    selection: previous.activeProjectSelection,
    project: previous.project,
    enabled: previous.selectionEnabled,
  });
  const nextActive = isProjectSelectedByRoute({
    selection: next.activeProjectSelection,
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
      activeWorkspaceSelectionKey(next.activeWorkspaceSelection) &&
    previous.activeProjectSelection?.serverId === next.activeProjectSelection?.serverId &&
    previous.activeProjectSelection?.projectId === next.activeProjectSelection?.projectId
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
        pinnedWorkspaceReorderEnabled={!hasActiveLabelFilter}
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
  pinnedWorkspaceReorderEnabled,
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
  /** Reordering is disabled while a label filter hides part of the persisted pinned order. */
  pinnedWorkspaceReorderEnabled: boolean;
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
        workspaceEntriesByKey,
        activeRouteSelection: activeRouteWorkspaceSelection,
      }),
    [activeRouteWorkspaceSelection, projects, workspaceEntriesByKey, workspaceLayouts],
  );

  const getProjectOrder = useSidebarOrderStore((state) => state.getProjectOrder);
  const setProjectOrder = useSidebarOrderStore((state) => state.setProjectOrder);
  const getWorkspaceOrder = useSidebarOrderStore((state) => state.getWorkspaceOrder);
  const setWorkspaceOrder = useSidebarOrderStore((state) => state.setWorkspaceOrder);
  const getPinnedWorkspaceOrder = useSidebarOrderStore((state) => state.getPinnedWorkspaceOrder);
  const setPinnedWorkspaceOrder = useSidebarOrderStore((state) => state.setPinnedWorkspaceOrder);

  const isWorkspaceRoute = useMemo(
    () => Boolean(pathname && parseHostWorkspaceRouteFromPathname(pathname)),
    [pathname],
  );
  const activeProjectSelection = useActiveProjectSelection();
  const selectionEnabled = isWorkspaceRoute || activeProjectSelection !== null;
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
  const handlePinnedWorkspaceReorder = useCallback(
    (reorderedWorkspaces: SidebarWorkspacePlacement[]) => {
      const reorderedWorkspaceKeys = reorderedWorkspaces.map((workspace) => workspace.workspaceKey);
      const currentPinnedWorkspaceOrder = getPinnedWorkspaceOrder();
      if (
        !hasVisibleOrderChanged({
          currentOrder: currentPinnedWorkspaceOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        })
      ) {
        return;
      }

      setPinnedWorkspaceOrder(
        mergeWithRemainder({
          currentOrder: currentPinnedWorkspaceOrder,
          reorderedVisibleKeys: reorderedWorkspaceKeys,
        }),
      );
    },
    [getPinnedWorkspaceOrder, setPinnedWorkspaceOrder],
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
          onPinnedWorkspaceReorder={handlePinnedWorkspaceReorder}
          pinnedWorkspaceReorderEnabled={pinnedWorkspaceReorderEnabled && !hasActiveHostFilter}
          onCreateConversationDraft={handleCreateConversationDraft}
          drag={dragState.drag}
          isDragging={dragState.isDragging}
          dragHandleProps={dragState.dragHandleProps}
          useNestable={platformIsNative}
          dragGestureHostPresented={dragGestureHostPresented}
          activeWorkspaceSelection={activeWorkspaceSelection}
          activeProjectSelection={activeProjectSelection}
          hostBadgeByServerId={hostBadgeByServerId}
          supportsPinningByServerId={supportsPinningByServerId}
          onToggleWorkspacePin={onToggleWorkspacePin}
        />
      );
    },
    [
      collapsedProjectKeys,
      activeProjectSelection,
      activeWorkspaceSelection,
      agentDraftsByProjectViewKey,
      onWorkspacePress,
      handleCreateConversationDraft,
      handleWorkspaceReorder,
      handlePinnedWorkspaceReorder,
      hasActiveHostFilter,
      pinnedWorkspaceReorderEnabled,
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
        extraData={`${activeWorkspaceSelectionKey(activeWorkspaceSelection)}:${activeProjectSelection?.serverId ?? ""}:${activeProjectSelection?.projectId ?? ""}`}
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
          showsVerticalScrollIndicator
          testID="sidebar-project-workspace-list-scroll"
        >
          {content}
        </NestableScrollContainer>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator
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
    paddingHorizontal: SIDEBAR_LIST_INSET,
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
    marginHorizontal: -SIDEBAR_LIST_INSET,
    paddingHorizontal: theme.spacing[2] + SIDEBAR_LIST_INSET,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  agentDraftRowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
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
  agentDraftDeleteSlot: {
    width: 20,
    height: 20,
    marginLeft: "auto",
    flexShrink: 0,
  },
  agentDraftDeleteButton: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  agentDraftDeleteHidden: {
    opacity: 0,
  },
  projectRow: {
    position: "relative",
    minHeight: 32,
    paddingVertical: theme.spacing[1.5],
    marginHorizontal: -SIDEBAR_LIST_INSET,
    paddingHorizontal: theme.spacing[2] + SIDEBAR_LIST_INSET,
    marginBottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  projectRowPressTarget: {
    flex: 1,
    minWidth: 0,
    alignSelf: "stretch",
    alignItems: "center",
    flexDirection: "row",
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
    right: theme.spacing[2] + SIDEBAR_LIST_INSET,
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
