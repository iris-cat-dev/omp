import { createPaseoApi, type PaseoApi } from "@omp-desktop/client";
import { createPluginPaseoApi } from "@omp-desktop/plugin/host";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { PluginClientInstance } from "./registry";

export function getPluginPaseo(instance: PluginClientInstance, hostId?: string): PaseoApi {
  instance.scope.assertCurrent();
  if (instance.installation.owner !== "desktop") {
    if (hostId !== undefined && hostId !== instance.hostId) throw new Error("Plugin action belongs to another host");
    return instance.context.paseo;
  }
  if (hostId === undefined) return instance.context.paseo;
  const client = getHostRuntimeStore().getSnapshot(hostId)?.client;
  if (!client) throw new Error("Plugin action host is unavailable");
  return createPluginPaseoApi(createPaseoApi(client), instance.installation, instance.scope, { mode: instance.mode, legacy: instance.format === "legacy" });
}
