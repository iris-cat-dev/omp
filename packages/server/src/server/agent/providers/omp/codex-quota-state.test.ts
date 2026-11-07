import { describe, expect, it } from "vitest";
import type { OmpProviderAccountQuota } from "@omp-desktop/protocol/messages";
import { CodexQuotaState } from "./codex-quota-state.js";
import { quotaAccountKey } from "./quota-account-key.js";

const NOW = Date.parse("2026-10-11T00:00:00Z");
const timestamp = (seconds: number) => new Date(NOW + seconds * 1_000).toISOString();
function quota(overrides: Partial<OmpProviderAccountQuota> = {}): OmpProviderAccountQuota {
  return {
    status: "available",
    planLabel: "plus",
    fiveHourUsedPct: 46,
    fiveHourLimitReached: false,
    fiveHourResetsAt: "2026-10-11T05:00:00.000Z",
    weeklyUsedPct: 20,
    weeklyResetsAt: "2026-10-18T00:00:00.000Z",
    fetchedAt: timestamp(0),
    ...overrides,
  };
}
function failed(overrides: Partial<OmpProviderAccountQuota> = {}): OmpProviderAccountQuota {
  return quota({
    status: "error",
    planLabel: undefined,
    fiveHourUsedPct: null,
    fiveHourLimitReached: null,
    fiveHourResetsAt: null,
    weeklyUsedPct: null,
    weeklyResetsAt: null,
    fetchedAt: timestamp(1),
    error: "Codex usage request failed",
    queryError: { kind: "network" },
    ...overrides,
  });
}

const account = {
  provider: "openai-codex",
  credentialId: 1,
  accessToken: "private-one",
  identityKey: "account-one",
  accountId: "codex-one",
  orgId: "organization-one",
};

describe("Codex successful usage history", () => {
  it("retains the original successful date through repeated failures and replaces it on recovery", () => {
    const state = new CodexQuotaState();
    state.completeRead(state.beginRead("A"), quota());
    state.completeRead(state.beginRead("B"), quota({ fiveHourUsedPct: 70 }));
    const first = state.completeRead(state.beginRead("A"), failed());
    expect(first).toMatchObject({
      status: "error",
      fiveHourUsedPct: 46,
      fiveHourLimitReached: false,
      fetchedAt: timestamp(1),
      lastSuccessfulAt: timestamp(0),
      error: "Codex usage request failed",
      queryError: { kind: "network" },
    });
    const second = state.completeRead(
      state.beginRead("A"),
      failed({
        fetchedAt: timestamp(2),
        error: "Codex usage request timed out",
        queryError: { kind: "timeout" },
      }),
    );
    expect(second).toMatchObject({
      status: "error",
      fiveHourUsedPct: 46,
      fetchedAt: timestamp(2),
      lastSuccessfulAt: timestamp(0),
      error: "Codex usage request timed out",
      queryError: { kind: "timeout" },
    });
    const other = state.completeRead(
      state.beginRead("B"),
      quota({ fiveHourUsedPct: 75, fetchedAt: timestamp(2) }),
    );
    expect(other).toMatchObject({ status: "available", fiveHourUsedPct: 75 });
    expect(other).not.toHaveProperty("lastSuccessfulAt");
    const recovered = state.completeRead(
      state.beginRead("A"),
      quota({ fiveHourUsedPct: 49, fetchedAt: timestamp(3) }),
    );
    expect(recovered).toMatchObject({ status: "available", fiveHourUsedPct: 49 });
    expect(recovered).not.toHaveProperty("lastSuccessfulAt");
    expect(recovered).not.toHaveProperty("queryError");
    expect(
      state.completeRead(state.beginRead("A"), failed({ fetchedAt: timestamp(4) })),
    ).toMatchObject({ fiveHourUsedPct: 49, lastSuccessfulAt: timestamp(3) });
  });

  it("keeps no-history usage unknown and separates query throttling from actual returned exhaustion", () => {
    const state = new CodexQuotaState();
    const throttled = failed({ queryError: { kind: "rate_limited", httpStatus: 429 } });
    expect(state.completeRead(state.beginRead("unknown"), throttled)).toMatchObject({
      fiveHourUsedPct: null,
      fiveHourLimitReached: null,
      weeklyUsedPct: null,
      queryError: { kind: "rate_limited" },
    });
    expect(state.completeRead(state.beginRead("unknown"), throttled)).not.toHaveProperty(
      "lastSuccessfulAt",
    );
    state.completeRead(
      state.beginRead("actual"),
      quota({ fiveHourUsedPct: 100, fiveHourLimitReached: true }),
    );
    expect(state.completeRead(state.beginRead("actual"), throttled)).toMatchObject({
      status: "error",
      fiveHourUsedPct: 100,
      fiveHourLimitReached: true,
      lastSuccessfulAt: timestamp(0),
      queryError: { kind: "rate_limited" },
    });
  });

  it.each([401, 403])("clears same-account history after HTTP %s", (httpStatus) => {
    const state = new CodexQuotaState();
    state.completeRead(state.beginRead("A"), quota());
    const pending = state.beginRead("A");
    const authentication = failed({
      status: "unavailable",
      queryError: { kind: "authentication", httpStatus },
    });
    expect(state.completeRead(state.beginRead("A"), authentication)).toEqual(authentication);
    expect(state.completeRead(pending, quota({ fiveHourUsedPct: 49 }))).toEqual(authentication);
    const later = state.completeRead(state.beginRead("A"), failed());
    expect(later?.fiveHourUsedPct).toBeNull();
    expect(later).not.toHaveProperty("lastSuccessfulAt");
  });

  it("retains only recognized usage and uses this attempt's independent cards and credits", () => {
    const state = new CodexQuotaState();
    state.completeRead(
      state.beginRead("A"),
      quota({
        credits: { hasCredits: true, unlimited: false, balance: "99" },
        resetCredits: { status: "available", availableCount: 3, credits: [] },
      }),
    );
    const currentCards = { status: "available", availableCount: 1, credits: [] } as const;
    const retained = state.completeRead(
      state.beginRead("A"),
      failed({ resetCredits: { ...currentCards, credits: [] } }),
    );
    expect(retained).toMatchObject({ fiveHourUsedPct: 46, resetCredits: currentCards });
    expect(retained).not.toHaveProperty("credits");
    const currentCredits = { hasCredits: true, unlimited: false, balance: "12.5" };
    expect(
      state.completeRead(state.beginRead("A"), failed({ credits: currentCredits })),
    ).toMatchObject({ credits: currentCredits, fiveHourUsedPct: 46 });
    expect(state.completeRead(state.beginRead("A"), failed())).not.toHaveProperty("resetCredits");
  });

  it("replaces old windows with a partial success and never retains a date without numeric usage", () => {
    const state = new CodexQuotaState();
    state.completeRead(state.beginRead("A"), quota());
    const weekly = quota({
      fiveHourUsedPct: null,
      fiveHourLimitReached: null,
      fiveHourResetsAt: null,
      weeklyUsedPct: 75,
      fetchedAt: timestamp(1),
    });
    state.completeRead(state.beginRead("A"), weekly);
    expect(state.completeRead(state.beginRead("A"), failed())).toMatchObject({
      fiveHourUsedPct: null,
      weeklyUsedPct: 75,
      lastSuccessfulAt: timestamp(1),
    });
    state.completeRead(state.beginRead("A"), { ...weekly, weeklyUsedPct: null });
    const missing = state.completeRead(state.beginRead("A"), failed());
    expect(missing?.weeklyUsedPct).toBeNull();
    expect(missing).not.toHaveProperty("lastSuccessfulAt");
  });

  it("uses the newest read rather than an older in-flight success or failure", () => {
    const state = new CodexQuotaState();
    state.completeRead(state.beginRead("A"), quota());
    const oldSuccess = state.beginRead("A");
    const newestFailure = state.completeRead(state.beginRead("A"), failed());
    expect(
      state.completeRead(oldSuccess, quota({ fiveHourUsedPct: 100, fiveHourLimitReached: true })),
    ).toEqual(newestFailure);
    const oldFailure = state.beginRead("A");
    const newestSuccess = state.completeRead(
      state.beginRead("A"),
      quota({ fiveHourUsedPct: 49, fetchedAt: timestamp(2) }),
    );
    expect(state.completeRead(oldFailure, failed())).toEqual(newestSuccess);
    const noHistory = state.beginRead("B");
    state.beginRead("B");
    expect(state.completeRead(noHistory, quota())).toBeUndefined();
  });

  it("isolates databases, providers, credential IDs and actual identity while surviving token refresh", () => {
    const key = quotaAccountKey("one/agent.db", account);
    const state = new CodexQuotaState();
    state.completeRead(state.beginRead(key), quota());
    expect(quotaAccountKey("one/agent.db", { ...account, accessToken: "refreshed" })).toBe(key);
    for (const other of [
      quotaAccountKey("two/agent.db", account),
      quotaAccountKey("one/agent.db", { ...account, provider: "anthropic" }),
      quotaAccountKey("one/agent.db", { ...account, credentialId: 2 }),
      quotaAccountKey("one/agent.db", { ...account, identityKey: "account-two" }),
      quotaAccountKey("one/agent.db", { ...account, accountId: "codex-two" }),
      quotaAccountKey("one/agent.db", { ...account, orgId: "organization-two" }),
    ]) {
      expect(other).not.toBe(key);
      expect(state.completeRead(state.beginRead(other), failed())?.fiveHourUsedPct).toBeNull();
    }
    const anonymous = {
      ...account,
      identityKey: undefined,
      accountId: undefined,
      orgId: undefined,
    };
    expect(quotaAccountKey("one/agent.db", anonymous)).not.toBe(
      quotaAccountKey("one/agent.db", { ...anonymous, accessToken: "different" }),
    );
  });

  it("invalidates deletion and successful reset observations, including old in-flight inventory", () => {
    const state = new CodexQuotaState();
    state.completeRead(state.beginRead("A"), quota());
    const deleted = state.beginRead("A");
    state.retainAccounts(new Set());
    state.beginRead("A");
    expect(state.completeRead(deleted, quota())).toBeUndefined();
    const beforeReset = state.beginRead("A");
    state.invalidate("A");
    expect(
      state.completeRead(
        beforeReset,
        quota({ resetCredits: { status: "available", availableCount: 1, credits: [] } }),
      ),
    ).toBeUndefined();
    const unknown = state.completeRead(state.beginRead("A"), failed());
    expect(unknown?.fiveHourUsedPct).toBeNull();
    expect(unknown).not.toHaveProperty("lastSuccessfulAt");
    const recovered = state.completeRead(
      state.beginRead("A"),
      quota({ fiveHourUsedPct: 0, fetchedAt: timestamp(3) }),
    );
    expect(state.completeRead(beforeReset, quota())).toEqual(recovered);
  });
});
