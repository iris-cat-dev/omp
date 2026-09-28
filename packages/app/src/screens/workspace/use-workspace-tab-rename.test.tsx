/* @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { useWorkspaceTabRename } from "@/screens/workspace/use-workspace-tab-rename";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";

vi.mock("@/components/rename-modal", () => ({ AdaptiveRenameModal: () => null }));
void i18n;

const SERVER_ID = "rename-test-server";
const WORKSPACE_ID = "rename-test-workspace";
const PRIMARY_ID = "primary-agent";
const OTHER_ID = "other-agent";
const NOW = new Date("2026-08-01T12:00:00.000Z");

function agent(id: string, title: string, createdAt: Date): Agent {
  return {
    serverId: SERVER_ID,
    id,
    provider: "omp",
    status: "idle",
    activeTurn: null,
    createdAt,
    updatedAt: NOW,
    lastUserMessageAt: null,
    lastActivityAt: NOW,
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title,
    cwd: "/repo",
    workspaceId: WORKSPACE_ID,
    model: null,
    parentAgentId: null,
    labels: {},
  };
}

function agentTab(id: string): WorkspaceTabDescriptor {
  return { key: id, tabId: id, kind: "agent", target: { kind: "agent", agentId: id } };
}

beforeEach(() => {
  const store = useSessionStore.getState();
  store.initializeSession(SERVER_ID, null as unknown as DaemonClient);
  const workspace: WorkspaceDescriptor = {
    id: WORKSPACE_ID,
    projectId: "project",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "Derived workspace name",
    title: "Original workspace",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
  store.setWorkspaces(SERVER_ID, new Map([[WORKSPACE_ID, workspace]]));
  store.setAgents(
    SERVER_ID,
    new Map([
      [PRIMARY_ID, agent(PRIMARY_ID, "Original primary agent", NOW)],
      [OTHER_ID, agent(OTHER_ID, "Original conversation", new Date(NOW.getTime() + 1000))],
    ]),
  );
});

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

function mountRename(client: DaemonClient) {
  const queryClient = new QueryClient();
  return renderHook(() =>
    useWorkspaceTabRename({
      client,
      normalizedServerId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      queryClient,
      terminalsData: undefined,
      terminalsQueryKey: ["terminals", SERVER_ID],
    }),
  );
}

describe("renamed conversation tab titles", () => {
  it("shows the saved workspace title when returning to the primary tab before an update event arrives", async () => {
    const store = useSessionStore.getState();
    const workspace = store.sessions[SERVER_ID]!.workspaces.get(WORKSPACE_ID)!;
    store.setWorkspaces(SERVER_ID, new Map([["legacy-key", workspace]]));
    const setWorkspaceTitle = vi.fn(async () => ({ title: "Renamed workspace" }));
    const hook = mountRename({ setWorkspaceTitle } as unknown as DaemonClient);
    act(() => hook.result.current.handleRenameTab(agentTab(PRIMARY_ID)));
    expect(hook.result.current.renamingTab?.currentTitle).toBe("Original workspace");

    await act(async () => hook.result.current.handleRenameModalSubmit("Renamed workspace"));

    const workspaces = useSessionStore.getState().sessions[SERVER_ID]?.workspaces;
    expect(workspaces?.get("legacy-key")).toMatchObject({
      name: "Renamed workspace",
      title: "Renamed workspace",
    });
    expect(workspaces?.size).toBe(1);
    expect(setWorkspaceTitle).toHaveBeenCalledWith(WORKSPACE_ID, "Renamed workspace");
    act(() => hook.result.current.handleRenameTab(agentTab(OTHER_ID)));
    act(() => hook.result.current.handleRenameTab(agentTab(PRIMARY_ID)));
    expect(hook.result.current.renamingTab?.currentTitle).toBe("Renamed workspace");
    hook.unmount();
  });

  it("shows a renamed additional conversation when returning to its tab before an update event arrives", async () => {
    const updateAgent = vi.fn(async () => {});
    const hook = mountRename({ updateAgent } as unknown as DaemonClient);
    act(() => hook.result.current.handleRenameTab(agentTab(OTHER_ID)));
    expect(hook.result.current.renamingTab?.currentTitle).toBe("Original conversation");

    await act(async () => hook.result.current.handleRenameModalSubmit("Renamed conversation"));

    act(() => hook.result.current.handleRenameTab(agentTab(PRIMARY_ID)));
    act(() => hook.result.current.handleRenameTab(agentTab(OTHER_ID)));
    expect(hook.result.current.renamingTab?.currentTitle).toBe("Renamed conversation");
    expect(useSessionStore.getState().sessions[SERVER_ID]?.agents.get(OTHER_ID)?.title).toBe(
      "Renamed conversation",
    );
    expect(updateAgent).toHaveBeenCalledWith(OTHER_ID, { name: "Renamed conversation" });
    hook.unmount();
  });

  it("keeps an unloaded additional conversation's renamed title when returning to its tab", async () => {
    const store = useSessionStore.getState();
    const other = store.sessions[SERVER_ID]!.agents.get(OTHER_ID)!;
    store.setAgents(SERVER_ID, (agents) => {
      const next = new Map(agents);
      next.delete(OTHER_ID);
      return next;
    });
    store.setAgentDetails(SERVER_ID, new Map([[OTHER_ID, other]]));
    const hook = mountRename({ updateAgent: vi.fn(async () => {}) } as unknown as DaemonClient);
    act(() => hook.result.current.handleRenameTab(agentTab(OTHER_ID)));
    await act(async () => hook.result.current.handleRenameModalSubmit("Saved unloaded title"));

    act(() => hook.result.current.handleRenameTab(agentTab(PRIMARY_ID)));
    act(() => hook.result.current.handleRenameTab(agentTab(OTHER_ID)));
    expect(hook.result.current.renamingTab?.currentTitle).toBe("Saved unloaded title");
    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentDetails.get(OTHER_ID)?.title).toBe(
      "Saved unloaded title",
    );
    hook.unmount();
  });
});
