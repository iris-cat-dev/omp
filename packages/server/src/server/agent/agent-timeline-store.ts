import { randomUUID } from "node:crypto";
import type { AgentUserMessageRewindStatus } from "@omp-desktop/protocol/agent-types";
import type { AgentTimelineItem, ToolCallTimelineItem } from "./agent-sdk-types.js";
import { mergeToolCallItems } from "./timeline-projection.js";
import { formatToolCallEntry } from "./activity-curator.js";
import {
  applyToolContextChanges,
  copyContextText,
  createToolContextChange,
  toolContextKey,
  type ToolContext,
} from "./tool-context-history.js";
import type {
  AgentTimelineFetchOptions,
  AgentToolContextChange,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "./agent-timeline-store-types.js";

export interface SeedAgentTimelineOptions {
  items?: readonly AgentTimelineItem[];
  rows?: readonly AgentTimelineRow[];
  epoch?: string;
  nextSeq?: number;
  timestamp?: string;
}

interface MaterializedToolCall {
  rowIndex: number;
  firstSeq: number;
  item: ToolCallTimelineItem;
}

function toolForkContext(item: ToolCallTimelineItem): ToolContext {
  return {
    summary: copyContextText(formatToolCallEntry(item, { includeExternalToolInput: false }).text),
    log: item.detail.type === "sub_agent" ? item.detail.log : "",
  };
}

function toolCallRow(row: AgentTimelineRow, call: MaterializedToolCall): AgentTimelineRow {
  return {
    ...row,
    get item() {
      return call.item;
    },
  };
}

interface AgentTimelineState {
  epoch: string;
  rows: AgentTimelineRow[];
  nextSeq: number;
  contentVersion: number;
  toolCalls: Map<string, MaterializedToolCall>;
  contextsAtBoundary: Map<string, ToolContext>;
  pendingToolContexts: Map<string, { callId: string; turnId?: string; context: ToolContext }>;
}

const DEFAULT_TIMELINE_FETCH_LIMIT = 200;

function estimateResidentBytes(value: unknown): number {
  if (typeof value === "string") return 24 + value.length * 2;
  if (typeof value !== "object" || value === null) return 8;
  if (Array.isArray(value)) {
    let bytes = 48;
    for (const item of value) bytes += 8 + estimateResidentBytes(item);
    return bytes;
  }
  let bytes = 64;
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      bytes += key.length * 2 + 16 + estimateResidentBytes((value as Record<string, unknown>)[key]);
    }
  }
  return bytes;
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row };
}

function cloneFetchRow(row: AgentTimelineRow): AgentTimelineRow {
  const copy = cloneRow(row);
  delete copy.toolContextChanges;
  delete copy.contentVersion;
  return copy;
}

interface FetchContext {
  state: AgentTimelineState;
  direction: NonNullable<AgentTimelineFetchOptions["direction"]>;
  limit: number;
  selectAll: boolean;
  cursor: AgentTimelineFetchOptions["cursor"];
  minSeq: number;
  maxSeq: number;
  window: { minSeq: number; maxSeq: number; nextSeq: number };
  cloneRow: (row: AgentTimelineRow) => AgentTimelineRow;
}

function fetchTail(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, minSeq, window } = ctx;
  const selected =
    selectAll || limit >= state.rows.length
      ? state.rows
      : state.rows.slice(state.rows.length - limit);
  return {
    epoch: state.epoch,
    contentVersion: state.contentVersion,
    direction,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected.length > 0 && selected[0].seq > minSeq,
    hasNewer: false,
    rows: selected.map(ctx.cloneRow),
  };
}

function fetchAfter(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, cursor, minSeq, maxSeq, window } = ctx;
  const baseSeq = cursor?.seq ?? 0;
  const acknowledgedVersion = cursor?.contentVersion ?? 0;
  const revisions =
    acknowledgedVersion < state.contentVersion
      ? state.rows
          .filter((row) => row.seq <= baseSeq && (row.contentVersion ?? 0) > acknowledgedVersion)
          .sort((left, right) => (left.contentVersion ?? 0) - (right.contentVersion ?? 0))
      : [];
  const revisedRows = selectAll ? revisions : revisions.slice(0, limit);
  const hasMoreRevisions = revisedRows.length < revisions.length;
  const contentVersion = hasMoreRevisions
    ? revisedRows.at(-1)!.contentVersion!
    : state.contentVersion;
  const startIdx = state.rows.findIndex((row) => row.seq > baseSeq);
  const selected =
    startIdx < 0
      ? []
      : selectAll
        ? state.rows.slice(startIdx)
        : state.rows.slice(startIdx, startIdx + limit);
  const lastSelected = selected.at(-1);
  return {
    epoch: state.epoch,
    contentVersion,
    hasMoreRevisions,
    direction,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected.length > 0 ? selected[0].seq > minSeq : baseSeq >= minSeq,
    hasNewer: hasMoreRevisions || (lastSelected !== undefined && lastSelected.seq < maxSeq),
    rows: selected.map(ctx.cloneRow),
    revisedRows: revisedRows.map(ctx.cloneRow),
  };
}

function fetchBefore(ctx: FetchContext): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, cursor, minSeq, window } = ctx;
  const beforeSeq = cursor?.seq ?? state.nextSeq;
  const endExclusive = state.rows.findIndex((row) => row.seq >= beforeSeq);
  const boundedRows = endExclusive < 0 ? state.rows : state.rows.slice(0, endExclusive);
  const selected =
    selectAll || limit >= boundedRows.length
      ? boundedRows
      : boundedRows.slice(boundedRows.length - limit);
  return {
    epoch: state.epoch,
    direction,
    contentVersion: state.contentVersion,
    reset: false,
    staleCursor: false,
    gap: false,
    window,
    hasOlder: selected.length > 0 && selected[0].seq > minSeq,
    hasNewer: endExclusive >= 0,
    rows: selected.map(ctx.cloneRow),
  };
}

function fetchReset(
  ctx: FetchContext,
  flags: { staleCursor: boolean; gap: boolean },
): AgentTimelineFetchResult {
  const { state, direction, limit, selectAll, minSeq, window } = ctx;
  const rows =
    selectAll || limit >= state.rows.length
      ? state.rows.map(ctx.cloneRow)
      : state.rows.slice(state.rows.length - limit).map(ctx.cloneRow);
  // A bounded reset can retain visible old tool identities in the replica.
  // Do not acknowledge unseen edits outside this page: after pages drain them.
  const needsRevisionCatchUp = rows.length < state.rows.length && ctx.cursor?.epoch === state.epoch;
  const contentVersion = needsRevisionCatchUp
    ? ctx.cursor?.contentVersion !== undefined && ctx.cursor.contentVersion <= state.contentVersion
      ? ctx.cursor.contentVersion
      : 0
    : state.contentVersion;
  return {
    epoch: state.epoch,
    contentVersion,
    direction,
    reset: true,
    staleCursor: flags.staleCursor,
    gap: flags.gap,
    window,
    hasOlder: rows.length > 0 && rows[0].seq > minSeq,
    hasNewer: contentVersion < state.contentVersion,
    hasMoreRevisions: contentVersion < state.contentVersion,
    rows,
  };
}

function resolveHydratedToolCall(
  toolCalls: Map<string, MaterializedToolCall>,
  key: string,
  item: ToolCallTimelineItem,
  rowIndex: number,
  firstSeq: number,
): MaterializedToolCall {
  let call = toolCalls.get(key);
  if (call) {
    // Historical sequence numbers remain addressable, but no longer own
    // superseded argument/log snapshots.
    if ((item.revision ?? 0) === 0 || (item.revision ?? 0) > (call.item.revision ?? 0)) {
      call.item = {
        ...mergeToolCallItems(call.item, item),
        revision: Math.max((call.item.revision ?? 0) + 1, item.revision ?? 0),
      };
    }
  } else {
    call = {
      rowIndex,
      firstSeq,
      item: { ...mergeToolCallItems(item, item), revision: Math.max(1, item.revision ?? 0) },
    };
    toolCalls.set(key, call);
  }
  return call;
}

function hydrateToolCallState(
  rows: AgentTimelineRow[],
): Pick<AgentTimelineState, "toolCalls" | "contextsAtBoundary" | "pendingToolContexts"> {
  const toolCalls = new Map<string, MaterializedToolCall>();
  const contextsAtBoundary = new Map<string, ToolContext>();
  const pendingToolContexts: AgentTimelineState["pendingToolContexts"] = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.toolContextChanges) {
      applyToolContextChanges(contextsAtBoundary, row.toolContextChanges);
    }
    if (row.item.type !== "tool_call") continue;
    const key = toolContextKey(row.item.callId, row.turnId);
    const call = resolveHydratedToolCall(toolCalls, key, row.item, index, row.seq);
    if (!row.toolContextChanges) {
      const context = toolForkContext(call.item);
      const change = createToolContextChange({
        callId: row.item.callId,
        turnId: row.turnId,
        previous: contextsAtBoundary.get(key),
        next: context,
      });
      row.toolContextChanges = change ? [change] : [];
      contextsAtBoundary.set(key, context);
    }
    call.rowIndex = index;
    rows[index] = toolCallRow(row, call);
  }
  for (const [key, call] of toolCalls) {
    const context = toolForkContext(call.item);
    const committed = contextsAtBoundary.get(key);
    if (context.summary !== committed?.summary || context.log !== (committed?.log ?? "")) {
      pendingToolContexts.set(key, {
        callId: call.item.callId,
        turnId: rows[call.rowIndex].turnId,
        context,
      });
    }
  }
  return { toolCalls, contextsAtBoundary, pendingToolContexts };
}

function fetchCursorReset(ctx: FetchContext): AgentTimelineFetchResult | undefined {
  const { state, direction, cursor, minSeq } = ctx;
  if (cursor && typeof cursor.epoch === "string" && cursor.epoch !== state.epoch) {
    return fetchReset(ctx, { staleCursor: true, gap: false });
  }
  if (direction === "after" && cursor && state.rows.length > 0 && cursor.seq < minSeq - 1) {
    return fetchReset(ctx, { staleCursor: false, gap: true });
  }
  if (
    direction === "after" &&
    (!cursor ||
      cursor.contentVersion === undefined ||
      cursor.contentVersion > state.contentVersion ||
      cursor.seq > ctx.maxSeq)
  ) {
    // A seq alone cannot acknowledge edits to old rows. Unknown/restarted
    // replicas receive one authoritative page, then acknowledge its watermark.
    return fetchReset(ctx, { staleCursor: false, gap: false });
  }
  return undefined;
}

export class InMemoryAgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineState>();

  has(agentId: string): boolean {
    return this.states.has(agentId);
  }

  initialize(agentId: string, options?: SeedAgentTimelineOptions): void {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const rows = options?.rows?.length
      ? options.rows.map(cloneRow)
      : this.buildRowsFromItems(options?.items ?? [], options?.nextSeq ?? 1, timestamp);
    const nextSeq = options?.nextSeq ?? (rows.length ? rows[rows.length - 1].seq + 1 : 1);
    let contentVersion = 0;
    for (const row of rows) contentVersion = Math.max(contentVersion, row.contentVersion ?? 0);
    for (const row of rows) {
      if (row.contentVersion === undefined) row.contentVersion = ++contentVersion;
    }
    const toolCallState = hydrateToolCallState(rows);
    this.states.set(agentId, {
      epoch: options?.epoch ?? randomUUID(),
      rows,
      nextSeq,
      contentVersion,
      ...toolCallState,
    });
  }

  delete(agentId: string): void {
    this.states.delete(agentId);
  }

  getRetainedBytes(agentId: string): number {
    const state = this.requireState(agentId);
    let bytes = estimateResidentBytes(state.rows);
    for (const context of state.contextsAtBoundary.values())
      bytes += estimateResidentBytes(context);
    for (const context of state.pendingToolContexts.values())
      bytes += estimateResidentBytes(context);
    return bytes;
  }

  getItems(agentId: string): AgentTimelineItem[] {
    return this.requireState(agentId).rows.map((row) => row.item);
  }

  getRows(agentId: string): AgentTimelineRow[] {
    return this.requireState(agentId).rows.map(cloneRow);
  }

  getSubmittedUserMessage(agentId: string, clientMessageId: string): AgentTimelineRow | null {
    const row = this.requireState(agentId).rows.find(
      (candidate) =>
        candidate.item.type === "user_message" &&
        candidate.item.clientMessageId === clientMessageId,
    );
    return row ? cloneRow(row) : null;
  }

  updateSubmittedUserMessage(
    agentId: string,
    clientMessageId: string,
    update: { rewindStatus: AgentUserMessageRewindStatus; providerMessageId?: string },
  ): AgentTimelineRow | null {
    const state = this.requireState(agentId);
    const index = state.rows.findIndex(
      (candidate) =>
        candidate.item.type === "user_message" &&
        candidate.item.clientMessageId === clientMessageId,
    );
    const row = state.rows[index];
    if (!row || row.item.type !== "user_message") return null;
    const providerMessageId = row.providerMessageId ?? update.providerMessageId;
    let rewindStatus = update.rewindStatus;
    if (providerMessageId || (row.item.messageId && row.item.messageId !== clientMessageId)) {
      rewindStatus = "ready";
    } else if (row.item.rewindStatus === "unavailable") {
      rewindStatus = "unavailable";
    }
    if (row.providerMessageId === providerMessageId && row.item.rewindStatus === rewindStatus) {
      return null;
    }
    const enriched: AgentTimelineRow = {
      ...row,
      item: { ...row.item, rewindStatus },
      ...(providerMessageId ? { providerMessageId } : {}),
      contentVersion: ++state.contentVersion,
    };
    state.rows[index] = enriched;
    return cloneRow(enriched);
  }

  getEpoch(agentId: string): string {
    return this.requireState(agentId).epoch;
  }

  fetch(agentId: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    const state = this.requireState(agentId);
    const direction = options?.direction ?? "tail";
    const requestedLimit = options?.limit;
    const limit =
      requestedLimit === undefined
        ? DEFAULT_TIMELINE_FETCH_LIMIT
        : Math.max(0, Math.floor(requestedLimit));
    const cursor = options?.cursor;
    const minSeq = state.rows.length ? state.rows[0].seq : 0;
    const maxSeq = state.rows.length ? state.rows[state.rows.length - 1].seq : 0;
    const selectAll = limit === 0;

    const window = {
      minSeq,
      maxSeq,
      nextSeq: state.nextSeq,
    };

    const ctx: FetchContext = {
      state,
      direction,
      limit,
      selectAll,
      cursor,
      minSeq,
      maxSeq,
      window,
      cloneRow: options?.includeToolContextChanges ? cloneRow : cloneFetchRow,
    };

    const reset = fetchCursorReset(ctx);
    if (reset) return reset;

    if (state.rows.length === 0) {
      return {
        epoch: state.epoch,
        contentVersion: state.contentVersion,
        direction,
        reset: false,
        staleCursor: false,
        gap: false,
        window,
        hasOlder: false,
        hasNewer: false,
        rows: [],
      };
    }

    if (direction === "tail") {
      return fetchTail(ctx);
    }
    if (direction === "after") {
      return fetchAfter(ctx);
    }
    return fetchBefore(ctx);
  }

  append(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    if (item.type === "tool_call") {
      state.pendingToolContexts.set(toolContextKey(item.callId, options?.turnId), {
        callId: item.callId,
        turnId: options?.turnId,
        context: toolForkContext(item),
      });
    }
    const contextChanges: AgentToolContextChange[] = [];
    for (const [key, pending] of state.pendingToolContexts) {
      const change = createToolContextChange({
        callId: pending.callId,
        turnId: pending.turnId,
        previous: state.contextsAtBoundary.get(key),
        next: pending.context,
      });
      if (change) contextChanges.push(change);
      state.contextsAtBoundary.set(key, pending.context);
    }
    state.pendingToolContexts.clear();
    const row: AgentTimelineRow = {
      seq: state.nextSeq,
      contentVersion: ++state.contentVersion,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
      ...(contextChanges.length || item.type === "tool_call"
        ? { toolContextChanges: contextChanges }
        : {}),
    };
    state.nextSeq += 1;
    state.rows.push(row);
    return cloneRow(row);
  }

  upsertToolCall(
    agentId: string,
    item: ToolCallTimelineItem,
    options?: { timestamp?: string; providerMessageId?: string; turnId?: string },
  ): AgentTimelineRow {
    const state = this.requireState(agentId);
    const key = toolContextKey(item.callId, options?.turnId);
    const existing = state.toolCalls.get(key);
    if (existing) {
      // Provider revisions and this store's canonical revision counter are different clocks.
      // Assign the next canonical revision before merging live input; only persisted/projection
      // merges should compare incoming canonical revisions against the stored row.
      const merged = mergeToolCallItems(existing.item, {
        ...item,
        revision: (existing.item.revision ?? 0) + 1,
      });
      if (
        merged === existing.item &&
        (options?.providerMessageId === undefined ||
          options.providerMessageId === state.rows[existing.rowIndex].providerMessageId)
      ) {
        return cloneRow(state.rows[existing.rowIndex]);
      }
      existing.item = merged;
      const context = toolForkContext(existing.item);
      const committed = state.contextsAtBoundary.get(key);
      if (context.summary === committed?.summary && context.log === (committed?.log ?? "")) {
        state.pendingToolContexts.delete(key);
      } else {
        state.pendingToolContexts.set(key, {
          callId: item.callId,
          turnId: options?.turnId,
          context,
        });
      }
      const row = toolCallRow(
        {
          ...state.rows[existing.rowIndex],
          timestamp: options?.timestamp ?? new Date().toISOString(),
          contentVersion: ++state.contentVersion,
          ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
        },
        existing,
      );
      state.rows[existing.rowIndex] = row;
      return cloneRow(row);
    }

    const stored = { ...mergeToolCallItems(item, item), revision: 1 };
    const row = this.append(agentId, stored, options);
    const call = { rowIndex: state.rows.length - 1, firstSeq: row.seq, item: stored };
    state.toolCalls.set(key, call);
    state.rows[call.rowIndex] = toolCallRow(row, call);
    return row;
  }

  getLastItem(agentId: string): AgentTimelineItem | null {
    const state = this.requireState(agentId);
    return state.rows[state.rows.length - 1]?.item ?? null;
  }

  getLastAssistantMessage(agentId: string): string | null {
    const rows = this.requireState(agentId).rows;
    const chunks: string[] = [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const item = rows[i].item;
      if (item.type !== "assistant_message") {
        if (chunks.length > 0) {
          break;
        }
        continue;
      }
      chunks.push(item.text);
    }

    if (chunks.length === 0) {
      return null;
    }

    return chunks.toReversed().join("");
  }

  private requireState(agentId: string): AgentTimelineState {
    const state = this.states.get(agentId);
    if (!state) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return state;
  }

  private buildRowsFromItems(
    items: readonly AgentTimelineItem[],
    startSeq: number,
    timestamp: string,
  ): AgentTimelineRow[] {
    let nextSeq = startSeq;
    return items.map((item) => {
      const row: AgentTimelineRow = {
        seq: nextSeq,
        timestamp,
        item,
      };
      nextSeq += 1;
      return row;
    });
  }
}
