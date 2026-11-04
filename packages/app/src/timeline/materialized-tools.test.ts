import { afterEach, describe, expect, test } from "vitest";
import type { ToolCallTimelineItem } from "@omp-desktop/protocol/agent-types";
import type { AgentStreamEventPayload } from "@omp-desktop/protocol/messages";
import { providerSubagentKey, useProviderSubagentStore } from "@/subagents/provider-store";
import { isAgentToolCallItem, type StreamItem } from "@/types/stream";
import {
  processAgentStreamEvent,
  processTimelineResponse,
  type ProcessTimelineResponseInput,
} from "./session-stream-reducers";

const timestamp = new Date("2026-11-04T00:00:00.000Z");

function tool(
  revision: number,
  input: string,
): Extract<ToolCallTimelineItem, { status: "running" }> {
  return {
    type: "tool_call",
    callId: "write-1",
    name: "write",
    revision,
    status: "running",
    error: null,
    detail: { type: "unknown", input, output: null },
  };
}

function visibleTool(tail: StreamItem[], head: StreamItem[]) {
  return [...tail, ...head].find(isAgentToolCallItem)?.payload.data;
}

afterEach(() => {
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    hiddenFromTrack: new Set(),
    connectionGenerations: new Map(),
    listSync: new Map(),
    timelineSync: new Map(),
    liveRevisions: new Map(),
    runVersions: new Map(),
  });
});

describe("materialized tool revisions", () => {
  test("updates a tool behind the live cursor without replaying stale progress", () => {
    const first = processAgentStreamEvent({
      event: { type: "timeline", provider: "omp", item: tool(1, "partial") },
      seq: 1,
      epoch: "epoch-1",
      timestamp,
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
    });
    const afterText = processAgentStreamEvent({
      event: {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "Done" },
      },
      seq: 2,
      epoch: "epoch-1",
      timestamp,
      currentTail: first.tail,
      currentHead: first.head,
      currentCursor: first.cursor ?? undefined,
    });
    const finished: AgentStreamEventPayload = {
      type: "timeline",
      provider: "omp",
      item: { ...tool(3, "complete source"), status: "completed" },
    };
    const completed = processAgentStreamEvent({
      event: finished,
      seq: 1,
      epoch: "epoch-1",
      timestamp,
      currentTail: afterText.tail,
      currentHead: afterText.head,
      currentCursor: afterText.cursor ?? undefined,
    });
    expect(visibleTool(completed.tail, completed.head)).toMatchObject({
      status: "completed",
      revision: 3,
      detail: { input: "complete source" },
    });
    expect(completed.cursorChanged).toBe(false);
    expect(completed.sideEffects).toEqual([]);
    const stale = processAgentStreamEvent({
      event: { type: "timeline", provider: "omp", item: tool(2, "stale prefix") },
      seq: 1,
      epoch: "epoch-1",
      timestamp,
      currentTail: completed.tail,
      currentHead: completed.head,
      currentCursor: afterText.cursor ?? undefined,
    });
    expect(visibleTool(stale.tail, stale.head)).toMatchObject({
      status: "completed",
      revision: 3,
      detail: { input: "complete source" },
    });
  });

  test("refreshes an unchanged sequence window and does not roll back a newer live revision", () => {
    const first = processAgentStreamEvent({
      event: { type: "timeline", provider: "omp", item: tool(1, "partial") },
      seq: 1,
      epoch: "epoch-1",
      timestamp,
      currentTail: [],
      currentHead: [],
      currentCursor: undefined,
    });
    const input: ProcessTimelineResponseInput = {
      payload: {
        agentId: "parent",
        direction: "tail",
        projection: "projected",
        reset: false,
        epoch: "epoch-1",
        window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
        startCursor: { seq: 1 },
        endCursor: { seq: 1 },
        entries: [
          {
            seqStart: 1,
            seqEnd: 1,
            provider: "omp",
            timestamp: timestamp.toISOString(),
            item: { ...tool(4, "saved result"), status: "completed" },
          },
        ],
        error: null,
        hasOlder: false,
        hasNewer: false,
      },
      currentTail: first.tail,
      currentHead: first.head,
      currentCursor: first.cursor ?? undefined,
      isInitializing: false,
      hasActiveInitDeferred: false,
      initRequestDirection: "tail",
      sendingClientMessageIds: [],
    };
    const refreshed = processTimelineResponse(input);
    expect(visibleTool(refreshed.tail, refreshed.head)).toMatchObject({
      status: "completed",
      revision: 4,
      detail: { input: "saved result" },
    });
    const staleSnapshot = processTimelineResponse({
      ...input,
      currentTail: refreshed.tail,
      currentHead: refreshed.head,
      payload: {
        ...input.payload,
        reset: true,
        entries: [{ ...input.payload.entries[0]!, item: tool(2, "stale snapshot") }],
      },
    });
    expect(visibleTool(staleSnapshot.tail, staleSnapshot.head)).toMatchObject({
      status: "completed",
      revision: 4,
      detail: { input: "saved result" },
    });
    const restarted = processTimelineResponse({
      ...input,
      currentTail: refreshed.tail,
      currentHead: refreshed.head,
      payload: {
        ...input.payload,
        epoch: "epoch-2",
        reset: true,
        entries: [{ ...input.payload.entries[0]!, item: tool(1, "new run") }],
      },
    });
    expect(visibleTool(restarted.tail, restarted.head)).toMatchObject({
      status: "running",
      revision: 1,
      detail: { input: "new run" },
    });
  });

  test("keeps one child row through streamed prefixes, completion, and a stale tail response", () => {
    const store = useProviderSubagentStore.getState();
    const base = {
      kind: "timeline" as const,
      parentAgentId: "parent",
      subagentId: "child",
      provider: "omp",
      epoch: "epoch-1",
      seq: 1,
      timestamp: timestamp.toISOString(),
    };
    for (let revision = 1; revision <= 256; revision += 1) {
      const prefix = "x".repeat(revision * 512);
      store.applyUpdate("server", {
        ...base,
        item: { ...tool(revision, prefix), metadata: { streamingArgs: prefix } },
      });
    }
    store.applyUpdate("server", {
      ...base,
      seq: 2,
      item: { type: "assistant_message", text: "Saved" },
    });
    store.applyUpdate("server", {
      ...base,
      item: { ...tool(257, "complete source"), status: "completed" },
    });
    store.applyUpdate("server", { ...base, item: tool(200, "stale prefix") });
    store.replaceTimeline("server", {
      requestId: "old-tail",
      parentAgentId: "parent",
      subagentId: "child",
      provider: "omp",
      direction: "tail",
      epoch: "epoch-1",
      reset: true,
      staleCursor: false,
      gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      hasOlder: false,
      hasNewer: false,
      rows: [
        { seq: 1, timestamp: base.timestamp, item: tool(1, "old tail") },
        { seq: 2, timestamp: base.timestamp, item: { type: "assistant_message", text: "Saved" } },
      ],
      error: null,
    });
    const state = useProviderSubagentStore
      .getState()
      .timelines.get(providerSubagentKey("server", "parent", "child"))!;
    expect(state.rows.size).toBe(2);
    expect(state.lastSeq).toBe(2);
    expect(state.needsRefresh).toBe(false);
    expect(state.rows.get(1)?.item).toMatchObject({ revision: 257, status: "completed" });
    expect(visibleTool(state.tail, state.head)).toMatchObject({
      revision: 257,
      status: "completed",
      detail: { input: "complete source" },
    });
    expect(visibleTool(state.tail, state.head)?.metadata?.streamingArgs).toBeUndefined();
  });
});

test("keeps unsequenced worktree/tool progress visible without losing the committed revision", () => {
  const first = processAgentStreamEvent({
    event: { type: "timeline", provider: "omp", item: tool(1, "initial") },
    seq: 1,
    epoch: "epoch-1",
    timestamp,
    currentTail: [],
    currentHead: [],
    currentCursor: undefined,
  });
  const progress = processAgentStreamEvent({
    event: {
      type: "timeline",
      provider: "omp",
      item: { ...tool(1, "live worktree progress"), revision: undefined },
    },
    seq: undefined,
    epoch: undefined,
    timestamp,
    currentTail: first.tail,
    currentHead: first.head,
    currentCursor: first.cursor ?? undefined,
  });
  expect(visibleTool(progress.tail, progress.head)).toMatchObject({
    revision: 1,
    status: "running",
    detail: { input: "live worktree progress" },
  });
  const completed = processAgentStreamEvent({
    event: {
      type: "timeline",
      provider: "omp",
      item: { ...tool(2, "saved result"), status: "completed" },
    },
    seq: 1,
    epoch: "epoch-1",
    timestamp,
    currentTail: progress.tail,
    currentHead: progress.head,
    currentCursor: first.cursor ?? undefined,
  });
  expect(visibleTool(completed.tail, completed.head)).toMatchObject({
    revision: 2,
    status: "completed",
    detail: { input: "saved result" },
  });
});

test("uses newer committed tool status and clears an older failure", () => {
  const failed = processAgentStreamEvent({
    event: {
      type: "timeline",
      provider: "omp",
      item: { ...tool(3, "failed attempt"), status: "failed", error: { message: "old failure" } },
    },
    seq: 1,
    epoch: "epoch-1",
    timestamp,
    currentTail: [],
    currentHead: [],
    currentCursor: undefined,
  });
  const completed = processAgentStreamEvent({
    event: {
      type: "timeline",
      provider: "omp",
      item: { ...tool(4, "recovered result"), status: "completed" },
    },
    seq: 1,
    epoch: "epoch-1",
    timestamp,
    currentTail: failed.tail,
    currentHead: failed.head,
    currentCursor: failed.cursor ?? undefined,
  });
  expect(visibleTool(completed.tail, completed.head)).toMatchObject({
    revision: 4,
    status: "completed",
    error: null,
    detail: { input: "recovered result" },
  });
});
