import type { AgentSessionConfig } from "@omp-desktop/protocol/agent-types";
import type { PetCreationHost } from "./client-host.js";
import type { PetCreationWorkspace } from "./types.js";

export async function launchDesktopPetCreation(input: { host: PetCreationHost; workspace: PetCreationWorkspace; preferences: Omit<AgentSessionConfig, "cwd">; locale: Parameters<PetCreationHost["createAgent"]>[0]["locale"] }): Promise<{ workspaceId: string; agentId: string }> {
  const { host, workspace, preferences, locale } = input;
  const createdWorkspace = await host.createWorkspace(workspace.cwd);
  const clientMessageId = host.createMessageId();
  const timestamp = new Date();
  const agent = await host.createAgent({ workspaceId: createdWorkspace.id, config: { ...preferences, cwd: createdWorkspace.cwd }, locale, initialPrompt: workspace.initialPrompt, clientMessageId, timestamp });
  host.openAgent(agent.id);
  return { workspaceId: createdWorkspace.id, agentId: agent.id };
}
