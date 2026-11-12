import { useEffect } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { HostPluginCatalogBridge } from "./catalog";
import { LocalPluginCatalogBridge } from "./local-runtime";
import { pluginSelectionMemory } from "./selection-memory";
import { PluginNativeMenuBridge } from "./menus";

export function PluginRuntime() {
  const hosts = useHosts();
  useEffect(() => {
    void pluginSelectionMemory.load().catch((error: unknown) => console.error("[Plugins] Contribution host preference failed", error));
  }, []);
  return <>
    <LocalPluginCatalogBridge />
    <PluginNativeMenuBridge />
    {hosts.map((host) => <HostPluginCatalogBridge key={host.serverId} hostId={host.serverId} />)}
  </>;
}
