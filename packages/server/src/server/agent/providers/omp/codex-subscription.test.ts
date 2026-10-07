import { describe, expect, it, vi } from "vitest";
import { fetchCodexSubscription, resolveCodexSubscription } from "./codex-subscription.js";

const NOW = Date.parse("2026-10-01T00:00:00Z");
function credential(until: unknown, overrides: Record<string, unknown> = {}) {
  const claims = {
    exp: NOW / 1000 + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-1",
      chatgpt_subscription_active_until: until,
    },
    ...overrides,
  };
  return {
    accountId: "account-1",
    accessToken: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
  };
}

describe("Codex subscription metadata", () => {
  it("uses subscription expiry instead of credential expiry", () => {
    expect(resolveCodexSubscription(credential("2026-11-01T08:00:00+08:00"), "plus", NOW)).toEqual({
      status: "active",
      expiresAt: "2026-11-01T00:00:00.000Z",
    });
  });
  it("distinguishes expired from absent subscriptions", () => {
    expect(resolveCodexSubscription(credential("2026-09-01T00:00:00Z"), "plus", NOW)).toEqual({
      status: "expired",
      expiresAt: "2026-09-01T00:00:00.000Z",
    });
    expect(resolveCodexSubscription(credential(null), "free", NOW)).toEqual({
      status: "none",
      expiresAt: null,
    });
  });
  it.each([null, undefined, "invalid", "2026-11-01T00:00:00", 1793491200])(
    "does not invent expiry from unsupported metadata %s",
    (until) => {
      expect(resolveCodexSubscription(credential(until), "plus", NOW)).toEqual({
        status: "unavailable",
        expiresAt: null,
      });
    },
  );
  it("does not reuse stale credentials or a different account's claims", () => {
    expect(
      resolveCodexSubscription(credential("2026-11-01T00:00:00Z", { exp: NOW / 1000 }), "plus", NOW)
        .status,
    ).toBe("unavailable");
    const differentAccount = { ...credential("2026-11-01T00:00:00Z"), accountId: "account-2" };
    expect(resolveCodexSubscription(differentAccount, "plus", NOW).status).toBe("unavailable");
    expect(resolveCodexSubscription({ accessToken: "opaque-token" }, "plus", NOW).status).toBe(
      "unavailable",
    );
  });
});

function accountResponse(entitlement: unknown, accountId = "account-1") {
  return new Response(
    JSON.stringify({ accounts: { default: { account: { account_id: accountId }, entitlement } } }),
    { headers: { "Content-Type": "application/json" } },
  );
}

describe("Codex subscription lookup", () => {
  it.each([
    [
      { has_active_subscription: true, expires_at: "2026-11-01T08:00:00+08:00" },
      { status: "active", expiresAt: "2026-11-01T00:00:00.000Z", source: "account" },
    ],
    [
      { has_active_subscription: false, expires_at: "2026-09-01T00:00:00Z" },
      { status: "expired", expiresAt: "2026-09-01T00:00:00.000Z", source: "account" },
    ],
    [
      { has_active_subscription: true, expires_at: null },
      { status: "unavailable", expiresAt: null, unavailableReason: "not_provided" },
    ],
    [
      { has_active_subscription: false, expires_at: null },
      { status: "none", expiresAt: null },
    ],
  ])("uses account entitlement without inventing a date: %j", async (entitlement, expected) => {
    const subscription = await fetchCodexSubscription(
      {
        credential: credential(undefined),
        now: () => NOW,
        fetch: async () => accountResponse(entitlement),
      },
      "plus",
    );
    expect(subscription).toEqual(expected);
  });

  it.each([
    { accounts: [{ id: "account-1", plan_type: "pro" }] },
    { accounts: { default: { account: { account_id: "account-1", plan_type: "pro" } } } },
  ])(
    "reports a supported plan-only account response as lacking expiry support: %j",
    async (payload) => {
      const subscription = await fetchCodexSubscription(
        {
          credential: credential(undefined),
          now: () => NOW,
          fetch: async () => new Response(JSON.stringify(payload)),
        },
        "pro",
      );
      expect(subscription).toEqual({
        status: "unavailable",
        expiresAt: null,
        unavailableReason: "unsupported",
      });
    },
  );

  it("does not use another workspace's entitlement when the selected account is absent", async () => {
    const subscription = await fetchCodexSubscription(
      {
        credential: credential(undefined),
        now: () => NOW,
        fetch: async () =>
          accountResponse(
            { has_active_subscription: true, expires_at: "2026-11-01T00:00:00Z" },
            "different-account",
          ),
      },
      "plus",
    );
    expect(subscription).toEqual({
      status: "unavailable",
      expiresAt: null,
      error: "Codex subscription response omitted the selected account",
    });
  });

  it.each([401, 403, 429, 503])(
    "reports HTTP %s as a query failure, not unsupported",
    async (status) => {
      const subscription = await fetchCodexSubscription(
        {
          credential: credential(undefined),
          now: () => NOW,
          fetch: async () => new Response(null, { status }),
        },
        "pro",
      );
      expect(subscription).toEqual({
        status: "unavailable",
        expiresAt: null,
        error: `Codex subscription lookup failed (HTTP ${status})`,
      });
    },
  );

  it.each([404, 405, 501])(
    "reports HTTP %s as unsupported without implying no subscription",
    async (status) => {
      expect(
        await fetchCodexSubscription(
          {
            credential: credential(undefined),
            now: () => NOW,
            fetch: async () => new Response(null, { status }),
          },
          "pro",
        ),
      ).toEqual({ status: "unavailable", expiresAt: null, unavailableReason: "unsupported" });
    },
  );

  it.each(["invalid", "2026-11-01T00:00:00"])(
    "rejects ambiguous account expiry %s",
    async (expires_at) => {
      expect(
        await fetchCodexSubscription(
          {
            credential: credential(undefined),
            now: () => NOW,
            fetch: async () => accountResponse({ has_active_subscription: true, expires_at }),
          },
          "plus",
        ),
      ).toMatchObject({ status: "unavailable", expiresAt: null, error: expect.any(String) });
    },
  );

  it("does not expose sensitive network exception details", async () => {
    expect(
      await fetchCodexSubscription(
        {
          credential: credential(undefined),
          now: () => NOW,
          fetch: async () => {
            throw new Error("Codex subscription lookup secret-access-token");
          },
        },
        "plus",
      ),
    ).toEqual({
      status: "unavailable",
      expiresAt: null,
      error: "Codex subscription lookup failed",
    });
  });

  it("reports a timed-out query without reporting unsupported or expired", async () => {
    vi.useFakeTimers();
    try {
      const request = fetchCodexSubscription(
        {
          credential: credential(undefined),
          now: () => NOW,
          timeoutMs: 100,
          fetch: (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init!.signal!.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        },
        "plus",
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(await request).toEqual({
        status: "unavailable",
        expiresAt: null,
        error: "Codex subscription lookup timed out",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
