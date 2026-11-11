import { useMemo } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { settingsStyles } from "@/styles/settings";
import { buildPluginSettingsRoute, buildOpenProjectRoute } from "@/utils/host-routes";
import { useHosts } from "@/runtime/host-runtime";
import { usePluginContributions } from "./hooks";
import { PluginView, usePluginHostProps } from "./view";
import { buildPluginSurfaceRoute, type PluginSurfaceIdentity } from "./routes";
import { pluginSelectionMemory } from "./selection-memory";

export function PluginSurfaceScreen({ hostId, owner, pluginId, identity }: { hostId: string; owner: "desktop" | "daemon"; pluginId: string; identity: PluginSurfaceIdentity }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const surfaces = usePluginContributions("surface");
  const sidebar = usePluginContributions("sidebar");
  const host = usePluginHostProps(hostId, owner);
  const available = useMemo(() => (identity.kind === "sidebar" ? sidebar : surfaces).filter(({ instance, contribution }) => instance.installation.id === pluginId && contribution.id === identity.id), [identity.kind, identity.id, pluginId, sidebar, surfaces]);
  const sidebarEntry = identity.kind === "sidebar" ? sidebar.find(({ instance, contribution }) => instance.installation.owner === owner && instance.hostId === hostId && instance.installation.id === pluginId && contribution.id === identity.id) : null;
  const surfaceId = identity.kind === "surface" ? identity.id : sidebarEntry?.contribution.surface;
  const entry = surfaces.find(({ instance, contribution }) => instance.installation.owner === owner && instance.hostId === hostId && instance.installation.id === pluginId && contribution.id === surfaceId);
  const title = sidebarEntry?.contribution.title ?? pluginId;
  return <View style={{ flex: 1 }} testID="plugin-surface">
    <MenuHeader title={title} rightContent={<Button size="sm" variant="ghost" onPress={() => router.canGoBack() ? router.back() : router.replace(buildOpenProjectRoute())}>{t("plugins.close")}</Button>} />
    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", paddingHorizontal: 16, paddingBottom: 12 }}>
      {available.map(({ key, instance }) => <Button key={key} size="sm" variant={instance.hostId === hostId && instance.installation.owner === owner ? "default" : "outline"} onPress={() => {
        instance.scope.assertCurrent();
        void pluginSelectionMemory.select(identity.kind, `${pluginId}/${identity.kind}/${identity.id}`, instance.hostId, instance.installation.owner).then(() => { instance.scope.assertCurrent(); router.replace(buildPluginSurfaceRoute(instance.hostId, pluginId, identity, instance.installation.owner)); });
      }}>{instance.installation.owner === "desktop" ? t("plugins.environment.native-desktop") : `${t("plugins.daemon")} · ${hosts.find((candidate) => candidate.serverId === instance.hostId)?.label ?? instance.hostId}`}</Button>)}
    </View>
    {entry ? <PluginView key={entry.key} instance={entry.instance}><entry.contribution.Component {...host} /></PluginView> : <View style={{ padding: 24, gap: 12 }}>
      <Text style={settingsStyles.rowTitle}>{t("plugins.unavailable")}</Text>
      <Text style={settingsStyles.rowHint}>{`${hostId} · ${pluginId}/${identity.id}`}</Text>
      <Button onPress={() => router.push(buildPluginSettingsRoute({ pluginId, serverId: owner === "desktop" ? undefined : hostId }))}>{t("plugins.configure")}</Button>
    </View>}
  </View>;
}
