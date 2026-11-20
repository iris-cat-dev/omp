import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import {
  useActiveWorkspaceSelection,
  useSidebarActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { CompactExplorerSidebar } from "@/components/compact-explorer-sidebar";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { selectIsCompactFileExplorerOpen, usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { useWorkspaceCheckoutStatus } from "@/screens/workspace/use-workspace-checkout-status";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import {
  resolveCompactExplorerSidebarHostModel,
  type CompactExplorerSidebarHostModel,
} from "@/components/compact-explorer-sidebar-host-state";

function useActiveCompactExplorerSidebarModel(
  enabled: boolean,
): CompactExplorerSidebarHostModel | null {
  const routeSelection = useActiveWorkspaceSelection();
  const selection = useSidebarActiveWorkspaceSelection();
  const workspace = useWorkspace(selection?.serverId ?? null, selection?.workspaceId ?? null);
  const workspaces = useSessionStore(
    (state) => state.sessions[routeSelection?.serverId ?? ""]?.workspaces,
  );
  const isExplorerOpen = usePanelStore(selectIsCompactFileExplorerOpen);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const client = useHostRuntimeClient(selection?.serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(selection?.serverId ?? "");
  const retainedModelRef = useRef<CompactExplorerSidebarHostModel | null>(null);
  const { checkoutQuery } = useWorkspaceCheckoutStatus({
    client,
    isConnected,
    isRouteFocused: enabled && selection !== null,
    normalizedServerId: selection?.serverId ?? "",
    normalizedWorkspaceId: selection?.workspaceId ?? "",
    workspaceDirectory: workspace?.workspaceDirectory || null,
  });
  const resolvedModel = useMemo(
    () =>
      resolveCompactExplorerSidebarHostModel({
        previous: isExplorerOpen ? retainedModelRef.current : null,
        routeSelection,
        selection,
        workspace,
        workspaces,
        isGit: checkoutQuery.data?.isGit ?? false,
      }),
    [checkoutQuery.data?.isGit, isExplorerOpen, routeSelection, selection, workspace, workspaces],
  );

  useEffect(() => {
    if (!selection) {
      retainedModelRef.current = null;
      if (enabled && isExplorerOpen) {
        showMobileAgent();
      }
      return;
    }
    if (!isExplorerOpen) {
      retainedModelRef.current = null;
      return;
    }
    if (resolvedModel) {
      retainedModelRef.current = resolvedModel;
    }
  }, [enabled, isExplorerOpen, resolvedModel, selection, showMobileAgent]);

  return selection ? (resolvedModel ?? (isExplorerOpen ? retainedModelRef.current : null)) : null;
}

interface CompactExplorerSidebarHostProps {
  children: ReactNode;
  enabled: boolean;
}

export function CompactExplorerSidebarHost({ children, enabled }: CompactExplorerSidebarHostProps) {
  const model = useActiveCompactExplorerSidebarModel(enabled);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const openTab = useWorkspaceLayoutStore((state) => state.openTab);
  const modelWorkspaceId = model?.workspaceId ?? null;
  const openWorkspaceTabInFocusedPane = useCallback(
    (workspaceKey: string, target: WorkspaceTabTarget) => {
      if (!modelWorkspaceId) return null;
      return openTab({
        workspaceKey,
        target:
          target.workspaceId || target.kind === "setup"
            ? target
            : { ...target, workspaceId: modelWorkspaceId },
        intent: "reveal",
      });
    },
    [modelWorkspaceId, openTab],
  );
  const focusWorkspaceTab = useWorkspaceLayoutStore((state) => state.focusTab);

  const handleOpenFile = useCallback(
    (location: WorkspaceFileLocation) => {
      if (!model) {
        return;
      }
      openWorkspaceFileFromExplorer({
        location,
        persistenceKey: model.persistenceKey,
        showMobileAgent,
        openWorkspaceTabInFocusedPane,
        focusWorkspaceTab,
      });
    },
    [focusWorkspaceTab, model, openWorkspaceTabInFocusedPane, showMobileAgent],
  );
  const handleOpenDiff = useCallback(
    (path: string) => {
      if (!model) {
        return;
      }
      showMobileAgent();
      const tabId = openWorkspaceTabInFocusedPane(model.persistenceKey, {
        kind: "working_diff",
        focusPath: path,
        focusRequestId: Date.now(),
      });
      if (tabId) {
        focusWorkspaceTab(model.persistenceKey, tabId);
      }
    },
    [focusWorkspaceTab, model, openWorkspaceTabInFocusedPane, showMobileAgent],
  );

  return (
    <>
      {children}
      {enabled && model ? (
        <CompactExplorerSidebar
          serverId={model.serverId}
          workspaceId={model.workspaceId}
          workspaceRoot={model.workspaceRoot}
          isGit={model.isGit}
          onOpenFile={handleOpenFile}
          onOpenDiff={handleOpenDiff}
        />
      ) : null}
    </>
  );
}
