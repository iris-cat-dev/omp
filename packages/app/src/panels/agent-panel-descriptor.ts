import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { getProviderIcon } from "@/components/provider-icons";
import {
  resolveAgentTabPrimaryLabel,
  resolveSidebarWorkspacePrimaryLabel,
} from "@/components/sidebar/sidebar-workspace-title";
import { useAppSettings } from "@/hooks/use-settings";
import type { PanelDescriptor, PanelDescriptorContext } from "@/panels/panel-registry";
import { selectAgentTurnPresentation, useSessionStore, type Agent } from "@/stores/session-store";
import { pickWorkspacePrimaryAgentId } from "@/subagents/policies";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";

function formatProviderLabel(provider: Agent["provider"]): string {
  if (!provider) {
    return "Agent";
  }
  return provider
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveAgentDescriptorIdentity(agent: Agent | null) {
  return {
    provider: agent?.provider ?? "codex",
    title: agent?.title ?? null,
    status: agent?.status ?? null,
    pendingPermissionCount: agent?.pendingPermissions.length ?? 0,
    requiresAttention: agent?.requiresAttention ?? false,
    attentionReason: agent?.attentionReason ?? null,
  };
}

export function useAgentPanelDescriptor(
  target: { kind: "agent"; agentId: string },
  context: PanelDescriptorContext,
): PanelDescriptor {
  const { t } = useTranslation();
  const {
    settings: { workspaceTitleSource },
  } = useAppSettings();
  const descriptorState = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[context.serverId];
      if (!session) {
        return {
          ...resolveAgentDescriptorIdentity(null),
          isPrimaryAgent: false,
          workspaceName: null,
          currentBranch: null,
          isTurnActive: false,
        };
      }
      const agent =
        session.agents.get(target.agentId) ?? session.agentDetails.get(target.agentId) ?? null;
      const workspaceId = normalizeWorkspaceOpaqueId(agent?.workspaceId);
      const isPrimaryAgent = Boolean(
        workspaceId &&
        pickWorkspacePrimaryAgentId(
          [...session.agentDetails.values(), ...session.agents.values()],
          workspaceId,
        ) === target.agentId,
      );
      const workspaceKey = isPrimaryAgent
        ? resolveWorkspaceMapKeyByIdentity({
            workspaces: session.workspaces,
            workspaceId,
          })
        : null;
      const workspace = workspaceKey ? session.workspaces.get(workspaceKey) : null;
      return {
        ...resolveAgentDescriptorIdentity(agent),
        isPrimaryAgent,
        workspaceName: workspace?.title ?? workspace?.name ?? null,
        currentBranch: workspace?.gitRuntime?.currentBranch ?? null,
        isTurnActive: selectAgentTurnPresentation(session, target.agentId).isActive,
      };
    }),
  );
  const provider = descriptorState.provider;
  const currentBranch = descriptorState.currentBranch?.trim();
  const workspaceLabel = descriptorState.workspaceName
    ? resolveSidebarWorkspacePrimaryLabel({
        workspace: {
          name: descriptorState.workspaceName,
          currentBranch: currentBranch && currentBranch !== "HEAD" ? currentBranch : null,
        },
        workspaceTitleSource,
      })
    : null;
  const label = resolveAgentTabPrimaryLabel({
    agentTitle: descriptorState.title,
    isPrimaryAgent: descriptorState.isPrimaryAgent,
    workspaceLabel,
    newConversationLabel: t("newWorkspace.title"),
  });
  const icon = getProviderIcon(provider);

  return {
    label: label ?? "",
    subtitle: `${formatProviderLabel(provider)} agent`,
    tooltip: label ?? `${formatProviderLabel(provider)} agent`,
    titleState: label ? "ready" : "loading",
    icon,
    statusBucket: descriptorState.status
      ? deriveSidebarStateBucket({
          status: descriptorState.isTurnActive ? "running" : descriptorState.status,
          pendingPermissionCount: descriptorState.pendingPermissionCount,
          requiresAttention: descriptorState.requiresAttention,
          attentionReason: descriptorState.attentionReason,
        })
      : null,
  };
}
