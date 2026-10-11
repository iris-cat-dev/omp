import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_PROFILE_ENDPOINT,
  CLAUDE_USAGE_ENDPOINT,
  fetchClaudeAccountQuota,
} from "./claude-account-quota.js";

const NOW = Date.parse("2026-10-11T00:00:00.000Z");
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function quotaOptions(fetchApi: typeof fetch) {
  return {
    credential: { accessToken: " private-token ", subscriptionType: "max" },
    fetch: fetchApi,
    now: () => NOW,
  };
}

function stallUntilAbort(_url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { promise, reject } = Promise.withResolvers<Response>();
  init?.signal?.addEventListener(
    "abort",
    () => reject(new DOMException("private-token", "AbortError")),
    { once: true },
  );
  return promise;
}

describe("fetchClaudeAccountQuota", () => {
  it("maps real windows, preserves raw model suffixes, and converts cents rather than dollars", async () => {
    const fetchApi = vi.fn(async () =>
      jsonResponse({
        five_hour: { utilization: "100", resets_at: "2026-10-11T05:00:00+02:00" },
        seven_day: { utilization: 23, resets_at: "2026-10-18T00:00Z" },
        seven_day_opus: { utilization: 51, resets_at: "2026-10-18T00:00Z" },
        seven_day_omelette: { utilization: 105, resets_at: null },
        seven_day_sonnet: null,
        tangelo: { utilization: 30 },
        extra_usage: {
          is_enabled: true,
          used_credits: 1234.5,
          monthly_limit: 45000,
          utilization: 2.74,
          currency: "USD",
        },
      }),
    );
    const quota = await fetchClaudeAccountQuota(quotaOptions(fetchApi));
    expect(quota).toEqual({
      status: "available",
      planLabel: "max",
      fiveHourUsedPct: 100,
      fiveHourLimitReached: true,
      fiveHourResetsAt: "2026-10-11T03:00:00.000Z",
      weeklyUsedPct: 23,
      weeklyResetsAt: "2026-10-18T00:00:00.000Z",
      modelWindows: [
        { model: "opus", usedPct: 51, resetsAt: "2026-10-18T00:00:00.000Z" },
        { model: "omelette", usedPct: 100, resetsAt: null },
      ],
      extraUsage: { enabled: true, usedUsd: 12.345, monthlyLimitUsd: 450, usedPct: 2.74 },
      fetchedAt: "2026-10-11T00:00:00.000Z",
    });
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi).toHaveBeenCalledWith(
      CLAUDE_USAGE_ENDPOINT,
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: {
          Accept: "application/json",
          Authorization: "Bearer private-token",
          "anthropic-beta": "oauth-2025-04-20",
        },
      }),
    );
    expect(JSON.stringify(quota)).not.toContain("private-token");
    expect(quota).not.toHaveProperty("subscription");
    expect(quota).not.toHaveProperty("resetCredits");
  });

  it.each([
    {
      used_credits: null,
      monthly_limit: null,
      currency: "USD",
      expectedUsed: null,
      expectedLimit: null,
    },
    { used_credits: 0, monthly_limit: 0, currency: "USD", expectedUsed: 0, expectedLimit: 0 },
    {
      used_credits: "",
      monthly_limit: -1,
      currency: "USD",
      expectedUsed: null,
      expectedLimit: null,
    },
    {
      used_credits: 400,
      monthly_limit: 900,
      currency: "EUR",
      expectedUsed: null,
      expectedLimit: null,
    },
    {
      used_credits: 400,
      monthly_limit: 900,
      currency: null,
      expectedUsed: null,
      expectedLimit: null,
    },
  ])(
    "preserves absent, zero, invalid and non-USD amounts: $currency/$used_credits",
    async (entry) => {
      const quota = await fetchClaudeAccountQuota(
        quotaOptions(async () =>
          jsonResponse({
            five_hour: { utilization: null, resets_at: "2026-10-11T05:00:00" },
            seven_day: null,
            seven_day_opus: { utilization: false, resets_at: "not-a-date" },
            seven_day_sonnet: {},
            extra_usage: { is_enabled: false, ...entry, utilization: null },
          }),
        ),
      );
      expect(quota).toMatchObject({
        status: "available",
        fiveHourUsedPct: null,
        fiveHourLimitReached: null,
        fiveHourResetsAt: null,
        weeklyUsedPct: null,
        weeklyResetsAt: null,
        modelWindows: [{ model: "opus", usedPct: null, resetsAt: null }],
        extraUsage: {
          enabled: false,
          usedUsd: entry.expectedUsed,
          monthlyLimitUsd: entry.expectedLimit,
          usedPct: null,
        },
      });
    },
  );

  it.each([401, 403, 429, 500])(
    "sanitizes HTTP %i without requesting a profile",
    async (status) => {
      const fetchApi = vi.fn(async () => new Response("private-token backend-details", { status }));
      const quota = await fetchClaudeAccountQuota(quotaOptions(fetchApi));
      expect(quota.status).toBe(status === 401 || status === 403 ? "unavailable" : "error");
      expect(quota.error).toBe(
        status === 401 || status === 403
          ? "Claude account authentication expired"
          : "Claude usage request failed",
      );
      expect(fetchApi).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(quota)).not.toContain("private-token");
    },
  );

  it("does not request usage without a token", async () => {
    const fetchApi = vi.fn();
    const quota = await fetchClaudeAccountQuota({
      ...quotaOptions(fetchApi),
      credential: { accessToken: " " },
    });
    expect(quota.status).toBe("unavailable");
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it.each([
    {
      fetchApi: async () => new Response("private-token"),
      error: "Claude usage response was not valid JSON",
    },
    {
      fetchApi: async () => jsonResponse({ error: { message: "private-token" } }),
      error: "Claude usage response did not include quota windows",
    },
    {
      fetchApi: async () => {
        throw new Error("private-token");
      },
      error: "Claude usage request failed",
    },
    {
      fetchApi: async () => {
        throw new DOMException("private-token", "AbortError");
      },
      error: "Claude usage request timed out",
    },
  ])("reports sanitized parse/network boundaries: $error", async ({ fetchApi, error }) => {
    const quota = await fetchClaudeAccountQuota(quotaOptions(fetchApi));
    expect(quota).toMatchObject({ status: "error", error });
    expect(JSON.stringify(quota)).not.toContain("private-token");
  });

  it.each(["http", "json", "network"])(
    "keeps successful usage when optional profile fails: %s",
    async (mode) => {
      const fetchApi = vi.fn(async (url: RequestInfo | URL) => {
        if (String(url) === CLAUDE_USAGE_ENDPOINT)
          return jsonResponse({ five_hour: { utilization: 36 } });
        if (mode === "network") throw new Error("private-token");
        return mode === "http" ? new Response(null, { status: 403 }) : new Response("invalid");
      });
      const quota = await fetchClaudeAccountQuota({
        ...quotaOptions(fetchApi),
        credential: { accessToken: "private-token" },
      });
      expect(quota).toMatchObject({ status: "available", fiveHourUsedPct: 36, planLabel: null });
      expect(quota).not.toHaveProperty("error");
      expect(fetchApi).toHaveBeenCalledTimes(2);
      expect(String(fetchApi.mock.calls[1]![0])).toBe(CLAUDE_PROFILE_ENDPOINT);
    },
  );

  it("reads only real profile plan metadata and never converts dates to an expiration", async () => {
    const quota = await fetchClaudeAccountQuota({
      ...quotaOptions(async (url) =>
        jsonResponse(
          String(url) === CLAUDE_USAGE_ENDPOINT
            ? { seven_day: { utilization: 18 } }
            : {
                organization: {
                  rate_limit_tier: "default_claude_max_5x",
                  subscription_created_at: "2026-01-01",
                },
              },
        ),
      ),
      credential: { accessToken: "private-token" },
    });
    expect(quota).toMatchObject({ status: "available", weeklyUsedPct: 18, planLabel: "Max 5x" });
    expect(quota).not.toHaveProperty("subscription");
  });

  it("shows Pro rather than the shared default tier from a real profile shape", async () => {
    const quota = await fetchClaudeAccountQuota({
      fetch: async (url) =>
        jsonResponse(
          String(url) === CLAUDE_USAGE_ENDPOINT
            ? { five_hour: { utilization: 24 }, seven_day: { utilization: 4 } }
            : {
                organization: {
                  organization_type: "claude_pro",
                  rate_limit_tier: "default_claude_ai",
                },
              },
        ),
      credential: { accessToken: "private-token" },
    });
    expect(quota).toMatchObject({
      status: "available",
      fiveHourUsedPct: 24,
      weeklyUsedPct: 4,
      planLabel: "Pro",
    });
  });
  it("aborts a stalled usage request at its deadline without fetching a profile", async () => {
    vi.useFakeTimers();
    try {
      const fetchApi = vi.fn(stallUntilAbort);
      const pending = fetchClaudeAccountQuota({ ...quotaOptions(fetchApi), timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({
        status: "error",
        error: "Claude usage request timed out",
      });
      expect(fetchApi).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
