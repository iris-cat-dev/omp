import type { BrowserRecord } from "@/desktop/browser/store/state";
import { collectAllTabs, type WorkspaceLayout } from "@/stores/workspace-layout-actions";

export interface WorkspaceBrowserEntry {
  browser: BrowserRecord;
  hostWorkspaceIds: string[];
}

/** Owner browsers can be recovered; guests are discoverable only in their current host. */
export function collectWorkspaceBrowserEntries(input: {
  serverId: string;
  workspaceId: string;
  browsersById: Record<string, BrowserRecord>;
  layoutByWorkspace: Record<string, WorkspaceLayout>;
}): WorkspaceBrowserEntry[] {
  const { serverId, workspaceId, browsersById, layoutByWorkspace } = input;
  if (!serverId || !workspaceId) return [];

  const hostWorkspaceIdsByBrowser = new Map<string, string[]>();
  const serverPrefix = `${serverId}:`;
  for (const [workspaceKey, layout] of Object.entries(layoutByWorkspace)) {
    if (!workspaceKey.startsWith(serverPrefix)) continue;
    const hostWorkspaceId = workspaceKey.slice(serverPrefix.length);
    for (const tab of collectAllTabs(layout.root)) {
      if (tab.target.kind !== "browser") continue;
      const hosts = hostWorkspaceIdsByBrowser.get(tab.target.browserId) ?? [];
      if (!hosts.includes(hostWorkspaceId)) hosts.push(hostWorkspaceId);
      hostWorkspaceIdsByBrowser.set(tab.target.browserId, hosts);
    }
  }

  return Object.values(browsersById).flatMap((browser) => {
    if (browser.automationServerId && browser.automationServerId !== serverId) return [];
    const hostWorkspaceIds = hostWorkspaceIdsByBrowser.get(browser.browserId) ?? [];
    const ownedHere =
      browser.automationServerId === serverId && browser.automationWorkspaceId === workspaceId;
    if (!ownedHere && !hostWorkspaceIds.includes(workspaceId)) return [];
    return [{ browser, hostWorkspaceIds }];
  });
}
