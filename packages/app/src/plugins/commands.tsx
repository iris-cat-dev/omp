import { useMemo } from "react";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import type { PluginCommandCenterItemContribution, PluginMenuItemContribution } from "@omp-desktop/plugin";
import { useCommandCenterActions } from "@/command-center/provider";
import { getCommandCenterIcon } from "@/command-center/icon";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { collectAllTabs, findPaneById, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSessionStore } from "@/stores/session-store";
import { resolveProjectLayoutKey } from "@/workspace-tabs/project-scope";
import { usePluginContributions } from "./hooks";
import type { PluginClientInstance } from "./registry";
import { createPluginClientStateSource } from "./client-state";
import { buildPluginSurfaceRoute } from "./routes";
import { resolvePluginIcon } from "./icons";
import { getPluginPaseo } from "./paseo";

export interface PluginActionContext { hostId?: string; workspaceId?: string; agentId?: string }

export function openPluginPanel(instance: PluginClientInstance, context: PluginActionContext, panelId: string) {
  instance.scope.assertCurrent();
  const panel = instance.contributions.panel.find((item) => item.id === panelId);
  if (!panel) throw new Error(`Plugin panel ${panelId} is unavailable`);
  if (!context.hostId || !context.workspaceId || (panel.context === "agent" && !context.agentId)) throw new Error(`Plugin panel ${panelId} requires ${panel.context} context`);
  if (instance.installation.owner !== "desktop" && instance.hostId !== context.hostId) throw new Error("Plugin panel belongs to another host");
  const workspaceKey = resolveProjectLayoutKey({ serverId: context.hostId, workspaceId: context.workspaceId });
  if (!workspaceKey) throw new Error("Plugin panel workspace is unavailable");
  const target = { kind: "plugin" as const, owner: instance.installation.owner, pluginId: instance.installation.id, panelId, workspaceId: context.workspaceId, ...(panel.context === "agent" ? { context: "agent" as const, agentId: context.agentId! } : { context: "workspace" as const }) };
  useWorkspaceLayoutStore.getState().openTab({ workspaceKey, target, intent: "reveal" });
}

function openPluginSurface(instance: PluginClientInstance, id: string) {
  instance.scope.assertCurrent();
  if (!instance.contributions.surface.some((surface) => surface.id === id)) throw new Error(`Plugin surface ${id} is unavailable`);
  router.push(buildPluginSurfaceRoute(instance.hostId, instance.installation.id, { kind: "surface", id }, instance.installation.owner));
}

export async function runPluginCommand(instance: PluginClientInstance, item: PluginCommandCenterItemContribution, context: PluginActionContext) {
  instance.scope.assertCurrent();
  const capabilities = {
    rpc: instance.context.rpc,
    openSurface: (id: string) => openPluginSurface(instance, id),
  };
  if (item.context === "global") await item.onSelect({ ...capabilities, context: "global", get paseo() { return getPluginPaseo(instance, instance.installation.owner === "desktop" ? context.hostId || undefined : undefined); } });
  else {
    const source = createPluginClientStateSource(context.hostId ?? null);
    const workspace = context.workspaceId ? source.getWorkspace(context.workspaceId) : null;
    if (!workspace) throw new Error("Plugin command workspace is unavailable");
    const openPanel = (id: string) => openPluginPanel(instance, context, id);
    if (item.context === "workspace") await item.onSelect({ ...capabilities, context: "workspace", workspace, openPanel, get paseo() { return getPluginPaseo(instance, context.hostId); } });
    else {
      const agent = context.agentId ? source.getAgent(context.agentId) : null;
      if (!agent || agent.workspaceId !== workspace.id) throw new Error("Plugin command agent context is unavailable");
      await item.onSelect({ ...capabilities, context: "agent", workspace, agent, openPanel, get paseo() { return getPluginPaseo(instance, context.hostId); } });
    }
  }
  instance.scope.assertCurrent();
}

export async function runPluginMenuItem(instance: PluginClientInstance, item: PluginMenuItemContribution, context: PluginActionContext) {
  instance.scope.assertCurrent();
  await item.onSelect({
    hostId: context.hostId ?? instance.hostId, workspaceId: context.workspaceId, agentId: context.agentId,
    rpc: instance.context.rpc, openPanel: (id: string) => openPluginPanel(instance, context, id),
    openSurface: (id: string) => openPluginSurface(instance, id),
    get paseo() { return getPluginPaseo(instance, context.hostId); },
  });
  instance.scope.assertCurrent();
}

export function PluginCommandCenterActions() {
  const { t } = useTranslation();
  const commands = usePluginContributions("command");
  const selection = useActiveWorkspaceSelection();
  const workspaceKey = selection ? resolveProjectLayoutKey(selection) : null;
  const layout = useWorkspaceLayoutStore((state) => workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined);
  const pane = layout ? findPaneById(layout.root, layout.focusedPaneId) : null;
  const target = layout ? collectAllTabs(layout.root).find((tab) => tab.tabId === pane?.focusedTabId)?.target : null;
  const agentId = target?.kind === "agent" ? target.agentId : target?.kind === "plugin" && target.context === "agent" ? target.agentId : undefined;
  const session = useSessionStore((state) => selection ? state.sessions[selection.serverId] : undefined);
  const actions = useMemo<CommandCenterContribution[]>(() => {
    const context: PluginActionContext = { hostId: selection?.serverId, workspaceId: selection?.workspaceId, agentId };
    return commands.flatMap(({ key, instance, contribution }, rank) => {
      if (contribution.context !== "global" && (!selection || (instance.installation.owner !== "desktop" && instance.hostId !== selection.serverId))) return [];
      const source = createPluginClientStateSource(context.hostId ?? null);
      if (contribution.context !== "global" && (!context.workspaceId || !source.getWorkspace(context.workspaceId))) return [];
      if (contribution.context === "agent" && (!agentId || !source.getAgent(agentId))) return [];
      return [{ id: key, group: "plugins", groupRank: 60, rank, keywords: contribution.keywords ?? [], visibility: "always" as const,
        run: () => runPluginCommand(instance, contribution, context),
        presentation: { kind: "action" as const, title: contribution.title, subtitle: `${instance.installation.id} · ${instance.hostId}`, sectionTitle: t("settings.sections.plugins"), icon: getCommandCenterIcon(resolvePluginIcon(contribution.icon)) },
      }];
    });
  }, [commands, selection?.serverId, selection?.workspaceId, agentId, session, t]);
  useCommandCenterActions({ sourceId: "desktop-plugins", enabled: true, actions });
  return null;
}
