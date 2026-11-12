import type { PluginClientStateSource } from "@omp-desktop/plugin/host";
import type { PluginAgentSnapshot, PluginWorkspaceSnapshot } from "@omp-desktop/plugin";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";

const agents = new WeakMap<Agent, PluginAgentSnapshot>();
const workspaces = new WeakMap<WorkspaceDescriptor, PluginWorkspaceSnapshot>();

export function createPluginClientStateSource(hostId: string | null): PluginClientStateSource {
  return {
    subscribe: (listener) => useSessionStore.subscribe(listener),
    getWorkspace(id) {
      if (hostId === null) return null;
      const session = useSessionStore.getState().sessions[hostId];
      if (!session) return null;
      let source = session.workspaces.get(id);
      if (!source) for (const candidate of session.workspaces.values()) if (candidate.id === id) { source = candidate; break; }
      if (!source) return null;
      const cached = workspaces.get(source);
      if (cached) return cached;
      const snapshot: PluginWorkspaceSnapshot = Object.freeze({
        id: source.id, projectId: source.projectId, projectDisplayName: source.projectDisplayName,
        projectRootPath: source.projectRootPath, directory: source.workspaceDirectory,
        projectKind: source.projectKind, kind: source.workspaceKind, name: source.name,
        title: source.title ?? null, status: source.status,
        statusEnteredAt: source.statusEnteredAt?.toISOString() ?? null, archivingAt: source.archivingAt,
        diffStat: source.diffStat ? Object.freeze({ ...source.diffStat }) : null,
      });
      workspaces.set(source, snapshot);
      return snapshot;
    },
    getAgent(id) {
      if (hostId === null) return null;
      const session = useSessionStore.getState().sessions[hostId];
      const source = session?.agents.get(id) ?? session?.agentDetails.get(id);
      if (!source?.workspaceId) return null;
      const cached = agents.get(source);
      if (cached) return cached;
      const snapshot: PluginAgentSnapshot = Object.freeze({
        id: source.id, workspaceId: source.workspaceId, provider: source.provider, status: source.status,
        createdAt: source.createdAt.toISOString(), updatedAt: source.updatedAt.toISOString(), lastActivityAt: source.lastActivityAt.toISOString(),
        title: source.title, cwd: source.cwd, model: source.model, currentModeId: source.currentModeId,
        thinkingOptionId: source.thinkingOptionId ?? null, requiresAttention: source.requiresAttention ?? false,
        attentionReason: source.attentionReason ?? null, parentAgentId: source.parentAgentId,
        labels: Object.freeze({ ...source.labels }),
      });
      agents.set(source, snapshot);
      return snapshot;
    },
  };
}
