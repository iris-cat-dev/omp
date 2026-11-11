import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { resolveAgentTabPrimaryLabel } from "@/components/sidebar/sidebar-workspace-title";
import { pickWorkspacePrimaryAgentId } from "@/subagents/policies";
import { normalizeWorkspaceOpaqueId, resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
type ActivityTitleAgent = Pick<Agent, "id" | "title" | "workspaceId" | "createdAt" | "archivedAt" | "parentAgentId">;
export interface ActivityLabelContext { agents: ReadonlyMap<string, ActivityTitleAgent>; agentDetails: ReadonlyMap<string, ActivityTitleAgent>; workspaces: Map<string, WorkspaceDescriptor> }
export function createActivityAgentLabelResolver(presentation: ActivityLabelContext | undefined) {
  let primaryAgents: ActivityTitleAgent[] | undefined;
  const primaryByWorkspace = new Map<string, string | null>();
  return (agent: { id: string; title?: string | null; workspaceId?: string | null }, untitled: string): string => {
    if (!presentation) return agent.title?.trim() || untitled;
    const current = presentation.agents.get(agent.id) ?? presentation.agentDetails.get(agent.id);
    const workspaceId = normalizeWorkspaceOpaqueId(current ? current.workspaceId : agent.workspaceId);
    const workspaceKey = resolveWorkspaceMapKeyByIdentity({ workspaces: presentation.workspaces, workspaceId });
    const workspace = workspaceKey ? presentation.workspaces.get(workspaceKey) : undefined;
    let isPrimaryAgent = false;
    if (workspaceId && workspace) {
      let primaryId = primaryByWorkspace.get(workspaceId);
      if (primaryId === undefined) { primaryAgents ??= [...presentation.agentDetails.values(), ...presentation.agents.values()]; primaryId = pickWorkspacePrimaryAgentId(primaryAgents, workspaceId); primaryByWorkspace.set(workspaceId, primaryId); }
      isPrimaryAgent = primaryId === agent.id;
    }
    return resolveAgentTabPrimaryLabel({ agentTitle: current ? current.title : agent.title, isPrimaryAgent, workspaceLabel: workspace?.title ?? workspace?.name, newConversationLabel: untitled })?.trim() || untitled;
  };
}
