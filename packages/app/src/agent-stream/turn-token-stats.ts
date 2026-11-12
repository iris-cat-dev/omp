import type { AgentUsage } from "@omp-desktop/protocol/agent-types";

export interface TurnTokenStats {
  totalTokens: number;
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


/** Provider input/output totals remain core facts, including replay priority. */
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
  return { totalTokens };
}
