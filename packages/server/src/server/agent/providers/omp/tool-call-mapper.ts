import type { ToolCallDetail } from "../../agent-sdk-types.js";
import { persistOmpImageOutputs } from "./image-output.js";
import {
  extractTextFromToolResult,
  mapToolDetail as mapOmpCoreToolDetail,
  resolveXdevToolCall,
  type OmpToolResult,
  type OmpTrackedToolCall,
} from "./tool-call-detail.js";

export function mapOmpToolDetail(
  toolCall: OmpTrackedToolCall,
  result: OmpToolResult,
  context?: {
    toolCallId: string;
    mapSubagentDetail?: (baseDetail: ToolCallDetail) => ToolCallDetail;
    imageOutputDir?: string;
    toolCallStatus?: "running" | "completed" | "failed";
  },
): ToolCallDetail | null {
  const dispatch = resolveXdevToolCall(toolCall, result);
  if (dispatch) {
    toolCall = dispatch.toolCall;
    result = dispatch.result;
  }
  if (toolCall.toolName === "todo") {
    return null;
  }
  if (toolCall.toolName === "task") {
    const detail = mapOmpTaskDetail(toolCall.args, result);
    return context?.mapSubagentDetail?.(detail) ?? detail;
  }
  if (toolCall.toolName === "generate_image") {
    return mapOmpImageGenerationDetail(toolCall.args, result, context);
  }
  if (toolCall.toolName === "present_image") {
    return mapOmpPresentImageDetail(toolCall.args, result, context);
  }
  if (toolCall.toolName === "edit") {
    return mapOmpEditDetail(toolCall, result);
  }
  if (toolCall.toolName === "read") {
    return mapOmpReadDetail(toolCall, result);
  }
  return mapOmpCoreToolDetail(toolCall, result);
}

export function mapOmpPresentedFiles(toolCall:OmpTrackedToolCall,result:OmpToolResult,status:string):Array<{path:string;mimeType?:string;name:string}>{
  const dispatch=resolveXdevToolCall(toolCall,result);
  const actualTool=dispatch?.toolCall??toolCall;const actualResult=dispatch?.result??result;
  if(status!=="completed"||actualTool.toolName!=="present_image")return [];
  const details=resultDetails(actualResult);const filePath=firstString(details?.filePath);
  if(firstString(details?.status)!=="published"||!filePath)return [];
  return [{path:filePath,mimeType:firstString(details?.mimeType),name:filePath.split(/[\\/]/).at(-1)??filePath}];
}

/** Only the successful sandbox wrapper emits this durable artifact contract. */
export function mapOmpGeneratedImages(toolCall: OmpTrackedToolCall, result: OmpToolResult, status: string): { generatedImagesSource?: "omp-sandbox-image"; generatedImages?: Array<{ path: string; mimeType: string; name?: string }> } {
  if (status !== "completed" || toolCall.toolName !== "generate_image" || (result && typeof result === "object" && result.isError)) return {};
  const details = resultDetails(result);
  if (details?.generatedImagesSource !== "omp-sandbox-image" || !Array.isArray(details.generatedImages) || !details.generatedImages.length) return {};
  const generatedImages: Array<{ path: string; mimeType: string; name?: string }> = [];
  for (const image of details.generatedImages) {
    if (!isRecord(image) || typeof image.path !== "string" || !/^\.qqbot-media\/generated\/[a-f0-9-]+\.(png|jpg|webp|gif)$/.test(image.path) || typeof image.mimeType !== "string" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) return {};
    generatedImages.push({ path: image.path, mimeType: image.mimeType, ...(typeof image.name === "string" ? { name: image.name } : {}) });
  }
  return { generatedImagesSource: "omp-sandbox-image", generatedImages };
}

function mapOmpImageGenerationDetail(
  args: unknown,
  result: OmpToolResult,
  context?: { imageOutputDir?: string; toolCallStatus?: "running" | "completed" | "failed" },
): ToolCallDetail {
  const argRecord = isRecord(args) ? args : {};
  const details = resultDetails(result);
  // Match native prompt assembly, without exposing reference image data in the card.
  const subject = [argRecord.subject, argRecord.action, argRecord.scene]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(", ");
  const parts = [subject, argRecord.composition, argRecord.lighting, argRecord.style].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  let prompt = parts.length
    ? `${parts.map((part) => part.replace(/[.!,;:]+$/, "")).join(". ")}.`
    : undefined;
  if (firstString(argRecord.text)) {
    prompt = `${prompt ?? ""}\n\nText: ${argRecord.text}`.trim();
  }
  const changes = Array.isArray(argRecord.changes)
    ? argRecord.changes.filter((value): value is string => typeof value === "string")
    : [];
  if (changes.length) {
    prompt =
      `${prompt ?? ""}\n\nChanges:\n${changes.map((change) => `- ${change}`).join("\n")}`.trim();
  }
  const referenceCount = Array.isArray(argRecord.input) ? argRecord.input.length : 0;
  const referenceText = referenceCount
    ? `${referenceCount} reference image${referenceCount === 1 ? "" : "s"}`
    : undefined;
  const model = firstString(details?.model, argRecord.model);
  const provider = firstString(details?.provider);
  const metadata = [
    model ? `Model: ${provider ? `${provider}/` : ""}${model}` : undefined,
    referenceText ? `${result ? "Used" : "Using"} ${referenceText}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const failed =
    context?.toolCallStatus === "failed" ||
    (result !== null && typeof result !== "string" && result.isError === true);
  const outputs = failed
    ? []
    : persistOmpImageOutputs(details?.images, details?.imagePaths, context?.imageOutputDir);
  const primary = outputs[0];
  const sandboxImages = mapOmpGeneratedImages({ kind: "unknown", toolName: "generate_image", args }, result, context?.toolCallStatus ?? (failed ? "failed" : result ? "completed" : "running")).generatedImages ?? [];
  const reportedCount =
    typeof details?.imageCount === "number" && Number.isFinite(details.imageCount)
      ? Math.max(0, Math.floor(details.imageCount))
      : 0;
  const expectedCount = Math.max(
    reportedCount,
    Array.isArray(details?.images) ? details.images.length : 0,
    Array.isArray(details?.imagePaths) ? details.imagePaths.length : 0,
  );
  const pending =
    !failed &&
    !primary &&
    (context?.toolCallStatus === "running" ||
      (result === null && context?.toolCallStatus !== "completed"));
  const resultText = extractTextFromToolResult(result);
  let statusText: string | undefined;
  if (primary) {
    statusText =
      outputs.length === 1 && expectedCount <= 1
        ? `Saved to ${primary.filePath}`
        : `Previewing image ${primary.index + 1} of ${expectedCount || outputs.length}\n${outputs.map((output) => `Image ${output.index + 1}: ${output.filePath}`).join("\n")}`;
    if (expectedCount > outputs.length) {
      statusText += `\n${expectedCount - outputs.length} image(s) unavailable`;
    }
  } else if (failed) {
    statusText = resultText ?? "Image generation failed.";
  } else if (pending) {
    statusText = resultText ?? prompt;
  } else if (sandboxImages.length) {
    statusText = sandboxImages.map(image => `Saved to ${image.path}`).join("\n");
  } else {
    statusText =
      expectedCount > 0
        ? "Generated image data is unavailable for preview."
        : (resultText ?? "No image data returned.");
  }
  return {
    type: "plain_text",
    label: failed
      ? "Image generation failed"
      : primary || sandboxImages.length
        ? outputs.length > 1 || sandboxImages.length > 1
          ? "Generated images"
          : "Generated image"
        : pending
          ? "Generating image"
          : "No image available",
    text: [statusText, metadata || undefined].filter(Boolean).join(" · ") || undefined,
    icon: "sparkles",
    ...(primary
      ? {
          preview: {
            type: "image",
            source: primary.filePath,
            mimeType: primary.mimeType,
            ...(prompt ? { alt: prompt } : {}),
          },
        }
      : {}),
  };
}

function mapOmpPresentImageDetail(
  args: unknown,
  result: OmpToolResult,
  context?: { imageOutputDir?: string },
): ToolCallDetail {
  const argRecord = isRecord(args) ? args : {};
  const details = resultDetails(result);
  const filePath = firstString(details?.filePath);
  const alt = firstString(details?.alt, argRecord.alt);
  const published = firstString(details?.status) === "published" && filePath !== undefined;
  const image =
    published && context?.imageOutputDir
      ? persistOmpImageOutputs(undefined, [filePath], context.imageOutputDir)[0]
      : undefined;
  const mimeType = firstString(image?.mimeType, details?.mimeType);
  return {
    type: "plain_text",
    label: published ? "Presented image" : "Presenting image",
    text: published ? `Published ${filePath}` : firstString(argRecord.path, argRecord.alt),
    icon: "sparkles",
    ...(published && filePath
      ? {
          preview: {
            type: "image",
            source: image?.filePath ?? filePath,
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
