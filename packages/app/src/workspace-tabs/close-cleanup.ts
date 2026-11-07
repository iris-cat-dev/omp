import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";

/** Explicitly discard only the closed draft. In-flight agent creates remain protected. */
export function closeWorkspaceDraftTab(input: {
  serverId: string;
  workspaceKey: string;
  tabId: string;
}) {
  const layout = useWorkspaceLayoutStore.getState();
  const target = layout.getWorkspaceTabs(input.workspaceKey).find((tab) => tab.tabId === input.tabId)
    ?.target;
  if (target?.kind !== "draft") return null;
  const result = layout.closeTab(input.workspaceKey, input.tabId);
  if (!result) return result;
  useDraftStore.getState().clearDraftInput({
    draftKey: buildDraftStoreKey({
      serverId: input.serverId,
      agentId: input.tabId,
      draftId: target.draftId,
    }),
    lifecycle: "abandoned",
  });
  useWorkspaceAttachmentsStore.getState().clearWorkspaceAttachments({
    scopeKey: buildDraftWorkspaceAttachmentScopeKey(target.draftId),
  });
  if (target.workspaceId) {
    useWorkspaceDraftSubmissionStore.getState().consumePending({
      serverId: input.serverId,
      workspaceId: target.workspaceId,
      draftId: target.draftId,
    });
  }
  return result;
}

export function resolveClosedTabWorkspaceArchives(input: {
  routeWorkspaceId: string;
  closingTarget: WorkspaceTabTarget | null | undefined;
  routeWorkspaceEmpty: boolean;
}): string[] {
  const draftWorkspaceId =
    input.closingTarget?.kind === "draft" ? input.closingTarget.workspaceId?.trim() : undefined;
  const archiveWorkspaceIds: string[] = [];
  if (draftWorkspaceId && draftWorkspaceId !== input.routeWorkspaceId) {
    archiveWorkspaceIds.push(draftWorkspaceId);
  }
  if (input.routeWorkspaceEmpty) {
    archiveWorkspaceIds.push(input.routeWorkspaceId);
  }
  return archiveWorkspaceIds;
}
