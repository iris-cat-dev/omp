import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import {
  confirmRiskyWorktreeArchive,
  DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
  type WorktreeArchiveWarningLabels,
} from "@/git/worktree-archive-warning";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { archiveEmptyWorkspace, archiveWorkspaceOptimistically } from "@/workspace/workspace-archive";
import {
  captureWorkspaceTabCleanup,
  closeWorkspaceAgentTabs,
} from "@/workspace/workspace-tab-cleanup";

export interface ArchiveWorkspaceInput {
  serverId: string;
  workspaceId: string;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  name: string;
  onlyIfEmpty?: boolean;
  isDirty?: boolean | null;
  aheadOfOrigin?: number | null;
  diffStat?: { additions: number; deletions: number } | null;
  warningLabels?: WorktreeArchiveWarningLabels;
  onArchiveStarted: () => void;
  onSetHiding?: (hiding: boolean) => void;
}

export interface WorkspaceArchiveController {
  archive: () => void;
}

export function useWorkspaceArchive(input: ArchiveWorkspaceInput): WorkspaceArchiveController {
  const {
    serverId,
    workspaceId,
    workspaceKind,
    name,
    onlyIfEmpty = false,
    isDirty,
    aheadOfOrigin,
    diffStat,
    warningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
    onArchiveStarted,
    onSetHiding,
  } = input;
  const { t } = useTranslation();
  const toast = useToast();

  const archiveWorkspaceRecord = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (onlyIfEmpty) {
      onSetHiding?.(true);
      try {
        const archived = await archiveEmptyWorkspace({
          client,
          workspace: { serverId, workspaceId },
          hasPendingTerminalCreate: false,
          preserveDrafts: true,
        });
        if (archived) onArchiveStarted();
      } catch (error) {
        toast.error(
          t("sidebar.workspace.toasts.emptyArchiveFailed", {
            reason: error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
          }),
        );
      } finally {
        onSetHiding?.(false);
      }
      return;
    }
    if (!client) {
      toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
      return;
    }
    const tabCleanup = captureWorkspaceTabCleanup({ serverId, workspaceId });
    onSetHiding?.(true);
    try {
      onArchiveStarted();
      await archiveWorkspaceOptimistically({
        client,
        workspace: {
          serverId,
          workspaceId,
        },
      });
      closeWorkspaceAgentTabs(tabCleanup);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
      );
    } finally {
      onSetHiding?.(false);
    }
  }, [onArchiveStarted, onSetHiding, onlyIfEmpty, serverId, t, toast, workspaceId]);

  const archive = useCallback(() => {
    void (async () => {
      if (workspaceKind === "worktree") {
        const confirmed = await confirmRiskyWorktreeArchive(
          {
            workspaceName: name,
            isDirty,
            aheadOfOrigin,
            diffStat,
          },
          warningLabels,
        );
        if (!confirmed) {
          return;
        }
      }
      await archiveWorkspaceRecord();
    })();
  }, [
    aheadOfOrigin,
    archiveWorkspaceRecord,
    diffStat,
    isDirty,
    name,
    warningLabels,
    workspaceKind,
  ]);

  return {
    archive,
  };
}
