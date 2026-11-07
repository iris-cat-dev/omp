import { describe, expect, it } from "vitest";
import type { OmpProviderAccountQuota } from "@omp-desktop/protocol/messages";
import { ClaudeQuotaState } from "./claude-quota-state.js";
import { quotaAccountKey } from "./quota-account-key.js";

const NOW = Date.parse("2026-10-11T00:00:00Z");
const RESET = "2026-10-11T05:00:00.000Z";
function quota(overrides: Partial<OmpProviderAccountQuota> = {}): OmpProviderAccountQuota {
  return {
    status: "available",
    fiveHourUsedPct: 100,
    fiveHourLimitReached: true,
    fiveHourResetsAt: RESET,
    weeklyUsedPct: 20,
    weeklyResetsAt: "2026-10-18T00:00:00Z",
    fetchedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}
const modelError = {
  provider: "anthropic",
  stopReason: "error",
  errorStatus: 429,
  errorMessage:
    "429 rate_limit_error: This request would exceed your account's rate limit. retry-after-ms=8016000",
};
const failed = quota({
  status: "error",
  fiveHourUsedPct: null,
  fiveHourLimitReached: null,
  fiveHourResetsAt: null,
  weeklyUsedPct: null,
  weeklyResetsAt: null,
  queryError: { kind: "rate_limited", httpStatus: 429, retryAt: "2026-10-11T00:00:39Z" },
});

describe("Claude account restriction evidence", () => {
  it("keeps generic model throttles unknown, separate from query retries and other accounts", () => {
    const state = new ClaudeQuotaState(() => NOW);
    state.observeCompletion("one", modelError);
    const one = state.completeRead(state.beginRead("one"), failed);
    expect(one.modelRateLimit).toEqual({
      scope: "unknown",
      resetsAt: "2026-10-11T02:13:36.000Z",
      observedAt: new Date(NOW).toISOString(),
    });
    expect(one.queryError?.retryAt).toBe("2026-10-11T00:00:39Z");
    expect(one.fiveHourLimitReached).toBeNull();
    expect(state.completeRead(state.beginRead("two"), failed)).not.toHaveProperty("modelRateLimit");
    state.observeCompletion("one", { ...modelError, provider: "openai-codex" });
    expect(state.completeRead(state.beginRead("one"), failed).modelRateLimit).toEqual(
      one.modelRateLimit,
    );
  });

  it("retains exhausted five-hour evidence through failed queries and expired deadlines until rechecked", () => {
    let now = NOW;
    const state = new ClaudeQuotaState(() => now);
    state.completeRead(state.beginRead("one"), quota());
    state.observeCompletion("one", modelError);
    now += 6 * 60 * 60_000;
    const result = state.completeRead(state.beginRead("one"), failed);
    expect(result).toMatchObject({
      fiveHourUsedPct: null,
      fiveHourLimitReached: true,
      fiveHourResetsAt: RESET,
      modelRateLimit: { scope: "five_hour", resetsAt: RESET },
    });
    const fresh = state.completeRead(
      state.beginRead("one"),
      quota({
        fiveHourUsedPct: 12,
        fiveHourLimitReached: false,
        fiveHourResetsAt: "2026-10-11T11:00:00Z",
      }),
    );
    expect(fresh.fiveHourLimitReached).toBe(false);
    expect(fresh.fiveHourUsedPct).toBe(12);
    expect(fresh).not.toHaveProperty("modelRateLimit");
  });

  it("clears known scope on a fresh zero-usage window even without a reset date", () => {
    const state = new ClaudeQuotaState(() => NOW);
    state.completeRead(state.beginRead("one"), quota());
    state.observeCompletion("one", modelError);
    const fresh = state.completeRead(
      state.beginRead("one"),
      quota({
        fiveHourUsedPct: 0,
        fiveHourLimitReached: false,
        fiveHourResetsAt: null,
      }),
    );
    expect(fresh).toMatchObject({
      fiveHourUsedPct: 0,
      fiveHourLimitReached: false,
      fiveHourResetsAt: null,
    });
    expect(fresh).not.toHaveProperty("modelRateLimit");
  });

  it("clears only the corresponding known scope, never generic throttles from unrelated usage", () => {
    const state = new ClaudeQuotaState(() => NOW);
    state.observeCompletion("weekly", {
      ...modelError,
      errorMessage: "weekly quota exceeded retry-after-ms=1000",
    });
    expect(state.completeRead(state.beginRead("weekly"), failed).modelRateLimit?.scope).toBe(
      "seven_day",
    );
    const partial = quota({
      fiveHourUsedPct: 12,
      fiveHourLimitReached: false,
      weeklyUsedPct: null,
    });
    expect(state.completeRead(state.beginRead("weekly"), partial)).toHaveProperty("modelRateLimit");
    expect(
      state.completeRead(
        state.beginRead("weekly"),
        quota({ weeklyUsedPct: 0, weeklyResetsAt: null }),
      ),
    ).not.toHaveProperty("modelRateLimit");
    state.observeCompletion("unknown", {
      ...modelError,
      errorMessage: "five-hour limit not reached; rate_limit_error retry-after-ms=1000",
    });
    state.observeCompletion("unknown", { provider: "anthropic", stopReason: "aborted" });
    expect(state.completeRead(state.beginRead("unknown"), partial)).toHaveProperty(
      "modelRateLimit.scope",
      "unknown",
    );
  });

  it("does not infer five-hour scope from an old exhaustion observation or a long retry", () => {
    let now = NOW;
    const state = new ClaudeQuotaState(() => now);
    state.completeRead(state.beginRead("one"), quota());
    now += 6 * 60_000;
    state.observeCompletion("one", modelError);
    expect(state.completeRead(state.beginRead("one"), failed).modelRateLimit?.scope).toBe(
      "unknown",
    );
  });

  it("preserves newer native events against older in-flight success, then clears with real model success", () => {
    const state = new ClaudeQuotaState(() => NOW);
    const read = state.beginRead("one");
    state.observeCompletion("one", {
      ...modelError,
      errorMessage: "five-hour limit reached retry-after-ms=1000",
    });
    const raced = state.completeRead(
      read,
      quota({ fiveHourUsedPct: 12, fiveHourLimitReached: false }),
    );
    expect(raced).toMatchObject({
      fiveHourUsedPct: null,
      fiveHourLimitReached: true,
      modelRateLimit: { scope: "five_hour", resetsAt: "2026-10-11T00:00:01.000Z" },
    });
    state.observeCompletion("one", { provider: "anthropic", stopReason: "stop" });
    expect(state.completeRead(state.beginRead("one"), failed)).not.toHaveProperty("modelRateLimit");
  });

  it("does not let an older read overwrite a newer exhausted observation", () => {
    const state = new ClaudeQuotaState(() => NOW);
    const old = state.beginRead("one");
    state.completeRead(state.beginRead("one"), quota());
    expect(
      state.completeRead(old, quota({ fiveHourUsedPct: 1, fiveHourLimitReached: false })),
    ).toMatchObject({ fiveHourUsedPct: 100, fiveHourLimitReached: true });
  });

  it("does not treat partial, stale-window, or unrelated fresh windows as five-hour recovery", () => {
    const state = new ClaudeQuotaState(() => NOW);
    state.completeRead(state.beginRead("one"), quota());
    for (const incoming of [
      quota({ fiveHourUsedPct: null, fiveHourLimitReached: null, fiveHourResetsAt: null }),
      quota({
        fiveHourUsedPct: 1,
        fiveHourLimitReached: false,
        fiveHourResetsAt: "2026-10-10T00:00:00Z",
      }),
    ]) {
      expect(state.completeRead(state.beginRead("one"), incoming).fiveHourLimitReached).toBe(true);
    }
  });

  it("survives same-account token refresh but isolates identity/config changes and deletion", () => {
    const account = {
      provider: "anthropic",
      credentialId: 1,
      accessToken: "secret",
      identityKey: "account-one",
    };
    const key = quotaAccountKey("one/agent.db", account);
    expect(quotaAccountKey("one/agent.db", { ...account, accessToken: "refreshed" })).toBe(key);
    expect(quotaAccountKey("one/agent.db", { ...account, identityKey: "account-two" })).not.toBe(
      key,
    );
    expect(quotaAccountKey("two/agent.db", account)).not.toBe(key);
    expect(
      quotaAccountKey("one/agent.db", {
        ...account,
        identityKey: undefined,
        accessToken: "new",
      }),
    ).not.toBe(quotaAccountKey("one/agent.db", { ...account, identityKey: undefined }));
    const state = new ClaudeQuotaState(() => NOW);
    state.observeCompletion(key, modelError);
    state.retainAccounts(new Set());
    expect(state.completeRead(state.beginRead(key), failed)).not.toHaveProperty("modelRateLimit");
  });
});
