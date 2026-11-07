import {
  clearWorkspaceArchivePending,
  isWorkspaceArchivePending,
  markWorkspaceArchivePending,
} from "@/contexts/session-workspace-upserts";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { i18n } from "@/i18n/i18next";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { ensureProjectLayoutsMigrated } from "@/workspace-tabs/project-scope";
import { isWorkspaceSidePanelToolTarget } from "@/workspace-tabs/side-panel-target";
import { isDraftTabInUse } from "@/workspace/draft-tab-usage";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";

export interface WorkspaceArchiveTarget {
  serverId: string;
  workspaceId: string;
}

interface WorkspaceArchiveResult {
  error: string | null;
  skipped?: boolean;
  archivedAt?: string | null;
}

interface WorkspaceArchiveClient {
  archiveWorkspace: (
    workspaceId: string,
    options?: { onlyIfEmpty?: boolean },
  ) => Promise<WorkspaceArchiveResult>;
}

interface OptimisticWorkspaceArchiveSnapshot {
  workspace: WorkspaceDescriptor | null;
}

export interface WorkspaceArchiveFailure {
  serverId: string;
  workspaceId: string;
  error: unknown;
}

function isWorkspaceArchiveFailure(error: unknown): error is WorkspaceArchiveFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "serverId" in error &&
    typeof error.serverId === "string" &&
    "workspaceId" in error &&
    typeof error.workspaceId === "string" &&
    "error" in error
  );
}

function hideWorkspaceOptimistically(
  workspace: WorkspaceArchiveTarget,
): OptimisticWorkspaceArchiveSnapshot {
  const workspaces = useSessionStore.getState().sessions[workspace.serverId]?.workspaces;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: workspace.workspaceId,
  });
  const snapshot = workspaceKey ? (workspaces?.get(workspaceKey) ?? null) : null;
  markWorkspaceArchivePending({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
  });
  useSessionStore.getState().removeWorkspace(workspace.serverId, workspace.workspaceId);
  return { workspace: snapshot };
}

function restoreOptimisticallyHiddenWorkspace(input: {
  serverId: string;
  workspaceId: string;
  snapshot: OptimisticWorkspaceArchiveSnapshot;
}): void {
  clearWorkspaceArchivePending({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (input.snapshot.workspace) {
    useSessionStore.getState().mergeWorkspaces(input.serverId, [input.snapshot.workspace]);
  }
}

async function archiveWorkspaceOrThrow(input: {
  client: WorkspaceArchiveClient;
  workspaceId: string;
}): Promise<void> {
  const payload = await input.client.archiveWorkspace(input.workspaceId);
  if (payload.error) {
    throw new Error(payload.error);
  }
}

export async function archiveWorkspaceOptimistically(input: {
  client: WorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
}): Promise<void> {
  const snapshot = hideWorkspaceOptimistically(input.workspace);

  try {
    await archiveWorkspaceOrThrow({
      client: input.client,
      workspaceId: input.workspace.workspaceId,
    });
  } catch (error) {
    restoreOptimisticallyHiddenWorkspace({
      serverId: input.workspace.serverId,
      workspaceId: input.workspace.workspaceId,
      snapshot,
    });
    throw error;
  }
}

function hasProtectedWorkspaceContent(input: {
  workspace: WorkspaceArchiveTarget;
  closedDraftId?: string;
  hasPendingTerminalCreate: boolean;
  preserveDrafts?: boolean;
}): boolean {
  const { serverId, workspaceId } = input.workspace;
  if (input.hasPendingTerminalCreate) return true;
  if (input.preserveDrafts) {
    const attachments = useWorkspaceAttachmentsStore.getState().attachmentsByScope;
    const workspaceScope = buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd: "" });
    if (attachments[workspaceScope]?.length) return true;
    ensureProjectLayoutsMigrated(serverId);
    for (const [key, layout] of Object.entries(useWorkspaceLayoutStore.getState().layoutByWorkspace)) {
      if (!key.startsWith(`${serverId}:project:`)) continue;
      for (const tab of collectAllTabs(layout.root)) {
        if (tab.target.workspaceId !== workspaceId) continue;
        if (tab.target.kind === "agent") return true;
        if (
          tab.target.kind === "draft" &&
          (tab.target.draftId !== input.closedDraftId ||
            isDraftTabInUse({ serverId, tabId: tab.tabId, draftId: tab.target.draftId }))
        ) return true;
      }
    }
  }
  for (const pending of Object.values(useCreateFlowStore.getState().pendingByDraftId)) {
    if (
      pending.serverId === serverId &&
      (pending.workspaceId === workspaceId || pending.draftId === input.closedDraftId)
    ) return true;
  }
  return Object.values(useWorkspaceDraftSubmissionStore.getState().pendingByDraftId).some(
    (pending) => pending.serverId === serverId && pending.workspaceId === workspaceId,
  );
}

// Unlike explicit archives, closing an unused conversation must not hide anything
// until the server has checked its persisted history and live resources.
export async function archiveEmptyWorkspace(input: {
  client: (WorkspaceArchiveClient & { restoreWorkspace: (workspaceId: string) => Promise<void> }) | null;
  workspace: WorkspaceArchiveTarget;
  closedDraftId?: string;
  hasPendingTerminalCreate: boolean;
  preserveDrafts?: boolean;
}): Promise<boolean> {
  const { serverId, workspaceId } = input.workspace;
  if (hasProtectedWorkspaceContent(input)) return false;
  if (!input.client) {
    throw new Error(i18n.t("sidebar.workspace.toasts.hostDisconnected"));
  }
  if (
    useSessionStore.getState().sessions[serverId]?.serverInfo?.features?.workspaceArchiveIfEmpty !==
    true
  ) {
    // Older daemons strip unknown request fields and would archive unconditionally.
    throw new Error(i18n.t("sidebar.workspace.toasts.updateHostToArchiveEmpty"));
  }
  if (isWorkspaceArchivePending(input.workspace)) return false;
  markWorkspaceArchivePending({ ...input.workspace, phase: "checking" });
  let payload: WorkspaceArchiveResult;
  try {
    payload = await input.client.archiveWorkspace(workspaceId, { onlyIfEmpty: true });
  } catch (error) {
    clearWorkspaceArchivePending(input.workspace);
    throw error;
  }
  if (payload.error) {
    clearWorkspaceArchivePending(input.workspace);
    throw new Error(payload.error);
  }
  if (payload.skipped) {
    clearWorkspaceArchivePending(input.workspace);
    return false;
  }
  if (!payload.archivedAt) {
    clearWorkspaceArchivePending(input.workspace);
    throw new Error(i18n.t("sidebar.workspace.toasts.archiveFailed"));
  }
  if (hasProtectedWorkspaceContent(input)) {
    // A new conversation claimed this checkout while the server checked emptiness.
    // Restore it before reporting completion; never sweep its new drafts or inputs.
    markWorkspaceArchivePending({ ...input.workspace, phase: "recovering" });
    await input.client.restoreWorkspace(workspaceId);
    // Keep ownership until a directory upsert/snapshot confirms the restore.
    return false;
  }
  markWorkspaceArchivePending(input.workspace);
  removeUnusedWorkspaceTabs({ serverId, workspaceId });
  return true;
}

// Remove unused views and companion tools only when no conversation claimed the
// workspace during the conditional archive request.
function removeUnusedWorkspaceTabs(input: { serverId: string; workspaceId: string }): void {
  const { serverId, workspaceId } = input;
  useSessionStore.getState().removeWorkspace(serverId, workspaceId);
  const prefix = `${serverId}:project:`;
  for (const [workspaceKey, layout] of Object.entries(
    useWorkspaceLayoutStore.getState().layoutByWorkspace,
  )) {
    if (!workspaceKey.startsWith(prefix)) continue;
    for (const tab of collectAllTabs(layout.root)) {
      if (
        tab.target.workspaceId === workspaceId &&
        (tab.target.kind === "draft" ||
          tab.target.kind === "workspace_overview" ||
          isWorkspaceSidePanelToolTarget(tab.target))
      ) {
        useWorkspaceLayoutStore.getState().closeTab(workspaceKey, tab.tabId);
      }
    }
  }
}

export async function archiveWorkspacesOptimistically(input: {
  getClient: (serverId: string) => WorkspaceArchiveClient | null;
  workspaces: WorkspaceArchiveTarget[];
}): Promise<WorkspaceArchiveFailure[]> {
  const results = await Promise.allSettled(
    input.workspaces.map(async (workspace) => {
      const client = input.getClient(workspace.serverId);
      if (!client) {
        throw {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
          error: new Error(i18n.t("sidebar.workspace.toasts.hostDisconnected")),
        } satisfies WorkspaceArchiveFailure;
      }

      try {
        await archiveWorkspaceOptimistically({
          client,
          workspace,
        });
      } catch (error) {
        throw {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
          error,
        } satisfies WorkspaceArchiveFailure;
      }
    }),
  );

  return results.flatMap((result) =>
    result.status === "rejected" && isWorkspaceArchiveFailure(result.reason) ? [result.reason] : [],
  );
}
