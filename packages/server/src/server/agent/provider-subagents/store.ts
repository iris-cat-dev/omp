import type { AgentProvider, AgentTimelineItem } from "../agent-sdk-types.js";
import { limitAgentTimelineItemContent } from "../agent-timeline-content.js";
import { InMemoryAgentTimelineStore } from "../agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../agent-timeline-store-types.js";
import { selectTimelineWindowByProjectedLimit } from "../timeline-projection.js";

export type ProviderSubagentStatus = "running" | "completed" | "failed" | "canceled";

export interface ProviderSubagentDescriptor {
  id: string;
  parentAgentId: string;
  provider: AgentProvider;
  title: string | null;
  description: string | null;
  model: string | null;
  status: ProviderSubagentStatus;
  createdAt: string;
  updatedAt: string;
  toolCallId: string | null;
  cwd: string | null;
  subtitle: string | null;
}

export type ProviderSubagentInputEvent =
  | {
      type: "upsert";
      id: string;
      title?: string | null;
      description?: string | null;
      model?: string | null;
      /**
       * Omit to keep the stored status. A presentation-only upsert says nothing about whether the
       * child is still running, and must not revert a finished one.
       */
      status?: ProviderSubagentStatus;
      toolCallId?: string | null;
      cwd?: string | null;
      subtitle?: string | null;
      timestamp?: string;
    }
  | {
      type: "timeline";
      id: string;
      item: AgentTimelineItem;
      timestamp?: string;
    }
  | { type: "remove"; id: string };

export type ProviderSubagentStoreEvent =
  | { type: "upsert"; subagent: ProviderSubagentDescriptor }
  | {
      type: "timeline";
      parentAgentId: string;
      subagentId: string;
      provider: AgentProvider;
      row: AgentTimelineRow;
      epoch: string;
    }
  | { type: "remove"; parentAgentId: string; subagentId: string };

function storeKey(parentAgentId: string, subagentId: string): string {
  return `${parentAgentId}\0${subagentId}`;
}

/**
 * Sticky upsert semantics for a descriptor field: an omitted value preserves what is stored, an
 * explicit `null` clears it. Providers observe these fields incrementally, so a partial upsert
 * must never blank fields it says nothing about.
 */
function stickyField<T>(next: T | undefined, previous: T | null | undefined): T | null {
  return next === undefined ? (previous ?? null) : next;
}

export class ProviderSubagentStore {
  private readonly descriptors = new Map<string, ProviderSubagentDescriptor>();
  private readonly timelines = new InMemoryAgentTimelineStore();
  private readonly childrenByParent = new Map<string, Set<string>>();

  constructor(private readonly epochPrefix?: string) {}

  apply(
    parentAgentId: string,
    provider: AgentProvider,
    event: ProviderSubagentInputEvent,
  ): ProviderSubagentStoreEvent | null {
    const key = storeKey(parentAgentId, event.id);
    if (event.type === "remove") {
      this.descriptors.delete(key);
      this.timelines.delete(key);
      const children = this.childrenByParent.get(parentAgentId);
      children?.delete(event.id);
      if (children?.size === 0) this.childrenByParent.delete(parentAgentId);
      return { type: "remove", parentAgentId, subagentId: event.id };
    }
    let children = this.childrenByParent.get(parentAgentId);
    if (!children) this.childrenByParent.set(parentAgentId, (children = new Set()));
    children.add(event.id);

    if (event.type === "timeline") {
      if (!this.timelines.has(key)) {
        this.timelines.initialize(
          key,
          this.epochPrefix ? { epoch: `${this.epochPrefix}:${key}` } : undefined,
        );
      }
      const item = limitAgentTimelineItemContent(event.item);
      const row =
        item.type === "tool_call"
          ? this.timelines.upsertToolCall(key, item, { timestamp: event.timestamp })
          : this.timelines.append(key, item, { timestamp: event.timestamp });
      return {
        type: "timeline",
        parentAgentId,
        subagentId: event.id,
        provider,
        row,
        epoch: this.timelines.getEpoch(key),
      };
    }

    const previous = this.descriptors.get(key);
    if (!this.timelines.has(key)) {
      this.timelines.initialize(
        key,
        this.epochPrefix ? { epoch: `${this.epochPrefix}:${key}` } : undefined,
      );
    }
    const timestamp = event.timestamp ?? new Date().toISOString();
    const subagent: ProviderSubagentDescriptor = {
      id: event.id,
      parentAgentId,
      provider,
      title: stickyField(event.title, previous?.title),
      description: stickyField(event.description, previous?.description),
      model: stickyField(event.model, previous?.model),
      status: event.status ?? previous?.status ?? "running",
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
      toolCallId: stickyField(event.toolCallId, previous?.toolCallId),
      cwd: stickyField(event.cwd, previous?.cwd),
      subtitle: stickyField(event.subtitle, previous?.subtitle),
    };
    if (
      previous &&
      previous.provider === subagent.provider &&
      previous.title === subagent.title &&
      previous.description === subagent.description &&
      previous.model === subagent.model &&
      previous.status === subagent.status &&
      previous.toolCallId === subagent.toolCallId &&
      previous.cwd === subagent.cwd &&
      previous.subtitle === subagent.subtitle
    ) {
      return null;
    }
    this.descriptors.set(key, subagent);
    return { type: "upsert", subagent };
  }

  list(parentAgentId: string): ProviderSubagentDescriptor[] {
    return [...this.descriptors.values()]
      .filter((subagent) => subagent.parentAgentId === parentAgentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listAll(): ProviderSubagentDescriptor[] {
    return [...this.descriptors.values()];
  }

  get(parentAgentId: string, subagentId: string): ProviderSubagentDescriptor | null {
    return this.descriptors.get(storeKey(parentAgentId, subagentId)) ?? null;
  }

  fetchTimeline(
    parentAgentId: string,
    subagentId: string,
    options?: AgentTimelineFetchOptions,
  ): AgentTimelineFetchResult {
    const direction = options?.direction ?? "tail";
    const limit = options?.limit === undefined ? 200 : Math.max(0, Math.floor(options.limit));
    const key = storeKey(parentAgentId, subagentId);
    const timeline = this.timelines.fetch(key, { ...options, limit });
    if (limit === 0) return timeline;
    const fullRows = this.timelines.fetch(key, { direction: "tail", limit: 0 }).rows;
    const eligible =
      timeline.reset || direction === "tail"
        ? fullRows
        : fullRows.filter((row) =>
            direction === "after"
              ? row.seq > (options?.cursor?.seq ?? 0)
              : row.seq < (options?.cursor?.seq ?? timeline.window.nextSeq),
          );
    if (eligible.length === 0) return timeline;
    const selected = selectTimelineWindowByProjectedLimit({
      rows: eligible,
      direction: timeline.reset ? "tail" : direction,
      limit,
    });
    const firstRow = selected.selectedRows[0];
    const lastRow = selected.selectedRows[selected.selectedRows.length - 1];
    return {
      ...timeline,
      rows: selected.selectedRows,
      hasOlder: firstRow !== undefined && firstRow.seq > timeline.window.minSeq,
      hasNewer: lastRow !== undefined && lastRow.seq < timeline.window.maxSeq,
    };
  }

  deleteParent(parentAgentId: string): ProviderSubagentStoreEvent[] {
    const events: ProviderSubagentStoreEvent[] = [];
    for (const subagentId of this.childrenByParent.get(parentAgentId) ?? []) {
      const key = storeKey(parentAgentId, subagentId);
      this.descriptors.delete(key);
      this.timelines.delete(key);
      events.push({ type: "remove", parentAgentId, subagentId });
    }
    this.childrenByParent.delete(parentAgentId);
    return events;
  }
}
