import { describe, expect, test } from "vitest";
import { ProviderSubagentStore } from "./store.js";

describe("ProviderSubagentStore", () => {
  test("keeps provider children and their timelines scoped to the parent agent", () => {
    const subagents = new ProviderSubagentStore();

    subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      title: "Explore",
      model: "openai-codex/gpt-5.5",
      cwd: "/workspace/child",
      status: "running",
      timestamp: "2026-07-12T10:00:00.000Z",
    });
    subagents.apply("parent-a", "codex", {
      type: "timeline",
      id: "child-1",
      item: { type: "assistant_message", text: "Found it." },
      timestamp: "2026-07-12T10:00:01.000Z",
    });
    subagents.apply("parent-a", "codex", {
      type: "upsert",
      id: "child-1",
      status: "completed",
      timestamp: "2026-07-12T10:00:02.000Z",
    });
    subagents.apply("parent-b", "claude", {
      type: "upsert",
      id: "child-1",
      title: "Review",
      status: "running",
      timestamp: "2026-07-12T10:00:03.000Z",
    });

    expect(subagents.list("parent-a")).toEqual([
      expect.objectContaining({
        id: "child-1",
        parentAgentId: "parent-a",
        provider: "codex",
        title: "Explore",
        model: "openai-codex/gpt-5.5",
        cwd: "/workspace/child",
        status: "completed",
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:02.000Z",
      }),
    ]);
    expect(subagents.fetchTimeline("parent-a", "child-1").rows).toEqual([
      {
        seq: 1,
        timestamp: "2026-07-12T10:00:01.000Z",
        item: { type: "assistant_message", text: "Found it." },
      },
    ]);
    expect(subagents.list("parent-b")[0]).toMatchObject({ provider: "claude", title: "Review" });
    expect(subagents.deleteParent("parent-a")).toEqual([
      { type: "remove", parentAgentId: "parent-a", subagentId: "child-1" },
    ]);
    expect(subagents.list("parent-a")).toEqual([]);
    expect(subagents.list("parent-b")).toHaveLength(1);
  });

  test("limits oversized provider child tool output before storage", () => {
    const subagents = new ProviderSubagentStore();
    const output = "x".repeat(70 * 1024);
    const update = subagents.apply("parent-a", "opencode", {
      type: "timeline",
      id: "child-1",
      item: {
        type: "tool_call",
        callId: "call-1",
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "print", output },
      },
    });

    expect(update.type).toBe("timeline");
    const [row] = subagents.fetchTimeline("parent-a", "child-1").rows;
    expect(row?.item).toMatchObject({
      type: "tool_call",
      detail: { type: "shell", output: "x".repeat(64 * 1024) },
    });
  });

  test("pages provider history on projected item boundaries", () => {
    const subagents = new ProviderSubagentStore();
    for (let index = 0; index < 101; index += 1) {
      subagents.apply("parent-a", "opencode", {
        type: "timeline",
        id: "child-1",
        item: { type: "assistant_message", text: String(index) },
      });
    }

    const page = subagents.fetchTimeline("parent-a", "child-1", {
      direction: "tail",
      limit: 1,
    });
    expect(page.rows).toHaveLength(101);
    expect(page.rows[0]?.seq).toBe(1);
    expect(page.rows.at(-1)?.seq).toBe(101);
    expect(page.hasOlder).toBe(false);
  });
});

test("materializes interleaved child tools and resets after cursors for revised results", () => {
  const subagents = new ProviderSubagentStore();
  subagents.apply("parent", "omp", { type: "upsert", id: "child", status: "running" });
  for (let revision = 1; revision <= 256; revision += 1) {
    subagents.apply("parent", "omp", {
      type: "timeline",
      id: "child",
      item: {
        type: "tool_call",
        callId: "write-1",
        name: "write",
        status: "running",
        error: null,
        detail: { type: "unknown", input: "x".repeat(revision * 512), output: null },
        metadata: { streamingArgs: "x".repeat(revision * 512) },
      },
    });
  }
  const before = subagents.fetchTimeline("parent", "child", { limit: 0 });
  subagents.apply("parent", "omp", {
    type: "timeline",
    id: "child",
    item: { type: "assistant_message", text: "Saved" },
  });
  subagents.apply("parent", "omp", {
    type: "timeline",
    id: "child",
    item: {
      type: "tool_call",
      callId: "write-1",
      name: "write",
      status: "completed",
      error: null,
      detail: { type: "write", filePath: "/work/result.ts", content: "final source" },
    },
  });
  const after = subagents.fetchTimeline("parent", "child", {
    direction: "after",
    cursor: { epoch: before.epoch, seq: before.window.maxSeq },
    limit: 0,
  });
  expect(after.reset).toBe(true);
  expect(after.rows.map((row) => row.seq)).toEqual([1, 2]);
  expect(after.window.nextSeq).toBe(3);
  expect(after.rows[0]?.item).toMatchObject({
    status: "completed",
    revision: 257,
    detail: { type: "write", filePath: "/work/result.ts", content: "final source" },
  });
  const finalItem = after.rows[0]?.item;
  if (finalItem?.type !== "tool_call") throw new Error("Expected the completed child tool");
  expect(finalItem.metadata?.streamingArgs).toBeUndefined();
  subagents.apply("parent", "omp", { type: "upsert", id: "child", status: "completed" });
  expect(subagents.fetchTimeline("parent", "child", { limit: 0 }).rows[0]?.item).toMatchObject({
    status: "completed",
    detail: { content: "final source" },
  });
});
