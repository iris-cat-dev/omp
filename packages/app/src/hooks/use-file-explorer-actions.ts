import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  useSessionStore,
  type AgentFileExplorerState,
  type ExplorerDirectory,
} from "@/stores/session-store";
import { explorerFileFromReadResult } from "@/file-explorer/read-result";
import { parentExplorerPath } from "@/utils/explorer-paths";
import {
  buildWorkspaceExplorerStateKey,
  type FileExplorerWorkspaceScope,
} from "@/file-explorer/state-key";

function createExplorerState(): AgentFileExplorerState {
  return {
    requestScope: {},
    directories: new Map(),
    files: new Map(),
    refreshRevision: 0,
    isLoading: false,
    lastError: null,
    pendingRequest: null,
    currentPath: ".",
    history: ["."],
    lastVisitedPath: ".",
    selectedEntryPath: null,
  };
}

function pushHistory(history: string[], path: string): string[] {
  const normalizedHistory = history.length === 0 ? ["."] : history;
  const last = normalizedHistory[normalizedHistory.length - 1];
  if (last === path) {
    return normalizedHistory;
  }
  return [...normalizedHistory, path];
}

interface ExplorerRequest {
  path: string;
  mode: "list" | "file";
}

const latestRequestByScope = new WeakMap<object, Map<string, ExplorerRequest>>();

function getExplorerRequests(requestScope: object): Map<string, ExplorerRequest> {
  let requests = latestRequestByScope.get(requestScope);
  if (!requests) {
    requests = new Map();
    latestRequestByScope.set(requestScope, requests);
  }
  return requests;
}

function firstChildExplorerPath(parentPath: string, path: string): string | null {
  if (path === parentPath || path === ".") {
    return null;
  }
  const prefix = parentPath === "." ? "" : `${parentPath}/`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  const separator = path.indexOf("/", prefix.length);
  return separator === -1 ? path : path.slice(0, separator);
}

function pruneExplorerState(
  state: AgentFileExplorerState,
  shouldPrune: (path: string, mode: ExplorerRequest["mode"]) => boolean,
): AgentFileExplorerState {
  const requests = latestRequestByScope.get(state.requestScope);
  for (const [target, request] of requests ?? []) {
    if (shouldPrune(request.path, request.mode)) {
      requests!.delete(target);
    }
  }

  let directories = state.directories;
  for (const path of state.directories.keys()) {
    if (shouldPrune(path, "list")) {
      if (directories === state.directories) {
        directories = new Map(directories);
      }
      directories.delete(path);
    }
  }
  let files = state.files;
  for (const path of state.files.keys()) {
    if (shouldPrune(path, "file")) {
      if (files === state.files) {
        files = new Map(files);
      }
      files.delete(path);
    }
  }
  const cancelsPendingRequest =
    state.pendingRequest !== null &&
    shouldPrune(state.pendingRequest.path, state.pendingRequest.mode);
  if (directories === state.directories && files === state.files && !cancelsPendingRequest) {
    return state;
  }
  return {
    ...state,
    directories,
    files,
    ...(cancelsPendingRequest ? { isLoading: false, pendingRequest: null } : {}),
  };
}

export function useFileExplorerActions(params: { serverId: string } & FileExplorerWorkspaceScope) {
  const { t } = useTranslation();
  const { serverId, workspaceId, workspaceRoot } = params;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const setFileExplorer = useSessionStore((state) => state.setFileExplorer);
  const normalizedWorkspaceRoot = useMemo(() => {
    const trimmed = workspaceRoot?.trim();
    return trimmed ? trimmed : null;
  }, [workspaceRoot]);
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [workspaceId, normalizedWorkspaceRoot],
  );

  const updateExplorerState = useCallback(
    (
      updater: (prev: AgentFileExplorerState) => AgentFileExplorerState,
      expectedRequestScope?: object,
    ): object | null => {
      if (!workspaceStateKey || useSessionStore.getState().sessions[serverId]?.client !== client) {
        return null;
      }
      let requestScope: object | null = null;
      setFileExplorer(serverId, (prev) => {
        const existing = prev.get(workspaceStateKey);
        if (expectedRequestScope && existing?.requestScope !== expectedRequestScope) {
          return prev;
        }
        const current = existing ?? createExplorerState();
        requestScope = current.requestScope;
        const updated = updater(current);
        if (updated === existing) {
          return prev;
        }
        const next = new Map(prev);
        next.set(workspaceStateKey, updated);
        return next;
      });
      return requestScope;
    },
    [client, serverId, setFileExplorer, workspaceStateKey],
  );

  const invalidateSubtree = useCallback(
    (requestScope: object, path: string) =>
      updateExplorerState(
        (state) =>
          pruneExplorerState(
            state,
            (target) => path === "." || target === path || target.startsWith(`${path}/`),
          ),
        requestScope,
      ),
    [updateExplorerState],
  );

  const requestDirectoryListing = useCallback(
    async (
      path: string,
      options?: { recordHistory?: boolean; setCurrentPath?: boolean },
    ): Promise<ExplorerDirectory | null> => {
      if (!workspaceStateKey) {
        return null;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      const shouldSetCurrentPath = options?.setCurrentPath ?? true;
      const shouldRecordHistory = options?.recordHistory ?? shouldSetCurrentPath;
      const requestScope = updateExplorerState((state) => ({
        ...state,
        isLoading: true,
        lastError: null,
        pendingRequest: { path: normalizedPath, mode: "list" },
        ...(shouldSetCurrentPath
          ? {
              currentPath: normalizedPath,
              history: shouldRecordHistory
                ? pushHistory(state.history, normalizedPath)
                : state.history,
              lastVisitedPath: normalizedPath,
            }
          : {}),
      }));
      if (!requestScope) {
        return null;
      }
      const requests = getExplorerRequests(requestScope);
      const requestTarget = `list:${normalizedPath}`;
      const requestToken: ExplorerRequest = { path: normalizedPath, mode: "list" };
      requests.set(requestTarget, requestToken);

      try {
        if (!normalizedWorkspaceRoot || !client) {
          updateExplorerState(
            (state) => ({
              ...state,
              isLoading: false,
              lastError: t(
                !normalizedWorkspaceRoot
                  ? "workspace.fileExplorer.states.unavailable"
                  : "workspace.terminal.hostDisconnected",
              ),
              pendingRequest: null,
            }),
            requestScope,
          );
          return null;
        }

        const directory = await client.listDirectory(normalizedWorkspaceRoot, normalizedPath);
        if (requests.get(requestTarget) !== requestToken) {
          return directory;
        }
        updateExplorerState((state) => {
          const entryKinds = new Map<string, "file" | "directory">();
          for (const entry of directory.entries) {
            entryKinds.set(entry.path, entry.kind);
          }
          const prunedState = pruneExplorerState(state, (targetPath, mode) => {
            const childPath = firstChildExplorerPath(directory.path, targetPath);
            if (childPath === null) {
              return false;
            }
            const expectedKind = mode === "file" && childPath === targetPath ? "file" : "directory";
            return entryKinds.get(childPath) !== expectedKind;
          });
          const ownsLoadingState =
            prunedState.pendingRequest?.mode === "list" &&
            prunedState.pendingRequest.path === normalizedPath;
          const directories = new Map(prunedState.directories);
          directories.set(directory.path, directory);
          return {
            ...prunedState,
            isLoading: ownsLoadingState ? false : prunedState.isLoading,
            pendingRequest: ownsLoadingState ? null : prunedState.pendingRequest,
            directories,
          };
        }, requestScope);
        return directory;
      } catch (error) {
        if (requests.get(requestTarget) !== requestToken) {
          return null;
        }
        updateExplorerState((state) => {
          const ownsLoadingState =
            state.pendingRequest?.mode === "list" && state.pendingRequest.path === normalizedPath;
          // A failed root listing must remain visible even when a child is loading.
          return {
            ...state,
            isLoading: ownsLoadingState ? false : state.isLoading,
            lastError:
              error instanceof Error
                ? error.message
                : t("workspace.fileExplorer.errors.failedToListDirectory"),
            pendingRequest: ownsLoadingState ? null : state.pendingRequest,
          };
        }, requestScope);
        return null;
      } finally {
        if (requests.get(requestTarget) === requestToken) {
          requests.delete(requestTarget);
        }
      }
    },
    [client, normalizedWorkspaceRoot, t, updateExplorerState, workspaceStateKey],
  );

  const requestFilePreview = useCallback(
    async (path: string) => {
      if (!workspaceStateKey) {
        return;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      const requestScope = updateExplorerState((state) => ({
        ...state,
        isLoading: true,
        lastError: null,
        pendingRequest: { path: normalizedPath, mode: "file" },
      }));
      if (!requestScope) {
        return;
      }
      const requests = getExplorerRequests(requestScope);
      const requestTarget = `file:${normalizedPath}`;
      const requestToken: ExplorerRequest = { path: normalizedPath, mode: "file" };
      requests.set(requestTarget, requestToken);

      try {
        if (!normalizedWorkspaceRoot || !client) {
          updateExplorerState(
            (state) => ({
              ...state,
              isLoading: false,
              lastError: t(
                !normalizedWorkspaceRoot
                  ? "workspace.fileExplorer.states.unavailable"
                  : "workspace.terminal.hostDisconnected",
              ),
              pendingRequest: null,
            }),
            requestScope,
          );
          return;
        }

        const file = await client.readFile(normalizedWorkspaceRoot, normalizedPath);
        if (requests.get(requestTarget) !== requestToken) {
          return;
        }
        updateExplorerState((state) => {
          const ownsLoadingState =
            state.pendingRequest?.mode === "file" && state.pendingRequest.path === normalizedPath;
          const files = new Map(state.files);
          const explorerFile = explorerFileFromReadResult(file);
          files.set(explorerFile.path, explorerFile);
          return {
            ...state,
            isLoading: ownsLoadingState ? false : state.isLoading,
            pendingRequest: ownsLoadingState ? null : state.pendingRequest,
            files,
          };
        }, requestScope);
      } catch (error) {
        if (requests.get(requestTarget) !== requestToken) {
          return;
        }
        updateExplorerState((state) => {
          const ownsLoadingState =
            state.pendingRequest?.mode === "file" && state.pendingRequest.path === normalizedPath;
          return {
            ...state,
            isLoading: ownsLoadingState ? false : state.isLoading,
            lastError:
              error instanceof Error ? error.message : t("panels.file.failedToLoadPreview"),
            pendingRequest: ownsLoadingState ? null : state.pendingRequest,
          };
        }, requestScope);
      } finally {
        if (requests.get(requestTarget) === requestToken) {
          requests.delete(requestTarget);
        }
      }
    },
    [client, normalizedWorkspaceRoot, t, updateExplorerState, workspaceStateKey],
  );

  const requestFileDownloadToken = useCallback(
    async (path: string) => {
      if (!normalizedWorkspaceRoot) {
        throw new Error(t("workspace.fileExplorer.states.unavailable"));
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.requestDownloadToken(normalizedWorkspaceRoot, path);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, t],
  );

  const createEntry = useCallback(
    async (input: { parentPath: string; name: string; kind: "file" | "directory" }) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const requestScope = updateExplorerState((state) => state);
      if (!requestScope) {
        return null;
      }
      const payload = await client.createFileEntry({
        cwd: normalizedWorkspaceRoot,
        ...input,
      });
      if (payload.success && updateExplorerState((state) => state, requestScope)) {
        await requestDirectoryListing(input.parentPath, {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing, updateExplorerState],
  );

  const renameEntry = useCallback(
    async (input: { path: string; name: string }) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const requestScope = updateExplorerState((state) => state);
      if (!requestScope) {
        return null;
      }
      const payload = await client.renameFileEntry({
        cwd: normalizedWorkspaceRoot,
        ...input,
      });
      if (payload.success && invalidateSubtree(requestScope, input.path)) {
        await requestDirectoryListing(parentExplorerPath(input.path), {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [
      client,
      invalidateSubtree,
      normalizedWorkspaceRoot,
      requestDirectoryListing,
      updateExplorerState,
    ],
  );
  const moveEntry = useCallback(
    async (input: { path: string; parentPath: string }) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const requestScope = updateExplorerState((state) => state);
      if (!requestScope) {
        return null;
      }
      const payload = await client.moveFileEntry({
        cwd: normalizedWorkspaceRoot,
        ...input,
      });
      if (payload.success && invalidateSubtree(requestScope, input.path)) {
        const previousParentPath = parentExplorerPath(input.path);
        const changedParentPaths =
          previousParentPath === input.parentPath
            ? [previousParentPath]
            : [previousParentPath, input.parentPath];
        await Promise.all(
          changedParentPaths.map((path) =>
            requestDirectoryListing(path, {
              recordHistory: false,
              setCurrentPath: false,
            }),
          ),
        );
      }
      return payload;
    },
    [
      client,
      invalidateSubtree,
      normalizedWorkspaceRoot,
      requestDirectoryListing,
      updateExplorerState,
    ],
  );

  const duplicateEntry = useCallback(
    async (path: string) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const requestScope = updateExplorerState((state) => state);
      if (!requestScope) {
        return null;
      }
      const payload = await client.duplicateFileEntry({ cwd: normalizedWorkspaceRoot, path });
      if (payload.success && updateExplorerState((state) => state, requestScope)) {
        await requestDirectoryListing(parentExplorerPath(path), {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing, updateExplorerState],
  );

  const deleteEntry = useCallback(
    async (path: string) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const requestScope = updateExplorerState((state) => state);
      if (!requestScope) {
        return null;
      }
      const payload = await client.deleteFileEntry({ cwd: normalizedWorkspaceRoot, path });
      if (payload.success && invalidateSubtree(requestScope, path)) {
        await requestDirectoryListing(parentExplorerPath(path), {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [
      client,
      invalidateSubtree,
      normalizedWorkspaceRoot,
      requestDirectoryListing,
      updateExplorerState,
    ],
  );

  const selectExplorerEntry = useCallback(
    (path: string | null) => {
      updateExplorerState((state) => ({
        ...state,
        selectedEntryPath: path,
      }));
    },
    [updateExplorerState],
  );

  return {
    workspaceStateKey,
    requestDirectoryListing,
    requestFilePreview,
    requestFileDownloadToken,
    createEntry,
    renameEntry,
    moveEntry,
    duplicateEntry,
    deleteEntry,
    selectExplorerEntry,
  };
}
