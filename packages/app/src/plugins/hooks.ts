import { useMemo, useSyncExternalStore } from "react";
import { collectPluginContributions, pluginClientRegistry, type PluginContributions } from "./registry";

export function usePluginClientSnapshot() {
  return useSyncExternalStore(pluginClientRegistry.subscribe, pluginClientRegistry.getSnapshot, pluginClientRegistry.getSnapshot);
}

export function usePluginContributions<K extends keyof PluginContributions>(kind: K, hostId?: string, owner?: "desktop" | "daemon") {
  const snapshot = usePluginClientSnapshot();
  return useMemo(() => collectPluginContributions(snapshot, kind, hostId, owner), [snapshot, kind, hostId, owner]);
}
