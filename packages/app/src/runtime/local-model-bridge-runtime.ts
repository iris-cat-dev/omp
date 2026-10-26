import { useSyncExternalStore } from "react";
import { getDesktopHost, type DesktopRemoteSshProfile } from "@/desktop/host";
import { getDesktopDaemonStatus, shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import type { HostRuntimeStore } from "./host-runtime";
import { LocalModelBridgeController, type ModelBridgeConnection } from "./local-model-bridge";

let controller: LocalModelBridgeController | null = null;
let refreshProfile: ((serverId: string) => Promise<void>) | null = null;
let localServerId: string | null = null;
let assertClientReady: ((client: object) => void) | null = null;

export function mountLocalModelBridgeRuntime(store: HostRuntimeStore): void {
  const bridge = getDesktopHost()?.remoteSsh;
  if (!shouldUseDesktopDaemon() || !bridge?.getProfile || controller) return;
  const activeController = new LocalModelBridgeController();
  controller = activeController;
  const loaded = new Set<string>();
  const profileVersions = new Map<string, number>();
  const checking = new Set<string>();
  let sourceRevision = 0;
  let watchedSource: ModelBridgeConnection | null = null;
  let unwatchSource: (() => void) | null = null;
  let catalogHash: string | null = null;
  assertClientReady = (client) => {
    for (const host of store.getHosts()) {
      if (store.getSnapshot(host.serverId)?.client !== client) continue;
      if (!loaded.has(host.serverId) || checking.has(host.serverId)) {
        throw new Error(
          "Checking model source. Wait for Host Settings to report that the model source is ready.",
        );
      }
      const status = activeController.getStatus(host.serverId);
      if (status && status.status !== "ready" && status.status !== "remote") {
        throw new Error(
          status.error ??
            "Local model source is not ready. Check Host Settings; no remote fallback is used.",
        );
      }
    }
  };
  const reconcile = () => {
    const connections = new Map<string, ModelBridgeConnection>();
    for (const host of store.getHosts()) {
      const snapshot = store.getSnapshot(host.serverId);
      if (snapshot?.client && snapshot.connectionStatus === "online") {
        connections.set(host.serverId, {
          client: snapshot.client,
          generation: `${snapshot.clientGeneration}:${snapshot.connectionEpoch}`,
          supportsLocalModels: snapshot.client.supportsLocalModelBridge(),
        });
      }
    }
    const source = localServerId ? (connections.get(localServerId) ?? null) : null;
    if (
      source?.client !== watchedSource?.client ||
      source?.generation !== watchedSource?.generation
    ) {
      unwatchSource?.();
      unwatchSource = null;
      watchedSource = source;
      catalogHash = null;
      const sourceClient = localServerId ? store.getSnapshot(localServerId)?.client : null;
      if (source && sourceClient) {
        unwatchSource = sourceClient.on("providers_snapshot_update", (message) => {
          if (message.payload.cwd) return;
          const entry = message.payload.entries.find((candidate) => candidate.provider === "omp");
          if (!entry || entry.status === "loading" || entry.status === "error") return;
          // Refreshing timestamps or unrelated providers must not interrupt
          // active remote turns. Only the source's selectable catalog matters.
          const hash = JSON.stringify({ enabled: entry.enabled, models: entry.models });
          if (hash === catalogHash) return;
          catalogHash = hash;
          sourceRevision += 1;
          reconcile();
        });
      }
    }
    activeController.reconcile(
      source ? { ...source, generation: `${source.generation}:${sourceRevision}` } : null,
      connections,
    );
  };
  refreshProfile = async (serverId) => {
    const version = (profileVersions.get(serverId) ?? 0) + 1;
    profileVersions.set(serverId, version);
    checking.add(serverId);
    const profile = await bridge.getProfile!(serverId);
    if (
      profileVersions.get(serverId) !== version ||
      !store.getHosts().some((host) => host.serverId === serverId)
    )
      return;
    loaded.add(serverId);
    checking.delete(serverId);
    activeController.setProfile(serverId, profile);
    reconcile();
  };
  const syncHosts = () => {
    const ids = new Set(store.getHosts().map((host) => host.serverId));
    for (const serverId of loaded) {
      if (ids.has(serverId)) continue;
      loaded.delete(serverId);
      profileVersions.delete(serverId);
      checking.delete(serverId);
      activeController.setProfile(serverId, null);
    }
    for (const serverId of ids) {
      if (loaded.has(serverId)) continue;
      loaded.add(serverId);
      void refreshProfile?.(serverId).catch((error: unknown) => {
        console.error("[LocalModelBridge] Failed to load managed SSH profile", error);
      });
    }
    reconcile();
  };
  store.subscribeAll(reconcile);
  store.subscribeHostList(syncHosts);
  void getDesktopDaemonStatus()
    .then((status) => {
      localServerId = status.serverId || null;
      reconcile();
      return undefined;
    })
    .catch((error: unknown) => {
      console.error("[LocalModelBridge] Failed to identify local daemon", error);
    });
  syncHosts();
}

export async function reloadLocalModelBridgeProfile(serverId: string): Promise<void> {
  await refreshProfile?.(serverId);
}

export async function setSshModelSource(
  profile: DesktopRemoteSshProfile,
  modelSource: "local" | "remote",
): Promise<void> {
  const save = getDesktopHost()?.remoteSsh?.saveProfile;
  if (!save) throw new Error("Managed SSH profile settings are unavailable.");
  await save({ ...profile, modelSource });
  await reloadLocalModelBridgeProfile(profile.serverId);
}

export function useLocalModelBridgeStatus(serverId: string) {
  return useSyncExternalStore(
    (listener) => controller?.subscribe(listener) ?? (() => undefined),
    () => controller?.getStatus(serverId) ?? null,
    () => null,
  );
}

export function assertLocalModelBridgeReady(client: object): void {
  assertClientReady?.(client);
}
