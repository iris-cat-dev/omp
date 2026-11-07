import { describe, expect, it, vi } from "vitest";
import { CODEX_USAGE_ENDPOINT, fetchCodexAccountQuota } from "./codex-account-quota.js";
import { CODEX_RESET_CREDITS_ENDPOINT } from "./codex-reset-credits.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const NOW = Date.parse("2026-08-29T00:00:00.000Z");

describe("fetchCodexAccountQuota", () => {
  it("maps the five-hour window and sends the account id without exposing credentials", async () => {
    const fetchApi = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({
        Accept: "application/json",
        Authorization: "Bearer access-token",
        "ChatGPT-Account-Id": "account-1",
      });
      return jsonResponse({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: "100", reset_at: 1_798_122_000 },
          secondary_window: { used_percent: 12, reset_at: 1_798_640_000 },
        },
      });
    });

    await expect(
      fetchCodexAccountQuota({
        credential: { accessToken: " access-token ", accountId: "account-1" },
        fetch: fetchApi,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({
      status: "available",
      planLabel: "plus",
      fiveHourUsedPct: 100,
      fiveHourLimitReached: true,
      fiveHourResetsAt: "2026-12-24T14:20:00.000Z",
      weeklyUsedPct: 12,
      weeklyResetsAt: "2026-12-30T14:13:20.000Z",
      fetchedAt: "2026-08-29T00:00:00.000Z",
    });
    expect(fetchApi).toHaveBeenCalledWith(
      CODEX_USAGE_ENDPOINT,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    {
      label: "missing",
      credits: undefined,
      expected: null,
    },
    { label: "null", credits: null, expected: null },
    {
      label: "exact decimal balance",
      credits: { has_credits: true, unlimited: false, balance: "9007199254740993.000001" },
      expected: { hasCredits: true, unlimited: false, balance: "9007199254740993.000001" },
    },
    {
      label: "zero",
      credits: { has_credits: false, unlimited: false, balance: "0" },
      expected: { hasCredits: false, unlimited: false, balance: "0" },
    },
    {
      label: "unlimited",
      credits: { has_credits: true, unlimited: true, balance: null },
      expected: { hasCredits: true, unlimited: true, balance: null },
    },
    {
      label: "disabled",
      credits: { has_credits: false, unlimited: false },
      expected: { hasCredits: false, unlimited: false, balance: null },
    },
    {
      label: "unknown balance",
      credits: { has_credits: true, unlimited: false, balance: null },
      expected: { hasCredits: true, unlimited: false, balance: null },
    },
    {
      label: "numeric balance",
      credits: { has_credits: true, unlimited: false, balance: 25 },
      expected: { hasCredits: true, unlimited: false, balance: null },
    },
    {
      label: "blank balance",
      credits: { has_credits: true, unlimited: false, balance: "" },
      expected: { hasCredits: true, unlimited: false, balance: null },
    },
    {
      label: "malformed balance",
      credits: { has_credits: true, unlimited: false, balance: "not-a-balance" },
      expected: { hasCredits: true, unlimited: false, balance: null },
    },
    {
      label: "malformed flags",
      credits: { has_credits: "true", unlimited: false, balance: "25" },
      expected: null,
    },
    { label: "missing flags", credits: { balance: "25" }, expected: null },
  ])(
    "keeps $label credits distinct from quota windows and reset cards",
    async ({ credits, expected }) => {
      const fetchApi = vi.fn(async (url: RequestInfo | URL) =>
        jsonResponse(
          url === CODEX_USAGE_ENDPOINT
            ? {
                plan_type: "plus",
                rate_limit: {
                  primary_window: { used_percent: 20 },
                  secondary_window: { used_percent: 35 },
                },
                credits,
              }
            : { available_count: 2, credits: [] },
        ),
      );
      const quota = await fetchCodexAccountQuota({
        credential: { accessToken: "access-token" },
        fetch: fetchApi,
        now: () => NOW,
      });
      expect(quota.credits).toEqual(expected);
      expect(quota).toMatchObject({
        status: "available",
        fiveHourUsedPct: 20,
        weeklyUsedPct: 35,
        resetCredits: { status: "available", availableCount: 2 },
      });
      expect(fetchApi.mock.calls.filter(([url]) => url === CODEX_USAGE_ENDPOINT)).toHaveLength(1);
      expect(fetchApi).toHaveBeenCalledTimes(2);
    },
  );

  it("retains returned credits when usage windows are unavailable", async () => {
    const quota = await fetchCodexAccountQuota({
      credential: { accessToken: "access-token" },
      fetch: async () =>
        jsonResponse({
          rate_limit: null,
          credits: { has_credits: true, unlimited: false, balance: "12.50" },
        }),
      now: () => NOW,
    });
    expect(quota.status).toBe("error");
    expect(quota.fiveHourUsedPct).toBeNull();
    expect(quota.credits).toEqual({ hasCredits: true, unlimited: false, balance: "12.50" });
  });

  it("does not invent credits or request usage without account credentials", async () => {
    const fetchApi = vi.fn<typeof fetch>();
    const quota = await fetchCodexAccountQuota({
      credential: { accessToken: "" },
      fetch: fetchApi,
      now: () => NOW,
    });
    expect(quota.status).toBe("unavailable");
    expect(quota.credits).toBeUndefined();
    expect(quota.queryError).toEqual({ kind: "authentication" });
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("maps the Pro primary window as total quota without a five-hour quota", async () => {
    const fetchApi = vi.fn(async () =>
      jsonResponse({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 16, reset_at: 1_798_640_000 },
        },
      }),
    );

    await expect(
      fetchCodexAccountQuota({
        credential: { accessToken: "access-token" },
        fetch: fetchApi,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({
      status: "available",
      planLabel: "pro",
      fiveHourUsedPct: null,
      fiveHourLimitReached: null,
      fiveHourResetsAt: null,
      weeklyUsedPct: 16,
      weeklyResetsAt: "2026-12-30T14:13:20.000Z",
      fetchedAt: "2026-08-29T00:00:00.000Z",
    });
  });

  it.each([
    {
      plan: "pro",
      primary: { limit_window_seconds: 18_000, used_percent: 20, reset_at: 1_798_122_000 },
      secondary: { limit_window_seconds: 604_800, used_percent: 65, reset_at: 1_798_640_000 },
      fiveHourUsedPct: 20,
      weeklyUsedPct: 65,
    },
    {
      plan: "plus",
      primary: { limit_window_seconds: 604_800, used_percent: 65, reset_at: 1_798_640_000 },
      secondary: { limit_window_seconds: 18_000, used_percent: 20, reset_at: 1_798_122_000 },
      fiveHourUsedPct: 20,
      weeklyUsedPct: 65,
    },
  ])(
    "maps explicitly timed $plan windows regardless of their positions",
    async ({ plan, primary, secondary, fiveHourUsedPct, weeklyUsedPct }) => {
      const quota = await fetchCodexAccountQuota({
        credential: { accessToken: "access-token" },
        fetch: async () =>
          jsonResponse({
            plan_type: plan,
            rate_limit: { primary_window: primary, secondary_window: secondary },
          }),
        now: () => NOW,
      });
      expect(quota).toMatchObject({
        status: "available",
        fiveHourUsedPct,
        fiveHourLimitReached: false,
        fiveHourResetsAt: "2026-12-24T14:20:00.000Z",
        weeklyUsedPct,
        weeklyResetsAt: "2026-12-30T14:13:20.000Z",
      });
    },
  );

  it("keeps a weekly-only explicitly timed window even when the five-hour window is absent", async () => {
    const quota = await fetchCodexAccountQuota({
      credential: { accessToken: "access-token" },
      fetch: async () =>
        jsonResponse({
          plan_type: "plus",
          rate_limit: {
            secondary_window: {
              limit_window_seconds: 604_800,
              used_percent: 41,
              reset_at: 1_798_640_000,
            },
          },
        }),
      now: () => NOW,
    });
    expect(quota).toMatchObject({
      status: "available",
      fiveHourUsedPct: null,
      fiveHourLimitReached: null,
      fiveHourResetsAt: null,
      weeklyUsedPct: 41,
      weeklyResetsAt: "2026-12-30T14:13:20.000Z",
    });
  });

  it("does not coerce null or blank usage to zero or relabel unrecognized explicit durations", async () => {
    const quota = await fetchCodexAccountQuota({
      credential: { accessToken: "access-token" },
      fetch: async () =>
        jsonResponse({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              limit_window_seconds: 86_400,
              used_percent: 72,
              reset_at: 1_798_122_000,
            },
            secondary_window: {
              limit_window_seconds: 604_800,
              used_percent: null,
              reset_at: 1_798_640_000,
            },
          },
        }),
      now: () => NOW,
    });
    expect(quota).toMatchObject({
      status: "available",
      fiveHourUsedPct: null,
      fiveHourLimitReached: null,
      fiveHourResetsAt: null,
      weeklyUsedPct: null,
      weeklyResetsAt: "2026-12-30T14:13:20.000Z",
    });
    const blank = await fetchCodexAccountQuota({
      credential: { accessToken: "access-token" },
      fetch: async () =>
        jsonResponse({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              limit_window_seconds: 604_800,
              used_percent: "  ",
              reset_at: 1_798_640_000,
            },
          },
        }),
      now: () => NOW,
    });
    expect(blank).toMatchObject({
      status: "available",
      weeklyUsedPct: null,
      weeklyResetsAt: "2026-12-30T14:13:20.000Z",
    });
  });

  it.each([401, 403])(
    "classifies HTTP %s as expired authentication without refreshing",
    async (httpStatus) => {
      const fetchApi = vi.fn(async () => new Response(null, { status: httpStatus }));

      await expect(
        fetchCodexAccountQuota({
          credential: { accessToken: "expired-token" },
          fetch: fetchApi,
          now: () => NOW,
        }),
      ).resolves.toMatchObject({
        status: "unavailable",
        fiveHourLimitReached: null,
        error: "Codex account authentication expired",
        queryError: { kind: "authentication", httpStatus },
      });
    },
  );

  it("keeps absent five-hour usage unknown when only the weekly window is returned", async () => {
    const fetchApi = vi.fn(async () =>
      jsonResponse({ rate_limit: { secondary_window: { used_percent: 20 } } }),
    );

    await expect(
      fetchCodexAccountQuota({
        credential: { accessToken: "access-token" },
        fetch: fetchApi,
        now: () => NOW,
      }),
    ).resolves.toMatchObject({
      status: "available",
      fiveHourUsedPct: null,
      fiveHourLimitReached: null,
      weeklyUsedPct: 20,
    });
  });
  it("keeps reset cards available when the independent usage request fails", async () => {
    const quota = await fetchCodexAccountQuota({
      credential: { accessToken: "access-token" },
      now: () => NOW,
      fetch: async (url) =>
        url === CODEX_USAGE_ENDPOINT
          ? jsonResponse({}, 503)
          : jsonResponse({
              available_count: 1,
              credits: [
                {
                  id: "reset-1",
                  reset_type: "codex_rate_limits",
                  status: "available",
                  granted_at: "2026-08-01T00:00:00Z",
                  expires_at: null,
                },
              ],
            }),
    });
    expect(quota.status).toBe("error");
    expect(quota.resetCredits).toEqual({
      status: "available",
      availableCount: 1,
      credits: [
        {
          id: "reset-1",
          resetType: "codex_rate_limits",
          status: "available",
          grantedAt: "2026-08-01T00:00:00Z",
          expiresAt: null,
          title: null,
          description: null,
        },
      ],
    });
  });

  it("refreshes only usage and reset cards even when the credential carries subscription claims", async () => {
    const accessToken = `header.${Buffer.from(
      JSON.stringify({
        exp: NOW / 1_000 + 3_600,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-1",
          chatgpt_subscription_active_until: "2026-10-01T00:00:00Z",
        },
      }),
    ).toString("base64url")}.signature`;
    const fetchApi = vi.fn(async (url: RequestInfo | URL) => {
      if (url === CODEX_USAGE_ENDPOINT) {
        return jsonResponse({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: "42",
              reset_at: 1_798_122_000,
              limit_window_seconds: 18_000,
            },
            secondary_window: {
              used_percent: 65,
              reset_at: 1_798_640_000,
              limit_window_seconds: 604_800,
            },
          },
          credits: { has_credits: true, unlimited: false, balance: " 12.50 " },
        });
      }
      if (url === CODEX_RESET_CREDITS_ENDPOINT) {
        return jsonResponse({
          available_count: 1,
          credits: [
            {
              id: " reset-1 ",
              reset_type: "codex_rate_limits",
              status: "available",
              granted_at: "2026-08-01T00:00:00Z",
            },
          ],
        });
      }
      throw new Error(`Unexpected account request: ${url}`);
    });
    const quota = await fetchCodexAccountQuota({
      credential: { accessToken, accountId: "account-1" },
      now: () => NOW,
      fetch: fetchApi,
    });

    expect(fetchApi.mock.calls.map(([url]) => url)).toEqual([
      CODEX_USAGE_ENDPOINT,
      CODEX_RESET_CREDITS_ENDPOINT,
    ]);
    expect(quota).toEqual({
      status: "available",
      planLabel: "plus",
      credits: { hasCredits: true, unlimited: false, balance: "12.50" },
      fiveHourUsedPct: 42,
      fiveHourLimitReached: false,
      fiveHourResetsAt: "2026-12-24T14:20:00.000Z",
      weeklyUsedPct: 65,
      weeklyResetsAt: "2026-12-30T14:13:20.000Z",
      fetchedAt: "2026-08-29T00:00:00.000Z",
      resetCredits: {
        status: "available",
        availableCount: 1,
        credits: [
          {
            id: "reset-1",
            resetType: "codex_rate_limits",
            status: "available",
            grantedAt: "2026-08-01T00:00:00Z",
            expiresAt: null,
            title: null,
            description: null,
          },
        ],
      },
    });
  });

  it("keeps usage available when the independent reset-card request fails", async () => {
    const quota = await fetchCodexAccountQuota({
      credential: { accessToken: "access-token" },
      now: () => NOW,
      fetch: async (url) =>
        url === CODEX_USAGE_ENDPOINT
          ? jsonResponse({
              plan_type: "plus",
              rate_limit: {
                primary_window: { used_percent: 42, reset_at: 1_798_122_000 },
                secondary_window: { used_percent: 65, reset_at: 1_798_640_000 },
              },
            })
          : jsonResponse({}, 503),
    });

    expect(quota).toMatchObject({
      status: "available",
      planLabel: "plus",
      fiveHourUsedPct: 42,
      fiveHourLimitReached: false,
      fiveHourResetsAt: "2026-12-24T14:20:00.000Z",
      weeklyUsedPct: 65,
      weeklyResetsAt: "2026-12-30T14:13:20.000Z",
      resetCredits: {
        status: "error",
        availableCount: null,
        credits: [],
        error: "Codex reset card request failed (HTTP 503)",
      },
    });
  });

  it.each([
    { status: 429, retryAfter: "39", kind: "rate_limited", retryAt: "2026-08-29T00:00:39.000Z" },
    {
      status: 429,
      retryAfter: "Sat, 29 Aug 2026 00:02:00 GMT",
      kind: "rate_limited",
      retryAt: "2026-08-29T00:02:00.000Z",
    },
    { status: 429, retryAfter: "-1", kind: "rate_limited", retryAt: null },
    { status: 429, retryAfter: "private-response-text", kind: "rate_limited", retryAt: null },
    { status: 503, retryAfter: "15", kind: "http", retryAt: "2026-08-29T00:00:15.000Z" },
  ])(
    "classifies HTTP $status without using it as quota exhaustion",
    async ({ status, retryAfter, kind, retryAt }) => {
      const quota = await fetchCodexAccountQuota({
        credential: { accessToken: "private-token" },
        now: () => NOW,
        fetch: async (url) =>
          url === CODEX_USAGE_ENDPOINT
            ? new Response("private-token backend details", {
                status,
                headers: { "Retry-After": retryAfter },
              })
            : jsonResponse({ available_count: 0, credits: [] }),
      });
      expect(quota).toMatchObject({
        status: "error",
        fiveHourUsedPct: null,
        fiveHourLimitReached: null,
        weeklyUsedPct: null,
        queryError: { kind, httpStatus: status, retryAt },
      });
      expect(JSON.stringify(quota)).not.toContain("private-token");
      expect(JSON.stringify(quota)).not.toContain("backend details");
    },
  );

  it.each([
    { name: "network", error: new TypeError("private-token network address"), kind: "network" },
    { name: "abort", error: new DOMException("private-token", "AbortError"), kind: "timeout" },
  ])("sanitizes $name exceptions", async ({ error, kind }) => {
    const quota = await fetchCodexAccountQuota({
      credential: { accessToken: "private-token" },
      now: () => NOW,
      fetch: async (url) => {
        if (url === CODEX_USAGE_ENDPOINT) throw error;
        return jsonResponse({ available_count: 0, credits: [] });
      },
    });
    expect(quota).toMatchObject({ status: "error", fiveHourUsedPct: null, queryError: { kind } });
    expect(JSON.stringify(quota)).not.toContain("private-token");
  });

  it.each(["invalid JSON private-token", JSON.stringify({ rate_limit: "private-token" })])(
    "classifies invalid payloads without echoing their body",
    async (body) => {
      const quota = await fetchCodexAccountQuota({
        credential: { accessToken: "private-token" },
        now: () => NOW,
        fetch: async (url) =>
          url === CODEX_USAGE_ENDPOINT
            ? new Response(body)
            : jsonResponse({ available_count: 0, credits: [] }),
      });
      expect(quota).toMatchObject({
        status: "error",
        fiveHourUsedPct: null,
        fiveHourLimitReached: null,
        queryError: { kind: "invalid_response" },
      });
      expect(JSON.stringify(quota)).not.toContain("private-token");
    },
  );

  it.each(["fetch", "body"])("keeps the timeout through stalled %s consumption", async (stage) => {
    vi.useFakeTimers();
    try {
      const started = Promise.withResolvers<void>();
      const stalled = Promise.withResolvers<Response>();
      const body = Promise.withResolvers<string>();
      const pending = fetchCodexAccountQuota({
        credential: { accessToken: "private-token" },
        now: () => NOW,
        timeoutMs: 10,
        fetch: async (url) => {
          if (url !== CODEX_USAGE_ENDPOINT)
            return jsonResponse({ available_count: 0, credits: [] });
          started.resolve();
          if (stage === "fetch") return stalled.promise;
          const response = new Response();
          vi.spyOn(response, "text").mockReturnValue(body.promise);
          return response;
        },
      });
      await started.promise;
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({
        status: "error",
        fiveHourUsedPct: null,
        queryError: { kind: "timeout" },
      });
      stalled.resolve(new Response("{}"));
      body.resolve("{}");
    } finally {
      vi.useRealTimers();
    }
  });
});
