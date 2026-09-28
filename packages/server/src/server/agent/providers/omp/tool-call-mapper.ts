import type { ToolCallDetail } from "../../agent-sdk-types.js";
import {
  extractTextFromToolResult,
  mapToolDetail as mapOmpCoreToolDetail,
  type OmpToolResult,
  type OmpTrackedToolCall,
} from "./tool-call-detail.js";

export function mapOmpToolDetail(
  toolCall: OmpTrackedToolCall,
  result: OmpToolResult,
  context?: {
    toolCallId: string;
    mapSubagentDetail?: (baseDetail: ToolCallDetail) => ToolCallDetail;
  },
): ToolCallDetail | null {
  if (toolCall.toolName === "todo") {
    return null;
  }
  if (toolCall.toolName === "task") {
    const detail = mapOmpTaskDetail(toolCall.args, result);
    return context?.mapSubagentDetail?.(detail) ?? detail;
  }
  if (toolCall.toolName === "image_gen") {
    return mapOmpImageGenerationDetail(toolCall.args, result);
  }
  if (toolCall.toolName === "present_image") {
    return mapOmpPresentImageDetail(toolCall.args, result);
  }
  if (toolCall.toolName === "edit") {
    return mapOmpEditDetail(toolCall, result);
  }
  if (toolCall.toolName === "read") {
    return mapOmpReadDetail(toolCall, result);
  }
  return mapOmpCoreToolDetail(toolCall, result);
}

interface ImageGenerationStatusTextInput {
  filePath: string | undefined;
  prompt: string | undefined;
  elapsedText: string | null;
  referenceText: string | null;
}

function formatImageGenerationElapsed(seconds: number | null): string | null {
  if (seconds === null) {
    return null;
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function imageGenerationStatusText(input: ImageGenerationStatusTextInput): string | undefined {
  if (input.filePath) {
    return input.referenceText
      ? `Saved to ${input.filePath} · Used ${input.referenceText}`
      : `Saved to ${input.filePath}`;
  }
  if (input.elapsedText) {
    return `Waiting for the image provider · ${input.elapsedText} elapsed`;
  }
  if (input.referenceText) {
    return `${input.prompt ?? "Generating image"} · Using ${input.referenceText}`;
  }
  return input.prompt;
}

function mapOmpImageGenerationDetail(args: unknown, result: OmpToolResult): ToolCallDetail {
  const argRecord = isRecord(args) ? args : {};
  const details = resultDetails(result);
  const prompt = firstString(details?.prompt, argRecord.prompt);
  const filePath = firstString(details?.filePath);
  const mimeType = firstString(details?.mimeType);
  const referenceImageCount = Array.isArray(argRecord.referenceImagePaths)
    ? argRecord.referenceImagePaths.length
    : 0;
  const referenceText =
    referenceImageCount === 0
      ? null
      : `${referenceImageCount} reference image${referenceImageCount === 1 ? "" : "s"}`;
  const elapsedSeconds =
    typeof details?.elapsedSeconds === "number" &&
    Number.isFinite(details.elapsedSeconds) &&
    details.elapsedSeconds >= 0
      ? Math.floor(details.elapsedSeconds)
      : null;
  const elapsedText = formatImageGenerationElapsed(elapsedSeconds);
  return {
    type: "plain_text",
    label: filePath ? "Generated image" : "Generating image",
    text: imageGenerationStatusText({ filePath, prompt, elapsedText, referenceText }),
    icon: "sparkles",
    ...(filePath
      ? {
          preview: {
            type: "image",
            source: filePath,
            ...(mimeType ? { mimeType } : {}),
            ...(prompt ? { alt: prompt } : {}),
          },
        }
      : {}),
  };
}

function mapOmpPresentImageDetail(args: unknown, result: OmpToolResult): ToolCallDetail {
  const argRecord = isRecord(args) ? args : {};
  const details = resultDetails(result);
  const filePath = firstString(details?.filePath);
  const mimeType = firstString(details?.mimeType);
  const alt = firstString(details?.alt, argRecord.alt);
  const published = firstString(details?.status) === "published" && filePath !== undefined;
  return {
    type: "plain_text",
    label: published ? "Presented image" : "Presenting image",
    text: published ? `Published ${filePath}` : firstString(argRecord.path, argRecord.alt),
    icon: "sparkles",
    ...(published && filePath
      ? {
          preview: {
            type: "image",
            source: filePath,
            ...(mimeType ? { mimeType } : {}),
            ...(alt ? { alt } : {}),
          },
        }
      : {}),
  };
}

function mapOmpTaskDetail(args: unknown, result: OmpToolResult): ToolCallDetail {
  const argRecord = isRecord(args) ? args : {};
  const resultText = extractTextFromToolResult(result);
  const childSessionId = readChildSessionId(result);
  return {
    type: "sub_agent",
    subAgentType: firstString(
      argRecord.agent,
      argRecord.subAgentType,
      argRecord.agentType,
      argRecord.type,
    ),
    description: firstString(
      argRecord.description,
      argRecord.task,
      argRecord.prompt,
      argRecord.assignment,
    ),
    ...(childSessionId ? { childSessionId } : {}),
    log: resultText?.trim() ?? "",
  };
}

function mapOmpEditDetail(
  toolCall: OmpTrackedToolCall,
  result: OmpToolResult,
): ToolCallDetail | null {
  const fallback = mapOmpCoreToolDetail(toolCall, result);
  const details = resultDetails(result);
  const filePath =
    firstString(details?.path, details?.filePath) ?? readPatchInputPath(toolCall.args);
  if (!filePath) {
    return fallback;
  }
  return {
    type: "edit",
    filePath,
    oldString: firstString(details?.oldText, details?.old_string),
    newString: firstString(details?.newText, details?.new_string),
    unifiedDiff: firstString(details?.diff),
  };
}

function mapOmpReadDetail(
  toolCall: OmpTrackedToolCall,
  result: OmpToolResult,
): ToolCallDetail | null {
  const fallback = mapOmpCoreToolDetail(toolCall, result);
  if (!fallback || fallback.type !== "read") {
    return fallback;
  }
  const details = resultDetails(result);
  const displayContent = isRecord(details?.displayContent) ? details.displayContent : null;
  const displayText = firstString(displayContent?.text);
  if (!displayText) {
    return fallback;
  }
  return {
    ...fallback,
    content: displayText,
  };
}

function resultDetails(result: OmpToolResult): Record<string, unknown> | null {
  if (typeof result === "string" || result === null) {
    return null;
  }
  return isRecord(result.details) ? result.details : null;
}

function readChildSessionId(result: OmpToolResult): string | undefined {
  const details = resultDetails(result);
  const direct = firstString(details?.sessionFile, details?.session_file, details?.childSessionId);
  if (direct) {
    return direct;
  }
  const text = extractTextFromToolResult(result);
  return text?.match(/(?:session|transcript)(?: file)?:\s*(?<path>\/\S+\.jsonl)/i)?.groups?.path;
}

function readPatchInputPath(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const input = args.input;
  if (typeof input !== "string") {
    return undefined;
  }
  const match = /^\[(?<path>.+?)#[^\]\n]+]/m.exec(input);
  return match?.groups?.path;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
