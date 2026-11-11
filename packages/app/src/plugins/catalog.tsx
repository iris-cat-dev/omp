import { useEffect, useSyncExternalStore } from "react";
import { createActivationScope, createPluginPaseoApi, type PluginActivationScope } from "@omp-desktop/plugin/host";
import { createPaseoApi } from "@omp-desktop/client";
import type { DaemonClient } from "@omp-desktop/client/internal/daemon-client";
import type { DesktopPluginCatalogEntry } from "@omp-desktop/protocol/desktop-plugins";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { hasPluginClientTrust, subscribePluginClientTrust } from "./client-trust";
import { setupPluginClient } from "./context";
import { loadTrustedPluginClient } from "./load";
import { pluginClientRegistry, pluginInstanceKey } from "./registry";

export interface DaemonPluginCatalogSnapshot {
  status: "loading" | "ready" | "offline" | "error";
  plugins: readonly DesktopPluginCatalogEntry[];
  revision: number;
  pluginsEnabled: boolean;
  error: string | null;
}
const empty: DaemonPluginCatalogSnapshot = { status: "offline", plugins: [], revision: -1, pluginsEnabled: false, error: null };
const snapshots = new Map<string, DaemonPluginCatalogSnapshot>();
const listeners = new Set<() => void>();
const reloaders = new Map<string, () => Promise<void>>();
function publish(hostId: string, snapshot: DaemonPluginCatalogSnapshot) {
  snapshots.set(hostId, snapshot);
  for (const listener of listeners) listener();
}
export function useDaemonPluginCatalog(hostId?: string) {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => hostId ? snapshots.get(hostId) ?? empty : empty,
    () => empty,
  );
}
export async function reloadDaemonPluginCatalog(hostId: string) {
  const reload = reloaders.get(hostId);
  if (!reload) throw new Error("Plugin host is offline");
  await reload();
}

function pluginServices(client: DaemonClient, entry: DesktopPluginCatalogEntry, scope: PluginActivationScope, mode: "manage" | "active") {
  return {
    getPaseo: () => createPluginPaseoApi(createPaseoApi(client), entry, scope, { mode, legacy: entry.format === "legacy" }),
    storage: {
      get: async <T,>() => { const snapshot = await client.getPluginStorage(entry.id, entry.generation); return { revision: snapshot.revision, values: snapshot.values as T }; },
      patch: async <T,>(fields: Partial<T>, revision: number) => { const snapshot = await client.patchPluginStorage(entry.id, fields as Record<string, unknown>, revision, entry.generation); return { revision: snapshot.revision, values: snapshot.values as T }; },
    },
    secrets: {
      configured: async (key: string) => await client.setPluginSecret(entry.id, key, "configured", undefined, entry.generation),
      set: async (key: string, value: string) => { await client.setPluginSecret(entry.id, key, "set", value, entry.generation); },
      delete: async (key: string) => { await client.setPluginSecret(entry.id, key, "delete", undefined, entry.generation); },
    },
    native: {
      invoke: async <T,>(operation: string, input?: unknown) => await client.invokePluginRpc(entry.id, operation, input, entry.generation) as T,
      subscribe(event: string, listener: (payload: unknown) => void) {
        return client.on("status", (message) => {
          if (message.payload.status === "plugin_catalog_changed" && message.payload.pluginId === entry.id && event === "plugins:changed") listener(message.payload);
        });
      },
    },
    invoke: (method: string, input: unknown) => client.invokePluginRpc(entry.id, method, input, entry.generation),
  };
}

export function HostPluginCatalogBridge({ hostId }: { hostId: string }) {
  const runtime = useHostRuntimeSnapshot(hostId);
  const client = runtime?.client;
  const online = runtime?.connectionStatus === "online";
  const epoch = runtime?.connectionEpoch;
  useEffect(() => {
    if (!client || !online) {
      publish(hostId, { ...snapshots.get(hostId) ?? empty, status: "offline" });
      return;
    }
    const lifetime = new AbortController();
    const running = new Map<string, { signature: string; bundle: string; scope: PluginActivationScope }>();
    const retiring = new Map<string, Promise<void>>();
    let desired = new Map<string, { signature: string; bundle: string; mode: "manage" | "active" }>();
    let currentRevision = -1;
    let queue: Promise<void> = Promise.resolve();
    let refreshSequence = 0;
    publish(hostId, { ...snapshots.get(hostId) ?? empty, status: "loading", error: null });

    function describe(entry: DesktopPluginCatalogEntry) {
      const mode = entry.effectiveEnabled && (entry.status === "running" || entry.status === "waiting") ? "active" as const : "manage" as const;
      if (!entry.trusted || !entry.clientBundle || (entry.format === "legacy" && mode === "manage")) return null;
      return { mode, bundle: entry.clientBundle, signature: JSON.stringify([entry.id, entry.packageId, entry.format, entry.generation, entry.version, entry.source, entry.trusted, entry.declaredCapabilities, entry.grantedCapabilities, mode]) };
    }
    function isDesired(key: string, candidate: { signature: string; bundle: string }) {
      const current = desired.get(key);
      return !lifetime.signal.aborted && current?.signature === candidate.signature && current.bundle === candidate.bundle;
    }
    async function stop(key: string) {
      const current = running.get(key);
      if (!current) { await retiring.get(key); return; }
      running.delete(key);
      pluginClientRegistry.remove(key, current.scope);
      const cleanup = current.scope.dispose().catch((error: unknown) => pluginClientRegistry.fail(key, error, current.scope));
      retiring.set(key, cleanup);
      await cleanup;
      if (retiring.get(key) === cleanup) retiring.delete(key);
    }
    async function reconcile(entries: readonly DesktopPluginCatalogEntry[]) {
      if (lifetime.signal.aborted) return;
      for (const entry of entries) {
        if (lifetime.signal.aborted) return;
        const key = pluginInstanceKey(hostId, entry.id, "daemon");
        const candidate = describe(entry);
        if (!candidate || !isDesired(key, candidate)) continue;
        const previous = running.get(key);
        if (previous && !previous.scope.signal.aborted && previous.signature === candidate.signature && previous.bundle === candidate.bundle) continue;
        await stop(key);
        if (!isDesired(key, candidate)) continue;
        const trusted = await hasPluginClientTrust(hostId, entry);
        if (!isDesired(key, candidate)) continue;
        if (!trusted) {
          pluginClientRegistry.fail(key, "This plugin client has not been trusted on this device");
          continue;
        }
        if (!isDesired(key, candidate)) continue;
        const { mode, signature, bundle } = candidate;
        const scope = createActivationScope(entry.generation);
        pluginClientRegistry.begin(key, scope);
        running.set(key, { signature, bundle, scope });
        try {
          const instance = await setupPluginClient({ hostId, installation: entry, format: entry.format, mode, scope, services: pluginServices(client!, entry, scope, mode), setup: loadTrustedPluginClient(bundle), changed: () => pluginClientRegistry.changed(key) });
          if (!instance || !isDesired(key, candidate) || scope.signal.aborted) { await stop(key); continue; }
          pluginClientRegistry.replace(instance);
        } catch (error) {
          await scope.dispose().catch((cleanupError: unknown) => pluginClientRegistry.fail(key, cleanupError, scope));
          if (isDesired(key, candidate)) pluginClientRegistry.fail(key, error, scope);
        }
      }
    }
    async function refresh() {
      const sequence = ++refreshSequence;
      try {
        const result = await client!.getPluginCatalogSnapshot();
        if (lifetime.signal.aborted || sequence !== refreshSequence || result.revision < currentRevision) return;
        currentRevision = result.revision;
        publish(hostId, { status: "ready", plugins: result.plugins, revision: result.revision, pluginsEnabled: result.pluginsEnabled, error: null });
        const entries = result.plugins;
        desired = new Map(entries.flatMap((entry) => { const candidate = describe(entry); return candidate ? [[pluginInstanceKey(hostId, entry.id, "daemon"), candidate] as const] : []; }));
        for (const [key, current] of running) if (!isDesired(key, current)) void stop(key);
        const run = () => reconcile(entries);
        queue = queue.then(run, run);
        await queue;
      } catch (error) {
        if (!lifetime.signal.aborted) publish(hostId, { ...snapshots.get(hostId) ?? empty, status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    }
    reloaders.set(hostId, refresh);
    const off = client.on("status", (message) => {
      if (message.payload.status !== "plugin_catalog_changed") return;
      if (typeof message.payload.pluginId === "string") {
        const key = pluginInstanceKey(hostId, message.payload.pluginId, "daemon");
        const current = running.get(key);
        if (message.payload.generation !== current?.scope.generation) {
          desired.delete(key);
          void stop(key);
        }
      } else {
        desired.clear();
        for (const key of running.keys()) void stop(key);
      }
      void refresh();
    });
    const offTrust = subscribePluginClientTrust((installation) => {
      if (installation.hostId !== hostId) return;
      desired.delete(pluginInstanceKey(hostId, installation.installationId, "daemon"));
      void stop(pluginInstanceKey(hostId, installation.installationId, "daemon"));
      void refresh();
    });
    void refresh();
    return () => {
      lifetime.abort();
      off();
      offTrust();
      if (reloaders.get(hostId) === refresh) reloaders.delete(hostId);
      for (const [key, current] of running) {
        pluginClientRegistry.remove(key, current.scope);
        void current.scope.dispose().catch((error: unknown) => pluginClientRegistry.fail(key, error, current.scope));
      }
      running.clear();
    };
  }, [client, online, epoch, hostId]);
  return null;
}
