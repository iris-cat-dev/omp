import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import {
  buildSidebarProjectRowModel,
  resolveSidebarProjectIconTarget,
  resolveSidebarProjectIconTargets,
  resolveSidebarProjectLocalPath,
} from "./sidebar-project-row-model";

function workspace(overrides: Partial<SidebarWorkspaceEntry> = {}): SidebarWorkspaceEntry {
  return {
    workspaceKey: "srv:ws-root",
    serverId: "srv",
    workspaceId: "ws-root",
    projectViewKey: "project-1",
    projectName: "paseo",
    workspaceDirectory: "/repo",
    workspaceDirectoryLabel: "/repo",
    projectKind: "git",
    workspaceKind: "checkout",
    name: "paseo",
    title: null,
    currentBranch: null,
    statusBucket: "done",
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    statusEnteredAt: null,
    ...overrides,
    archivingAt: overrides.archivingAt ?? null,
  };
}

type ProjectOverrides = Omit<Partial<SidebarProjectEntry>, "hosts"> & {
  hosts?: Array<Omit<SidebarProjectEntry["hosts"][number], "projectId"> & { projectId?: string }>;
};

function project(overrides: ProjectOverrides = {}): SidebarProjectEntry {
  const projectKind = overrides.projectKind ?? "git";
  const hosts = Array.from(
    overrides.hosts ?? [
      {
        serverId: "srv",
        iconWorkingDir: "/repo",
        worktreeSupport: projectKind === "git" ? "supported" : "unsupported",
      },
    ],
    (host) => Object.assign({}, host, { projectId: host.projectId ?? `project-${host.serverId}` }),
  );
  return {
    viewKey: "project-1",
    projectName: "paseo",
    projectKind,
    iconWorkingDir: "/repo",
    workspaces: [workspace()],
    ...overrides,
    hosts,
  };
}

describe("buildSidebarProjectRowModel", () => {
  it("keeps the Agent entry for a non-git project without workspace multiplicity", () => {
    const result = buildSidebarProjectRowModel({
      project: project({
        projectKind: "directory",
        workspaces: [workspace({ workspaceId: "ws-non-git", workspaceKind: "checkout" })],
      }),
    });

    expect(result).toEqual({
      kind: "project_section",
      trailingAction: {
        kind: "new_agent",
        target: { serverId: "srv", projectId: "project-srv", iconWorkingDir: "/repo" },
      },
    });
  });
  it("targets the project's first host even without worktree support", () => {
    const result = buildSidebarProjectRowModel({
      project: project({
        hosts: [
          { serverId: "host-a", iconWorkingDir: "/repo/a", worktreeSupport: "unsupported" },
          { serverId: "host-b", iconWorkingDir: "/repo/b", worktreeSupport: "supported" },
        ],
      }),
    });

    expect(result.trailingAction).toEqual({
      kind: "new_agent",
      target: { serverId: "host-a", projectId: "project-host-a", iconWorkingDir: "/repo/a" },
    });
  });

  it("resolves project icons from the project host, not the focused host", () => {
    const iconTarget = resolveSidebarProjectIconTarget(
      project({
        hosts: [
          { serverId: "host-b", iconWorkingDir: "/repo/b", worktreeSupport: "supported" as const },
          { serverId: "host-a", iconWorkingDir: "/repo/a", worktreeSupport: "supported" as const },
        ],
      }),
    );

    expect(iconTarget).toEqual({
      serverId: "host-b",
      projectId: "project-host-b",
      iconWorkingDir: "/repo/b",
    });
  });

  it("keys project icon results by the rendered project view", () => {
    const [iconTarget] = resolveSidebarProjectIconTargets([
      project({
        viewKey: '["placement","host-b","project-b"]',
        hosts: [
          {
            serverId: "host-b",
            iconWorkingDir: "/repo/b",
            worktreeSupport: "supported" as const,
            iconRevision: "effective-revision",
          },
        ],
      }),
    ]);

    expect(iconTarget).toEqual({
      projectViewKey: '["placement","host-b","project-b"]',
      serverId: "host-b",
      projectId: "project-host-b",
      iconWorkingDir: "/repo/b",
      iconRevision: "effective-revision",
    });
  });

  it("resolves desktop file actions from the local project placement", () => {
    const groupedProject = project({
      iconWorkingDir: "/remote/repo",
      hosts: [
        {
          serverId: "remote",
          iconWorkingDir: "/remote/repo",
          worktreeSupport: "supported" as const,
        },
        { serverId: "local", iconWorkingDir: "/local/repo", worktreeSupport: "supported" as const },
      ],
    });

    expect(resolveSidebarProjectLocalPath(groupedProject, "local")).toBe("/local/repo");
    expect(resolveSidebarProjectLocalPath(groupedProject, "missing")).toBe("");
  });

  it("keeps the Agent entry for an empty project", () => {
    const result = buildSidebarProjectRowModel({
      project: project({ projectKind: "git", workspaces: [] }),
    });

    expect(result).toEqual({
      kind: "project_section",
      trailingAction: {
        kind: "new_agent",
        target: { serverId: "srv", projectId: "project-srv", iconWorkingDir: "/repo" },
      },
    });
  });
});
