import type { ProviderSubagentDescriptorPayload } from "@omp-desktop/protocol/messages";
import type {
  ConnectionState,
  ProviderSubagentListPayload,
  ProviderSubagentTimelinePayload,
} from "@omp-desktop/client/internal/daemon-client";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyProviderSubagentUpdate,
  bindProviderSubagentRecovery,
  providerSubagentKey,
  providerSubagentParentKey,
  refreshProviderSubagentTimeline,
  refreshProviderSubagents,
  useProviderSubagentStore,
} from "./provider-store";

const SERVER = "recovery-server";
const PARENT = "parent";
const CHILD = "child";
const KEY = providerSubagentKey(SERVER, PARENT, CHILD);
const timestamp = "2026-11-01T10:00:00.000Z";
const descriptor: ProviderSubagentDescriptorPayload = {
  id: CHILD,
  parentAgentId: PARENT,
  provider: "omp",
  title: "Explore",
  description: "Inspect the repository",
  status: "running",
  createdAt: timestamp,
  updatedAt: timestamp,
  toolCallId: "dispatch",
};

function page(epoch: string, chunks: string[], reset = false): ProviderSubagentTimelinePayload {
  return {
    requestId: "tail",
    parentAgentId: PARENT,
    subagentId: CHILD,
    provider: "omp",
    direction: "tail",
    epoch,
    reset,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: chunks.length, nextSeq: chunks.length + 1 },
    hasOlder: false,
    hasNewer: false,
    rows: chunks.map((text, index) => ({
      seq: index + 1,
      timestamp,
      item: { type: "assistant_message", messageId: "message", text },
    })),
    error: null,
  };
}

function live(seq: number, text: string, epoch = "epoch-1") {
  return {
    kind: "timeline" as const,
    parentAgentId: PARENT,
    subagentId: CHILD,
    provider: "omp" as const,
    epoch,
    seq,
    timestamp,
    item: { type: "assistant_message" as const, messageId: "message", text },
  };
}

function displayedText(): string {
  const timeline = useProviderSubagentStore.getState().timelines.get(KEY);
  return [...(timeline?.tail ?? []), ...(timeline?.head ?? [])]
    .filter((item) => item.kind === "assistant_message")
    .map((item) => item.text)
    .join("");
}

function clientWithTimeline(fetch: () => Promise<ProviderSubagentTimelinePayload>) {
  return {
    listProviderSubagents: vi.fn(
      async (): Promise<ProviderSubagentListPayload> => ({
        requestId: "list",
        parentAgentId: PARENT,
        subagents: [descriptor],
        error: null,
      }),
    ),
    fetchProviderSubagentTimeline: vi.fn(fetch),
    getProviderSubagentSubscriptions: vi.fn(() => ({
      parentAgentIds: [PARENT],
      timelines: [{ parentAgentId: PARENT, subagentId: CHILD }],
    })),
    syncProviderSubagentSubscriptions: vi.fn(async () => {}),
  };
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

describe("provider child authoritative recovery", () => {
  test("displays text, thinking and tool deltas without duplicate rows or full refreshes", () => {
    const client = clientWithTimeline(async () => page("epoch-1", []));
    applyProviderSubagentUpdate(client, SERVER, { kind: "upsert", subagent: descriptor });
    const thinking = { ...live(1, ""), item: { type: "reasoning" as const, text: "Inspect " } };
    applyProviderSubagentUpdate(client, SERVER, thinking);
    applyProviderSubagentUpdate(client, SERVER, {
      ...thinking,
      seq: 2,
      item: { type: "reasoning", text: "first." },
    });
    const tool = {
      ...live(3, ""),
      item: {
        type: "tool_call" as const,
        callId: "read-1",
        name: "read",
        status: "running" as const,
        error: null,
        detail: { type: "unknown" as const, input: { path: "src/index.ts" }, output: null },
      },
    };
    applyProviderSubagentUpdate(client, SERVER, tool);
    applyProviderSubagentUpdate(client, SERVER, {
      ...tool,
      seq: 4,
      item: {
        ...tool.item,
        status: "completed",
        detail: { ...tool.item.detail, output: "source" },
      },
    });
    applyProviderSubagentUpdate(client, SERVER, live(5, "Hello "));
    applyProviderSubagentUpdate(client, SERVER, live(6, "world."));
    applyProviderSubagentUpdate(client, SERVER, live(6, "world."));
    const timeline = useProviderSubagentStore.getState().timelines.get(KEY)!;
    const items = [...timeline.tail, ...timeline.head];
    expect(displayedText()).toBe("Hello world.");
    expect(items.filter((item) => item.kind === "thought")).toEqual([
      expect.objectContaining({ text: "Inspect first.", status: "ready" }),
    ]);
    expect(items.filter((item) => item.kind === "tool_call")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          data: expect.objectContaining({ callId: "read-1", status: "completed" }),
        }),
      }),
    ]);
    expect(client.fetchProviderSubagentTimeline).not.toHaveBeenCalled();
  });

  test("fills a seq gap in one flight and merges rows arriving behind the tail request", async () => {
    const tail = Promise.withResolvers<ProviderSubagentTimelinePayload>();
    const client = clientWithTimeline(() => tail.promise);
    applyProviderSubagentUpdate(client, SERVER, { kind: "upsert", subagent: descriptor });
    applyProviderSubagentUpdate(client, SERVER, live(1, "A"));
    applyProviderSubagentUpdate(client, SERVER, live(3, "C"));
    const recovery = refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    applyProviderSubagentUpdate(client, SERVER, live(4, "D"));
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledTimes(1);
    tail.resolve(page("epoch-1", ["A", "B", "C"]));
    await recovery;
    expect(displayedText()).toBe("ABCD");
    expect(useProviderSubagentStore.getState().timelines.get(KEY)?.needsRefresh).toBe(false);
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledTimes(1);
  });

  test("rebuilds a changed epoch and preserves live rows newer than a reset tail", async () => {
    const tail = Promise.withResolvers<ProviderSubagentTimelinePayload>();
    const client = clientWithTimeline(() => tail.promise);
    applyProviderSubagentUpdate(client, SERVER, { kind: "upsert", subagent: descriptor });
    applyProviderSubagentUpdate(client, SERVER, live(1, "Old"));
    applyProviderSubagentUpdate(client, SERVER, live(2, "B", "epoch-2"));
    const recovery = refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    applyProviderSubagentUpdate(client, SERVER, live(3, "C", "epoch-2"));
    expect(displayedText()).toBe("Old");
    tail.resolve(page("epoch-2", ["A", "B"], true));
    await recovery;
    expect(displayedText()).toBe("ABC");
    expect(useProviderSubagentStore.getState().timelines.get(KEY)?.epoch).toBe("epoch-2");
    applyProviderSubagentUpdate(client, SERVER, live(4, "Stale", "epoch-1"));
    expect(displayedText()).toBe("ABC");
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledTimes(1);
  });

  test("does not let a pre-epoch request retire a new epoch observed in flight", async () => {
    const oldTail = Promise.withResolvers<ProviderSubagentTimelinePayload>();
    const client = clientWithTimeline(async () => page("epoch-2", ["New"], true));
    client.fetchProviderSubagentTimeline.mockImplementationOnce(() => oldTail.promise);
    useProviderSubagentStore.getState().replaceTimeline(SERVER, page("epoch-1", ["Old"]));
    const request = refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    applyProviderSubagentUpdate(client, SERVER, live(1, "New", "epoch-2"));
    oldTail.resolve(page("epoch-1", ["Old"]));
    await request;
    expect(displayedText()).toBe("New");
    expect(useProviderSubagentStore.getState().timelines.get(KEY)?.epoch).toBe("epoch-2");
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledTimes(2);
  });

  test("recovers a dropped final delta on invalidate while preserving newer output and completion", async () => {
    const tail = Promise.withResolvers<ProviderSubagentTimelinePayload>();
    const client = clientWithTimeline(() => tail.promise);
    applyProviderSubagentUpdate(client, SERVER, { kind: "upsert", subagent: descriptor });
    applyProviderSubagentUpdate(client, SERVER, live(1, "A"));
    // The final B delta was dropped: no later seq exists to expose the gap.
    applyProviderSubagentUpdate(client, SERVER, { kind: "invalidate", parentAgentId: PARENT });
    const recovery = refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    const listRecovery = refreshProviderSubagents(client, SERVER, PARENT);
    applyProviderSubagentUpdate(client, SERVER, live(3, "C"));
    applyProviderSubagentUpdate(client, SERVER, {
      kind: "upsert",
      subagent: { ...descriptor, status: "completed" },
    });
    tail.resolve(page("epoch-1", ["A", "B"]));
    await Promise.all([recovery, listRecovery]);
    const state = useProviderSubagentStore.getState();
    expect(displayedText()).toBe("ABC");
    expect(state.descriptors.get(KEY)?.status).toBe("completed");
    expect(state.timelines.get(KEY)?.head).toEqual([]);
    expect(state.timelines.get(KEY)?.needsRefresh).toBe(false);
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledTimes(1);
  });

  test("starts recovery without waiting for invalidated old snapshots and ignores their late results", async () => {
    const oldList = Promise.withResolvers<ProviderSubagentListPayload>();
    const oldTail = Promise.withResolvers<ProviderSubagentTimelinePayload>();
    const freshTail = Promise.withResolvers<ProviderSubagentTimelinePayload>();
    const client = clientWithTimeline(() => freshTail.promise);
    useProviderSubagentStore
      .getState()
      .applyUpdate(SERVER, { kind: "upsert", subagent: descriptor });
    useProviderSubagentStore.getState().replaceTimeline(SERVER, page("epoch-1", ["A"]));
    client.listProviderSubagents.mockImplementationOnce(() => oldList.promise);
    client.fetchProviderSubagentTimeline.mockImplementationOnce(() => oldTail.promise);
    const staleList = refreshProviderSubagents(client, SERVER, PARENT);
    const staleTail = refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    applyProviderSubagentUpdate(client, SERVER, { kind: "invalidate" });
    const recoveredList = refreshProviderSubagents(client, SERVER, PARENT);
    const recoveredTail = refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    expect(client.listProviderSubagents).toHaveBeenCalledTimes(2);
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledTimes(2);
    applyProviderSubagentUpdate(client, SERVER, live(3, "C"));
    freshTail.resolve(page("epoch-1", ["A", "B"]));
    await Promise.all([recoveredList, recoveredTail]);
    expect(displayedText()).toBe("ABC");
    oldList.resolve({ requestId: "old-list", parentAgentId: PARENT, subagents: [], error: null });
    oldTail.resolve(page("epoch-1", ["Stale"]));
    await Promise.all([staleList, staleTail]);
    expect(displayedText()).toBe("ABC");
    expect(useProviderSubagentStore.getState().descriptors.get(KEY)).toEqual(descriptor);
  });

  test("coalesces repeated invalidations instead of creating unbounded recovery flights", async () => {
    const oldTail = Promise.withResolvers<ProviderSubagentTimelinePayload>();
    const recoveryTail = Promise.withResolvers<ProviderSubagentTimelinePayload>();
    const client = clientWithTimeline(async () => page("epoch-1", ["A", "B", "C"]));
    client.fetchProviderSubagentTimeline
      .mockImplementationOnce(() => oldTail.promise)
      .mockImplementationOnce(() => recoveryTail.promise);
    useProviderSubagentStore
      .getState()
      .applyUpdate(SERVER, { kind: "upsert", subagent: descriptor });
    const old = refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    applyProviderSubagentUpdate(client, SERVER, { kind: "invalidate", parentAgentId: PARENT });
    const recovery = refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    for (let index = 0; index < 20; index += 1) {
      applyProviderSubagentUpdate(client, SERVER, { kind: "invalidate", parentAgentId: PARENT });
    }
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledTimes(2);
    recoveryTail.resolve(page("epoch-1", ["A", "B"]));
    await recovery;
    expect(displayedText()).toBe("ABC");
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledTimes(3);
    oldTail.resolve(page("epoch-1", ["Stale"]));
    await old;
    expect(displayedText()).toBe("ABC");
  });

  test("marks an inactive child dirty without fetching its timeline for gaps or invalidation", async () => {
    const client = clientWithTimeline(async () => page("epoch-1", ["A", "B", "C"]));
    client.getProviderSubagentSubscriptions.mockReturnValue({
      parentAgentIds: [PARENT],
      timelines: [],
    });
    applyProviderSubagentUpdate(client, SERVER, { kind: "upsert", subagent: descriptor });
    applyProviderSubagentUpdate(client, SERVER, live(1, "A"));
    applyProviderSubagentUpdate(client, SERVER, live(3, "C"));
    expect(useProviderSubagentStore.getState().timelines.get(KEY)?.needsRefresh).toBe(true);
    applyProviderSubagentUpdate(client, SERVER, { kind: "invalidate" });
    await refreshProviderSubagents(client, SERVER, PARENT);
    expect(client.fetchProviderSubagentTimeline).not.toHaveBeenCalled();
    expect(useProviderSubagentStore.getState().timelines.get(KEY)?.needsRefresh).toBe(true);
    client.getProviderSubagentSubscriptions.mockReturnValue({
      parentAgentIds: [PARENT],
      timelines: [{ parentAgentId: PARENT, subagentId: CHILD }],
    });
    await refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    expect(displayedText()).toBe("ABC");
    expect(useProviderSubagentStore.getState().timelines.get(KEY)?.needsRefresh).toBe(false);
  });

  test("waits for restored lease ACK and refreshes no closed or unrelated cached children", async () => {
    const ack = Promise.withResolvers<void>();
    const client = {
      ...clientWithTimeline(async () => page("epoch-1", ["Recovered"])),
      subscribeConnectionStatus: vi.fn(),
    };
    client.syncProviderSubagentSubscriptions.mockImplementation(() => ack.promise);
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER, { kind: "upsert", subagent: descriptor });
    store.applyUpdate(SERVER, { kind: "upsert", subagent: { ...descriptor, id: "closed" } });
    store.replaceTimeline(SERVER, { ...page("epoch-1", ["Closed"]), subagentId: "closed" });
    store.applyUpdate(SERVER, {
      kind: "upsert",
      subagent: { ...descriptor, id: "unrelated-child", parentAgentId: "unrelated" },
    });
    let connectionListener!: (connection: ConnectionState) => void;
    client.subscribeConnectionStatus.mockImplementation((listener: typeof connectionListener) => {
      connectionListener = listener;
      listener({ status: "disconnected" });
      return () => {};
    });
    const unbind = bindProviderSubagentRecovery(client, SERVER);
    connectionListener({ status: "connected" });
    expect(client.syncProviderSubagentSubscriptions).toHaveBeenCalledTimes(1);
    expect(client.listProviderSubagents).not.toHaveBeenCalled();
    expect(client.fetchProviderSubagentTimeline).not.toHaveBeenCalled();
    ack.resolve();
    await vi.waitFor(() => expect(displayedText()).toBe("Recovered"));
    expect(client.listProviderSubagents).toHaveBeenCalledTimes(1);
    expect(client.listProviderSubagents).toHaveBeenCalledWith(PARENT);
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledTimes(1);
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledWith(
      PARENT,
      CHILD,
      expect.objectContaining({ direction: "tail" }),
    );
    unbind();
  });

  test("reconnects active children after lease ACK and rejects old-connection responses", async () => {
    const completed = { ...descriptor, status: "completed" as const };
    const hidden = { ...completed, id: "hidden" };
    const running = { ...descriptor, updatedAt: "2026-11-01T10:01:00.000Z" };
    const oldList = Promise.withResolvers<ProviderSubagentListPayload>();
    const oldTail = Promise.withResolvers<ProviderSubagentTimelinePayload>();
    let currentList = [completed, hidden] as ProviderSubagentDescriptorPayload[];
    let currentPage = page("epoch-1", ["Old"]);
    const client = {
      ...clientWithTimeline(async () => currentPage),
      subscribeConnectionStatus: vi.fn(),
    };
    client.listProviderSubagents.mockImplementation(async () => ({
      requestId: "list",
      parentAgentId: PARENT,
      subagents: currentList,
      error: null,
    }));
    let connectionListener!: (connection: ConnectionState) => void;
    client.subscribeConnectionStatus.mockImplementation((listener: typeof connectionListener) => {
      connectionListener = listener;
      listener({ status: "connected" });
      return () => {};
    });
    const unbind = bindProviderSubagentRecovery(client, SERVER);
    await refreshProviderSubagents(client, SERVER, PARENT);
    await refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    useProviderSubagentStore.getState().hideFromTrack(SERVER, PARENT, [CHILD, "hidden"]);
    client.listProviderSubagents.mockImplementationOnce(() => oldList.promise);
    client.fetchProviderSubagentTimeline.mockImplementationOnce(() => oldTail.promise);
    const staleList = refreshProviderSubagents(client, SERVER, PARENT);
    const staleTimeline = refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    const callsBeforeReconnect = client.fetchProviderSubagentTimeline.mock.calls.length;
    connectionListener({ status: "disconnected" });
    currentList = [running, hidden];
    currentPage = page("epoch-2", ["New"], true);
    connectionListener({ status: "connected" });
    await refreshProviderSubagents(client, SERVER, PARENT);
    await refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    expect(client.fetchProviderSubagentTimeline.mock.calls.length).toBeGreaterThan(
      callsBeforeReconnect,
    );
    oldList.resolve({
      requestId: "stale",
      parentAgentId: PARENT,
      subagents: [completed],
      error: null,
    });
    oldTail.resolve(page("epoch-1", ["Stale"]));
    await Promise.all([staleList, staleTimeline]);
    const state = useProviderSubagentStore.getState();
    expect(state.descriptors.get(KEY)?.status).toBe("running");
    expect(state.hiddenFromTrack.has(KEY)).toBe(false);
    expect(state.hiddenFromTrack.has(providerSubagentKey(SERVER, PARENT, "hidden"))).toBe(true);
    expect(displayedText()).toBe("New");
    unbind();
  });

  test("keeps a new same-id run visible when old list and tail requests finish", async () => {
    const completed = { ...descriptor, status: "completed" as const };
    const oldList = Promise.withResolvers<ProviderSubagentListPayload>();
    const oldTail = Promise.withResolvers<ProviderSubagentTimelinePayload>();
    const client = clientWithTimeline(async () => page("epoch-1", ["Old", "New"]));
    useProviderSubagentStore
      .getState()
      .applyUpdate(SERVER, { kind: "upsert", subagent: completed });
    useProviderSubagentStore.getState().replaceTimeline(SERVER, page("epoch-1", ["Old"]));
    useProviderSubagentStore.getState().hideFromTrack(SERVER, PARENT, [CHILD]);
    client.listProviderSubagents.mockImplementationOnce(() => oldList.promise);
    client.fetchProviderSubagentTimeline.mockImplementationOnce(() => oldTail.promise);
    const listRequest = refreshProviderSubagents(client, SERVER, PARENT);
    const tailRequest = refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    applyProviderSubagentUpdate(client, SERVER, {
      kind: "upsert",
      subagent: { ...descriptor, updatedAt: "2026-11-01T10:01:00.000Z" },
    });
    applyProviderSubagentUpdate(client, SERVER, live(2, "New"));
    oldList.resolve({
      requestId: "old",
      parentAgentId: PARENT,
      subagents: [completed],
      error: null,
    });
    oldTail.resolve(page("epoch-1", ["Old"]));
    await Promise.all([listRequest, tailRequest]);
    expect(useProviderSubagentStore.getState().descriptors.get(KEY)?.status).toBe("running");
    expect(useProviderSubagentStore.getState().hiddenFromTrack.has(KEY)).toBe(false);
    expect(displayedText()).toBe("OldNew");
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledTimes(2);
  });

  test("does not let an in-flight missing result erase a newly started child's live output", async () => {
    const missing = Promise.withResolvers<ProviderSubagentTimelinePayload>();
    const client = clientWithTimeline(async () => page("epoch-1", ["New"]));
    client.fetchProviderSubagentTimeline.mockImplementationOnce(() => missing.promise);
    const request = refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    applyProviderSubagentUpdate(client, SERVER, { kind: "upsert", subagent: descriptor });
    applyProviderSubagentUpdate(client, SERVER, live(1, "New"));
    missing.resolve({ ...page("epoch-1", []), provider: null });
    await request;
    expect(displayedText()).toBe("New");
    expect(useProviderSubagentStore.getState().timelineSync.get(KEY)).toBe("ready");
    expect(client.fetchProviderSubagentTimeline).toHaveBeenCalledTimes(2);
  });

  test("settles missing children and permits an explicit retry after a failed fetch", async () => {
    const client = clientWithTimeline(async () => ({ ...page("epoch-1", []), provider: null }));
    client.listProviderSubagents.mockResolvedValue({
      requestId: "list",
      parentAgentId: PARENT,
      subagents: [],
      error: null,
    });
    await refreshProviderSubagents(client, SERVER, PARENT);
    await refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    expect(
      useProviderSubagentStore.getState().listSync.get(providerSubagentParentKey(SERVER, PARENT)),
    ).toBe("ready");
    expect(useProviderSubagentStore.getState().timelineSync.get(KEY)).toBe("missing");
    client.fetchProviderSubagentTimeline.mockRejectedValueOnce(new Error("offline"));
    await expect(refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD)).rejects.toThrow(
      "offline",
    );
    expect(useProviderSubagentStore.getState().timelineSync.get(KEY)).toBe("error");
    client.fetchProviderSubagentTimeline.mockResolvedValueOnce(
      page("epoch-2", ["Recovered"], true),
    );
    await refreshProviderSubagentTimeline(client, SERVER, PARENT, CHILD);
    expect(displayedText()).toBe("Recovered");
    expect(useProviderSubagentStore.getState().timelineSync.get(KEY)).toBe("ready");
  });
});
