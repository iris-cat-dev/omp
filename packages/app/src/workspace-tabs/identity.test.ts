import { describe, expect, it, test } from "vitest";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "./identity";

describe("New tab identity", () => {
  it("stays outside deterministic target identity", () => {
    const target = { kind: "new_tab" } as const;

    expect(normalizeWorkspaceTabTarget(target)).toEqual(target);
    expect(workspaceTabTargetsEqual(target, target)).toBe(false);
    expect(() => buildDeterministicWorkspaceTabId(target)).toThrow(
      "New tabs do not have deterministic target identities",
    );
  });
});

describe("draft tab identity", () => {
  it("preserves and compares the draft execution workspace", () => {
    const target = normalizeWorkspaceTabTarget({
      kind: "draft",
      draftId: " draft-1 ",
      workspaceId: " workspace-target ",
    });

    expect(target).toEqual({
      kind: "draft",
      draftId: "draft-1",
      workspaceId: "workspace-target",
    });
    expect(
      target &&
        workspaceTabTargetsEqual(target, {
          kind: "draft",
          draftId: "draft-1",
          workspaceId: "workspace-target",
        }),
    ).toBe(true);
    expect(
      target &&
        workspaceTabTargetsEqual(target, {
          kind: "draft",
          draftId: "draft-1",
          workspaceId: "workspace-other",
        }),
    ).toBe(false);
  });
});

describe("checkout-bound resource identity", () => {
  it("preserves ownership through normalization and differentiates equal paths", () => {
    const first = normalizeWorkspaceTabTarget({
      kind: "file",
      path: "src/index.ts",
      workspaceId: " checkout-a ",
    });
    const second = normalizeWorkspaceTabTarget({
      kind: "file",
      path: "src/index.ts",
      workspaceId: "checkout-b",
    });
    expect(first?.workspaceId).toBe("checkout-a");
    expect(first && second && workspaceTabTargetsEqual(first, second)).toBe(false);
    expect(first && second && buildDeterministicWorkspaceTabId(first)).not.toBe(
      second && buildDeterministicWorkspaceTabId(second),
    );
  });

  it("keeps terminal and agent ownership immutable in target comparisons", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "terminal", terminalId: "t", workspaceId: "a" },
        { kind: "terminal", terminalId: "t", workspaceId: "b" },
      ),
    ).toBe(false);
    expect(
      normalizeWorkspaceTabTarget({
        kind: "agent",
        agentId: "a",
        workspaceId: " checkout ",
      }),
    ).toEqual({ kind: "agent", agentId: "a", workspaceId: "checkout" });
  });
});

describe("prompt analysis tab identity", () => {
  it("restores its conversation owner and keeps analysis separate from the chat", () => {
    const target = normalizeWorkspaceTabTarget({
      kind: "prompt_analysis",
      agentId: " conversation-a ",
      workspaceId: " checkout-a ",
    });
    expect(target).toEqual({
      kind: "prompt_analysis",
      agentId: "conversation-a",
      workspaceId: "checkout-a",
    });
    const analysis = {
      kind: "prompt_analysis",
      agentId: "conversation-a",
      workspaceId: "checkout-a",
    } as const;
    expect(workspaceTabTargetsEqual(analysis, analysis)).toBe(true);
    expect(workspaceTabTargetsEqual(analysis, { ...analysis, agentId: "conversation-b" })).toBe(
      false,
    );
    expect(workspaceTabTargetsEqual(analysis, { ...analysis, workspaceId: "checkout-b" })).toBe(
      false,
    );
    expect(buildDeterministicWorkspaceTabId(analysis)).not.toBe(
      buildDeterministicWorkspaceTabId({ kind: "agent", agentId: analysis.agentId }),
    );
    expect(normalizeWorkspaceTabTarget({ kind: "prompt_analysis", agentId: " " })).toBeNull();
  });
});

describe("provider subagent tab identity", () => {
  test("normalizes and compares the parent and provider child as one tab identity", () => {
    const target = normalizeWorkspaceTabTarget({
      kind: "provider_subagent",
      parentAgentId: " parent-a ",
      subagentId: " child-a ",
    });

    expect(target).toEqual({
      kind: "provider_subagent",
      parentAgentId: "parent-a",
      subagentId: "child-a",
    });
    expect(
      target &&
        workspaceTabTargetsEqual(target, {
          kind: "provider_subagent",
          parentAgentId: "parent-a",
          subagentId: "child-a",
        }),
    ).toBe(true);
  });

  test("does not collide when parent and child ids contain separators", () => {
    const first = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a_b",
      subagentId: "c",
    });
    const second = buildDeterministicWorkspaceTabId({
      kind: "provider_subagent",
      parentAgentId: "a",
      subagentId: "b_c",
    });

    expect(first).not.toBe(second);
  });
});

describe("working diff tab identity", () => {
  const target = {
    kind: "working_diff" as const,
    focusPath: "src/example.ts",
    focusRequestId: 1,
  };

  it("normalizes file focus navigation", () => {
    expect(
      normalizeWorkspaceTabTarget({
        ...target,
        focusPath: " src\\example.ts ",
      }),
    ).toEqual(target);
  });

  it("treats focus as navigation state rather than tab identity", () => {
    expect(workspaceTabTargetsEqual(target, target)).toBe(true);
    expect(workspaceTabTargetsEqual(target, { ...target, focusPath: "src/other.ts" })).toBe(false);
    expect(workspaceTabTargetsEqual(target, { ...target, focusRequestId: 2 })).toBe(false);
    const workingDiffId = buildDeterministicWorkspaceTabId(target);
    const otherFocusId = buildDeterministicWorkspaceTabId({
      ...target,
      focusPath: "src/other.ts",
    });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: target.focusPath,
    });

    expect(workingDiffId).toBe("working_diff_document");
    expect(workingDiffId).toBe(otherFocusId);
    expect(workingDiffId).not.toBe(buildDeterministicWorkspaceTabId({ kind: "working_diff" }));
    expect(workingDiffId).not.toBe(fileId);
  });
});

describe("workspace utility panel identity", () => {
  it.each(["files", "pull_request"] as const)(
    "normalizes and deterministically keys %s",
    (kind) => {
      const target = { kind };

      expect(normalizeWorkspaceTabTarget(target)).toEqual(target);
      expect(buildDeterministicWorkspaceTabId(target)).toBe(kind);
      expect(workspaceTabTargetsEqual(target, target)).toBe(true);
    },
  );
});

describe("commit diff tab identity", () => {
  it("keys a commit diff tab by its sha", () => {
    expect(buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" })).toBe(
      "commit_diff_abc123",
    );
  });

  it("does not collide a commit diff tab id with a file tab id", () => {
    const diffId = buildDeterministicWorkspaceTabId({ kind: "commit_diff", sha: "abc123" });
    const fileId = buildDeterministicWorkspaceTabId({
      kind: "file",
      path: "abc123",
    });
    expect(diffId).not.toBe(fileId);
  });

  it("treats two commit diff targets with the same sha as equal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "abc123" },
      ),
    ).toBe(true);
  });

  it("treats commit diff targets with different shas as unequal", () => {
    expect(
      workspaceTabTargetsEqual(
        { kind: "commit_diff", sha: "abc123" },
        { kind: "commit_diff", sha: "def456" },
      ),
    ).toBe(false);
  });

  it("normalizes a commit diff target", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "abc123",
      }),
    ).toEqual({ kind: "commit_diff", sha: "abc123" });
  });

  it("rejects a commit diff target with a blank sha", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "commit_diff",
        sha: "   ",
      }),
    ).toBeNull();
  });
});

describe("plugin panel tab identity", () => {
  it("normalizes exact workspace and agent context", () => {
    expect(
      normalizeWorkspaceTabTarget({
        kind: "plugin",
        pluginId: " review ",
        panelId: " details ",
        context: "agent",
        agentId: " agent-1 ",
      }),
    ).toEqual({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "agent",
      agentId: "agent-1",
    });
  });

  it("gives workspace and agent instances distinct stable ids", () => {
    const workspace = buildDeterministicWorkspaceTabId({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "workspace",
    });
    const agent = buildDeterministicWorkspaceTabId({
      kind: "plugin",
      pluginId: "review",
      panelId: "details",
      context: "agent",
      agentId: "agent-1",
    });

    expect(workspace).toBe("plugin_workspace_6_review_7_details");
    expect(agent).toBe("plugin_agent_6_review_7_details_7_agent-1");
  });
});
