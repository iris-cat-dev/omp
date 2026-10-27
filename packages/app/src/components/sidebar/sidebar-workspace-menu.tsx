import * as Clipboard from "expo-clipboard";
import { getParentAgentIdFromLabels } from "@omp-desktop/protocol/agent-labels";
import type { FetchAgentHistoryEntry } from "@omp-desktop/client/internal/daemon-client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type KeyboardEvent,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { type PressableStateCallbackType, type View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Archive,
  CircleCheck,
  Copy,
  MessageSquareQuote,
  MoreVertical,
  Pencil,
  Split,
  Pin,
  PinOff,
  Tag,
  Trash2,
} from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { pickWorkspacePrimaryAgentId } from "@/subagents/policies";
import { getForgePresentation, normalizeForge } from "@/git/forge";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { OpenInFileManagerMenuItem } from "@/workspace/open-in-file-manager/menu-item";
import { resolveSidebarWorkspaceAccessibilityLabel } from "@/components/sidebar/sidebar-workspace-title";
import {
  workspaceServiceLabelKey,
  type WorkspaceServiceSummary,
} from "@/components/sidebar/workspace-meta-row";
import {
  useWorkspaceLabelMenuPages,
  WORKSPACE_LABEL_PAGE_ID,
  type WorkspaceLabelTarget,
} from "@/workspace-labels/picker";
import {
  useWorkspaceConversationMenuPages,
  WORKSPACE_CONVERSATIONS_PAGE_ID,
} from "@/components/sidebar/workspace-conversations-menu";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedCopy = withUnistyles(Copy);
const ThemedArchive = withUnistyles(Archive);
const ThemedMessageSquareQuote = withUnistyles(MessageSquareQuote);
const ThemedPencil = withUnistyles(Pencil);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedSplit = withUnistyles(Split);
const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const ThemedTag = withUnistyles(Tag);
const ThemedTrash2 = withUnistyles(Trash2);

const copyLeadingIcon = <ThemedCopy size={14} uniProps={foregroundMutedColorMapping} />;
const renameLeadingIcon = <ThemedPencil size={14} uniProps={foregroundMutedColorMapping} />;
const referenceContentLeadingIcon = (
  <ThemedMessageSquareQuote size={14} uniProps={foregroundMutedColorMapping} />
);
const markAsReadLeadingIcon = (
  <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />
);
const archiveLeadingIcon = <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />;
const pinLeadingIcon = <ThemedPin size={14} uniProps={foregroundMutedColorMapping} />;
const unpinLeadingIcon = <ThemedPinOff size={14} uniProps={foregroundMutedColorMapping} />;
const deleteLeadingIcon = <ThemedTrash2 size={14} uniProps={foregroundMutedColorMapping} />;
const forkLeadingIcon = <ThemedSplit size={14} uniProps={foregroundMutedColorMapping} />;
const conversationsLeadingIcon = (
  <ThemedMessageSquareQuote size={14} uniProps={foregroundMutedColorMapping} />
);
const EMPTY_ROOT_AGENTS: readonly NonNullable<SidebarWorkspaceEntry["rootAgents"]>[number][] = [];

function renderTriggerIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical
      size={14}
      uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

function stopRowActionPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export interface SidebarWorkspaceMenuProps {
  workspaceKey: string;
  serverId?: string;
  workspaceId?: string;
  workspaceLabels?: readonly string[];
  rootAgents?: SidebarWorkspaceEntry["rootAgents"];
  onCopyPath?: () => void;
  onCopyBranchName?: () => void;
  onReferenceContent?: () => void;
  referenceContentStatus?: "idle" | "pending" | "success";
  onRename?: () => void;
  onMarkAsRead?: () => void;
  onFork?: () => void;
  forkPending?: boolean;
  onArchive: () => void;
  onDelete?: () => void;
  deleteStatus?: "idle" | "pending" | "success";
  deletePendingLabel?: string;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  isPinned?: boolean;
  onTogglePin?: () => void;
  openInFileManagerPath?: string | null;
  /**
   * Lifted so the row that reveals the kebab can keep it mounted while its menu is up. See
   * `useOpenKebabMenuVisibility`.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface SidebarWorkspaceMenuItemsProps extends Omit<
  SidebarWorkspaceMenuProps,
  "onArchive" | "open" | "onOpenChange" | "rootAgents"
> {
  onArchive?: () => void;
  rootAgentCount?: number;
}

type MenuSurface = "context" | "dropdown";

function WorkspaceMenuItem({
  surface,
  children,
  ...props
}: PropsWithChildren<
  Omit<ComponentProps<typeof DropdownMenuItem>, "children"> & { surface: MenuSurface }
>) {
  if (surface === "context") {
    return <ContextMenuItem {...props}>{children}</ContextMenuItem>;
  }
  return <DropdownMenuItem {...props}>{children}</DropdownMenuItem>;
}

function SidebarWorkspaceMenuItems({
  surface,
  workspaceKey,
  serverId,
  workspaceId,
  onCopyPath,
  onCopyBranchName,
  onReferenceContent,
  referenceContentStatus,
  onRename,
  onMarkAsRead,
  onFork,
  forkPending,
  onArchive,
  onDelete,
  deleteStatus,
  deletePendingLabel,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  openInFileManagerPath,
  rootAgentCount = 0,
}: SidebarWorkspaceMenuItemsProps & { surface: MenuSurface }): ReactNode {
  const { t } = useTranslation();
  const toast = useToast();
  const copyAgentId = useCallback(async () => {
    if (!serverId || !workspaceId) return;
    try {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      const entries: FetchAgentHistoryEntry[] = [];
      let cursor: string | null = null;
      do {
        const history = await client.fetchAgentHistory({
          filter: { includeArchived: true, workspaceIds: [workspaceId] },
          sort: [{ key: "created_at", direction: "asc" }],
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        entries.push(...history.entries);
        cursor = history.pageInfo.hasMore ? history.pageInfo.nextCursor : null;
      } while (cursor);
      const agentId = pickWorkspacePrimaryAgentId(
        entries.map(({ agent }) => ({
          id: agent.id,
          workspaceId: agent.workspaceId,
          parentAgentId: getParentAgentIdFromLabels(agent.labels),
          createdAt: agent.createdAt,
          archivedAt: agent.archivedAt,
        })),
        workspaceId,
      );
      if (!agentId) throw new Error(t("workspace.tabs.toasts.copyFailed"));
      await Clipboard.setStringAsync(agentId);
      toast.copied(t("workspace.tabs.toasts.agentIdCopiedLabel"));
    } catch {
      toast.error(t("workspace.tabs.toasts.copyFailed"));
    }
  }, [serverId, workspaceId, t, toast]);
  const archiveTrailing = useMemo(
    () => (archiveShortcutKeys ? <Shortcut chord={archiveShortcutKeys} /> : null),
    [archiveShortcutKeys],
  );
  const labelLeading = useMemo(
    () => <ThemedTag size={14} uniProps={foregroundMutedColorMapping} />,
    [],
  );

  return (
    <>
      {onCopyPath ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-copy-path-${workspaceKey}`}
          leading={copyLeadingIcon}
          onSelect={onCopyPath}
        >
          {t("sidebar.workspace.actions.copyPath")}
        </WorkspaceMenuItem>
      ) : null}
      {serverId && workspaceId ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-copy-agent-id-${workspaceKey}`}
          leading={copyLeadingIcon}
          onSelect={copyAgentId}
        >
          {t("workspace.tabs.menu.copyAgentId")}
        </WorkspaceMenuItem>
      ) : null}
      <OpenInFileManagerMenuItem
        surface={surface}
        path={openInFileManagerPath}
        testID={`sidebar-workspace-menu-open-folder-${workspaceKey}`}
      />
      {onCopyBranchName ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-copy-branch-name-${workspaceKey}`}
          leading={copyLeadingIcon}
          onSelect={onCopyBranchName}
        >
          {t("sidebar.workspace.actions.copyBranchName")}
        </WorkspaceMenuItem>
      ) : null}
      {onReferenceContent ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-reference-content-${workspaceKey}`}
          leading={referenceContentLeadingIcon}
          onSelect={onReferenceContent}
          status={referenceContentStatus}
        >
          {t("sidebar.workspace.actions.referenceContent")}
        </WorkspaceMenuItem>
      ) : null}
      {onRename ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-rename-${workspaceKey}`}
          leading={renameLeadingIcon}
          onSelect={onRename}
        >
          {t("sidebar.workspace.actions.rename")}
        </WorkspaceMenuItem>
      ) : null}
      {onMarkAsRead ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-mark-as-read-${workspaceKey}`}
          leading={markAsReadLeadingIcon}
          onSelect={onMarkAsRead}
        >
          Mark as read
        </WorkspaceMenuItem>
      ) : null}
      {onFork ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-fork-${workspaceKey}`}
          leading={forkLeadingIcon}
          onSelect={onFork}
          status={forkPending ? "pending" : "idle"}
        >
          {t("message.actions.forkInNewWorkspace")}
        </WorkspaceMenuItem>
      ) : null}
      {onTogglePin ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-pin-${workspaceKey}`}
          leading={isPinned ? unpinLeadingIcon : pinLeadingIcon}
          onSelect={onTogglePin}
        >
          {isPinned ? t("sidebar.workspace.actions.unpin") : t("sidebar.workspace.actions.pin")}
        </WorkspaceMenuItem>
      ) : null}
      {rootAgentCount > 1 ? (
        <DropdownMenuSubTrigger
          id={WORKSPACE_CONVERSATIONS_PAGE_ID}
          leading={conversationsLeadingIcon}
          testID={`sidebar-workspace-menu-conversations-${workspaceKey}`}
        >
          {t("sidebar.workspace.actions.conversations", { count: rootAgentCount })}
        </DropdownMenuSubTrigger>
      ) : null}
      {serverId && workspaceId ? (
        <DropdownMenuSubTrigger
          id={WORKSPACE_LABEL_PAGE_ID}
          leading={labelLeading}
          testID={`sidebar-workspace-menu-labels-${workspaceKey}`}
        >
          {t("workspaceLabels.title")}
        </DropdownMenuSubTrigger>
      ) : null}
      {onArchive ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-archive-${workspaceKey}`}
          leading={archiveLeadingIcon}
          trailing={archiveTrailing}
          status={archiveStatus}
          pendingLabel={archivePendingLabel}
          onSelect={onArchive}
        >
          {archiveLabel ?? t("sidebar.workspace.actions.archive")}
        </WorkspaceMenuItem>
      ) : null}
      {onDelete ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-delete-${workspaceKey}`}
          leading={deleteLeadingIcon}
          status={deleteStatus}
          pendingLabel={deletePendingLabel}
          onSelect={onDelete}
        >
          {t("sidebar.workspace.actions.delete")}
        </WorkspaceMenuItem>
      ) : null}
    </>
  );
}

export function SidebarWorkspaceMenu({
  workspaceKey,
  serverId,
  workspaceId,
  workspaceLabels,
  rootAgents = EMPTY_ROOT_AGENTS,
  onCopyPath,
  onCopyBranchName,
  onReferenceContent,
  referenceContentStatus,
  onRename,
  onMarkAsRead,
  onFork,
  forkPending,
  onArchive,
  onDelete,
  deleteStatus,
  deletePendingLabel,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  openInFileManagerPath,
  open,
  onOpenChange,
}: SidebarWorkspaceMenuProps) {
  const { t } = useTranslation();
  const workspaceTarget = useMemo<WorkspaceLabelTarget | null>(
    () =>
      serverId && workspaceId ? { serverId, workspaceId, labels: workspaceLabels ?? [] } : null,
    [serverId, workspaceId, workspaceLabels],
  );
  const labelPages = useWorkspaceLabelMenuPages(workspaceTarget);
  const conversationPages = useWorkspaceConversationMenuPages({
    serverId,
    workspaceId,
    rootAgents,
  });
  const pages = useMemo(
    () => [...conversationPages, ...labelPages],
    [conversationPages, labelPages],
  );
  return (
    <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole="button"
        onPressIn={stopRowActionPropagation}
        {...(isWeb ? { onPointerDown: stopRowActionPropagation } : {})}
        accessibilityLabel={t("sidebar.workspace.actions.menu")}
        testID={`sidebar-workspace-kebab-${workspaceKey}`}
      >
        {renderTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        width={260}
        pages={pages}
        sheetTitle={t("sidebar.workspace.actions.menu")}
      >
        <SidebarWorkspaceMenuItems
          surface="dropdown"
          workspaceKey={workspaceKey}
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceLabels={workspaceLabels}
          rootAgentCount={rootAgents.length}
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
          openInFileManagerPath={openInFileManagerPath}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ContextTriggerProps = Omit<
  ComponentProps<typeof ContextMenuTrigger>,
  "children" | "enabledOnMobile" | "highlightStyle"
>;

export function SidebarWorkspaceContextMenu({
  children,
  contextMenuOpen,
  onContextMenuOpenChange,
  workspace,
  leadingProjectName,
  hostBadgeLabel,
  serviceSummary,
  workspaceKey,
  onCopyPath,
  onCopyBranchName,
  onReferenceContent,
  referenceContentStatus,
  onRename,
  onMarkAsRead,
  onFork,
  forkPending,
  onArchive,
  onDelete,
  deleteStatus,
  deletePendingLabel,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  openInFileManagerPath,
  accessibilityLabel,
  highlightStyle,
  ...triggerProps
}: PropsWithChildren<
  SidebarWorkspaceMenuItemsProps &
    ContextTriggerProps & {
      contextMenuOpen: boolean;
      onContextMenuOpenChange: (open: boolean) => void;
      workspace: SidebarWorkspaceEntry;
      leadingProjectName?: string | null;
      hostBadgeLabel?: string | null;
      serviceSummary?: WorkspaceServiceSummary | null;
      highlightStyle: ComponentProps<typeof ContextMenuTrigger>["highlightStyle"];
    }
>) {
  const { t } = useTranslation();
  const pullRequestLabel = workspace.prHint
    ? t("workspace.git.pr.accessibility.pullRequest", {
        number: workspace.prHint.number,
        context: getForgePresentation(normalizeForge(workspace.prHint.forge)).changeRequestContext,
      })
    : null;
  const rowAccessibilityLabel = resolveSidebarWorkspaceAccessibilityLabel({
    workspace,
    leadingProjectName,
    hostBadgeLabel,
    pullRequestLabel,
    serviceLabel: serviceSummary
      ? t(workspaceServiceLabelKey(serviceSummary), { name: serviceSummary.name })
      : null,
  });
  const workspaceTarget = useMemo<WorkspaceLabelTarget>(
    () => ({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      labels: workspace.labels ?? [],
    }),
    [workspace],
  );
  const labelPages = useWorkspaceLabelMenuPages(workspaceTarget);
  const conversationPages = useWorkspaceConversationMenuPages({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
    rootAgents: workspace.rootAgents ?? EMPTY_ROOT_AGENTS,
  });
  const pages = useMemo(
    () => [...conversationPages, ...labelPages],
    [conversationPages, labelPages],
  );

  const renameTriggerRef = useRef<View | null>(null);
  useEffect(() => {
    const node = renameTriggerRef.current;
    if (!isWeb || !(node instanceof HTMLElement) || !onRename || triggerProps.disabled) return;
    const handleDoubleClick = (event: MouseEvent) => {
      if (contextMenuOpen || !(event.target instanceof Element)) return;
      if (
        event.target.closest(
          '[data-testid^="sidebar-workspace-quick-"],[data-testid^="sidebar-workspace-kebab-"],[data-testid^="sidebar-workspace-rename-"],a,input,[role="link"]',
        )
      )
        return;
      const control = event.target.closest('button,[role="button"]');
      if (control && control !== node) return;
      event.preventDefault();
      event.stopPropagation();
      onRename();
    };
    node.addEventListener("dblclick", handleDoubleClick);
    return () => node.removeEventListener("dblclick", handleDoubleClick);
  }, [contextMenuOpen, onRename, triggerProps.disabled]);
  const handleWebKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    triggerProps.onPress?.(
      event as unknown as Parameters<NonNullable<typeof triggerProps.onPress>>[0],
    );
  };
  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={onContextMenuOpenChange}>
      <ContextMenuTrigger
        {...triggerProps}
        accessibilityRole={isWeb ? "none" : triggerProps.accessibilityRole}
        {...(isWeb ? { role: "group", onKeyDown: handleWebKeyDown } : {})}
        triggerRef={renameTriggerRef}
        enabledOnMobile={false}
        accessibilityLabel={accessibilityLabel ?? rowAccessibilityLabel}
        highlightStyle={highlightStyle}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        align="start"
        width={260}
        testID={`sidebar-workspace-context-menu-${workspaceKey}`}
        pages={pages}
      >
        <SidebarWorkspaceMenuItems
          surface="context"
          workspaceKey={workspaceKey}
          serverId={workspaceTarget.serverId}
          workspaceId={workspaceTarget.workspaceId}
          workspaceLabels={workspaceTarget.labels}
          rootAgentCount={workspace.rootAgents?.length ?? 0}
          onCopyPath={onCopyPath}
          onReferenceContent={onReferenceContent}
          referenceContentStatus={referenceContentStatus}
          onCopyBranchName={onCopyBranchName}
          onRename={onRename}
          onMarkAsRead={onMarkAsRead}
          onFork={onFork}
          forkPending={forkPending}
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
          openInFileManagerPath={openInFileManagerPath}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function triggerStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.trigger, hovered && styles.triggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: 2,
    borderRadius: 4,
    marginLeft: 2,
    // MoreVertical paints only around the center of its SVG. Keep the padded hit box, but
    // pull the painted dots through that unused view-box space onto the trailing-content rail.
    marginRight: -7,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
