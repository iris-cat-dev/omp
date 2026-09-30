import {
  collectAllPanes,
  collectAllTabs,
  getFocusedBrowserId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export function getBrowserPresentation(input: {
  serverId: string;
  ownerWorkspaceId: string;
  browserId: string;
  visibleWorkspace: ActiveWorkspaceSelection | null;
}) {
  const layouts = useWorkspaceLayoutStore.getState().layoutByWorkspace;
  const visibleKey =
    input.visibleWorkspace?.serverId === input.serverId
      ? buildWorkspaceTabPersistenceKey(input.visibleWorkspace)
      : null;
  const visibleLayout = visibleKey ? layouts[visibleKey] : undefined;
  const visibleTab = visibleLayout
    ? collectAllTabs(visibleLayout.root).find(
        (tab) => tab.target.kind === "browser" && tab.target.browserId === input.browserId,
      )
    : undefined;
  const presented = Boolean(
    visibleLayout &&
    visibleTab &&
    collectAllPanes(visibleLayout.root).some(
      (pane) => pane.hidden !== true && pane.tabIds.includes(visibleTab.tabId),
    ),
  );
  let presentationHostWorkspaceId: string | null = presented
    ? input.visibleWorkspace!.workspaceId
    : null;
  if (!presentationHostWorkspaceId) {
    const prefix = `${input.serverId}:`;
    for (const [key, layout] of Object.entries(layouts)) {
      if (
        key.startsWith(prefix) &&
        collectAllTabs(layout.root).some(
          (tab) => tab.target.kind === "browser" && tab.target.browserId === input.browserId,
        )
      ) {
        presentationHostWorkspaceId = key.slice(prefix.length);
        break;
      }
    }
  }
  return {
    ownerWorkspaceId: input.ownerWorkspaceId,
    presentationHostWorkspaceId,
    presented,
    activated: presented && getFocusedBrowserId(visibleLayout) === input.browserId,
  };
}

/** Move only the presentation target; keep the resident guest and automation owner intact. */
export function revealWorkspaceBrowser(input: {
  serverId: string;
  workspaceId: string;
  browserId: string;
}): boolean {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  if (!workspaceKey) return false;
  const store = useWorkspaceLayoutStore.getState();
  const tabId = store.openTab({
    workspaceKey,
    target: { kind: "browser", browserId: input.browserId },
    intent: "reveal",
  });
  if (!tabId) return false;
  for (const [key, layout] of Object.entries(store.layoutByWorkspace)) {
    if (key === workspaceKey || !key.startsWith(`${input.serverId}:`)) continue;
    for (const tab of collectAllTabs(layout.root)) {
      if (tab.target.kind === "browser" && tab.target.browserId === input.browserId) {
        useWorkspaceLayoutStore.getState().closeTab(key, tab.tabId);
      }
    }
  }
  return true;
}
