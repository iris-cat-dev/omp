import type { ComponentType } from "react";
import type { TFunction } from "i18next";
import type { ShellExecution, ToolCallDetail } from "@omp-desktop/protocol/agent-types";
import type { ToolCallDisplayInput } from "@/utils/tool-call-display";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";
import { extractToolCallFilePath } from "@/utils/extract-tool-call-file-path";
import { parseInlinePathToken, type InlinePathTarget } from "@/assistant-file-links";
import {
  hasMeaningfulToolCallDetail,
  isPendingToolCallDetail,
} from "@/utils/tool-call-detail-state";

type ToolCallStatus = "executing" | "running" | "completed" | "failed" | "canceled";
export type ToolCallPresentationIcon = ComponentType<{ size?: number; color?: string }>;

interface BuildToolCallPresentationInput {
  toolName: string;
  status: ToolCallStatus;
  error: unknown;
  detail?: ToolCallDetail;
  cwd?: string;
  metadata?: Record<string, unknown>;
  resolveIcon: ToolCallIconResolver;
  t: TFunction;
}

export interface ToolCallPresentation {
  displayName: string;
  summary?: string;
  errorText?: string;
  icon: ToolCallPresentationIcon;
  isLoadingDetails: boolean;
  hasDetails: boolean;
  canOpenDetails: boolean;
  openFileTarget: InlinePathTarget | null;
  isPlan: boolean;
}

export type ToolCallIconResolver = (
  toolName: string,
  detail: ToolCallDetail | undefined,
) => ToolCallPresentationIcon;

function displayStatus(status: ToolCallStatus): ToolCallDisplayInput["status"] {
  return status === "executing" ? "running" : status;
}

function displayDetail(detail: ToolCallDetail | undefined): ToolCallDetail {
  return detail ?? { type: "unknown", input: null, output: null };
}

function shellSummaryState(input: BuildToolCallPresentationInput, execution: ShellExecution) {
  if (input.status === "canceled" || execution.termination === "canceled") return "canceled";
  if (input.status === "failed") return "fail";
  if (input.status === "completed" && execution.state === "running") return "ok";
  return execution.state;
}

function buildShellSummary(input: BuildToolCallPresentationInput): string | undefined {
  if (input.detail?.type !== "shell" || !input.detail.execution) return undefined;
  const execution = input.detail.execution;
  const state = shellSummaryState(input, execution);
  const progress = execution.progress;
  let measured: string | undefined;
  if (progress?.kind === "percentage") measured = `${progress.percentage}%`;
  else if (progress) measured = `${progress.completed}/${progress.total}`;
  const current = execution.steps.find((step) => step.id === execution.currentStepId);
  const stateKey =
    execution.termination === "timed_out" && state !== "canceled"
      ? "toolCallDetails.shell.timedOut"
      : `toolCallDetails.shell.${state}`;
  return [input.t(stateKey), measured, progress?.label || current?.command]
    .filter(Boolean)
    .join(" · ");
}

export function buildToolCallPresentation(
  input: BuildToolCallPresentationInput,
): ToolCallPresentation {
  const detailForDisplay = displayDetail(input.detail);
  const displayModel = buildToolCallDisplayModel({
    name: input.toolName,
    status: displayStatus(input.status),
    error: input.error ?? null,
    detail: detailForDisplay,
    metadata: input.metadata,
    cwd: input.cwd,
  });
  const isLoadingDetails = isPendingToolCallDetail({
    detail: input.detail,
    status: input.status,
    error: input.error,
  });
  const hasDetails = Boolean(input.error) || hasMeaningfulToolCallDetail(input.detail);
  const isImageTool = input.toolName === "generate_image" || input.toolName === "present_image";
  const openFilePath = extractToolCallFilePath(input.detail);
  const openFileTarget = openFilePath
    ? (parseInlinePathToken(openFilePath) ?? { raw: openFilePath, path: openFilePath })
    : null;

  const summary = buildShellSummary(input) ?? (isImageTool ? undefined : displayModel.summary);

  return {
    displayName: isImageTool
      ? input.t(
          input.toolName === "generate_image"
            ? "toolCallDetails.generateImage"
            : "toolCallDetails.presentImage",
        )
      : displayModel.displayName,
    summary,
    errorText: displayModel.errorText,
    icon: input.resolveIcon(input.toolName, input.detail),
    isLoadingDetails,
    hasDetails,
    canOpenDetails: hasDetails || isLoadingDetails,
    openFileTarget,
    isPlan: input.detail?.type === "plan",
  };
}
