import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Globe } from "lucide-react-native";
import { collectWorkspaceBrowserEntries } from "@/desktop/browser/discovery";
import { revealWorkspaceBrowser } from "@/desktop/browser/presentation";
import { useBrowserStore } from "@/desktop/browser/store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { WorkspaceTabLaunchItem } from "..";

export function useExistingWorkspaceBrowsers(input: {
  serverId: string;
  workspaceId: string;
  enabled: boolean;
}): WorkspaceTabLaunchItem[] {
  const { serverId, workspaceId, enabled } = input;
  const { t } = useTranslation();
  const browsersById = useBrowserStore((state) => state.browsersById);
  const layoutByWorkspace = useWorkspaceLayoutStore((state) => state.layoutByWorkspace);
  const workspaces = useSessionStore((state) => state.sessions[serverId]?.workspaces);

  return useMemo(() => {
    if (!enabled) return [];
    return collectWorkspaceBrowserEntries({
      serverId,
      workspaceId,
      browsersById,
      layoutByWorkspace,
    }).map(({ browser, hostWorkspaceIds }) => {
      const hosts = hostWorkspaceIds.map((hostId) => {
        const key = resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId: hostId });
        const workspace = key ? workspaces?.get(key) : undefined;
        const name = workspace?.title?.trim() || workspace?.name;
        return name ? `${name} (${hostId})` : hostId;
      });
      return {
        id: `existing-browser:${browser.browserId}`,
        label: browser.title.trim() || browser.url || t("workspace.tabs.fallback.browser"),
        description: hosts.length
          ? t("workspace.tabs.actions.browserHostedIn", { hosts: hosts.join(", ") })
          : t("workspace.tabs.actions.browserNotPresented"),
        Icon: Globe,
        disabled: false,
        launch: (destination) => {
          // Recheck the current store, not a menu snapshot, before moving a guest browser.
          const eligible = collectWorkspaceBrowserEntries({
            serverId,
            workspaceId,
            browsersById: useBrowserStore.getState().browsersById,
            layoutByWorkspace: useWorkspaceLayoutStore.getState().layoutByWorkspace,
          }).some((entry) => entry.browser.browserId === browser.browserId);
          if (
            !eligible ||
            !revealWorkspaceBrowser({ serverId, workspaceId, browserId: browser.browserId })
          ) {
            return;
          }
          if (destination.kind === "replace") {
            const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
            if (!workspaceKey) return;
            const state = useWorkspaceLayoutStore.getState();
            const launcherTab = state
              .getWorkspaceTabs(workspaceKey)
              .find((tab) => tab.tabId === destination.tabId);
            if (launcherTab?.target.kind === "new_tab") {
              state.closeTab(workspaceKey, launcherTab.tabId);
            }
          }
        },
      } satisfies WorkspaceTabLaunchItem;
    });
  }, [browsersById, enabled, layoutByWorkspace, serverId, t, workspaceId, workspaces]);
}
