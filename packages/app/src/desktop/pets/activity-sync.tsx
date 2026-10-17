import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useShallow } from "zustand/shallow";
import { useTranslation } from "react-i18next";
import { useAppSettings } from "@/hooks/use-settings";
import { DEFAULT_UI_FONT_STACK } from "@/styles/theme";
import { getDesktopHost } from "@/desktop/host";
import { useDesktopIpcErrorReporter } from "@/desktop/hooks/desktop-ipc-error";
import { useSessionStore } from "@/stores/session-store";
import {
  getHostRuntimeStore,
  useHosts,
  useHostRuntimeConnectionStatuses,
} from "@/runtime/host-runtime";
import { deriveDesktopPetTasks } from "./model";
import type { DesktopPetActivity } from "./types";

export function DesktopPetActivitySync() {
  return getDesktopHost()?.pet?.publishActivity ? <ConnectedDesktopPetActivitySync /> : null;
}

function ConnectedDesktopPetActivitySync() {
  "use no memo";
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const fontFamily = settings.uiFontFamily.trim() || DEFAULT_UI_FONT_STACK;
  const reportError = useDesktopIpcErrorReporter();
  const runtime = getHostRuntimeStore();
  const revalidations = useRef(
    new Map<
      string,
      {
        fingerprint: string;
        pending: Promise<void> | null;
      }
    >(),
  );
  const version = useSyncExternalStore(
    (onChange) => runtime.subscribeAll(onChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  // Renames update session metadata independently of committed directory activity.
  const namingSources = useSessionStore(
    useShallow((state) => {
      const sources: unknown[] = [];
      for (const serverId of serverIds) {
        const session = state.sessions[serverId];
        sources.push(session?.agents, session?.agentDetails, session?.workspaces);
      }
      return sources;
    }),
  );
  const activity = useMemo<DesktopPetActivity>(() => {
    // Match runtime selectors: this version invalidates reads of the mutable store.
    void version;
    void namingSources;
    const connectedServerIds = new Set(serverIds.filter((id) => statuses.get(id) === "online"));
    const tasks: DesktopPetActivity["tasks"] = [];
    const revisions: DesktopPetActivity["revisions"] = {};
    for (const serverId of connectedServerIds) {
      const publication = runtime.getAgentDirectoryPublication(serverId);
      if (!publication) continue;
      revisions[serverId] = publication.revision;
      tasks.push(
        ...deriveDesktopPetTasks(
          publication.agents.values(),
          connectedServerIds,
          t("desktop.pets.untitledTask"),
          serverId,
          useSessionStore.getState().sessions[serverId],
        ),
      );
    }
    return {
      tasks,
      revisions,
      connected: connectedServerIds.size > 0,
      serverIds: [...connectedServerIds],
      fontFamily,
      labels: {
        idle: t("desktop.pets.activity.idle"),
        offline: t("desktop.pets.activity.offline"),
        running: t("desktop.pets.activity.running"),
        needs_input: t("desktop.pets.activity.needsInput"),
        ready: t("desktop.pets.activity.ready"),
        blocked: t("desktop.pets.activity.blocked"),
        openApp: t("desktop.pets.activity.openApp"),
        openTask: t("desktop.pets.activity.openTask"),
        hide: t("desktop.pets.activity.hide"),
        resetPosition: t("desktop.pets.activity.resetPosition"),
        taskCount: t("desktop.pets.activity.taskCount"),
      },
    };
  }, [runtime, version, namingSources, serverIds, statuses, t, fontFamily]);

  useEffect(() => {
    const publish = getDesktopHost()?.pet?.publishActivity;
    if (!publish) return;
    for (const serverId of revalidations.current.keys()) {
      if (!activity.serverIds.includes(serverId)) revalidations.current.delete(serverId);
    }
    void publish(activity)
      .then(async ({ revalidate }) => {
        const pending: Promise<void>[] = [];
        for (const { serverId, generation } of revalidate) {
          const connection = runtime.getSnapshot(serverId);
          if (connection?.connectionStatus !== "online") continue;
          const fingerprint = JSON.stringify([
            generation,
            activity.revisions[serverId],
            connection.clientGeneration,
            connection.connectionEpoch,
          ]);
          const existing = revalidations.current.get(serverId);
          if (existing?.fingerprint === fingerprint) {
            if (existing.pending) pending.push(existing.pending);
            continue;
          }
          // One attempt for this directory/connection state. Failed reads are
          // reported, not retried by font/language/loading-state re-renders.
          const attempt = { fingerprint, pending: null as Promise<void> | null };
          const refresh = runtime
            .refreshAgentDirectory({ serverId, expectedGeneration: generation })
            .then(() => undefined)
            .finally(() => {
              attempt.pending = null;
            });
          attempt.pending = refresh;
          revalidations.current.set(serverId, attempt);
          pending.push(refresh);
        }
        await Promise.all(pending);
        return undefined;
      })
      .catch((error: unknown) =>
        reportError({
          error,
          message: t("desktop.pets.activityFailed"),
          logLabel: "[DesktopPet] Failed to publish activity",
        }),
      );
  }, [activity, reportError, runtime, t]);
  return null;
}
