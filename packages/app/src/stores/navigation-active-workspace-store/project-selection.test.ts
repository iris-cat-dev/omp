import { describe, expect, it, vi } from "vitest";
import { createProjectSelectionStore } from "./project-selection";
import { navigateToProject, type NavigateToWorkspaceDeps } from "./navigation";
import { shouldFocusProjectOnPress } from "@/utils/project-row-interaction";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";

function projectFixture() {
  let persisted: string | null = null;
  const store = createProjectSelectionStore({
    read: async () => persisted,
    write: async (value) => {
      persisted = value;
    },
  });
  return { store, getPersisted: () => persisted };
}

describe("project focus", () => {
  it("requires Cmd on a Mac desktop; plain clicks retain collapse", () => {
    expect(shouldFocusProjectOnPress({ metaKey: true, isMacDesktop: true })).toBe(true);
    expect(shouldFocusProjectOnPress({ metaKey: false, isMacDesktop: true })).toBe(false);
    expect(shouldFocusProjectOnPress({ metaKey: true, isMacDesktop: false })).toBe(false);
  });

  it("restores the last workspace per project without opening an attention tab", async () => {
    const { store, getPersisted } = projectFixture();
    const first = { serverId: "host", projectId: "first" };
    const second = { serverId: "host", projectId: "second" };
    store.remember(first, { serverId: "host", workspaceId: "first-workspace" });
    store.remember(second, { serverId: "host", workspaceId: "second-workspace" });
    await vi.waitFor(() => expect(getPersisted()).toContain("second-workspace"));
    const rehydrated = createProjectSelectionStore({
      read: async () => getPersisted(),
      write: async () => {},
    });
    await rehydrated.hydrate();
    const routes: string[] = [];
    const opened: string[] = [];
    const readRequests: string[] = [];
    const deps: NavigateToWorkspaceDeps & {
      getProjectLastWorkspace: typeof rehydrated.get;
    } = {
      getProjectLastWorkspace: rehydrated.get,
      getSessionWorkspaces: () =>
        new Map([
          ["first-workspace", { id: "first-workspace", projectId: "first" } as WorkspaceDescriptor],
          [
            "second-workspace",
            { id: "second-workspace", projectId: "second" } as WorkspaceDescriptor,
          ],
        ]),
      getSessionAgents: () => [
        { id: "attention", workspaceId: "first-workspace", requiresAttention: true } as Agent,
      ],
      getFocusedAgentId: (_serverId, workspaceId) => `focused:${workspaceId}`,
      requestAgentAttentionRead: (_serverId, agentId) => readRequests.push(agentId),
      openTab: ({ workspaceKey }) => {
        opened.push(workspaceKey);
        return null;
      },
      pinAgent: () => {},
      rememberLastWorkspace: () => {},
      navigateToRoute: (route) => {
        routes.push(route);
      },
    };
    navigateToProject(first, deps);
    navigateToProject(second, deps);
    navigateToProject(first, deps);
    expect(routes).toEqual([
      "/h/host/workspace/first-workspace",
      "/h/host/workspace/second-workspace",
      "/h/host/workspace/first-workspace",
    ]);
    expect(opened).toEqual([]);
    expect(readRequests).toEqual([
      "focused:first-workspace",
      "focused:second-workspace",
      "focused:first-workspace",
    ]);
  });

  it("focuses a project with no workspace without allocating backend resources", () => {
    const { store } = projectFixture();
    const navigations: string[] = [];
    const deps: NavigateToWorkspaceDeps & { getProjectLastWorkspace: typeof store.get } = {
      getProjectLastWorkspace: store.get,
      getSessionWorkspaces: () => new Map(),
      getSessionAgents: () => [],
      getFocusedAgentId: () => null,
      requestAgentAttentionRead: () => {
        throw new Error("No conversation should be marked read");
      },
      openTab: () => {
        throw new Error("No tabs should open");
      },
      pinAgent: () => {
        throw new Error("No agents should pin");
      },
      rememberLastWorkspace: () => {
        throw new Error("No workspace should be remembered");
      },
      navigateToRoute: (route) => {
        navigations.push(route);
      },
    };
    expect(navigateToProject({ serverId: "host", projectId: "empty/one" }, deps)).toBe(
      "/h/host/project/empty%2Fone",
    );
    expect(navigations).toEqual(["/h/host/project/empty%2Fone"]);
  });

  it("keeps other projects' saved selections when a project is opened during hydration", async () => {
    let finishRead!: (value: string) => void;
    let persisted = "";
    const saved = { serverId: "host", projectId: "saved" };
    const active = { serverId: "host", projectId: "active" };
    const store = createProjectSelectionStore({
      read: () =>
        new Promise<string>((resolve) => {
          finishRead = resolve;
        }),
      write: async (value) => {
        persisted = value;
      },
    });
    const hydration = store.hydrate();
    store.remember(active, { serverId: "host", workspaceId: "new-active" });
    finishRead(
      JSON.stringify({
        "host:project:saved": { serverId: "host", workspaceId: "saved-workspace" },
        "host:project:active": { serverId: "host", workspaceId: "old-active" },
      }),
    );
    await hydration;
    expect(store.get(saved)?.workspaceId).toBe("saved-workspace");
    expect(store.get(active)?.workspaceId).toBe("new-active");
    await vi.waitFor(() =>
      expect(JSON.parse(persisted)).toEqual({
        "host:project:saved": { serverId: "host", workspaceId: "saved-workspace" },
        "host:project:active": { serverId: "host", workspaceId: "new-active" },
      }),
    );
  });
});
