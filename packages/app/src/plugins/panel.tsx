import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { Puzzle } from "lucide-react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import type { PluginWorkspaceTabTarget } from "@/workspace-tabs/model";
import { buildPluginSettingsRoute } from "@/utils/host-routes";
import { settingsStyles } from "@/styles/settings";
import { usePluginContributions } from "./hooks";
import { PluginView, usePluginHostProps } from "./view";
import { resolvePluginIcon } from "./icons";

function PluginPanel() {
  const pane = usePaneContext();
  if (pane.target.kind !== "plugin") throw new Error("PluginPanel requires a plugin target");
  const target = pane.target;
  const hostId = target.owner === "desktop" ? "desktop" : pane.serverId;
  const panels = usePluginContributions("panel", hostId, target.owner ?? "daemon");
  const entry = panels.find(({ instance, contribution }) => instance.installation.id === target.pluginId && contribution.id === target.panelId && contribution.context === target.context);
  const host = usePluginHostProps(pane.serverId);
  const { t } = useTranslation();
  const state = useMemo(() => {
    if (!entry?.contribution.stateSchema || pane.state === undefined) return { success: true as const, data: pane.state };
    return entry.contribution.stateSchema.safeParse(pane.state);
  }, [entry?.contribution, pane.state]);
  const setState = useCallback((value: Parameters<typeof pane.setCurrentTabState>[0]) => {
    if (!entry?.contribution.stateSchema) throw new Error("This plugin panel has not registered a state schema");
    entry.instance.scope.assertCurrent();
    pane.setCurrentTabState(z.json().parse(entry.contribution.stateSchema.parse(value)));
  }, [entry, pane.setCurrentTabState]);
  const configure = useCallback(() => {
    router.push(buildPluginSettingsRoute({ pluginId: target.pluginId, serverId: target.owner === "desktop" ? undefined : pane.serverId }));
  }, [target.pluginId, target.owner, pane.serverId]);
  if (!entry || !state.success) {
    return <View style={{ padding: 24, gap: 12 }} testID="plugin-panel-unavailable">
      <Text style={settingsStyles.rowTitle}>{t("plugins.unavailable", { defaultValue: "插件不可用" })}</Text>
      <Text style={settingsStyles.rowHint}>{!state.success ? state.error.message : `${target.pluginId} / ${target.panelId}`}</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button onPress={configure}>{t("plugins.configure", { defaultValue: "配置" })}</Button>
        <Button variant="outline" onPress={pane.closeCurrentTab}>{t("plugins.close", { defaultValue: "关闭" })}</Button>
      </View>
    </View>;
  }
  const contribution = entry.contribution;
  return <PluginView instance={entry.instance} hostId={pane.serverId}>
    {contribution.context === "agent" && target.context === "agent"
      ? <contribution.Component {...host} context="agent" workspaceId={pane.workspaceId} agentId={target.agentId} state={state.data} setState={contribution.stateSchema ? setState : undefined} />
      : contribution.context === "workspace"
        ? <contribution.Component {...host} context="workspace" workspaceId={pane.workspaceId} state={state.data} setState={contribution.stateSchema ? setState : undefined} />
        : null}
  </PluginView>;
}

function usePluginPanelDescriptor(target: PluginWorkspaceTabTarget, context: { serverId: string }) {
  const { t } = useTranslation();
  const panels = usePluginContributions("panel", target.owner === "desktop" ? "desktop" : context.serverId, target.owner ?? "daemon");
  const entry = panels.find(({ instance, contribution }) => instance.installation.id === target.pluginId && contribution.id === target.panelId && contribution.context === target.context);
  const label = entry?.contribution.title ?? t("plugins.unavailable", { defaultValue: "插件不可用" });
  return { label, subtitle: target.pluginId, tooltip: `${label}\n${target.pluginId}/${target.panelId}`, titleState: "ready" as const, icon: entry ? resolvePluginIcon(entry.contribution.icon) : Puzzle, statusBucket: null };
}

export const pluginPanelRegistration: PanelRegistration<"plugin"> = {
  kind: "plugin",
  component: PluginPanel,
  useDescriptor: usePluginPanelDescriptor,
  resourceKey: (target) => JSON.stringify([target.owner ?? "daemon", target.pluginId, target.panelId, target.context, target.context === "agent" ? target.agentId : null]),
};
