import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  FileDiff,
  FolderTree,
  GitPullRequest,
  SquarePen,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react-native";
import invariant from "tiny-invariant";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { NewTabSelection } from "@/workspace-tabs/new-tab";
import type { TerminalProfile } from "@omp-desktop/protocol/messages";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@omp-desktop/protocol/terminal-profiles";
import { getBuiltInLaunchOrder, type BuiltInLaunchItemId } from "./internal/catalog";
import { usePluginContributions } from "@/plugins/hooks";
import { resolvePluginIcon } from "@/plugins/icons";
import { resolveProjectLayoutKey } from "@/workspace-tabs/project-scope";
import { collectAllTabs, findPaneById, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

export type WorkspaceTabLaunchPurpose = "primary" | "supporting";

export type WorkspaceTabLaunchDestination =
  | { kind: "open"; paneId?: string }
  | { kind: "replace"; tabId: string };

export interface NewTabLauncher {
  workspaceId: string;
  showChanges: boolean;
  showPullRequest: boolean;
  terminalDisabled: boolean;
  launch: (selection: NewTabSelection, destination: WorkspaceTabLaunchDestination) => void;
}

export interface WorkspaceTabLaunchItem {
  id: string;
  label: string;
  description?: string;
  Icon?: LucideIcon;
  terminalIconKey?: string;
  shortcutActionId?: string;
  disabled: boolean;
  launch: (destination: WorkspaceTabLaunchDestination) => void;
}

export interface WorkspaceTabLaunchGroup {
  id: "tabs" | "terminal-profiles" | "plugins";
  label: string | null;
  items: readonly WorkspaceTabLaunchItem[];
  accessory?: { id: string; label: string; run: () => void };
}

const NewTabLauncherContext = createContext<NewTabLauncher | null>(null);

export function NewTabLauncherProvider({
  value,
  children,
}: {
  value: NewTabLauncher;
  children: ReactNode;
}) {
  return <NewTabLauncherContext.Provider value={value}>{children}</NewTabLauncherContext.Provider>;
}

export function useNewTabLauncher(): NewTabLauncher {
  const launcher = useContext(NewTabLauncherContext);
  invariant(launcher, "NewTabLauncherProvider is required");
  return launcher;
}

const BUILT_IN_SELECTIONS: Record<BuiltInLaunchItemId, NewTabSelection> = {
  agent: { kind: "agent" },
  terminal: { kind: "terminal" },
  changes: { kind: "target", target: { kind: "working_diff" } },
  files: { kind: "target", target: { kind: "files" } },
  pullRequest: { kind: "target", target: { kind: "pull_request" } },
};

export function useWorkspaceTabLaunchCatalog(input: {
  serverId: string;
  purpose: WorkspaceTabLaunchPurpose;
}): readonly WorkspaceTabLaunchGroup[] {
  const { serverId, purpose } = input;
  const { t } = useTranslation();
  const router = useRouter();
  const launcher = useNewTabLauncher();
  const { config } = useDaemonConfig(serverId);
  const pluginPanels = usePluginContributions("panel");
  const workspaceKey = resolveProjectLayoutKey({ serverId, workspaceId: launcher.workspaceId });
  const layout = useWorkspaceLayoutStore((state) => workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined);
  const focusedPane = layout ? findPaneById(layout.root, layout.focusedPaneId) : null;
  const target = layout ? collectAllTabs(layout.root).find((tab) => tab.tabId === focusedPane?.focusedTabId)?.target : null;
  const agentId = target?.kind === "agent" ? target.agentId : target?.kind === "plugin" && target.context === "agent" ? target.agentId : undefined;

  const launchSelection = useCallback(
    (selection: NewTabSelection) => (destination: WorkspaceTabLaunchDestination) => {
      launcher.launch(selection, destination);
    },
    [launcher],
  );
  const editTerminalProfiles = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "terminals") as Href);
  }, [router, serverId]);

  return useMemo(() => {
    const builtIns: Record<BuiltInLaunchItemId, WorkspaceTabLaunchItem & { hidden?: boolean }> = {
      agent: {
        id: "agent",
        label: t("workspace.tabs.fallback.agent"),
        Icon: SquarePen,
        shortcutActionId: "workspace-tab-target-agent",
        disabled: false,
        launch: launchSelection(BUILT_IN_SELECTIONS.agent),
      },
      terminal: {
        id: "terminal",
        label: t("workspace.tabs.fallback.terminal"),
        Icon: SquareTerminal,
        shortcutActionId: "workspace-terminal-new",
        disabled: launcher.terminalDisabled,
        launch: launchSelection(BUILT_IN_SELECTIONS.terminal),
      },
      changes: {
        id: "changes",
        label: t("workspace.tabs.actions.changes"),
        Icon: FileDiff,
        shortcutActionId: "workspace-tab-target-changes",
        disabled: false,
        hidden: !launcher.showChanges,
        launch: launchSelection(BUILT_IN_SELECTIONS.changes),
      },
      files: {
        id: "files",
        label: t("workspace.tabs.actions.files"),
        Icon: FolderTree,
        shortcutActionId: "workspace-tab-target-files",
        disabled: false,
        launch: launchSelection(BUILT_IN_SELECTIONS.files),
      },
      pullRequest: {
        id: "pull-request",
        label: t("workspace.tabs.actions.pullRequest"),
        Icon: GitPullRequest,
        disabled: false,
        hidden: !launcher.showPullRequest,
        launch: launchSelection(BUILT_IN_SELECTIONS.pullRequest),
      },
    };
    const tabItems = getBuiltInLaunchOrder(purpose).flatMap((id) => {
      const item = builtIns[id];
      return item.hidden ? [] : [item];
    });

    const profiles = resolveTerminalProfiles(config?.terminalProfiles);
    const groups: WorkspaceTabLaunchGroup[] = [{ id: "tabs", label: null, items: tabItems }];
    if (profiles.length > 0) {
      groups.push({
        id: "terminal-profiles",
        label: t("workspace.tabs.actions.terminalProfilesMenu"),
        items: profiles.map((profile: TerminalProfile) => ({
          id: `terminal-profile:${profile.id}`,
          label: profile.name,
          terminalIconKey: getTerminalProfileIcon(profile),
          disabled: launcher.terminalDisabled,
          launch: launchSelection({ kind: "terminal", profile }),
        })),
        accessory: {
          id: "edit-terminal-profiles",
          label: t("workspace.tabs.actions.editTerminalProfiles"),
          run: editTerminalProfiles,
        },
      });
    }
    const panelItems: WorkspaceTabLaunchItem[] = pluginPanels.filter(({ instance }) => instance.installation.owner === "desktop" || instance.hostId === serverId).map(({ key, instance, contribution }) => ({
      id: key, label: contribution.title, description: `${instance.installation.id} · ${instance.hostId}`, Icon: resolvePluginIcon(contribution.icon),
      disabled: contribution.context === "agent" && !agentId,
      launch(destination) {
        instance.scope.assertCurrent();
        if (contribution.context === "agent" && !agentId) throw new Error("Plugin panel requires agent context");
        const target = { kind: "plugin" as const, pluginId: instance.installation.id, panelId: contribution.id, owner: instance.installation.owner,
          ...(contribution.context === "agent" ? { context: "agent" as const, agentId: agentId! } : { context: "workspace" as const }) };
        launcher.launch({ kind: "target", target }, destination);
      },
    }));
    if (panelItems.length) groups.push({ id: "plugins", label: t("settings.sections.plugins"), items: panelItems });
    return groups;
  }, [config?.terminalProfiles, editTerminalProfiles, launchSelection, launcher, purpose, t, pluginPanels, serverId, agentId]);
}

export { getBuiltInLaunchOrder } from "./internal/catalog";
