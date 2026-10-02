import { memo, useCallback, type ReactElement } from "react";
import type { BackgroundProcess } from "@omp-desktop/protocol/background-processes";
import type { BackgroundProcessesState } from "@/background-processes/query";
import {
  BackgroundProcessesTrack,
  hasVisibleBackgroundProcessState,
} from "@/background-processes/track";
import { useBackgroundProcessTerminalTabs } from "@/background-processes/terminal-tabs";
import { WorkspaceBranchPill } from "@/composer/branch-pill";
import { useWorkspaceHasBranch } from "@/composer/workspace-branch";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import { useWorkspaceHasDiffStat } from "@/composer/workspace-diff-stat";
import { ComposerTrackBar } from "@/composer/tracks";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  type ArchiveFinishedStatus,
  useArchiveSubagent,
  useDetachSubagent,
  type SubagentRow,
} from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openSidePanelView } from "@/workspace-tabs/side-panel";

/**
 * The pane's ambient workspace changes and subagents as a row of pills above the composer.
 *
 * The row shares the composer's keyboard transform and owns the space between itself and the
 * transcript. Each pill owns its action while tab placement stays behind the workspace boundary.
 */
export const AgentTracks = memo(function AgentTracks({
  serverId,
  workspaceId,
  cwd,
  agentId,
  backgroundProcesses,
  subagentRows,
  archiveFinishedStatus,
  onArchiveFinished,
}: {
  serverId: string;
  workspaceId: string;
  cwd: string;
  agentId: string;
  backgroundProcesses: BackgroundProcessesState;
  subagentRows: SubagentRow[];
  archiveFinishedStatus: ArchiveFinishedStatus;
  onArchiveFinished: () => void;
}): ReactElement | null {
  const toast = useToast();
  const { openTab, tabId, workspaceId: paneWorkspaceId } = usePaneContext();
  const hasWorkspaceDiffStat = useWorkspaceHasDiffStat(serverId, workspaceId);
  const hasWorkspaceBranch = useWorkspaceHasBranch(serverId, workspaceId);
  const isCompact = useIsCompactFormFactor();
  const canSplit = supportsDesktopPaneSplits() && !isCompact;
  const paneWorkspaceKey = buildWorkspaceTabPersistenceKey({
    serverId,
    workspaceId: paneWorkspaceId,
  });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent({ serverId });
  const detachSubagent = useDetachSubagent({ serverId });
  // Sidebar navigation may host an agent tab in a different workspace.
  // Open child tabs through that pane so they stay with their parent.
  const handleOpenSubagent = useCallback(
    (subagentId: string) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(subagentId) ?? session?.agentDetails.get(subagentId);
      if (agent?.workspaceId && agent.workspaceId !== workspaceId) {
        navigateToAgent({ serverId, agentId: subagentId });
        return;
      }
      if (canSplit) {
        openTab({ kind: "agent", agentId: subagentId });
        return;
      }
      navigateToAgent({ serverId, agentId: subagentId });
    },
    [canSplit, openTab, serverId, workspaceId],
  );
  const handleOpenProviderSubagent = useCallback(
    (parentAgentId: string, subagentId: string) => {
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [openTab],
  );
  const handleStopSubagent = useCallback(
    async (subagentId: string) => {
      try {
        const client = useSessionStore.getState().sessions[serverId]?.client;
        if (!client) throw new Error(i18n.t("workspaceSetup.errors.hostDisconnected"));
        await client.cancelAgent(subagentId);
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [serverId, toast],
  );
  const handleStopProviderSubagent = useCallback(
    async (parentAgentId: string, subagentId: string) => {
      try {
        const client = useSessionStore.getState().sessions[serverId]?.client;
        if (!client) throw new Error(i18n.t("workspaceSetup.errors.hostDisconnected"));
        await client.cancelProviderSubagent(parentAgentId, subagentId);
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [serverId, toast],
  );
  const handleOpenProcess = useCallback(
    (process: BackgroundProcess) => {
      if (process.source === "terminal" && process.terminalId) {
        if (!paneWorkspaceKey) return;
        const store = useWorkspaceLayoutStore.getState();
        const processTabId = store.openTab({
          workspaceKey: paneWorkspaceKey,
          target: { kind: "terminal", terminalId: process.terminalId },
          intent: "reveal",
          parentTabId: tabId,
        });
        if (processTabId) {
          useBackgroundProcessTerminalTabs
            .getState()
            .setHidden(paneWorkspaceKey, process.terminalId, false);
          const state = store
            .getWorkspaceTabs(paneWorkspaceKey)
            .find((tab) => tab.tabId === processTabId)?.state;
          store.setTabState(paneWorkspaceKey, processTabId, {
            ...(state && typeof state === "object" && !Array.isArray(state) ? state : {}),
            backgroundProcessOutput: true,
          });
        }
      } else {
        openTab({ kind: "background_process", agentId, processId: process.id });
      }
    },
    [agentId, openTab, paneWorkspaceKey, tabId],
  );
  const handleOpenChanges = useCallback(() => {
    openSidePanelView({
      isCompact,
      workspaceKey: paneWorkspaceKey,
      checkout: { serverId, cwd, isGit: true },
      view: "changes",
    });
  }, [cwd, isCompact, paneWorkspaceKey, serverId]);

  if (
    !hasWorkspaceDiffStat &&
    !hasWorkspaceBranch &&
    !hasVisibleBackgroundProcessState(backgroundProcesses) &&
    !hasAgentTracks({ subagentRows, archiveFinishedStatus })
  ) {
    return null;
  }

  return (
    <ComposerTrackBar>
      <SubagentsTrack
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        onStopSubagent={handleStopSubagent}
        onStopProviderSubagent={handleStopProviderSubagent}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={onArchiveFinished}
        archiveFinishedStatus={archiveFinishedStatus}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
      />
      <BackgroundProcessesTrack state={backgroundProcesses} onOpen={handleOpenProcess} />
      <WorkspaceDiffStatPill
        serverId={serverId}
        workspaceId={workspaceId}
        onPress={handleOpenChanges}
      />
      <WorkspaceBranchPill serverId={serverId} workspaceId={workspaceId} />
    </ComposerTrackBar>
  );
});

export function hasAgentTracks({
  subagentRows,
  archiveFinishedStatus,
}: {
  subagentRows: readonly SubagentRow[];
  archiveFinishedStatus: ArchiveFinishedStatus;
}): boolean {
  return subagentRows.length > 0 || archiveFinishedStatus.kind !== "idle";
}
