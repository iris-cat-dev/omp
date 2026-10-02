import { describe, expect, it, vi } from "vitest";
import { resolveNavigateToAgent, type NavigateToAgentDeps } from "./resolve";
import {
  navigateToWorkspace,
  type NavigateToWorkspaceDeps,
} from "@/stores/navigation-active-workspace-store/navigation";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  collectAllPanes,
  createWorkspaceLayoutStore,
  findPaneById,
} from "@/stores/workspace-layout-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
  },
}));

const SERVER_ID = "server-1";
const HOST_ID = "workspace-host";
const OWNER_ID = "workspace-owner";
const HOST_KEY = `${SERVER_ID}:${HOST_ID}`;
const AGENT_ID = "agent-y";

function createNavigation(agentWorkspaceId: string | null = OWNER_ID) {
  let nextId = 0;
  const store = createWorkspaceLayoutStore({
    createNodeId: (prefix) => `${prefix}_${++nextId}`,
    createFocusRestorationToken: () => `focus-${++nextId}`,
  });
  let route = `/h/${SERVER_ID}/workspace/${HOST_ID}`;
  let remembered: ActiveWorkspaceSelection | null = null;
  const workspaceDeps: NavigateToWorkspaceDeps = {
    getSessionWorkspaces: () =>
      new Map([HOST_ID, OWNER_ID].map((id) => [id, { id } as WorkspaceDescriptor])),
    getSessionAgents: () => [],
    openTab: (input) => store.getState().openTab(input),
    pinAgent: (key, id) => store.getState().pinAgent(key, id),
    rememberLastWorkspace: (selection) => {
      remembered = selection;
    },
    navigateToRoute: (nextRoute) => {
      route = nextRoute;
    },
  };
  const deps: NavigateToAgentDeps = {
    ...workspaceDeps,
    getWorkspaceTabs: (key) => store.getState().getWorkspaceTabs(key),
    readAgentNavTarget: () => ({ agentWorkspaceId }),
    navigateToHostAgent: (nextRoute) => {
      route = nextRoute;
    },
    navigateToWorkspace: (input) => navigateToWorkspace(input, workspaceDeps),
  };
  const openAgent = (agentId: string) =>
    store.getState().openTab({
      workspaceKey: HOST_KEY,
      target: { kind: "agent", agentId },
      intent: "reveal",
    })!;
  const agentIds = (key = HOST_KEY) =>
    store
      .getState()
      .getWorkspaceTabs(key)
      .flatMap((tab) => (tab.target.kind === "agent" ? [tab.target.agentId] : []));
  return { store, deps, openAgent, agentIds, route: () => route, remembered: () => remembered };
}

function notification(workspaceId = OWNER_ID) {
  return {
    serverId: SERVER_ID,
    workspaceId,
    agentId: AGENT_ID,
    pin: true,
    tabHost: { serverId: SERVER_ID, workspaceId: HOST_ID },
  };
}

describe("resolveNavigateToAgent", () => {
  it.each([HOST_ID, OWNER_ID])(
    "reveals an existing notification target without changing panes (%s)",
    (ownerId) => {
      const nav = createNavigation(ownerId);
      nav.openAgent("agent-x");
      const targetTabId = nav.openAgent(AGENT_ID);
      nav.openAgent("agent-z");
      const targetPaneId = nav.store.getState().splitPane(HOST_KEY, {
        tabId: targetTabId,
        targetPaneId: "main",
        position: "right",
      });
      nav.openAgent("agent-w");
      const panes = () =>
        collectAllPanes(nav.store.getState().layoutByWorkspace[HOST_KEY].root).map((pane) => ({
          id: pane.id,
          tabIds: pane.tabIds,
        }));
      const before = panes();

      const route = resolveNavigateToAgent(notification(ownerId), nav.deps);

      expect(route).toBe(`/h/${SERVER_ID}/workspace/${HOST_ID}`);
      expect(nav.route()).toBe(route);
      expect(panes()).toEqual(before);
      const layout = nav.store.getState().layoutByWorkspace[HOST_KEY];
      expect(layout.focusedPaneId).toBe(targetPaneId);
      expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(targetTabId);
      expect(nav.agentIds().filter((id) => id === AGENT_ID)).toEqual([AGENT_ID]);
      expect(nav.remembered()).toEqual(notification().tabHost);
    },
  );

  it("adds a not-yet-open notification target and preserves the other tabs", () => {
    const nav = createNavigation();
    nav.openAgent("agent-x");
    nav.openAgent("agent-z");

    resolveNavigateToAgent(notification(), nav.deps);
    resolveNavigateToAgent(notification(), nav.deps);

    expect(nav.route()).toBe(`/h/${SERVER_ID}/workspace/${HOST_ID}`);
    expect(nav.agentIds()).toEqual(["agent-x", "agent-z", AGENT_ID]);
    expect(nav.store.getState().layoutByWorkspace[`${SERVER_ID}:${OWNER_ID}`]).toBeUndefined();
  });

  it("does not host a notification from another server", () => {
    const nav = createNavigation();
    nav.openAgent("agent-x");
    const before = nav.store.getState().layoutByWorkspace[HOST_KEY];

    resolveNavigateToAgent({ ...notification(), serverId: "server-2" }, nav.deps);

    expect(nav.route()).toBe(`/h/server-2/workspace/${OWNER_ID}`);
    expect(nav.agentIds(`server-2:${OWNER_ID}`)).toEqual([AGENT_ID]);
    expect(nav.store.getState().layoutByWorkspace[HOST_KEY]).toEqual(before);
  });

  it("leaves a draft-only host so its normal cleanup can run", () => {
    const nav = createNavigation();
    nav.store.getState().openTab({
      workspaceKey: HOST_KEY,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    const before = nav.store.getState().layoutByWorkspace[HOST_KEY];

    resolveNavigateToAgent(notification(), nav.deps);

    expect(nav.route()).toBe(`/h/${SERVER_ID}/workspace/${OWNER_ID}`);
    expect(nav.agentIds(`${SERVER_ID}:${OWNER_ID}`)).toEqual([AGENT_ID]);
    expect(nav.store.getState().layoutByWorkspace[HOST_KEY]).toEqual(before);
  });

  it("uses the notification owner on a cold start without a tab host", () => {
    const nav = createNavigation(null);

    resolveNavigateToAgent({ ...notification(), tabHost: null }, nav.deps);

    expect(nav.route()).toBe(`/h/${SERVER_ID}/workspace/${OWNER_ID}`);
    expect(nav.agentIds(`${SERVER_ID}:${OWNER_ID}`)).toEqual([AGENT_ID]);
  });

  it("keeps ordinary agent navigation targeted at the owning workspace", () => {
    const nav = createNavigation();

    resolveNavigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID }, nav.deps);

    expect(nav.route()).toBe(`/h/${SERVER_ID}/workspace/${OWNER_ID}`);
    expect(nav.agentIds(`${SERVER_ID}:${OWNER_ID}`)).toEqual([AGENT_ID]);
  });

  it("falls back to agent recovery when neither host nor owner is known", () => {
    const nav = createNavigation(null);

    resolveNavigateToAgent({ serverId: SERVER_ID, agentId: AGENT_ID }, nav.deps);

    expect(nav.route()).toBe(`/h/${SERVER_ID}/agent/${AGENT_ID}`);
    expect(nav.store.getState().layoutByWorkspace).toEqual({});
  });
});
