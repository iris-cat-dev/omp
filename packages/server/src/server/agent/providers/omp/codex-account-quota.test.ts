import { describe, expect, it, vi } from "vitest";
import { CODEX_USAGE_ENDPOINT, fetchCodexAccountQuota } from "./codex-account-quota.js";
import { CODEX_SUBSCRIPTION_ENDPOINT } from "./codex-subscription.js";

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

  it("marks expired credentials unavailable without attempting refresh", async () => {
    const fetchApi = vi.fn(async () => new Response(null, { status: 401 }));

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
    });
  });

  it("rejects a successful response that has no five-hour window", async () => {
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
      status: "error",
      fiveHourUsedPct: null,
      fiveHourLimitReached: null,
      error: "Codex usage response did not include the five-hour limit",
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

  it("queries the selected account's subscription when OAuth claims omit its expiry", async () => {
    const quota = await fetchCodexAccountQuota({
      credential: { accessToken: "access-token", accountId: "account-1" },
      now: () => NOW,
      fetch: async (url) => {
        if (url === CODEX_USAGE_ENDPOINT) {
          return jsonResponse({
            plan_type: "plus",
            rate_limit: { primary_window: { used_percent: 42 } },
          });
        }
        if (url === CODEX_SUBSCRIPTION_ENDPOINT) {
          return jsonResponse({
            accounts: {
              default: {
                account: { account_id: "another-account" },
                entitlement: {
                  has_active_subscription: true,
                  expires_at: "2026-09-30T00:00:00Z",
                },
              },
              selected: {
                account: { account_id: "account-1" },
                entitlement: {
                  has_active_subscription: true,
                  expires_at: "2026-10-01T08:00:00+08:00",
                },
              },
            },
          });
        }
        return jsonResponse({ available_count: 0, credits: [] });
      },
    });
    expect(quota.subscription).toMatchObject({
      status: "active",
      expiresAt: "2026-10-01T00:00:00.000Z",
    });
  });
});
