import { Buffer } from "node:buffer";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

const TOOL_CALL_CONTENT_MAX_LENGTH = 64 * 1024;

function copyLimitedContent(content: string): string {
  // A V8 sliced string can otherwise keep the entire oversized output alive.
  // UTF-16 preserves the exact code units, including a surrogate at the boundary.
  return Buffer.from(content.slice(0, TOOL_CALL_CONTENT_MAX_LENGTH), "utf16le").toString("utf16le");
}

function limitFailedShellError(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    item.status !== "failed" ||
    typeof item.error !== "object" ||
    item.error === null ||
    !("content" in item.error) ||
    typeof item.error.content !== "string" ||
    item.error.content.length <= TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    return item;
  }
  return {
    ...item,
    error: {
      ...item.error,
      content: copyLimitedContent(item.error.content),
    },
  };
}

function limitPlainText(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "plain_text" ||
    typeof item.detail.text !== "string" ||
    item.detail.text.length <= TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    return item;
  }
  return {
    ...item,
    detail: {
      ...item.detail,
      text: copyLimitedContent(item.detail.text),
    },
  };
}

export function limitAgentTimelineItemContent(item: AgentTimelineItem): AgentTimelineItem {
  item = limitFailedShellError(item);
  item = limitPlainText(item);
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    typeof item.detail.output !== "string"
  ) {
    return item;
  }
  if (item.detail.output.length <= TOOL_CALL_CONTENT_MAX_LENGTH) {
    return item;
  }
  return {
    ...item,
    detail: {
      ...item.detail,
      output: copyLimitedContent(item.detail.output),
    },
  };
}
