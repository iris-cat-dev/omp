import type { AgentUsage } from "@omp-desktop/protocol/agent-types";

/** Completed replay is authoritative; session aggregates never describe this turn. */
export function calculateCompletedOutputRate(
  recordedUsage: AgentUsage | null | undefined,
  replayedUsage?: AgentUsage | null,
): number | null {
  const usage = replayedUsage?.scope === "session" ? recordedUsage : (replayedUsage ?? recordedUsage);
  if (usage?.scope === "session") return null;
  return measuredTurnRate(usage);
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
