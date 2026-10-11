import type { OmpProviderAccountQuota } from "@omp-desktop/protocol/messages";

// These OAuth telemetry endpoints are undocumented and may change independently of the public API.
export const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ClaudeAccountQuotaCredential {
  accessToken: string;
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface ClaudeAccountQuotaFetchOptions {
  credential: ClaudeAccountQuotaCredential;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const PLAN_LABELS: Readonly<Record<string, string>> = {
  claude_pro: "Pro",
  claude_max: "Max",
  claude_team: "Team",
  claude_enterprise: "Enterprise",
};

function planLabel(subscriptionType: unknown, rateLimitTier: unknown): string | null {
  const subscription = text(subscriptionType);
  const tier = text(rateLimitTier);
  const maxTier = tier?.match(/^default_claude_max_(5|20)x$/);
  if (maxTier) return `Max ${maxTier[1]}x`;
  return (subscription ? PLAN_LABELS[subscription] : undefined) ?? tier ?? subscription;
}

function nonnegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function usedPct(value: unknown): number | null {
  const number = nonnegativeNumber(value);
  return number === null ? null : Math.min(100, number);
}

function window(value: unknown): { usedPct: number | null; resetsAt: string | null } | null {
  const data = record(value);
  if (!data || !("utilization" in data || "resets_at" in data)) return null;
  const reset = text(data.resets_at);
  // Require a timezone to avoid interpreting API dates in the server's local timezone.
  const milliseconds = reset && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(reset) ? Date.parse(reset) : NaN;
  return {
    usedPct: usedPct(data.utilization),
    resetsAt: Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null,
  };
}

function extraUsage(value: unknown): OmpProviderAccountQuota["extraUsage"] {
  const data = record(value);
  if (!data || typeof data.is_enabled !== "boolean") return undefined;
  // The OAuth usage endpoint reports cents in USD unless it explicitly declares another currency.
  const isUsd = data.currency === undefined || text(data.currency)?.toUpperCase() === "USD";
  const used = isUsd ? nonnegativeNumber(data.used_credits) : null;
  const limit = isUsd ? nonnegativeNumber(data.monthly_limit) : null;
  return {
    enabled: data.is_enabled,
    usedUsd: used === null ? null : used / 100,
    monthlyLimitUsd: limit === null ? null : limit / 100,
    usedPct: usedPct(data.utilization),
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

function parseUsage(payload: unknown, now: () => number): OmpProviderAccountQuota {
  const data = record(payload);
  if (!data) return failure("error", "Claude usage response did not include quota windows", now);
  const fiveHour = window(data.five_hour);
  const weekly = window(data.seven_day);
  const modelWindows: NonNullable<OmpProviderAccountQuota["modelWindows"]> = [];
  for (const [key, value] of Object.entries(data)) {
    const match = /^seven_day_([a-zA-Z0-9][a-zA-Z0-9_-]*)$/.exec(key);
    const modelWindow = match ? window(value) : null;
    if (match && modelWindow) modelWindows.push({ model: match[1]!, ...modelWindow });
  }
  const extra = extraUsage(data.extra_usage);
  if (!fiveHour && !weekly && modelWindows.length === 0 && !extra) {
    return failure("error", "Claude usage response did not include quota windows", now);
  }
  const fiveHourUsedPct = fiveHour?.usedPct ?? null;
  return {
    status: "available",
    fiveHourUsedPct,
    fiveHourLimitReached: fiveHourUsedPct === null ? null : fiveHourUsedPct >= 100,
    fiveHourResetsAt: fiveHour?.resetsAt ?? null,
    weeklyUsedPct: weekly?.usedPct ?? null,
    weeklyResetsAt: weekly?.resetsAt ?? null,
    modelWindows,
    ...(extra ? { extraUsage: extra } : {}),
    fetchedAt: new Date(now()).toISOString(),
  };
}

export async function fetchClaudeAccountQuota(
  options: ClaudeAccountQuotaFetchOptions,
): Promise<OmpProviderAccountQuota> {
  const now = options.now ?? Date.now;
  const accessToken = options.credential.accessToken.trim();
  if (!accessToken) return failure("unavailable", "Claude account credential is unavailable", now);
  const fetchApi = options.fetch ?? fetch;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
  };
  async function request(endpoint: string): Promise<{ status: number; ok: boolean; body: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      // Keep the deadline active until the body is consumed as well.
      const response = await fetchApi(endpoint, {
        method: "GET",
        headers,
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      });
      const body = response.ok ? await response.text() : "";
      return { status: response.status, ok: response.ok, body };
    } finally {
      clearTimeout(timeout);
    }
  }

  let quota: OmpProviderAccountQuota;
  try {
    const response = await request(CLAUDE_USAGE_ENDPOINT);
    if (response.status === 401 || response.status === 403) {
      return failure("unavailable", "Claude account authentication expired", now);
    }
    if (!response.ok) return failure("error", "Claude usage request failed", now);
    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      return failure("error", "Claude usage response was not valid JSON", now);
    }
    quota = parseUsage(payload, now);
  } catch (error) {
    return failure(
      "error",
      error instanceof DOMException && error.name === "AbortError"
        ? "Claude usage request timed out"
        : "Claude usage request failed",
      now,
    );
  }
  if (quota.status !== "available") return quota;
  let label = planLabel(options.credential.subscriptionType, options.credential.rateLimitTier);
  if (!label) {
    try {
      const response = await request(CLAUDE_PROFILE_ENDPOINT);
      if (response.ok) {
        const profile = record(JSON.parse(response.body));
        const organization = record(profile?.organization);
        label = planLabel(organization?.organization_type, organization?.rate_limit_tier);
      }
    } catch {
      // Plan metadata is optional: a profile failure must never discard successful usage.
    }
  }
  return { ...quota, planLabel: label };
}
