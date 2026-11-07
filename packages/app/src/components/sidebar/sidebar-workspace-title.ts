import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { STATUS_BUCKET_LABELS } from "@/hooks/sidebar-status-view-model";

export function resolveSidebarWorkspacePrimaryLabel(
  workspace: Pick<SidebarWorkspaceEntry, "name" | "isUnstarted">,
  unstartedLabel: string,
): string {
  return workspace.isUnstarted ? unstartedLabel : workspace.name;
}

export function resolveAgentTabPrimaryLabel(input: {
  agentTitle: string | null | undefined;
  isPrimaryAgent: boolean;
  workspaceLabel?: string | null;
  newConversationLabel: string;
}): string | null {
  if (input.isPrimaryAgent && input.workspaceLabel) {
    return input.workspaceLabel;
  }
  const title = input.agentTitle?.trim();
  if (title && title.toLowerCase() !== "new agent") {
    return title;
  }
  return input.isPrimaryAgent ? input.newConversationLabel : null;
}

export function resolveSidebarWorkspaceAccessibilityLabel(input: {
  workspace: Pick<SidebarWorkspaceEntry, "name" | "statusBucket" | "isUnstarted">;
  leadingProjectName?: string | null;
  hostBadgeLabel?: string | null;
  pullRequestLabel?: string | null;
  serviceLabel?: string | null;
  unstartedLabel?: string;
}): string {
  return [
    input.leadingProjectName,
    resolveSidebarWorkspacePrimaryLabel(input.workspace, input.unstartedLabel ?? input.workspace.name),
    input.hostBadgeLabel,
    input.pullRequestLabel,
    input.serviceLabel,
    input.workspace.statusBucket === "done"
      ? null
      : STATUS_BUCKET_LABELS[input.workspace.statusBucket],
  ]
    .filter((label): label is string => Boolean(label))
    .join(", ");
}
