import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { buildProjectGroupedAgentListItems } from "./agent-list";

function agent(input: {
  id: string;
  projectKey: string;
  projectName: string;
  serverId?: string;
}): AggregatedAgent {
  const serverId = input.serverId ?? "host-a";
  const cwd = `/${serverId}/${input.id}`;
  return {
    id: input.id,
    serverId,
    serverLabel: serverId,
    title: input.id,
    status: "closed",
    lastActivityAt: new Date(0),
    cwd,
    provider: "codex",
    createdAt: new Date(0),
    labels: {},
    projectPlacement: {
      projectKey: input.projectKey,
      projectName: input.projectName,
      workspaceName: null,
      checkout: {
        cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

function itemLabels(agents: AggregatedAgent[]): string[] {
  return buildProjectGroupedAgentListItems(agents).map((item) =>
    item.type === "header" ? `project:${item.label}` : `agent:${item.agent.id}`,
  );
}

describe("project-grouped agent list", () => {
  it("groups equivalent projects across hosts while preserving recency order", () => {
    expect(
      itemLabels([
        agent({ id: "alpha-new", projectKey: "remote:alpha", projectName: "Alpha" }),
        agent({ id: "beta", projectKey: "remote:beta", projectName: "Beta" }),
        agent({
          id: "alpha-old",
          projectKey: "remote:alpha",
          projectName: "Alpha",
          serverId: "host-b",
        }),
      ]),
    ).toEqual([
      "project:Alpha",
      "agent:alpha-new",
      "agent:alpha-old",
      "project:Beta",
      "agent:beta",
    ]);
  });

  it("orders project names naturally without reordering conversations inside each project", () => {
    const items = buildProjectGroupedAgentListItems(
      [
        agent({ id: "newest", projectKey: "ten", projectName: "Project 10" }),
        agent({ id: "middle", projectKey: "two", projectName: "Project 2" }),
        agent({ id: "oldest", projectKey: "ten", projectName: "Project 10" }),
      ],
      new Intl.Collator("en", { numeric: true }),
    );
    expect(items.map((item) => (item.type === "header" ? item.label : item.agent.id))).toEqual([
      "Project 2",
      "middle",
      "Project 10",
      "newest",
      "oldest",
    ]);
  });

  it("keeps distinct projects separate when their display names match", () => {
    expect(
      itemLabels([
        agent({ id: "first", projectKey: "remote:first", projectName: "App" }),
        agent({ id: "second", projectKey: "remote:second", projectName: "App" }),
      ]),
    ).toEqual(["project:App", "agent:first", "project:App", "agent:second"]);
  });
});
