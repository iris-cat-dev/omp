import { isDelegatedAgent } from "@omp-desktop/protocol/agent-labels";
import type { PetActivityAgent } from "./client-host.js";
import type { DesktopPetTask, PetTaskStatus } from "./types.js";
const PRIORITY: Record<PetTaskStatus, number> = { needs_input: 0, blocked: 1, ready: 2, running: 3 };
function taskStatus(agent: PetActivityAgent): PetTaskStatus | null {
  if ((agent.pendingPermissionCount ?? agent.pendingPermissions?.length ?? 0) > 0 || (agent.requiresAttention && agent.attentionReason === "permission")) return "needs_input";
  if (agent.requiresAttention && agent.attentionReason === "error") return "blocked";
  if (agent.requiresAttention && agent.attentionReason === "finished") return "ready";
  return agent.status === "running" ? "running" : null;
}
export function deriveDesktopPetTasks(agents: Iterable<PetActivityAgent>, connectedServerIds: ReadonlySet<string>, untitledLabel: string, hostServerId?: string, resolveLabel?: (agent: PetActivityAgent, untitled: string) => string): DesktopPetTask[] {
  const tasks: DesktopPetTask[] = [];
  for (const agent of agents) {
    const serverId = hostServerId ?? agent.serverId;
    if (!serverId || agent.archivedAt || isDelegatedAgent(agent) || !connectedServerIds.has(serverId)) continue;
    const status = taskStatus(agent);
    if (!status) continue;
    tasks.push({ serverId, agentId: agent.id, title: resolveLabel?.(agent, untitledLabel).trim() || agent.title?.trim() || untitledLabel, status, updatedAt: Math.max(agent.lastActivityAt.getTime(), agent.attentionTimestamp?.getTime() ?? 0) });
  }
  return tasks.sort((left, right) => PRIORITY[left.status] - PRIORITY[right.status] || right.updatedAt - left.updatedAt || left.serverId.localeCompare(right.serverId) || left.agentId.localeCompare(right.agentId));
}
