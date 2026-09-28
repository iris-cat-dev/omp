import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AgentStatusDot } from "@/components/agent-status-dot";
import {
  MenuHint,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import { useToast } from "@/contexts/toast-context";
import type { SidebarWorkspaceRootAgent } from "@/hooks/use-sidebar-workspaces-list";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export const WORKSPACE_CONVERSATIONS_PAGE_ID = "workspaceConversations";

const NO_PAGES: readonly MenuPageDefinition[] = [];

export function useWorkspaceConversationMenuPages(input: {
  serverId: string | undefined;
  workspaceId: string | undefined;
  rootAgents: readonly SidebarWorkspaceRootAgent[];
}): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  const { serverId, workspaceId, rootAgents } = input;

  return useMemo(() => {
    if (!serverId || !workspaceId || rootAgents.length < 2) return NO_PAGES;
    return [
      {
        id: WORKSPACE_CONVERSATIONS_PAGE_ID,
        title: t("sidebar.workspace.conversations.title"),
        content: (
          <WorkspaceConversationsPage
            serverId={serverId}
            workspaceId={workspaceId}
            rootAgents={rootAgents}
          />
        ),
      },
    ];
  }, [rootAgents, serverId, t, workspaceId]);
}

function OpenConversationMenuItem({
  agent,
  description,
  name,
  onOpen,
}: {
  agent: SidebarWorkspaceRootAgent;
  description: string;
  name: string;
  onOpen: (agentId: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onOpen(agent.id), [agent.id, onOpen]);
  const leading = useMemo(
    () => (
      <AgentStatusDot
        status={agent.status}
        pendingPermissionCount={agent.pendingPermissionCount}
        requiresAttention={agent.requiresAttention}
        attentionReason={agent.attentionReason}
        showInactive
      />
    ),
    [agent.attentionReason, agent.pendingPermissionCount, agent.requiresAttention, agent.status],
  );

  return (
    <MenuItem
      leading={leading}
      description={description}
      onSelect={handleSelect}
      testID={`sidebar-workspace-conversation-open-${agent.id}`}
    >
      {name}
    </MenuItem>
  );
}

function ArchiveConversationMenuItem({
  agent,
  archiveLabel,
  pendingLabel,
  pending,
  onArchive,
}: {
  agent: SidebarWorkspaceRootAgent;
  archiveLabel: string;
  pendingLabel: string;
  pending: boolean;
  onArchive: (agent: SidebarWorkspaceRootAgent) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onArchive(agent), [agent, onArchive]);
  return (
    <MenuItem
      destructive
      status={pending ? "pending" : "idle"}
      pendingLabel={pendingLabel}
      onSelect={handleSelect}
      testID={`sidebar-workspace-conversation-archive-${agent.id}`}
    >
      {archiveLabel}
    </MenuItem>
  );
}

function WorkspaceConversationsPage({
  serverId,
  workspaceId,
  rootAgents,
}: {
  serverId: string;
  workspaceId: string;
  rootAgents: readonly SidebarWorkspaceRootAgent[];
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const { archiveAgent, isArchivingAgent } = useArchiveAgent();

  const openConversation = useCallback(
    (agentId: string) => {
      navigateToAgent({ serverId, workspaceId, agentId, pin: true });
    },
    [serverId, workspaceId],
  );
  const archiveConversation = useCallback(
    (agent: SidebarWorkspaceRootAgent) => {
      void (async () => {
        const name = agent.title ?? t("sidebar.workspace.conversations.untitled");
        const confirmed = await confirmDialog({
          title: t("sidebar.workspace.conversations.archiveTitle", { name }),
          message: t("sidebar.workspace.conversations.archiveMessage"),
          confirmLabel: t("sidebar.workspace.conversations.archiveConfirm"),
          destructive: true,
        });
        if (!confirmed) return;
        try {
          await archiveAgent({ serverId, agentId: agent.id });
        } catch (error) {
          toast.error(toErrorMessage(error));
        }
      })();
    },
    [archiveAgent, serverId, t, toast],
  );

  return (
    <>
      <MenuLabel>{t("sidebar.workspace.conversations.open")}</MenuLabel>
      {rootAgents.map((agent, index) => {
        const name = agent.title ?? t("sidebar.workspace.conversations.untitled");
        return (
          <OpenConversationMenuItem
            key={agent.id}
            agent={agent}
            name={name}
            description={t(
              index === 0
                ? "sidebar.workspace.conversations.primary"
                : "sidebar.workspace.conversations.additional",
            )}
            onOpen={openConversation}
          />
        );
      })}
      <MenuSeparator />
      <MenuLabel>{t("sidebar.workspace.conversations.resolve")}</MenuLabel>
      {rootAgents.map((agent) => {
        const name = agent.title ?? t("sidebar.workspace.conversations.untitled");
        return (
          <ArchiveConversationMenuItem
            key={agent.id}
            agent={agent}
            archiveLabel={t("sidebar.workspace.conversations.archive", { name })}
            pendingLabel={t("sidebar.workspace.conversations.archiving", { name })}
            pending={isArchivingAgent({ serverId, agentId: agent.id })}
            onArchive={archiveConversation}
          />
        );
      })}
      <MenuHint>{t("sidebar.workspace.conversations.hint")}</MenuHint>
    </>
  );
}
