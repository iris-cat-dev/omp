import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useSessionStore,
  type ExplorerDirectory,
  type ExplorerEntry,
} from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import { FileExplorerPane } from "./file-explorer-pane";

vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("@/hooks/use-file-download", () => ({ useFileDownload: () => vi.fn() }));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useIsLocalDaemon: () => false }));
vi.mock("@/workspace/desktop-open-targets", () => ({
  useDesktopOpenTargets: () => ({ targets: [] }),
  openDesktopTarget: vi.fn(),
}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock("@/components/file-explorer-search", () => ({ FileExplorerSearch: () => null }));
vi.mock("@/components/file-explorer-content-search", () => ({
  FileExplorerContentSearch: () => null,
}));
vi.mock("@/components/ui/overlay-scrollbar/use-overlay-flat-list-scrollbar", () => ({
  useOverlayFlatListScrollbar: () => ({ enabled: false, overlay: null }),
}));

const serverId = "explorer-refresh-regression";
const workspaceId = "workspace-refresh";
const stateKey = `workspace:${workspaceId}`;
let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let directories: Map<string, ExplorerDirectory>;
let rootGate: Promise<void> | null;

function entry(path: string, kind: ExplorerEntry["kind"]): ExplorerEntry {
  return { path, name: path.split("/").at(-1)!, kind, size: 0, modifiedAt: "2026-10-25T00:00:00Z" };
}

function visiblePaths() {
  return [...container.querySelectorAll('[data-testid^="file-explorer-row-"][aria-label]')].map(
    (element) => element.getAttribute("aria-label"),
  );
}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rootGate = null;
  directories = new Map([
    [".", { path: ".", entries: [entry("old", "directory"), entry("live", "directory")] }],
    ["old", { path: "old", entries: [entry("old/nested", "directory")] }],
    ["old/nested", { path: "old/nested", entries: [entry("old/nested/obsolete.txt", "file")] }],
    ["live", { path: "live", entries: [entry("live/before.txt", "file")] }],
  ]);
  const client = {
    async listDirectory(_cwd: string, path: string) {
      const directory = directories.get(path);
      if (path === "." && rootGate) await rootGate;
      if (!directory) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      return directory;
    },
  };
  useSessionStore.getState().initializeSession(serverId, client as unknown as DaemonClient);
  usePanelStore.setState({
    expandedPathsByWorkspace: { [stateKey]: [".", "old", "old/nested", "live"] },
    explorerShowHiddenFiles: true,
    explorerRevealRequest: null,
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  container.style.cssText = "display:flex;width:700px;height:600px";
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <FileExplorerPane
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot="/workspace"
        />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(visiblePaths()).toContain("obsolete.txt"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  await queryClient.cancelQueries();
  queryClient.clear();
  container.remove();
  useSessionStore.getState().clearSession(serverId);
  usePanelStore.setState({ expandedPathsByWorkspace: {} });
  vi.unstubAllGlobals();
});

it.each(["removed parent", "removed child", "replaced with file"])(
  "keeps Files usable after an externally %s and refreshes surviving branches",
  async (change) => {
    if (change === "removed child") {
      directories.set("old", { path: "old", entries: [] });
    } else {
      directories.set(".", {
        path: ".",
        entries: [
          entry("live", "directory"),
          ...(change === "replaced with file" ? [entry("old", "file")] : []),
        ],
      });
      directories.delete("old");
    }
    directories.delete("old/nested");
    directories.set("live", { path: "live", entries: [entry("live/after.txt", "file")] });
    const gate = Promise.withResolvers<void>();
    rootGate = gate.promise;
    await act(async () => {
      useSessionStore.getState().requestFileExplorerRefresh(serverId, stateKey);
    });
    await act(async () => gate.resolve());
    await vi.waitFor(() => {
      const explorer = useSessionStore.getState().sessions[serverId]!.fileExplorer.get(stateKey)!;
      expect(visiblePaths()).toContain("after.txt");
      expect(visiblePaths()).not.toContain("obsolete.txt");
      expect(explorer.lastError).toBeNull();
      expect(explorer.directories.has("old/nested")).toBe(false);
    });
  },
);

it("keeps a root failure visible instead of issuing stale child requests", async () => {
  directories.clear();
  await act(async () => {
    useSessionStore.getState().requestFileExplorerRefresh(serverId, stateKey);
  });
  await vi.waitFor(() => {
    expect(container.textContent).toContain("ENOENT: no such file or directory, stat '.'");
    expect(container.querySelector('[data-testid="file-explorer-tree-scroll"]')).toBeNull();
  });
});

it("does not traverse an obsolete parent response after a newer refresh removed that branch", async () => {
  const gate = Promise.withResolvers<void>();
  rootGate = gate.promise;
  await act(async () => {
    useSessionStore.getState().requestFileExplorerRefresh(serverId, stateKey);
  });
  rootGate = null;
  directories.set(".", { path: ".", entries: [entry("live", "directory")] });
  directories.delete("old");
  directories.delete("old/nested");
  directories.set("live", { path: "live", entries: [entry("live/after.txt", "file")] });
  await act(async () => {
    useSessionStore.getState().requestFileExplorerRefresh(serverId, stateKey);
  });
  await vi.waitFor(() => expect(visiblePaths()).toContain("after.txt"));
  await act(async () => gate.resolve());
  await vi.waitFor(() => {
    expect(visiblePaths()).toContain("after.txt");
    expect(visiblePaths()).not.toContain("obsolete.txt");
    expect(
      useSessionStore.getState().sessions[serverId]!.fileExplorer.get(stateKey)!.lastError,
    ).toBeNull();
  });
});
