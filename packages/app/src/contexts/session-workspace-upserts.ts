import type { WorkspaceDescriptor } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

interface PendingWorkspaceArchive {
  workspaceId: string;
  phase: "checking" | "recovering" | "hidden";
}

const pendingWorkspaceArchivesByServer = new Map<string, Map<string, PendingWorkspaceArchive>>();

function pendingArchiveKey(input: { serverId: string; workspaceId: string }): string {
  return `${input.serverId.trim()}::${input.workspaceId.trim()}`;
}

export function markWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId: string;
  phase?: PendingWorkspaceArchive["phase"];
}): void {
  const serverId = input.serverId.trim();
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!serverId || !workspaceId) {
    return;
  }

  const archives = pendingWorkspaceArchivesByServer.get(serverId) ?? new Map();
  archives.set(pendingArchiveKey({ serverId, workspaceId }), {
    workspaceId,
    phase: input.phase ?? "hidden",
  });
  pendingWorkspaceArchivesByServer.set(serverId, archives);
}

export function clearWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId: string;
}): void {
  const serverId = input.serverId.trim();
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if (!serverId || !workspaceId) {
    return;
  }

  const archives = pendingWorkspaceArchivesByServer.get(serverId);
  if (!archives) {
    return;
  }
  archives.delete(pendingArchiveKey({ serverId, workspaceId }));
  if (archives.size === 0) {
    pendingWorkspaceArchivesByServer.delete(serverId);
  }
}

export function isWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId?: string | null;
}): boolean {
  const serverId = input.serverId.trim();
  if (!serverId) {
    return false;
  }

  const archives = pendingWorkspaceArchivesByServer.get(serverId);
  if (!archives) {
    return false;
  }

  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  return Boolean(workspaceId && archives.has(pendingArchiveKey({ serverId, workspaceId })));
}

/**
 * Owners may disappear from the directory before an archive response arrives.
 * Keep their tabs while checking emptiness or recovering from a late-content race.
 */
export function listWorkspaceArchivePendingIds(serverId: string): string[] {
  const archives = pendingWorkspaceArchivesByServer.get(serverId.trim());
  return archives ? [...archives.values()].map((entry) => entry.workspaceId) : [];
}

export function reconcileWorkspaceArchivePending(input: {
  serverId: string;
  workspaceId: string;
  kind: "upsert" | "remove";
}): void {
  const phase = pendingWorkspaceArchivesByServer.get(input.serverId.trim())
    ?.get(pendingArchiveKey(input))?.phase;
  if (
    (phase === "hidden" && input.kind === "remove") ||
    (phase === "recovering" && input.kind === "upsert")
  ) {
    clearWorkspaceArchivePending(input);
  }
}

export function shouldSuppressWorkspaceForLocalArchive(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
}): boolean {
  return pendingWorkspaceArchivesByServer.get(input.serverId.trim())
    ?.get(pendingArchiveKey({ serverId: input.serverId, workspaceId: input.workspace.id }))
    ?.phase === "hidden";
}
