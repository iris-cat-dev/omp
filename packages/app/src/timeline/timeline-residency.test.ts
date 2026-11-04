import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { estimateResidentJsBytes, retainTimelineByteWindow } from "./timeline-residency";

function history(count: number): StreamItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "assistant_message", id: `row-${index}`, text: "x".repeat(2000), timestamp: new Date(0),
    timelineCursor: { epoch: "epoch", seq: index + 1 },
  }));
}

describe("timeline byte residency", () => {
  it("bounds payload bytes while preserving a reloadable cursor and content watermarks", () => {
    const items = history(40);
    const result = retainTimelineByteWindow({ items, cursor: { epoch: "epoch", startSeq: 1, endSeq: 40, contentVersion: 9 }, anchorId: "row-20", budget: 20_000 });
    expect(estimateResidentJsBytes(result.items)).toBeLessThanOrEqual(20_000);
    expect(result.items.some((item) => item.id === "row-20")).toBe(true);
    expect(result.cursor.contentVersion).toBe(9);
    expect(result.cursor.startSeq).toBeGreaterThan(1);
    expect(result.cursor.endSeq).toBeLessThan(40);
    expect(result.droppedOlder).toBe(true);
    expect(result.droppedNewer).toBe(true);
    // The discarded originals remain unchanged and can be fetched in either direction.
    expect(items).toHaveLength(40);
    expect(items[0]?.id).toBe("row-0");
  });

  it("never unloads local/unacknowledged rows or an active turn to meet a byte target", () => {
    const items = history(12);
    const local: StreamItem = { kind: "user_message", id: "local", clientMessageId: "submission", text: "pending".repeat(1000), timestamp: new Date(0) };
    items.push(local);
    const active: StreamItem = { ...history(1)[0]!, id: "active", turnId: "turn", timelineCursor: { epoch: "epoch", seq: 13 } };
    items.push(active);
    const result = retainTimelineByteWindow({ items, cursor: { epoch: "epoch", startSeq: 1, endSeq: 13 }, anchorId: "row-4", budget: 8000, pinnedTurnId: "turn" });
    expect(result.items).toContain(local);
    expect(result.items).toContain(active);
    expect(result.items.some((item) => item.id === "row-4")).toBe(true);
  });

  it("accounts for same-sequence replacement payloads rather than memoizing by item ID", () => {
    const original = history(1)[0]!;
    const replacement = { ...original, text: "x".repeat(20_000) };
    expect(estimateResidentJsBytes(replacement)).toBeGreaterThan(estimateResidentJsBytes(original));
  });

  it("pins every visible row even when the reading window exceeds the nominal budget", () => {
    const items = history(40);
    const result = retainTimelineByteWindow({ items, cursor: { epoch: "epoch", startSeq: 1, endSeq: 40 }, anchorId: "row-20", budget: 8000, pinnedIds: new Set(["row-18", "row-19", "row-20", "row-21", "row-22"]) });
    expect(result.items.map((item) => item.id)).toEqual(expect.arrayContaining(["row-18", "row-19", "row-20", "row-21", "row-22"]));
    expect(result.items.length).toBeLessThan(items.length);
  });
});
