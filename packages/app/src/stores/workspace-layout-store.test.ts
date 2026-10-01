import { beforeEach, describe, expect, it, vi } from "vitest";

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

import AsyncStorage from "@react-native-async-storage/async-storage";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTab } from "@/workspace-tabs/model";
import { defaultChangesState, type ChangesState } from "@/panels/changes/state";
import { defaultFileState, type FileState } from "@/panels/file/state";
import {
  canDismissPaneInLayout,
  collectAllPanes,
  collectAllTabs,
  createWorkspaceLayoutStore,
  createDefaultLayout,
  createWorkspaceLayoutWithSidePanel,
  findPaneById,
  findBottomTerminalPaneId,
  findPaneContainingTab,
  FOCUSED_PANE_PLACEMENT,
  getTreeDepth,
  insertSplit,
  normalizeLayout,
  removePaneFromTree,
  removeTabFromTree,
  stripEphemeralTabsFromLayout,
  type SplitNode,
  type SplitPane,
} from "@/stores/workspace-layout-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-main";

function createDeterministicWorkspaceLayoutIds() {
  let values: string[] = [];
  let fallbackIndex = 0;

  function nextValue(): string {
    const value = values.shift();
    if (value) {
      return value;
    }
    fallbackIndex += 1;
    return `generated-${fallbackIndex}`;
  }

  return {
    useValues: (nextValues: string[]) => {
      values = nextValues.slice();
      fallbackIndex = 0;
    },
    reset: () => {
      values = [];
      fallbackIndex = 0;
    },
    createNodeId: (prefix: "pane" | "group") => `${prefix}_${nextValue()}`,
    createFocusRestorationToken: () => `workspace-focus-${nextValue()}`,
  };
}

const workspaceLayoutIds = createDeterministicWorkspaceLayoutIds();
const workspaceLayoutStore = createWorkspaceLayoutStore(workspaceLayoutIds);

function useWorkspaceLayoutIds(...values: string[]) {
  workspaceLayoutIds.useValues(values);
}

function createTab(tabId: string, target?: WorkspaceTab["target"]): WorkspaceTab {
  return {
    tabId,
    target: target ?? { kind: "draft", draftId: tabId },
    createdAt: 1,
  };
}

function createPane(input: {
  id: string;
  tabIds: string[];
  focusedTabId?: string | null;
  hidden?: boolean;
  targetsByTabId?: Record<string, WorkspaceTab["target"]>;
}): SplitNode {
  const tabs = input.tabIds.map((tabId) => createTab(tabId, input.targetsByTabId?.[tabId]));
  return {
    kind: "pane",
    pane: {
      id: input.id,
      tabIds: input.tabIds,
      focusedTabId: input.focusedTabId ?? input.tabIds[input.tabIds.length - 1] ?? null,
      ...(input.hidden === true ? { hidden: true } : {}),
      tabs,
    } as SplitPane,
  };
}

function createWorkspaceKey(): string {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: SERVER_ID,
    workspaceId: WORKSPACE_ID,
  });
  expect(key).toBeTruthy();
  return key as string;
}

function collectTabIds(root: SplitNode): string[] {
  return collectAllTabs(root).map((tab) => tab.tabId);
}

function collectContentTabs(root: SplitNode): WorkspaceTab[] {
  return collectAllTabs(root).filter((tab) => tab.target.kind !== "new_tab");
}

function contentTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
  return tabs.filter((tab) => tab.target.kind !== "new_tab");
}

function expectGroup(node: SplitNode): Extract<SplitNode, { kind: "group" }> {
  expect(node.kind).toBe("group");
  return node as Extract<SplitNode, { kind: "group" }>;
}

describe("workspace-layout-store helpers", () => {
  it("creates independent random New tabs for the default panes", () => {
    const layout = createWorkspaceLayoutWithSidePanel();
    const tabs = collectAllTabs(layout.root);

    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.target)).toEqual([{ kind: "new_tab" }, { kind: "new_tab" }]);
    expect(new Set(tabs.map((tab) => tab.tabId)).size).toBe(2);
    expect(expectGroup(layout.root).group.sizes).toEqual([0.75, 0.25]);
  });

  it("discards persisted New tabs and restores each empty pane with a fresh identity", async () => {
    const persisted = createWorkspaceLayoutWithSidePanel();
    const persistedIds = new Set(collectAllTabs(persisted.root).map((tab) => tab.tabId));
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: { workspace: persisted },
          splitSizesByWorkspace: {},
          explorerPaneIdByWorkspace: { workspace: "explorer" },
        },
        version: 1,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await restored.persist.rehydrate();

    const restoredTabs = collectAllTabs(restored.getState().layoutByWorkspace.workspace.root);
    expect(restoredTabs).toHaveLength(2);
    expect(new Set(restoredTabs.map((tab) => tab.tabId)).size).toBe(2);
    expect(restoredTabs.every((tab) => !persistedIds.has(tab.tabId))).toBe(true);
  });

  it("restores a draft execution workspace independently from its tab host", async () => {
    const workspaceKey = createWorkspaceKey();
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: {
            [workspaceKey]: {
              root: createPane({
                id: "main",
                tabIds: ["draft-cross-workspace"],
                targetsByTabId: {
                  "draft-cross-workspace": {
                    kind: "draft",
                    draftId: "draft-cross-workspace",
                    workspaceId: "workspace-target",
                  },
                },
              }),
              focusedPaneId: "main",
            },
          },
          splitSizesByWorkspace: {},
          explorerPaneIdByWorkspace: {},
        },
        version: 2,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await restored.persist.rehydrate();

    expect(restored.getState().getWorkspaceTabs(workspaceKey)[0]?.target).toEqual({
      kind: "draft",
      draftId: "draft-cross-workspace",
      workspaceId: "workspace-target",
    });
  });

  it.each([1, 2])(
    "recovers other tabs, panes, focus and workspaces from version %i layouts with browser tabs",
    async (version) => {
      const main = {
        kind: "pane",
        pane: {
          id: "main",
          tabIds: ["agent-a", "browser-a", "draft-a"],
          focusedTabId: "browser-a",
          tabs: [
            createTab("agent-a", { kind: "agent", agentId: "agent-a" }),
            { tabId: "browser-a", target: { kind: "browser", browserId: "old-a" }, createdAt: 1 },
            createTab("draft-a", { kind: "draft", draftId: "draft-a" }),
          ],
        },
      };
      const otherPane = {
        kind: "pane",
        pane: {
          id: "other-pane",
          tabIds: ["browser-b"],
          focusedTabId: "browser-b",
          tabs: [
            { tabId: "browser-b", target: { kind: "browser", browserId: "old-b" }, createdAt: 1 },
          ],
        },
      };
      await AsyncStorage.setItem(
        "workspace-layout-state",
        JSON.stringify({
          state: {
            layoutByWorkspace: {
              first: {
                root: {
                  kind: "group",
                  group: {
                    id: "user-split",
                    direction: "horizontal",
                    children: [main, otherPane],
                    sizes: [0.6, 0.4],
                  },
                },
                focusedPaneId: "main",
                parentTabIdByTabId: {
                  "draft-a": "browser-a",
                  "browser-a": "agent-a",
                },
              },
              second: {
                root: createPane({
                  id: "main",
                  tabIds: ["agent-b"],
                  targetsByTabId: { "agent-b": { kind: "agent", agentId: "agent-b" } },
                }),
                focusedPaneId: "main",
              },
            },
            splitSizesByWorkspace: { first: { "user-split": [0.6, 0.4] } },
          },
          version,
        }),
      );

      const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
      await restored.persist.rehydrate();
      const first = restored.getState().layoutByWorkspace.first;
      const second = restored.getState().layoutByWorkspace.second;
      expect(first.focusedPaneId).toBe("main");
      expect(findPaneById(first.root, "main")?.focusedTabId).toBe("draft-a");
      expect(collectContentTabs(first.root).map((tab) => tab.tabId)).toEqual([
        "agent-a",
        "draft-a",
      ]);
      expect(findPaneById(first.root, "other-pane")).toBeTruthy();
      expect(first.parentTabIdByTabId).toBeUndefined();
      expect(collectContentTabs(second.root).map((tab) => tab.tabId)).toEqual(["agent-b"]);
      expect(restored.getState().splitSizesByWorkspace.first?.["user-split"]).toEqual([0.6, 0.4]);
    },
  );

  it("survives closing the draft created while repairing a hidden-only layout", async () => {
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: {
            workspace: {
              root: createPane({ id: "explorer", tabIds: [], hidden: true }),
              focusedPaneId: "explorer",
            },
          },
          splitSizesByWorkspace: {},
          explorerPaneIdByWorkspace: { workspace: "explorer" },
        },
        version: 2,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await restored.persist.rehydrate();

    const emptySnapshot = {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      knownTerminalIds: [],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    };
    restored.getState().reconcileTabs("workspace", emptySnapshot);

    let layout = restored.getState().layoutByWorkspace.workspace;
    const visiblePanes = collectAllPanes(layout.root);
    expect(visiblePanes).toHaveLength(1);
    expect(visiblePanes[0]?.id).not.toBe("explorer");
    expect(findPaneById(layout.root, "explorer")?.hidden).toBe(true);
    expect(collectContentTabs(layout.root).map((tab) => tab.target.kind)).toEqual(["draft"]);

    const draftTabId = collectContentTabs(layout.root)[0]?.tabId;
    expect(draftTabId).toBeTruthy();
    restored.getState().closeTab("workspace", draftTabId as string);
    restored.getState().reconcileTabs("workspace", emptySnapshot);

    layout = restored.getState().layoutByWorkspace.workspace;
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([visiblePanes[0]?.id]);
    expect(findPaneById(layout.root, "explorer")?.hidden).toBe(true);
    expect(collectContentTabs(layout.root).map((tab) => tab.target.kind)).toEqual(["draft"]);
  });

  it("narrows the former half-width side panel when restoring version 1 layouts", async () => {
    const persisted = createWorkspaceLayoutWithSidePanel();
    expectGroup(persisted.root).group.sizes = [0.5, 0.5];
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: { workspace: persisted },
          splitSizesByWorkspace: {},
          explorerPaneIdByWorkspace: { workspace: "explorer" },
        },
        version: 1,
      }),
    );

    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await restored.persist.rehydrate();

    const restoredLayout = restored.getState().layoutByWorkspace.workspace;
    expect(expectGroup(restoredLayout.root).group.sizes).toEqual([0.75, 0.25]);
  });

  it("finds panes and tabs across nested groups", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.4, 0.6],
        children: [
          createPane({ id: "left", tabIds: ["tab-a", "tab-b"], focusedTabId: "tab-a" }),
          {
            kind: "group",
            group: {
              id: "group-right",
              direction: "vertical",
              sizes: [0.5, 0.5],
              children: [
                createPane({ id: "top-right", tabIds: ["tab-c"] }),
                createPane({ id: "bottom-right", tabIds: ["tab-d"] }),
              ],
            },
          },
        ],
      },
    };

    expect(findPaneById(root, "top-right")?.tabIds).toEqual(["tab-c"]);
    expect(findPaneContainingTab(root, "tab-b")?.id).toBe("left");
    expect(getTreeDepth(root)).toBe(3);
    expect(collectAllPanes(root).map((pane) => pane.id)).toEqual([
      "left",
      "top-right",
      "bottom-right",
    ]);
    expect(collectAllTabs(root).map((tab) => tab.tabId)).toEqual([
      "tab-a",
      "tab-b",
      "tab-c",
      "tab-d",
    ]);
  });

  it("keeps tabs in hidden panes while excluding those panes from focus helpers", () => {
    const root = createPane({ id: "hidden", tabIds: ["tab-a"], hidden: true });

    expect(collectAllTabs(root).map((tab) => tab.tabId)).toEqual(["tab-a"]);
    expect(collectAllPanes(root)).toEqual([]);
  });
});

describe("workspace-layout-store tree transforms", () => {
  beforeEach(() => {
    workspaceLayoutIds.reset();
  });

  it("insertSplit adds root-level same-direction splits as a flat sibling", () => {
    useWorkspaceLayoutIds("11111111-1111-1111-1111-111111111111");

    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.25, 0.75],
        children: [
          createPane({ id: "left", tabIds: ["tab-a"] }),
          createPane({ id: "right", tabIds: ["tab-b", "tab-c"] }),
        ],
      },
    };

    const nextRoot = insertSplit(root, "right", "tab-c", "right", workspaceLayoutIds.createNodeId);
    const nextGroup = expectGroup(nextRoot);

    expect(nextGroup.group.id).toBe("group-root");
    expect(nextGroup.group.direction).toBe("horizontal");
    expect(nextGroup.group.children).toHaveLength(3);
    expect(nextGroup.group.sizes).toEqual([0.25, 0.375, 0.375]);
    expect(getTreeDepth(nextRoot)).toBe(getTreeDepth(root));
    expect(collectAllPanes(nextRoot).map((pane) => pane.id)).toEqual([
      "left",
      "right",
      "pane_11111111-1111-1111-1111-111111111111",
    ]);
    expect(findPaneById(nextRoot, "right")?.tabIds).toEqual(["tab-b"]);
    expect(findPaneById(nextRoot, "pane_11111111-1111-1111-1111-111111111111")?.tabIds).toEqual([
      "tab-c",
    ]);
  });

  /**
   * The renderer keys panes by id and reconciles them positionally, so a pane that changes render
   * path is unmounted and rebuilt — the composer, terminal, and scroll state in it are lost. A
   * same-direction split has no reason to move anything: it appends a sibling into the group that
   * is already running in that direction. Perpendicular splits are excluded because nesting is the
   * only way to change axis.
   */
  describe("same-direction splits never move an existing pane", () => {
    function panePathsById(root: SplitNode, path: string[] = []): Map<string, string> {
      if (root.kind === "pane") {
        return new Map([[root.pane.id, path.join("/")]]);
      }
      const paths = new Map<string, string>();
      for (const child of root.group.children) {
        const childKey = child.kind === "pane" ? child.pane.id : child.group.id;
        for (const [paneId, childPath] of panePathsById(child, [...path, childKey])) {
          paths.set(paneId, childPath);
        }
      }
      return paths;
    }

    function withPaneTabs(root: SplitNode, paneId: string, tabIds: string[]): SplitNode {
      if (root.kind === "pane") {
        return root.pane.id === paneId ? createPane({ id: paneId, tabIds }) : root;
      }
      return {
        kind: "group",
        group: {
          ...root.group,
          children: root.group.children.map((child) => withPaneTabs(child, paneId, tabIds)),
        },
      };
    }

    function expectExistingPanesUnmoved(before: SplitNode, after: SplitNode) {
      const beforePaths = panePathsById(before);
      const afterPaths = panePathsById(after);
      for (const [paneId, panePath] of beforePaths) {
        expect(afterPaths.get(paneId)).toBe(panePath);
      }
      expect(getTreeDepth(after)).toBe(getTreeDepth(before));
    }

    for (const position of ["left", "right"] as const) {
      it(`keeps every pane in place when a tab is dragged ${position} from the default layout`, () => {
        workspaceLayoutIds.reset();
        const mainPaneId = collectAllPanes(createWorkspaceLayoutWithSidePanel().root)[0]?.id;
        expect(mainPaneId).toBeTruthy();
        const root = withPaneTabs(createWorkspaceLayoutWithSidePanel().root, mainPaneId as string, [
          "tab-a",
          "tab-b",
        ]);

        const nextRoot = insertSplit(
          root,
          mainPaneId as string,
          "tab-a",
          position,
          workspaceLayoutIds.createNodeId,
        );

        expectExistingPanesUnmoved(root, nextRoot);
      });
    }

    it("keeps every pane in place when splitPaneEmpty opens the first split pane", () => {
      workspaceLayoutIds.reset();
      const workspaceKey = createWorkspaceKey();
      const store = workspaceLayoutStore.getState();
      const before = createWorkspaceLayoutWithSidePanel();
      const mainPaneId = collectAllPanes(before.root)[0]?.id;
      expect(mainPaneId).toBeTruthy();

      const newPaneId = store.splitPaneEmpty(workspaceKey, {
        targetPaneId: mainPaneId as string,
        position: "right",
      });

      expect(newPaneId).not.toBeNull();
      const after = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
      expectExistingPanesUnmoved(before.root, after.root);
    });
  });

  it("removePaneFromTree unwraps single-child groups and renormalizes siblings", () => {
    const root: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.2, 0.8],
        children: [
          createPane({ id: "left", tabIds: ["tab-a"] }),
          {
            kind: "group",
            group: {
              id: "group-right",
              direction: "vertical",
              sizes: [0.5, 0.5],
              children: [
                createPane({ id: "top-right", tabIds: ["tab-b"] }),
                createPane({ id: "bottom-right", tabIds: ["tab-c"] }),
              ],
            },
          },
        ],
      },
    };

    const nextRoot = removePaneFromTree(root, "top-right");
    const nextGroup = expectGroup(nextRoot);

    expect(nextGroup.group.sizes).toEqual([0.2, 0.8]);
    expect(collectAllPanes(nextRoot).map((pane) => pane.id)).toEqual(["left", "bottom-right"]);
    expect(nextGroup.group.children[1]).toEqual(
      createPane({ id: "bottom-right", tabIds: ["tab-c"] }),
    );
  });

  it("removeTabFromTree collapses empty panes but keeps the final root pane", () => {
    const splitRoot: SplitNode = {
      kind: "group",
      group: {
        id: "group-root",
        direction: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          createPane({ id: "left", tabIds: ["tab-a"] }),
          createPane({ id: "right", tabIds: ["tab-b"] }),
        ],
      },
    };

    const collapsed = removeTabFromTree(splitRoot, "tab-a");
    expect(collapsed).toEqual(createPane({ id: "right", tabIds: ["tab-b"] }));

    const singlePaneRoot = createPane({ id: "main", tabIds: ["tab-a"] });
    const emptied = removeTabFromTree(singlePaneRoot, "tab-a");
    expect(collectAllTabs(emptied)).toHaveLength(1);
    expect(collectAllTabs(emptied)[0]?.target).toEqual({ kind: "new_tab" });
  });
});

describe("workspace-layout-store actions", () => {
  it("creates duplicate Changes instances while reveal keeps the first instance", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const first = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "new",
    });
    const second = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "new",
    });

    expect(first).not.toBe(second);
    expect(
      collectAllTabs(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).filter(
        (tab) => tab.target.kind === "working_diff",
      ),
    ).toHaveLength(2);

    expect(
      store.openTab({
        workspaceKey: workspaceKey,
        target: { kind: "working_diff" },
        intent: "reveal",
      }),
    ).toBe(first);
  });

  it("creates duplicate Pull request instances explicitly", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const first = store.openTab({ workspaceKey, target: { kind: "pull_request" }, intent: "new" });
    const second = store.openTab({ workspaceKey, target: { kind: "pull_request" }, intent: "new" });
    expect(first).not.toBe(second);
    expect(
      collectAllTabs(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).filter(
        (tab) => tab.target.kind === "pull_request",
      ),
    ).toHaveLength(2);
  });

  it("preserves same-kind state, clears cross-kind state, and accepts an explicit override", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const file = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "new",
    })!;
    const fileState: FileState = { treeVisible: true, treeWidth: 240 };
    store.setTabState(workspaceKey, file, fileState);
    const sameKind = store.replaceTab(workspaceKey, file, { kind: "file", path: "/repo/b.ts" });
    expect(sameKind).toBe(file);
    expect(
      collectAllTabs(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).find(
        (tab) => tab.tabId === sameKind,
      )?.state,
    ).toEqual(fileState);
    const crossKind = store.replaceTab(workspaceKey, sameKind!, { kind: "working_diff" });
    expect(
      collectAllTabs(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).find(
        (tab) => tab.tabId === crossKind,
      )?.state,
    ).toBeUndefined();
    const override: ChangesState = { ...defaultChangesState, wrapLines: true };
    const overridden = store.replaceTab(
      workspaceKey,
      crossKind!,
      { kind: "working_diff" },
      override,
    );
    expect(
      collectAllTabs(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).find(
        (tab) => tab.tabId === overridden,
      )?.state,
    ).toEqual(override);
  });

  it("keeps every Changes presentation field independent across explicit instances", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const first = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "new",
    })!;
    const second = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "new",
    })!;
    const changed: ChangesState = {
      layout: "split" as const,
      wrapLines: true,
      hideWhitespace: true,
      treeVisible: true,
      treeWidth: 320,
      collapsedFilePaths: ["a.ts"],
      collapsedFolderPaths: ["src"],
      commitsCollapsed: false,
    };
    store.setTabState(workspaceKey, first, changed);
    const tabs = collectAllTabs(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
    );
    expect(tabs.find((tab) => tab.tabId === first)?.state).toEqual(changed);
    expect(tabs.find((tab) => tab.tabId === second)?.state).toEqual(undefined);
  });

  it("restores a revealed file's parent after local replacement", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const parent = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "parent" },
      intent: "new",
    })!;
    const file = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts", lineStart: 1 },
      intent: "new",
    })!;
    store.setTabState(workspaceKey, file, {
      treeVisible: true,
      treeWidth: 300,
    });
    expect(
      store.openTab({
        workspaceKey: workspaceKey,
        target: { kind: "file", path: "/repo/a.ts", lineStart: 9 },
        intent: "reveal",
        placement: undefined,
        parentTabId: parent,
      }),
    ).toBe(file);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === file)).toMatchObject({
      target: { path: "/repo/a.ts", lineStart: 9 },
      state: { ...defaultFileState, treeVisible: true, treeWidth: 300 },
    });
    expect(layout.parentTabIdByTabId?.[file]).toBe(parent);

    const replacement = store.replaceTab(
      workspaceKey,
      file,
      { kind: "file", path: "/repo/b.ts" },
      { ...defaultFileState, treeVisible: true, treeWidth: 300 },
    );
    expect(replacement).toBe(file);
    const replacedLayout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(replacedLayout.parentTabIdByTabId?.[file]).toBe(parent);

    store.closeTab(workspaceKey, replacement as string);
    expect(
      findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, "main")
        ?.focusedTabId,
    ).toBe(parent);
  });

  it("keeps existing child edges attached to a replacement tab", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const replaced = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "files" },
      intent: "new",
    })!;
    const child = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "reveal",
      parentTabId: replaced,
    })!;
    const unrelatedParent = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "unrelated" },
      intent: "new",
    })!;
    const unrelatedChild = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/unrelated.ts" },
      intent: "reveal",
      parentTabId: unrelatedParent,
    })!;

    const replacement = store.replaceTab(
      workspaceKey,
      replaced,
      { kind: "file", path: "/repo/b.ts" },
      { ...defaultFileState, treeVisible: true },
    )!;
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(layout.parentTabIdByTabId?.[child]).toBe(replacement);
    expect(layout.parentTabIdByTabId?.[unrelatedChild]).toBe(unrelatedParent);
    expect(Object.entries(layout.parentTabIdByTabId ?? {}).flat()).not.toContain(replaced);

    store.focusTab(workspaceKey, child);
    store.closeTab(workspaceKey, child);
    expect(
      findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, "main")
        ?.focusedTabId,
    ).toBe(replacement);
  });

  it("reveals provider children through the child capability in a compact pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const parent = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "parent" },
      intent: "new",
    })!;
    const target = {
      kind: "provider_subagent" as const,
      parentAgentId: "parent",
      subagentId: "provider-child",
    };
    const compactPanePlacement = { mode: "pane" as const, paneId: "main" };

    const child = store.openTab({
      workspaceKey: workspaceKey,
      target: target,
      intent: "reveal",
      parentTabId: parent,
      placement: compactPanePlacement,
    })!;
    expect(
      store.openTab({
        workspaceKey: workspaceKey,
        target: target,
        intent: "reveal",
        parentTabId: parent,
        placement: compactPanePlacement,
      }),
    ).toBe(child);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, child)?.id).toBe("main");
    expect(layout.parentTabIdByTabId?.[child]).toBe(parent);

    store.closeTab(workspaceKey, child);
    expect(
      findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, "main")
        ?.focusedTabId,
    ).toBe(parent);
  });

  it("replaces only the supplied file slot and carries its state", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const preserved = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "new",
    });
    const local = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/b.ts" },
      intent: "new",
    });

    const replacement = store.replaceTab(
      workspaceKey,
      local as string,
      { kind: "file", path: "/repo/a.ts" },
      { ...defaultFileState, treeVisible: true, treeWidth: 280 },
    );

    const tabs = collectAllTabs(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
    );
    expect(replacement).not.toBe(preserved);
    expect(tabs.find((tab) => tab.tabId === preserved)?.target).toEqual({
      kind: "file",
      path: "/repo/a.ts",
    });
    expect(tabs.find((tab) => tab.tabId === replacement)?.state).toEqual({
      ...defaultFileState,
      treeVisible: true,
      treeWidth: 280,
    });
  });
  beforeEach(() => {
    workspaceLayoutIds.reset();
    workspaceLayoutStore.setState({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      pinnedAgentIdsByWorkspace: {},
      hiddenAgentIdsByWorkspace: {},
      focusRestorationByWorkspace: {},
      sidePanelPaneIdByWorkspace: {},
    });
  });

  it("replaces a pane's sole New tab when real content opens", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const initialLayout = createWorkspaceLayoutWithSidePanel();
    workspaceLayoutStore.setState({ layoutByWorkspace: { [workspaceKey]: initialLayout } });
    const initialMainTabId = findPaneById(initialLayout.root, "main")?.focusedTabId;

    const agentTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "background",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([agentTabId]);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(agentTabId);
    expect(collectTabIds(layout.root)).not.toContain(initialMainTabId);
  });

  it("creates a dedicated bottom pane containing only the terminal", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    workspaceLayoutStore.setState({
      layoutByWorkspace: { [workspaceKey]: createWorkspaceLayoutWithSidePanel() },
    });
    useWorkspaceLayoutIds("bottom-pane", "bottom-group");

    const terminalTabId = store.openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "terminal-below" },
      intent: "reveal",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const paneId = findPaneContainingTab(layout.root, terminalTabId!)?.id;
    expect(paneId).toBe("pane_bottom-pane");
    expect(findPaneById(layout.root, paneId)?.tabIds).toEqual([terminalTabId]);
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === terminalTabId)?.target).toEqual({
      kind: "terminal",
      terminalId: "terminal-below",
    });
  });

  it("moves a New tab's selected tool to the side panel without changing identity", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const initialLayout = createWorkspaceLayoutWithSidePanel();
    workspaceLayoutStore.setState({ layoutByWorkspace: { [workspaceKey]: initialLayout } });
    const newTabId = findPaneById(initialLayout.root, "main")?.focusedTabId as string;

    const resultTabId = store.replaceTab(workspaceKey, newTabId, { kind: "files" });

    expect(resultTabId).toBe(newTabId);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, newTabId)?.id).toBe("explorer");
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === newTabId)?.target).toEqual({
      kind: "files",
    });
    const mainTabId = findPaneById(layout.root, "main")?.focusedTabId;
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === mainTabId)?.target.kind).toBe(
      "new_tab",
    );
  });

  it("closes a split through its sole New tab and leaves creation after the final one", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    useWorkspaceLayoutIds("new-pane", "new-group");
    const splitPaneId = store.splitPaneEmpty(workspaceKey, {
      targetPaneId: "main",
      position: "right",
    }) as string;
    const splitNewTabId = findPaneById(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
      splitPaneId,
    )?.focusedTabId as string;

    expect(store.closeTab(workspaceKey, splitNewTabId)).toBe("closed");

    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, splitPaneId)).toBeNull();
    store.closeTab(workspaceKey, findPaneById(layout.root, "main")?.focusedTabId as string);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const finalNewTabId = findPaneById(layout.root, "main")?.focusedTabId as string;

    expect(store.closeTab(workspaceKey, finalNewTabId)).toBe("workspace-empty");

    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectTabIds(layout.root)).not.toContain(finalNewTabId);
    expect(findPaneById(layout.root, "main")).not.toBeNull();
    expect(findPaneById(layout.root, "explorer")?.hidden).toBe(true);
  });

  it("keeps another conversation but leaves after the last draft despite an open tool pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const firstDraftId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "first-draft" },
      intent: "new",
    })!;
    const secondDraftId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "second-draft" },
      intent: "new",
    })!;

    expect(store.closeTab(workspaceKey, secondDraftId)).toBe("closed");
    expect(
      collectContentTabs(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).map(
        (tab) => tab.tabId,
      ),
    ).toEqual([firstDraftId]);

    const sidePanelPaneId = store.showSidePanel(workspaceKey)!;
    expect(store.closeTab(workspaceKey, firstDraftId)).toBe("workspace-empty");
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, sidePanelPaneId)?.hidden).not.toBe(true);
    expect(collectTabIds(layout.root)).not.toContain(firstDraftId);
  });

  it.each(["draft", "new_tab"] as const)(
    "leaves an empty %s conversation after opening a terminal or file manager",
    (kind) => {
      for (const target of [
        { kind: "files" } as const,
        { kind: "terminal", terminalId: "terminal-1" } as const,
      ]) {
        const workspaceKey = createWorkspaceKey();
        const store = workspaceLayoutStore.getState();
        const initialLayout = createWorkspaceLayoutWithSidePanel();
        workspaceLayoutStore.setState({ layoutByWorkspace: { [workspaceKey]: initialLayout } });
        const tabId =
          kind === "new_tab"
            ? findPaneById(initialLayout.root, "main")!.focusedTabId!
            : store.openTab({
                workspaceKey,
                target: { kind, draftId: "empty-draft" },
                intent: "new",
              })!;
        store.openTab({ workspaceKey, target, intent: "reveal" });

        expect(store.closeTab(workspaceKey, tabId)).toBe("workspace-empty");
        expect(store.getWorkspaceTabs(workspaceKey).some((tab) => tab.tabId === tabId)).toBe(false);
      }
    },
  );

  it("migrates legacy layouts to include the hidden registered explorer pane", async () => {
    const legacyLayout = createDefaultLayout();
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: { layoutByWorkspace: { legacy: legacyLayout } },
        version: 1,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    const state = restored.getState();
    const layout = state.layoutByWorkspace.legacy;
    const sidePanelPaneId = state.sidePanelPaneIdByWorkspace.legacy;
    expect(findPaneById(layout.root, "main")).toBeTruthy();
    expect(sidePanelPaneId).toBeTruthy();
    expect(findPaneById(layout.root, sidePanelPaneId)?.hidden).toBe(true);
    expect(restored.getState().splitSizesByWorkspace).toEqual({});
    await expect(AsyncStorage.getItem("workspace-layout-state")).resolves.not.toBeNull();
  });

  it("migrates a legacy focused Changes tab into a main-pane document identity", async () => {
    const legacyLayout = {
      root: {
        kind: "group" as const,
        group: {
          id: "workspace-root",
          direction: "horizontal" as const,
          sizes: [0.5, 0.5],
          children: [
            createPane({
              id: "main",
              tabIds: ["agent_one"],
              targetsByTabId: {
                agent_one: { kind: "agent", agentId: "one" },
              },
            }),
            createPane({
              id: "explorer",
              tabIds: ["working_diff"],
              focusedTabId: "working_diff",
              hidden: true,
              targetsByTabId: {
                working_diff: {
                  kind: "working_diff",
                  focusPath: "src/example.ts",
                  focusRequestId: 1,
                },
              },
            }),
          ],
        },
      },
      focusedPaneId: "main",
    };
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: { legacy: legacyLayout },
          explorerPaneIdByWorkspace: { legacy: "explorer" },
        },
        version: 1,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    const layout = restored.getState().layoutByWorkspace.legacy;
    const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
    expect(findPaneContainingTab(layout.root, "working_diff_document")?.id).toBe("main");
    expect(tabsById.get("working_diff_document")?.target).toEqual({
      kind: "working_diff",
      focusPath: "src/example.ts",
      focusRequestId: 1,
    });
    expect(
      findPaneById(layout.root, "explorer")?.tabIds.map(
        (tabId) => tabsById.get(tabId)?.target.kind,
      ),
    ).toEqual(["new_tab"]);
  });

  it("restores a layout saved before the Side panel rename, PR bookkeeping and all", async () => {
    const savedLayout = createWorkspaceLayoutWithSidePanel();
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: { renamed: savedLayout },
          explorerPaneIdByWorkspace: { renamed: "explorer" },
          acknowledgedPullRequestByWorkspace: { renamed: "url:https://example.test/pulls/1" },
        },
        version: 1,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    const state = restored.getState();
    expect(state.layoutByWorkspace.renamed).toBeTruthy();
    expect(state.sidePanelPaneIdByWorkspace.renamed).toBe("explorer");
  });

  it("persists first-class pane targets, visibility, and focus", async () => {
    await AsyncStorage.removeItem("workspace-layout-state");
    const workspaceKey = createWorkspaceKey();
    const source = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await source.persist.rehydrate();

    source.getState().openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const focusedAgentTabId = source.getState().openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-2" },
      intent: "reveal",
    });
    const sidePanelPaneId = source.getState().showSidePanel(workspaceKey);
    expect(sidePanelPaneId).toBeTruthy();
    source
      .getState()
      .openTab({ workspaceKey: workspaceKey, target: { kind: "files" }, intent: "reveal" });
    source.getState().openTab({
      workspaceKey: workspaceKey,
      target: { kind: "pull_request" },
      intent: "background",
      placement: { mode: "prefer", paneId: sidePanelPaneId as string },
    });
    source.getState().hideSidePanel(workspaceKey);

    await vi.waitFor(async () => {
      expect(await AsyncStorage.getItem("workspace-layout-state")).not.toBeNull();
    });

    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await restored.persist.rehydrate();
    const state = restored.getState();
    const layout = state.layoutByWorkspace[workspaceKey];

    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(focusedAgentTabId);
    expect(findPaneById(layout.root, sidePanelPaneId)?.hidden).toBe(true);
    expect(collectAllTabs(layout.root).map((tab) => tab.target.kind)).toEqual([
      "agent",
      "agent",
      "files",
      "pull_request",
    ]);
    expect(state.sidePanelPaneIdByWorkspace[workspaceKey]).toBe(sidePanelPaneId);
  });

  it("persists and rehydrates independent Changes state through validated storage", async () => {
    await AsyncStorage.removeItem("workspace-layout-state");
    const workspaceKey = createWorkspaceKey();
    const source = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await source.persist.rehydrate();
    const first = source
      .getState()
      .openTab({ workspaceKey: workspaceKey, target: { kind: "working_diff" }, intent: "new" })!;
    const second = source
      .getState()
      .openTab({ workspaceKey: workspaceKey, target: { kind: "working_diff" }, intent: "new" })!;
    const firstState: ChangesState = {
      layout: "split" as const,
      wrapLines: true,
      hideWhitespace: true,
      treeVisible: true,
      treeWidth: 320,
      collapsedFilePaths: ["src/a.ts"],
      collapsedFolderPaths: ["src"],
      commitsCollapsed: false,
    };
    const secondState: ChangesState = {
      layout: "unified" as const,
      wrapLines: false,
      hideWhitespace: false,
      treeVisible: false,
      collapsedFilePaths: ["README.md"],
      collapsedFolderPaths: ["docs"],
      commitsCollapsed: true,
    };
    source.getState().setTabState(workspaceKey, first, firstState);
    source.getState().setTabState(workspaceKey, second, secondState);

    await vi.waitFor(async () => {
      const persisted = await AsyncStorage.getItem("workspace-layout-state");
      expect(persisted).not.toBeNull();
      const root = JSON.parse(persisted ?? "{}").state.layoutByWorkspace[workspaceKey].root;
      expect(collectTabIds(root)).toEqual([first, second]);
    });

    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());
    await restored.persist.rehydrate();
    const tabs = collectAllTabs(restored.getState().layoutByWorkspace[workspaceKey].root);
    expect(tabs.find((tab) => tab.tabId === first)?.state).toEqual(firstState);
    expect(tabs.find((tab) => tab.tabId === second)?.state).toEqual(secondState);
  });

  it("leaves a side-panel background tab in the only other pane instead of emptying it", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const setupTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "setup", workspaceId: WORKSPACE_ID },
      intent: "reveal",
      placement: { mode: "pane", paneId: "main" },
    });

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "setup", workspaceId: WORKSPACE_ID },
      intent: "background",
      placement: { mode: "prefer", paneId: "explorer" },
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, setupTabId as string)?.id).toBe("main");
    expect(findPaneById(layout.root, "main")).toBeTruthy();
    expect(findPaneById(layout.root, "explorer")?.hidden).toBe(true);
    expect(layout.focusedPaneId).toBe("main");
  });

  it("keeps ambient entity tabs out of the side panel after a background tab lands there", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "pull_request" },
      intent: "background",
      placement: { mode: "prefer", paneId: "explorer" },
    });
    store.focusPane(workspaceKey, "explorer");
    const agentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(agentTabId).toBeTruthy();
    expect(findPaneContainingTab(layout.root, agentTabId as string)?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
  });

  it("opens a background terminal in the bottom pane without moving focus", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.focusPane(workspaceKey, "explorer");

    const terminalTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "terminal",
        terminalId: "terminal-1",
      },
      intent: "background",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findBottomTerminalPaneId({ layout, tabs: collectAllTabs(layout.root) })).toBe(
      findPaneContainingTab(layout.root, terminalTabId as string)?.id,
    );
    expect(layout.focusedPaneId).toBe("explorer");
  });

  it("places a background setup tab in the main pane without moving focus", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.focusPane(workspaceKey, "explorer");

    const setupTabId = store.openTab({
      workspaceKey,
      target: { kind: "setup", workspaceId: WORKSPACE_ID },
      intent: "background",
      placement: { mode: "prefer", paneId: "main" },
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, setupTabId as string)?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("explorer");
  });

  it("keeps a failed setup tab out of the focused side panel when main was removed", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    workspaceLayoutStore.setState((state) => ({
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: normalizeLayout({
          root: {
            kind: "group",
            group: {
              id: "root",
              direction: "horizontal",
              sizes: [0.5, 0.5],
              children: [
                createPane({ id: "secondary", tabIds: [] }),
                createPane({ id: "explorer", tabIds: [] }),
              ],
            },
          },
          focusedPaneId: "explorer",
        }),
      },
      sidePanelPaneIdByWorkspace: {
        ...state.sidePanelPaneIdByWorkspace,
        [workspaceKey]: "explorer",
      },
    }));

    const setupTabId = store.openTab({
      workspaceKey,
      target: { kind: "setup", workspaceId: WORKSPACE_ID },
      intent: "background",
      placement: { mode: "prefer", paneId: "main" },
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, setupTabId as string)?.id).toBe("secondary");
    expect(layout.focusedPaneId).toBe("explorer");
  });

  it("keeps ambient draft opens out of the focused explorer pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.focusPane(workspaceKey, "explorer");

    const draftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, draftTabId as string)?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
  });

  it("keeps an explicit explorer placement for content in the main pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });

    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
      placement: { mode: "pane", paneId: "explorer" },
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, draftTabId as string)?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
  });

  it("opens user-created terminals in the bottom pane while the side panel is focused", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.focusPane(workspaceKey, "explorer");

    const terminalTabId = store.openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "terminal-1" },
      intent: "reveal",
      placement: FOCUSED_PANE_PLACEMENT,
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findBottomTerminalPaneId({ layout, tabs: collectAllTabs(layout.root) })).toBe(
      findPaneContainingTab(layout.root, terminalTabId as string)?.id,
    );
    expect(layout.focusedPaneId).toBe(
      findPaneContainingTab(layout.root, terminalTabId as string)?.id,
    );
  });

  it("keeps an existing terminal in its bottom pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const terminalTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "terminal",
        terminalId: "terminal-1",
      },
      intent: "background",
    });
    store.showSidePanel(workspaceKey);

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "terminal", terminalId: "terminal-1" },
      intent: "reveal",
      placement: FOCUSED_PANE_PLACEMENT,
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const terminalPaneId = findPaneContainingTab(layout.root, terminalTabId as string)?.id;
    expect(findBottomTerminalPaneId({ layout, tabs: collectAllTabs(layout.root) })).toBe(
      terminalPaneId,
    );
    expect(findPaneById(layout.root, "main")).toBeTruthy();
    expect(layout.focusedPaneId).toBe(terminalPaneId);
  });

  it("defers terminal reconciliation while a user terminal is being created", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.focusPane(workspaceKey, "explorer");

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      knownTerminalIds: ["terminal-1"],
      standaloneTerminalIds: ["terminal-1"],
      hasActivePendingTerminalCreate: true,
    });

    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, "terminal_terminal-1")).toBeNull();

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      knownTerminalIds: ["terminal-1"],
      standaloneTerminalIds: ["terminal-1"],
    });

    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findBottomTerminalPaneId({ layout, tabs: collectAllTabs(layout.root) })).toBe(
      findPaneContainingTab(layout.root, "terminal_terminal-1")?.id,
    );
  });

  it("keeps non-entity tabs in the focused explorer pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.focusPane(workspaceKey, "explorer");

    const filesTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "files" },
      intent: "reveal",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, filesTabId as string)?.id).toBe("explorer");
  });

  it("prevents dragging an entity tab into the explorer pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const agentTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.showSidePanel(workspaceKey);
    store.moveTabToPane(workspaceKey, agentTabId as string, "explorer");
    store.focusPane(workspaceKey, "main");

    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, agentTabId as string)?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
  });

  it("keeps reconcile auto-opened agents out of the focused explorer pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.focusPane(workspaceKey, "explorer");

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1", "agent-2"],
      autoOpenAgentIds: ["agent-1", "agent-2"],
      knownAgentIds: ["agent-1", "agent-2"],
      standaloneTerminalIds: [],
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, "agent_agent-2")?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("explorer");
  });

  it("repairs a mixed conversation and terminal pane without adding a parallel workspace pane", () => {
    useWorkspaceLayoutIds(
      "terminal-pane",
      "terminal-group",
      "unexpected-workspace-pane",
      "unexpected-workspace-group",
    );
    const workspaceKey = createWorkspaceKey();
    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: normalizeLayout({
          root: {
            kind: "group",
            group: {
              id: "workspace-root",
              direction: "horizontal",
              sizes: [0.75, 0.25],
              children: [
                createPane({
                  id: "main",
                  tabIds: ["agent_agent-1", "terminal_terminal-1"],
                  focusedTabId: "terminal_terminal-1",
                  targetsByTabId: {
                    "agent_agent-1": { kind: "agent", agentId: "agent-1" },
                    "terminal_terminal-1": { kind: "terminal", terminalId: "terminal-1" },
                  },
                }),
                createPane({ id: "explorer", tabIds: [], hidden: true }),
              ],
            },
          },
          focusedPaneId: "main",
        }),
      },
      sidePanelPaneIdByWorkspace: {
        ...state.sidePanelPaneIdByWorkspace,
        [workspaceKey]: "explorer",
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownAgentIds: ["agent-1"],
      knownTerminalIds: ["terminal-1"],
      standaloneTerminalIds: ["terminal-1"],
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([
      "main",
      "pane_terminal-pane",
    ]);
    expect(findPaneContainingTab(layout.root, "agent_agent-1")?.id).toBe("main");
    expect(findPaneContainingTab(layout.root, "terminal_terminal-1")?.id).toBe(
      "pane_terminal-pane",
    );
    expect(findBottomTerminalPaneId({ layout, tabs: collectAllTabs(layout.root) })).toBe(
      "pane_terminal-pane",
    );
  });

  it("keeps two agent conversations in side-by-side center panes through reconciliation", () => {
    useWorkspaceLayoutIds("23232323-2323-2323-2323-232323232323");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const firstTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-2" },
      intent: "reveal",
    });
    const secondPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1", "agent-2"],
      autoOpenAgentIds: ["agent-1", "agent-2"],
      knownAgentIds: ["agent-1", "agent-2"],
      standaloneTerminalIds: [],
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(secondPaneId).toBe("pane_23232323-2323-2323-2323-232323232323");
    expect(findPaneContainingTab(layout.root, firstTabId!)?.id).toBe("main");
    expect(findPaneContainingTab(layout.root, secondTabId!)?.id).toBe(secondPaneId);
  });

  it("creates a center pane when the side panel is the only pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    workspaceLayoutStore.setState((state) => ({
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: normalizeLayout({
          root: createPane({ id: "explorer", tabIds: [] }),
          focusedPaneId: "explorer",
        }),
      },
      sidePanelPaneIdByWorkspace: {
        ...state.sidePanelPaneIdByWorkspace,
        [workspaceKey]: "explorer",
      },
    }));

    const agentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, agentTabId as string)?.id).not.toBe("explorer");
  });

  it("creates setup in the main pane without changing focus", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const agentTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });

    const tabId = store.openTab({
      workspaceKey,
      target: { kind: "setup", workspaceId: WORKSPACE_ID },
      intent: "background",
      placement: { mode: "prefer", paneId: "explorer" },
    });

    const state = workspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    const sidePanelPaneId = state.sidePanelPaneIdByWorkspace[workspaceKey] ?? "explorer";
    expect(tabId).toBe("setup_ws-main");
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, sidePanelPaneId)?.hidden).toBe(true);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(agentTabId);
    expect(findPaneContainingTab(layout.root, tabId!)?.id).toBe("main");
  });

  it("opens assistant files in the main pane while keeping the side panel available", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const paneId = store.showSidePanel(workspaceKey) as string;
    const tabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
      parentTabId: "agent_agent-a",
      placement: { mode: "prefer", paneId },
    });
    const createdState = workspaceLayoutStore.getState();
    const sidePanelPaneId = createdState.sidePanelPaneIdByWorkspace[workspaceKey];

    expect(sidePanelPaneId).toBe("explorer");
    expect(
      findPaneContainingTab(createdState.layoutByWorkspace[workspaceKey].root, tabId!)?.id,
    ).toBe("main");
    expect(collectAllTabs(createdState.layoutByWorkspace[workspaceKey].root)).toContainEqual({
      tabId,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      createdAt: expect.any(Number),
    });

    store.hideSidePanel(workspaceKey);
    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
      placement: { mode: "prefer", paneId: store.showSidePanel(workspaceKey) as string },
    });
    const revealedLayout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(findPaneById(revealedLayout.root, sidePanelPaneId)?.hidden).toBeUndefined();
    expect(findPaneContainingTab(revealedLayout.root, "file_/repo/worktree/b.ts")?.id).toBe("main");
    expect(revealedLayout.focusedPaneId).toBe("main");
  });

  it("keeps a canonical duplicate file tab in the main pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    useWorkspaceLayoutIds("explorer");
    const paneId = store.showSidePanel(workspaceKey) as string;
    const tabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    });
    store.hideSidePanel(workspaceKey);

    store.showSidePanel(workspaceKey);
    const duplicateTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts", lineStart: 12 },
      intent: "reveal",
      parentTabId: "agent_agent-a",
      placement: { mode: "prefer", paneId },
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(duplicateTabId).toBe(tabId);
    expect(collectAllTabs(layout.root).filter((tab) => tab.tabId === tabId)).toHaveLength(1);
    expect(findPaneContainingTab(layout.root, tabId as string)?.id).toBe("main");
    expect(findPaneById(layout.root, paneId)?.hidden).toBeUndefined();
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(tabId);
  });

  it("restores workspace and agent plugin panel targets", async () => {
    const workspaceTarget = {
      kind: "plugin",
      pluginId: "review",
      panelId: "summary",
      context: "workspace",
    };
    const agentTarget = {
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "agent",
      agentId: "agent-1",
    };
    await AsyncStorage.setItem(
      "workspace-layout-state",
      JSON.stringify({
        state: {
          layoutByWorkspace: {
            workspace: {
              root: {
                kind: "pane",
                pane: {
                  id: "main",
                  tabIds: ["workspace-panel", "agent-panel"],
                  focusedTabId: "agent-panel",
                  tabs: [
                    { tabId: "workspace-panel", target: workspaceTarget, createdAt: 1 },
                    { tabId: "agent-panel", target: agentTarget, createdAt: 2 },
                  ],
                },
              },
              focusedPaneId: "main",
            },
          },
          splitSizesByWorkspace: {},
        },
        version: 1,
      }),
    );
    const restored = createWorkspaceLayoutStore(createDeterministicWorkspaceLayoutIds());

    await restored.persist.rehydrate();

    const layout = restored.getState().layoutByWorkspace.workspace;
    expect(layout && collectContentTabs(layout.root).map((tab) => tab.target)).toEqual([
      workspaceTarget,
      agentTarget,
    ]);
  });

  it("opens tabs into the focused pane and focuses duplicate opens instead of creating them", () => {
    useWorkspaceLayoutIds("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    expect(splitPaneId).toBe("pane_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

    store.focusPane(workspaceKey, "main");
    const duplicateTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstTabId).toBe("file_/repo/worktree/a.ts");
    expect(secondTabId).toBe("file_/repo/worktree/b.ts");
    expect(duplicateTabId).toBe(secondTabId);
    expect(layout.focusedPaneId).toBe("pane_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(collectContentTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      "file_/repo/worktree/a.ts",
      "file_/repo/worktree/b.ts",
    ]);
  });

  it("updates an existing file tab when opening the same path at a new line range", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
        lineStart: 5,
      },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
        lineStart: 10,
        lineEnd: 12,
      },
      intent: "reveal",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstTabId).toBe("file_/repo/worktree/a.ts");
    expect(secondTabId).toBe(firstTabId);
    expect(collectContentTabs(layout.root)).toEqual([
      {
        tabId: "file_/repo/worktree/a.ts",
        target: {
          kind: "file",
          path: "/repo/worktree/a.ts",
          lineStart: 10,
          lineEnd: 12,
        },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("openTab background intent inserts a tab without stealing focus", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const agentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const setupTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "setup",
        workspaceId: "ws-main",
      },
      intent: "background",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;

    expect(agentTabId).toBe("agent_agent-1");
    expect(setupTabId).toBe("setup_ws-main");
    expect(pane.tabIds).toEqual([agentTabId, setupTabId]);
    expect(pane.focusedTabId).toBe(agentTabId);
    expect(layout.focusedPaneId).toBe("main");
  });

  it("openTab background intent on an existing target is a no-op", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const duplicateTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "background",
    });
    const layoutAfter = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layoutAfter.root, "main")!;

    expect(duplicateTabId).toBe(firstTabId);
    expect(pane.tabIds).toEqual([firstTabId, secondTabId]);
    expect(pane.focusedTabId).toBe(secondTabId);
  });

  it("closing a focused middle tab selects the tab to its right", () => {
    const workspaceKey = createWorkspaceKey();
    const firstTabId = "draft-1";
    const closedTabId = "draft-2";
    const rightTabId = "draft-3";

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: createPane({
            id: "main",
            tabIds: [firstTabId, closedTabId, rightTabId],
            focusedTabId: closedTabId,
          }),
          focusedPaneId: "main",
        },
      },
    }));

    workspaceLayoutStore.getState().closeTab(workspaceKey, closedTabId);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;

    expect(pane.tabIds).toEqual([firstTabId, rightTabId]);
    expect(pane.focusedTabId).toBe(rightTabId);
  });

  it("closing a focused child tab returns to its parent before using tab-strip order", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const parentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "draft",
        draftId: "draft-parent",
      },
      intent: "reveal",
    });
    const childTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "draft-child" },
      intent: "reveal",
      parentTabId: parentTabId!,
    });
    const rightTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "draft",
        draftId: "draft-right",
      },
      intent: "reveal",
    });
    store.focusTab(workspaceKey, childTabId!);

    workspaceLayoutStore.getState().closeTab(workspaceKey, childTabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;

    expect(pane.tabIds).toEqual([parentTabId, rightTabId]);
    expect(pane.focusedTabId).toBe(parentTabId);
  });

  it("closing a focused last tab selects the tab to its left", () => {
    const workspaceKey = createWorkspaceKey();
    const leftTabId = "draft-1";
    const closedTabId = "draft-2";

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: createPane({
            id: "main",
            tabIds: [leftTabId, closedTabId],
            focusedTabId: closedTabId,
          }),
          focusedPaneId: "main",
        },
      },
    }));

    workspaceLayoutStore.getState().closeTab(workspaceKey, closedTabId);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const pane = findPaneById(layout.root, "main")!;

    expect(pane.tabIds).toEqual([leftTabId]);
    expect(pane.focusedTabId).toBe(leftTabId);
  });

  it("unfocuses and restores the previous focused pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const token = store.unfocusPane(workspaceKey);
    expect(token).toBeTruthy();
    expect(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId,
    ).toBeNull();

    store.restorePaneFocus(workspaceKey, token!);
    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "main",
    );
  });

  it("does not restore stale focus after another pane is focused", () => {
    useWorkspaceLayoutIds("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    store.splitPane(workspaceKey, {
      tabId: firstTabId!,
      targetPaneId: "main",
      position: "right",
    });
    store.focusPane(workspaceKey, "main");

    const token = store.unfocusPane(workspaceKey);
    store.focusPane(workspaceKey, "pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    store.restorePaneFocus(workspaceKey, token!);

    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    );
  });

  it("waits for nested focus restorations before restoring", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const outerToken = store.unfocusPane(workspaceKey);
    const innerToken = store.unfocusPane(workspaceKey);

    store.restorePaneFocus(workspaceKey, outerToken!);
    expect(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId,
    ).toBeNull();

    store.restorePaneFocus(workspaceKey, innerToken!);
    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]?.focusedPaneId).toBe(
      "main",
    );
  });

  it("openTab creates distinct draft tabs for repeated Cmd+T/new-tab opens", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "draft-2" },
      intent: "reveal",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstTabId).toBe("draft-1");
    expect(secondTabId).toBe("draft-2");
    expect(firstTabId).not.toBe(secondTabId);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([firstTabId, secondTabId]);
    expect(collectContentTabs(layout.root)).toEqual([
      {
        tabId: firstTabId,
        target: { kind: "draft", draftId: "draft-1" },
        createdAt: expect.any(Number),
      },
      {
        tabId: secondTabId,
        target: { kind: "draft", draftId: "draft-2" },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("opens a generated draft in the focused center split", () => {
    useWorkspaceLayoutIds("77777777-7777-7777-7777-777777777777");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const newPaneId = store.splitPaneEmpty(workspaceKey, {
      targetPaneId: "main",
      position: "right",
    });
    const draftTabId = store.openTab({
      workspaceKey,
      target: {
        kind: "draft",
        draftId: "draft-split",
      },
      intent: "reveal",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(newPaneId).toBe("pane_77777777-7777-7777-7777-777777777777");
    expect(draftTabId).toBe("draft-split");
    expect(layout.focusedPaneId).toBe(newPaneId);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([fileTabId]);
    expect(findPaneById(layout.root, newPaneId)?.tabIds).toEqual([draftTabId]);
  });

  it("hides and shows the side panel without changing its tabs or split sizes", () => {
    useWorkspaceLayoutIds("88888888-8888-8888-8888-888888888888");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "main-tab" },
      intent: "reveal",
    });
    const paneId = store.showSidePanel(workspaceKey)!;
    store.openTab({
      workspaceKey,
      target: { kind: "working_diff" },
      intent: "reveal",
    });
    const shownLayout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const sideTabIds = findPaneById(shownLayout.root, paneId)?.tabIds;
    const sizes = expectGroup(shownLayout.root).group.sizes;

    store.hideSidePanel(workspaceKey);
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, paneId)).toMatchObject({
      hidden: true,
      tabIds: sideTabIds,
    });
    expect(expectGroup(layout.root).group.sizes).toEqual(sizes);
    expect(layout.focusedPaneId).toBe("main");

    store.showSidePanel(workspaceKey);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, paneId)).toMatchObject({ tabIds: sideTabIds });
    expect(findPaneById(layout.root, paneId)?.hidden).toBeUndefined();
    expect(expectGroup(layout.root).group.sizes).toEqual(sizes);
  });

  it("focusTab moves workspace focus to the pane containing the tab", () => {
    useWorkspaceLayoutIds("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const fileTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "reveal",
    });
    const terminalTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "terminal",
        terminalId: "term-1",
      },
      intent: "reveal",
    });
    const terminalPaneId = findPaneContainingTab(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
      terminalTabId!,
    )?.id;

    store.focusTab(workspaceKey, fileTabId!);
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout.focusedPaneId).toBe("main");

    store.focusTab(workspaceKey, terminalTabId!);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;
    expect(terminalPaneId).toBe("pane_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(layout.focusedPaneId).toBe(terminalPaneId);
    expect(findPaneById(layout.root, terminalPaneId)?.focusedTabId).toBe(terminalTabId);
  });

  it("focusTab reveals a hidden tool pane and focuses its requested tab without changing sizes", () => {
    useWorkspaceLayoutIds("89898989-8989-8989-8989-898989898989");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const paneId = store.showSidePanel(workspaceKey)!;
    const targetTabId = store.openTab({
      workspaceKey,
      target: { kind: "working_diff" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    })!;
    store.focusPane(workspaceKey, "main");
    const group = expectGroup(
      workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
    ).group;
    store.resizeSplit(workspaceKey, group.id, [0.7, 0.3]);
    store.hideSidePanel(workspaceKey);
    const splitSizes = workspaceLayoutStore.getState().splitSizesByWorkspace[workspaceKey];

    store.focusTab(workspaceKey, targetTabId);

    const state = workspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
    const sidePane = findPaneById(layout.root, paneId);
    expect(layout.focusedPaneId).toBe(paneId);
    expect(sidePane?.focusedTabId).toBe(targetTabId);
    expect(sidePane?.tabIds.map((tabId) => tabsById.get(tabId)?.target.kind)).toEqual([
      "files",
      "working_diff",
    ]);
    expect(sidePane?.hidden).toBeUndefined();
    expect(expectGroup(layout.root).group.sizes).toEqual(group.sizes);
    expect(state.splitSizesByWorkspace[workspaceKey]).toBe(splitSizes);
  });

  it("convertDraftToAgent keeps the conversation in its center split", () => {
    useWorkspaceLayoutIds("12121212-1212-1212-1212-121212121212");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "draft-2" },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    const nextTabId = store.convertDraftToAgent(workspaceKey, secondTabId!, "agent-1");
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const convertedTab = collectAllTabs(layout.root).find((tab) => tab.tabId === nextTabId);

    expect(splitPaneId).toBe("pane_12121212-1212-1212-1212-121212121212");
    expect(nextTabId).toBe("agent_agent-1");
    expect(findPaneContainingTab(layout.root, "agent_agent-1")?.id).toBe(splitPaneId);
    expect(findPaneById(layout.root, splitPaneId)).toBeTruthy();
    expect(convertedTab).toEqual({
      tabId: "agent_agent-1",
      target: { kind: "agent", agentId: "agent-1" },
      createdAt: expect.any(Number),
    });
  });

  it("replaceTab routes a terminal replacement into the bottom pane", () => {
    useWorkspaceLayoutIds("terminal-bottom", "terminal-group");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const draftTabId = store.openTab({
      workspaceKey,
      target: { kind: "draft", draftId: "draft-terminal" },
      intent: "reveal",
    });

    const terminalTabId = store.replaceTab(workspaceKey, draftTabId!, {
      kind: "terminal",
      terminalId: "terminal-1",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const terminalPaneId = findPaneContainingTab(layout.root, terminalTabId!)?.id;
    const mainPane = findPaneById(layout.root, "main");
    const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));

    expect(terminalPaneId).toBe("pane_terminal-bottom");
    expect(findBottomTerminalPaneId({ layout, tabs: collectAllTabs(layout.root) })).toBe(
      terminalPaneId,
    );
    expect(mainPane?.tabIds).toHaveLength(1);
    expect(tabsById.get(mainPane?.tabIds[0] ?? "")?.target.kind).toBe("new_tab");
  });

  it("replaceTab keeps a draft tab in place while updating its target", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "draft",
        draftId: "draft-retarget",
      },
      intent: "reveal",
    });
    const nextTabId = store.replaceTab(workspaceKey, draftTabId!, {
      kind: "file",
      path: "/repo/worktree/retargeted.ts",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(draftTabId).toBe("draft-retarget");
    expect(nextTabId).toBe(draftTabId);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([draftTabId!]);
    expect(collectContentTabs(layout.root)).toEqual([
      {
        tabId: draftTabId!,
        target: { kind: "file", path: "/repo/worktree/retargeted.ts" },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("replaceTab gives a non-draft tab the new target identity", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const agentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "agent",
        agentId: "agent-retarget",
      },
      intent: "reveal",
    });
    const nextTabId = store.replaceTab(workspaceKey, agentTabId!, {
      kind: "draft",
      draftId: "draft-from-agent",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(agentTabId).toBe("agent_agent-retarget");
    expect(nextTabId).toBe("draft-from-agent");
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual(["draft-from-agent"]);
    expect(collectContentTabs(layout.root)).toEqual([
      {
        tabId: "draft-from-agent",
        target: { kind: "draft", draftId: "draft-from-agent" },
        createdAt: expect.any(Number),
      },
    ]);
  });

  it("replaceTab keeps a pane-local replacement beside an existing target", () => {
    useWorkspaceLayoutIds("55555555-5555-5555-5555-555555555555");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const existingFileTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/existing.ts",
      },
      intent: "reveal",
    });
    const draftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "draft-dup" },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: draftTabId!,
      targetPaneId: "main",
      position: "right",
    });
    const secondDraftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "draft",
        draftId: "draft-dup-2",
      },
      intent: "reveal",
    });

    const nextTabId = store.replaceTab(workspaceKey, secondDraftTabId!, {
      kind: "file",
      path: "/repo/worktree/existing.ts",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(existingFileTabId).toBe("file_/repo/worktree/existing.ts");
    expect(draftTabId).toBe("draft-dup");
    expect(splitPaneId).toBe("pane_55555555-5555-5555-5555-555555555555");
    expect(nextTabId).not.toBe(existingFileTabId);
    expect(collectContentTabs(layout.root)).toHaveLength(3);
    expect(collectAllTabs(layout.root).filter((tab) => tab.target.kind === "file")).toHaveLength(2);
  });

  it("replaceTab keeps a pane-local replacement beside an existing matching target", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstDraftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "draft",
        draftId: "draft-agent-1",
      },
      intent: "reveal",
    });
    const firstAgentTabId = store.replaceTab(workspaceKey, firstDraftTabId!, {
      kind: "agent",
      agentId: "agent-1",
    });
    const secondDraftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "draft",
        draftId: "draft-agent-2",
      },
      intent: "reveal",
    });

    const nextTabId = store.replaceTab(workspaceKey, secondDraftTabId!, {
      kind: "agent",
      agentId: "agent-1",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(firstAgentTabId).toBe(firstDraftTabId);
    expect(nextTabId).not.toBe(firstDraftTabId);
    expect(collectContentTabs(layout.root)).toHaveLength(2);
    expect(collectAllTabs(layout.root).filter((tab) => tab.target.kind === "agent")).toHaveLength(
      2,
    );
  });

  it("reorderTabs reorders tabs within the focused pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const firstTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const thirdTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/c.ts",
      },
      intent: "reveal",
    });

    store.reorderTabs(workspaceKey, [thirdTabId!, firstTabId!]);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(findPaneById(layout.root, "main")).toEqual({
      id: "main",
      tabIds: [thirdTabId!, firstTabId!, secondTabId!],
      focusedTabId: thirdTabId,
      tabs: [
        {
          tabId: thirdTabId,
          target: { kind: "file", path: "/repo/worktree/c.ts" },
          createdAt: expect.any(Number),
        },
        {
          tabId: firstTabId,
          target: { kind: "file", path: "/repo/worktree/a.ts" },
          createdAt: expect.any(Number),
        },
        {
          tabId: secondTabId,
          target: { kind: "file", path: "/repo/worktree/b.ts" },
          createdAt: expect.any(Number),
        },
      ],
    });
  });

  it("reorderTabsInPane reorders tabs in the requested pane without changing focused pane", () => {
    useWorkspaceLayoutIds("34343434-3434-3434-3434-343434343434");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const thirdTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/c.ts",
      },
      intent: "reveal",
    });
    const fourthTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/d.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: thirdTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.moveTabToPane(workspaceKey, fourthTabId!, splitPaneId!);
    store.focusPane(workspaceKey, "main");
    store.reorderTabsInPane(workspaceKey, splitPaneId!, [fourthTabId!, thirdTabId!]);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(splitPaneId).toBe("pane_34343434-3434-3434-3434-343434343434");
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, splitPaneId)).toEqual({
      id: splitPaneId,
      tabIds: [fourthTabId!, thirdTabId!],
      focusedTabId: fourthTabId,
      tabs: [
        {
          tabId: fourthTabId,
          target: { kind: "file", path: "/repo/worktree/d.ts" },
          createdAt: expect.any(Number),
        },
        {
          tabId: thirdTabId,
          target: { kind: "file", path: "/repo/worktree/c.ts" },
          createdAt: expect.any(Number),
        },
      ],
    });
  });

  it("focusPane switches workspace focus to a different pane", () => {
    useWorkspaceLayoutIds("56565656-5656-5656-5656-565656565656");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.focusPane(workspaceKey, "main");
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout.focusedPaneId).toBe("main");

    store.focusPane(workspaceKey, splitPaneId!);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;

    expect(splitPaneId).toBe("pane_56565656-5656-5656-5656-565656565656");
    expect(layout.focusedPaneId).toBe(splitPaneId);
  });

  it("focusPane reveals an explicitly targeted hidden pane", () => {
    useWorkspaceLayoutIds("57575757-5757-5757-5757-575757575757");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const paneId = store.showSidePanel(workspaceKey)!;
    store.focusPane(workspaceKey, "main");
    store.hideSidePanel(workspaceKey);

    store.focusPane(workspaceKey, paneId);

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout.focusedPaneId).toBe(paneId);
    expect(findPaneById(layout.root, paneId)?.hidden).toBeUndefined();
  });

  it("closeTab collapses an emptied pane and keeps the nearest sibling focused", () => {
    useWorkspaceLayoutIds("cccccccc-cccc-cccc-cccc-cccccccccccc");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.closeTab(workspaceKey, secondTabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(splitPaneId).toBe("pane_cccccccc-cccc-cccc-cccc-cccccccccccc");
    expect(layout.focusedPaneId).toBe("main");
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main"]);
  });

  it("allows parallel center panes and rejects stacked workspace panes", () => {
    useWorkspaceLayoutIds(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
    );

    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const a = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const b = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
    });
    const c = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/c.ts" },
      intent: "reveal",
    });
    const d = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/d.ts" },
      intent: "reveal",
    });
    const e = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/e.ts" },
      intent: "reveal",
    });

    expect(a).toBeTruthy();
    const pane1 = store.splitPane(workspaceKey, {
      tabId: b!,
      targetPaneId: "main",
      position: "right",
    });
    const pane2 = store.splitPane(workspaceKey, {
      tabId: c!,
      targetPaneId: pane1!,
      position: "right",
    });
    const pane3 = store.splitPane(workspaceKey, {
      tabId: d!,
      targetPaneId: pane2!,
      position: "right",
    });
    const stackedPane = store.splitPane(workspaceKey, {
      tabId: e!,
      targetPaneId: pane3!,
      position: "bottom",
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(pane1).toBe("pane_11111111-1111-1111-1111-111111111111");
    expect(pane2).toBe("pane_22222222-2222-2222-2222-222222222222");
    expect(pane3).toBe("pane_33333333-3333-3333-3333-333333333333");
    expect(stackedPane).toBeNull();
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([
      "main",
      pane1,
      pane2,
      pane3,
    ]);
    expect(getTreeDepth(layout.root)).toBe(2);
  });

  it("moveTabToPane collapses the source pane when its last tab moves out", () => {
    useWorkspaceLayoutIds("dddddddd-dddd-dddd-dddd-dddddddddddd");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const leftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/a.ts",
      },
      intent: "reveal",
    });
    const rightTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: rightTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.moveTabToPane(workspaceKey, leftTabId!, splitPaneId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(layout.focusedPaneId).toBe(splitPaneId);
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([splitPaneId!]);
    expect(findPaneById(layout.root, splitPaneId)?.tabIds).toEqual([
      "file_/repo/worktree/b.ts",
      "file_/repo/worktree/a.ts",
    ]);
  });

  it("moving a pane's sole New tab closes that pane instead of moving the tab", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    }) as string;
    const splitPaneId = store.splitPaneEmpty(workspaceKey, {
      targetPaneId: "main",
      position: "right",
    }) as string;
    const before = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const newTabId = findPaneById(before.root, splitPaneId)?.focusedTabId as string;

    store.moveTabToPane(workspaceKey, newTabId, "main");

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main"]);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([fileTabId]);
    expect(collectAllTabs(layout.root).some((tab) => tab.tabId === newTabId)).toBe(false);
  });

  it("blocks moving the side panel's default Files tool into the main pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const fileTabId = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    }) as string;
    const sidePanelPaneId = store.showSidePanel(workspaceKey) as string;
    const before = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const filesTabId = findPaneById(before.root, sidePanelPaneId)?.focusedTabId as string;

    store.moveTabToPane(workspaceKey, filesTabId, "main");

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, sidePanelPaneId)?.hidden).toBeUndefined();
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([fileTabId]);
    expect(findPaneById(layout.root, sidePanelPaneId)?.tabIds).toEqual([filesTabId]);
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === filesTabId)?.target).toEqual({
      kind: "files",
    });
  });

  it("prevents workspace and terminal tabs from crossing their zones", () => {
    useWorkspaceLayoutIds("terminal-pane", "terminal-group");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const agentTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    }) as string;
    const terminalTabId = store.openTab({
      workspaceKey,
      target: { kind: "terminal", terminalId: "terminal-1" },
      intent: "reveal",
    }) as string;
    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const terminalPaneId = findPaneContainingTab(layout.root, terminalTabId)?.id as string;

    store.moveTabToPane(workspaceKey, agentTabId, terminalPaneId);
    store.moveTabToPane(workspaceKey, terminalTabId, "main");

    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneContainingTab(layout.root, agentTabId)?.id).toBe("main");
    expect(findPaneContainingTab(layout.root, terminalTabId)?.id).toBe(terminalPaneId);
  });

  it("closeTab removes an emptied side-by-side pane", () => {
    useWorkspaceLayoutIds(
      "78787878-7878-7878-7878-787878787878",
      "89898989-8989-8989-8989-898989898989",
      "9a9a9a9a-9a9a-9a9a-9a9a-9a9a9a9a9a9a",
    );

    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const thirdTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/c.ts",
      },
      intent: "reveal",
    });
    const paneBId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });
    const paneCId = store.splitPane(workspaceKey, {
      tabId: thirdTabId!,
      targetPaneId: paneBId!,
      position: "right",
    });

    store.closeTab(workspaceKey, secondTabId!);
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(paneBId).toBe("pane_78787878-7878-7878-7878-787878787878");
    expect(paneCId).toBe("pane_89898989-8989-8989-8989-898989898989");
    expect(layout.focusedPaneId).toBe(paneCId);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual(["file_/repo/worktree/a.ts"]);
    expect(findPaneById(layout.root, paneCId)?.tabIds).toEqual(["file_/repo/worktree/c.ts"]);
    expect(findPaneById(layout.root, "explorer")?.hidden).toBe(true);
  });

  it("openTab focuses the existing tab instead of creating a duplicate entry", () => {
    useWorkspaceLayoutIds("abababab-abab-abab-abab-abababababab");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const secondTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: secondTabId!,
      targetPaneId: "main",
      position: "right",
    });

    store.focusPane(workspaceKey, "main");
    const duplicateTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/worktree/b.ts",
      },
      intent: "reveal",
    });
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(splitPaneId).toBe("pane_abababab-abab-abab-abab-abababababab");
    expect(duplicateTabId).toBe(secondTabId);
    expect(layout.focusedPaneId).toBe(splitPaneId);
    expect(collectContentTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      "file_/repo/worktree/a.ts",
      "file_/repo/worktree/b.ts",
    ]);
  });

  it("persists working diff tabs while stripping commit diff tabs", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "working_diff",
        focusPath: "src/a.ts",
      },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "commit_diff", sha: "abc123" },
      intent: "reveal",
    });

    const partialize = workspaceLayoutStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    if (!partialize) {
      throw new Error("Workspace layout partialize function is missing");
    }
    const currentState = workspaceLayoutStore.getState();
    const layout = stripEphemeralTabsFromLayout(currentState.layoutByWorkspace[workspaceKey]);
    const persisted = partialize(currentState);

    expect(persisted).toEqual({
      layoutByWorkspace: { [workspaceKey]: layout },
      splitSizesByWorkspace: currentState.splitSizesByWorkspace,
      // The persisted key keeps its pre-rename spelling for older clients.
      explorerPaneIdByWorkspace: {},
    });
    expect(layout && collectAllTabs(layout.root).map((tab) => tab.target)).toEqual([
      {
        kind: "working_diff",
        focusPath: "src/a.ts",
      },
    ]);
  });

  it("hydrates duplicate Changes and Pull request instances without collapsing their ids or state", () => {
    const tabs = [
      {
        tabId: "changes-a",
        createdAt: 1,
        target: { kind: "working_diff" },
        state: {
          mode: "base",
          baseRef: "main",
          layout: "split",
          wrapLines: true,
          hideWhitespace: true,
          treeVisible: true,
          treeWidth: 300,
          collapsedFilePaths: ["a"],
          collapsedFolderPaths: ["src"],
          commitsCollapsed: false,
        },
      },
      {
        tabId: "changes-b",
        createdAt: 2,
        target: { kind: "working_diff" },
        state: {
          mode: "uncommitted",
          layout: "unified",
          wrapLines: false,
          hideWhitespace: false,
          treeVisible: false,
          collapsedFilePaths: [],
          collapsedFolderPaths: [],
          commitsCollapsed: true,
        },
      },
      { tabId: "pr-a", createdAt: 3, target: { kind: "pull_request" } },
      { tabId: "pr-b", createdAt: 4, target: { kind: "pull_request" } },
    ];
    const layout = normalizeLayout({
      root: {
        kind: "pane",
        pane: { id: "main", tabIds: tabs.map((tab) => tab.tabId), focusedTabId: "changes-a", tabs },
      },
      focusedPaneId: "main",
    });
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toEqual([
      "changes-a",
      "changes-b",
      "pr-a",
      "pr-b",
    ]);
    expect(
      collectAllTabs(layout.root).find((tab) => tab.tabId === "changes-a")?.state,
    ).toMatchObject({ baseRef: "main", treeWidth: 300, collapsedFolderPaths: ["src"] });
  });

  it("resizeSplit keeps side-by-side sizes normalized above the minimum", () => {
    useWorkspaceLayoutIds(
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    );

    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const a = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    const b = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/b.ts" },
      intent: "reveal",
    });
    const c = store.openTab({
      workspaceKey,
      target: { kind: "file", path: "/repo/worktree/c.ts" },
      intent: "reveal",
    });

    expect(a).toBeTruthy();
    const rightPaneId = store.splitPane(workspaceKey, {
      tabId: b!,
      targetPaneId: "main",
      position: "right",
    });
    const farRightPaneId = store.splitPane(workspaceKey, {
      tabId: c!,
      targetPaneId: rightPaneId!,
      position: "right",
    });

    const splitRoot = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root;
    const splitGroup = expectGroup(splitRoot);
    store.resizeSplit(workspaceKey, splitGroup.group.id, [0.01, 0.29, 0.3, 0.4]);

    const resizedRoot = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root;
    const resizedGroup = expectGroup(resizedRoot);
    const total = resizedGroup.group.sizes.reduce((sum, size) => sum + size, 0);

    expect(rightPaneId).toBe("pane_eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
    expect(farRightPaneId).toBe("pane_ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(resizedGroup.group.sizes.every((size) => size >= 0.1)).toBe(true);
    expect(total).toBeCloseTo(1, 10);
  });

  it("closing the final draft returns to creation while retaining the pane placeholder", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const tabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "draft-1" },
      intent: "reveal",
    });
    expect(store.closeTab(workspaceKey, tabId!)).toBe("workspace-empty");
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    const mainTab = collectAllTabs(layout.root).find(
      (tab) => findPaneContainingTab(layout.root, tab.tabId)?.id === "main",
    );
    expect(mainTab?.target).toEqual({ kind: "new_tab" });
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(mainTab?.tabId);
    expect(findPaneById(layout.root, "explorer")?.hidden).toBe(true);
  });

  it("keeps pinned archived agents in memory per workspace without persisting them", () => {
    const workspaceKey = createWorkspaceKey();
    const otherWorkspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: "ws-other-worktree",
    });

    expect(otherWorkspaceKey).toBeTruthy();

    const store = workspaceLayoutStore.getState();
    store.pinAgent(workspaceKey, "agent-1");
    store.pinAgent(workspaceKey, "agent-1");
    store.pinAgent(otherWorkspaceKey as string, "agent-2");

    let state = workspaceLayoutStore.getState();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
    expect(Array.from(state.pinnedAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    store.unpinAgent(workspaceKey, "agent-1");

    state = workspaceLayoutStore.getState();
    expect(state.pinnedAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    const partialize = workspaceLayoutStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    expect(partialize?.(state)).toEqual({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      explorerPaneIdByWorkspace: {},
    });
  });

  it("keeps hidden agent intents in memory per workspace without persisting them", () => {
    const workspaceKey = createWorkspaceKey();
    const otherWorkspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: "ws-other-worktree",
    });

    expect(otherWorkspaceKey).toBeTruthy();

    const store = workspaceLayoutStore.getState();
    store.hideAgent(workspaceKey, "agent-1");
    store.hideAgent(workspaceKey, "agent-1");
    store.hideAgent(otherWorkspaceKey as string, "agent-2");

    let state = workspaceLayoutStore.getState();
    expect(Array.from(state.hiddenAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
    expect(Array.from(state.hiddenAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    store.unhideAgent(workspaceKey, "agent-1");

    state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.hiddenAgentIdsByWorkspace[otherWorkspaceKey as string] ?? [])).toEqual([
      "agent-2",
    ]);

    const partialize = workspaceLayoutStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    expect(partialize?.(state)).toEqual({
      layoutByWorkspace: {},
      splitSizesByWorkspace: {},
      explorerPaneIdByWorkspace: {},
    });
  });

  it("convertDraftToAgent removes the draft and focuses the existing split conversation", () => {
    useWorkspaceLayoutIds("67676767-6767-6767-6767-676767676767");
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const draftTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "draft",
        draftId: "draft-existing",
      },
      intent: "reveal",
    });
    const agentTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: agentTabId!,
      targetPaneId: "main",
      position: "right",
    });

    const nextTabId = store.convertDraftToAgent(workspaceKey, draftTabId!, "agent-1");
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(splitPaneId).toBe("pane_67676767-6767-6767-6767-676767676767");
    expect(nextTabId).toBe("agent_agent-1");
    expect(collectContentTabs(layout.root).map((tab) => tab.tabId)).toEqual(["agent_agent-1"]);
    expect(layout.focusedPaneId).toBe(splitPaneId);
    expect(findPaneContainingTab(layout.root, "agent_agent-1")?.id).toBe(splitPaneId);
  });

  it("reconcileTabs canonicalizes duplicates and prunes stale entity tabs from hydrated snapshots", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: {
            kind: "pane",
            pane: {
              id: "main",
              tabIds: ["draft_agent", "agent_agent-1", "terminal_orphan", "draft-1"],
              focusedTabId: "draft_agent",
              tabs: [
                {
                  tabId: "draft_agent",
                  target: { kind: "agent", agentId: "agent-1" },
                  createdAt: 1,
                },
                {
                  tabId: "agent_agent-1",
                  target: { kind: "agent", agentId: "agent-1" },
                  createdAt: 2,
                },
                {
                  tabId: "terminal_orphan",
                  target: { kind: "terminal", terminalId: "term-stale" },
                  createdAt: 3,
                },
                {
                  tabId: "draft-1",
                  target: { kind: "draft", draftId: "draft-1" },
                  createdAt: 4,
                },
              ],
            } as SplitPane,
          },
          focusedPaneId: "main",
        },
      },
      pinnedAgentIdsByWorkspace: {
        [workspaceKey]: new Set<string>(["agent-2"]),
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownAgentIds: ["agent-1", "agent-2"],
      standaloneTerminalIds: ["term-1"],
      hasActivePendingDraftCreate: false,
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const tabs = collectAllTabs(layout.root);

    expect(tabs.map((tab) => tab.tabId)).toEqual([
      "agent_agent-1",
      "draft-1",
      "agent_agent-2",
      "terminal_term-1",
    ]);
    expect(tabs.find((tab) => tab.tabId === "agent_agent-1")).toEqual({
      tabId: "agent_agent-1",
      target: { kind: "agent", agentId: "agent-1" },
      createdAt: 2,
    });
    expect(layout.focusedPaneId).toBe("main");
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe("agent_agent-1");
  });

  it("reconcileTabs preserves a draft-origin agent tab id when there is no duplicate", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: {
            kind: "pane",
            pane: {
              id: "main",
              tabIds: ["draft-agent"],
              focusedTabId: "draft-agent",
              tabs: [
                {
                  tabId: "draft-agent",
                  target: { kind: "agent", agentId: "agent-1" },
                  createdAt: 1,
                },
              ],
            } as SplitPane,
          },
          focusedPaneId: "main",
        },
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownAgentIds: ["agent-1"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    expect(collectContentTabs(layout.root)).toEqual([
      {
        tabId: "draft-agent",
        target: { kind: "agent", agentId: "agent-1" },
        createdAt: 1,
      },
    ]);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe("draft-agent");
  });

  it("reconcileTabs does not re-add locally hidden agent tabs", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.setState((state) => ({
      ...state,
      hiddenAgentIdsByWorkspace: {
        [workspaceKey]: new Set<string>(["agent-1"]),
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownAgentIds: ["agent-1"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey))).toEqual([]);
  });

  it("reconcileTabs lands on an existing agent instead of the initial New tab", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownAgentIds: ["agent-1"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual(["agent_agent-1"]);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe("agent_agent-1");
  });

  it("reconcileTabs lands on a draft when the hydrated workspace is empty", () => {
    const workspaceKey = createWorkspaceKey();

    const snapshot = {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      knownTerminalIds: [],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    };
    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, snapshot);

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const mainTab = collectAllTabs(layout.root).find(
      (tab) => findPaneContainingTab(layout.root, tab.tabId)?.id === "main",
    );
    expect(mainTab?.target.kind).toBe("draft");
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(mainTab?.tabId);

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, snapshot);
    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]).toBe(layout);
  });

  it("reconcileTabs recovers a transient all-hidden layout", () => {
    const workspaceKey = createWorkspaceKey();
    workspaceLayoutStore.setState((state) => ({
      ...state,
      layoutByWorkspace: {
        ...state.layoutByWorkspace,
        [workspaceKey]: {
          root: createPane({
            id: "explorer",
            tabIds: ["placeholder"],
            hidden: true,
            targetsByTabId: { placeholder: { kind: "new_tab" } },
          }),
          focusedPaneId: "explorer",
        },
      },
      sidePanelPaneIdByWorkspace: {
        ...state.sidePanelPaneIdByWorkspace,
        [workspaceKey]: "explorer",
      },
    }));

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      knownTerminalIds: [],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const visiblePanes = collectAllPanes(layout.root);
    expect(visiblePanes).toHaveLength(1);
    expect(visiblePanes[0]?.id).not.toBe("explorer");
    expect(findPaneById(layout.root, "explorer")?.hidden).toBe(true);
    expect(collectContentTabs(layout.root).map((tab) => tab.target.kind)).toEqual(["draft"]);
  });

  it("reconcileTabs does not auto-open subagents omitted from autoOpenAgentIds", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent", "child-agent"],
      autoOpenAgentIds: ["parent-agent"],
      knownAgentIds: ["parent-agent", "child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(
      contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).map(
        (tab) => tab.tabId,
      ),
    ).toEqual(["agent_parent-agent"]);
  });

  it("reconcileTabs keeps manually opened subagent tabs that remain active", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "child-agent" },
      intent: "reveal",
    });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent", "child-agent"],
      autoOpenAgentIds: ["parent-agent"],
      knownAgentIds: ["parent-agent", "child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(
      contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).map(
        (tab) => tab.tabId,
      ),
    ).toEqual(["agent_child-agent", "agent_parent-agent"]);
  });

  it("reconcileTabs prunes archived subagent tabs that are no longer active", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "child-agent" },
      intent: "reveal",
    });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["parent-agent"],
      autoOpenAgentIds: ["parent-agent"],
      knownAgentIds: ["parent-agent", "child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(
      contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey)).map(
        (tab) => tab.tabId,
      ),
    ).toEqual(["agent_parent-agent"]);
  });

  it("openTab reveal intent reopens hidden subagent tabs and clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "child-agent");
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["child-agent"],
      autoOpenAgentIds: [],
      knownAgentIds: ["child-agent"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey))).toEqual([]);

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "child-agent" },
      intent: "reveal",
    });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(contentTabs(state.getWorkspaceTabs(workspaceKey)).map((tab) => tab.tabId)).toEqual([
      "agent_child-agent",
    ]);
  });

  it("reconcileTabs auto-opens only standalone terminals while keeping explicitly opened live terminals", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    const scriptTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "terminal",
        terminalId: "term-script",
      },
      intent: "reveal",
    });

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      knownTerminalIds: ["term-script", "term-manual"],
      standaloneTerminalIds: ["term-manual"],
      hasActivePendingDraftCreate: false,
    });

    const tabs = contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey));
    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(tabs.map((tab) => tab.tabId)).toEqual(["terminal_term-script", "terminal_term-manual"]);
    expect(findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId).toBe(scriptTabId);
  });

  it("reconcileTabs does not auto-open live non-standalone terminals", () => {
    const workspaceKey = createWorkspaceKey();

    workspaceLayoutStore.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      knownTerminalIds: ["term-script"],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });

    expect(contentTabs(workspaceLayoutStore.getState().getWorkspaceTabs(workspaceKey))).toEqual([]);
  });

  it("explicitly opening an agent tab clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(contentTabs(state.getWorkspaceTabs(workspaceKey)).map((tab) => tab.tabId)).toEqual([
      "agent_agent-1",
    ]);
  });

  it("pinning an agent clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    expect(workspaceLayoutStore.getState().hiddenAgentIdsByWorkspace[workspaceKey]).toBeDefined();

    store.pinAgent(workspaceKey, "agent-1");

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
    expect(Array.from(state.pinnedAgentIdsByWorkspace[workspaceKey] ?? [])).toEqual(["agent-1"]);
  });

  it("keeps an explicitly pinned archived agent before its detail is hydrated", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "archived-agent" },
      intent: "reveal",
    });
    store.pinAgent(workspaceKey, "archived-agent");
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      standaloneTerminalIds: [],
    });

    expect(
      store
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.tabId),
    ).toEqual(["agent_archived-agent"]);

    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      standaloneTerminalIds: [],
    });

    expect(
      store
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.tabId),
    ).toEqual(["agent_archived-agent"]);

    store.resolvePendingAgent(workspaceKey, "archived-agent");
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      standaloneTerminalIds: [],
    });

    expect(
      store
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.tabId),
    ).toEqual([]);

    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "archived-agent" },
      intent: "reveal",
    });
    store.pinAgent(workspaceKey, "archived-agent");
    store.reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: [],
      autoOpenAgentIds: [],
      knownAgentIds: [],
      standaloneTerminalIds: [],
    });

    expect(
      store
        .getWorkspaceTabs(workspaceKey)
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.tabId),
    ).toEqual(["agent_archived-agent"]);
  });

  it("retargeting a tab to an agent clears hidden intent", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();

    store.hideAgent(workspaceKey, "agent-1");
    const tabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/worktree/a.ts" },
      intent: "reveal",
    });
    store.replaceTab(workspaceKey, tabId!, { kind: "agent", agentId: "agent-1" });

    const state = workspaceLayoutStore.getState();
    expect(state.hiddenAgentIdsByWorkspace[workspaceKey]).toBeUndefined();
  });

  it("closePane removes an emptied main pane and moves focus to the surviving pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const keptTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/kept" },
      intent: "reveal",
    });
    useWorkspaceLayoutIds("split", "group-1");
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: keptTabId as string,
      targetPaneId: "main",
      position: "right",
    });
    const strandedTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: {
        kind: "file",
        path: "/repo/stranded",
      },
      intent: "reveal",
    });
    store.moveTabToPane(workspaceKey, strandedTabId as string, "main");
    store.closeTab(workspaceKey, strandedTabId as string);
    expect(
      findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, "main"),
    ).toBeTruthy();

    store.closePane(workspaceKey, "main");

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([splitPaneId]);
    expect(layout.focusedPaneId).toBe(splitPaneId);
  });

  it("closePane drops the tabs the pane was still holding", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const keptTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/kept" },
      intent: "reveal",
    });
    useWorkspaceLayoutIds("split", "group-1");
    const splitPaneId = store.splitPane(workspaceKey, {
      tabId: keptTabId as string,
      targetPaneId: "main",
      position: "right",
    });
    const doomedTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/doomed" },
      intent: "reveal",
    });
    store.moveTabToPane(workspaceKey, doomedTabId as string, "main");

    store.closePane(workspaceKey, "main");

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectContentTabs(layout.root).map((tab) => tab.tabId)).toEqual([keptTabId]);
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([splitPaneId]);
  });

  it("closePane refuses to close the last visible pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const before = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    store.closePane(workspaceKey, "main");

    expect(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]).toBe(before);
  });

  it("closePane hides the side panel instead of removing it, keeping its tabs", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "kept" },
      intent: "reveal",
    });
    const paneId = store.showSidePanel(workspaceKey) as string;
    const filesTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "files" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    });

    store.closePane(workspaceKey, paneId);

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, paneId)?.hidden).toBe(true);
    expect(collectAllTabs(layout.root).map((tab) => tab.tabId)).toContain(filesTabId);
    expect(store.showSidePanel(workspaceKey)).toBe(paneId);
    expect(
      findPaneById(workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root, paneId)
        ?.hidden,
    ).toBeUndefined();
  });

  it("closing the final Side panel content tab leaves New tab hidden until reveal", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "kept" },
      intent: "reveal",
    });
    const paneId = store.showSidePanel(workspaceKey) as string;
    const filesTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "files" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    }) as string;

    store.closeTab(workspaceKey, filesTabId);

    let layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const hiddenPane = findPaneById(layout.root, paneId);
    expect(hiddenPane?.hidden).toBe(true);
    expect(hiddenPane?.tabIds).toHaveLength(1);
    expect(
      collectAllTabs(layout.root).find((tab) => tab.tabId === hiddenPane?.focusedTabId)?.target,
    ).toEqual({ kind: "new_tab" });
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main"]);

    expect(store.showSidePanel(workspaceKey)).toBe(paneId);
    layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, paneId)?.tabIds).toEqual(hiddenPane?.tabIds);
    expect(findPaneById(layout.root, paneId)?.hidden).toBeUndefined();
  });

  it("closing one of several Side panel tabs leaves the panel visible", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "kept" },
      intent: "reveal",
    });
    const paneId = store.showSidePanel(workspaceKey) as string;
    const filesTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "files" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    }) as string;
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    });

    store.closeTab(workspaceKey, filesTabId);

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(layout.root, paneId)?.hidden).toBeUndefined();
    expect(findPaneById(layout.root, paneId)?.tabIds).toEqual(["working_diff"]);
  });

  it("closing the final Side panel content tab keeps New tab on screen", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const paneId = store.showSidePanel(workspaceKey) as string;
    const filesTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "files" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    }) as string;
    store.closePane(workspaceKey, "main");

    store.closeTab(workspaceKey, filesTabId);

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([paneId]);
    const finalPane = findPaneById(layout.root, paneId);
    expect(finalPane?.tabIds).toHaveLength(1);
    expect(
      collectAllTabs(layout.root).find((tab) => tab.tabId === finalPane?.focusedTabId)?.target,
    ).toEqual({ kind: "new_tab" });
    expect(findPaneById(layout.root, paneId)?.hidden).toBeUndefined();
  });

  it("keeps a side-panel tool in its zone despite an explicit workspace placement", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const sidePanelPaneId = store.showSidePanel(workspaceKey) as string;
    const changesTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "reveal",
      placement: { mode: "pane", paneId: sidePanelPaneId },
    });

    const reopened = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "working_diff" },
      intent: "reveal",
      placement: { mode: "pane", paneId: "main" },
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(reopened).toBe(changesTabId);
    expect(collectAllTabs(layout.root).filter((tab) => tab.tabId === changesTabId)).toHaveLength(1);
    expect(findPaneContainingTab(layout.root, changesTabId as string)?.id).toBe(sidePanelPaneId);
    expect(layout.focusedPaneId).toBe(sidePanelPaneId);
    expect(findPaneById(layout.root, sidePanelPaneId)?.focusedTabId).toBe(changesTabId);
  });

  it("a preferred open focuses an existing tab where the user left it", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const sidePanelPaneId = store.showSidePanel(workspaceKey) as string;
    const fileTabId = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "reveal",
      placement: { mode: "prefer", paneId: sidePanelPaneId },
    }) as string;
    store.moveTabToPane(workspaceKey, fileTabId, "main");

    const reopened = store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "file", path: "/repo/a.ts" },
      intent: "reveal",
      placement: { mode: "prefer", paneId: sidePanelPaneId },
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(reopened).toBe(fileTabId);
    expect(findPaneContainingTab(layout.root, fileTabId)?.id).toBe("main");
    expect(layout.focusedPaneId).toBe("main");
  });
  it("keeps Files and Changes together in the tool-only side panel", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const paneId = store.showSidePanel(workspaceKey) as string;
    const changesTabId = store.openTab({
      workspaceKey,
      target: { kind: "working_diff" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    }) as string;

    store.openTab({
      workspaceKey,
      target: { kind: "working_diff" },
      intent: "reveal",
      placement: { mode: "pane", paneId: "main" },
    });

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
    expect(findPaneContainingTab(layout.root, changesTabId)?.id).toBe(paneId);
    const sidePane = findPaneById(layout.root, paneId);
    expect(sidePane?.tabIds.map((tabId) => tabsById.get(tabId)?.target.kind)).toEqual([
      "files",
      "working_diff",
    ]);
    expect(findPaneById(layout.root, paneId)?.hidden).toBeUndefined();
  });
  it("closePane refuses to hide the side panel once it is the only visible pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const paneId = store.showSidePanel(workspaceKey) as string;
    store.closePane(workspaceKey, "main");
    const afterMainClosed = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(afterMainClosed.root, "main")).toBeNull();
    expect(collectAllPanes(afterMainClosed.root).map((pane) => pane.id)).toEqual([paneId]);
    const before = afterMainClosed;

    store.closePane(workspaceKey, paneId);

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout).toBe(before);
    expect(findPaneById(layout.root, paneId)?.hidden).toBeUndefined();
  });
  it("closePane refuses to hide the side panel once it is the only visible pane", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const paneId = store.showSidePanel(workspaceKey) as string;
    store.closePane(workspaceKey, "main");
    const afterMainClosed = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(findPaneById(afterMainClosed.root, "main")).toBeNull();
    expect(collectAllPanes(afterMainClosed.root).map((pane) => pane.id)).toEqual([paneId]);
    const before = afterMainClosed;

    store.closePane(workspaceKey, paneId);

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout).toBe(before);
    expect(findPaneById(layout.root, paneId)?.hidden).toBeUndefined();
  });
  it("hideSidePanel refuses to blank the workspace when the side panel is all that is left", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const paneId = store.showSidePanel(workspaceKey) as string;
    store.closePane(workspaceKey, "main");
    const before = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(collectAllPanes(before.root).map((pane) => pane.id)).toEqual([paneId]);

    store.hideSidePanel(workspaceKey);

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout).toBe(before);
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual([paneId]);
  });
  it("canDismissPaneInLayout refuses the final visible pane, loaded or empty", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    store.openTab({
      workspaceKey: workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const loadedFinal = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    // Only `main` is on screen; the side panel is present but hidden.
    expect(collectAllPanes(loadedFinal.root).map((pane) => pane.id)).toEqual(["main"]);
    expect(canDismissPaneInLayout(loadedFinal, "main")).toBe(false);
    expect(canDismissPaneInLayout(loadedFinal, "explorer")).toBe(false);

    const paneId = store.showSidePanel(workspaceKey) as string;
    const bothVisible = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(canDismissPaneInLayout(bothVisible, "main")).toBe(true);
    expect(canDismissPaneInLayout(bothVisible, paneId)).toBe(true);

    store.closePane(workspaceKey, "main");
    const sidePanelAlone = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(canDismissPaneInLayout(sidePanelAlone, paneId)).toBe(false);
  });

  it("closePane keeps the final visible workspace pane and its tabs", () => {
    const workspaceKey = createWorkspaceKey();
    const store = workspaceLayoutStore.getState();
    const agentTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "only" },
      intent: "reveal",
    });
    const filesTabId = store.openTab({
      workspaceKey,
      target: { kind: "files" },
      intent: "reveal",
    });
    store.hideSidePanel(workspaceKey);
    const before = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];

    store.closePane(workspaceKey, "main");

    const layout = workspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(layout).toBe(before);
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([agentTabId]);
    expect(findPaneContainingTab(layout.root, filesTabId!)?.id).toBe("explorer");
    expect(collectAllPanes(layout.root).map((pane) => pane.id)).toEqual(["main"]);
  });
});
