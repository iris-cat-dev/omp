import { isDelegatedAgent } from "@omp-desktop/protocol/agent-labels";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { resolveAgentTabPrimaryLabel } from "@/components/sidebar/sidebar-workspace-title";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { pickWorkspacePrimaryAgentId } from "@/subagents/policies";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import type { DesktopPetTask, PetTaskStatus } from "./types";

const PRIORITY: Record<PetTaskStatus, number> = {
  needs_input: 0,
  blocked: 1,
  ready: 2,
  running: 3,
};

type PetActivityAgent = Pick<
  AggregatedAgent,
  | "id"
  | "archivedAt"
  | "labels"
  | "pendingPermissionCount"
  | "requiresAttention"
  | "attentionReason"
  | "status"
  | "title"
  | "workspaceId"
  | "lastActivityAt"
  | "attentionTimestamp"
> & { serverId?: string; pendingPermissions?: readonly unknown[] };

type PetTitleAgent = Pick<
  Agent,
  "id" | "title" | "workspaceId" | "createdAt" | "archivedAt" | "parentAgentId"
>;

interface PetTaskTitleContext {
  agents: ReadonlyMap<string, PetTitleAgent>;
  agentDetails: ReadonlyMap<string, PetTitleAgent>;
  workspaces: Map<string, WorkspaceDescriptor>;
}

class PetTaskTitleResolver {
  private primaryAgents: PetTitleAgent[] | undefined;
  private primaryByWorkspace: Map<string, string | null> | undefined;

  constructor(
    private readonly presentation: PetTaskTitleContext,
    private readonly untitledLabel: string,
  ) {}

  resolve(agent: PetActivityAgent): string {
    const { presentation, untitledLabel } = this;
    const current = presentation.agents.get(agent.id) ?? presentation.agentDetails.get(agent.id);
    const workspaceId = normalizeWorkspaceOpaqueId(
      current ? current.workspaceId : agent.workspaceId,
    );
    const workspaceKey = resolveWorkspaceMapKeyByIdentity({
      workspaces: presentation.workspaces,
      workspaceId,
    });
    const workspace = workspaceKey ? presentation.workspaces.get(workspaceKey) : undefined;
    let isPrimaryAgent = false;
    let workspaceLabel: string | undefined;
    if (workspaceId && workspace) {
      this.primaryByWorkspace ??= new Map();
      let primaryId = this.primaryByWorkspace.get(workspaceId);
      if (primaryId === undefined) {
        this.primaryAgents ??= [
          ...presentation.agentDetails.values(),
          ...presentation.agents.values(),
        ];
        primaryId = pickWorkspacePrimaryAgentId(this.primaryAgents, workspaceId);
        this.primaryByWorkspace.set(workspaceId, primaryId);
      }
      isPrimaryAgent = primaryId === agent.id;
      workspaceLabel = workspace.title ?? workspace.name;
    }
    return (
      resolveAgentTabPrimaryLabel({
        agentTitle: current ? current.title : agent.title,
        isPrimaryAgent,
        workspaceLabel,
        newConversationLabel: untitledLabel,
      })?.trim() || untitledLabel
    );
  }
}

function taskStatus(agent: PetActivityAgent): PetTaskStatus | null {
  if (
    (agent.pendingPermissionCount ?? agent.pendingPermissions?.length ?? 0) > 0 ||
    (agent.requiresAttention && agent.attentionReason === "permission")
  )
    return "needs_input";
  if (agent.requiresAttention && agent.attentionReason === "error") return "blocked";
  if (agent.requiresAttention && agent.attentionReason === "finished") return "ready";
  return agent.status === "running" ? "running" : null;
}

export function deriveDesktopPetTasks(
  agents: Iterable<PetActivityAgent>,
  connectedServerIds: ReadonlySet<string>,
  untitledLabel: string,
  hostServerId?: string,
  presentation?: PetTaskTitleContext,
): DesktopPetTask[] {
  const tasks: DesktopPetTask[] = [];
  let titles: PetTaskTitleResolver | undefined;
  for (const agent of agents) {
    const serverId = hostServerId ?? agent.serverId;
    if (
      !serverId ||
      agent.archivedAt ||
      isDelegatedAgent(agent) ||
      !connectedServerIds.has(serverId)
    )
      continue;
    const status = taskStatus(agent);
    if (!status) continue;
    tasks.push({
      serverId,
      agentId: agent.id,
      title: presentation
        ? (titles ??= new PetTaskTitleResolver(presentation, untitledLabel)).resolve(agent)
        : agent.title?.trim() || untitledLabel,
      status,
      updatedAt: Math.max(agent.lastActivityAt.getTime(), agent.attentionTimestamp?.getTime() ?? 0),
    });
  }
  return tasks.sort(
    (left, right) =>
      PRIORITY[left.status] - PRIORITY[right.status] ||
      right.updatedAt - left.updatedAt ||
      left.serverId.localeCompare(right.serverId) ||
      left.agentId.localeCompare(right.agentId),
  );
}
