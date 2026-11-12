import { useEffect, useMemo } from "react";
import { View } from "react-native";
import { Puzzle } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useUnistyles } from "react-native-unistyles";
import { z } from "zod";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import type { PluginMenuItemContribution } from "@omp-desktop/plugin";
import { usePluginContributions } from "./hooks";
import { pluginClientRegistry, type PluginClientInstance } from "./registry";
import { runPluginMenuItem, type PluginActionContext } from "./commands";
import { resolvePluginIcon } from "./icons";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { WorkspaceTabMenuEntry } from "@/screens/workspace/workspace-tab-menu";

export function PluginMenuIcon({ name }: { name: string }) {
  const { theme } = useUnistyles();
  const Icon = resolvePluginIcon(name);
  return Icon ? <Icon size={16} color={theme.colors.foregroundMuted} /> : null;
}

export function usePluginTabMenuEntries({ hostId, workspaceId, target }: { hostId?: string; workspaceId?: string; target: WorkspaceTabDescriptor["target"] }): WorkspaceTabMenuEntry[] {
  const entries = usePluginContributions("menu");
  const agentId = "agentId" in target ? target.agentId : undefined;
  return useMemo(() => {
    if (!hostId || !workspaceId) return [];
    const context: PluginActionContext = { hostId, workspaceId, agentId };
    return entries.filter(({ instance, contribution }) => (contribution.position === "tab" || (contribution.position === "agent" && agentId)) && (instance.installation.owner === "desktop" || instance.hostId === hostId)).map(({ key, instance, contribution }) => ({
      kind: "item", key: `plugin:${key}`, label: contribution.title, pluginIcon: contribution.icon,
      testID: `plugin-menu-${instance.installation.owner}-${instance.hostId}-${instance.installation.id}-${contribution.id}`,
      onSelect: () => { void runPluginMenuItem(instance, contribution, context).catch((error) => pluginClientRegistry.fail(instance.key, error, instance.scope)); },
    }));
  }, [entries, hostId, workspaceId, agentId]);
}

export function PluginWorkspaceMenu({ hostId, workspaceId }: { hostId: string; workspaceId?: string }) {
  const entries = usePluginContributions("menu");
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  if (!workspaceId || !entries.some(({ instance, contribution }) => contribution.position === "workspace" && (instance.installation.owner === "desktop" || instance.hostId === hostId))) return null;
  return <DropdownMenu><DropdownMenuTrigger accessibilityRole="button" accessibilityLabel={t("plugins.workspaceActions")} testID="plugin-workspace-menu" style={{ padding: 8 }}><Puzzle size={18} color={theme.colors.foregroundMuted} /></DropdownMenuTrigger><DropdownMenuContent><PluginMenuItems position="workspace" hostId={hostId} workspaceId={workspaceId} /></DropdownMenuContent></DropdownMenu>;
}

export function PluginMenuItems({ position, hostId, workspaceId, agentId, surface = "dropdown" }: { position: PluginMenuItemContribution["position"]; hostId?: string; workspaceId?: string; agentId?: string; surface?: "dropdown" | "context" }) {
  const entries = usePluginContributions("menu");
  const { theme } = useUnistyles();
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  return entries.filter(({ instance, contribution }) => contribution.position === position && (!hostId || instance.installation.owner === "desktop" || instance.hostId === hostId)).map(({ key, instance, contribution }) => {
    const Icon = contribution.icon ? resolvePluginIcon(contribution.icon) : null;
    const context: PluginActionContext = { hostId, workspaceId, agentId };
    return <Item key={key} testID={`plugin-menu-${instance.installation.owner}-${instance.hostId}-${instance.installation.id}-${contribution.id}`} leading={Icon ? <Icon size={16} color={theme.colors.foregroundMuted} /> : undefined} onSelect={() => { void runPluginMenuItem(instance, contribution, context).catch((error) => pluginClientRegistry.fail(instance.key, error, instance.scope)); }}>{contribution.title}</Item>;
  });
}

export function PluginSettingsActions({ hostId, owner, installationId }: { hostId: string; owner: "desktop" | "daemon"; installationId: string }) {
  const entries = usePluginContributions("menu", hostId, owner);
  const actions = entries.filter(({ instance, contribution }) => instance.installation.id === installationId && contribution.position === "application");
  if (!actions.length) return null;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
    {actions.map(({ key, instance, contribution }) => <Button key={key} size="sm" variant="outline" leftIcon={contribution.icon ? resolvePluginIcon(contribution.icon) : undefined} testID={`plugin-settings-action-${key}`} onPress={() => { void runPluginMenuItem(instance, contribution, {}).catch((error) => pluginClientRegistry.fail(instance.key, error, instance.scope)); }}>{contribution.title}</Button>)}
  </View>;
}

const menuAction = z.object({ installationId: z.string(), generation: z.number().int(), clientActivationId: z.string(), actionId: z.string() });
const menuLease = z.object({ leaseId: z.string() });

function NativeInstallationMenu({ instance, items }: { instance: PluginClientInstance; items: readonly PluginMenuItemContribution[] }) {
  useEffect(() => {
    let disposed = false;
    let leaseId: string | null = null;
    const unregister = async () => {
      if (!leaseId) return;
      const id = leaseId;
      leaseId = null;
      await instance.context.native.invoke("menu.unregister", { leaseId: id });
    };
    const off = instance.context.native.subscribe("plugin-menu-action", (value) => {
      const action = menuAction.parse(value);
      if (disposed || action.installationId !== instance.installation.id || action.generation !== instance.scope.generation || action.clientActivationId !== instance.scope.id) return;
      const item = items.find((entry) => entry.id === action.actionId);
      if (!item) throw new Error("Native plugin menu action is unavailable");
      void runPluginMenuItem(instance, item, {}).catch((error) => pluginClientRegistry.fail(instance.key, error, instance.scope));
    });
    const removeOwned = instance.scope.own(async () => { disposed = true; off(); await unregister(); });
    void instance.context.native.invoke("menu.register", { items: items.map(({ id, title, order }) => ({ id, title, order })) }).then(async (value) => {
      leaseId = menuLease.parse(value).leaseId;
      if (disposed) await unregister();
    }).catch((error) => { if (!disposed) pluginClientRegistry.fail(instance.key, error, instance.scope); });
    return () => { disposed = true; off(); void Promise.resolve(removeOwned()).catch((error) => pluginClientRegistry.fail(instance.key, error, instance.scope)); };
  }, [instance, items]);
  return null;
}

export function PluginNativeMenuBridge() {
  const entries = usePluginContributions("menu");
  const groups = useMemo(() => {
    const result = new Map<PluginClientInstance, PluginMenuItemContribution[]>();
    for (const { instance, contribution } of entries) {
      if (instance.installation.owner !== "desktop" || contribution.position !== "application" || !instance.installation.grantedCapabilities.includes("ui.menu")) continue;
      const group = result.get(instance);
      if (group) group.push(contribution); else result.set(instance, [contribution]);
    }
    return [...result];
  }, [entries]);
  return groups.map(([instance, items]) => <NativeInstallationMenu key={`${instance.key}:${instance.scope.id}`} instance={instance} items={items} />);
}
