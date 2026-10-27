import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarWorkspaceMenu } from "./sidebar-workspace-menu";

const state = vi.hoisted(() => ({
  items: new Map<string, () => Promise<void>>(),
  history: vi.fn(),
  copy: vi.fn(),
  copied: vi.fn(),
  error: vi.fn(),
  archive: vi.fn(),
  connected: true,
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: state.copy }));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ copied: state.copied, error: state.error }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: (serverId: string) =>
      state.connected && serverId === "host" ? { fetchAgentHistory: state.history } : null,
  }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: (component: unknown) => component,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => children,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => children,
  DropdownMenuTrigger: () => null,
  DropdownMenuItem: ({ testID, onSelect }: { testID?: string; onSelect: () => Promise<void> }) => {
    if (testID) state.items.set(testID, onSelect);
    return null;
  },
  DropdownMenuSubTrigger: () => null,
}));
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: () => null,
  ContextMenuContent: () => null,
  ContextMenuTrigger: () => null,
  ContextMenuItem: () => null,
}));
vi.mock("@/components/ui/shortcut", () => ({ Shortcut: () => null }));
vi.mock("@/workspace/open-in-file-manager/menu-item", () => ({
  OpenInFileManagerMenuItem: () => null,
}));
vi.mock("@/components/sidebar/workspace-meta-row", () => ({ workspaceServiceLabelKey: vi.fn() }));
vi.mock("@/workspace-labels/picker", () => ({
  useWorkspaceLabelMenuPages: () => [],
  WORKSPACE_LABEL_PAGE_ID: "labels",
}));
vi.mock("@/components/sidebar/workspace-conversations-menu", () => ({
  useWorkspaceConversationMenuPages: () => [],
  WORKSPACE_CONVERSATIONS_PAGE_ID: "conversations",
}));

function agent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    agent: { id, workspaceId: "workspace", labels: {}, createdAt: "2026-01-02", ...overrides },
  };
}

async function copyAgentId() {
  renderToStaticMarkup(
    <SidebarWorkspaceMenu
      workspaceKey="host:workspace"
      serverId="host"
      workspaceId="workspace"
      onArchive={state.archive}
    />,
  );
  await state.items.get("sidebar-workspace-menu-copy-agent-id-host:workspace")!();
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.resetAllMocks();
  state.items.clear();
  state.connected = true;
  state.copy.mockResolvedValue(undefined);
});

describe("copy sidebar conversation Agent ID", () => {
  it("resolves the clicked workspace's active primary across history pages instead of a child or archived agent", async () => {
    state.history
      .mockResolvedValueOnce({
        entries: [
          agent("archived", { archivedAt: "2026-01-03", createdAt: "2025-01-01" }),
          agent("other-workspace", { workspaceId: "other", createdAt: "2025-01-01" }),
          agent("child", {
            createdAt: "2025-01-01",
            labels: { "paseo.parent-agent-id": "primary" },
          }),
        ],
        pageInfo: { hasMore: true, nextCursor: "page-2" },
      })
      .mockResolvedValueOnce({
        entries: [agent("primary", { createdAt: "2026-01-01" }), agent("newer-root")],
        pageInfo: { hasMore: false, nextCursor: null },
      });
    await copyAgentId();
    expect(state.history.mock.calls[1][0].page.cursor).toBe("page-2");
    expect(state.history.mock.calls[0][0].filter.workspaceIds).toEqual(["workspace"]);
    expect(state.copy).toHaveBeenCalledExactlyOnceWith("primary");
    expect(state.copied).toHaveBeenCalledExactlyOnceWith(
      "workspace.tabs.toasts.agentIdCopiedLabel",
    );
  });

  it("copies an archived conversation's ID when no active agent remains", async () => {
    state.history.mockResolvedValueOnce({
      entries: [agent("archived-root", { archivedAt: "2026-01-03" })],
      pageInfo: { hasMore: false },
    });
    await copyAgentId();
    expect(state.copy).toHaveBeenCalledExactlyOnceWith("archived-root");
  });

  it.each(["disconnected", "empty", "clipboard-rejected"])(
    "reports %s without a false success",
    async (failure) => {
      state.connected = failure !== "disconnected";
      state.history.mockResolvedValueOnce({
        entries: failure === "empty" ? [] : [agent("primary")],
        pageInfo: { hasMore: false },
      });
      if (failure === "clipboard-rejected") state.copy.mockRejectedValueOnce(new Error("Denied"));
      await copyAgentId();
      expect(state.error).toHaveBeenCalledExactlyOnceWith("workspace.tabs.toasts.copyFailed");
      expect(state.copied).not.toHaveBeenCalled();
      if (failure !== "clipboard-rejected") expect(state.copy).not.toHaveBeenCalled();
    },
  );
});
