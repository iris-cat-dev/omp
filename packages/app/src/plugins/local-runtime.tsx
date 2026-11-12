import { useEffect, useRef, useSyncExternalStore } from "react";
import { createActivationScope, createPluginOmpApi, type PluginActivationScope } from "@omp-desktop/plugin/host";
import { createOmpApi } from "@omp-desktop/client";
import { LocalPluginSnapshotSchema, type LocalPluginSnapshot } from "@omp-desktop/protocol/desktop-local-plugins";
import { getDesktopHost } from "@/desktop/host";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { setupPluginClient } from "./context";
import { loadTrustedPluginClient } from "./load";
import { pluginClientRegistry, pluginInstanceKey, pluginExtensionKey } from "./registry";
import { getLocalPluginControl, type LocalPluginEnvironment } from "./local-control";

interface LocalPluginCatalogState {
  status: "unavailable" | "loading" | "ready" | "error";
  snapshot: LocalPluginSnapshot | null;
  error: string | null;
  environment: LocalPluginEnvironment | null;
}
let state: LocalPluginCatalogState = { status: "unavailable", snapshot: null, error: null, environment: null };
const listeners = new Set<() => void>();
let reload: (() => Promise<void>) | null = null;
function publish(next: LocalPluginCatalogState) {
  state = next;
  for (const listener of listeners) listener();
}
export function useLocalPluginCatalog() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => state,
    () => state,
  );
}
export async function reloadLocalPluginCatalog() {
  if (!reload) throw new Error("Local client plugin runtime is unavailable");
  await reload();
}

export function LocalPluginCatalogBridge() {
  const localServerId = useLocalDaemonServerId();
  const hostId = useRef(localServerId);
  hostId.current = localServerId;
  useEffect(() => {
    const availableBridge = getDesktopHost()?.plugins;
    if (!availableBridge) return;
    const bridge = availableBridge;
    const control = getLocalPluginControl();
    const lifetime = new AbortController();
    const running = new Map<string, { signature: string; bundle: string | undefined; scope: PluginActivationScope }>();
    let desired = new Map<string, { signature: string; bundle: string | undefined; mode: "manage" | "active" }>();
    let refreshSequence = 0;
    let queue: Promise<void> = Promise.resolve();
    publish({ ...state, status: "loading", error: null, environment: control.environment });

    function describe(record: LocalPluginSnapshot["installations"][number]) {
      const mode = record.enabled && record.status === "active" ? "active" as const : "manage" as const;
      if (!record.installed || !record.trusted || (record.format === "legacy" && mode === "manage") || !record.clientBundle) return null;
      return { mode, bundle: record.clientBundle, signature: JSON.stringify([record.id, record.packageId, record.format, record.source, record.generation, record.version, record.enabled, record.installed, record.trusted, record.declaredCapabilities, record.grantedCapabilities, mode]) };
    }
    function isDesired(key: string, candidate: { signature: string; bundle: string | undefined }) {
      const current = desired.get(key);
      return !lifetime.signal.aborted && current?.signature === candidate.signature && current.bundle === candidate.bundle;
    }
    function stop(key: string) {
      const current = running.get(key);
      if (!current) return;
      running.delete(key);
      pluginClientRegistry.remove(key, current.scope);
      void current.scope.dispose().catch((error) => pluginClientRegistry.fail(key, error, current.scope));
    }
    async function reconcile(snapshot: LocalPluginSnapshot) {
      if (lifetime.signal.aborted) return;
      for (const record of snapshot.installations) {
        if (lifetime.signal.aborted) return;
        const key = pluginInstanceKey("desktop", record.id, "desktop");
        const candidate = describe(record);
        if (!candidate || !isDesired(key, candidate)) continue;
        const previous = running.get(key);
        if (previous && !previous.scope.signal.aborted && previous.signature === candidate.signature && previous.bundle === candidate.bundle) continue;
        stop(key);
        if (!isDesired(key, candidate)) continue;
        const { mode, signature, bundle } = candidate;
        const scope = createActivationScope(record.generation);
        pluginClientRegistry.begin(key, scope);
        running.set(key, { signature, bundle, scope });
        const binding = { installationId: record.id, generation: record.generation, clientActivationId: scope.id };
        // Revoke native authorization on abort, before any plugin-owned async cleanup.
        scope.signal.addEventListener("abort", () => {
          void bridge.releaseClientScope(binding).catch((error: unknown) => pluginClientRegistry.fail(key, error, scope));
        }, { once: true });
        // Keep the final idempotent close after owned resources have finished releasing.
        scope.own(() => bridge.releaseClientScope(binding));
        const invoke = (method: string, input?: unknown) => bridge.publish({ ...binding, method, input });
        try {
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          const cancel = () => resolve();
          scope.signal.addEventListener("abort", cancel, { once: true });
          void bridge.openClientScope({ ...binding, mode }).then(resolve, reject).finally(() => scope.signal.removeEventListener("abort", cancel));
          await promise;
          if (!isDesired(key, candidate) || scope.signal.aborted) { stop(key); continue; }
          const setup = loadTrustedPluginClient(bundle!);
          const instance = await setupPluginClient({
            hostId: "desktop", installation: record, format: record.format === "legacy" ? "legacy" : "package", mode, scope, setup, changed: () => pluginClientRegistry.changed(key),
            services: {
              getOmp() {
                const client = hostId.current ? getHostRuntimeStore().getSnapshot(hostId.current)?.client : null;
                if (!client) throw new Error("This local plugin has no connected local daemon");
                return createPluginOmpApi(createOmpApi(client), record, scope, { mode, legacy: record.format === "legacy" });
              },
              storage: {
                get: async <T,>() => await invoke("storage.get") as { revision: number; values: T },
                patch: async <T,>(patch: Partial<T>, expectedRevision: number) => await invoke("storage.patch", { patch, expectedRevision }) as { revision: number; values: T },
              },
              secrets: {
                configured: async (key) => await invoke("secret", { key, operation: "configured" }) as boolean,
                set: async (key, value) => { await invoke("secret", { key, operation: "set", value }); },
                delete: async (key) => { await invoke("secret", { key, operation: "delete" }); },
              },
              native: {
                invoke: async <T,>(method: string, input?: unknown) => await invoke(method, input) as T,
                subscribe(event, listener) {
                  let cancelled = false;
                  let off: (() => void) | undefined;
                  void listenToDesktopEvent(event === "plugins:changed" ? "desktop-plugins-changed" : event, (payload) => {
                    if (cancelled || scope.signal.aborted) return;
                    if (event === "plugin-menu-action") {
                      if (typeof payload === "object" && payload !== null && "installationId" in payload && payload.installationId === record.id && "generation" in payload && payload.generation === record.generation && "clientActivationId" in payload && payload.clientActivationId === scope.id) listener(payload);
                    } else listener(payload);
                  }).then((remove) => { if (cancelled) remove(); else off = remove; }).catch((error: unknown) => pluginClientRegistry.fail(key, error, scope));
                  return () => { cancelled = true; off?.(); };
                },
              },
              invoke,
            },
          });
          if (!instance || !isDesired(key, candidate) || scope.signal.aborted) { stop(key); continue; }
          pluginClientRegistry.replace(instance);
        } catch (error) {
          void stop(key);
          if (isDesired(key, candidate)) {
            pluginClientRegistry.fail(key, error, scope);
          }
        }
      }
    }
    async function refresh() {
      const sequence = ++refreshSequence;
      try {
        const snapshot = LocalPluginSnapshotSchema.parse(await control.getSnapshot());
        if (lifetime.signal.aborted || sequence !== refreshSequence || (state.snapshot && snapshot.revision < state.snapshot.revision)) return;
        publish({ status: "ready", snapshot, error: null, environment: control.environment });
        const selected = snapshot.backgroundProvider;
        pluginClientRegistry.selectBackground(selected ? pluginExtensionKey(pluginInstanceKey("desktop", selected.installationId, "desktop"), "background", selected.extensionId) : null);
        desired = new Map(snapshot.installations.flatMap((record) => { const candidate = describe(record); return candidate ? [[pluginInstanceKey("desktop", record.id, "desktop"), candidate] as const] : []; }));
        for (const [key, current] of running) if (!isDesired(key, current)) void stop(key);
        const run = () => reconcile(snapshot);
        queue = queue.then(run, run);
        await queue;
      } catch (error) {
        if (!lifetime.signal.aborted) publish({ ...state, status: "error", error: error instanceof Error ? error.message : String(error) });
      }
    }
    reload = refresh;
    let off: (() => void) | undefined;
    void control.subscribe(() => { void refresh(); })
      .then((remove) => { if (lifetime.signal.aborted) remove(); else off = remove; })
      .catch((error: unknown) => publish({ ...state, status: "error", error: error instanceof Error ? error.message : String(error) }));
    void refresh();
    return () => {
      lifetime.abort();
      off?.();
      if (reload === refresh) reload = null;
      for (const [key, previous] of running) {
        pluginClientRegistry.remove(key, previous.scope);
        void previous.scope.dispose().catch((error: unknown) => pluginClientRegistry.fail(key, error, previous.scope));
      }
      running.clear();
    };
  }, []);
  return null;
}
