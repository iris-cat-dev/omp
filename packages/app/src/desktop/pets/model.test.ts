import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@omp-desktop/protocol/agent-labels";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { deriveDesktopPetTasks } from "./model";

function agent(id: string, overrides: Partial<AggregatedAgent> = {}): AggregatedAgent {
  return {
    id,
    serverId: "local",
    serverLabel: "Local",
    provider: "omp",
    title: id,
    status: "idle",
    lastActivityAt: new Date(1000),
    createdAt: new Date(0),
    cwd: "/repo",
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    pendingPermissionCount: 0,
    ...overrides,
  };
}

function workspace(id: string, title: string | null): WorkspaceDescriptor {
  return {
    id,
    title,
    name: "main",
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "checkout",
    status: "running",
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
  };
}
const connected = new Set(["local"]);

describe("desktop pet task activity", () => {
  it("prioritizes actual permissions, error attention, unread completion and running work", () => {
    const tasks = deriveDesktopPetTasks(
      [
        agent("running", { status: "running", lastActivityAt: new Date(9000) }),
        agent("ready", { status: "running", requiresAttention: true, attentionReason: "finished" }),
        agent("blocked", { status: "running", requiresAttention: true, attentionReason: "error" }),
        agent("permission", {
          status: "running",
          requiresAttention: true,
          attentionReason: "error",
          pendingPermissionCount: 1,
        }),
      ],
      connected,
      "Untitled",
    );
    expect(tasks.map(({ agentId, status }) => [agentId, status])).toEqual([
      ["permission", "needs_input"],
      ["blocked", "blocked"],
      ["ready", "ready"],
      ["running", "running"],
    ]);
  });

  it("clears acknowledged completion and errors, retaining only genuinely running work", () => {
    for (const attentionReason of ["finished", "error", "permission"] as const) {
      const unattended = agent("task", { requiresAttention: true, attentionReason });
      expect(deriveDesktopPetTasks([unattended], connected, "Untitled")).toHaveLength(1);
      expect(
        deriveDesktopPetTasks([{ ...unattended, requiresAttention: false }], connected, "Untitled"),
      ).toEqual([]);
      expect(
        deriveDesktopPetTasks(
          [{ ...unattended, requiresAttention: false, status: "running" }],
          connected,
          "Untitled",
        )[0]?.status,
      ).toBe("running");
    }
  });

  it("retains pending permissions even when attention was acknowledged", () => {
    expect(
      deriveDesktopPetTasks(
        [
          agent("approval", {
            pendingPermissionCount: 1,
            requiresAttention: false,
            attentionReason: null,
          }),
        ],
        connected,
        "Untitled",
      )[0]?.status,
    ).toBe("needs_input");
  });

  it("ignores archived, disconnected and dormant records without inventing completion", () => {
    const agents = [
      agent("archived", { status: "running", archivedAt: new Date(2000) }),
      agent("offline", {
        serverId: "remote",
        requiresAttention: true,
        attentionReason: "permission",
      }),
      agent("dormant"),
      agent("old-error", { status: "error", attentionReason: "error", requiresAttention: false }),
    ];
    expect(deriveDesktopPetTasks(agents, connected, "Untitled")).toEqual([]);
    expect(
      deriveDesktopPetTasks([agent("active", { status: "running" })], new Set(), "Untitled"),
    ).toEqual([]);
  });

  it("preserves host-scoped identities and uses attention recency plus localized untitled text", () => {
    const tasks = deriveDesktopPetTasks(
      [
        agent("same", { title: " ", status: "running" }),
        agent("same", {
          serverId: "remote",
          status: "running",
          attentionTimestamp: new Date(2000),
        }),
      ],
      new Set(["local", "remote"]),
      "未命名任务",
    );
    expect(
      tasks.map(({ serverId, agentId, title, updatedAt }) => ({
        serverId,
        agentId,
        title,
        updatedAt,
      })),
    ).toEqual([
      { serverId: "remote", agentId: "same", title: "same", updatedAt: 2000 },
      { serverId: "local", agentId: "same", title: "未命名任务", updatedAt: 1000 },
    ]);
  });
  it("keeps independent main conversations in a shared workspace without child attention", () => {
    const root = {
      ...agent("root", { status: "running", workspaceId: "shared" }),
      pendingPermissions: [],
    };
    const otherMain = agent("other-main", {
      workspaceId: "shared",
      requiresAttention: true,
      attentionReason: "finished",
    });
    const child = {
      ...agent("child", {
        workspaceId: "separate-child-workspace",
        labels: { [PARENT_AGENT_ID_LABEL]: "root" },
        pendingPermissionCount: undefined,
      }),
      pendingPermissions: [{}],
    };
    const grandchild = agent("grandchild", {
      workspaceId: "shared",
      labels: { [PARENT_AGENT_ID_LABEL]: "child" },
      requiresAttention: true,
      attentionReason: "error",
    });
    const directory = new Map(
      [root, otherMain, child, grandchild].map((entry) => [entry.id, entry]),
    );
    const tasks = deriveDesktopPetTasks(
      directory.values(),
      new Set(["remote"]),
      "Untitled",
      "remote",
    );
    expect(tasks.map(({ serverId, agentId, status }) => [serverId, agentId, status])).toEqual([
      ["remote", "other-main", "ready"],
      ["remote", "root", "running"],
    ]);
  });

  it("remains idle when only an orphaned subagent is running", () => {
    const child = agent("orphan", {
      status: "running",
      labels: { [PARENT_AGENT_ID_LABEL]: "missing-parent" },
    });
    expect(deriveDesktopPetTasks([child], connected, "Untitled")).toEqual([]);
  });

  it("shows a conversation again when its parent relationship is removed", () => {
    const child = agent("promoted", {
      status: "running",
      labels: { [PARENT_AGENT_ID_LABEL]: "old-parent" },
    });
    expect(deriveDesktopPetTasks([child], connected, "Untitled")).toEqual([]);
    const tasks = deriveDesktopPetTasks([{ ...child, labels: {} }], connected, "Untitled");
    expect(tasks.map(({ agentId, status }) => [agentId, status])).toEqual([
      ["promoted", "running"],
    ]);
  });

  it("uses the renamed workspace only for its primary conversation and keeps independent names", () => {
    const root = agent("root", {
      workspaceId: "workspace-1",
      title: "Original first request",
      requiresAttention: true,
      attentionReason: "finished",
    });
    const other = agent("other", {
      workspaceId: "workspace-1",
      title: "Old independent name",
      status: "running",
      createdAt: new Date(1000),
    });
    const child = agent("child", {
      workspaceId: "workspace-1",
      createdAt: new Date(-1000),
      labels: { [PARENT_AGENT_ID_LABEL]: "root" },
      pendingPermissionCount: 1,
    });
    const presentation = {
      agents: new Map([
        ["root", { ...root, parentAgentId: null }],
        ["other", { ...other, parentAgentId: null, title: "独立会话新名称" }],
        ["child", { ...child, parentAgentId: "root" }],
      ]),
      agentDetails: new Map(),
      workspaces: new Map([["cached-workspace-key", workspace("workspace-1", "壁纸与宠物开发")]]),
    };
    const tasks = deriveDesktopPetTasks(
      [root, other, child],
      connected,
      "Untitled",
      "local",
      presentation,
    );
    expect(tasks.map(({ agentId, title }) => [agentId, title])).toEqual([
      ["root", "壁纸与宠物开发"],
      ["other", "独立会话新名称"],
    ]);
    presentation.workspaces = new Map([["cached-workspace-key", workspace("workspace-1", null)]]);
    expect(
      deriveDesktopPetTasks([root, other, child], connected, "Untitled", "local", presentation)[0]
        ?.title,
    ).toBe("main");
  });

  it("refreshes a renamed conversation without replacing committed attention with live session state", () => {
    const committed = agent("task", {
      title: "Original first request",
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: new Date(2000),
    });
    const live = {
      ...committed,
      parentAgentId: null,
      title: "First custom name",
      requiresAttention: false,
      status: "idle" as const,
    };
    const presentation = {
      agents: new Map([["task", live]]),
      agentDetails: new Map(),
      workspaces: new Map<string, WorkspaceDescriptor>(),
    };
    const derive = () =>
      deriveDesktopPetTasks([committed], connected, "Untitled", "local", presentation);
    expect(derive()).toEqual([
      {
        serverId: "local",
        agentId: "task",
        title: "First custom name",
        status: "ready",
        updatedAt: 2000,
      },
    ]);
    presentation.agents = new Map([["task", { ...live, title: "Renamed while waiting" }]]);
    expect(derive()).toEqual([
      {
        serverId: "local",
        agentId: "task",
        title: "Renamed while waiting",
        status: "ready",
        updatedAt: 2000,
      },
    ]);
  });
});
