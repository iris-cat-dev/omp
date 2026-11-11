import { AgentTimelineItemPayloadSchema, type AgentAttachment } from "@omp-desktop/protocol/messages";
import type { AgentPromptInput, AgentTimelineItem } from "../../agent-sdk-types.js";

export const LOCAL_SUBMISSION_ANNOTATION = "desktop-local-submission";
type LocalSubmissionItem = Extract<AgentTimelineItem, { type: "user_message" }>;

export function captureLocalSubmission(prompt: AgentPromptInput, clientMessageId: string | null): LocalSubmissionItem {
  if (typeof prompt === "string") return { type: "user_message", text: prompt, rewindStatus: "unavailable", ...(clientMessageId ? { clientMessageId } : {}) };
  const text: string[] = [];
  let images: LocalSubmissionItem["images"];
  let attachments: AgentAttachment[] | undefined;
  for (const block of prompt) {
    if (block.type === "image") (images ??= []).push({ data: block.data, mimeType: block.mimeType });
    else if (block.type === "text" && !("mimeType" in block)) text.push(block.text);
    else (attachments ??= []).push(block as AgentAttachment);
  }
  return { type: "user_message", text: text.join("\n").trim(), rewindStatus: "unavailable", ...(clientMessageId ? { clientMessageId } : {}), ...(images ? { images } : {}), ...(attachments ? { attachments } : {}) };
}

export function readLocalSubmission(entry: { type?: string; customType?: unknown; data?: unknown }): LocalSubmissionItem | null {
  if (entry.type !== "custom" || entry.customType !== LOCAL_SUBMISSION_ANNOTATION) return null;
  const item = AgentTimelineItemPayloadSchema.parse(entry.data);
  if (item.type !== "user_message") throw new Error("A local submission annotation must contain a user message");
  return { ...item, rewindStatus: "unavailable" };
}
