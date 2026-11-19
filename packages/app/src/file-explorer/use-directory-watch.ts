import { useEffect, useRef } from "react";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";

const REFRESH_BATCH_MS = 60;

interface ExpandedDirectoryWatch {
  update(paths: ReadonlySet<string>, pendingEdit: boolean): void;
  dispose(): void;
}

function watchExpandedDirectories({
  client,
  cwd,
  listDirectory,
}: {
  client: DaemonClient;
  cwd: string;
  listDirectory: DirectoryWatchOptions["listDirectory"];
}): ExpandedDirectoryWatch {
  const subscriptions = new Map<string, () => void>();
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let editing = false;

  function schedule() {
    if (timer !== undefined || editing || dirty.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (editing) return;
      for (const path of dirty) void listDirectory(path, { background: true });
      dirty.clear();
    }, REFRESH_BATCH_MS);
  }

  return {
    update(paths: ReadonlySet<string>, pendingEdit: boolean) {
      editing = pendingEdit;
      for (const [path, stop] of subscriptions) {
        if (paths.has(path)) continue;
        stop();
        subscriptions.delete(path);
        dirty.delete(path);
      }
      for (const path of paths) {
        if (subscriptions.has(path)) continue;
        subscriptions.set(
          path,
          client.watchDirectory({ cwd, path }, () => {
            dirty.add(path);
            schedule();
          }),
        );
      }
      schedule();
    },
    dispose() {
      clearTimeout(timer);
      for (const stop of subscriptions.values()) stop();
    },
  };
}

interface DirectoryWatchOptions {
  serverId: string;
  workspaceStateKey: string | null;
  cwd: string;
  active: boolean;
  editing: boolean;
  paths: ReadonlySet<string>;
  listDirectory: (path: string, options: { background: true }) => Promise<unknown>;
}

export function useExplorerDirectoryWatch({
  serverId,
  workspaceStateKey,
  cwd,
  active,
  editing,
  paths,
  listDirectory,
}: DirectoryWatchOptions): void {
  const client = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return session?.serverInfo?.features?.fsDirectoryWatch === true ? session.client : null;
  });
  const watch = useRef<ExpandedDirectoryWatch | null>(null);
  useEffect(() => {
    if (!client || !active) return;
    const subscription = watchExpandedDirectories({ client, cwd, listDirectory });
    watch.current = subscription;
    return () => {
      watch.current = null;
      subscription.dispose();
    };
  }, [active, client, cwd, listDirectory, workspaceStateKey]);

  // Reconcile retained subscriptions when the tree changes without restarting unchanged paths.
  useEffect(() => {
    watch.current?.update(paths, editing);
  }, [active, client, cwd, editing, listDirectory, paths, workspaceStateKey]);
}
