import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

interface WorkspaceAgent {
  parentAgentId: string | null;
  workspaceId?: string | null;
}

export function isWorkspaceRootAgent(
  agent: WorkspaceAgent,
  parentAgent: { workspaceId?: string | null } | undefined,
): boolean {
  if (!agent.parentAgentId) {
    return true;
  }

  const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
  if (!workspaceId || !parentAgent) {
    return false;
  }
  return normalizeWorkspaceOpaqueId(parentAgent.workspaceId) !== workspaceId;
}

type PrimaryWorkspaceAgent = WorkspaceAgent & {
  id: string;
  createdAt?: Date | string | null;
  archivedAt?: Date | string | null;
};

function createdAtTimestamp(agent: PrimaryWorkspaceAgent): number {
  let createdAt = Number.POSITIVE_INFINITY;
  if (agent.createdAt instanceof Date) {
    createdAt = agent.createdAt.getTime();
  } else if (agent.createdAt) {
    createdAt = Date.parse(agent.createdAt);
  }
  return Number.isFinite(createdAt) ? createdAt : Number.POSITIVE_INFINITY;
}

export function listActiveWorkspaceRootAgentIds(
  agents: readonly PrimaryWorkspaceAgent[],
  workspaceId: string,
): string[] {
  const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(workspaceId);
  if (!normalizedWorkspaceId) return [];

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return agents
    .filter(
      (agent) =>
        !agent.archivedAt &&
        normalizeWorkspaceOpaqueId(agent.workspaceId) === normalizedWorkspaceId &&
        isWorkspaceRootAgent(
          agent,
          agent.parentAgentId ? byId.get(agent.parentAgentId) : undefined,
        ),
    )
    .sort((left, right) => {
      const createdAtDifference = createdAtTimestamp(left) - createdAtTimestamp(right);
      return createdAtDifference || left.id.localeCompare(right.id);
    })
    .map((agent) => agent.id);
}

/** A workspace owns one primary tab; additional independent roots remain separate conversations. */
export function pickWorkspacePrimaryAgentId(
  agents: readonly PrimaryWorkspaceAgent[],
  workspaceId: string,
): string | null {
  const normalizedWorkspaceId = normalizeWorkspaceOpaqueId(workspaceId);
  if (!normalizedWorkspaceId) return null;

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  let primary: PrimaryWorkspaceAgent | null = null;
  let primaryIsActive = false;
  let primaryIsRoot = false;
  let primaryCreatedAt = Infinity;
  for (const agent of agents) {
    if (normalizeWorkspaceOpaqueId(agent.workspaceId) !== normalizedWorkspaceId) continue;
    const active = !agent.archivedAt;
    const root = isWorkspaceRootAgent(
      agent,
      agent.parentAgentId ? byId.get(agent.parentAgentId) : undefined,
    );
    const timestamp = createdAtTimestamp(agent);
    if (
      !primary ||
      (active && !primaryIsActive) ||
      (active === primaryIsActive &&
        ((root && !primaryIsRoot) ||
          (root === primaryIsRoot &&
            (timestamp < primaryCreatedAt ||
              (timestamp === primaryCreatedAt && agent.id < primary.id)))))
    ) {
      primary = agent;
      primaryIsActive = active;
      primaryIsRoot = root;
      primaryCreatedAt = timestamp;
    }
  }
  return primary?.id ?? null;
}
