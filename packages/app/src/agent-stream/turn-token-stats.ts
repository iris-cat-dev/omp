import type { AgentUsage } from "@omp-desktop/protocol/agent-types";

export interface TurnTokenStats {
  totalTokens: number;
  avgTokensPerSecond: number | null;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/**
 * Compact token count for the turn footer: 950 -> "950", 4600 -> "4.6k",
 * 1250000 -> "1.3M".
 */
export function formatTokenCount(count: number): string {
  const rounded = Math.max(0, Math.round(count));
  if (rounded >= 1_000_000) {
    return trimTrailingZero((rounded / 1_000_000).toFixed(1)) + "M";
  }
  if (rounded >= 1_000) {
    return trimTrailingZero((rounded / 1_000).toFixed(1)) + "k";
  }
  return String(rounded);
}

function measuredTurnRate(usage: AgentUsage | null | undefined): number | null {
  const native = usage?.nativeMetrics;
  const outputTokens = usage?.outputTokens;
  if (
    !native ||
    !Number.isSafeInteger(native.measuredDurationMs) ||
    native.measuredDurationMs < 500 ||
    !Number.isSafeInteger(native.measuredOutputTokens) ||
    native.measuredOutputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    native.measuredOutputTokens > outputTokens
  ) {
    return null;
  }
  const rate = native.measuredOutputTokens / (native.measuredDurationMs / 1_000);
  return Number.isFinite(rate) ? rate : null;
}

/**
 * Keep provider token/cache semantics unchanged. Speed is the valid own native
 * requests' Σoutput / Σduration, not the whole turn's "Worked for" duration.
 * Untimed, failed and interrupted requests can count in totals, never in speed.
 * Completed replay metadata is authoritative over retained in-flight samples.
 */
export function deriveTurnTokenStats(
  recordedUsage: AgentUsage | null | undefined,
  replayedUsage?: AgentUsage | null,
): TurnTokenStats | null {
  const usage =
    replayedUsage?.scope === "session" ? recordedUsage : (replayedUsage ?? recordedUsage);
  if (usage?.scope === "session") return null;
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  const hasInput =
    typeof inputTokens === "number" && Number.isFinite(inputTokens) && inputTokens > 0;
  const hasOutput =
    typeof outputTokens === "number" && Number.isFinite(outputTokens) && outputTokens > 0;
  if (!hasInput && !hasOutput) {
    return null;
  }
  const totalTokens =
    (hasInput ? (inputTokens as number) : 0) + (hasOutput ? (outputTokens as number) : 0);
  return { totalTokens, avgTokensPerSecond: measuredTurnRate(usage) };
}
