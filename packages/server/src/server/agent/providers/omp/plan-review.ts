import type { ToolCallTimelineItem } from "@omp-desktop/protocol/agent-types";
import { OmpPlanReviewSchema, type OmpPlanReview } from "./rpc-types.js";

export function readOmpPlanReview(entry: {
  type?: string;
  customType?: unknown;
  data?: unknown;
}): OmpPlanReview | undefined {
  if (entry.type !== "custom" || entry.customType !== "desktop-plan-review") return undefined;
  return OmpPlanReviewSchema.parse(entry.data);
}

export function mapOmpPlanReview(review: OmpPlanReview): ToolCallTimelineItem {
  return {
    type: "tool_call",
    callId: review.id,
    name: "plan",
    status: "completed",
    error: null,
    detail: { type: "plan", text: review.markdown, title: review.title, path: review.path },
  };
}
