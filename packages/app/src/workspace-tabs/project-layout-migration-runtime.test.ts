import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type {
  FetchAgentHistoryResponseMessage,
  ListTerminalsResponse,
} from "@omp-desktop/protocol/messages";
import {
  collectAllTabs,
  findPaneById,
  createWorkspaceLayoutStore,
  type WorkspaceLayout,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  clearWorkspaceArchivePending,
  markWorkspaceArchivePending,
} from "@/contexts/session-workspace-upserts";
import { mountProjectLayoutMigrationRuntime } from "./project-layout-migration-runtime";
import type { WorkspaceTab } from "./model";
import { resolveWorkspaceTabWorkspaceId } from "./tool-workspace-selection";

const serverId = "migration-runtime-host";
const rawKey = `${serverId}:source`;
const sourceProject = `${serverId}:project:source-project`;
const destinationProject = `${serverId}:project:destination-project`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function tab(tabId: string, target: WorkspaceTab["target"]): WorkspaceTab {
  return { tabId, target, createdAt: 37, state: { cursor: 123 } };
}

function layout(...tabs: WorkspaceTab[]): WorkspaceLayout {
  const pane = {
    id: "pane",
    tabs,
    tabIds: tabs.map((item) => item.tabId),
    focusedTabId: tabs[0]?.tabId ?? null,
  };
  return {
    root: { kind: "pane", pane },
    focusedPaneId: "pane",
  };
}

function tabsAt(key: string): WorkspaceTab[] {
  const value = useWorkspaceLayoutStore.getState().layoutByWorkspace[key];
  return value ? collectAllTabs(value.root) : [];
}

function tabAt(key: string, tabId: string): WorkspaceTab | undefined {
  return tabsAt(key).find((item) => item.tabId === tabId);
}

function historyPage(
  agents: Array<{ id: string; workspaceId: string }>,
  nextCursor: string | null = null,
): FetchAgentHistoryResponseMessage["payload"] {
  return {
    requestId: "history",
    entries: agents.map(({ id, workspaceId }) => ({ agent: { id, workspaceId } })),
    pageInfo: { nextCursor, prevCursor: null, hasMore: nextCursor !== null },
  } as FetchAgentHistoryResponseMessage["payload"];
}

function terminalPage(
  terminals: Array<{ id: string; workspaceId?: string }>,
  cwd?: string,
): ListTerminalsResponse["payload"] {
  return {
    requestId: "terminals",
    ...(cwd ? { cwd } : {}),
    terminals: terminals.map((entry) => ({ name: entry.id, ...entry })),
  };
}

type Client = Pick<DaemonClient, "fetchAgentHistory" | "listTerminals">;
function client(input?: {
  history?: Client["fetchAgentHistory"];
  terminals?: Client["listTerminals"];
}): Client {
  return {
    fetchAgentHistory: input?.history ?? vi.fn(async () => historyPage([])),
    listTerminals: input?.terminals ?? vi.fn(async () => terminalPage([])),
  };
}

function setSession(
  connection: Client,
  input: { hydratedAgents?: boolean; activeAgents?: string[] } = {},
) {
  useSessionStore.getState().initializeSession(serverId, connection as DaemonClient, 1);
  const session = useSessionStore.getState().sessions[serverId];
  useSessionStore.setState({
    sessions: {
      ...useSessionStore.getState().sessions,
      [serverId]: {
        ...session,
        client: connection as DaemonClient,
        hasHydratedWorkspaces: true,
        hasHydratedAgents: input.hydratedAgents ?? true,
        agents: new Map(
          (input.activeAgents ?? []).map((id) => [id, { id, workspaceId: "destination" }]),
        ) as typeof session.agents,
        workspaces: new Map([
          [
            "source",
            {
              id: "source",
              projectId: "source-project",
              workspaceDirectory: "/work/source",
              projectRootPath: "/work",
            },
          ],
          [
            "destination",
            {
              id: "destination",
              projectId: "destination-project",
              workspaceDirectory: "/work/destination",
              projectRootPath: "/work",
            },
          ],
        ]) as Map<string, WorkspaceDescriptor>,
      },
    },
  });
}

let dispose: (() => void) | undefined;
function mount(connection: Client) {
  dispose = mountProjectLayoutMigrationRuntime({ serverId, client: connection });
}

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(async () => {
  await useWorkspaceLayoutStore.persist.rehydrate();
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    sidePanelPaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  useSessionStore.setState({ sessions: {} });
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
  useSessionStore.setState({ sessions: {} });
});

describe("automatic project layout migration runtime", () => {
  it("saves migrated tabs without legacy size metadata and restores them in a new store", async () => {
    const connection = client();
    setSession(connection, { activeAgents: ["already-known"] });
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(
          tab("source-file", { kind: "file", path: "src/index.ts" }),
          tab("agent", { kind: "agent", agentId: "already-known" }),
        ),
      },
    });
    mount(connection);
    await settle();
    const reopened = createWorkspaceLayoutStore();
    await reopened.persist.rehydrate();
    expect(
      reopened
        .getState()
        .getWorkspaceTabs(sourceProject)
        .find((item) => item.tabId === "source-file"),
    ).toMatchObject({
      target: { kind: "file", path: "src/index.ts", workspaceId: "source" },
      state: { cursor: 123 },
    });
    expect(
      reopened
        .getState()
        .getWorkspaceTabs(destinationProject)
        .find((item) => item.tabId === "agent"),
    ).toMatchObject({
      target: { kind: "agent", workspaceId: "destination" },
      state: { cursor: 123 },
    });
  });

  it("uses active ownership without requesting archived history or terminals when no terminal is pending", async () => {
    const connection = client();
    setSession(connection, { activeAgents: ["already-known"] });
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(
          tab("agent", { kind: "agent", agentId: "already-known" }),
          tab("source-draft", { kind: "draft", draftId: "draft" }),
        ),
      },
    });
    mount(connection);
    expect(tabAt(destinationProject, "agent")).toMatchObject({
      target: { workspaceId: "destination" },
      state: { cursor: 123 },
    });
    expect(tabAt(sourceProject, "source-draft")).toMatchObject({
      target: { workspaceId: "source" },
      state: { cursor: 123 },
    });
    expect(connection.fetchAgentHistory).not.toHaveBeenCalled();
    expect(connection.listTerminals).not.toHaveBeenCalled();
  });

  it("looks up only pending ownership, pages archived metadata, and preserves newly opened tabs while requests are pending", async () => {
    const first = deferred<FetchAgentHistoryResponseMessage["payload"]>();
    const second = deferred<FetchAgentHistoryResponseMessage["payload"]>();
    const terminals = deferred<ListTerminalsResponse["payload"]>();
    const fetchAgentHistory = vi
      .fn<Client["fetchAgentHistory"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const listTerminals = vi.fn<Client["listTerminals"]>(() => terminals.promise);
    const connection = client({ history: fetchAgentHistory, terminals: listTerminals });
    setSession(connection);
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(
          tab("archived", { kind: "agent", agentId: "archived-agent" }),
          tab("terminal", { kind: "terminal", terminalId: "live-terminal" }),
          tab("source-draft", { kind: "new_tab" }),
        ),
      },
    });
    mount(connection);
    expect(fetchAgentHistory).toHaveBeenCalledTimes(1);
    expect(fetchAgentHistory).toHaveBeenCalledWith({
      filter: { includeArchived: true },
      page: { limit: 200 },
    });
    expect(listTerminals).toHaveBeenCalledTimes(1);
    expect(tabAt(rawKey, "archived")).toMatchObject({ target: { agentId: "archived-agent" } });
    expect(tabAt(rawKey, "terminal")).toMatchObject({ target: { terminalId: "live-terminal" } });
    const existing = useWorkspaceLayoutStore.getState().layoutByWorkspace[rawKey];
    const opened = tab("opened-during-lookup", { kind: "draft", draftId: "fresh" });
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        ...useWorkspaceLayoutStore.getState().layoutByWorkspace,
        [rawKey]: layout(...collectAllTabs(existing.root), opened),
      },
    });
    first.resolve(historyPage([{ id: "unrelated", workspaceId: "source" }], "next-page"));
    await settle();
    expect(fetchAgentHistory).toHaveBeenCalledTimes(2);
    expect(fetchAgentHistory).toHaveBeenLastCalledWith({
      filter: { includeArchived: true },
      page: { limit: 200, cursor: "next-page" },
    });
    second.resolve(historyPage([{ id: "archived-agent", workspaceId: "destination" }]));
    terminals.resolve(terminalPage([{ id: "live-terminal", workspaceId: "destination" }]));
    await settle();
    expect(tabAt(destinationProject, "archived")).toMatchObject({
      target: { workspaceId: "destination" },
      state: { cursor: 123 },
    });
    expect(tabAt(destinationProject, "terminal")).toMatchObject({
      target: { workspaceId: "destination" },
      state: { cursor: 123 },
    });
    expect(tabAt(sourceProject, "source-draft")).toMatchObject({
      target: { workspaceId: "source", kind: "new_tab" },
      state: { cursor: 123 },
    });
    expect(tabAt(sourceProject, "opened-during-lookup")).toMatchObject({
      target: { workspaceId: "source" },
      state: { cursor: 123 },
    });
    expect(useSessionStore.getState().sessions[serverId].agents.has("archived-agent")).toBe(false);
  });

  it("waits for workspace and agent readiness before fetching archived ownership", async () => {
    const fetchAgentHistory = vi.fn<Client["fetchAgentHistory"]>(async () =>
      historyPage([{ id: "archived-agent", workspaceId: "destination" }]),
    );
    const connection = client({ history: fetchAgentHistory });
    setSession(connection, { hydratedAgents: false });
    const initial = useSessionStore.getState().sessions[serverId];
    useSessionStore.setState({
      sessions: {
        ...useSessionStore.getState().sessions,
        [serverId]: { ...initial, hasHydratedWorkspaces: false },
      },
    });
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(tab("agent", { kind: "agent", agentId: "archived-agent" })),
      },
    });
    mount(connection);
    expect(fetchAgentHistory).not.toHaveBeenCalled();
    expect(tabAt(rawKey, "agent")).toBeDefined();
    const session = useSessionStore.getState().sessions[serverId];
    useSessionStore.setState({
      sessions: {
        ...useSessionStore.getState().sessions,
        [serverId]: { ...session, hasHydratedWorkspaces: true },
      },
    });
    expect(fetchAgentHistory).not.toHaveBeenCalled();
    const ready = useSessionStore.getState().sessions[serverId];
    useSessionStore.setState({
      sessions: {
        ...useSessionStore.getState().sessions,
        [serverId]: { ...ready, hasHydratedAgents: true },
      },
    });
    await settle();
    expect(fetchAgentHistory).toHaveBeenCalledTimes(1);
    expect(tabAt(destinationProject, "agent")?.tabId).toBe("agent");
  });

  it("infers an omitted terminal owner only from an unambiguous scoped checkout listing", async () => {
    const listTerminals = vi.fn<Client["listTerminals"]>(async (cwd) =>
      cwd === undefined
        ? terminalPage([{ id: "unscoped" }])
        : terminalPage(cwd === "/work/destination" ? [{ id: "unscoped" }] : [], cwd),
    );
    const connection = client({ terminals: listTerminals });
    setSession(connection);
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(tab("terminal", { kind: "terminal", terminalId: "unscoped" })),
      },
    });
    mount(connection);
    await settle();
    expect(tabAt(destinationProject, "terminal")?.target.workspaceId).toBe("destination");
    expect(listTerminals).toHaveBeenCalledWith("/work/destination", undefined, {
      workspaceId: "destination",
    });
  });

  it("does not treat a failed terminal catalog as deletion and retries on a session transition", async () => {
    const listTerminals = vi
      .fn<Client["listTerminals"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(terminalPage([{ id: "live", workspaceId: "destination" }]));
    const connection = client({ terminals: listTerminals });
    setSession(connection);
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(tab("terminal", { kind: "terminal", terminalId: "live" })),
      },
    });
    mount(connection);
    await settle();
    expect(tabAt(rawKey, "terminal")).toBeDefined();
    expect(listTerminals).toHaveBeenCalledTimes(1);
    const session = useSessionStore.getState().sessions[serverId];
    useSessionStore.setState({
      sessions: {
        ...useSessionStore.getState().sessions,
        [serverId]: { ...session, workspaces: new Map(session.workspaces) },
      },
    });
    await settle();
    expect(listTerminals).toHaveBeenCalledTimes(2);
    expect(tabAt(destinationProject, "terminal")?.target.workspaceId).toBe("destination");
  });

  it("keeps pending tabs after failed lookup and retries on a directory transition", async () => {
    const fetchAgentHistory = vi
      .fn<Client["fetchAgentHistory"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(historyPage([{ id: "archived-agent", workspaceId: "destination" }]));
    const connection = client({ history: fetchAgentHistory });
    setSession(connection);
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(tab("agent", { kind: "agent", agentId: "archived-agent" })),
      },
    });
    mount(connection);
    await settle();
    expect(tabAt(rawKey, "agent")).toBeDefined();
    expect(fetchAgentHistory).toHaveBeenCalledTimes(1);
    const session = useSessionStore.getState().sessions[serverId];
    useSessionStore.setState({
      sessions: {
        ...useSessionStore.getState().sessions,
        [serverId]: { ...session, agentDetails: new Map(session.agentDetails) },
      },
    });
    await settle();
    expect(fetchAgentHistory).toHaveBeenCalledTimes(2);
    expect(tabAt(destinationProject, "agent")?.tabId).toBe("agent");
  });

  it("reconnects pending ownership with a new client without accepting the old client reply", async () => {
    const oldReply = deferred<FetchAgentHistoryResponseMessage["payload"]>();
    const newReply = deferred<FetchAgentHistoryResponseMessage["payload"]>();
    const old = client({ history: vi.fn<Client["fetchAgentHistory"]>(() => oldReply.promise) });
    const next = client({ history: vi.fn<Client["fetchAgentHistory"]>(() => newReply.promise) });
    setSession(old);
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(tab("agent", { kind: "agent", agentId: "archived-agent" })),
      },
    });
    mount(old);
    dispose?.();
    setSession(next);
    mount(next);
    oldReply.resolve(historyPage([]));
    await settle();
    expect(tabAt(rawKey, "agent")).toBeDefined();
    newReply.resolve(historyPage([{ id: "archived-agent", workspaceId: "destination" }]));
    await settle();
    expect(tabAt(destinationProject, "agent")).toMatchObject({
      target: { workspaceId: "destination" },
      state: { cursor: 123 },
    });
  });

  it("does not restore closed tabs from late metadata, and ignores results after disposal", async () => {
    const oldReply = deferred<FetchAgentHistoryResponseMessage["payload"]>();
    const connection = client({
      history: vi.fn<Client["fetchAgentHistory"]>(() => oldReply.promise),
    });
    setSession(connection);
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(tab("closed", { kind: "agent", agentId: "archived-agent" })),
      },
    });
    mount(connection);
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
    oldReply.resolve(historyPage([{ id: "archived-agent", workspaceId: "destination" }]));
    await settle();
    expect(tabAt(rawKey, "closed")).toBeUndefined();
    expect(tabAt(destinationProject, "closed")).toBeUndefined();

    const nextReply = deferred<FetchAgentHistoryResponseMessage["payload"]>();
    const next = client({ history: vi.fn<Client["fetchAgentHistory"]>(() => nextReply.promise) });
    setSession(next);
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(tab("retained", { kind: "agent", agentId: "another-agent" })),
      },
    });
    dispose?.();
    mount(next);
    dispose?.();
    nextReply.resolve(historyPage([{ id: "another-agent", workspaceId: "destination" }]));
    await settle();
    expect(tabAt(rawKey, "retained")).toBeDefined();
    expect(tabAt(destinationProject, "retained")).toBeUndefined();
  });

  it("rechecks a new legacy agent after an earlier complete catalog instead of pruning it", async () => {
    const nextCatalog = deferred<FetchAgentHistoryResponseMessage["payload"]>();
    const fetchAgentHistory = vi
      .fn<Client["fetchAgentHistory"]>()
      .mockResolvedValueOnce(historyPage([]))
      .mockImplementationOnce(() => nextCatalog.promise);
    const connection = client({ history: fetchAgentHistory });
    setSession(connection);
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(tab("old-dead", { kind: "agent", agentId: "deleted" })),
      },
    });
    mount(connection);
    await settle();
    expect(tabAt(rawKey, "old-dead")).toBeUndefined();
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        ...useWorkspaceLayoutStore.getState().layoutByWorkspace,
        [rawKey]: layout(tab("new-live", { kind: "agent", agentId: "created-after-catalog" })),
      },
    });
    expect(fetchAgentHistory).toHaveBeenCalledTimes(2);
    expect(tabAt(rawKey, "new-live")).toBeDefined();
    nextCatalog.resolve(historyPage([{ id: "created-after-catalog", workspaceId: "destination" }]));
    await settle();
    expect(tabAt(destinationProject, "new-live")?.tabId).toBe("new-live");
  });

  it("prunes only proven-dead terminal and agent references after complete catalogs", async () => {
    const connection = client();
    setSession(connection);
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [rawKey]: layout(
          tab("dead-agent", { kind: "agent", agentId: "deleted" }),
          tab("dead-terminal", { kind: "terminal", terminalId: "exited" }),
          tab("draft", { kind: "draft", draftId: "keep" }),
        ),
      },
    });
    mount(connection);
    await settle();
    expect(tabAt(sourceProject, "draft")).toMatchObject({
      target: { workspaceId: "source" },
      state: { cursor: 123 },
    });
    expect(tabAt(rawKey, "dead-agent")).toBeUndefined();
    expect(tabAt(rawKey, "dead-terminal")).toBeUndefined();
    expect(tabAt(sourceProject, "dead-agent")).toBeUndefined();
    expect(tabAt(sourceProject, "dead-terminal")).toBeUndefined();
  });

  it.each(["files", "working_diff"] as const)(
    "recovers restored orphaned %s panels only after authoritative workspace hydration",
    (kind) => {
      const connection = client();
      setSession(connection);
      const session = useSessionStore.getState().sessions[serverId];
      useSessionStore.setState({
        sessions: {
          ...useSessionStore.getState().sessions,
          [serverId]: { ...session, hasHydratedWorkspaces: false },
        },
      });
      const restored = layout(tab("tool", { kind, workspaceId: "removed" }));
      useWorkspaceLayoutStore.setState({
        layoutByWorkspace: { [sourceProject]: restored },
        sidePanelPaneIdByWorkspace: { [sourceProject]: "pane" },
        splitSizesByWorkspace: { [sourceProject]: { split: [0.7, 0.3] } },
      });
      mount(connection);
      expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[sourceProject]).toBe(restored);
      const ready = useSessionStore.getState().sessions[serverId];
      useSessionStore.setState({
        sessions: {
          ...useSessionStore.getState().sessions,
          [serverId]: { ...ready, hasHydratedWorkspaces: true },
        },
      });
      const recovered = tabAt(sourceProject, "tool")!;
      expect(recovered).toEqual({
        tabId: "tool",
        createdAt: 37,
        state: { cursor: 123 },
        target: { kind, workspaceId: "source" },
      });
      // The pane-context resolver now supplies a real descriptor/directory to
      // FileExplorerPane and ChangesSurface instead of the directoryMissing gate.
      const workspaceId = resolveWorkspaceTabWorkspaceId({
        target: recovered.target,
        routeWorkspaceId: "source",
        toolWorkspaceId: "removed",
      });
      expect(
        useSessionStore.getState().sessions[serverId].workspaces.get(workspaceId)
          ?.workspaceDirectory,
      ).toBe("/work/source");
      expect(useWorkspaceLayoutStore.getState().sidePanelPaneIdByWorkspace[sourceProject]).toBe(
        "pane",
      );
      expect(useWorkspaceLayoutStore.getState().splitSizesByWorkspace[sourceProject]).toEqual({
        split: [0.7, 0.3],
      });
      const finalized = useWorkspaceLayoutStore.getState().layoutByWorkspace;
      useSessionStore.setState({
        sessions: {
          ...useSessionStore.getState().sessions,
          [serverId]: {
            ...useSessionStore.getState().sessions[serverId],
            focusedAgentId: "another-conversation",
          },
        },
      });
      expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toBe(finalized);
    },
  );

  it("prefers the focused main checkout behind an orphaned focused side panel", () => {
    const connection = client();
    setSession(connection);
    const session = useSessionStore.getState().sessions[serverId];
    const source = session.workspaces.get("source")!;
    useSessionStore.setState({
      sessions: {
        ...useSessionStore.getState().sessions,
        [serverId]: {
          ...session,
          workspaces: new Map([
            ...session.workspaces,
            ["sibling", { ...source, id: "sibling", workspaceDirectory: "/work/sibling" }],
          ]),
        },
      },
    });
    const main = layout(tab("agent", { kind: "agent", agentId: "a", workspaceId: "sibling" }));
    const tools = layout(
      tab("files", { kind: "files", workspaceId: "removed" }),
      tab("changes", {
        kind: "working_diff",
        workspaceId: "removed",
      }),
    );
    const restored: WorkspaceLayout = {
      root: {
        kind: "group",
        group: {
          id: "split",
          direction: "horizontal",
          sizes: [0.7, 0.3],
          children: [
            main.root,
            { kind: "pane", pane: { ...findPaneById(tools.root, "pane")!, id: "tools" } },
          ],
        },
      },
      focusedPaneId: "tools",
      parentTabIdByTabId: { changes: "agent" },
    };
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: { [sourceProject]: restored } });
    mount(connection);
    expect(tabAt(sourceProject, "files")?.target.workspaceId).toBe("sibling");
    expect(tabAt(sourceProject, "changes")).toEqual({
      ...tab("changes", {
        kind: "working_diff",
        workspaceId: "sibling",
      }),
    });
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[sourceProject]).toMatchObject({
      focusedPaneId: "tools",
      parentTabIdByTabId: { changes: "agent" },
      root: { group: { sizes: [0.7, 0.3] } },
    });
  });

  it("retains valid bound tools, unbound tools and resource-specific owners across focus changes", () => {
    const connection = client();
    setSession(connection);
    const restored = layout(
      tab("files", { kind: "files", workspaceId: "source" }),
      tab("changes", { kind: "working_diff", workspaceId: "source" }),
      tab("unbound", { kind: "files" }),
      tab("file", { kind: "file", path: "/old/checkout/file.ts", workspaceId: "removed" }),
      tab("focused-diff", {
        kind: "working_diff",
        workspaceId: "removed",
        focusPath: "src/main.ts",
      }),
      tab("requested-diff", {
        kind: "working_diff",
        workspaceId: "removed",
        focusRequestId: 0,
      }),
      tab("commit", { kind: "commit_diff", sha: "abc", workspaceId: "removed" }),
      tab("terminal", { kind: "terminal", terminalId: "t", workspaceId: "removed" }),
      tab("foreign-owner", { kind: "working_diff", workspaceId: "destination" }),
    );
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: { [sourceProject]: restored } });
    mount(connection);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[sourceProject]).toBe(restored);
  });

  it("never recovers into another project or host", () => {
    const connection = client();
    setSession(connection);
    const foreignKey = `another-host:project:source-project`;
    const missingKey = `${serverId}:project:deleted-project`;
    const foreign = layout(tab("foreign", { kind: "files", workspaceId: "removed" }));
    const missing = layout(tab("missing", { kind: "working_diff", workspaceId: "removed" }));
    const layouts = { [foreignKey]: foreign, [missingKey]: missing };
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: layouts });
    mount(connection);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace).toBe(layouts);
  });

  it("uses the project's root checkout when no focused tab has a live owner", () => {
    const connection = client();
    setSession(connection);
    const session = useSessionStore.getState().sessions[serverId];
    const source = session.workspaces.get("source")!;
    useSessionStore.setState({
      sessions: {
        ...useSessionStore.getState().sessions,
        [serverId]: {
          ...session,
          workspaces: new Map([
            ...session.workspaces,
            ["root", { ...source, id: "root", workspaceDirectory: source.projectRootPath }],
          ]),
        },
      },
    });
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {
        [sourceProject]: layout(tab("changes", { kind: "working_diff", workspaceId: "removed" })),
      },
    });
    mount(connection);
    expect(tabAt(sourceProject, "changes")?.target.workspaceId).toBe("root");
  });

  it.each([{ workspaceDirectory: "" }, { archivingAt: "2026-11-06T00:00:00Z" }])(
    "does not recover into an unusable sibling %j",
    (patch) => {
      const connection = client();
      setSession(connection);
      const session = useSessionStore.getState().sessions[serverId];
      const source = session.workspaces.get("source")!;
      useSessionStore.setState({
        sessions: {
          ...useSessionStore.getState().sessions,
          [serverId]: {
            ...session,
            workspaces: new Map(session.workspaces).set("source", { ...source, ...patch }),
          },
        },
      });
      const restored = layout(tab("files", { kind: "files", workspaceId: "removed" }));
      useWorkspaceLayoutStore.setState({ layoutByWorkspace: { [sourceProject]: restored } });
      mount(connection);
      expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[sourceProject]).toBe(restored);
    },
  );

  it("preserves tool bindings while an optimistic archive may still roll back", () => {
    const connection = client();
    setSession(connection);
    const archive = { serverId, workspaceId: "removed" };
    markWorkspaceArchivePending(archive);
    try {
      const restored = layout(
        tab("files", { kind: "files", workspaceId: "removed" }),
        tab("changes", { kind: "working_diff", workspaceId: "removed" }),
      );
      useWorkspaceLayoutStore.setState({ layoutByWorkspace: { [sourceProject]: restored } });
      mount(connection);
      expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[sourceProject]).toBe(restored);
    } finally {
      clearWorkspaceArchivePending(archive);
    }
  });
});
