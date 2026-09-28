import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import { orderPinnedSidebarProjects } from "@/hooks/use-sidebar-pins";

function placement(workspaceKey: string): SidebarWorkspacePlacement {
  return {
    workspaceKey,
    serverId: "s1",
    workspaceId: workspaceKey,
    projectViewKey: "p1",
    projectName: "Project 1",
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceKey,
  };
}

function project(projectKey: string, workspaces: SidebarWorkspacePlacement[]): SidebarProjectEntry {
  return {
    viewKey: projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: "",
    hosts: [],
    workspaces,
  };
}

describe("orderPinnedSidebarProjects", () => {
  it("keeps every pinned chat inside its project", () => {
    const only = placement("w1");
    const projects = [project("p1", [only])];
    const result = orderPinnedSidebarProjects({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
    });

    expect(result).toEqual(projects);
  });

  it("keeps a genuinely empty project so its new-workspace row stays reachable", () => {
    const projects = [project("p1", [])];
    const result = orderPinnedSidebarProjects({
      projects,
      keys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      pinnedWorkspaceOrder: [],
    });

    expect(result).toHaveLength(1);
  });

  it("moves a pinned chat above the other chats in its project", () => {
    const projects = [project("p1", [placement("w2"), placement("w1")])];
    const result = orderPinnedSidebarProjects({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["w1"],
        pinnedAtByKey: { w1: "2026-01-01T00:00:00Z" },
      },
      pinnedWorkspaceOrder: [],
    });

    expect(result[0]?.workspaces.map((workspace) => workspace.workspaceKey)).toEqual(["w1", "w2"]);
  });

  it("orders pinned chats by most-recently-pinned first", () => {
    const projects = [project("p1", [placement("older"), placement("newer")])];
    const result = orderPinnedSidebarProjects({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["older", "newer"],
        pinnedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
        },
      },
      pinnedWorkspaceOrder: [],
    });

    expect(result[0]?.workspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("applies the saved order while keeping a newly pinned chat first", () => {
    const projects = [project("p1", [placement("older"), placement("newer"), placement("new")])];
    const result = orderPinnedSidebarProjects({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["older", "newer", "new"],
        pinnedAtByKey: {
          older: "2026-01-01T00:00:00Z",
          newer: "2026-02-01T00:00:00Z",
          new: "2026-03-01T00:00:00Z",
        },
      },
      pinnedWorkspaceOrder: ["older", "newer"],
    });

    expect(result[0]?.workspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      "new",
      "older",
      "newer",
    ]);
  });

  it("restores a manual pinned order without changing unpinned or other-project rows", () => {
    const projects = [
      project("p1", [placement("a"), placement("b"), placement("c"), placement("unpinned")]),
      project("p2", [placement("other-a"), placement("other-b")]),
    ];
    const result = orderPinnedSidebarProjects({
      projects,
      keys: {
        pinnedWorkspaceKeys: ["a", "b", "c", "other-a", "other-b"],
        pinnedAtByKey: {
          a: "2026-01-01T00:00:00Z",
          b: "2026-02-01T00:00:00Z",
          c: "2026-03-01T00:00:00Z",
          "other-a": "2026-04-01T00:00:00Z",
          "other-b": "2026-05-01T00:00:00Z",
        },
      },
      pinnedWorkspaceOrder: ["c", "a", "b"],
    });

    expect(result[0]?.workspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      "c",
      "a",
      "b",
      "unpinned",
    ]);
    expect(result[1]?.workspaces.map((workspace) => workspace.workspaceKey)).toEqual([
      "other-b",
      "other-a",
    ]);
  });
});
