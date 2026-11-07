import type { Logger } from "pino";

import { getWorkingTreeRootForGitDir } from "../../utils/checkout-git.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";

// Earlier discovery could persist a submodule's administrative directory as its
// source root. Recheck on startup so temporarily unavailable checkouts can heal
// later, without changing identities or merging existing projects/workspaces.
export async function repairGitDirectoryRoots(options: {
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  logger: Logger;
}): Promise<void> {
  const roots = new Map<string, Promise<string | null>>();
  function resolveRoot(gitDir: string): Promise<string | null> {
    let root = roots.get(gitDir);
    if (!root) {
      root = getWorkingTreeRootForGitDir(gitDir);
      roots.set(gitDir, root);
    }
    return root;
  }

  let projectsRepaired = 0;
  let workspacesRepaired = 0;
  for (const project of await options.projectRegistry.list()) {
    if (project.kind !== "git") continue;
    const rootPath = await resolveRoot(project.rootPath);
    if (!rootPath) continue;
    await options.projectRegistry.upsert({ ...project, rootPath });
    projectsRepaired += 1;
  }
  // Do not derive this from project repairs: the project may already be correct,
  // and archived workspaces must retain a usable source root for recovery too.
  for (const workspace of await options.workspaceRegistry.list()) {
    if (!workspace.mainRepoRoot) continue;
    const mainRepoRoot = await resolveRoot(workspace.mainRepoRoot);
    if (!mainRepoRoot) continue;
    await options.workspaceRegistry.upsert({ ...workspace, mainRepoRoot });
    workspacesRepaired += 1;
  }

  if (projectsRepaired > 0 || workspacesRepaired > 0) {
    options.logger.info(
      { projectsRepaired, workspacesRepaired },
      "Repaired Git administrative directory roots in workspace registries",
    );
  }
}
