import { describe, expect, it } from "vitest";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem } from "@/types/stream";
import { placePlanPermissions } from "./plan-permission-placement";

const timestamp = new Date("2026-08-26T08:36:41.000Z");

function planItem(id: string, reviewId: string, path?: string): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp,
    payload: {
      source: "agent",
      data: {
        provider: "omp",
        callId: reviewId,
        name: "submit_plan",
        status: "completed",
        error: null,
        detail: { type: "plan", text: "# Plan body", path },
      },
    },
  };
}

function planPermission(id: string, planReviewId = id): PendingPermission {
  return {
    key: `agent-1:${id}`,
    agentId: "agent-1",
    request: {
      id,
      provider: "omp",
      name: "OmpPlanApproval",
      kind: "plan",
      metadata: { planReviewId },
      input: { plan: "# Plan body" },
    },
  };
}

describe("placePlanPermissions", () => {
  it("embeds approval by exact call id, not the closest card, its row id, path, or body", () => {
    const first = planItem("row-1", "review-1", "/plans/current.md");
    const second = planItem("review-1", "review-2", "/plans/current.md");
    const permission = planPermission("review-1");

    const placement = placePlanPermissions([first, second], [permission]);

    expect(placement.planNumberByItemId).toEqual(
      new Map([
        [first.id, 1],
        [second.id, 2],
      ]),
    );
    expect(placement.permissionByItemId).toEqual(new Map([[first.id, permission]]));
    expect(placement.embeddedPermissionKeys).toEqual(new Set([permission.key]));
    expect(placement.standalonePlanNumberByPermissionKey.size).toBe(0);
  });

  it("keeps a pending review standalone until its exact timeline row arrives", () => {
    const completed = planItem("completed", "review-1", "/plans/first.md");
    const pending = planPermission("review-2");
    const timeline = [completed];
    const before = placePlanPermissions(timeline, [pending]);

    expect(before.permissionByItemId.size).toBe(0);
    expect(before.standalonePlanNumberByPermissionKey.get(pending.key)).toBe(2);

    const row = planItem("pending", "review-2", "/plans/second.md");
    const after = placePlanPermissions([...timeline, row], [pending]);
    expect(after.planNumberByItemId.get(row.id)).toBe(2);
    expect(after.permissionByItemId.get(row.id)).toBe(pending);
    expect(after.standalonePlanNumberByPermissionKey.size).toBe(0);

    const resolved = placePlanPermissions([...timeline, row], []);
    expect(resolved.planNumberByItemId.get(row.id)).toBe(2);
    expect(resolved.permissionByItemId.size).toBe(0);
  });

  it("retains numbers outside the render window without hiding their pending actions", () => {
    const first = planItem("first", "review-1", "/plans/first.md");
    const second = planItem("second", "review-2", "/plans/second.md");
    const request = planPermission("review-1");
    const placement = placePlanPermissions([first, second], [request], new Set([second.id]));

    expect(placement.planNumberByItemId.get(second.id)).toBe(2);
    expect(placement.embeddedPermissionKeys.size).toBe(0);
    expect(placement.standalonePlanNumberByPermissionKey.get(request.key)).toBe(1);
  });

  it("ignores legacy assistant flags, pathless plan tools, and inconsistent permission ids", () => {
    const oldMessage: StreamItem = {
      kind: "assistant_message",
      id: "old-message",
      messageId: "review-1",
      presentation: "plan",
      text: "Ordinary assistant chat",
      timestamp,
    };
    const oldTool = planItem("old-tool", "review-1");
    const native = planItem("native", "review-2", "/plans/review.md");
    const request = planPermission("review-1");
    const inconsistentRequest = planPermission("wrong-id", "review-2");
    const placement = placePlanPermissions(
      [oldMessage, oldTool, native],
      [request, inconsistentRequest],
    );

    expect(placement.planNumberByItemId).toEqual(new Map([[native.id, 1]]));
    expect(placement.permissionByItemId.size).toBe(0);
    expect(placement.standalonePlanNumberByPermissionKey).toEqual(new Map([[request.key, 2]]));
  });
});
