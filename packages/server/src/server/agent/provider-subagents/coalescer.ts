import type { AgentProvider } from "../agent-sdk-types.js";
import {
  AgentStreamCoalescer,
  type AgentStreamCoalescerTimers,
} from "../agent-stream-coalescer.js";
import type { ProviderSubagentInputEvent } from "./store.js";

type TimelineEvent = Extract<ProviderSubagentInputEvent, { type: "timeline" }>;

interface ChildBuffer {
  parentAgentId: string;
  subagentId: string;
  timestamp?: string;
}

/** Coalesce before the child store assigns sequence numbers, never across parent/child pairs. */
export class ProviderSubagentCoalescer {
  private readonly children = new Map<string, ChildBuffer>();
  private readonly parents = new Map<string, Set<string>>();
  private readonly suppressed = new Set<string>();
  private readonly stream: AgentStreamCoalescer;

  constructor(
    private readonly options: {
      windowMs?: number;
      timers: AgentStreamCoalescerTimers;
      onFlush: (parentAgentId: string, provider: AgentProvider, event: TimelineEvent) => void;
    },
  ) {
    this.stream = new AgentStreamCoalescer({
      windowMs: options.windowMs,
      timers: options.timers,
      onFlush: ({ agentId: key, provider, item }) => {
        const child = this.children.get(key);
        if (!child || this.suppressed.has(key)) return;
        options.onFlush(child.parentAgentId, provider, {
          type: "timeline",
          id: child.subagentId,
          item,
          ...(child.timestamp !== undefined ? { timestamp: child.timestamp } : {}),
        });
      },
    });
  }

  handle(parentAgentId: string, provider: AgentProvider, event: TimelineEvent): void {
    const key = `${parentAgentId}\0${event.id}`;
    let child = this.children.get(key);
    if (!child) {
      child = { parentAgentId, subagentId: event.id };
      this.children.set(key, child);
      let children = this.parents.get(parentAgentId);
      if (!children) this.parents.set(parentAgentId, (children = new Set()));
      children.add(key);
    }
    child.timestamp = event.timestamp;
    if (this.stream.handle(key, { type: "timeline", provider, item: event.item })) return;
    this.stream.flushFor(key);
    this.options.onFlush(parentAgentId, provider, event);
  }

  flushChild(parentAgentId: string, subagentId: string): void {
    this.clearChild(`${parentAgentId}\0${subagentId}`, false);
  }

  clearParent(parentAgentId: string, discard = false): void {
    const keys = this.parents.get(parentAgentId);
    if (!keys) return;
    for (const key of keys) this.clearChild(key, discard);
  }

  flushAll(): void {
    this.stream.flushAll();
  }

  private clearChild(key: string, discard: boolean): void {
    const child = this.children.get(key);
    if (!child) return;
    if (discard) this.suppressed.add(key);
    try {
      this.stream.flushAndDiscard(key);
    } finally {
      this.suppressed.delete(key);
      this.children.delete(key);
      const siblings = this.parents.get(child.parentAgentId);
      siblings?.delete(key);
      if (siblings?.size === 0) this.parents.delete(child.parentAgentId);
    }
  }
}
