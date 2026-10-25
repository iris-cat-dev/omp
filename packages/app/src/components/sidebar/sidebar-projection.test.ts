import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId: "srv",
        projectId: viewKey,
        iconWorkingDir: `/repo/${viewKey}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: { groupMode?: "project" | "status" }) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    groupMode: options?.groupMode ?? ("project" as const),
    collapsedProjectKeys: new Set<string>(),
    collapsedWorkspaceGroupKeys: new Set<string>(),
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput(groupMode: "project" | "status") {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput({ groupMode }),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

describe("buildSidebarProjection", () => {
  for (const groupMode of ["project", "status"] as const) {
    it(`hides archived-only conversations in ${groupMode} rows and shortcuts without deleting metadata`, () => {
      const archived = makeWorkspace("archived");
      archived.entry.hasOnlyArchivedAgents = true;
      const empty = makeWorkspace("empty");
      const active = makeWorkspace("active", "running");
      active.entry.hasOnlyArchivedAgents = false;
      const rows = [archived, empty, active];
      const archivedProject = makeProject([archived.placement], "archived-project");
      const input = {
        ...projectionInput({ groupMode }),
        projects: [
          archivedProject,
          makeProject([empty.placement, active.placement]),
          makeProject([], "empty-project"),
        ],
        workspaceEntriesByKey: new Map(rows.map(({ entry }) => [entry.workspaceKey, entry])),
      };
      const projection = buildSidebarProjection(input);
      expect(projection.projects.map((project) => project.viewKey)).toEqual([
        "archived-project",
        "project",
        "empty-project",
      ]);
      expect(projection.projects[0]?.workspaces).toEqual([]);
      expect(projection.projects[1]?.workspaces.map((row) => row.workspaceId).sort()).toEqual([
        "active",
        "empty",
      ]);
      expect(projection.shortcutModel.shortcutTargets.map((row) => row.workspaceId).sort()).toEqual([
        "active",
        "empty",
      ]);
      expect(
        projection.workspaceGroups.flatMap((group) => group.rows.map((row) => row.workspaceId)).sort(),
      ).toEqual(groupMode === "status" ? ["active", "empty"] : []);
      expect(archivedProject.workspaces).toEqual([archived.placement]);
      expect(input.workspaceEntriesByKey.get(archived.entry.workspaceKey)).toBe(archived.entry);
      expect(input.workspaceEntriesByKey.size).toBe(3);
      const restoredEntries = new Map(input.workspaceEntriesByKey);
      restoredEntries.set(archived.entry.workspaceKey, {
        ...archived.entry,
        hasOnlyArchivedAgents: undefined,
      });
      const restored = buildSidebarProjection({ ...input, workspaceEntriesByKey: restoredEntries });
      expect(restored.projects[0]?.workspaces).toEqual([archived.placement]);
      expect(restored.shortcutModel.shortcutTargets.map((row) => row.workspaceId)).toContain("archived");
    });
  }

  it("orders project chats by task status, preserving pins and same-status order", () => {
    const rows = [
      makeWorkspace("done"),
      makeWorkspace("running-first", "running"),
      makeWorkspace("waiting", "needs_input"),
      makeWorkspace("pinned"),
      makeWorkspace("failed", "failed"),
      makeWorkspace("running-second", "running"),
      makeWorkspace("attention", "attention"),
    ];
    const input = {
      ...projectionInput(),
      projects: [makeProject(rows.map((row) => row.placement))],
      pinnedKeys: {
        pinnedWorkspaceKeys: ["srv:pinned"],
        pinnedAtByKey: { "srv:pinned": "2026-07-12T12:00:00.000Z" },
      },
      workspaceEntriesByKey: new Map(rows.map((row) => [row.entry.workspaceKey, row.entry])),
    };
    const projection = buildSidebarProjection(input);
    expect(projection.projects[0]?.workspaces.map((row) => row.workspaceId)).toEqual([
      "pinned",
      "running-first",
      "running-second",
      "waiting",
      "failed",
      "attention",
      "done",
    ]);
    expect(projection.shortcutModel.shortcutTargets.map((row) => row.workspaceId)).toEqual([
      "pinned",
      "running-first",
      "running-second",
      "waiting",
      "failed",
      "attention",
      "done",
    ]);
    const updatedEntries = new Map(input.workspaceEntriesByKey);
    updatedEntries.set("srv:done", { ...rows[0]!.entry, statusBucket: "running" });
    updatedEntries.set("srv:running-first", { ...rows[1]!.entry, statusBucket: "done" });
    const updated = buildSidebarProjection({ ...input, workspaceEntriesByKey: updatedEntries });
    expect(updated.projects[0]?.workspaces.map((row) => row.workspaceId)).toEqual([
      "pinned",
      "done",
      "running-second",
      "waiting",
      "failed",
      "attention",
      "running-first",
    ]);
    expect(input.projects[0]?.workspaces.map((row) => row.workspaceId)).toEqual([
      "done",
      "running-first",
      "waiting",
      "pinned",
      "failed",
      "running-second",
      "attention",
    ]);
  });

  // The rule that outlived the bug it was written for: a project icon is fetched per project, so
  // whatever a mode groups by, the rows it produces can only reference projects already covered.
  for (const groupMode of ["project", "status"] as const) {
    it(`covers every row ${groupMode} grouping renders with a project icon target`, () => {
      const projection = buildSidebarProjection(twoProjectInput(groupMode));
      const covered = new Set(projection.projectIconTargets.map((target) => target.projectViewKey));

      // Every leading visual the sidebar can paint from this projection: grouped rows, project
      // headers and the rows under them.
      const renderedProjectViewKeys = new Set<string>();
      for (const group of projection.workspaceGroups) {
        for (const entry of group.rows) renderedProjectViewKeys.add(entry.projectViewKey);
      }
      for (const project of projection.projects) {
        renderedProjectViewKeys.add(project.viewKey);
        for (const entry of project.workspaces) renderedProjectViewKeys.add(entry.projectViewKey);
      }

      expect([...renderedProjectViewKeys].sort()).toEqual(["other-project", "project"]);
      expect([...renderedProjectViewKeys].filter((viewKey) => !covered.has(viewKey))).toEqual([]);
    });
  }

  it("keeps pinned chats at the top of their project and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.projects[0]?.workspaces.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
      "unpinned",
    ]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("keeps pinned chats in the normal status groups", () => {
    const projection = buildSidebarProjection(projectionInput({ groupMode: "status" }));

    expect(projection.workspaceGroups.map((group) => group.key)).toEqual([
      "needs_input",
      "running",
    ]);
    const workspaceIds: string[] = [];
    for (const group of projection.workspaceGroups) {
      for (const entry of group.rows) workspaceIds.push(entry.workspaceId);
    }
    expect(workspaceIds).toEqual(["unpinned", "pinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
      { serverId: "srv", workspaceId: "pinned" },
    ]);
  });
});
