import { createOmpApi, type OmpApi } from "@omp-desktop/client";
import { createPluginOmpApi } from "@omp-desktop/plugin/host";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { PluginClientInstance } from "./registry";

export function getPluginOmp(instance: PluginClientInstance, hostId?: string): OmpApi {
  instance.scope.assertCurrent();
  if (instance.installation.owner !== "desktop") {
    if (hostId !== undefined && hostId !== instance.hostId) throw new Error("Plugin action belongs to another host");
    return instance.context.omp;
  }
  if (hostId === undefined) return instance.context.omp;
  const client = getHostRuntimeStore().getSnapshot(hostId)?.client;
  if (!client) throw new Error("Plugin action host is unavailable");
  return createPluginOmpApi(createOmpApi(client), instance.installation, instance.scope, { mode: instance.mode, legacy: instance.format === "legacy" });
}
