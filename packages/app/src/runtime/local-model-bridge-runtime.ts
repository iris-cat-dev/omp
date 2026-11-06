import { useSyncExternalStore } from "react";
import { getDesktopDaemonStatus, shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import type { HostRuntimeStore } from "./host-runtime";
import { LocalModelBridgeController, type ModelBridgeConnection } from "./local-model-bridge";

let controller: LocalModelBridgeController | null = null;
let assertClientReady: ((client: object) => void) | null = null;

export function mountLocalModelBridgeRuntime(store: HostRuntimeStore): void {
  if (!shouldUseDesktopDaemon() || controller) return;
  const activeController = new LocalModelBridgeController();
  controller = activeController;
  const knownHosts = new Set<string>();
  let localServerId: string | null = null;
  let sourceIdentified = false;
  let sourceRevision = 0;
  let watchedSource: ModelBridgeConnection | null = null;
  let unwatchSource: (() => void) | null = null;
  let catalogHash: string | null = null;
  assertClientReady = (client) => {
    for (const host of store.getHosts()) {
      if (host.serverId === localServerId || store.getSnapshot(host.serverId)?.client !== client)
        continue;
      if (!sourceIdentified && host.modelSource !== undefined) {
        throw new Error(
          "Checking model source. Wait for Host Settings to report that the model source is ready.",
        );
      }
      const status = activeController.getStatus(host.serverId);
      if (status && status.status !== "ready" && status.status !== "remote") {
        throw new Error(
          status.error ?? "Model source is not ready. Check Host Settings before continuing.",
        );
      }
    }
  };
  const reconcile = () => {
    if (!sourceIdentified) return;
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
          // Only selectable catalog changes should interrupt active remote turns.
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
  const syncHosts = () => {
    const hosts = store.getHosts().filter((host) => host.serverId !== localServerId);
    const ids = new Set(hosts.map((host) => host.serverId));
    for (const serverId of knownHosts) {
      if (ids.has(serverId)) continue;
      knownHosts.delete(serverId);
      activeController.setProfile(serverId, null);
    }
    for (const host of hosts) {
      knownHosts.add(host.serverId);
      activeController.setProfile(host.serverId, host);
    }
    reconcile();
  };
  store.subscribeAll(reconcile);
  store.subscribeHostList(syncHosts);
  void getDesktopDaemonStatus()
    .then((status) => {
      localServerId = status.serverId || null;
      sourceIdentified = true;
      syncHosts();
    })
    .catch((error: unknown) => {
      console.error("[LocalModelBridge] Failed to identify local daemon", error);
      sourceIdentified = true;
      syncHosts();
    });
  syncHosts();
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
