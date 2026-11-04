import type { StreamItem } from "@/types/stream";
import type { AgentTimelineCursorState } from "@/stores/session-store";

export const TIMELINE_RESIDENCY_BUDGET = {
  visibleJsBytes: 24 * 1024 * 1024,
  backgroundJsBytes: 32 * 1024 * 1024,
  imageEncodedBytes: 12 * 1024 * 1024,
  imageDecodedBytes: 24 * 1024 * 1024,
} as const;

const objectBytes = new WeakMap<object, number>();

/** Conservative UTF-16 plus object/array storage, without constructing JSON copies. */
export function estimateResidentJsBytes(value: unknown): number {
  if (typeof value === "string") return 24 + value.length * 2;
  if (typeof value !== "object" || value === null) return 8;
  const cached = objectBytes.get(value);
  if (cached !== undefined) return cached;
  if (value instanceof Date) return 32;
  let bytes = 48;
  if (Array.isArray(value)) {
    for (const child of value) bytes += 8 + estimateResidentJsBytes(child);
  } else {
    for (const [key, child] of Object.entries(value)) {
      bytes += key.length * 2 + 16 + estimateResidentJsBytes(child);
    }
  }
  objectBytes.set(value, bytes);
  return bytes;
}

export function isNonReloadableStreamItem(item: StreamItem): boolean {
  return (
    !item.timelineCursor ||
    (item.kind === "thought" && item.status === "loading") ||
    (item.kind === "tool_call" &&
      (item.payload.data.status === "running" || item.payload.data.status === "executing"))
  );
}

export function retainTimelineByteWindow(input: {
  items: StreamItem[];
  cursor: AgentTimelineCursorState;
  anchorId: string | null;
  budget: number;
  pinnedTurnId?: string | null;
  pinnedIds?: ReadonlySet<string>;
}): {
  items: StreamItem[];
  cursor: AgentTimelineCursorState;
  droppedOlder: boolean;
  droppedNewer: boolean;
} {
  const { items, cursor, budget } = input;
  if (estimateResidentJsBytes(items) <= budget) {
    return { items, cursor, droppedOlder: false, droppedNewer: false };
  }
  const anchorIndex = input.anchorId ? items.findIndex((item) => item.id === input.anchorId) : -1;
  const anchor = anchorIndex >= 0 ? anchorIndex : Math.max(0, items.length - 1);
  // Keep a contiguous reading window. Rows beyond it remain on the daemon, not in JS.
  let start = anchor;
  let end = anchor;
  let bytes = estimateResidentJsBytes(items[anchor]);
  while (start > 0 || end < items.length - 1) {
    const left = start > 0 ? estimateResidentJsBytes(items[start - 1]) : Infinity;
    const right = end < items.length - 1 ? estimateResidentJsBytes(items[end + 1]) : Infinity;
    const preferRight = end - anchor < anchor - start;
    const next = preferRight ? right : left;
    const alternate = preferRight ? left : right;
    if (bytes + Math.min(next, alternate) > budget) break;
    if (bytes + next <= budget) {
      if (preferRight) end += 1;
      else start -= 1;
      bytes += next;
    } else {
      if (preferRight) start -= 1;
      else end += 1;
      bytes += alternate;
    }
  }
  // Unacknowledged/local rows and the current turn are never evicted. They may
  // legitimately exceed a budget and are separately visible in residency stats.
  const keep = (item: StreamItem, index: number) =>
    (index >= start && index <= end) ||
    input.pinnedIds?.has(item.id) === true ||
    isNonReloadableStreamItem(item) ||
    Boolean(input.pinnedTurnId && "turnId" in item && item.turnId === input.pinnedTurnId);
  const next = items.filter(keep);
  if (next.length === items.length) {
    return { items, cursor, droppedOlder: false, droppedNewer: false };
  }
  const known = [
    { startSeq: cursor.startSeq, endSeq: cursor.endSeq },
    ...(cursor.retainedRanges ?? []),
  ].sort((a, b) => a.startSeq - b.startSeq);
  const ranges: Array<{ startSeq: number; endSeq: number; hasOlder?: boolean }> = [];
  // A row's cursor is its canonical end sequence. Preserve the original coverage
  // before that row only when the preceding row was retained as well.
  for (const range of known) {
    let previousEnd = range.startSeq - 1;
    let previousKept = true;
    for (let index = 0; index < items.length; index += 1) {
      const position = items[index]!.timelineCursor;
      if (!position || position.epoch !== cursor.epoch || position.seq < range.startSeq || position.seq > range.endSeq) continue;
      const retained = keep(items[index]!, index);
      if (retained) {
        const rowStart = previousKept ? previousEnd + 1 : position.seq;
        const last = ranges[ranges.length - 1];
        if (last && last.endSeq + 1 >= rowStart) last.endSeq = position.seq;
        else ranges.push({ startSeq: rowStart, endSeq: position.seq, hasOlder: true });
      }
      previousEnd = position.seq;
      previousKept = retained;
    }
  }
  const primary = ranges.pop();
  if (!primary) return { items, cursor, droppedOlder: false, droppedNewer: false };
  return {
    items: next,
    cursor: {
      ...cursor,
      startSeq: primary.startSeq,
      endSeq: primary.endSeq,
      retainedRanges: ranges.length ? ranges : undefined,
    },
    droppedOlder: next[0] !== items[0],
    droppedNewer: primary.endSeq < cursor.endSeq,
  };
}
