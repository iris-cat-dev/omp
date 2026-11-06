import { describe, expect, it } from "vitest";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type { ToolCallTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { projectTimelineRows, selectProjectedTimelinePage } from "./timeline-projection.js";

describe("InMemoryAgentTimelineStore", () => {
  it("clamps an overshooting before cursor into the bounded tail window", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toEqual({
      epoch: "epoch-1",
      contentVersion: 3,
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });

  it("returns a bounded reset window when an after cursor is behind retained history", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toEqual({
      epoch: "epoch-1",
      contentVersion: 0,
      direction: "after",
      reset: true,
      staleCursor: false,
      gap: true,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: true,
      hasMoreRevisions: true,
      rows: [
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });

  it("materializes large tool snapshots at a stable sequence without losing terminal state", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent", { epoch: "epoch" });
    const running: ToolCallTimelineItem = {
      type: "tool_call",
      callId: "task",
      name: "task",
      status: "running",
      error: null,
      detail: { type: "sub_agent", log: "" },
      metadata: { streamingArgs: "{", intent: "Investigate", streamUpdate: true },
    };
    const first = store.upsertToolCall("agent", running, { turnId: "turn-1" });
    store.append("agent", { type: "assistant_message", text: "While the task runs" });
    for (let revision = 2; revision <= 256; revision += 1) {
      const row = store.upsertToolCall(
        "agent",
        {
          ...running,
          detail: { type: "sub_agent", log: `${revision}:${"large log ".repeat(1024)}` },
          metadata: { streamingArgs: `${revision}:${"argument".repeat(1024)}` },
        },
        { turnId: "turn-1" },
      );
      expect(row.seq).toBe(first.seq);
      expect(row.item).toHaveProperty("revision", revision);
    }
    const final = store.upsertToolCall(
      "agent",
      {
        ...running,
        status: "failed",
        error: { message: "Actual failure" },
        detail: { type: "sub_agent", log: "Final task result" },
        metadata: { finalResult: true },
      },
      { turnId: "turn-1", providerMessageId: "provider-result" },
    );
    expect(first.item).toHaveProperty("revision", 1);
    expect(final.item).toMatchObject({
      revision: 257,
      status: "failed",
      error: { message: "Actual failure" },
      detail: { type: "sub_agent", log: "Final task result" },
      metadata: { intent: "Investigate", streamUpdate: true, finalResult: true },
    });
    expect(final.item).not.toHaveProperty("metadata.streamingArgs");
    const late = store.upsertToolCall("agent", running, { turnId: "turn-1" });
    expect(late.item).toMatchObject({ status: "failed", error: { message: "Actual failure" } });
    expect(late.item).not.toHaveProperty("metadata.streamingArgs");
    const reused = store.upsertToolCall("agent", running, { turnId: "turn-2" });
    expect(reused.seq).toBe(3);
    expect(reused.item).toHaveProperty("revision", 1);
    const rows = store.getRows("agent");
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[0].providerMessageId).toBe("provider-result");
    expect(rows[1].item).toEqual({ type: "assistant_message", text: "While the task runs" });
    const after = store.fetch("agent", {
      direction: "after",
      cursor: { epoch: "epoch", seq: 1 },
      limit: 0,
    });
    expect(after.reset).toBe(true);
    expect(after.staleCursor).toBe(false);
    expect(after.gap).toBe(false);
    expect(after.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(after.rows[0].item).toEqual(late.item);
    expect(
      new Set(rows.filter((row) => row.item.type === "tool_call").map((row) => row.item)).size,
    ).toBe(2);
  });

  it("shares only current tool payloads across historical sequences and projected pages", () => {
    const legacy: AgentTimelineRow[] = [];
    for (let seq = 1; seq <= 128; seq += 1) {
      legacy.push({
        seq,
        timestamp: "2026-01-01T00:00:00.000Z",
        turnId: "turn",
        item:
          seq === 2
            ? { type: "assistant_message", text: "Interleaved text" }
            : {
                type: "tool_call",
                callId: "legacy-task",
                name: "task",
                status: seq === 128 ? "completed" : "running",
                error: null,
                detail: {
                  type: "sub_agent",
                  log: seq === 128 ? "Final answer" : `${seq}:${"log".repeat(4096)}`,
                },
                metadata:
                  seq === 128
                    ? { result: "saved" }
                    : { streamingArgs: `${seq}:${"args".repeat(4096)}` },
              },
      });
    }
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent", { epoch: "epoch", rows: legacy, nextSeq: 129 });
    const rows = store.getRows("agent");
    expect(rows.map((row) => row.seq)).toEqual(legacy.map((row) => row.seq));
    const tools = rows.filter((row) => row.item.type === "tool_call");
    expect(new Set(tools.map((row) => row.item)).size).toBe(1);
    expect(tools[0].item).toMatchObject({
      status: "completed",
      detail: { log: "Final answer" },
      metadata: { result: "saved" },
    });
    expect(tools[0].item).not.toHaveProperty("metadata.streamingArgs");
    const before = store.fetch("agent", {
      direction: "before",
      cursor: { epoch: "epoch", seq: 4 },
      limit: 2,
    });
    expect(before.rows.map((row) => row.seq)).toEqual([2, 3]);
    expect(before.gap).toBe(false);
    const projected = projectTimelineRows({ rows, mode: "projected" });
    expect(projected.map((entry) => entry.item)).toEqual([tools[0].item, rows[1].item]);
    expect(projected[0].sourceSeqRanges).toEqual([
      { startSeq: 1, endSeq: 1 },
      { startSeq: 3, endSeq: 128 },
    ]);
    expect(selectProjectedTimelinePage({ rows, direction: "tail", limit: 0 }).entries).toEqual(
      projected,
    );
    const firstPage = selectProjectedTimelinePage({
      rows,
      direction: "after",
      cursorSeq: 0,
      limit: 1,
    });
    expect(firstPage.entries[0].item).toEqual(tools[0].item);
    expect(firstPage.entries[0].item).toMatchObject({
      status: "completed",
      detail: { log: "Final answer" },
    });
    const updated = store.upsertToolCall(
      "agent",
      {
        ...(tools[0].item as ToolCallTimelineItem),
        detail: { type: "sub_agent", log: "Recovered final answer" },
      },
      { turnId: "turn" },
    );
    expect(updated.seq).toBe(128);
    expect(
      new Set(
        store
          .getRows("agent")
          .filter((row) => row.item.type === "tool_call")
          .map((row) => row.item),
      ).size,
    ).toBe(1);
    const restored = new InMemoryAgentTimelineStore();
    restored.initialize("agent", { rows: store.getRows("agent"), nextSeq: 129 });
    expect(restored.getRows("agent").map((row) => row.item)).toEqual(store.getItems("agent"));
    expect(restored.fetch("agent", { limit: 0 }).window).toEqual({
      minSeq: 1,
      maxSeq: 128,
      nextSeq: 129,
    });
  });

  it("projects reused call IDs independently in every turn", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent");
    const tool: ToolCallTimelineItem = {
      type: "tool_call",
      callId: "reused",
      name: "shell",
      status: "running",
      error: null,
      detail: { type: "shell", command: "echo saved" },
    };
    for (const turnId of ["first", "second"]) {
      store.append("agent", tool, { turnId });
      store.append(
        "agent",
        {
          ...tool,
          status: "completed",
          detail: {
            type: "shell",
            command: "echo saved",
            output: turnId,
            exitCode: 0,
          },
        },
        { turnId },
      );
    }
    const projected = projectTimelineRows({ rows: store.getRows("agent"), mode: "projected" });
    expect(projected).toHaveLength(2);
    expect(projected.map((entry) => entry.item)).toEqual([
      expect.objectContaining({
        status: "completed",
        detail: expect.objectContaining({ output: "first" }),
      }),
      expect.objectContaining({
        status: "completed",
        detail: expect.objectContaining({ output: "second" }),
      }),
    ]);
  });

  it("replays a submitted message's readiness revision without changing identity or regressing a bound native ID", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent", { epoch: "epoch-readiness" });
    store.append(
      "agent",
      {
        type: "user_message",
        text: "hello",
        messageId: "client-one",
        clientMessageId: "client-one",
        rewindStatus: "pending",
      },
      { turnId: "turn-one" },
    );
    const initial = store.fetch("agent", { direction: "tail", limit: 0 });
    const cursor = {
      epoch: initial.epoch,
      seq: initial.window.maxSeq,
      contentVersion: initial.contentVersion,
    };
    store.updateSubmittedUserMessage("agent", "client-one", { rewindStatus: "unavailable" });
    store.updateSubmittedUserMessage("agent", "client-one", { rewindStatus: "pending" });
    expect(store.getRows("agent")[0].item).toMatchObject({ rewindStatus: "unavailable" });
    store.updateSubmittedUserMessage("agent", "client-one", {
      rewindStatus: "ready",
      providerMessageId: "native-one",
    });
    store.updateSubmittedUserMessage("agent", "client-one", { rewindStatus: "unavailable" });
    const changed = store.fetch("agent", { direction: "after", cursor, limit: 0 });
    expect(changed.rows).toEqual([]);
    expect(changed.revisedRows).toMatchObject([
      {
        seq: 1,
        providerMessageId: "native-one",
        item: { messageId: "client-one", clientMessageId: "client-one", rewindStatus: "ready" },
      },
    ]);
    const restored = new InMemoryAgentTimelineStore();
    restored.initialize("agent", { epoch: "epoch-readiness", rows: store.getRows("agent") });
    expect(
      restored.fetch("agent", {
        direction: "after",
        cursor: { ...cursor, contentVersion: changed.contentVersion },
      }),
    ).toMatchObject({ rows: [], revisedRows: [] });
  });

  it("acknowledges old-seq revisions independently, including bounded pages and reconnects", () => {
    const store = new InMemoryAgentTimelineStore();
    const running: ToolCallTimelineItem = {
      type: "tool_call",
      callId: "one",
      name: "write",
      status: "running",
      error: null,
      detail: { type: "unknown", input: "initial", output: null },
    };
    store.initialize("agent", { epoch: "epoch-1" });
    store.upsertToolCall("agent", running);
    store.upsertToolCall("agent", { ...running, callId: "two" });
    store.append("agent", { type: "assistant_message", text: "Still streaming" });
    const initial = store.fetch("agent", { direction: "tail", limit: 0 });
    const cursor = {
      epoch: initial.epoch,
      seq: initial.window.maxSeq,
      contentVersion: initial.contentVersion,
    };
    store.upsertToolCall("agent", {
      ...running,
      callId: "two",
      status: "completed",
      detail: { type: "unknown", input: "second result", output: "saved" },
    });
    store.upsertToolCall("agent", {
      ...running,
      status: "completed",
      detail: { type: "unknown", input: "first result", output: "saved" },
    });
    const first = store.fetch("agent", { direction: "after", cursor, limit: 1 });
    expect(first.reset).toBe(false);
    expect(first.rows).toEqual([]);
    expect(first.revisedRows?.map((row) => row.seq)).toEqual([2]);
    expect(first.hasNewer).toBe(true);
    const second = store.fetch("agent", {
      direction: "after",
      cursor: { ...cursor, contentVersion: first.contentVersion },
      limit: 1,
    });
    expect(second.reset).toBe(false);
    expect(second.revisedRows?.map((row) => row.seq)).toEqual([1]);
    expect(second.hasNewer).toBe(false);
    const acknowledged = { ...cursor, contentVersion: second.contentVersion };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const unchanged = store.fetch("agent", {
        direction: "after",
        cursor: acknowledged,
        limit: 1,
      });
      expect(unchanged).toMatchObject({ reset: false, rows: [], revisedRows: [], hasNewer: false });
    }
    const missed = store.fetch("agent", { direction: "after", cursor, limit: 0 });
    expect(missed.revisedRows?.map((row) => row.seq)).toEqual([2, 1]);
    const restored = new InMemoryAgentTimelineStore();
    restored.initialize("agent", { epoch: "epoch-1", rows: store.getRows("agent") });
    expect(restored.fetch("agent", { direction: "after", cursor: acknowledged })).toMatchObject({
      reset: false,
      rows: [],
      revisedRows: [],
    });
    expect(
      store.fetch("agent", { direction: "after", cursor: { epoch: cursor.epoch, seq: cursor.seq } })
        .reset,
    ).toBe(true);
    store.initialize("agent", { epoch: "epoch-2", items: [running] });
    expect(store.fetch("agent", { direction: "after", cursor: acknowledged })).toMatchObject({
      reset: true,
      epoch: "epoch-2",
      window: { minSeq: 1, maxSeq: 1 },
    });
  });

  it("acknowledges an empty epoch at sequence zero", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("empty", { epoch: "empty-epoch" });
    const initial = store.fetch("empty", { direction: "after" });
    expect(initial).toMatchObject({ reset: true, contentVersion: 0, rows: [] });
    expect(
      store.fetch("empty", {
        direction: "after",
        cursor: { epoch: initial.epoch, seq: 0, contentVersion: 0 },
      }),
    ).toMatchObject({ reset: false, rows: [], hasNewer: false });
  });
});
