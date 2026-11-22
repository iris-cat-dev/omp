import type { ToolCallDetail } from "@omp-desktop/protocol/agent-types";
import type { PendingPermission } from "@/types/shared";
import type { AgentToolCallItem, StreamItem } from "@/types/stream";

export type NativePlanItem = AgentToolCallItem & {
  payload: { data: { detail: Extract<ToolCallDetail, { type: "plan" }> & { path: string } } };
};

export function isNativePlanItem(item?: StreamItem | null): item is NativePlanItem {
  if (item?.kind !== "tool_call" || item.payload.source !== "agent") {
    return false;
  }
  const { provider, detail } = item.payload.data;
  return provider === "omp" && detail.type === "plan" && Boolean(detail.path);
}

export function placePlanPermissions(
  items: readonly StreamItem[],
  pendingPermissions: readonly PendingPermission[],
  renderedItemIds?: ReadonlySet<string>,
) {
  // Items are the loaded timeline in chronological order, before render-window slicing.
  const permissionByReviewId = new Map<string, PendingPermission>();
  for (const permission of pendingPermissions) {
    const { request } = permission;
    if (
      request.provider === "omp" &&
      request.kind === "plan" &&
      request.metadata?.planReviewId === request.id
    ) {
      permissionByReviewId.set(request.id, permission);
    }
  }

  const planNumberByReviewId = new Map<string, number>();
  const planNumberByItemId = new Map<string, number>();
  const permissionByItemId = new Map<string, PendingPermission>();
  const embeddedPermissionKeys = new Set<string>();
  for (const item of items) {
    if (!isNativePlanItem(item)) continue;
    const reviewId = item.payload.data.callId;
    let number = planNumberByReviewId.get(reviewId);
    if (number === undefined) {
      number = planNumberByReviewId.size + 1;
      planNumberByReviewId.set(reviewId, number);
    }
    planNumberByItemId.set(item.id, number);

    const permission = permissionByReviewId.get(reviewId);
    if (
      permission &&
      !embeddedPermissionKeys.has(permission.key) &&
      (!renderedItemIds || renderedItemIds.has(item.id))
    ) {
      permissionByItemId.set(item.id, permission);
      embeddedPermissionKeys.add(permission.key);
    }
  }

  const standalonePlanNumberByPermissionKey = new Map<string, number>();
  for (const [reviewId, permission] of permissionByReviewId) {
    if (embeddedPermissionKeys.has(permission.key)) continue;
    let number = planNumberByReviewId.get(reviewId);
    if (number === undefined) {
      number = planNumberByReviewId.size + 1;
      planNumberByReviewId.set(reviewId, number);
    }
    standalonePlanNumberByPermissionKey.set(permission.key, number);
  }

  return {
    planNumberByItemId,
    permissionByItemId,
    embeddedPermissionKeys,
    standalonePlanNumberByPermissionKey,
  };
}
