import type { AgentUsage } from "@omp-desktop/protocol/agent-types";
import type { Theme } from "@/styles/theme";

export interface ContextWindowReading {
  used: number;
  max: number;
  percentage: number;
}

export function getContextWindowReading(usage: AgentUsage): ContextWindowReading | null {
  const { contextWindowUsedTokens: used, contextWindowMaxTokens: max } = usage;
  if (
    max === undefined ||
    !Number.isFinite(max) ||
    max <= 0 ||
    used === undefined ||
    !Number.isFinite(used) ||
    used < 0
  )
    return null;
  return { used, max, percentage: (used / max) * 100 };
}

export function getContextProgressColor(percentage: number, theme: Theme): string {
  if (percentage > 90) return theme.colors.destructive;
  if (percentage >= 70) return theme.colors.palette.amber[500];
  return theme.colors.foregroundMuted;
}

export function hasSessionCache(usage: AgentUsage): boolean {
  return (
    usage.scope === "session" &&
    (usage.cachedInputTokens !== undefined || usage.cacheWriteTokens !== undefined)
  );
}

export function getCacheHitRatio(
  uncached: number | undefined,
  read: number | undefined,
  written: number | undefined,
): number | null {
  if (uncached === undefined || read === undefined || written === undefined) return null;
  const promptTokens = uncached + read + written;
  return promptTokens > 0 ? read / promptTokens : null;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}

export function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}
