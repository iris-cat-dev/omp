import { describe, expect, it } from "vitest";
import { resolveCodexSubscription } from "./codex-subscription.js";

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
