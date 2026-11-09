import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import {
  collectAllTabs,
  findPaneById,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildProjectLayoutKey, buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export interface SidebarAgentDraft {
  serverId: string;
  workspaceId: string;
  tabHostWorkspaceId: string;
  draftId: string;
  tabId: string;
  selected: boolean;
}

export function groupSidebarAgentDrafts(input: {
  projects: readonly SidebarProjectEntry[];
  workspaceLayouts: Readonly<Record<string, WorkspaceLayout>>;
  workspaceEntriesByKey: ReadonlyMap<
    string,
    Pick<
      SidebarWorkspaceEntry,
      "title" | "workspaceKind" | "worktreeSlug" | "hasOnlyArchivedAgents" | "hasAssociatedAgents"
    >
  >;
  activeRouteSelection: ActiveWorkspaceSelection | null;
}): ReadonlyMap<string, SidebarAgentDraft[]> {
  const projectLayoutKeyByWorkspaceKey = new Map<string, string>();
  const projectByLayoutKey = new Map<string, { serverId: string; projectViewKey: string }>();
  for (const project of input.projects) {
    for (const host of project.hosts) {
      const projectKey = buildProjectLayoutKey(host);
      if (projectKey) {
        projectByLayoutKey.set(projectKey, {
          serverId: host.serverId,
          projectViewKey: project.viewKey,
        });
      }
    }
    for (const workspace of project.workspaces) {
      const host = project.hosts.find((item) => item.serverId === workspace.serverId);
      const projectLayoutKey = host ? buildProjectLayoutKey(host) : null;
      if (projectLayoutKey) {
        projectLayoutKeyByWorkspaceKey.set(workspace.workspaceKey, projectLayoutKey);
      }
    }
  }

  const activeRoute = input.activeRouteSelection;
  const activeRouteKey = activeRoute ? buildWorkspaceTabPersistenceKey(activeRoute) : null;
  const activeLayoutKey = activeRouteKey
    ? projectLayoutKeyByWorkspaceKey.get(activeRouteKey)
    : null;
  const draftsByProjectViewKey = new Map<string, SidebarAgentDraft[]>();
  for (const [layoutKey, layout] of Object.entries(input.workspaceLayouts)) {
    const projectHost = projectByLayoutKey.get(layoutKey);
    if (!projectHost) continue;
    const { serverId, projectViewKey } = projectHost;
    const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
    for (const tab of collectAllTabs(layout.root)) {
      if (tab.target.kind !== "draft") continue;
      const routeInLayout = activeLayoutKey === layoutKey;
      const workspaceId =
        tab.target.workspaceId?.trim() || (routeInLayout ? activeRoute?.workspaceId : undefined);
      if (!workspaceId) continue;
      const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
      if (!workspaceKey || projectLayoutKeyByWorkspaceKey.get(workspaceKey) !== layoutKey) {
        continue;
      }
      // An explicit draft is visible even while catalogs hydrate or scripts/create requests run.
      // Existing conversation and worktree ownership still keep their named workspace row.
      const workspace = input.workspaceEntriesByKey.get(workspaceKey);
      if (
        !workspace ||
        workspace.title?.trim() ||
        (workspace.workspaceKind !== "local_checkout" && workspace.workspaceKind !== "directory") ||
        workspace.worktreeSlug ||
        workspace.hasOnlyArchivedAgents ||
        workspace.hasAssociatedAgents
      ) {
        continue;
      }
      const tabHostWorkspaceId =
        routeInLayout && activeRoute ? activeRoute.workspaceId : workspaceId;
      const drafts = draftsByProjectViewKey.get(projectViewKey) ?? [];
      drafts.push({
        serverId,
        workspaceId,
        tabHostWorkspaceId,
        draftId: tab.target.draftId,
        tabId: tab.tabId,
        selected: routeInLayout && focusedPane?.focusedTabId === tab.tabId,
      });
      draftsByProjectViewKey.set(projectViewKey, drafts);
    }
  }
  return draftsByProjectViewKey;
}
