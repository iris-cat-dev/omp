import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import {
  resolveWorkspaceTabHost,
  type NavigateToSidebarWorkspaceDeps,
} from "@/stores/navigation-active-workspace-store/navigation";

export interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  // Owning workspace supplied by a deep link or notification; falls back to the session store.
  workspaceId?: string | null;
  pin?: boolean;
  // Optional presentation host. Never changes the agent's owning workspace.
  tabHost?: ActiveWorkspaceSelection | null;
}

export interface AgentNavTarget {
  agentWorkspaceId: string | null | undefined;
}

export interface NavigateToAgentDeps extends Pick<
  NavigateToSidebarWorkspaceDeps,
  "getSessionWorkspaces" | "getWorkspaceTabs"
> {
  readAgentNavTarget: (input: { serverId: string; agentId: string }) => AgentNavTarget;
  navigateToHostAgent: (route: string) => void;
  navigateToWorkspace: (input: NavigateToWorkspaceInput) => string;
}

export function resolveNavigateToAgent(
  input: NavigateToAgentInput,
  deps: NavigateToAgentDeps,
): string {
  const tabHost = resolveWorkspaceTabHost(input, deps);
  const agentWorkspaceId =
    tabHost?.workspaceId ??
    input.workspaceId ??
    deps.readAgentNavTarget({ serverId: input.serverId, agentId: input.agentId }).agentWorkspaceId;
  const workspaceId = normalizeWorkspaceOpaqueId(agentWorkspaceId);

  if (!workspaceId) {
    const route = buildHostAgentDetailRoute(input.serverId, input.agentId);
    deps.navigateToHostAgent(route);
    return route;
  }

  return deps.navigateToWorkspace({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "agent", agentId: input.agentId },
    pin: input.pin,
  });
}
