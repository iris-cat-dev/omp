import { describe, expect, it, vi } from "vitest";
import { launchDesktopPetCreation } from "./creation.js";
import type { PetCreationHost } from "./client-host.js";
const preferences = { provider: "omp", model: "configured-provider/configured-model", modeId: "full", thinkingOptionId: "high", featureValues: { workflow_mode: "build" } };
function creationHost() {
  let count = 0;
  const createWorkspace = vi.fn(async (directory: string) => ({ id: `workspace-${++count}`, cwd: directory }));
  const createAgent = vi.fn(async (input: { workspaceId: string }) => ({ id: `agent-${input.workspaceId}` }));
  const openAgent = vi.fn();
  const host: PetCreationHost = { serverId: "local", prepareWorkspace: vi.fn(async () => ({ cwd: "/owned/prepared", initialPrompt: "Create a pet" })), createMessageId: () => `message-${count}`, createWorkspace, createAgent, openAgent };
  return { host, createWorkspace, createAgent, openAgent };
}
describe("ordinary pet authoring conversations", () => {
  it("creates independent workspaces and preserves the user's model/thinking/mode/features without plugin activation", async () => {
    const { host, createWorkspace, createAgent, openAgent } = creationHost();
    const first = await launchDesktopPetCreation({ host, preferences, locale: "zh-CN", workspace: { cwd: "/owned/one", initialPrompt: "Read hatch-pet and create one" } });
    const second = await launchDesktopPetCreation({ host, preferences, locale: "zh-CN", workspace: { cwd: "/owned/two", initialPrompt: "Read hatch-pet and create another" } });
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(first.agentId).not.toBe(second.agentId);
    expect(createWorkspace.mock.calls).toEqual([["/owned/one"], ["/owned/two"]]);
    expect(createAgent).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: second.workspaceId, config: { ...preferences, cwd: "/owned/two" }, locale: "zh-CN", initialPrompt: "Read hatch-pet and create another", clientMessageId: expect.any(String), timestamp: expect.any(Date) }));
    expect(openAgent).toHaveBeenLastCalledWith(second.agentId);
  });
  it("surfaces workspace failure before creating or navigating to an agent", async () => { const { host, createWorkspace, createAgent, openAgent } = creationHost(); createWorkspace.mockRejectedValueOnce(new Error("Local host disconnected")); await expect(launchDesktopPetCreation({ host, preferences, locale: "en", workspace: { cwd: "/owned/failure", initialPrompt: "Create" } })).rejects.toThrow("Local host disconnected"); expect(createAgent).not.toHaveBeenCalled(); expect(openAgent).not.toHaveBeenCalled(); });
  it("does not claim a conversation when the selected creation model fails", async () => { const { host, createAgent, openAgent } = creationHost(); createAgent.mockRejectedValueOnce(new Error("Configured model unavailable")); await expect(launchDesktopPetCreation({ host, preferences, locale: "en", workspace: { cwd: "/owned/no-model", initialPrompt: "Create" } })).rejects.toThrow("Configured model unavailable"); expect(openAgent).not.toHaveBeenCalled(); });
});
