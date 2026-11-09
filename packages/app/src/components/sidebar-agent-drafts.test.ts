import { describe, expect, it } from "vitest";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { SplitPane, WorkspaceLayout } from "@/stores/workspace-layout-store";
import { groupSidebarAgentDrafts } from "./sidebar-agent-drafts";
import { buildSidebarWorkspaceEntries } from "@/hooks/sidebar-workspaces-view-model";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";

const hostWorkspace = {
  workspaceKey: "server-1:workspace-host",
  serverId: "server-1",
  workspaceId: "workspace-host",
  projectViewKey: "project-host",
  projectName: "Host project",
  projectRootPath: "/host",
  workspaceDirectory: "/host",
  projectKind: "git",
  workspaceKind: "local_checkout",
  name: "main",
} as const;
const targetWorkspace = {
  workspaceKey: "server-1:workspace-target",
  serverId: "server-1",
  workspaceId: "workspace-target",
  projectViewKey: "project-target",
  projectName: "Target project",
  projectRootPath: "/target",
  workspaceDirectory: "/target",
  projectKind: "git",
  workspaceKind: "local_checkout",
  name: "main",
} as const;
const projects: SidebarProjectEntry[] = [
  {
    viewKey: "project-host",
    projectName: "Host project",
    projectKind: "git",
    iconWorkingDir: "/host",
    hosts: [
      {
        serverId: "server-1",
        projectId: "project-host",
        iconWorkingDir: "/host",
        worktreeSupport: "supported",
      },
    ],
    workspaces: [hostWorkspace],
  },
  {
    viewKey: "project-target",
    projectName: "Target project",
    projectKind: "git",
    iconWorkingDir: "/target",
    hosts: [
      {
        serverId: "server-1",
        projectId: "project-target",
        iconWorkingDir: "/target",
        worktreeSupport: "supported",
      },
    ],
    workspaces: [targetWorkspace],
  },
];
const hostLayout: WorkspaceLayout = {
  focusedPaneId: "main",
  root: {
    kind: "pane",
    pane: {
      id: "main",
      tabIds: ["agent_existing", "tab-draft-new"],
      focusedTabId: "tab-draft-new",
      tabs: [
        {
          tabId: "agent_existing",
          target: { kind: "agent", agentId: "existing" },
          createdAt: 1,
        },
        {
          tabId: "tab-draft-new",
          target: {
            kind: "draft",
            draftId: "draft-new",
            workspaceId: "workspace-target",
          },
          createdAt: 2,
        },
      ],
    } as SplitPane,
  },
};

function workspaceEntries(overrides: Partial<WorkspaceDescriptor> = {}, hasHydratedAgents = true) {
  const descriptor: WorkspaceDescriptor = {
    id: targetWorkspace.workspaceId,
    projectId: "project-target",
    projectDisplayName: "Target project",
    projectRootPath: "/target",
    workspaceDirectory: "/target",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    title: null,
    status: "done",
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
    ...overrides,
  };
  return buildSidebarWorkspaceEntries({
    placements: [targetWorkspace],
    sessions: [
      {
        serverId: targetWorkspace.serverId,
        workspaces: new Map([[descriptor.id, descriptor]]),
        workspaceAgentActivity: new Map(),
        agents: new Map<string, Agent>(),
        hasHydratedAgents,
      },
    ],
  });
}

describe("sidebar agent drafts", () => {
  it.each(["local_checkout", "directory"] as const)("groups a %s draft under its owning project", (workspaceKind) => {
    const grouped = groupSidebarAgentDrafts({
      projects,
      workspaceLayouts: { "server-1:project:project-target": hostLayout },
      workspaceEntriesByKey: workspaceEntries({ workspaceKind }),
      activeRouteSelection: {
        serverId: targetWorkspace.serverId,
        workspaceId: targetWorkspace.workspaceId,
      },
    });

    expect(grouped.get("project-host")).toBeUndefined();
    expect(grouped.get("project-target")).toEqual([
      {
        serverId: "server-1",
        workspaceId: "workspace-target",
        tabHostWorkspaceId: "workspace-target",
        draftId: "draft-new",
        tabId: "tab-draft-new",
        selected: true,
      },
    ]);
  });

  it("groups project-scoped drafts by their owner checkout, not the selected checkout", () => {
    const otherCheckout = {
      ...targetWorkspace,
      workspaceKey: "server-1:workspace-other",
      workspaceId: "workspace-other",
    };
    const grouped = groupSidebarAgentDrafts({
      projects: [projects[0]!, { ...projects[1]!, workspaces: [targetWorkspace, otherCheckout] }],
      workspaceLayouts: { "server-1:project:project-target": hostLayout },
      workspaceEntriesByKey: workspaceEntries(),
      activeRouteSelection: { serverId: "server-1", workspaceId: otherCheckout.workspaceId },
    });

    expect(grouped.get("project-host")).toBeUndefined();
    expect(grouped.get("project-target")).toEqual([
      {
        serverId: "server-1",
        workspaceId: "workspace-target",
        tabHostWorkspaceId: "workspace-other",
        draftId: "draft-new",
        tabId: "tab-draft-new",
        selected: true,
      },
    ]);
  });

  it("does not advertise a draft tab under a different project's layout", () => {
    const grouped = groupSidebarAgentDrafts({
      projects,
      workspaceLayouts: { "server-1:project:project-host": hostLayout },
      workspaceEntriesByKey: new Map(),
      activeRouteSelection: {
        serverId: hostWorkspace.serverId,
        workspaceId: hostWorkspace.workspaceId,
      },
    });
    expect(grouped.get("project-target")).toBeUndefined();
    expect(grouped.get("project-host")).toBeUndefined();
  });

  it("keeps a titled workspace on its own row instead of a new-conversation stand-in", () => {
    const grouped = groupSidebarAgentDrafts({
      projects,
      workspaceLayouts: { "server-1:project:project-target": hostLayout },
      workspaceEntriesByKey: workspaceEntries({ title: "YBA 动态 MCP 控制台" }),
      activeRouteSelection: {
        serverId: targetWorkspace.serverId,
        workspaceId: targetWorkspace.workspaceId,
      },
    });

    expect(grouped.get("project-target")).toBeUndefined();
  });

  it("keeps an existing conversation on its workspace row when another draft is open", () => {
    const entries = workspaceEntries();
    entries.set(targetWorkspace.workspaceKey, {
      ...entries.get(targetWorkspace.workspaceKey)!,
      hasAssociatedAgents: true,
    });
    const grouped = groupSidebarAgentDrafts({
      projects,
      workspaceLayouts: { "server-1:project:project-target": hostLayout },
      workspaceEntriesByKey: entries,
      activeRouteSelection: { serverId: "server-1", workspaceId: targetWorkspace.workspaceId },
    });

    expect(grouped.get("project-target")).toBeUndefined();
  });

  it.each([
    { name: "archived history", overrides: { hasOnlyArchivedAgents: true }, hydrated: true },
    { name: "worktree", overrides: { workspaceKind: "worktree" as const }, hydrated: true },
    { name: "worktree metadata", overrides: { worktreeSlug: "keep" }, hydrated: true },
  ])("keeps a $name on its workspace row", ({ overrides, hydrated }) => {
    const grouped = groupSidebarAgentDrafts({
      projects,
      workspaceLayouts: { "server-1:project:project-target": hostLayout },
      workspaceEntriesByKey: workspaceEntries(overrides, hydrated),
      activeRouteSelection: { serverId: "server-1", workspaceId: targetWorkspace.workspaceId },
    });
    expect(grouped.get("project-target")).toBeUndefined();
  });

  it.each([
    { name: "unhydrated checkout", overrides: {}, hydrated: false },
    { name: "running workspace", overrides: { status: "running" as const }, hydrated: true },
    {
      name: "configured scripts",
      overrides: {
        scripts: [
          {
            scriptName: "dev",
            type: "script" as const,
            hostname: "dev.paseo.localhost",
            port: null,
            proxyUrl: null,
            lifecycle: "stopped" as const,
            health: null,
            exitCode: null,
            terminalId: null,
          },
        ],
      },
      hydrated: true,
    },
  ])(
    "keeps a new draft visible for a $name without treating it as recyclable",
    ({ overrides, hydrated }) => {
      const entries = workspaceEntries(overrides, hydrated);
      expect(entries.get(targetWorkspace.workspaceKey)?.isUnstarted).toBe(false);

      const grouped = groupSidebarAgentDrafts({
        projects,
        workspaceLayouts: { "server-1:project:project-target": hostLayout },
        workspaceEntriesByKey: entries,
        activeRouteSelection: { serverId: "server-1", workspaceId: targetWorkspace.workspaceId },
      });

      expect(grouped.get("project-target")).toEqual([
        {
          serverId: "server-1",
          workspaceId: "workspace-target",
          tabHostWorkspaceId: "workspace-target",
          draftId: "draft-new",
          tabId: "tab-draft-new",
          selected: true,
        },
      ]);
    },
  );
});
