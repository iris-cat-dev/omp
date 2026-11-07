import { z } from "zod";
import type { OmpProviderAccountQuota } from "@omp-desktop/protocol/messages";
import { fetchCodexResetCredits } from "./codex-reset-credits.js";

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
  rate_limit: z.unknown().optional(),
  credits: z.unknown().optional(),
});
const CodexRateLimitSchema = z.object({
  primary_window: z.unknown().optional(),
  secondary_window: z.unknown().optional(),
});
const CodexUsageCreditsSchema = z.object({
  has_credits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.unknown().optional(),
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

function parseCredits(value: unknown): OmpProviderAccountQuota["credits"] {
  const parsed = CodexUsageCreditsSchema.safeParse(value);
  if (!parsed.success) return null;
  // Codex reports a decimal string, not a reset-card count or a currency amount.
  const balance = typeof parsed.data.balance === "string" ? parsed.data.balance.trim() : null;
  return {
    hasCredits: parsed.data.has_credits,
    unlimited: parsed.data.unlimited,
    balance: balance !== null && /^\d+(?:\.\d+)?$/.test(balance) ? balance : null,
  };
}

function failure(
  status: "unavailable" | "error",
  error: string,
  now: () => number,
  queryError: OmpProviderAccountQuota["queryError"] = { kind: "invalid_response" },
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
    queryError,
  };
}

function selectQuotaWindow(
  primary: CodexUsageWindow | null,
  secondary: CodexUsageWindow | null,
  durationSeconds: number,
  legacyWindow: CodexUsageWindow | null,
): CodexUsageWindow | null {
  // Explicit durations take precedence over the historical plan/position mapping.
  // Unknown explicit durations must not be relabelled as either known window.
  if (primary?.durationSeconds === durationSeconds) return primary;
  if (secondary?.durationSeconds === durationSeconds) return secondary;
  return legacyWindow && !legacyWindow.hasDuration ? legacyWindow : null;
}

function resolveQuotaWindows(
  primary: CodexUsageWindow | null,
  secondary: CodexUsageWindow | null,
  hasFiveHourLimit: boolean,
): { fiveHour: CodexUsageWindow | null; weekly: CodexUsageWindow | null } | { error: string } {
  const fiveHour = selectQuotaWindow(primary, secondary, 18_000, hasFiveHourLimit ? primary : null);
  const weekly = selectQuotaWindow(
    primary,
    secondary,
    604_800,
    hasFiveHourLimit ? secondary : primary,
  );
  if (!fiveHour && !weekly) {
    return { error: "Codex usage response did not include a recognized quota window" };
  }
  return { fiveHour, weekly };
}

function parseUsageResponse(payload: unknown, now: () => number): OmpProviderAccountQuota {
  const parsed = CodexUsageResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return failure("error", "Codex usage response did not include rate limits", now);
  }
  const credits = parseCredits(parsed.data.credits);
  const rateLimit = CodexRateLimitSchema.safeParse(parsed.data.rate_limit);
  if (!rateLimit.success) {
    return {
      ...failure("error", "Codex usage response did not include rate limits", now),
      credits,
    };
  }
  const primary = parseWindow(rateLimit.data.primary_window);
  const secondary = parseWindow(rateLimit.data.secondary_window);
  const planLabel = typeof parsed.data.plan_type === "string" ? parsed.data.plan_type : null;
  const windows = resolveQuotaWindows(primary, secondary, !isProPlan(planLabel));
  if ("error" in windows) {
    return {
      ...failure("error", windows.error, now),
      credits,
    };
  }
  const { fiveHour, weekly } = windows;
  const fiveHourUsedPct = fiveHour?.usedPct ?? null;
  return {
    status: "available",
    planLabel,
    credits,
    fiveHourUsedPct,
    fiveHourLimitReached: fiveHourUsedPct === null ? null : fiveHourUsedPct >= 100,
    fiveHourResetsAt: fiveHour?.resetsAt ?? null,
    weeklyUsedPct: weekly?.usedPct ?? null,
    weeklyResetsAt: weekly?.resetsAt ?? null,
    fetchedAt: new Date(now()).toISOString(),
  };
}

function parseRetryAt(headers: Headers, now: number): string | null {
  const value = headers.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  let deadline = Date.parse(value);
  if (Number.isFinite(seconds)) deadline = seconds >= 0 ? now + seconds * 1_000 : NaN;
  return Number.isFinite(deadline) && Math.abs(deadline) <= 8.64e15
    ? new Date(deadline).toISOString()
    : null;
}

async function fetchCodexUsage(
  options: CodexAccountQuotaFetchOptions,
): Promise<OmpProviderAccountQuota> {
  const now = options.now ?? Date.now;
  const accessToken = options.credential.accessToken.trim();
  if (!accessToken) {
    return failure("unavailable", "Codex account credential is unavailable", now, {
      kind: "authentication",
    });
  }

  const fetchApi = options.fetch ?? fetch;
  const controller = new AbortController();
  const { promise: deadline, resolve: expire } = Promise.withResolvers<OmpProviderAccountQuota>();
  const timeout = setTimeout(() => {
    controller.abort();
    expire(failure("error", "Codex usage request timed out", now, { kind: "timeout" }));
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await Promise.race([
      deadline,
      (async () => {
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
          return failure("unavailable", "Codex account authentication expired", now, {
            kind: "authentication",
            httpStatus: response.status,
          });
        }
        if (!response.ok) {
          return failure("error", `Codex usage request failed (HTTP ${response.status})`, now, {
            kind: response.status === 429 ? "rate_limited" : "http",
            httpStatus: response.status,
            retryAt: parseRetryAt(response.headers, now()),
          });
        }

        // Keep the deadline through body consumption; body-reader failures are network errors.
        const body = await response.text();
        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          return failure("error", "Codex usage response was not valid JSON", now, {
            kind: "invalid_response",
            httpStatus: response.status,
          });
        }
        return parseUsageResponse(payload, now);
      })(),
    ]);
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return failure("error", "Codex usage request timed out", now, { kind: "timeout" });
    }
    return failure("error", "Codex usage request failed", now, { kind: "network" });
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
  };
}
