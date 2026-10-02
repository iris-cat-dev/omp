import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { pickAttentionAgent } from "@/utils/agent-attention";
import { listActiveWorkspaceRootAgentIds, pickWorkspacePrimaryAgentId } from "@/subagents/policies";
import {
  buildHostWorkspaceOpenRoute,
  buildHostWorkspaceRoute,
  decodeWorkspaceIdFromPathSegment,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";
import { prepareWorkspaceTab, type PrepareWorkspaceTabDeps } from "@/utils/prepare-workspace-tab";

export interface RouteSelectionInput {
  pathname: string;
  params: {
    serverId?: string | string[];
    workspaceId?: string | string[];
  };
}

export interface NavigateToWorkspaceInput {
  serverId: string;
  workspaceId: string;
  target?: WorkspaceTabTarget;
  pin?: boolean;
  // Defer agent-tab preparation until the destination route is active. This avoids
  // inactive retained-workspace effects restoring the previously focused tab.
  deferAgentTargetUntilNavigation?: boolean;
}

export interface NavigateToSidebarWorkspaceInput extends NavigateToWorkspaceInput {
  tabHost?: ActiveWorkspaceSelection | null;
}

export interface NavigateToWorkspaceDeps extends PrepareWorkspaceTabDeps {
  getSessionWorkspaces: (serverId: string) => Map<string, WorkspaceDescriptor> | null | undefined;
  getSessionAgents: (serverId: string) => Iterable<Agent>;
  rememberLastWorkspace: (selection: ActiveWorkspaceSelection) => void;
  navigateToRoute: (route: string) => void;
}

export interface WorkspaceHistoryAgent {
  id: string;
  workspaceId?: string | null;
  parentAgentId: string | null;
  createdAt?: Date | string | null;
  archivedAt?: Date | string | null;
}

export interface NavigateToSidebarWorkspaceDeps extends NavigateToWorkspaceDeps {
  getSessionAgentsHydrated: (serverId: string) => boolean;
  getWorkspaceTabs: (workspaceKey: string) => readonly WorkspaceTab[];
  fetchWorkspaceAgentHistory: (
    serverId: string,
    workspaceId: string,
  ) => Promise<readonly WorkspaceHistoryAgent[]>;
}

export interface NavigateToLastWorkspaceDeps extends NavigateToWorkspaceDeps {
  getLastWorkspaceSelection: () => ActiveWorkspaceSelection | null;
}

function getParamValue(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const firstValue = value[0];
    return typeof firstValue === "string" ? firstValue.trim() : "";
  }
  return "";
}

function parseWorkspaceSelectionFromRouteParams(params: {
  serverId?: string | string[];
  workspaceId?: string | string[];
}): ActiveWorkspaceSelection | null {
  const serverId = getParamValue(params.serverId);
  const workspaceValue = getParamValue(params.workspaceId);
  const workspaceId = workspaceValue ? decodeWorkspaceIdFromPathSegment(workspaceValue) : null;
  if (!serverId || !workspaceId) {
    return null;
  }
  return { serverId, workspaceId };
}

export function parseActiveWorkspaceSelection(
  input: RouteSelectionInput,
): ActiveWorkspaceSelection | null {
  const routeSelection = parseHostWorkspaceRouteFromPathname(input.pathname);
  if (routeSelection) {
    return routeSelection;
  }

  if (input.pathname !== "/" && input.pathname !== "") {
    return null;
  }

  return parseWorkspaceSelectionFromRouteParams(input.params);
}

export function navigateToWorkspace(
  input: NavigateToWorkspaceInput,
  deps: NavigateToWorkspaceDeps,
): string {
  const workspaces = deps.getSessionWorkspaces(input.serverId);
  const resolvedWorkspaceId = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: input.workspaceId,
  });
  if (input.target) {
    if (
      !input.deferAgentTargetUntilNavigation &&
      (resolvedWorkspaceId || input.target.kind !== "agent")
    ) {
      prepareWorkspaceTab({ ...input, target: input.target }, deps);
    }
  } else {
    const workspaceAgents = resolvedWorkspaceId
      ? Array.from(deps.getSessionAgents(input.serverId)).filter(
          (agent) => normalizeWorkspaceOpaqueId(agent.workspaceId) === resolvedWorkspaceId,
        )
      : [];
    const attentionAgentId = pickAttentionAgent(workspaceAgents);
    if (attentionAgentId && resolvedWorkspaceId) {
      deps.openTab({
        workspaceKey: `${input.serverId}:${resolvedWorkspaceId}`,
        target: { kind: "agent", agentId: attentionAgentId },
        intent: "reveal",
      });
    }
  }

  const route =
    input.target?.kind === "agent" &&
    (!resolvedWorkspaceId || input.deferAgentTargetUntilNavigation)
      ? buildHostWorkspaceOpenRoute(
          input.serverId,
          input.workspaceId,
          `agent:${input.target.agentId}`,
        )
      : buildHostWorkspaceRoute(input.serverId, input.workspaceId);
  deps.rememberLastWorkspace({ serverId: input.serverId, workspaceId: input.workspaceId });
  deps.navigateToRoute(route);
  return route;
}

export function resolveWorkspaceTabHost(
  input: Pick<NavigateToSidebarWorkspaceInput, "serverId" | "tabHost">,
  deps: Pick<NavigateToSidebarWorkspaceDeps, "getSessionWorkspaces" | "getWorkspaceTabs">,
): ActiveWorkspaceSelection | null {
  const tabHost = input.tabHost;
  if (!tabHost || tabHost.serverId !== input.serverId) {
    return null;
  }
  const workspaceId =
    resolveWorkspaceMapKeyByIdentity({
      workspaces: deps.getSessionWorkspaces(tabHost.serverId),
      workspaceId: tabHost.workspaceId,
    }) ?? normalizeWorkspaceOpaqueId(tabHost.workspaceId);
  if (workspaceId) {
    const tabs = deps.getWorkspaceTabs(`${tabHost.serverId}:${workspaceId}`);
    if (
      tabs.some((tab) => tab.target.kind === "draft") &&
      !tabs.some((tab) => tab.target.kind === "agent")
    ) {
      // Navigate away so the draft workspace's leave cleanup can release it.
      // Hosting the destination here would keep the route focused indefinitely.
      return null;
    }
  }
  return workspaceId ? { serverId: tabHost.serverId, workspaceId } : null;
}

function revealSidebarAgentInTabHost(
  tabHost: ActiveWorkspaceSelection,
  agentId: string,
  deps: NavigateToSidebarWorkspaceDeps,
): string {
  prepareWorkspaceTab(
    {
      serverId: tabHost.serverId,
      workspaceId: tabHost.workspaceId,
      target: { kind: "agent", agentId },
      pin: true,
    },
    deps,
  );
  return buildHostWorkspaceRoute(tabHost.serverId, tabHost.workspaceId);
}

export async function navigateToSidebarWorkspace(
  input: NavigateToSidebarWorkspaceInput,
  deps: NavigateToSidebarWorkspaceDeps,
): Promise<string> {
  if (input.target) {
    return navigateToWorkspace(input, deps);
  }

  const tabHost = resolveWorkspaceTabHost(input, deps);
  if (!deps.getSessionAgentsHydrated(input.serverId) && !tabHost) {
    return navigateToWorkspace(input, deps);
  }

  const workspaces = deps.getSessionWorkspaces(input.serverId);
  const workspaceId =
    resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId: input.workspaceId }) ??
    normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!workspaceId) {
    return navigateToWorkspace(input, deps);
  }

  const activeAgents = Array.from(deps.getSessionAgents(input.serverId)).filter(
    (agent) => !agent.archivedAt,
  );
  const activeWorkspaceAgents = activeAgents.filter(
    (agent) => normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId,
  );
  const rootAgentIds = listActiveWorkspaceRootAgentIds(activeAgents, workspaceId);
  if (rootAgentIds.length > 0) {
    const activeAgentById = new Map(activeAgents.map((agent) => [agent.id, agent]));
    const rootAgents = rootAgentIds.flatMap((agentId) => {
      const agent = activeAgentById.get(agentId);
      return agent ? [agent] : [];
    });
    const focusedAgentId = pickAttentionAgent(rootAgents) ?? rootAgentIds[0];
    if (!focusedAgentId) {
      return navigateToWorkspace(input, deps);
    }
    const revealOrder = [
      ...rootAgentIds.filter((agentId) => agentId !== focusedAgentId),
      focusedAgentId,
    ];
    if (tabHost) {
      for (const agentId of revealOrder) {
        revealSidebarAgentInTabHost(tabHost, agentId, deps);
      }
      return buildHostWorkspaceRoute(tabHost.serverId, tabHost.workspaceId);
    }

    const workspaceKey = `${input.serverId}:${workspaceId}`;
    for (const agentId of rootAgentIds) {
      deps.pinAgent(workspaceKey, agentId);
    }
    return navigateToWorkspace(
      {
        ...input,
        target: { kind: "agent", agentId: focusedAgentId },
        pin: true,
        deferAgentTargetUntilNavigation: true,
      },
      deps,
    );
  }
  if (activeWorkspaceAgents.length > 0) {
    const agentId = pickWorkspacePrimaryAgentId(activeAgents, workspaceId);
    if (agentId && tabHost) {
      return revealSidebarAgentInTabHost(tabHost, agentId, deps);
    }
    if (agentId) {
      return navigateToWorkspace(
        {
          ...input,
          target: { kind: "agent", agentId },
          pin: true,
          deferAgentTargetUntilNavigation: true,
        },
        deps,
      );
    }
    return navigateToWorkspace(input, deps);
  }

  try {
    const history = await deps.fetchWorkspaceAgentHistory(input.serverId, workspaceId);
    const agentId = pickWorkspacePrimaryAgentId(history, workspaceId);
    if (agentId) {
      if (tabHost) {
        return revealSidebarAgentInTabHost(tabHost, agentId, deps);
      }
      return navigateToWorkspace(
        {
          ...input,
          target: { kind: "agent", agentId },
          pin: true,
          deferAgentTargetUntilNavigation: true,
        },
        deps,
      );
    }
  } catch {
    // History is a best-effort fallback. The workspace itself must remain navigable.
  }

  return navigateToWorkspace(input, deps);
}

export function navigateToLastWorkspace(deps: NavigateToLastWorkspaceDeps): boolean {
  const selection = deps.getLastWorkspaceSelection();
  if (!selection) {
    return false;
  }
  navigateToWorkspace(selection, deps);
  return true;
}
