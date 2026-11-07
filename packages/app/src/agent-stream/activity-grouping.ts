import type { StreamItem } from "@/types/stream";
import { describeToolCall, hasInlineImagePreview } from "@/tool-calls/detail-level/grouping";
import { continuesTurn } from "./turn-membership";
import { isLaunchCompletionItem, type LaunchCompletionItem } from "./launch-completion";

export type AgentActivityItem =
  | Extract<StreamItem, { kind: "thought" | "tool_call" }>
  | LaunchCompletionItem;

export interface AgentActivityGroup {
  id: string;
  items: readonly AgentActivityItem[];
  isLoading: boolean;
}

export interface PreparedAgentActivityHistory {
  tail: StreamItem[];
  groupsByHostId: ReadonlyMap<string, AgentActivityGroup>;
  pendingItems: readonly AgentActivityItem[];
}

export interface AgentActivityProjection {
  tail: StreamItem[];
  head: StreamItem[];
  groupsByHostId: ReadonlyMap<string, AgentActivityGroup>;
  historyGroupUpdatesByHostId: ReadonlyMap<string, AgentActivityGroup>;
}

const EMPTY_GROUPS = new Map<string, AgentActivityGroup>();

function isAgentActivityItem(item: StreamItem): item is AgentActivityItem {
  if (item.kind === "tool_call" && hasInlineImagePreview(describeToolCall(item).detail)) {
    return false;
  }
  return item.kind === "thought" || item.kind === "tool_call" || isLaunchCompletionItem(item);
}

function isActivityRunning(item: AgentActivityItem): boolean {
  if (item.kind === "thought") {
    return item.status !== "ready";
  }
  if (item.kind === "assistant_message") return false;
  const status = describeToolCall(item).status;
  return status === "executing" || status === "running";
}

function buildGroup(items: readonly AgentActivityItem[]): AgentActivityGroup {
  const first = items[0];
  if (!first) {
    throw new Error("Cannot group an empty agent activity sequence");
  }
  return {
    id: first.id,
    items,
    isLoading: items.some(isActivityRunning),
  };
}

function appendSequence(input: {
  items: readonly AgentActivityItem[];
  output: StreamItem[];
  groups: Map<string, AgentActivityGroup>;
}): void {
  const first = input.items[0];
  if (!first) {
    return;
  }
  input.output.push(first);
  if (input.items.length > 1) {
    input.groups.set(first.id, buildGroup(input.items));
  }
}

function canAppend(previous: AgentActivityItem | undefined, next: AgentActivityItem): boolean {
  return previous === undefined || continuesTurn(previous, next);
}

export function prepareAgentActivityHistory(tail: StreamItem[]): PreparedAgentActivityHistory {
  const output: StreamItem[] = [];
  const groups = new Map<string, AgentActivityGroup>();
  let pending: AgentActivityItem[] = [];

  const flush = () => {
    appendSequence({ items: pending, output, groups });
    pending = [];
  };

  for (const item of tail) {
    if (isAgentActivityItem(item)) {
      if (!canAppend(pending.at(-1), item)) {
        flush();
      }
      pending.push(item);
      continue;
    }
    flush();
    output.push(item);
  }
  const trailingItems = pending;
  appendSequence({ items: trailingItems, output, groups });

  return {
    tail: groups.size > 0 ? output : tail,
    groupsByHostId: groups,
    pendingItems: trailingItems,
  };
}

export function projectAgentActivity(input: {
  history: PreparedAgentActivityHistory;
  head: StreamItem[];
}): AgentActivityProjection {
  const head: StreamItem[] = [];
  const liveGroups = new Map<string, AgentActivityGroup>();
  let pending = [...input.history.pendingItems];
  let hostPlacement: "history" | "head" | null = pending.length > 0 ? "history" : null;
  let pendingIncludesHead = false;

  const flush = () => {
    const first = pending[0];
    if (!first) {
      return;
    }
    if (hostPlacement === "head") {
      head.push(first);
    }
    if (pending.length > 1 && (hostPlacement === "head" || pendingIncludesHead)) {
      liveGroups.set(first.id, buildGroup(pending));
    }
    pending = [];
    hostPlacement = null;
    pendingIncludesHead = false;
  };

  for (const item of input.head) {
    if (isAgentActivityItem(item)) {
      if (!canAppend(pending.at(-1), item)) {
        flush();
      }
      if (pending.length === 0) {
        hostPlacement = "head";
      }
      pending.push(item);
      pendingIncludesHead = true;
      continue;
    }
    flush();
    head.push(item);
  }
  flush();

  if (liveGroups.size === 0) {
    return {
      tail: input.history.tail,
      head: input.head,
      groupsByHostId: input.history.groupsByHostId,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }

  const groupsByHostId = new Map(input.history.groupsByHostId);
  const historyGroupUpdatesByHostId = new Map<string, AgentActivityGroup>();
  for (const [id, group] of liveGroups) {
    groupsByHostId.set(id, group);
    if (input.history.groupsByHostId.has(id) || input.history.pendingItems[0]?.id === id) {
      historyGroupUpdatesByHostId.set(id, group);
    }
  }

  return {
    tail: input.history.tail,
    head,
    groupsByHostId,
    historyGroupUpdatesByHostId,
  };
}
