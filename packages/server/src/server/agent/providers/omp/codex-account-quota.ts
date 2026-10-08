import { z } from "zod";
import type { OmpProviderAccountQuota } from "@omp-desktop/protocol/messages";
import { fetchCodexResetCredits } from "./codex-reset-credits.js";
import { fetchCodexSubscription } from "./codex-subscription.js";

export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface CodexAccountQuotaCredential {
  accessToken: string;
  accountId?: string;
}

export interface CodexAccountQuotaFetchOptions {
  credential: CodexAccountQuotaCredential;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const CodexUsageResponseSchema = z.object({
  plan_type: z.unknown().optional(),
  rate_limit: z.object({
    primary_window: z.unknown().optional(),
    secondary_window: z.unknown().optional(),
  }),
});
const CodexUsageWindowSchema = z.object({
  used_percent: z.unknown().optional(),
  reset_at: z.unknown().optional(),
  limit_window_seconds: z.unknown().optional(),
});

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) {
    return null;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseUsedPct(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.min(100, number));
}

function parseResetAt(value: unknown): string | null {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds <= 0) return null;
  const milliseconds = seconds > 1_000_000_000_000 ? seconds : seconds * 1_000;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isProPlan(planLabel: string | null): boolean {
  return planLabel?.trim().toLowerCase() === "pro";
}

interface CodexUsageWindow {
  usedPct: number | null;
  resetsAt: string | null;
  durationSeconds: number | null;
  hasDuration: boolean;
}

function parseWindow(value: unknown): CodexUsageWindow | null {
  const parsed = CodexUsageWindowSchema.safeParse(value);
  if (!parsed.success) return null;
  const usedPct = parseUsedPct(parsed.data.used_percent);
  const resetsAt = parseResetAt(parsed.data.reset_at);
  if (usedPct === null && resetsAt === null) return null;
  return {
    usedPct,
    resetsAt,
    durationSeconds: finiteNumber(parsed.data.limit_window_seconds),
    hasDuration: Object.hasOwn(parsed.data, "limit_window_seconds"),
  };
}

function failure(
  status: "unavailable" | "error",
  error: string,
  now: () => number,
): OmpProviderAccountQuota {
  return {
    status,
    fiveHourUsedPct: null,
    fiveHourLimitReached: null,
    fiveHourResetsAt: null,
    weeklyUsedPct: null,
    weeklyResetsAt: null,
    fetchedAt: new Date(now()).toISOString(),
    error,
  };
}

function parseUsageResponse(payload: unknown, now: () => number): OmpProviderAccountQuota {
  const parsed = CodexUsageResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return failure("error", "Codex usage response did not include rate limits", now);
  }
  const primary = parseWindow(parsed.data.rate_limit.primary_window);
  const secondary = parseWindow(parsed.data.rate_limit.secondary_window);
  const planLabel = typeof parsed.data.plan_type === "string" ? parsed.data.plan_type : null;
  const hasFiveHourLimit = !isProPlan(planLabel);
  // An explicitly reported duration takes precedence over the historical plan/position mapping.
  // Unknown explicit durations must not be relabelled as either known window.
  const explicitFiveHour =
    primary?.durationSeconds === 18_000
      ? primary
      : secondary?.durationSeconds === 18_000
        ? secondary
        : null;
  const explicitWeekly =
    primary?.durationSeconds === 604_800
      ? primary
      : secondary?.durationSeconds === 604_800
        ? secondary
        : null;
  const legacyWeekly = hasFiveHourLimit ? secondary : primary;
  const fiveHour =
    explicitFiveHour ?? (hasFiveHourLimit && primary && !primary.hasDuration ? primary : null);
  const total = explicitWeekly ?? (legacyWeekly && !legacyWeekly.hasDuration ? legacyWeekly : null);
  if (!fiveHour && !total) {
    return failure("error", "Codex usage response did not include a recognized quota window", now);
  }
  if (!fiveHour && hasFiveHourLimit && !primary && secondary && !secondary.hasDuration) {
    return failure("error", "Codex usage response did not include the five-hour limit", now);
  }
  const fiveHourUsedPct = fiveHour?.usedPct ?? null;
  return {
    status: "available",
    planLabel,
    fiveHourUsedPct,
    fiveHourLimitReached: fiveHourUsedPct === null ? null : fiveHourUsedPct >= 100,
    fiveHourResetsAt: fiveHour?.resetsAt ?? null,
    weeklyUsedPct: total?.usedPct ?? null,
    weeklyResetsAt: total?.resetsAt ?? null,
    fetchedAt: new Date(now()).toISOString(),
  };
}

async function fetchCodexUsage(
  options: CodexAccountQuotaFetchOptions,
): Promise<OmpProviderAccountQuota> {
  const now = options.now ?? Date.now;
  const accessToken = options.credential.accessToken.trim();
  if (!accessToken) {
    return failure("unavailable", "Codex account credential is unavailable", now);
  }

  const fetchApi = options.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
    if (options.credential.accountId) {
      headers["ChatGPT-Account-Id"] = options.credential.accountId;
    }
    const response = await fetchApi(CODEX_USAGE_ENDPOINT, {
      headers,
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
      return failure("unavailable", "Codex account authentication expired", now);
    }
    if (!response.ok) {
      return failure("error", `Codex usage request failed (HTTP ${response.status})`, now);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failure("error", "Codex usage response was not valid JSON", now);
    }
    return parseUsageResponse(payload, now);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return failure("error", "Codex usage request timed out", now);
    }
    return failure("error", "Codex usage request failed", now);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchCodexAccountQuota(
  options: CodexAccountQuotaFetchOptions,
): Promise<OmpProviderAccountQuota> {
  const [quota, resetCredits] = await Promise.all([
    fetchCodexUsage(options),
    fetchCodexResetCredits(options),
  ]);
  return {
    ...quota,
    resetCredits,
    subscription: await fetchCodexSubscription(options, quota.planLabel ?? null),
  };
}
