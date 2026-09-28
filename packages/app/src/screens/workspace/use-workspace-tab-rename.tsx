import { useCallback, useState } from "react";
import { type QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type { ListTerminalsResponse } from "@omp-desktop/protocol/messages";
import { useTranslation } from "react-i18next";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import { pickWorkspacePrimaryAgentId } from "@/subagents/policies";

interface RenamingTabState {
  kind: "terminal" | "agent" | "workspace";
  id: string;
  currentTitle: string;
}

interface UseWorkspaceTabRenameInput {
  client: DaemonClient | null;
  normalizedServerId: string;
  workspaceId: string;
  queryClient: QueryClient;
  terminalsData: ListTerminalsResponse["payload"] | undefined;
  terminalsQueryKey: readonly unknown[];
}

interface UseWorkspaceTabRenameResult {
  renamingTab: RenamingTabState | null;
  handleRenameTab: (tab: WorkspaceTabDescriptor) => void;
  handleRenameModalSubmit: (nextTitle: string) => Promise<void>;
  handleRenameModalClose: () => void;
}

export function useWorkspaceTabRename(
  input: UseWorkspaceTabRenameInput,
): UseWorkspaceTabRenameResult {
  const { client, normalizedServerId, workspaceId, queryClient, terminalsData, terminalsQueryKey } =
    input;
  const { t } = useTranslation();
  const [renamingTab, setRenamingTab] = useState<RenamingTabState | null>(null);

  const handleRenameTab = useCallback(
    (tab: WorkspaceTabDescriptor) => {
      if (tab.target.kind === "terminal") {
        const { terminalId } = tab.target;
        const terminal = terminalsData?.terminals.find((entry) => entry.id === terminalId) ?? null;
        const currentTitle = terminal?.title ?? terminal?.name ?? "";
        setRenamingTab({ kind: "terminal", id: terminalId, currentTitle });
        return;
      }
      if (tab.target.kind === "agent") {
        const { agentId } = tab.target;
        const session = useSessionStore.getState().sessions[normalizedServerId];
        const agent = session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId) ?? null;
        const workspaceKey = resolveWorkspaceMapKeyByIdentity({
          workspaces: session?.workspaces,
          workspaceId,
        });
        const workspace = workspaceKey ? session?.workspaces.get(workspaceKey) : null;
        if (
          agent &&
          normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId &&
          pickWorkspacePrimaryAgentId(
            [...(session?.agentDetails.values() ?? []), ...(session?.agents.values() ?? [])],
            workspaceId,
          ) === agentId &&
          workspace
        ) {
          setRenamingTab({
            kind: "workspace",
            id: workspaceId,
            currentTitle: workspace.title ?? workspace.name,
          });
          return;
        }
        setRenamingTab({ kind: "agent", id: agentId, currentTitle: agent?.title ?? "" });
      }
    },
    [normalizedServerId, workspaceId, terminalsData],
  );

  const handleRenameModalSubmit = useCallback(
    async (nextTitle: string) => {
      if (!renamingTab) return;
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const trimmed = nextTitle.trim();
      if (renamingTab.kind === "terminal") {
        const result = await client.renameTerminal({
          terminalId: renamingTab.id,
          title: trimmed,
        });
        if (!result.success) {
          throw new Error(result.error ?? "Failed to rename terminal");
        }
        void queryClient.invalidateQueries({ queryKey: terminalsQueryKey });
        return;
      }
      if (renamingTab.kind === "workspace") {
        const { title } = await client.setWorkspaceTitle(renamingTab.id, trimmed || null);
        if (title) {
          useSessionStore.getState().setWorkspaces(normalizedServerId, (workspaces) => {
            const workspaceKey = resolveWorkspaceMapKeyByIdentity({
              workspaces,
              workspaceId: renamingTab.id,
            });
            const workspace = workspaceKey ? workspaces.get(workspaceKey) : null;
            if (
              !workspaceKey ||
              !workspace ||
              (workspace.title ?? workspace.name) !== renamingTab.currentTitle ||
              (workspace.name === title && workspace.title === title)
            ) {
              return workspaces;
            }
            const next = new Map(workspaces);
            next.set(workspaceKey, { ...workspace, name: title, title });
            return next;
          });
        }
        return;
      }
      await client.updateAgent(renamingTab.id, { name: trimmed });
      const renameInMap = (agents: Map<string, Agent>) => {
        const agent = agents.get(renamingTab.id);
        if (!agent || (agent.title ?? "") !== renamingTab.currentTitle || agent.title === trimmed) {
          return agents;
        }
        const next = new Map(agents);
        next.set(renamingTab.id, { ...agent, title: trimmed });
        return next;
      };
      const store = useSessionStore.getState();
      store.setAgents(normalizedServerId, renameInMap);
      store.setAgentDetails(normalizedServerId, renameInMap);
    },
    [client, normalizedServerId, queryClient, renamingTab, terminalsQueryKey, t],
  );

  const handleRenameModalClose = useCallback(() => {
    setRenamingTab(null);
  }, []);

  return {
    renamingTab,
    handleRenameTab,
    handleRenameModalSubmit,
    handleRenameModalClose,
  };
}

export interface WorkspaceTabRenameModalProps {
  renamingTab: RenamingTabState | null;
  onClose: () => void;
  onSubmit: (nextTitle: string) => Promise<void>;
}

export function WorkspaceTabRenameModal({
  renamingTab,
  onClose,
  onSubmit,
}: WorkspaceTabRenameModalProps) {
  const { t } = useTranslation();
  const title =
    renamingTab?.kind === "terminal"
      ? t("workspace.tabs.menu.renameTerminal")
      : renamingTab?.kind === "workspace"
        ? t("sidebar.workspace.rename.title")
        : t("workspace.tabs.menu.renameAgent");
  const initialValue = renamingTab?.currentTitle ?? "";
  const testID = renamingTab
    ? `workspace-tab-rename-modal-${renamingTab.kind}-${renamingTab.id}`
    : undefined;
  return (
    <AdaptiveRenameModal
      visible={renamingTab !== null}
      title={title}
      initialValue={initialValue}
      submitLabel={t("workspace.tabs.menu.rename")}
      maxLength={200}
      onClose={onClose}
      onSubmit={onSubmit}
      testID={testID}
    />
  );
}
