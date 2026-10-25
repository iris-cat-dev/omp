/** @vitest-environment jsdom */
import type { DaemonClient, FileReadResult } from "@omp-desktop/client/internal/daemon-client";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  useSessionStore,
  type AgentFileExplorerState,
  type ExplorerDirectory,
  type ExplorerEntry,
  type ExplorerFile,
} from "@/stores/session-store";
import { useFileExplorerActions } from "./use-file-explorer-actions";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const SERVER_ID = "file-explorer-race-server";
const WORKSPACE_ID = "workspace-1";
const WORKSPACE_ROOT = "/repo";
const WORKSPACE_STATE_KEY = `workspace:${WORKSPACE_ID}`;
const MODIFIED_AT = "2026-10-20T00:00:00.000Z";

const staleRoot: ExplorerDirectory = {
  path: ".",
  entries: [
    {
      name: "stale.txt",
      path: "stale.txt",
      kind: "file",
      size: 5,
      modifiedAt: MODIFIED_AT,
    },
  ],
};
const freshRoot: ExplorerDirectory = {
  path: ".",
  entries: [
    {
      name: "fresh.txt",
      path: "fresh.txt",
      kind: "file",
      size: 5,
      modifiedAt: MODIFIED_AT,
    },
  ],
};
const srcDirectory: ExplorerDirectory = {
  path: "src",
  entries: [
    {
      name: "index.ts",
      path: "src/index.ts",
      kind: "file",
      size: 5,
      modifiedAt: MODIFIED_AT,
    },
  ],
};
const docsDirectory: ExplorerDirectory = {
  path: "docs",
  entries: [
    {
      name: "guide.md",
      path: "docs/guide.md",
      kind: "file",
      size: 5,
      modifiedAt: MODIFIED_AT,
    },
  ],
};

interface PendingDirectoryRequest {
  path: string;
  promise: Promise<ExplorerDirectory>;
  resolve(value: ExplorerDirectory | PromiseLike<ExplorerDirectory>): void;
  reject(reason?: unknown): void;
}

interface PendingFileRequest {
  path: string;
  promise: Promise<FileReadResult>;
  resolve(value: FileReadResult | PromiseLike<FileReadResult>): void;
  reject(reason?: unknown): void;
}

let pendingRequests: PendingDirectoryRequest[];
let pendingFileRequests: PendingFileRequest[];
interface TestClient {
  listDirectory: Mock<(cwd: string, path: string) => Promise<ExplorerDirectory>>;
  readFile: Mock<(cwd: string, path: string) => Promise<FileReadResult>>;
  deleteFileEntry: Mock<() => Promise<{ success: boolean }>>;
  renameFileEntry: Mock<() => Promise<{ success: boolean }>>;
  moveFileEntry: Mock<() => Promise<{ success: boolean }>>;
}

let client: TestClient;

function createTestClient(): TestClient {
  return {
    listDirectory: vi.fn((_cwd: string, path: string) => {
      const pending = Promise.withResolvers<ExplorerDirectory>();
      pendingRequests.push({ path, ...pending });
      return pending.promise;
    }),
    readFile: vi.fn((_cwd: string, path: string) => {
      const pending = Promise.withResolvers<FileReadResult>();
      pendingFileRequests.push({ path, ...pending });
      return pending.promise;
    }),
    deleteFileEntry: vi.fn(async () => ({ success: true })),
    renameFileEntry: vi.fn(async () => ({ success: true })),
    moveFileEntry: vi.fn(async () => ({ success: true })),
  };
}

function directoryEntry(path: string, kind: ExplorerEntry["kind"] = "directory"): ExplorerEntry {
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    kind,
    size: 5,
    modifiedAt: MODIFIED_AT,
  };
}

function textFile(path: string): FileReadResult {
  return {
    path,
    bytes: new Uint8Array([65]),
    mime: "text/plain",
    kind: "text",
    size: 1,
    modifiedAt: MODIFIED_AT,
  };
}

function seedExplorerState(
  directories: ExplorerDirectory[] = [],
  filePaths: string[] = [],
): AgentFileExplorerState {
  const state: AgentFileExplorerState = {
    requestScope: {},
    directories: new Map(directories.map((directory) => [directory.path, directory])),
    files: new Map<string, ExplorerFile>(
      filePaths.map((path) => [
        path,
        {
          path,
          kind: "text",
          encoding: "utf-8",
          content: "cached",
          hasBom: false,
          size: 6,
          modifiedAt: MODIFIED_AT,
        },
      ]),
    ),
    refreshRevision: 0,
    isLoading: false,
    lastError: null,
    pendingRequest: null,
    currentPath: ".",
    history: ["."],
    lastVisitedPath: ".",
    selectedEntryPath: null,
  };
  useSessionStore.getState().setFileExplorer(SERVER_ID, new Map([[WORKSPACE_STATE_KEY, state]]));
  return state;
}

function explorerState() {
  return useSessionStore.getState().sessions[SERVER_ID]?.fileExplorer.get(WORKSPACE_STATE_KEY);
}

function renderExplorerActions() {
  return renderHook(() =>
    useFileExplorerActions({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      workspaceRoot: WORKSPACE_ROOT,
    }),
  );
}

beforeEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
  pendingRequests = [];
  pendingFileRequests = [];
  client = createTestClient();
  useSessionStore.getState().initializeSession(SERVER_ID, client as unknown as DaemonClient);
});

afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("useFileExplorerActions directory request ordering", () => {
  it("keeps the newer listing when an older request for the same directory resolves last", async () => {
    const { result } = renderHook(() =>
      useFileExplorerActions({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: WORKSPACE_ROOT,
      }),
    );
    let olderRequest!: Promise<ExplorerDirectory | null>;
    let newerRequest!: Promise<ExplorerDirectory | null>;

    act(() => {
      olderRequest = result.current.requestDirectoryListing(".");
      newerRequest = result.current.requestDirectoryListing(".");
    });
    expect(pendingRequests.map((request) => request.path)).toEqual([".", "."]);

    await act(async () => {
      pendingRequests[1]!.resolve(freshRoot);
      await newerRequest;
    });
    expect(
      useSessionStore
        .getState()
        .sessions[SERVER_ID]?.fileExplorer.get(WORKSPACE_STATE_KEY)
        ?.directories.get(".")
        ?.entries.map((entry) => entry.name),
    ).toEqual(["fresh.txt"]);

    await act(async () => {
      pendingRequests[0]!.resolve(staleRoot);
      await olderRequest;
    });
    const explorer = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.fileExplorer.get(WORKSPACE_STATE_KEY);
    expect(explorer?.directories.get(".")?.entries.map((entry) => entry.name)).toEqual([
      "fresh.txt",
    ]);
    expect(explorer?.lastError).toBeNull();
  });

  it("does not let an older failure replace a newer successful listing", async () => {
    const { result } = renderHook(() =>
      useFileExplorerActions({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: WORKSPACE_ROOT,
      }),
    );
    let olderRequest!: Promise<ExplorerDirectory | null>;
    let newerRequest!: Promise<ExplorerDirectory | null>;

    act(() => {
      olderRequest = result.current.requestDirectoryListing(".");
      newerRequest = result.current.requestDirectoryListing(".");
    });
    await act(async () => {
      pendingRequests[1]!.resolve(freshRoot);
      await newerRequest;
    });
    await act(async () => {
      pendingRequests[0]!.reject(new Error("stale request failed"));
      await olderRequest;
    });

    const explorer = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.fileExplorer.get(WORKSPACE_STATE_KEY);
    expect(explorer?.directories.get(".")?.entries.map((entry) => entry.name)).toEqual([
      "fresh.txt",
    ]);
    expect(explorer?.lastError).toBeNull();
  });

  it("keeps a newer same-directory error visible when the older listing succeeds later", async () => {
    const { result } = renderHook(() =>
      useFileExplorerActions({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: WORKSPACE_ROOT,
      }),
    );
    let olderRequest!: Promise<ExplorerDirectory | null>;
    let newerRequest!: Promise<ExplorerDirectory | null>;

    act(() => {
      olderRequest = result.current.requestDirectoryListing(".");
      newerRequest = result.current.requestDirectoryListing(".");
    });
    await act(async () => {
      pendingRequests[1]!.reject(new Error("newest request failed"));
      await newerRequest;
    });
    expect(
      useSessionStore.getState().sessions[SERVER_ID]?.fileExplorer.get(WORKSPACE_STATE_KEY)
        ?.lastError,
    ).toBe("newest request failed");

    await act(async () => {
      pendingRequests[0]!.resolve(staleRoot);
      await olderRequest;
    });
    const explorer = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.fileExplorer.get(WORKSPACE_STATE_KEY);
    expect(explorer?.directories.has(".")).toBe(false);
    expect(explorer?.lastError).toBe("newest request failed");
  });

  it("commits concurrent listings for different directories independently", async () => {
    const { result } = renderHook(() =>
      useFileExplorerActions({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: WORKSPACE_ROOT,
      }),
    );
    let srcRequest!: Promise<ExplorerDirectory | null>;
    let docsRequest!: Promise<ExplorerDirectory | null>;

    act(() => {
      srcRequest = result.current.requestDirectoryListing("src", {
        recordHistory: false,
        setCurrentPath: false,
      });
      docsRequest = result.current.requestDirectoryListing("docs", {
        recordHistory: false,
        setCurrentPath: false,
      });
    });
    await act(async () => {
      pendingRequests[1]!.resolve(docsDirectory);
      await docsRequest;
    });
    await act(async () => {
      pendingRequests[0]!.resolve(srcDirectory);
      await srcRequest;
    });

    const directories = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.fileExplorer.get(WORKSPACE_STATE_KEY)?.directories;
    expect(directories?.get("src")?.entries.map((entry) => entry.path)).toEqual(["src/index.ts"]);
    expect(directories?.get("docs")?.entries.map((entry) => entry.path)).toEqual(["docs/guide.md"]);
  });

  it("keeps a root refresh failure visible while a concurrent child listing succeeds", async () => {
    const { result } = renderHook(() =>
      useFileExplorerActions({
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: WORKSPACE_ROOT,
      }),
    );
    let rootRequest!: Promise<ExplorerDirectory | null>;
    let srcRequest!: Promise<ExplorerDirectory | null>;
    act(() => {
      rootRequest = result.current.requestDirectoryListing(".");
      srcRequest = result.current.requestDirectoryListing("src", {
        recordHistory: false,
        setCurrentPath: false,
      });
    });
    await act(async () => {
      pendingRequests[0]!.reject(new Error("root listing failed"));
      await rootRequest;
    });
    const whileLoading = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.fileExplorer.get(WORKSPACE_STATE_KEY);
    expect(whileLoading?.lastError).toBe("root listing failed");
    expect(whileLoading?.isLoading).toBe(true);
    expect(whileLoading?.pendingRequest).toEqual({ path: "src", mode: "list" });

    await act(async () => {
      pendingRequests[1]!.resolve(srcDirectory);
      await srcRequest;
    });
    const explorer = useSessionStore
      .getState()
      .sessions[SERVER_ID]?.fileExplorer.get(WORKSPACE_STATE_KEY);
    expect(explorer?.directories.get("src")?.entries.map((entry) => entry.path)).toEqual([
      "src/index.ts",
    ]);
    expect(explorer?.lastError).toBe("root listing failed");
    expect(explorer?.isLoading).toBe(false);
  });
});

describe("useFileExplorerActions directory cache lifetime", () => {
  it.each([".", "project"])(
    "prunes disappeared and non-directory subtrees beneath %s without evicting live collapsed siblings",
    async (parentPath) => {
      const childPath = (name: string) => (parentPath === "." ? name : `${parentPath}/${name}`);
      const removedPath = childPath("src");
      const livePath = childPath("src-old");
      const changedPath = childPath("changed");
      const keptFilePath = childPath("kept.txt");
      const removedFilePath = childPath("removed.txt");
      const liveDirectory: ExplorerDirectory = {
        path: livePath,
        entries: [directoryEntry(`${livePath}/index.ts`, "file")],
      };
      const unrelatedDirectory: ExplorerDirectory = { path: "unrelated", entries: [] };
      const initial = seedExplorerState(
        [
          { path: parentPath, entries: [] },
          { path: removedPath, entries: [] },
          { path: `${removedPath}/nested`, entries: [] },
          { path: changedPath, entries: [] },
          { path: `${changedPath}/nested`, entries: [] },
          liveDirectory,
          unrelatedDirectory,
        ],
        [
          `${removedPath}/nested/old.txt`,
          `${changedPath}/nested/old.txt`,
          `${livePath}/index.ts`,
          keptFilePath,
          removedFilePath,
          "unrelated/file.txt",
        ],
      );
      const { result } = renderExplorerActions();
      let request!: Promise<ExplorerDirectory | null>;
      act(() => {
        request = result.current.requestDirectoryListing(parentPath, {
          recordHistory: false,
          setCurrentPath: false,
        });
      });
      const listing: ExplorerDirectory = {
        path: parentPath,
        entries: [
          directoryEntry(livePath),
          // Symlinks, like regular files, are reported as kind "file" by the server.
          directoryEntry(changedPath, "file"),
          directoryEntry(keptFilePath, "file"),
          ...(parentPath === "." ? [directoryEntry("unrelated")] : []),
        ],
      };
      await act(async () => {
        pendingRequests[0]!.resolve(listing);
        await request;
      });

      const explorer = explorerState();
      expect(explorer?.directories.get(parentPath)).toBe(listing);
      expect(explorer?.directories.has(removedPath)).toBe(false);
      expect(explorer?.directories.has(`${removedPath}/nested`)).toBe(false);
      expect(explorer?.directories.has(changedPath)).toBe(false);
      expect(explorer?.directories.has(`${changedPath}/nested`)).toBe(false);
      expect(explorer?.directories.get(livePath)).toBe(liveDirectory);
      expect(explorer?.directories.get("unrelated")).toBe(unrelatedDirectory);
      expect([...explorer!.files.keys()].sort()).toEqual(
        [`${livePath}/index.ts`, keptFilePath, "unrelated/file.txt"].sort(),
      );
      expect(explorer?.files.get(`${livePath}/index.ts`)).toBe(
        initial.files.get(`${livePath}/index.ts`),
      );
    },
  );

  it("keeps cached subtrees and pending child requests when the parent listing fails", async () => {
    const initial = seedExplorerState(
      [srcDirectory, { path: "src/nested", entries: [] }],
      ["src/nested/cached.txt"],
    );
    const { result } = renderExplorerActions();
    let parentRequest!: Promise<ExplorerDirectory | null>;
    let childRequest!: Promise<ExplorerDirectory | null>;
    act(() => {
      parentRequest = result.current.requestDirectoryListing(".");
      childRequest = result.current.requestDirectoryListing("src/nested", {
        recordHistory: false,
        setCurrentPath: false,
      });
    });
    await act(async () => {
      pendingRequests[0]!.reject(new Error("parent unavailable"));
      await parentRequest;
    });
    expect(explorerState()?.directories).toBe(initial.directories);
    expect(explorerState()?.files).toBe(initial.files);
    expect(explorerState()?.pendingRequest).toEqual({ path: "src/nested", mode: "list" });
    expect(explorerState()?.isLoading).toBe(true);

    const nestedDirectory: ExplorerDirectory = {
      path: "src/nested",
      entries: [directoryEntry("src/nested/cached.txt", "file")],
    };
    await act(async () => {
      pendingRequests[1]!.resolve(nestedDirectory);
      await childRequest;
    });
    expect(explorerState()?.directories.get("src/nested")).toBe(nestedDirectory);
    expect(explorerState()?.files.get("src/nested/cached.txt")).toBe(
      initial.files.get("src/nested/cached.txt"),
    );
    expect(explorerState()?.lastError).toBe("parent unavailable");
  });

  it.each(["success", "failure"])(
    "ignores a late pruned child %s without canceling a live sibling request",
    async (outcome) => {
      seedExplorerState([srcDirectory, { path: "src-old", entries: [] }]);
      const { result } = renderExplorerActions();
      let parentRequest!: Promise<ExplorerDirectory | null>;
      let childRequest!: Promise<ExplorerDirectory | null>;
      let siblingRequest!: Promise<ExplorerDirectory | null>;
      act(() => {
        parentRequest = result.current.requestDirectoryListing(".");
        childRequest = result.current.requestDirectoryListing("src/nested", {
          recordHistory: false,
          setCurrentPath: false,
        });
      });
      await act(async () => {
        pendingRequests[0]!.resolve({
          path: ".",
          entries: [directoryEntry("src-old")],
        });
        await parentRequest;
      });
      expect(explorerState()?.isLoading).toBe(false);
      expect(explorerState()?.pendingRequest).toBeNull();
      expect(explorerState()?.directories.has("src")).toBe(false);

      act(() => {
        siblingRequest = result.current.requestDirectoryListing("src-old", {
          recordHistory: false,
          setCurrentPath: false,
        });
      });
      await act(async () => {
        if (outcome === "success") {
          pendingRequests[1]!.resolve({ path: "src/nested", entries: [] });
        } else {
          pendingRequests[1]!.reject(new Error("obsolete child error"));
        }
        expect(await childRequest).toEqual(
          outcome === "success" ? { path: "src/nested", entries: [] } : null,
        );
      });
      expect(explorerState()?.directories.has("src/nested")).toBe(false);
      expect(explorerState()?.lastError).toBeNull();
      expect(explorerState()?.pendingRequest).toEqual({ path: "src-old", mode: "list" });
      expect(explorerState()?.isLoading).toBe(true);

      const siblingDirectory: ExplorerDirectory = {
        path: "src-old",
        entries: [directoryEntry("src-old/live.txt", "file")],
      };
      await act(async () => {
        pendingRequests[2]!.resolve(siblingDirectory);
        await siblingRequest;
      });
      expect(explorerState()?.directories.get("src-old")).toBe(siblingDirectory);
      expect(explorerState()?.isLoading).toBe(false);
    },
  );

  it.each(["success", "failure"])(
    "ignores a late preview %s from a pruned subtree",
    async (outcome) => {
      seedExplorerState([srcDirectory], ["src/old.txt"]);
      const { result } = renderExplorerActions();
      let parentRequest!: Promise<ExplorerDirectory | null>;
      let previewRequest!: Promise<void>;
      act(() => {
        parentRequest = result.current.requestDirectoryListing(".");
        previewRequest = result.current.requestFilePreview("src/old.txt");
      });
      await act(async () => {
        pendingRequests[0]!.resolve({ path: ".", entries: [] });
        await parentRequest;
      });
      expect(explorerState()?.files.size).toBe(0);
      expect(explorerState()?.pendingRequest).toBeNull();
      expect(explorerState()?.isLoading).toBe(false);
      await act(async () => {
        if (outcome === "success") {
          pendingFileRequests[0]!.resolve(textFile("src/old.txt"));
        } else {
          pendingFileRequests[0]!.reject(new Error("obsolete preview error"));
        }
        await previewRequest;
      });
      expect(explorerState()?.files.size).toBe(0);
      expect(explorerState()?.lastError).toBeNull();
    },
  );
});

describe("useFileExplorerActions confirmed local mutations", () => {
  it.each(["delete", "rename", "move"] as const)(
    "invalidates only the obsolete subtree after a confirmed %s even if refresh fails",
    async (operation) => {
      const siblingDirectory: ExplorerDirectory = { path: "src-old", entries: [] };
      seedExplorerState(
        [
          srcDirectory,
          { path: "src/nested", entries: [] },
          siblingDirectory,
          { path: "target", entries: [] },
        ],
        ["src/nested/old.txt", "src-old/keep.txt"],
      );
      const confirmation = Promise.withResolvers<{ success: boolean }>();
      client.deleteFileEntry.mockReturnValue(confirmation.promise);
      client.renameFileEntry.mockReturnValue(confirmation.promise);
      client.moveFileEntry.mockReturnValue(confirmation.promise);
      const { result } = renderExplorerActions();
      let childRequest!: Promise<ExplorerDirectory | null>;
      let previewRequest!: Promise<void>;
      let mutation!: Promise<unknown>;
      act(() => {
        childRequest = result.current.requestDirectoryListing("src/nested", {
          recordHistory: false,
          setCurrentPath: false,
        });
        previewRequest = result.current.requestFilePreview("src/nested/old.txt");
        if (operation === "delete") {
          mutation = result.current.deleteEntry("src");
        } else if (operation === "rename") {
          mutation = result.current.renameEntry({ path: "src", name: "renamed" });
        } else {
          mutation = result.current.moveEntry({ path: "src", parentPath: "target" });
        }
      });
      expect(explorerState()?.directories.has("src/nested")).toBe(true);
      expect(explorerState()?.files.has("src/nested/old.txt")).toBe(true);

      await act(async () => {
        confirmation.resolve({ success: true });
        await Promise.resolve();
      });
      expect(pendingRequests.map((request) => request.path)).toEqual(
        operation === "move" ? ["src/nested", ".", "target"] : ["src/nested", "."],
      );
      expect(explorerState()?.directories.has("src")).toBe(false);
      expect(explorerState()?.directories.has("src/nested")).toBe(false);
      expect(explorerState()?.files.has("src/nested/old.txt")).toBe(false);
      expect(explorerState()?.directories.get("src-old")).toBe(siblingDirectory);
      expect(explorerState()?.files.has("src-old/keep.txt")).toBe(true);
      const pendingRefresh = explorerState()?.pendingRequest;

      await act(async () => {
        pendingRequests[0]!.resolve({ path: "src/nested", entries: [] });
        pendingFileRequests[0]!.resolve(textFile("src/nested/old.txt"));
        await Promise.all([childRequest, previewRequest]);
      });
      expect(explorerState()?.directories.has("src/nested")).toBe(false);
      expect(explorerState()?.files.has("src/nested/old.txt")).toBe(false);
      expect(explorerState()?.pendingRequest).toBe(pendingRefresh);
      expect(explorerState()?.isLoading).toBe(true);

      await act(async () => {
        for (const request of pendingRequests.slice(1)) {
          request.reject(new Error("refresh failed"));
        }
        expect(await mutation).toEqual({ success: true });
      });
      expect(explorerState()?.directories.has("src")).toBe(false);
      expect(explorerState()?.directories.has("src/nested")).toBe(false);
      expect(explorerState()?.directories.get("src-old")).toBe(siblingDirectory);
      expect(explorerState()?.files.has("src-old/keep.txt")).toBe(true);
      expect(explorerState()?.lastError).toBe("refresh failed");
      expect(explorerState()?.isLoading).toBe(false);
    },
  );

  it("does not invalidate or refresh an unconfirmed deletion", async () => {
    const initial = seedExplorerState([srcDirectory], ["src/index.ts"]);
    client.deleteFileEntry.mockResolvedValue({ success: false });
    const { result } = renderExplorerActions();
    await act(async () => {
      expect(await result.current.deleteEntry("src")).toEqual({ success: false });
    });
    expect(explorerState()).toBe(initial);
    expect(client.listDirectory).not.toHaveBeenCalled();
  });

  it.each(["removed", "recreated"] as const)(
    "does not apply a delayed mutation confirmation to a %s explorer cache",
    async (lifecycle) => {
      seedExplorerState([srcDirectory], ["src/index.ts"]);
      const confirmation = Promise.withResolvers<{ success: boolean }>();
      client.deleteFileEntry.mockReturnValue(confirmation.promise);
      const { result } = renderExplorerActions();
      let mutation!: Promise<unknown>;
      act(() => {
        mutation = result.current.deleteEntry("src");
      });
      let replacement: AgentFileExplorerState | undefined;
      act(() => {
        useSessionStore.getState().setFileExplorer(SERVER_ID, new Map());
        if (lifecycle === "recreated") {
          replacement = seedExplorerState([srcDirectory], ["src/index.ts"]);
        }
      });
      await act(async () => {
        confirmation.resolve({ success: true });
        expect(await mutation).toEqual({ success: true });
      });
      expect(explorerState()).toBe(replacement);
      expect(client.listDirectory).not.toHaveBeenCalled();
    },
  );
});

describe("useFileExplorerActions request cache ownership", () => {
  it.each([
    ["removed", "success"],
    ["removed", "failure"],
    ["recreated", "success"],
    ["recreated", "failure"],
    ["client-changed", "success"],
    ["client-changed", "failure"],
  ] as const)(
    "ignores obsolete directory and preview replies after cache %s (%s)",
    async (lifecycle, outcome) => {
      seedExplorerState([freshRoot], ["fresh.txt"]);
      const { result } = renderExplorerActions();
      let oldDirectoryRequest!: Promise<ExplorerDirectory | null>;
      let oldPreviewRequest!: Promise<void>;
      let currentDirectoryRequest: Promise<ExplorerDirectory | null> | null = null;
      act(() => {
        oldDirectoryRequest = result.current.requestDirectoryListing(".");
        oldPreviewRequest = result.current.requestFilePreview("stale.txt");
      });
      act(() => {
        if (lifecycle === "client-changed") {
          const nextClient = createTestClient();
          useSessionStore
            .getState()
            .updateSessionClient(SERVER_ID, nextClient as unknown as DaemonClient);
        } else {
          useSessionStore.getState().setFileExplorer(SERVER_ID, new Map());
          if (lifecycle === "recreated") {
            seedExplorerState([freshRoot], ["fresh.txt"]);
          }
        }
      });
      if (lifecycle !== "removed") {
        act(() => {
          currentDirectoryRequest = result.current.requestDirectoryListing(".");
        });
      }
      const currentState = explorerState();
      await act(async () => {
        if (outcome === "success") {
          pendingRequests[0]!.resolve(staleRoot);
          pendingFileRequests[0]!.resolve(textFile("stale.txt"));
        } else {
          pendingRequests[0]!.reject(new Error("obsolete directory failure"));
          pendingFileRequests[0]!.reject(new Error("obsolete preview failure"));
        }
        expect(await oldDirectoryRequest).toEqual(outcome === "success" ? staleRoot : null);
        await oldPreviewRequest;
      });
      expect(explorerState()).toBe(currentState);
      if (lifecycle === "removed") {
        expect(explorerState()).toBeUndefined();
      } else {
        expect(explorerState()?.directories.get(".")).toBe(freshRoot);
        expect([...explorerState()!.files.keys()]).toEqual(["fresh.txt"]);
        expect(explorerState()?.lastError).toBeNull();
        expect(explorerState()?.pendingRequest).toEqual({ path: ".", mode: "list" });
        expect(explorerState()?.isLoading).toBe(true);
        await act(async () => {
          pendingRequests[1]!.resolve(freshRoot);
          await currentDirectoryRequest;
        });
        expect(explorerState()?.directories.get(".")).toBe(freshRoot);
        expect(explorerState()?.pendingRequest).toBeNull();
        expect(explorerState()?.isLoading).toBe(false);
      }
    },
  );
});

describe("useFileExplorerActions concurrent subtree pruning", () => {
  it("keeps an already pending sibling listing active when pruning a vanished directory", async () => {
    seedExplorerState([srcDirectory, { path: "src-old", entries: [] }]);
    const { result } = renderExplorerActions();
    let parentRequest!: Promise<ExplorerDirectory | null>;
    let removedRequest!: Promise<ExplorerDirectory | null>;
    let siblingRequest!: Promise<ExplorerDirectory | null>;
    act(() => {
      parentRequest = result.current.requestDirectoryListing(".");
      removedRequest = result.current.requestDirectoryListing("src/nested", {
        recordHistory: false,
        setCurrentPath: false,
      });
      siblingRequest = result.current.requestDirectoryListing("src-old", {
        recordHistory: false,
        setCurrentPath: false,
      });
    });
    await act(async () => {
      pendingRequests[0]!.resolve({ path: ".", entries: [directoryEntry("src-old")] });
      await parentRequest;
    });
    expect(explorerState()?.directories.has("src")).toBe(false);
    expect(explorerState()?.pendingRequest).toEqual({ path: "src-old", mode: "list" });
    expect(explorerState()?.isLoading).toBe(true);
    await act(async () => {
      pendingRequests[1]!.reject(new Error("removed child failure"));
      await removedRequest;
    });
    expect(explorerState()?.lastError).toBeNull();
    expect(explorerState()?.pendingRequest).toEqual({ path: "src-old", mode: "list" });
    const siblingDirectory: ExplorerDirectory = {
      path: "src-old",
      entries: [directoryEntry("src-old/kept.txt", "file")],
    };
    await act(async () => {
      pendingRequests[2]!.resolve(siblingDirectory);
      await siblingRequest;
    });
    expect(explorerState()?.directories.get("src-old")).toBe(siblingDirectory);
    expect(explorerState()?.isLoading).toBe(false);
    expect(explorerState()?.pendingRequest).toBeNull();
  });
});
