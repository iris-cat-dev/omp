import type { AgentProvider } from "@omp-desktop/protocol/agent-types";
import type { JsonValue } from "@omp-desktop/protocol/agent-types";
import type { WorkspaceFileTabTarget } from "@/workspace/file-open";

export interface WorkspaceDraftTabSetup {
  provider: AgentProvider;
  cwd: string;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
}

export interface WorkspaceWorkingDiffTabTarget {
  kind: "working_diff";
  focusPath?: string;
  focusRequestId?: number;
}

export type PluginWorkspaceTabTarget =
  | {
      kind: "plugin";
      pluginId: string;
      panelId: string;
      context: "workspace";
    }
  | {
      kind: "plugin";
      pluginId: string;
      panelId: string;
      context: "agent";
      agentId: string;
    };

export type WorkspaceTabTarget = (
  | { kind: "new_tab" }
  | {
      kind: "draft";
      draftId: string;
      setup?: WorkspaceDraftTabSetup;
    }
  | { kind: "agent"; agentId: string }
  | { kind: "prompt_analysis"; agentId: string }
  | { kind: "provider_subagent"; parentAgentId: string; subagentId: string }
  | { kind: "terminal"; terminalId: string }
  | { kind: "background_process"; agentId: string; processId: string }
  | { kind: "files" }
  | { kind: "pull_request" }
  | WorkspaceFileTabTarget
  | { kind: "local_file"; previewId: string; name: string }
  | WorkspaceWorkingDiffTabTarget
  | PluginWorkspaceTabTarget
  | { kind: "setup"; workspaceId: string }
  | { kind: "workspace_overview"; workspaceId: string }
  | { kind: "commit_diff"; sha: string }
) & { workspaceId?: string };

export interface WorkspaceTab {
  tabId: string;
  target: WorkspaceTabTarget;
  createdAt: number;
  state?: JsonValue;
}

export function buildWorkspaceTabPersistenceKey(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  const serverId = input.serverId.trim();
  const workspaceId = input.workspaceId.trim();
  if (!serverId || !workspaceId) {
    return null;
  }
  return `${serverId}:${workspaceId}`;
}

/** A project owns one pane tree irrespective of the number of its workspaces. */
export function buildProjectLayoutKey(input: {
  serverId: string;
  projectId: string;
}): string | null {
  const serverId = input.serverId.trim();
  const projectId = input.projectId.trim();
  return serverId && projectId ? `${serverId}:project:${encodeURIComponent(projectId)}` : null;
}
