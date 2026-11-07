import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";

/** Whether removing a draft tab would drop a pending submission, typed text, or attachments. */
export function isDraftTabInUse(input: {
  serverId: string;
  tabId: string;
  draftId: string;
}): boolean {
  const pending = useCreateFlowStore.getState().pendingByDraftId[input.draftId];
  if (pending?.serverId === input.serverId) {
    return true;
  }
  if (
    useWorkspaceDraftSubmissionStore.getState().pendingByDraftId[input.draftId]?.serverId ===
    input.serverId
  ) {
    return true;
  }
  const draft = useDraftStore.getState().getDraftInput(
    buildDraftStoreKey({
      serverId: input.serverId,
      agentId: input.tabId,
      draftId: input.draftId,
    }),
  );
  return Boolean(
    draft?.text.trim() ||
    draft?.attachments.length ||
    useWorkspaceAttachmentsStore.getState().attachmentsByScope[
      buildDraftWorkspaceAttachmentScopeKey(input.draftId)
    ]?.length,
  );
}
