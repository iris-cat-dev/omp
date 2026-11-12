import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("@/command-center/provider", () => ({ useCommandCenterActions: () => {} }));
vi.mock("@/command-center/icon", () => ({ getCommandCenterIcon: () => null }));
vi.mock("./icons", () => ({ resolvePluginIcon: () => () => null }));
vi.mock("./hooks", () => ({ usePluginContributions: () => [] }));
vi.mock("./paseo", () => ({ getPluginPaseo: () => { throw new Error("Unexpected SDK access"); } }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({ useActiveWorkspaceSelection: () => null }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    getState: () => ({ sessions: { host: { workspaces: new Map([
      ["checkout-a", { id: "checkout-a", projectId: "project" }],
      ["checkout-b", { id: "checkout-b", projectId: "project" }],
    ]) } } }),
  },
}));

import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { PluginClientInstance } from "./registry";
import { openPluginPanel } from "./commands";

const instance = {
  hostId: "host",
  installation: { id: "review", owner: "daemon" },
  scope: { assertCurrent() {} },
  contributions: { panel: [
    { id: "summary", context: "workspace" },
    { id: "details", context: "agent" },
  ] },
} as unknown as PluginClientInstance;

beforeEach(() => {
  useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
});

describe("plugin panel workspace ownership", () => {
  it.each([
    ["summary", "checkout-a", undefined, "workspace"],
    ["details", "checkout-b", "agent-b", "agent"],
  ] as const)("opens %s in its execution checkout", (panelId, workspaceId, agentId, context) => {
    openPluginPanel(instance, { hostId: "host", workspaceId, agentId }, panelId);
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace["host:project:project"];
    expect(layout).toBeDefined();
    const [tab] = collectAllTabs(layout!.root);
    expect(tab?.target).toEqual({
      kind: "plugin", pluginId: "review", panelId, workspaceId, context,
      ...(agentId ? { agentId } : {}),
    });
    expect(layout?.focusedPaneId).toBeDefined();
  });

  it("rejects a daemon panel in another host without creating a tab", () => {
    expect(() => openPluginPanel(instance, { hostId: "other", workspaceId: "checkout-a" }, "summary"))
      .toThrow("Plugin panel belongs to another host");
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toEqual({});
  });
});
