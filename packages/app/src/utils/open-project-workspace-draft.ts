import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { generateDraftId } from "@/stores/draft-keys";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import { remapDraftCwdToWorkspace } from "@/utils/remap-draft-cwd-to-workspace";
import { archiveEmptyWorkspace } from "@/workspace/workspace-archive";

const pendingProjectDrafts = new Map<string, Promise<void>>();

interface OpenProjectWorkspaceDraftInput {
  serverId: string;
  projectId: string;
  projectRootPath: string;
  draftId?: string;
  tabHost?: ActiveWorkspaceSelection | null;
  setup?: WorkspaceDraftTabSetup;
  sourceDirectory?: string;
}

export function openProjectWorkspaceDraft(input: OpenProjectWorkspaceDraftInput): Promise<void> {
  // Forks and explicitly configured drafts carry independent content, even in one project.
  if (input.draftId || input.setup || input.sourceDirectory) {
    return createProjectWorkspaceDraft(input);
  }
  const key = JSON.stringify([input.serverId, input.projectId]);
  const existing = pendingProjectDrafts.get(key);
  if (existing) return existing;
  // Install the guard before calling the client: all entry points share this pending request.
  const pending = Promise.resolve()
    .then(() => createProjectWorkspaceDraft(input))
    .finally(() => pendingProjectDrafts.delete(key));
  pendingProjectDrafts.set(key, pending);
  return pending;
}

async function createProjectWorkspaceDraft(input: OpenProjectWorkspaceDraftInput): Promise<void> {
  const { serverId, projectId, projectRootPath } = input;
  if (!serverId.trim() || !projectId.trim() || !projectRootPath.trim()) {
    throw new Error("A host and project are required to open an agent draft");
  }

  const session = useSessionStore.getState().sessions[serverId];
  if (!session?.client) throw new Error("Host is unavailable");
  const tabHostWorkspace =
    input.tabHost?.serverId === serverId
      ? session.workspaces.get(input.tabHost.workspaceId)
      : undefined;
  const validTabHost =
    tabHostWorkspace?.projectId === projectId && !tabHostWorkspace.archivingAt
      ? tabHostWorkspace
      : null;
  const payload = await session.client.createWorkspace({
    source: { kind: "directory", path: projectRootPath, projectId },
  });
  if (payload.error || !payload.workspace) {
    throw new Error(payload.error ?? "Unable to create workspace");
  }
  const workspace = normalizeWorkspaceDescriptor(payload.workspace);
  useSessionStore.getState().mergeWorkspaces(serverId, [workspace]);
  const draftId = input.draftId?.trim() || generateDraftId();
  try {
    const setup = input.setup
      ? {
          ...input.setup,
          cwd: remapDraftCwdToWorkspace({
            cwd: input.setup.cwd,
            sourceDirectory: input.sourceDirectory,
            workspaceDirectory: workspace.workspaceDirectory,
          }),
        }
      : undefined;
    const currentTabHost = validTabHost
      ? useSessionStore.getState().sessions[serverId]?.workspaces.get(validTabHost.id)
      : null;
    const tabHostWorkspaceId =
      currentTabHost?.projectId === projectId && !currentTabHost.archivingAt
        ? currentTabHost.id
        : workspace.id;
    navigateToWorkspace({
      serverId,
      workspaceId: tabHostWorkspaceId,
      target: {
        kind: "draft",
        draftId,
        workspaceId: workspace.id,
        ...(setup ? { setup } : {}),
      },
    });
  } catch (error) {
    try {
      await archiveEmptyWorkspace({
        client: session.client,
        workspace: { serverId, workspaceId: workspace.id },
        closedDraftId: draftId,
        hasPendingTerminalCreate: false,
        preserveDrafts: true,
      });
    } catch (cleanupError) {
      // Leave the record visible for conditional cleanup; navigation's error stays primary.
      console.error("Failed to clean up workspace after draft navigation failed", cleanupError);
    }
    throw error;
  }
}
