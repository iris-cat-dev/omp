import { buildStatusGroups } from "@/hooks/sidebar-status-view-model";
import { orderPinnedSidebarProjects, type PinnedSidebarKeys } from "@/hooks/use-sidebar-pins";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import {
  resolveSidebarProjectIconTargets,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";
import { statusWorkspaceGroups, type SidebarWorkspaceGroup } from "./sidebar-labels";

export interface SidebarProjection {
  projects: SidebarProjectEntry[];
  workspaceGroups: SidebarWorkspaceGroup[];
  /**
   * The project icons this projection needs fetched, keyed by `projectViewKey` — one per project,
   * whatever the mode groups by. It sits here rather than beside `useProjectIcons` in the list
   * because it is the same `projects` the rows above are projected from: a mode that renders a
   * row can only ever ask for an icon this list already covers. It used to be derived in the
   * list, under a `groupMode === "status"` gate written when status was the only mode that put
   * icons on rows.
   */
  projectIconTargets: SidebarProjectIconTarget[];
  shortcutModel: SidebarShortcutModel;
}

export interface SidebarProjectionInput {
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  projectNamesByViewKey: Map<string, string>;
  groupMode: SidebarGroupMode;
  collapsedProjectKeys: ReadonlySet<string>;
  collapsedWorkspaceGroupKeys: ReadonlySet<string>;
}

const PROJECT_STATUS_RANK: Record<SidebarWorkspaceEntry["statusBucket"], number> = {
  running: 0,
  needs_input: 1,
  failed: 2,
  attention: 3,
  done: 4,
};

export function buildSidebarProjection(input: SidebarProjectionInput): SidebarProjection {
  // Archive visibility is sidebar-only: keep the project header and source workspace
  // metadata, but remove its conversation row before grouping and shortcut projection.
  const visibleProjects = input.projects.map((project) => {
    const workspaces = project.workspaces.filter(
      (workspace) =>
        input.workspaceEntriesByKey.get(workspace.workspaceKey)?.hasOnlyArchivedAgents !== true,
    );
    return workspaces.length === project.workspaces.length ? project : { ...project, workspaces };
  });
  let projects = orderPinnedSidebarProjects({
    projects: visibleProjects,
    keys: input.pinnedKeys,
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
  });
  if (input.groupMode === "project") {
    const pinned = new Set(input.pinnedKeys.pinnedWorkspaceKeys);
    const compareWorkspaces = (left: SidebarWorkspacePlacement, right: SidebarWorkspacePlacement) =>
      Number(pinned.has(right.workspaceKey)) - Number(pinned.has(left.workspaceKey)) ||
      PROJECT_STATUS_RANK[
        input.workspaceEntriesByKey.get(left.workspaceKey)?.statusBucket ?? "done"
      ] -
        PROJECT_STATUS_RANK[
          input.workspaceEntriesByKey.get(right.workspaceKey)?.statusBucket ?? "done"
        ];
    projects = projects.map((project) => {
      const needsSorting = project.workspaces.some(
        (workspace, index, rows) => index > 0 && compareWorkspaces(rows[index - 1]!, workspace) > 0,
      );
      return needsSorting
        ? { ...project, workspaces: project.workspaces.toSorted(compareWorkspaces) }
        : project;
    });
  }
  const orderedWorkspaces = projects.flatMap((project) =>
    project.workspaces.flatMap((workspace) => {
      const entry = input.workspaceEntriesByKey.get(workspace.workspaceKey);
      return entry ? [entry] : [];
    }),
  );
  // One switch decides both what the list groups by and what the keyboard shortcuts walk, so the
  // two cannot disagree and a new grouping mode is a compile error here rather than a silent
  // fall-through to the project rows.
  const workspaceGroups = buildWorkspaceGroups(input, orderedWorkspaces);

  const sections: SidebarShortcutSection[] = [];
  if (input.groupMode === "project") {
    sections.push(
      ...projects.map((project) => ({
        workspaces: project.workspaces,
        collapsed: input.collapsedProjectKeys.has(project.viewKey),
      })),
    );
  } else {
    sections.push(
      ...workspaceGroups.map((group) => ({
        workspaces: group.rows,
        collapsed: input.collapsedWorkspaceGroupKeys.has(group.key),
      })),
    );
  }

  return {
    projects,
    workspaceGroups,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}

/** Project mode keeps its project headers and groups nothing; status mode groups the rows. */
function buildWorkspaceGroups(
  input: SidebarProjectionInput,
  workspaces: SidebarWorkspaceEntry[],
): SidebarWorkspaceGroup[] {
  switch (input.groupMode) {
    case "project":
      return [];
    case "status":
      return statusWorkspaceGroups(buildStatusGroups(workspaces, input.projectNamesByViewKey));
  }
}
