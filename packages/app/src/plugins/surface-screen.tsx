import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { settingsStyles } from "@/styles/settings";
import { buildPluginSettingsRoute, buildOpenProjectRoute } from "@/utils/host-routes";
import { useHosts } from "@/runtime/host-runtime";
import { usePluginContributions } from "./hooks";
import { PluginView, usePluginHostProps } from "./view";
import { buildPluginSurfaceRoute, type PluginSurfaceIdentity } from "./routes";
import { pluginSelectionMemory } from "./selection-memory";

export function PluginSurfaceScreen({
  hostId,
  owner,
  pluginId,
  identity,
}: {
  hostId: string;
  owner: "desktop" | "daemon";
  pluginId: string;
  identity: PluginSurfaceIdentity;
}) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const surfaces = usePluginContributions("surface");
  const sidebar = usePluginContributions("sidebar");
  const host = usePluginHostProps(hostId, owner);
  const available = useMemo(
    () =>
      (identity.kind === "sidebar" ? sidebar : surfaces).filter(
        ({ instance, contribution }) =>
          instance.installation.id === pluginId && contribution.id === identity.id,
      ),
    [identity.kind, identity.id, pluginId, sidebar, surfaces],
  );
  const sidebarEntry =
    identity.kind === "sidebar"
      ? sidebar.find(
          ({ instance, contribution }) =>
            instance.installation.owner === owner &&
            instance.hostId === hostId &&
            instance.installation.id === pluginId &&
            contribution.id === identity.id,
        )
      : null;
  const surfaceId = identity.kind === "surface" ? identity.id : sidebarEntry?.contribution.surface;
  const entry = surfaces.find(
    ({ instance, contribution }) =>
      instance.installation.owner === owner &&
      instance.hostId === hostId &&
      instance.installation.id === pluginId &&
      contribution.id === surfaceId,
  );
  const title = sidebarEntry?.contribution.title ?? pluginId;

  const formatHostLabel = useCallback(
    (targetHostId: string, targetOwner: "desktop" | "daemon") =>
      targetOwner === "desktop"
        ? t("plugins.environment.native-desktop")
        : `${t("plugins.daemon")} · ${hosts.find((candidate) => candidate.serverId === targetHostId)?.label ?? targetHostId}`,
    [hosts, t],
  );

  const selectedKey = useMemo(
    () =>
      available.find(
        ({ instance }) => instance.hostId === hostId && instance.installation.owner === owner,
      )?.key ?? "",
    [available, hostId, owner],
  );

  const showHostSwitcher = available.length > 1 || (available.length === 1 && selectedKey === "");

  const hostOptions = useMemo(
    () =>
      available.map(({ key, instance }) => ({
        value: key,
        label: formatHostLabel(instance.hostId, instance.installation.owner),
      })),
    [available, formatHostLabel],
  );

  const handleSelectHost = useCallback(
    (nextKey: string) => {
      const target = available.find((item) => item.key === nextKey);
      if (!target) return;
      const { instance } = target;
      instance.scope.assertCurrent();
      void (async () => {
        await pluginSelectionMemory.select(
          identity.kind,
          `${pluginId}/${identity.kind}/${identity.id}`,
          instance.hostId,
          instance.installation.owner,
        );
        instance.scope.assertCurrent();
        router.replace(
          buildPluginSurfaceRoute(instance.hostId, pluginId, identity, instance.installation.owner),
        );
      })();
    },
    [available, identity, pluginId],
  );

  const handleClose = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(buildOpenProjectRoute());
    }
  }, []);

  const handleConfigure = useCallback(() => {
    router.push(
      buildPluginSettingsRoute({
        pluginId,
        serverId: owner === "desktop" ? undefined : hostId,
      }),
    );
  }, [hostId, owner, pluginId]);

  const singleHostBadge =
    !showHostSwitcher && available.length === 1
      ? formatHostLabel(available[0]!.instance.hostId, available[0]!.instance.installation.owner)
      : null;

  const closeLabel = t("plugins.close");
  const rightContent = useMemo(
    () => (
      <View style={styles.headerRight}>
        {singleHostBadge ? (
          <View style={styles.hostBadge} testID="plugin-surface-host-badge">
            <Text style={styles.hostBadgeText} numberOfLines={1}>
              {singleHostBadge}
            </Text>
          </View>
        ) : null}
        <Button size="sm" variant="ghost" onPress={handleClose}>
          {closeLabel}
        </Button>
      </View>
    ),
    [closeLabel, handleClose, singleHostBadge],
  );

  return (
    <View style={styles.container} testID="plugin-surface">
      <MenuHeader title={title} rightContent={rightContent} />
      {showHostSwitcher ? (
        <View style={styles.switcherBar} testID="plugin-surface-host-switcher-bar">
          <SegmentedControl
            size="sm"
            value={selectedKey}
            options={hostOptions}
            onValueChange={handleSelectHost}
            testID="plugin-surface-host-switcher"
          />
        </View>
      ) : null}
      {entry ? (
        <PluginView key={entry.key} instance={entry.instance}>
          <entry.contribution.Component {...host} />
        </PluginView>
      ) : (
        <View style={styles.unavailable}>
          <Text style={settingsStyles.rowTitle}>{t("plugins.unavailable")}</Text>
          <Text style={settingsStyles.rowHint}>{`${hostId} · ${pluginId}/${identity.id}`}</Text>
          <Button onPress={handleConfigure}>{t("plugins.configure")}</Button>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  hostBadge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    maxWidth: 240,
  },
  hostBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  switcherBar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  unavailable: {
    padding: theme.spacing[6],
    gap: theme.spacing[3],
  },
}));
