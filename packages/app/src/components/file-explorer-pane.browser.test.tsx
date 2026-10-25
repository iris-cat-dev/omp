import React, { act, type ReactNode } from "react";
import type { StyleProp, View as NativeView, ViewStyle } from "react-native";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentFileExplorerState,
  ExplorerDirectory,
  ExplorerEntry,
} from "@/stores/session-store";
import { buildWorkspaceExplorerStateKey } from "@/file-explorer/state-key";
import { EXPLORER_ENTRY_DRAG_MIME } from "@/file-explorer/entry-drag";
import { WORKSPACE_FILE_DRAG_MIME } from "@/attachments/workspace-file-drag";
import { FileExplorerPane } from "./file-explorer-pane";
import { RetainedPanelActivity } from "./retained-panel";

const fixture = vi.hoisted(() => ({
  directories: new Map<string, ExplorerDirectory>(),
  sessions: {} as Record<
    string,
    {
      fileExplorer: Map<string, AgentFileExplorerState>;
      serverInfo: { features: { fsEntryMove: boolean } };
    }
  >,
  expandedPathsByWorkspace: {} as Record<string, string[]>,
  revealRequest: null as {
    serverId: string;
    workspaceKey: string;
    path: string;
    revision: number;
  } | null,
  requestDirectoryListing: vi.fn<(path: string) => Promise<ExplorerDirectory | null>>(),
  moveEntry: vi.fn<
    (input: { path: string; parentPath: string }) => Promise<{
      success: boolean;
      movedPath: string;
    }>
  >(),
  selectExplorerEntry: vi.fn(),
  setExpandedPathsForWorkspace: vi.fn(),
  setExplorerSortOption: vi.fn(),
  toggleExplorerShowHiddenFiles: vi.fn(),
  download: vi.fn(),
  toastError: vi.fn(),
  shortcutOs: "mac" as "mac" | "non-mac",
  copyText: vi.fn(),
  openFile: vi.fn(),
}));

interface FixturePanelState {
  explorerSortOption: "name";
  explorerShowHiddenFiles: boolean;
  expandedPathsByWorkspace: Record<string, string[]>;
  explorerRevealRequest: typeof fixture.revealRequest;
  setExplorerSortOption: typeof fixture.setExplorerSortOption;
  toggleExplorerShowHiddenFiles: typeof fixture.toggleExplorerShowHiddenFiles;
  setExpandedPathsForWorkspace: typeof fixture.setExpandedPathsForWorkspace;
}

// Keep the pane, menus, RN web DOM, and drag hook real; replace daemon/persistence boundaries.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) =>
      values?.count === undefined ? key : `${key}: ${values.count}`,
  }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: fixture.copyText }));
vi.mock("@/utils/shortcut-platform", () => ({ getShortcutOs: () => fixture.shortcutOs }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: { sessions: typeof fixture.sessions }) => unknown) =>
    selector({ sessions: fixture.sessions }),
}));
vi.mock("@/stores/panel-store", () => {
  const getState = (): FixturePanelState => ({
    explorerSortOption: "name",
    explorerShowHiddenFiles: true,
    expandedPathsByWorkspace: fixture.expandedPathsByWorkspace,
    explorerRevealRequest: fixture.revealRequest,
    setExplorerSortOption: fixture.setExplorerSortOption,
    toggleExplorerShowHiddenFiles: fixture.toggleExplorerShowHiddenFiles,
    setExpandedPathsForWorkspace: fixture.setExpandedPathsForWorkspace,
  });
  return {
    usePanelStore: Object.assign(
      (selector: (state: FixturePanelState) => unknown) => selector(getState()),
      { getState },
    ),
  };
});
vi.mock("@/hooks/use-file-explorer-actions", () => ({
  useFileExplorerActions: () => ({
    requestDirectoryListing: fixture.requestDirectoryListing,
    moveEntry: fixture.moveEntry,
    selectExplorerEntry: fixture.selectExplorerEntry,
  }),
}));
vi.mock("@/hooks/use-file-download", () => ({ useFileDownload: () => fixture.download }));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useIsLocalDaemon: () => false }));
vi.mock("@/workspace/desktop-open-targets", () => ({
  useDesktopOpenTargets: () => ({ targets: [] }),
  openDesktopTarget: vi.fn(),
}));
vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: fixture.toastError }),
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
vi.mock("@/components/file-explorer-search", () => ({ FileExplorerSearch: () => null }));
vi.mock("@/components/file-explorer-content-search", () => ({
  FileExplorerContentSearch: () => null,
}));
vi.mock("@/components/ui/overlay-scrollbar/use-overlay-flat-list-scrollbar", () => ({
  useOverlayFlatListScrollbar: () => ({ enabled: false, overlay: null }),
}));

// Keep real actions/focus without Reanimated's frame. This hoisted mock must load its
// rendering dependencies inside the factory: static imports are not initialized yet.
vi.mock("@/components/ui/floating", async () => {
  const { forwardRef } = await import("react");
  const { ScrollView, View } = await import("react-native");
  return {
    FloatingSurface: forwardRef<
      NativeView,
      {
        children?: ReactNode;
        frameStyle?: StyleProp<ViewStyle>;
        nativeID?: string;
        style?: StyleProp<ViewStyle>;
        testID?: string;
      }
    >(function StaticFloatingSurface({ children, frameStyle, nativeID, style, testID }, ref) {
      return (
        <View ref={ref} nativeID={nativeID} style={[style, frameStyle]} testID={testID}>
          {children}
        </View>
      );
    }),
    FloatingScrollView: ScrollView,
  };
});

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

function entry(path: string, kind: ExplorerEntry["kind"]): ExplorerEntry {
  return { path, name: path.split("/").at(-1)!, kind, size: 0, modifiedAt: "2026-10-01T00:00:00Z" };
}

function requireElement(testId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`Missing ${testId}`);
  return element;
}

function row(name: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[data-testid^="file-explorer-row-"][aria-label="${name}"]`,
  );
  if (!element) throw new Error(`Missing row ${name}`);
  return element;
}

function siblingAction(name: string, action: "more" | "select" | "move-here"): HTMLElement {
  return requireElement(`${row(name).dataset.testid}-${action}`);
}

function startDrag(): DataTransfer {
  const transfer = new DataTransfer();
  act(() => {
    row("source.ts").dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }),
    );
  });
  return transfer;
}

function dispatchDrag(
  target: HTMLElement,
  type: "dragover" | "drop",
  transfer: DataTransfer,
): DragEvent {
  const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function renderPane(active = true, workspaceRoot = "/workspace") {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RetainedPanelActivity active={active}>
          <FileExplorerPane
            serverId="server-1"
            workspaceId="workspace-1"
            workspaceRoot={workspaceRoot}
            onOpenFile={fixture.openFile}
            revealRequests
          />
        </RetainedPanelActivity>
      </QueryClientProvider>,
    ),
  );
}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.shortcutOs = "mac";
  fixture.revealRequest = null;
  fixture.directories.clear();
  fixture.directories.set(".", {
    path: ".",
    entries: [entry("archive", "directory"), entry("src", "directory"), entry("root.txt", "file")],
  });
  fixture.directories.set("src", {
    path: "src",
    entries: [entry("src/source.ts", "file"), entry("src/other.ts", "file")],
  });
  fixture.directories.set("archive", { path: "archive", entries: [] });
  const stateKey = buildWorkspaceExplorerStateKey({
    workspaceId: "workspace-1",
    workspaceRoot: "/workspace",
  })!;
  fixture.sessions = {
    "server-1": {
      serverInfo: { features: { fsEntryMove: true } },
      fileExplorer: new Map([
        [
          stateKey,
          {
            requestScope: {},
            directories: fixture.directories,
            files: new Map(),
            refreshRevision: 0,
            isLoading: false,
            lastError: null,
            pendingRequest: null,
            currentPath: ".",
            history: [],
            lastVisitedPath: ".",
            selectedEntryPath: null,
          },
        ],
      ]),
    },
  };
  fixture.expandedPathsByWorkspace = { [stateKey]: [".", "src"] };
  fixture.requestDirectoryListing.mockImplementation(
    async (path) => fixture.directories.get(path) ?? null,
  );
  fixture.moveEntry.mockImplementation(async ({ path, parentPath }) => ({
    success: true,
    movedPath:
      parentPath === "." ? path.split("/").at(-1)! : `${parentPath}/${path.split("/").at(-1)}`,
  }));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  container.style.cssText = "display:flex;width:700px;height:600px";
  document.body.appendChild(container);
  root = createRoot(container);
  await renderPane();
});

afterEach(async () => {
  await act(async () => root.unmount());
  await queryClient.cancelQueries();
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("retained file explorer activity", () => {
  it("releases obsolete refresh queries without dropping the mounted pane's query", async () => {
    const explorer = fixture.sessions["server-1"].fileExplorer.values().next().value!;
    for (let revision = 1; revision <= 3; revision++) {
      explorer.refreshRevision = revision;
      await renderPane();
    }
    await vi.waitFor(() => {
      const queries = queryClient.getQueryCache().findAll({ queryKey: ["fileExplorerRefresh"] });
      expect(queries).toHaveLength(1);
      expect(queries[0]!.queryKey.at(-1)).toBe(3);
    });
    await renderPane(false);
    expect(queryClient.getQueryCache().findAll({ queryKey: ["fileExplorerRefresh"] })).toHaveLength(
      1,
    );
    await act(async () => root.render(<QueryClientProvider client={queryClient} />));
    await vi.waitFor(() => {
      expect(queryClient.getQueryCache().findAll({ queryKey: ["fileExplorerRefresh"] })).toEqual(
        [],
      );
    });
  });

  it("defers hidden reveals and does not replay a completed reveal on reactivation", async () => {
    await renderPane(false);
    fixture.requestDirectoryListing.mockClear();
    fixture.revealRequest = {
      serverId: "server-1",
      workspaceKey: buildWorkspaceExplorerStateKey({ workspaceId: "workspace-1" })!,
      path: "root.txt",
      revision: 1,
    };
    await renderPane(false);
    expect(fixture.requestDirectoryListing).not.toHaveBeenCalled();
    await renderPane();
    expect(fixture.requestDirectoryListing.mock.calls.map(([path]) => path)).toEqual(["."]);
    expect(fixture.selectExplorerEntry).toHaveBeenCalledWith("root.txt");
    await renderPane(false);
    await renderPane();
    expect(fixture.requestDirectoryListing).toHaveBeenCalledTimes(1);
  });

  it("coalesces hidden revisions into one refresh on activation", async () => {
    await renderPane(false);
    fixture.requestDirectoryListing.mockClear();
    const explorer = fixture.sessions["server-1"].fileExplorer.values().next().value!;
    explorer.refreshRevision = 1;
    await renderPane(false);
    explorer.refreshRevision = 3;
    await renderPane(false);
    expect(fixture.requestDirectoryListing).not.toHaveBeenCalled();

    await renderPane();
    expect(fixture.requestDirectoryListing.mock.calls.map(([path]) => path)).toEqual([".", "src"]);
    await renderPane();
    expect(fixture.requestDirectoryListing).toHaveBeenCalledTimes(2);
  });

  it("does not initialize hidden mounts or duplicate their pending revision on activation", async () => {
    await act(async () => root.unmount());
    root = createRoot(container);
    fixture.requestDirectoryListing.mockClear();
    await renderPane(false);
    const explorer = fixture.sessions["server-1"].fileExplorer.values().next().value!;
    explorer.refreshRevision = 4;
    await renderPane(false);
    expect(fixture.requestDirectoryListing).not.toHaveBeenCalled();
    await renderPane();
    expect(fixture.requestDirectoryListing.mock.calls.map(([path]) => path)).toEqual([".", "src"]);
  });

  it("ignores obsolete initialization after hiding and changing workspace scope", async () => {
    const { promise, resolve: resolveOldRoot } = Promise.withResolvers<ExplorerDirectory | null>();
    fixture.requestDirectoryListing.mockImplementationOnce(() => promise);
    await renderPane(true, "/old-workspace");
    await renderPane(false, "/workspace");
    fixture.requestDirectoryListing.mockClear();
    fixture.setExpandedPathsForWorkspace.mockClear();
    await renderPane();
    expect(fixture.requestDirectoryListing.mock.calls.map(([path]) => path)).toEqual([".", "src"]);
    expect(fixture.setExpandedPathsForWorkspace).toHaveBeenCalledTimes(1);

    await act(async () => resolveOldRoot(fixture.directories.get(".")!));
    expect(fixture.requestDirectoryListing).toHaveBeenCalledTimes(2);
    expect(fixture.setExpandedPathsForWorkspace).toHaveBeenCalledTimes(1);
    await renderPane(false);
    await renderPane();
    expect(fixture.requestDirectoryListing).toHaveBeenCalledTimes(2);
  });
});

describe("file explorer virtualized extent", () => {
  it("exposes the full scroll extent and reaches the final file without sweeping earlier rows", async () => {
    const count = 1500;
    fixture.directories.clear();
    fixture.directories.set(".", {
      path: ".",
      entries: Array.from({ length: count }, (_, index) =>
        entry(`file-${String(index).padStart(4, "0")}.ts`, "file"),
      ),
    });
    const explorerStates = fixture.sessions["server-1"].fileExplorer;
    const [key, explorer] = [...explorerStates.entries()][0];
    explorerStates.set(key, { ...explorer, directories: new Map(fixture.directories) });
    await renderPane();
    const scroll = requireElement("file-explorer-tree-scroll");
    await vi.waitFor(() => {
      // Each row includes at least its 16px icon; the unseen tail must already exist.
      expect(scroll.scrollHeight).toBeGreaterThan(count * 16);
    });
    await act(async () => {
      scroll.scrollTop = scroll.scrollHeight;
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(row("file-1499.ts")).toBeTruthy();
    });
    expect(
      container.querySelectorAll('[data-testid^="file-explorer-row-"][aria-label]').length,
    ).toBeLessThan(count);
  });
});

describe("file explorer selection and menus", () => {
  it("uses the refreshed visible paths for range selection and batch actions", async () => {
    fixture.directories.set(".", {
      path: ".",
      entries: ["alpha.txt", "beta.txt", "gamma.txt"].map((path) => entry(path, "file")),
    });
    const explorers = fixture.sessions["server-1"].fileExplorer;
    const [key, explorer] = [...explorers.entries()][0];
    explorers.set(key, { ...explorer, directories: new Map(fixture.directories) });
    fixture.expandedPathsByWorkspace[key] = ["."];
    await renderPane();
    await act(async () => {
      await userEvent.click(row("alpha.txt"));
      await userEvent.click(row("gamma.txt"), { modifiers: ["Shift"] });
    });
    for (const name of ["alpha.txt", "beta.txt", "gamma.txt"]) {
      expect(row(name).getAttribute("aria-selected")).toBe("true");
    }
    await act(async () => userEvent.click(siblingAction("gamma.txt", "more")));
    await act(async () =>
      userEvent.click(document.querySelector<HTMLElement>('[data-testid$="-copy-relative-path"]')!),
    );
    expect(fixture.copyText).toHaveBeenCalledExactlyOnceWith("alpha.txt\nbeta.txt\ngamma.txt");
  });

  it("keeps selected entries from collapsed cached directories in batch actions", async () => {
    await act(async () => {
      await userEvent.click(row("archive"), { modifiers: ["Meta"] });
      await userEvent.click(row("source.ts"), { modifiers: ["Meta"] });
    });
    const stateKey = buildWorkspaceExplorerStateKey({ workspaceId: "workspace-1" })!;
    fixture.expandedPathsByWorkspace[stateKey] = ["."];
    await renderPane();
    await act(async () => userEvent.click(siblingAction("archive", "more")));
    await act(async () =>
      userEvent.click(document.querySelector<HTMLElement>('[data-testid$="-copy-relative-path"]')!),
    );
    expect(fixture.copyText).toHaveBeenCalledExactlyOnceWith("archive\nsrc/source.ts");
  });

  it("keeps Mac Control-click as a menu gesture without opening or toggling the file", async () => {
    await act(async () => {
      await userEvent.click(row("source.ts"), { modifiers: ["Meta"] });
      await userEvent.click(row("other.ts"), { modifiers: ["Meta"] });
    });
    await act(async () => {
      row("source.ts").dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 0,
          ctrlKey: true,
        }),
      );
    });
    expect(row("source.ts").getAttribute("aria-selected")).toBe("true");
    expect(row("other.ts").getAttribute("aria-selected")).toBe("true");
    expect(fixture.openFile).not.toHaveBeenCalled();
    const copy = document.querySelector<HTMLElement>('[data-testid$="-copy-relative-path"]')!;
    await act(async () => userEvent.click(copy));
    expect(fixture.copyText).toHaveBeenCalledExactlyOnceWith("src/source.ts\nsrc/other.ts");
  });

  it("offers checkbox selection and an explicit menu without a modifier or secondary click", async () => {
    fixture.setExpandedPathsForWorkspace.mockClear();
    await act(async () => userEvent.click(requireElement("files-toggle-selection")));
    await act(async () => {
      await userEvent.click(siblingAction("archive", "select"));
      await userEvent.click(siblingAction("source.ts", "select"));
    });
    await act(async () => userEvent.click(siblingAction("source.ts", "more")));
    expect(document.body.textContent).toContain("workspace.fileExplorer.actions.selectedCount: 2");
    expect(document.querySelector('[data-testid$="-download"]')).toBeNull();
    expect(fixture.setExpandedPathsForWorkspace).not.toHaveBeenCalled();
    expect(fixture.openFile).not.toHaveBeenCalled();
    await act(async () =>
      userEvent.click(document.querySelector<HTMLElement>('[data-testid$="-copy-path"]')!),
    );
    expect(fixture.copyText).toHaveBeenCalledExactlyOnceWith(
      "/workspace/archive\n/workspace/src/source.ts",
    );
  });

  it("retargets an unselected row's menu without retaining the previous batch", async () => {
    await act(async () => {
      await userEvent.click(row("source.ts"), { modifiers: ["Meta"] });
      await userEvent.click(row("other.ts"), { modifiers: ["Meta"] });
      await userEvent.click(siblingAction("root.txt", "more"));
    });
    expect(row("source.ts").getAttribute("aria-selected")).toBe("false");
    expect(row("other.ts").getAttribute("aria-selected")).toBe("false");
    expect(row("root.txt").getAttribute("aria-selected")).toBe("true");
    await act(async () =>
      userEvent.click(document.querySelector<HTMLElement>('[data-testid$="-copy-relative-path"]')!),
    );
    expect(fixture.copyText).toHaveBeenCalledExactlyOnceWith("root.txt");
  });

  it.each(["mac", "non-mac"] as const)("selects ranges without opening files on %s", async (os) => {
    fixture.shortcutOs = os;
    // Dispatch modifiers independently of the host OS's Control-click conversion.
    await act(async () => {
      row("other.ts").dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          metaKey: os === "mac",
          ctrlKey: os === "non-mac",
        }),
      );
    });
    await act(async () => userEvent.click(row("root.txt"), { modifiers: ["Shift"] }));
    for (const name of ["other.ts", "source.ts", "root.txt"]) {
      expect(row(name).getAttribute("aria-selected")).toBe("true");
    }
    expect(row("src").getAttribute("aria-selected")).toBe("false");
    expect(fixture.openFile).not.toHaveBeenCalled();
  });
});

describe("file explorer row drop ownership", () => {
  it("rejects root moves on directory and nested-file gutters and sibling menus", () => {
    const transfer = startDrag();
    for (const name of ["archive", "other.ts"]) {
      // The outer row itself is the hit target over its indentation/padding.
      const gutter = row(name).parentElement!;
      for (const target of [gutter, siblingAction(name, "more")]) {
        expect(dispatchDrag(target, "dragover", transfer).defaultPrevented).toBe(false);
        expect(dispatchDrag(target, "drop", transfer).defaultPrevented).toBe(false);
      }
    }
    expect(fixture.moveEntry).not.toHaveBeenCalled();
  });

  it("rejects root moves on row checkboxes and the sibling move-here action", async () => {
    await act(async () => {
      await userEvent.click(requireElement("files-toggle-selection"));
    });
    const transfer = startDrag();
    for (const name of ["archive", "other.ts"]) {
      const checkbox = siblingAction(name, "select");
      expect(dispatchDrag(checkbox, "dragover", transfer).defaultPrevented).toBe(false);
      expect(dispatchDrag(checkbox, "drop", transfer).defaultPrevented).toBe(false);
    }
    await act(async () => {
      await userEvent.click(siblingAction("source.ts", "select"));
      await userEvent.click(requireElement("files-move-selection"));
    });
    const moveHere = siblingAction("archive", "move-here");
    expect(dispatchDrag(moveHere, "dragover", transfer).defaultPrevented).toBe(false);
    expect(dispatchDrag(moveHere, "drop", transfer).defaultPrevented).toBe(false);
    expect(fixture.moveEntry).not.toHaveBeenCalled();
  });

  it.each([
    { target: "archive", parentPath: "archive" },
    { target: "root.txt", parentPath: "." },
  ])("still moves a source onto the $target label", async ({ target, parentPath }) => {
    const transfer = startDrag();
    expect(Array.from(transfer.types)).toEqual(
      expect.arrayContaining([EXPLORER_ENTRY_DRAG_MIME, WORKSPACE_FILE_DRAG_MIME]),
    );
    expect(dispatchDrag(row(target), "dragover", transfer).defaultPrevented).toBe(true);
    await act(async () => {
      dispatchDrag(row(target), "drop", transfer);
    });
    expect(fixture.moveEntry).toHaveBeenCalledExactlyOnceWith({
      path: "src/source.ts",
      parentPath,
    });
  });

  it("keeps source drag and context selection on the main trigger only", () => {
    const source = row("source.ts");
    expect(source.draggable).toBe(true);
    const gutterTransfer = new DataTransfer();
    act(() => {
      source.parentElement!.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, dataTransfer: gutterTransfer }),
      );
    });
    expect(Array.from(gutterTransfer.types)).toEqual([]);
    act(() => {
      source.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
      );
    });
    expect(row("source.ts").getAttribute("aria-selected")).toBe("true");
    expect(Array.from(startDrag().types)).toContain(EXPLORER_ENTRY_DRAG_MIME);
  });
});
