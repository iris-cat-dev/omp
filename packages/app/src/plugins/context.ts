import { callPluginRpc, isPluginReleaseOperation } from "@omp-desktop/plugin/host";
import type {
  PluginClientContext,
  PluginClientSetup,
  PluginCleanup,
  PluginInstallation,
  PluginNativeApi,
  PluginSecrets,
  PluginStorage,
} from "@omp-desktop/plugin";
import type { PluginActivationScope } from "@omp-desktop/plugin/host";
import type { PaseoApi } from "@omp-desktop/client";
import { QueryClient } from "@tanstack/react-query";
import {
  emptyPluginContributions,
  pluginInstanceKey,
  type PluginClientInstance,
  type PluginContributions,
} from "./registry";
import { validatePluginContribution } from "./contribution-validation";

export interface PluginClientServices {
  getPaseo(): PaseoApi;
  storage: PluginStorage;
  secrets: PluginSecrets;
  native: PluginNativeApi;
  invoke(method: string, input: unknown): Promise<unknown>;
}

export async function setupPluginClient(input: {
  hostId: string;
  installation: PluginInstallation;
  mode: "manage" | "active";
  format: "legacy" | "package";
  scope: PluginActivationScope;
  services: PluginClientServices;
  setup: PluginClientSetup;
  changed?: () => void;
}): Promise<PluginClientInstance | null> {
  const { scope, services } = input;
  const installation: PluginInstallation = Object.freeze({
    id: input.installation.id, packageId: input.installation.packageId, owner: input.installation.owner,
    version: input.installation.version, generation: input.installation.generation, enabled: input.installation.enabled,
    declaredCapabilities: Object.freeze([...input.installation.declaredCapabilities]),
    grantedCapabilities: Object.freeze([...input.installation.grantedCapabilities]),
  });
  const contributions = emptyPluginContributions();
  const identifiers = new Set<string>();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  scope.own(() => { queryClient.clear(); });

  function register<K extends keyof PluginContributions>(kind: K, contribution: PluginContributions[K]) {
    scope.assertCurrent();
    contribution = validatePluginContribution(kind, contribution);
    const id = `${kind}:${contribution.id}`;
    if (identifiers.has(id)) throw new Error(`Duplicate plugin extension id: ${id}`);
    identifiers.add(id);
    const list = contributions[kind] as PluginContributions[K][];
    list.push(contribution);
    input.changed?.();
    return scope.own(() => {
      identifiers.delete(id);
      const index = list.indexOf(contribution);
      if (index >= 0) list.splice(index, 1);
      input.changed?.();
    });
  }

  function guarded<T>(operation: () => Promise<T>): Promise<T> {
    scope.assertCurrent();
    return operation().then((value) => { scope.assertCurrent(); return value; });
  }
  const context: PluginClientContext = {
    installation,
    signal: scope.signal,
    mode: input.mode,
    role: "client",
    get paseo() { return services.getPaseo(); },
    storage: {
      get: <T>() => guarded(() => services.storage.get<T>()),
      patch: <T>(patch: Partial<T>, revision: number) => guarded(() => services.storage.patch<T>(patch, revision)),
    },
    secrets: {
      configured: (key) => guarded(() => services.secrets.configured(key)),
      set: (key, value) => guarded(() => services.secrets.set(key, value)),
      delete: (key) => guarded(() => services.secrets.delete(key)),
    },
    native: {
      invoke: <T>(operation: string, value?: unknown) => installation.owner === "desktop" && isPluginReleaseOperation(operation, value)
        ? services.native.invoke<T>(operation, value)
        : guarded(() => services.native.invoke<T>(operation, value)),
      subscribe(event, listener) {
        scope.assertCurrent();
        return scope.own(services.native.subscribe(event, (value) => {
          if (!scope.signal.aborted) listener(value);
        }));
      },
    },
    rpc: (contract, value) => guarded(() => callPluginRpc(contract, services.invoke, value)),
    own: (cleanup) => scope.own(cleanup),
    // Shared legacy setup declares service handlers on both build targets. Client
    // handlers are never executed; RPCs go to the bound installation's service.
    handle(contract) {
      scope.assertCurrent();
      const key = `rpc:${contract.name}`;
      if (identifiers.has(key)) throw new Error(`Duplicate plugin RPC id: ${contract.name}`);
      identifiers.add(key);
      scope.own(() => { identifiers.delete(key); });
    },
    addSurface: (id, Component) => { register("surface", { id, Component }); },
    addSidebarItem: (item) => { register("sidebar", item); },
    addWorkspacePanel: (item) => { register("panel", item); },
    addCommandCenterItem: (item) => { register("command", item); },
    addAttachmentSource: (item) => { register("attachment", item); },
    addTheme: (item) => { register("theme", item); },
    addSettingsPage: (item) => register("settings", item),
    addMenuItem: (item) => register("menu", item),
    addTurnMetric: (item) => register("metric", item),
    addBackground: (item) => register("background", item),
    addOverlay: (item) => register("overlay", item),
  };
  const cancelled = Symbol("cancelled plugin setup");
  // The supported Hermes runtime requires the Promise executor API.
  let onAbort!: () => void;
  const cancellation = new Promise<typeof cancelled>((resolve) => {
    onAbort = () => resolve(cancelled);
    scope.signal.addEventListener("abort", onAbort, { once: true });
  });
  const pending = Promise.resolve(input.setup(context));
  let cleanup: void | PluginCleanup | typeof cancelled;
  try { cleanup = await Promise.race([pending, cancellation]); }
  finally { scope.signal.removeEventListener("abort", onAbort); }
  if (cleanup === cancelled) {
    // Consume only cleanup from a factory that finishes after its activation was cancelled.
    void pending.then((lateCleanup) => { if (typeof lateCleanup === "function") return lateCleanup(); }, () => undefined)
      .catch((error) => console.error("[Plugins] Cleanup after cancelled setup failed", error));
    return null;
  }
  if (cleanup !== undefined && typeof cleanup !== "function") throw new Error("Plugin client setup must return a cleanup function or undefined");
  if (input.format === "legacy" && typeof cleanup !== "function") throw new Error("Legacy plugin client contribution must return a cleanup function");
  if (scope.signal.aborted) {
    if (cleanup) await cleanup();
    return null;
  }
  if (cleanup) scope.own(cleanup);
  const surfaceIds = new Set(contributions.surface.map((surface) => surface.id));
  for (const sidebar of contributions.sidebar) {
    if (!surfaceIds.has(sidebar.surface)) throw new Error(`Sidebar ${sidebar.id} references missing surface ${sidebar.surface}`);
  }
  return {
    key: pluginInstanceKey(input.hostId, input.installation.id, input.installation.owner),
    hostId: input.hostId,
    installation,
    scope,
    mode: input.mode,
    format: input.format,
    queryClient,
    context,
    contributions,
    invoke: (method, value) => installation.owner === "desktop" && isPluginReleaseOperation(method, value)
      ? services.invoke(method, value)
      : guarded(() => services.invoke(method, value)),
  };
}
