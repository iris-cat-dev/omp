import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { createProjectIconTarget, type ProjectIconTarget } from "@/projects/icon-target";

export interface SidebarProjectHostTarget {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  customIconRevision?: string | null;
  iconRevision?: string;
}

export type SidebarProjectTrailingAction =
  | { kind: "new_agent"; target: SidebarProjectHostTarget }
  | { kind: "none" };

export interface SidebarProjectSectionRowModel {
  kind: "project_section";
  trailingAction: SidebarProjectTrailingAction;
}

export type SidebarProjectRowModel = SidebarProjectSectionRowModel;

function hostTarget(input: {
  serverId: string;
  projectId: string;
  iconWorkingDir: string;
  customIconRevision?: string | null;
  iconRevision?: string;
}): SidebarProjectHostTarget | null {
  const iconWorkingDir = input.iconWorkingDir.trim();
  if (!input.serverId || !iconWorkingDir) {
    return null;
  }
  return {
    serverId: input.serverId,
    projectId: input.projectId,
    iconWorkingDir,
    customIconRevision: input.customIconRevision,
    iconRevision: input.iconRevision,
  };
}

export function resolveSidebarProjectIconTarget(
  project: SidebarProjectEntry,
): SidebarProjectHostTarget | null {
  for (const host of project.hosts) {
    const target = hostTarget(host);
    if (target) {
      return target;
    }
  }
  return null;
}

export type SidebarProjectIconTarget = ProjectIconTarget;

export function resolveSidebarProjectIconTargets(
  projects: readonly SidebarProjectEntry[],
): SidebarProjectIconTarget[] {
  return projects.flatMap((project) => {
    const target = resolveSidebarProjectIconTarget(project);
    const iconTarget = target
      ? createProjectIconTarget({ projectViewKey: project.viewKey, placement: target })
      : null;
    return iconTarget ? [iconTarget] : [];
  });
}

export function resolveSidebarProjectLocalPath(
  project: SidebarProjectEntry,
  localServerId: string | null,
): string {
  if (!localServerId) return "";
  return project.hosts.find((host) => host.serverId === localServerId)?.iconWorkingDir.trim() ?? "";
}

// Agent drafts can be opened in the project's existing checkout. Creating a second
// workspace is only necessary when that checkout has not yet been provisioned.
export function buildSidebarProjectRowModel(input: {
  project: SidebarProjectEntry;
}): SidebarProjectRowModel {
  const target = resolveSidebarProjectIconTarget(input.project);
  return {
    kind: "project_section",
    trailingAction: target ? { kind: "new_agent", target } : { kind: "none" },
  };
}
