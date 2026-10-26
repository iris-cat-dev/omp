import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type { AgentSessionConfig } from "@omp-desktop/protocol/agent-types";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import { handoffCreatedAgentMessageSubmission } from "@/composer/submission/writer";
import { createUserMessage, generateMessageId } from "@/types/stream";
import type { PetCreationWorkspace } from "./types";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";
import { assertLocalModelBridgeReady } from "@/runtime/local-model-bridge-runtime";

// Mirrors the existing workspace draft's real create request, but never reuses
// a current workspace, draft id or conversation for the authoring directory.
export async function launchDesktopPetCreation(input: {
  serverId: string;
  client: Pick<DaemonClient, "createWorkspace" | "createAgent">;
  workspace: PetCreationWorkspace;
  preferences: Omit<AgentSessionConfig, "cwd">;
}): Promise<{ workspaceId: string; agentId: string }> {
  const { serverId, client, workspace, preferences } = input;
  const payload = await client.createWorkspace({
    source: { kind: "directory", path: workspace.cwd },
  });
  if (payload.error || !payload.workspace) {
    throw new Error(payload.error ?? "Unable to create pet authoring workspace");
  }
  const normalizedWorkspace = normalizeWorkspaceDescriptor(payload.workspace);
  const store = useSessionStore.getState();
  store.mergeWorkspaces(serverId, [normalizedWorkspace]);
  store.setHasHydratedWorkspaces(serverId, true);
  const cwd = requireWorkspaceDirectory({
    workspaceId: normalizedWorkspace.id,
    workspaceDirectory: normalizedWorkspace.workspaceDirectory,
  });
  const clientMessageId = generateMessageId();
  const timestamp = new Date();
  assertLocalModelBridgeReady(client);
  const agent = await client.createAgent({
    config: buildWorkspaceDraftAgentConfig({ ...preferences, cwd }),
    workspaceId: normalizedWorkspace.id,
    initialPrompt: workspace.initialPrompt,
    clientMessageId,
  });
  store.setAgents(serverId, (previous) => {
    const next = new Map(previous);
    next.set(
      agent.id,
      applyLegacyDaemonWorkspaceOwnership({
        serverId,
        agent: normalizeAgentSnapshot(agent, serverId),
      }),
    );
    return next;
  });
  handoffCreatedAgentMessageSubmission(
    serverId,
    agent.id,
    createUserMessage({
      clientMessageId,
      text: workspace.initialPrompt,
      timestamp,
    }),
  );
  navigateToAgent({ serverId, agentId: agent.id });
  return { workspaceId: normalizedWorkspace.id, agentId: agent.id };
}
