import type { TFunction } from "i18next";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import type { ProviderUsageBalanceUnit } from "./types";

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatPct(value: number): string {
  return `${Math.round(clampPct(value))}%`;
}

function relativeDuration(iso: string): { count: number; unit: "day" | "hour" | "minute" } | null {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs <= 0) return { count: 0, unit: "minute" };
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) return { count: diffDays, unit: "day" };
  if (diffHours > 0) return { count: diffHours, unit: "hour" };
  return { count: diffMinutes, unit: "minute" };
}

function formatDuration(
  duration: { count: number; unit: "day" | "hour" | "minute" },
  t: TFunction,
): string {
  return t(`providerUsage.duration.${duration.unit}`, { count: duration.count });
}

export function formatResetLabel(iso: string | null | undefined, t: TFunction): string | null {
  if (!iso) return null;
  const duration = relativeDuration(iso);
  if (!duration) return null;
  if (duration.count === 0) return t("providerUsage.resetNow");
  return t("providerUsage.resetsIn", { duration: formatDuration(duration, t) });
}

export function formatRunsOutLabel(iso: string | null | undefined, t: TFunction): string | null {
  if (!iso) return null;
  const duration = relativeDuration(iso);
  if (!duration) return null;
  if (duration.count === 0) return t("providerUsage.resetNow");
  return t("providerUsage.runsOutIn", { duration: formatDuration(duration, t) });
}

export function formatAgo(iso: string | null | undefined, t: TFunction): string | null {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs < 60_000) return t("providerUsage.justNow");
  const duration = relativeDuration(new Date(Date.now() + diffMs).toISOString());
  if (!duration) return null;
  return t("providerUsage.ago", { duration: formatDuration(duration, t) });
}

export function formatAmount(
  value: number,
  unit: ProviderUsageBalanceUnit,
  locale?: string,
): string {
  switch (unit) {
    case "usd":
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    case "tokens":
      return formatTokenCount(value);
    default:
      return value.toLocaleString(locale);
  }
}

const LABEL_KEYS: Record<string, string> = {
  balance: "providerUsage.labels.balance",
  subscription: "providerUsage.labels.balance",
  quota: "providerUsage.labels.apiKeyQuota",
  plan_usage: "providerUsage.labels.planUsage",
  team_spend: "providerUsage.labels.monthlyUsage",
  monthly_requests: "providerUsage.labels.monthlyRequests",
  daily: "providerUsage.labels.daily",
  "five-hour": "agentControls.quota.fiveHour",
  weekly: "providerUsage.labels.weekly",
  monthly: "providerUsage.labels.monthly",
  model: "providerUsage.labels.model",
};

export function formatProviderUsageLabel(id: string, fallback: string, t: TFunction): string {
  const key = LABEL_KEYS[id];
  return key ? t(key) : fallback;
}
