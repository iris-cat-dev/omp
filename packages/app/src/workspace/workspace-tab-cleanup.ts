import { useSessionStore } from "@/stores/session-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { ensureProjectLayoutsMigrated } from "@/workspace-tabs/project-scope";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface WorkspaceTabCleanupSnapshot {
  serverId: string;
  workspaceId: string;
  agentIds: ReadonlySet<string>;
}

export function captureWorkspaceTabCleanup(input: {
  serverId: string;
  workspaceId: string;
}): WorkspaceTabCleanupSnapshot {
  const serverId = input.serverId.trim();
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  const agentIds = new Set<string>();

  if (serverId && workspaceId) {
    const session = useSessionStore.getState().sessions[serverId];
    for (const agents of [session?.agentDetails.values(), session?.agents.values()]) {
      if (!agents) {
        continue;
      }
      for (const agent of agents) {
        if (normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId) {
          agentIds.add(agent.id);
        }
      }
    }
  }

  return { serverId, workspaceId: workspaceId ?? "", agentIds };
}

export function closeWorkspaceAgentTabs(snapshot: WorkspaceTabCleanupSnapshot): void {
  if (!snapshot.serverId || !snapshot.workspaceId) {
    return;
  }
  ensureProjectLayoutsMigrated(snapshot.serverId);

  const layoutStore = useWorkspaceLayoutStore.getState();
  const workspaceKeyPrefix = `${snapshot.serverId}:`;
  for (const [workspaceKey, layout] of Object.entries(layoutStore.layoutByWorkspace)) {
    if (!workspaceKey.startsWith(workspaceKeyPrefix)) {
      continue;
    }

    for (const tab of collectAllTabs(layout.root)) {
      const target = tab.target;
      const ownerAgentId =
        target.kind === "agent" ||
        target.kind === "background_process" ||
        target.kind === "prompt_analysis"
          ? target.agentId
          : target.kind === "provider_subagent"
            ? target.parentAgentId
            : target.kind === "plugin" && target.context === "agent"
              ? target.agentId
              : null;
      if (
        target.workspaceId === snapshot.workspaceId ||
        (!target.workspaceId && ownerAgentId && snapshot.agentIds.has(ownerAgentId))
      ) {
        layoutStore.closeTab(workspaceKey, tab.tabId);
      }
    }

    for (const agentId of snapshot.agentIds) {
      layoutStore.unpinAgent(workspaceKey, agentId);
    }
  }
}
