import type {
  AgentStreamEventPayload,
  ProviderSubagentDescriptorPayload,
  SessionOutboundMessage,
} from "@omp-desktop/protocol/messages";
import type {
  DaemonClient,
  FetchProviderSubagentTimelineOptions,
} from "@omp-desktop/client/internal/daemon-client";
import { create } from "zustand";
import { applyStreamEvent } from "@/types/stream";
import type { StreamItem } from "@/types/stream";
import type { AgentLifecycleStatus } from "@omp-desktop/protocol/agent-lifecycle";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";

type TimelinePayload = Extract<
  SessionOutboundMessage,
  { type: "agent.provider_subagents.timeline.get.response" }
>["payload"];
type UpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "agent.provider_subagents.update" }
>["payload"];

interface ProviderSubagentTimelineRow {
  provider: ProviderSubagentDescriptorPayload["provider"];
  item: Extract<UpdatePayload, { kind: "timeline" }>["item"];
  timestamp: string;
}

type SyncStatus = "loading" | "ready" | "missing" | "error";

export interface ProviderSubagentTimelineState {
  tail: StreamItem[];
  head: StreamItem[];
  epoch: string | null;
  lastSeq: number;
  contentVersion?: number;
  hasOlder: boolean;
  rows: Map<number, ProviderSubagentTimelineRow>;
  needsRefresh: boolean;
  refreshVersion: number;
  pendingEpochs: Map<string, Map<number, ProviderSubagentTimelineRow>>;
  retiredEpochs: Set<string>;
}

interface ProviderSubagentState {
  descriptors: Map<string, ProviderSubagentDescriptorPayload>;
  timelines: Map<string, ProviderSubagentTimelineState>;
  hiddenFromTrack: Set<string>;
  connectionGenerations: Map<string, number>;
  listSync: Map<string, SyncStatus>;
  timelineSync: Map<string, SyncStatus>;
  liveRevisions: Map<string, number>;
  runVersions: Map<string, number>;
  hideFromTrack(serverId: string, parentAgentId: string, subagentIds: readonly string[]): void;
  replaceList(
    serverId: string,
    parentAgentId: string,
    subagents: ProviderSubagentDescriptorPayload[],
    liveRevisions?: ReadonlyMap<string, number>,
  ): void;
  applyUpdate(serverId: string, payload: UpdatePayload): void;
  replaceTimeline(serverId: string, payload: TimelinePayload): void;
}

export function providerSubagentKey(
  serverId: string,
  parentAgentId: string,
  subagentId: string,
): string {
  return `${serverId}\0${parentAgentId}\0${subagentId}`;
}

export function providerSubagentParentKey(serverId: string, parentAgentId: string): string {
  return `${serverId}\0${parentAgentId}`;
}

export function providerSubagentLifecycleStatus(
  status: ProviderSubagentDescriptorPayload["status"],
): AgentLifecycleStatus {
  if (status === "running") return "running";
  if (status === "failed") return "error";
  return "idle";
}

type ListClient = Pick<DaemonClient, "listProviderSubagents">;
type TimelineClient = Pick<DaemonClient, "fetchProviderSubagentTimeline">;
type RecoveryClient = ListClient & TimelineClient & Pick<DaemonClient, "subscribeConnectionStatus">;

const pendingListRequests = new WeakMap<ListClient, Map<string, Promise<void>>>();
const pendingTimelineRequests = new WeakMap<TimelineClient, Map<string, Promise<void>>>();

function generation(serverId: string): number {
  return useProviderSubagentStore.getState().connectionGenerations.get(serverId) ?? 0;
}

function setSyncStatus(kind: "listSync" | "timelineSync", key: string, status: SyncStatus): void {
  useProviderSubagentStore.setState((state) => {
    const next = new Map(state[kind]).set(key, status);
    return kind === "listSync" ? { listSync: next } : { timelineSync: next };
  });
}

export function refreshProviderSubagents(
  client: ListClient & Partial<TimelineClient>,
  serverId: string,
  parentAgentId: string,
): Promise<void> {
  const parentKey = providerSubagentParentKey(serverId, parentAgentId);
  const connectionGeneration = generation(serverId);
  const requestKey = `${parentKey}\0${connectionGeneration}`;
  let clientRequests = pendingListRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    pendingListRequests.set(client, clientRequests);
  }
  const pending = clientRequests.get(requestKey);
  if (pending) return pending;

  const revisions = new Map(useProviderSubagentStore.getState().liveRevisions);
  setSyncStatus("listSync", parentKey, "loading");
  const request = client
    .listProviderSubagents(parentAgentId)
    .then((payload) => {
      if (generation(serverId) !== connectionGeneration) return undefined;
      if (payload.error) throw new Error(payload.error);
      useProviderSubagentStore
        .getState()
        .replaceList(serverId, parentAgentId, payload.subagents, revisions);
      setSyncStatus("listSync", parentKey, "ready");
      if (client.fetchProviderSubagentTimeline) {
        const prefix = `${parentKey}\0`;
        for (const [key, timeline] of useProviderSubagentStore.getState().timelines) {
          if (!key.startsWith(prefix) || !timeline.needsRefresh) continue;
          void refreshProviderSubagentTimeline(
            client as ListClient & TimelineClient,
            serverId,
            parentAgentId,
            key.slice(prefix.length),
          ).catch(() => undefined);
        }
      }
      return undefined;
    })
    .catch((error: unknown) => {
      if (generation(serverId) === connectionGeneration)
        setSyncStatus("listSync", parentKey, "error");
      throw error;
    })
    .finally(() => {
      clientRequests?.delete(requestKey);
    });
  clientRequests.set(requestKey, request);
  return request;
}

function isTimelineSnapshotInvalidated(
  state: ProviderSubagentState,
  key: string,
  before: ProviderSubagentTimelineState | undefined,
  runVersion: number,
  payload: TimelinePayload,
): boolean {
  const current = state.timelines.get(key);
  const changedRun = (state.runVersions.get(key) ?? 0) !== runVersion;
  const changedEpoch = current?.epoch !== before?.epoch;
  const newEpochObserved =
    current?.refreshVersion !== before?.refreshVersion && (current?.pendingEpochs.size ?? 0) > 0;
  return changedRun || newEpochObserved || (changedEpoch && payload.epoch !== current?.epoch);
}

export function refreshProviderSubagentTimeline(
  client: TimelineClient,
  serverId: string,
  parentAgentId: string,
  subagentId: string,
  options: FetchProviderSubagentTimelineOptions = {},
): Promise<void> {
  const key = providerSubagentKey(serverId, parentAgentId, subagentId);
  const connectionGeneration = generation(serverId);
  const direction = options.direction ?? "tail";
  const requestKey = `${key}\0${connectionGeneration}\0${direction}`;
  let clientRequests = pendingTimelineRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    pendingTimelineRequests.set(client, clientRequests);
  }
  const pending = clientRequests.get(requestKey);
  if (pending) return pending;

  if (direction === "tail") setSyncStatus("timelineSync", key, "loading");
  const request = (async () => {
    let requestDirection = direction;
    let cursor = options.cursor;
    // A new run or epoch observed in flight invalidates that snapshot. Repeat within
    // the same single flight, rather than racing a second request against the first.
    while (generation(serverId) === connectionGeneration) {
      const state = useProviderSubagentStore.getState();
      const runVersion = state.runVersions.get(key) ?? 0;
      const before = state.timelines.get(key);
      const payload = await client.fetchProviderSubagentTimeline(parentAgentId, subagentId, {
        limit: TIMELINE_FETCH_PAGE_SIZE,
        ...options,
        direction: requestDirection,
        ...(cursor ? { cursor } : {}),
      });
      if (generation(serverId) !== connectionGeneration) return;
      if (payload.error) throw new Error(payload.error);
      const currentState = useProviderSubagentStore.getState();
      const current = currentState.timelines.get(key);
      if (isTimelineSnapshotInvalidated(currentState, key, before, runVersion, payload)) {
        if (direction !== "tail") return;
        continue;
      }
      if (direction !== "tail" && current?.epoch && payload.epoch !== current.epoch) {
        void refreshProviderSubagentTimeline(client, serverId, parentAgentId, subagentId).catch(
          () => undefined,
        );
        return;
      }
      currentState.replaceTimeline(serverId, payload);
      if (payload.hasMoreRevisions || (requestDirection === "after" && payload.hasNewer)) {
        const loaded = useProviderSubagentStore.getState().timelines.get(key);
        if (!loaded?.epoch) throw new Error("Subagent revision page has no cursor");
        requestDirection = "after";
        cursor = { epoch: loaded.epoch, seq: loaded.lastSeq,
          ...(loaded.contentVersion !== undefined ? { contentVersion: loaded.contentVersion } : {}) };
        continue;
      }
      if (direction !== "tail") return;
      setSyncStatus("timelineSync", key, payload.provider ? "ready" : "missing");
      if (
        !payload.provider ||
        !useProviderSubagentStore.getState().timelines.get(key)?.needsRefresh
      )
        return;
    }
  })()
    .catch((error: unknown) => {
      if (direction === "tail" && generation(serverId) === connectionGeneration) {
        setSyncStatus("timelineSync", key, "error");
      }
      throw error;
    })
    .finally(() => {
      clientRequests?.delete(requestKey);
    });
  clientRequests.set(requestKey, request);
  return request;
}

export function applyProviderSubagentUpdate(
  client: ListClient & TimelineClient,
  serverId: string,
  payload: UpdatePayload,
): void {
  if (payload.kind === "remove") {
    useProviderSubagentStore.getState().applyUpdate(serverId, payload);
    return;
  }
  const parentAgentId =
    payload.kind === "upsert" ? payload.subagent.parentAgentId : payload.parentAgentId;
  const subagentId = payload.kind === "upsert" ? payload.subagent.id : payload.subagentId;
  const key = providerSubagentKey(serverId, parentAgentId, subagentId);
  const wasRunning = useProviderSubagentStore.getState().descriptors.get(key)?.status === "running";
  useProviderSubagentStore.getState().applyUpdate(serverId, payload);
  const state = useProviderSubagentStore.getState();
  if (
    state.timelines.get(key)?.needsRefresh ||
    (payload.kind === "upsert" &&
      !wasRunning &&
      payload.subagent.status === "running" &&
      state.timelineSync.has(key))
  ) {
    void refreshProviderSubagentTimeline(client, serverId, parentAgentId, subagentId).catch(
      () => undefined,
    );
  }
}

export function bindProviderSubagentRecovery(client: RecoveryClient, serverId: string): () => void {
  let wasConnected: boolean | undefined;
  return client.subscribeConnectionStatus((connection) => {
    const connected = connection.status === "connected";
    if (wasConnected === connected) return;
    wasConnected = connected;
    useProviderSubagentStore.setState((state) => ({
      connectionGenerations: new Map(state.connectionGenerations).set(
        serverId,
        generation(serverId) + 1,
      ),
    }));
    if (!connected) return;

    const state = useProviderSubagentStore.getState();
    const serverPrefix = `${serverId}\0`;
    const parents = new Set<string>();
    for (const key of state.listSync.keys()) {
      if (key.startsWith(serverPrefix)) parents.add(key.slice(serverPrefix.length));
    }
    const timelineKeys = new Set([...state.timelines.keys(), ...state.timelineSync.keys()]);
    for (const key of [...state.descriptors.keys(), ...timelineKeys]) {
      if (!key.startsWith(serverPrefix)) continue;
      const [parentAgentId] = key.slice(serverPrefix.length).split("\0");
      parents.add(parentAgentId!);
    }
    for (const parentAgentId of parents) {
      void refreshProviderSubagents(client, serverId, parentAgentId).catch(() => undefined);
    }
    for (const key of timelineKeys) {
      if (!key.startsWith(serverPrefix)) continue;
      const [parentAgentId, subagentId] = key.slice(serverPrefix.length).split("\0");
      void refreshProviderSubagentTimeline(client, serverId, parentAgentId!, subagentId!).catch(
        () => undefined,
      );
    }
  });
}

const EMPTY_TIMELINE: ProviderSubagentTimelineState = {
  tail: [],
  head: [],
  epoch: null,
  lastSeq: 0,
  hasOlder: false,
  rows: new Map(),
  needsRefresh: false,
  refreshVersion: 0,
  pendingEpochs: new Map(),
  retiredEpochs: new Set(),
};

function providerSubagentTerminalEvent(
  subagent: ProviderSubagentDescriptorPayload,
): AgentStreamEventPayload | null {
  if (subagent.status === "running") return null;
  if (subagent.status === "failed") {
    return { type: "turn_failed", provider: subagent.provider, error: "Subagent failed" };
  }
  if (subagent.status === "canceled") {
    return { type: "turn_canceled", provider: subagent.provider, reason: "canceled" };
  }
  return { type: "turn_completed", provider: subagent.provider };
}

function buildTimelineState(
  rows: ProviderSubagentTimelineState["rows"],
  epoch: string | null,
  descriptor?: ProviderSubagentDescriptorPayload,
  hasOlder = false,
): ProviderSubagentTimelineState {
  let timeline = { tail: [] as StreamItem[], head: [] as StreamItem[] };
  let lastSeq = 0;
  for (const [seq, row] of [...rows].sort(([left], [right]) => left - right)) {
    lastSeq = seq;
    timeline = applyStreamEvent({
      ...timeline,
      event: { type: "timeline", provider: row.provider, item: row.item },
      timestamp: new Date(row.timestamp),
    });
  }
  const terminalEvent = descriptor ? providerSubagentTerminalEvent(descriptor) : null;
  if (terminalEvent && descriptor) {
    timeline = applyStreamEvent({
      ...timeline,
      event: terminalEvent,
      timestamp: new Date(descriptor.updatedAt),
    });
  }
  return { ...EMPTY_TIMELINE, ...timeline, epoch, lastSeq, hasOlder, rows };
}

function isNewerToolRevision(
  incoming: ProviderSubagentTimelineRow,
  existing: ProviderSubagentTimelineRow | undefined,
): boolean {
  return (
    incoming.item.type === "tool_call" &&
    existing?.item.type === "tool_call" &&
    incoming.item.callId === existing.item.callId &&
    (incoming.item.status !== "running" || existing.item.status === "running") &&
    ((incoming.item.revision ?? 0) > (existing.item.revision ?? 0) ||
      (incoming.item.status !== "running" && existing.item.status === "running"))
  );
}

function buildTimelineResponseRows(
  existing: ProviderSubagentTimelineState | undefined,
  payload: TimelinePayload,
  provider: ProviderSubagentDescriptorPayload["provider"],
): ProviderSubagentTimelineState["rows"] {
  const rows = new Map<number, ProviderSubagentTimelineRow>();
  for (const row of payload.rows) {
    rows.set(row.seq, { provider, item: row.item, timestamp: row.timestamp });
  }
  for (const row of payload.revisedRows ?? []) {
    // Unloaded rows are fetched by seq when viewed; edits only hydrate retained rows.
    if (existing?.epoch !== payload.epoch || !existing.rows.has(row.seq)) continue;
    const candidate = { provider, item: row.item, timestamp: row.timestamp };
    if (!isNewerToolRevision(rows.get(row.seq) ?? candidate, candidate)) rows.set(row.seq, candidate);
  }
  const liveRows =
    existing?.epoch === payload.epoch ? existing.rows : existing?.pendingEpochs.get(payload.epoch);
  if (!liveRows) return rows;
  if (payload.direction !== "tail" && !payload.reset) {
    const merged = new Map(liveRows);
    for (const [seq, row] of rows) {
      if (!isNewerToolRevision(liveRows.get(seq) ?? row, row)) merged.set(seq, row);
    }
    return merged;
  }
  const boundary = payload.rows.length
    ? Math.max(...payload.rows.map((row) => row.seq))
    : payload.window.maxSeq;
  // Even reset responses can have newer live rows in the authoritative epoch.
  // Keep them by seq, never concatenate a fetched full transcript onto live text.
  for (const [seq, row] of liveRows) {
    if (seq > boundary || isNewerToolRevision(row, rows.get(seq))) rows.set(seq, row);
  }
  return rows;
}

function hasSequenceGap(
  rows: ReadonlyMap<number, ProviderSubagentTimelineRow>,
  boundary: number,
): boolean {
  let previous = boundary;
  for (const seq of [...rows.keys()]
    .filter((candidate) => candidate > boundary)
    .sort((a, b) => a - b)) {
    if (seq !== previous + 1) return true;
    previous = seq;
  }
  return false;
}

function collectProtectedListKeys(
  state: ProviderSubagentState,
  prefix: string,
  requestRevisions: ReadonlyMap<string, number> | undefined,
): Set<string> {
  const protectedKeys = new Set<string>();
  if (requestRevisions) {
    for (const [key, revision] of state.liveRevisions) {
      if (key.startsWith(prefix) && revision !== (requestRevisions.get(key) ?? 0))
        protectedKeys.add(key);
    }
  }
  return protectedKeys;
}

function reconcileListDescriptors(
  state: ProviderSubagentState,
  serverId: string,
  parentAgentId: string,
  subagents: ProviderSubagentDescriptorPayload[],
  protectedKeys: ReadonlySet<string>,
): Pick<ProviderSubagentState, "descriptors" | "hiddenFromTrack" | "runVersions"> {
  const prefix = `${providerSubagentParentKey(serverId, parentAgentId)}\0`;
  const descriptors = new Map(state.descriptors);
  for (const key of descriptors.keys()) {
    if (key.startsWith(prefix) && !protectedKeys.has(key)) descriptors.delete(key);
  }
  const hiddenFromTrack = new Set(state.hiddenFromTrack);
  const runVersions = new Map(state.runVersions);
  for (const subagent of subagents) {
    const key = providerSubagentKey(serverId, parentAgentId, subagent.id);
    if (protectedKeys.has(key)) continue;
    const previous = state.descriptors.get(key);
    const next = previous && previous.updatedAt > subagent.updatedAt ? previous : subagent;
    descriptors.set(key, next);
    if (!previous || (previous.status !== "running" && next.status === "running")) {
      runVersions.set(key, (runVersions.get(key) ?? 0) + 1);
    }
    if (next.status === "running") hiddenFromTrack.delete(key);
  }
  for (const key of state.descriptors.keys()) {
    if (key.startsWith(prefix) && !descriptors.has(key)) {
      runVersions.set(key, (runVersions.get(key) ?? 0) + 1);
    }
  }
  return { descriptors, hiddenFromTrack, runVersions };
}

function reconcileTimelineDescriptor(
  current: ProviderSubagentTimelineState,
  previous: ProviderSubagentDescriptorPayload | undefined,
  subagent: ProviderSubagentDescriptorPayload,
): ProviderSubagentTimelineState {
  if (previous?.status === subagent.status) return current;
  const resumed = previous && previous.status !== "running" && subagent.status === "running";
  return {
    ...current,
    ...buildTimelineState(current.rows, current.epoch, subagent, current.hasOlder),
    pendingEpochs: current.pendingEpochs,
    retiredEpochs: current.retiredEpochs,
    needsRefresh: current.needsRefresh || !!resumed,
    refreshVersion: current.refreshVersion + (resumed ? 1 : 0),
  };
}

function applyDescriptorUpdate(
  state: ProviderSubagentState,
  key: string,
  subagent: ProviderSubagentDescriptorPayload,
): Partial<ProviderSubagentState> {
  const previous = state.descriptors.get(key);
  if (previous && previous.updatedAt > subagent.updatedAt) return state;
  const descriptors = new Map(state.descriptors).set(key, subagent);
  const hiddenFromTrack = new Set(state.hiddenFromTrack);
  const liveRevisions = new Map(state.liveRevisions).set(
    key,
    (state.liveRevisions.get(key) ?? 0) + 1,
  );
  const runVersions = new Map(state.runVersions);
  const resumed = previous && previous.status !== "running" && subagent.status === "running";
  if (!previous || resumed) runVersions.set(key, (runVersions.get(key) ?? 0) + 1);
  if (subagent.status === "running") hiddenFromTrack.delete(key);
  let timelines = state.timelines;
  const current = state.timelines.get(key);
  if (current && previous?.status !== subagent.status) {
    timelines = new Map(state.timelines).set(
      key,
      reconcileTimelineDescriptor(current, previous, subagent),
    );
  }
  return { descriptors, timelines, hiddenFromTrack, liveRevisions, runVersions };
}

function bufferPendingTimelineEpoch(
  current: ProviderSubagentTimelineState,
  payload: Extract<UpdatePayload, { kind: "timeline" }>,
  row: ProviderSubagentTimelineRow,
): ProviderSubagentTimelineState {
  const pendingEpochs = new Map(current.pendingEpochs);
  const pendingRows = new Map(pendingEpochs.get(payload.epoch));
  if (pendingRows.has(payload.seq) && !isNewerToolRevision(row, pendingRows.get(payload.seq)))
    return current;
  const newEpoch = !pendingEpochs.has(payload.epoch);
  pendingRows.set(payload.seq, row);
  pendingEpochs.set(payload.epoch, pendingRows);
  return {
    ...current,
    pendingEpochs,
    needsRefresh: true,
    refreshVersion: current.refreshVersion + (newEpoch ? 1 : 0),
  };
}

function applyTimelineUpdate(
  state: ProviderSubagentState,
  key: string,
  payload: Extract<UpdatePayload, { kind: "timeline" }>,
): Partial<ProviderSubagentState> {
  const current = state.timelines.get(key) ?? EMPTY_TIMELINE;
  if (current.retiredEpochs.has(payload.epoch)) return state;
  const row = { provider: payload.provider, item: payload.item, timestamp: payload.timestamp };
  if (current.epoch && current.epoch !== payload.epoch) {
    const next = bufferPendingTimelineEpoch(current, payload, row);
    return next === current ? state : { timelines: new Map(state.timelines).set(key, next) };
  }
  const previous = current.rows.get(payload.seq);
  if (previous && !isNewerToolRevision(row, previous)) return state;
  const rows = new Map(current.rows).set(payload.seq, row);
  const gap = payload.seq > current.lastSeq + 1;
  const descriptor = state.descriptors.get(key);
  const next =
    previous || payload.seq <= current.lastSeq || descriptor?.status !== "running"
      ? buildTimelineState(rows, payload.epoch, descriptor, current.hasOlder)
      : applyStreamEvent({
          tail: current.tail,
          head: current.head,
          event: { type: "timeline", provider: payload.provider, item: payload.item },
          timestamp: new Date(payload.timestamp),
        });
  return {
    timelines: new Map(state.timelines).set(key, {
      ...current,
      ...next,
      epoch: payload.epoch,
      lastSeq: Math.max(current.lastSeq, payload.seq),
      rows,
      pendingEpochs: current.pendingEpochs,
      retiredEpochs: current.retiredEpochs,
      needsRefresh: current.needsRefresh || gap,
      refreshVersion: current.refreshVersion + (gap ? 1 : 0),
    }),
  };
}

function collectRetiredTimelineEpochs(
  existing: ProviderSubagentTimelineState | undefined,
  payload: TimelinePayload,
): Set<string> {
  const retiredEpochs = new Set(existing?.retiredEpochs);
  if (payload.direction === "tail") {
    if (existing?.epoch && existing.epoch !== payload.epoch) retiredEpochs.add(existing.epoch);
    for (const epoch of existing?.pendingEpochs.keys() ?? []) {
      if (epoch !== payload.epoch) retiredEpochs.add(epoch);
    }
  }
  return retiredEpochs;
}

export const useProviderSubagentStore = create<ProviderSubagentState>((set) => ({
  descriptors: new Map(),
  timelines: new Map(),
  hiddenFromTrack: new Set(),
  connectionGenerations: new Map(),
  listSync: new Map(),
  timelineSync: new Map(),
  liveRevisions: new Map(),
  runVersions: new Map(),
  hideFromTrack(serverId, parentAgentId, subagentIds) {
    set((state) => {
      const hiddenFromTrack = new Set(state.hiddenFromTrack);
      for (const subagentId of subagentIds) {
        const key = providerSubagentKey(serverId, parentAgentId, subagentId);
        if (state.descriptors.get(key)?.status !== "running") hiddenFromTrack.add(key);
      }
      return { hiddenFromTrack };
    });
  },
  replaceList(serverId, parentAgentId, subagents, requestRevisions) {
    set((state) => {
      const prefix = `${providerSubagentParentKey(serverId, parentAgentId)}\0`;
      const protectedKeys = collectProtectedListKeys(state, prefix, requestRevisions);
      const { descriptors, hiddenFromTrack, runVersions } = reconcileListDescriptors(
        state,
        serverId,
        parentAgentId,
        subagents,
        protectedKeys,
      );
      const timelines = new Map(state.timelines);
      for (const [key, current] of timelines) {
        if (!key.startsWith(prefix)) continue;
        const subagent = descriptors.get(key);
        if (!subagent) {
          timelines.delete(key);
          continue;
        }
        timelines.set(
          key,
          reconcileTimelineDescriptor(current, state.descriptors.get(key), subagent),
        );
      }
      return {
        descriptors,
        timelines,
        hiddenFromTrack,
        runVersions,
        listSync: new Map(state.listSync).set(
          providerSubagentParentKey(serverId, parentAgentId),
          "ready",
        ),
      };
    });
  },
  applyUpdate(serverId, payload) {
    set((state) => {
      if (payload.kind === "upsert") {
        const key = providerSubagentKey(
          serverId,
          payload.subagent.parentAgentId,
          payload.subagent.id,
        );
        return applyDescriptorUpdate(state, key, payload.subagent);
      }
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      if (payload.kind === "remove") {
        const descriptors = new Map(state.descriptors);
        descriptors.delete(key);
        const timelines = new Map(state.timelines);
        timelines.delete(key);
        return {
          descriptors,
          timelines,
          liveRevisions: new Map(state.liveRevisions).set(
            key,
            (state.liveRevisions.get(key) ?? 0) + 1,
          ),
          runVersions: new Map(state.runVersions).set(key, (state.runVersions.get(key) ?? 0) + 1),
          timelineSync: new Map(state.timelineSync).set(key, "missing"),
        };
      }
      return applyTimelineUpdate(state, key, payload);
    });
  },
  replaceTimeline(serverId, payload) {
    set((state) => {
      const key = providerSubagentKey(serverId, payload.parentAgentId, payload.subagentId);
      if (!payload.provider) {
        const timelines = new Map(state.timelines);
        timelines.delete(key);
        return { timelines, timelineSync: new Map(state.timelineSync).set(key, "missing") };
      }
      const existing = state.timelines.get(key);
      if (existing?.retiredEpochs.has(payload.epoch)) return state;
      const rows = buildTimelineResponseRows(existing, payload, payload.provider);
      const descriptor = state.descriptors.get(key);
      const retiredEpochs = collectRetiredTimelineEpochs(existing, payload);
      const boundary = payload.rows.length
        ? Math.max(...payload.rows.map((row) => row.seq))
        : payload.window.maxSeq;
      const next = buildTimelineState(rows, payload.epoch, descriptor, payload.hasOlder);
      return {
        timelines: new Map(state.timelines).set(key, {
          ...next,
          ...(payload.reset || payload.direction === "after" || existing?.epoch !== payload.epoch || existing?.contentVersion === undefined
            ? { contentVersion: payload.reset ? payload.contentVersion : Math.max(existing?.contentVersion ?? 0, payload.contentVersion ?? 0) }
            : { contentVersion: existing?.contentVersion }),
          retiredEpochs,
          pendingEpochs:
            payload.direction === "tail" ? new Map() : (existing?.pendingEpochs ?? new Map()),
          refreshVersion: existing?.refreshVersion ?? 0,
          needsRefresh:
            payload.direction === "tail"
              ? hasSequenceGap(rows, boundary)
              : (existing?.needsRefresh ?? false),
        }),
      };
    });
  },
}));
