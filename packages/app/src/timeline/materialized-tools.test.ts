import { afterEach, describe, expect, test } from "vitest";
import type { ToolCallTimelineItem } from "@omp-desktop/protocol/agent-types";
import type { AgentStreamEventPayload } from "@omp-desktop/protocol/messages";
import { providerSubagentKey, useProviderSubagentStore } from "@/subagents/provider-store";
import { isAgentToolCallItem, type StreamItem } from "@/types/stream";
import { useSessionStore } from "@/stores/session-store";
import {
  commitTimelineResponseResult,
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
  useSessionStore.setState({ sessions: {} });
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
    expect(refreshed.commit).toBe("apply");
    const store = useSessionStore.getState();
    store.initializeSession("revision-consumer", null);
    store.setAgentStreamState("revision-consumer", "parent", { tail: first.tail, head: first.head });
    commitTimelineResponseResult({
      result: refreshed, payload: input.payload, serverId: "revision-consumer", agentId: "parent",
      currentCursor: input.currentCursor, currentNewerAvailable: false,
      shouldMarkAuthoritativeHistoryApplied: true, store,
    });
    const committed = useSessionStore.getState().sessions["revision-consumer"]!;
    expect(visibleTool(committed.agentStreamTail.get("parent")!, committed.agentStreamHead.get("parent") ?? []))
      .toMatchObject({ revision: 4, status: "completed", detail: { input: "saved result" } });
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
    for (const direction of ["before", "tail"] as const) {
      const olderPage = processTimelineResponse({ ...input,
        currentTail: refreshed.tail, currentHead: refreshed.head,
        currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 1 },
        payload: { ...input.payload, direction, mergeWindow: true,
          entries: [{ ...input.payload.entries[0]!, item: tool(2, "old page") }] },
      });
      expect(visibleTool(olderPage.tail, olderPage.head)).toMatchObject({
        revision: 4, status: "completed", detail: { input: "saved result" },
      });
    }
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
    store.replaceTimeline("server", {
      requestId: "revised-row", parentAgentId: "parent", subagentId: "child", provider: "omp",
      direction: "after", epoch: "epoch-1", reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 }, hasOlder: false, hasNewer: false,
      contentVersion: 260, rows: [], revisedRows: [{ seq: 1, timestamp: base.timestamp,
        item: { ...tool(258, "updated result"), status: "completed" } }], error: null,
    });
    const revised = useProviderSubagentStore.getState().timelines.get(providerSubagentKey("server", "parent", "child"))!;
    expect(revised.contentVersion).toBe(260);
    expect(revised.lastSeq).toBe(2);
    expect(revised.rows.size).toBe(2);
    expect(visibleTool(revised.tail, revised.head)).toMatchObject({ revision: 258, detail: { input: "updated result" } });
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

test("consumes same-seq after revisions without flushing streaming text or falsely acknowledging an older page", () => {
  const first = processAgentStreamEvent({ event: { type: "timeline", provider: "omp", item: tool(1, "partial") },
    seq: 1, epoch: "epoch-1", timestamp, currentTail: [], currentHead: [], currentCursor: undefined });
  const streaming = processAgentStreamEvent({ event: { type: "timeline", provider: "omp", item: { type: "assistant_message", text: "Live text" } },
    seq: 2, epoch: "epoch-1", timestamp, currentTail: first.tail, currentHead: first.head, currentCursor: first.cursor ?? undefined });
  const input: ProcessTimelineResponseInput = {
    payload: { agentId: "parent", direction: "after", projection: "projected", reset: false, epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 }, startCursor: null, endCursor: { seq: 2 }, entries: [],
      contentVersion: 7, revisedEntries: [{ seqStart: 1, seqEnd: 1, provider: "omp", timestamp: timestamp.toISOString(),
        item: { ...tool(4, "saved result"), status: "completed" } }], error: null, hasOlder: true, hasNewer: false },
    currentTail: streaming.tail, currentHead: streaming.head, currentCursor: { epoch: "epoch-1", startSeq: 1, endSeq: 2, contentVersion: 5 },
    isInitializing: false, hasActiveInitDeferred: false, initRequestDirection: "after", sendingClientMessageIds: [],
  };
  const revised = processTimelineResponse(input);
  expect(revised.commit).toBe("apply");
  expect(revised.head).toBe(streaming.head);
  expect(visibleTool(revised.tail, revised.head)).toMatchObject({ revision: 4, status: "completed" });
  expect(revised.cursor).toEqual({ epoch: "epoch-1", startSeq: 1, endSeq: 2, contentVersion: 7 });
  const unchanged = processTimelineResponse({ ...input, currentTail: revised.tail, currentHead: revised.head,
    currentCursor: revised.cursor ?? undefined, payload: { ...input.payload, revisedEntries: [] } });
  expect(unchanged.commit).toBe("discard");
  expect(unchanged.cursorChanged).toBe(false);
  expect(unchanged.tail).toBe(revised.tail);
  expect(unchanged.head).toBe(revised.head);
  for (const mergeWindow of [true, false]) {
    const oldPage = processTimelineResponse({ ...input, currentTail: revised.tail, currentHead: revised.head,
      currentCursor: { epoch: "epoch-1", startSeq: 2, endSeq: 2, contentVersion: 7 },
      payload: { ...input.payload, direction: "before", mergeWindow,
        startCursor: { seq: 1 }, endCursor: { seq: 1 }, contentVersion: 99,
        entries: [{ ...input.payload.revisedEntries![0]!, item: tool(2, "old page") }], revisedEntries: [] } });
    expect(visibleTool(oldPage.tail, oldPage.head)).toMatchObject({ revision: 4, status: "completed" });
    expect([...oldPage.tail, ...oldPage.head].filter(isAgentToolCallItem)).toHaveLength(1);
    expect(oldPage.cursor?.contentVersion).toBe(7);
  }
  const tail = processTimelineResponse({ ...input, currentTail: revised.tail, currentHead: revised.head,
    currentCursor: revised.cursor ?? undefined, payload: { ...input.payload, direction: "tail", contentVersion: 99, revisedEntries: [] } });
  expect(tail.cursor?.contentVersion).toBe(7);
  const filled = processTimelineResponse({ ...input, currentTail: revised.tail,
    currentHead: revised.head.map((item) => ({ ...item, timelineCursor: { epoch: "epoch-1", seq: 3 } })),
    currentCursor: { epoch: "epoch-1", startSeq: 3, endSeq: 3, contentVersion: 7,
      retainedRanges: [{ startSeq: 1, endSeq: 1 }] },
    payload: { ...input.payload, direction: "after", mergeWindow: true, contentVersion: 99,
      window: { minSeq: 1, maxSeq: 3, nextSeq: 4 }, startCursor: { seq: 2 }, endCursor: { seq: 2 },
      entries: [{ seqStart: 2, seqEnd: 2, provider: "omp", timestamp: timestamp.toISOString(),
        item: { type: "user_message", text: "middle context", messageId: "middle" } }], revisedEntries: [] } });
  expect(filled.cursor).toEqual({ epoch: "epoch-1", startSeq: 1, endSeq: 3, contentVersion: 7 });
  expect(filled.tail.some((item) => item.kind === "user_message" && item.text === "middle context")).toBe(true);
  expect(filled.head.some((item) => item.kind === "assistant_message" && item.text === "Live text")).toBe(true);
  const restartedWindow = processTimelineResponse({ ...input, currentTail: revised.tail, currentHead: revised.head,
    payload: { ...input.payload, mergeWindow: true, reset: true, epoch: "epoch-2", contentVersion: 1,
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: { seq: 1 }, endCursor: { seq: 1 },
      entries: [{ ...input.payload.revisedEntries![0]!, item: tool(1, "new epoch") }], revisedEntries: [] } });
  expect(restartedWindow.cursor).toEqual({ epoch: "epoch-2", startSeq: 1, endSeq: 1, contentVersion: 1 });
  expect(visibleTool(restartedWindow.tail, restartedWindow.head)).toMatchObject({ revision: 1, status: "running" });
});

test("keeps parent turn context when a provider reuses a call ID with revision one", () => {
  const first = processAgentStreamEvent({ event: { type: "timeline", provider: "omp", turnId: "first-turn",
      item: { ...tool(4, "first result"), status: "completed" } },
    seq: 1, epoch: "epoch-1", timestamp, currentTail: [], currentHead: [], currentCursor: undefined });
  const second = processAgentStreamEvent({ event: { type: "timeline", provider: "omp", turnId: "second-turn", item: tool(1, "second input") },
    seq: 2, epoch: "epoch-1", timestamp, currentTail: first.tail, currentHead: first.head, currentCursor: first.cursor ?? undefined });
  expect([...second.tail, ...second.head].filter(isAgentToolCallItem).map((item) => ({
    turnId: item.turnId, revision: item.payload.data.revision, status: item.payload.data.status,
    input: item.payload.data.detail.type === "unknown" ? item.payload.data.detail.input : null,
  }))).toEqual([
    { turnId: "first-turn", revision: 4, status: "completed", input: "first result" },
    { turnId: "second-turn", revision: 1, status: "running", input: "second input" },
  ]);
});
