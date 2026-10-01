import { describe, expect, it, vi } from "vitest";
import { fetchCodexAccountQuota } from "./codex-account-quota.js";
import {
  CODEX_RESET_CREDITS_ENDPOINT,
  consumeCodexResetCredit,
  fetchCodexResetCredits,
} from "./codex-reset-credits.js";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const card = {
  id: "selected-card",
  reset_type: "codex_rate_limits",
  status: "available",
  granted_at: "2026-09-01T00:00:00Z",
  expires_at: "2026-11-01T00:00:00Z",
};
const credential = { accessToken: "secret", accountId: "selected-account" };
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Codex reset credits", () => {
  it("preserves future status/type and nullable metadata without treating them as usable", async () => {
    const result = await fetchCodexResetCredits({
      credential,
      fetch: async () =>
        json({
          available_count: 3,
          credits: [
            card,
            {
              ...card,
              id: "future",
              reset_type: "future_type",
              status: "future_status",
              expires_at: null,
            },
          ],
        }),
    });
    expect(result).toEqual({
      status: "available",
      availableCount: 3,
      credits: [
        {
          id: "selected-card",
          resetType: "codex_rate_limits",
          status: "available",
          grantedAt: card.granted_at,
          expiresAt: card.expires_at,
          title: null,
          description: null,
        },
        {
          id: "future",
          resetType: "future_type",
          status: "future_status",
          grantedAt: card.granted_at,
          expiresAt: null,
          title: null,
          description: null,
        },
      ],
    });
  });

  it.each([
    {},
    { available_count: "1", credits: [] },
    { available_count: 1, credits: [card, card] },
  ])("rejects malformed or duplicate card details", async (payload) => {
    expect(
      await fetchCodexResetCredits({ credential, fetch: async () => json(payload) }),
    ).toMatchObject({ status: "error", availableCount: null, credits: [] });
  });

  it("leaves valid quota intact when the reset API is unsupported", async () => {
    const result = await fetchCodexAccountQuota({
      credential,
      now: () => NOW,
      fetch: async (url) =>
        String(url) === CODEX_RESET_CREDITS_ENDPOINT
          ? json({}, 404)
          : json({
              plan_type: "plus",
              rate_limit: {
                primary_window: { used_percent: 80 },
                secondary_window: { used_percent: 25 },
              },
            }),
    });
    expect(result).toMatchObject({
      status: "available",
      fiveHourUsedPct: 80,
      weeklyUsedPct: 25,
      resetCredits: { status: "unavailable", availableCount: null, credits: [] },
    });
  });

  it.each([
    { ...card, status: "redeemed" },
    { ...card, status: "future_status" },
    { ...card, reset_type: "future_type" },
    { ...card, expires_at: "2026-10-01T00:00:00Z" },
    { ...card, expires_at: "invalid" },
    { ...card, id: "other-card" },
  ])(
    "does not submit an unavailable, expired, unknown, or absent selected card",
    async (credit) => {
      const methods: string[] = [];
      const fetchApi = async (_url: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return json({ available_count: 1, credits: [credit] });
      };
      await expect(
        consumeCodexResetCredit({
          credential,
          fetch: fetchApi,
          now: () => NOW,
          creditId: card.id,
          redeemRequestId: "stable-request",
        }),
      ).rejects.toThrow("not available or has expired");
      expect(methods).toEqual(["GET"]);
    },
  );

  it.each(["reset", "nothing_to_reset", "no_credit", "already_redeemed"])(
    "returns the authoritative %s result without converting HTTP 200 to success",
    async (code) => {
      const fetchApi = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
        expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("selected-account");
        expect(init?.cache).toBe("no-store");
        if (init?.method === "POST") {
          expect(String(url)).toBe(`${CODEX_RESET_CREDITS_ENDPOINT}/consume`);
          expect(JSON.parse(String(init.body))).toEqual({
            credit_id: "selected-card",
            redeem_request_id: "stable-request",
          });
          return json({ code, windows_reset: code === "reset" ? 2 : 0 });
        }
        return json({ available_count: 1, credits: [card] });
      });
      expect(
        await consumeCodexResetCredit({
          credential,
          fetch: fetchApi,
          now: () => NOW,
          creditId: card.id,
          redeemRequestId: "stable-request",
        }),
      ).toEqual({ code, windowsReset: code === "reset" ? 2 : 0 });
    },
  );

  it.each([
    {},
    { code: "unknown", windows_reset: 2 },
    { code: "reset", windows_reset: -1 },
    { code: "reset", windows_reset: "2" },
    { code: "reset" },
  ])("rejects invalid success bodies without retrying the POST", async (payload) => {
    const methods: string[] = [];
    const fetchApi = async (_url: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return json(init?.method === "POST" ? payload : { available_count: 1, credits: [card] });
    };
    await expect(
      consumeCodexResetCredit({
        credential,
        fetch: fetchApi,
        now: () => NOW,
        creditId: card.id,
        redeemRequestId: "stable-request",
      }),
    ).rejects.toThrow("consumption response was malformed");
    expect(methods).toEqual(["GET", "POST"]);
  });
});
