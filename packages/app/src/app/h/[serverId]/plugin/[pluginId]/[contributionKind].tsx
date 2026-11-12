import { Redirect, useLocalSearchParams } from "expo-router";
import { buildPluginSurfaceRoute } from "@/plugins/routes";

export default function LegacyPluginSurfaceRoute() {
  const params = useLocalSearchParams<{ serverId: string; pluginId: string; contributionKind: string }>();
  return <Redirect href={buildPluginSurfaceRoute(params.serverId, params.pluginId, { kind: "sidebar", id: params.contributionKind })} />;
}
