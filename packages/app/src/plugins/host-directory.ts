import type { PluginHostConnection, PluginHostDirectory, PluginInstallation } from "@omp-desktop/plugin";
import { createPluginOmpApi, type PluginActivationScope } from "@omp-desktop/plugin/host";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { pluginClientRegistry } from "./registry";

/** Connections always belong to the same explicitly trusted installation on each host. */
export function createPluginHostDirectory(
  hostId: string,
  installation: PluginInstallation,
  scope: PluginActivationScope,
  mode: "manage" | "active",
): PluginHostDirectory {
  const seen = new Set([hostId]);
  function activeInstances() {
    scope.assertCurrent();
    if (mode !== "active") throw new Error("Host connections are unavailable in management mode");
    if (installation.owner !== "daemon") return [];
    return pluginClientRegistry.getSnapshot().instances.filter((instance) =>
      instance.installation.owner === "daemon" &&
      instance.installation.id === installation.id &&
      instance.installation.packageId === installation.packageId &&
      instance.mode === "active" && !instance.scope.signal.aborted,
    );
  }
  return {
    list() {
      const runtime = getHostRuntimeStore();
      const active = new Set(activeInstances().map((instance) => instance.hostId));
      for (const id of active) seen.add(id);
      return runtime.getHosts().flatMap((host) => {
        const online = runtime.getSnapshot(host.serverId)?.connectionStatus === "online";
        if (online ? !active.has(host.serverId) : !seen.has(host.serverId)) return [];
        return [{ id: host.serverId, label: host.label, online: online && active.has(host.serverId) }];
      });
    },
    subscribe(listener) {
      scope.assertCurrent();
      const runtime = getHostRuntimeStore();
      const notify = () => { if (!scope.signal.aborted) listener(); };
      const offRegistry = pluginClientRegistry.subscribe(notify);
      const offRuntime = runtime.subscribeAll(notify);
      const offHosts = runtime.subscribeHostList(notify);
      const release = scope.own(() => { offRegistry(); offRuntime(); offHosts(); });
      return () => { void release(); };
    },
    get(id): PluginHostConnection | null {
      const instance = activeInstances().find((candidate) => candidate.hostId === id);
      if (!instance || getHostRuntimeStore().getSnapshot(id)?.connectionStatus !== "online") return null;
      // Apply both installations' approvals: a remote grant cannot elevate the caller.
      const omp = createPluginOmpApi(instance.context.omp, installation, scope, { mode: "active" });
      return {
        omp,
        subscribe(listener) {
          scope.assertCurrent();
          instance.scope.assertCurrent();
          const release = scope.own(instance.context.native.subscribe("plugins:changed", () => {
            if (!scope.signal.aborted && !instance.scope.signal.aborted) listener();
          }));
          return () => { void release(); };
        },
        async rpc(contract, value) {
          scope.assertCurrent();
          const result = await instance.context.rpc(contract, value);
          scope.assertCurrent();
          return result;
        },
      };
    },
  };
}
