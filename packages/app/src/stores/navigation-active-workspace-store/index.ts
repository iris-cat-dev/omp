import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLocalSearchParams, usePathname } from "expo-router";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  createLastWorkspaceSelectionStore,
  LAST_WORKSPACE_SELECTION_STORAGE_KEY,
  type ActiveWorkspaceSelection,
  type LastWorkspaceSelectionStorage,
} from "@/stores/last-workspace-selection";
import {
  navigateToLastWorkspace as navigateToLastWorkspacePure,
  navigateToProject as navigateToProjectPure,
  navigateToSidebarWorkspace as navigateToSidebarWorkspacePure,
  navigateToWorkspace as navigateToWorkspacePure,
  parseActiveWorkspaceSelection,
  type NavigateToSidebarWorkspaceDeps,
  type NavigateToSidebarWorkspaceInput,
  type NavigateToWorkspaceDeps,
  type NavigateToWorkspaceInput,
} from "./navigation";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { stripHostWorkspaceRouteEchoSearchFromBrowserUrlAfterCommit } from "@/utils/host-route-browser";
import { navigateToHostWorkspaceRoute } from "@/navigation/workspace-route-navigation";
import { getParentAgentIdFromLabels } from "@omp-desktop/protocol/agent-labels";
import {
  resolveProjectLayoutKey,
  ensureProjectLayoutsMigrated,
} from "@/workspace-tabs/project-scope";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { parseHostProjectRouteFromPathname } from "@/utils/host-routes";
import {
  createProjectSelectionStore,
  PROJECT_SELECTION_STORAGE_KEY,
  type ActiveProjectSelection,
} from "./project-selection";
import {
  resolveWorkspaceToolSelection,
  type WorkspaceToolSelection,
} from "@/workspace-tabs/tool-workspace-selection";
import { isDraftTabInUse } from "@/workspace/draft-tab-usage";
import { requestAgentAttentionRead } from "@/stores/agent-attention-read-store";

export type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
export type { NavigateToWorkspaceInput } from "./navigation";
export type { ActiveProjectSelection } from "./project-selection";

const lastWorkspaceSelectionStorage: LastWorkspaceSelectionStorage = {
  read: () => AsyncStorage.getItem(LAST_WORKSPACE_SELECTION_STORAGE_KEY),
  write: (value) => AsyncStorage.setItem(LAST_WORKSPACE_SELECTION_STORAGE_KEY, value),
  clear: () => AsyncStorage.removeItem(LAST_WORKSPACE_SELECTION_STORAGE_KEY),
};

const lastWorkspaceSelectionStore = createLastWorkspaceSelectionStore(
  lastWorkspaceSelectionStorage,
);
const projectSelectionStore = createProjectSelectionStore({
  read: () => AsyncStorage.getItem(PROJECT_SELECTION_STORAGE_KEY),
  write: (value) => AsyncStorage.setItem(PROJECT_SELECTION_STORAGE_KEY, value),
});
void projectSelectionStore.hydrate();

function projectIdForWorkspace(
  workspaces: Map<string, WorkspaceDescriptor> | null | undefined,
  workspaceId: string,
): string | null {
  const key = resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId });
  return key ? (workspaces?.get(key)?.projectId ?? null) : null;
}

function rememberProjectWorkspace(selection: ActiveWorkspaceSelection) {
  const workspaces = useSessionStore.getState().sessions[selection.serverId]?.workspaces;
  const projectId = projectIdForWorkspace(workspaces, selection.workspaceId);
  if (projectId) {
    projectSelectionStore.remember({ serverId: selection.serverId, projectId }, selection);
  }
}

function navigateDeps(): NavigateToWorkspaceDeps {
  return {
    getSessionWorkspaces: (serverId) => useSessionStore.getState().sessions[serverId]?.workspaces,
    getSessionAgents: (serverId) =>
      useSessionStore.getState().sessions[serverId]?.agents.values() ?? [],
    getFocusedAgentId: (serverId, workspaceId) => {
      const workspaceKey = resolveProjectLayoutKey({ serverId, workspaceId });
      const layout = workspaceKey
        ? useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]
        : null;
      if (!layout) return null;
      const pane = findPaneById(layout.root, layout.focusedPaneId);
      if (!pane || pane.hidden === true) return null;
      const target = collectAllTabs(layout.root).find(
        (tab) => tab.tabId === pane.focusedTabId,
      )?.target;
      return target?.kind === "agent" ? target.agentId : null;
    },
    requestAgentAttentionRead,
    openTab: (input) => useWorkspaceLayoutStore.getState().openTab(input),
    pinAgent: (workspaceKey, agentId) =>
      useWorkspaceLayoutStore.getState().pinAgent(workspaceKey, agentId),
    rememberLastWorkspace: (selection) => {
      lastWorkspaceSelectionStore.remember(selection);
      rememberProjectWorkspace(selection);
    },
    navigateToRoute: (route) => {
      navigateToHostWorkspaceRoute(route);
      stripHostWorkspaceRouteEchoSearchFromBrowserUrlAfterCommit();
    },
  };
}

export function hydrateLastWorkspaceSelection(): Promise<void> {
  return lastWorkspaceSelectionStore.hydrate();
}

export function getLastWorkspaceSelection(): ActiveWorkspaceSelection | null {
  return lastWorkspaceSelectionStore.getSelection();
}

export function getIsLastWorkspaceSelectionHydrated(): boolean {
  return lastWorkspaceSelectionStore.isHydrated();
}

export function navigateToWorkspace(input: NavigateToWorkspaceInput): string {
  ensureProjectLayoutsMigrated(input.serverId);
  return navigateToWorkspacePure(input, navigateDeps());
}

/** Project switches retain the project's focused pane and never open an attention tab. */
export function navigateToProject(project: ActiveProjectSelection): string {
  ensureProjectLayoutsMigrated(project.serverId);
  return navigateToProjectPure(project, {
    ...navigateDeps(),
    getProjectLastWorkspace: (target) =>
      projectSelectionStore.get(target) ??
      (lastWorkspaceSelectionStore.getSelection()?.serverId === target.serverId
        ? lastWorkspaceSelectionStore.getSelection()
        : null),
  });
}

export async function navigateToSidebarWorkspace(
  input: NavigateToSidebarWorkspaceInput,
): Promise<string> {
  ensureProjectLayoutsMigrated(input.serverId);
  const deps: NavigateToSidebarWorkspaceDeps = {
    ...navigateDeps(),
    getSessionAgentsHydrated: (serverId) =>
      useSessionStore.getState().sessions[serverId]?.hasHydratedAgents ?? false,
    fetchWorkspaceAgentHistory: async (serverId, workspaceId) => {
      const client = useSessionStore.getState().sessions[serverId]?.client;
      if (!client) {
        return [];
      }
      const payload = await client.fetchAgentHistory({
        filter: {
          includeArchived: true,
          workspaceIds: [workspaceId],
        },
        sort: [{ key: "created_at", direction: "asc" }],
        page: { limit: 200 },
      });
      return payload.entries.map(({ agent }) => ({
        id: agent.id,
        workspaceId: agent.workspaceId,
        parentAgentId: getParentAgentIdFromLabels(agent.labels),
        createdAt: agent.createdAt,
        archivedAt: agent.archivedAt,
      }));
    },
    projectTabs: {
      list: ({ serverId, workspaceId }) => {
        const projectKey = resolveProjectLayoutKey({ serverId, workspaceId });
        if (!projectKey) return null;
        const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[projectKey];
        return layout ? collectAllTabs(layout.root) : null;
      },
      isDraftInUse: isDraftTabInUse,
      replace: ({ workspaceKey, tabId, target }) => {
        useWorkspaceLayoutStore.getState().replaceTab(workspaceKey, tabId, target);
      },
    },
  };
  return navigateToSidebarWorkspacePure(input, deps);
}

export function useActiveProjectSelection(): ActiveProjectSelection | null {
  const pathname = usePathname();
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    projectId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const workspaceSelection = parseActiveWorkspaceSelection({ pathname, params });
  const workspaceProjectId = useSessionStore((state) => {
    if (!workspaceSelection) return null;
    return projectIdForWorkspace(
      state.sessions[workspaceSelection.serverId]?.workspaces,
      workspaceSelection.workspaceId,
    );
  });
  const projectRoute = parseHostProjectRouteFromPathname(pathname);
  if (projectRoute) return projectRoute;
  if (
    /^\/h\/[^/]+\/project\//.test(pathname) &&
    typeof params.serverId === "string" &&
    typeof params.projectId === "string"
  ) {
    return { serverId: params.serverId, projectId: params.projectId };
  }
  return workspaceSelection && workspaceProjectId
    ? { serverId: workspaceSelection.serverId, projectId: workspaceProjectId }
    : null;
}

export function navigateToLastWorkspace(): boolean {
  return navigateToLastWorkspacePure({
    ...navigateDeps(),
    getLastWorkspaceSelection: () => lastWorkspaceSelectionStore.getSelection(),
  });
}

export function useActiveWorkspaceSelection(): ActiveWorkspaceSelection | null {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const selection = parseActiveWorkspaceSelection({ pathname: usePathname(), params });
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const projectId = useSessionStore((state) =>
    serverId && workspaceId
      ? projectIdForWorkspace(state.sessions[serverId]?.workspaces, workspaceId)
      : null,
  );
  useEffect(() => {
    if (!serverId || !workspaceId) return;
    const current = { serverId, workspaceId };
    lastWorkspaceSelectionStore.remember(current);
    if (projectId) {
      projectSelectionStore.remember({ serverId, projectId }, current);
    }
  }, [serverId, workspaceId, projectId]);
  return selection;
}
export function useSidebarActiveWorkspaceSelection(): ActiveWorkspaceSelection | null {
  const routeSelection = useActiveWorkspaceSelection();
  const workspaceKey = routeSelection ? resolveProjectLayoutKey(routeSelection) : null;
  const focusedTarget = useWorkspaceLayoutStore((state) => {
    const layout = workspaceKey ? state.layoutByWorkspace[workspaceKey] : null;
    if (!layout) {
      return null;
    }
    const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
    if (!focusedPane?.focusedTabId || focusedPane.hidden === true) {
      return null;
    }
    return (
      collectAllTabs(layout.root).find((tab) => tab.tabId === focusedPane.focusedTabId)?.target ??
      null
    );
  });
  const focusedAgentWorkspaceId = useSessionStore((state) => {
    if (!routeSelection || focusedTarget?.kind !== "agent") {
      return null;
    }
    const session = state.sessions[routeSelection.serverId];
    const focusedAgent =
      session?.agents.get(focusedTarget.agentId) ??
      session?.agentDetails.get(focusedTarget.agentId) ??
      null;
    return focusedAgent?.workspaceId?.trim() || null;
  });
  const [lastToolSelection, setLastToolSelection] = useState<WorkspaceToolSelection | null>(null);
  const toolSelection = useMemo(
    () =>
      resolveWorkspaceToolSelection({
        current: lastToolSelection,
        routeSelection,
        focusedTarget,
        focusedAgentWorkspaceId,
      }),
    [focusedAgentWorkspaceId, focusedTarget, lastToolSelection, routeSelection],
  );

  useEffect(() => {
    setLastToolSelection((current) => (current === toolSelection ? current : toolSelection));
  }, [toolSelection]);

  return toolSelection?.activeSelection ?? null;
}

export function useLastWorkspaceSelection(): ActiveWorkspaceSelection | null {
  return useSyncExternalStore(
    lastWorkspaceSelectionStore.subscribe,
    getLastWorkspaceSelection,
    getLastWorkspaceSelection,
  );
}

export function useIsLastWorkspaceSelectionHydrated(): boolean {
  return useSyncExternalStore(
    lastWorkspaceSelectionStore.subscribe,
    getIsLastWorkspaceSelectionHydrated,
    getIsLastWorkspaceSelectionHydrated,
  );
}

void hydrateLastWorkspaceSelection();
