export interface PluginSurfaceIdentity { kind: "sidebar" | "surface"; id: string }

export function buildPluginSurfaceRoute(hostId: string, pluginId: string, identity: PluginSurfaceIdentity, owner: "desktop" | "daemon" = "daemon") {
  const prefix = owner === "desktop" ? "" : `/h/${encodeURIComponent(hostId)}` as const;
  return `${prefix}/plugin/${encodeURIComponent(pluginId)}/${identity.kind}/${encodeURIComponent(identity.id)}` as const;
}
