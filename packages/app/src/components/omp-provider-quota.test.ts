import { describe, expect, test } from "vitest";
import {
  formatOmpQuotaResetTime,
  formatOmpQuotaCountdown,
  isOmpCodexResetCreditUsable,
  resolveOmpRemainingQuotaPct,
  shouldShowOmpFiveHourQuota,
} from "./omp-provider-quota";

describe("OMP provider quota percentage", () => {
  test.each([
    [0, 100],
    [42, 58],
    [100, 0],
    [-10, 100],
    [125, 0],
    [42.5, 57.5],
  ])("converts %s%% used into %s%% remaining", (usedPct, expected) => {
    expect(resolveOmpRemainingQuotaPct(usedPct)).toBe(expected);
  });

  test("returns null when the provider did not report usage", () => {
    expect(resolveOmpRemainingQuotaPct(null)).toBeNull();
    expect(resolveOmpRemainingQuotaPct(undefined)).toBeNull();
    expect(resolveOmpRemainingQuotaPct(Number.NaN)).toBeNull();
  });
});

describe("OMP provider quota reset time", () => {
  test("includes the localized calendar date and time", () => {
    const result = formatOmpQuotaResetTime("2026-06-15T11:03:00.000Z", "zh-CN");

    expect(result).toContain("2026");
    expect(result).toContain("6");
    expect(result).toContain("15");
  });

  test.each([null, undefined, "", "not-a-date"])("omits invalid reset time %s", (value) => {
    expect(formatOmpQuotaResetTime(value, "zh-CN")).toBeNull();
  });
});

describe("OMP provider quota windows", () => {
  test.each(["pro", " PRO ", "Pro", "plus", "team", null, undefined])(
    "hides the five-hour window for %s when no five-hour data exists",
    (planLabel) => {
      expect(shouldShowOmpFiveHourQuota({ planLabel })).toBe(false);
    },
  );

  test.each(["pro", "plus", null])("shows a real five-hour window for %s", (planLabel) => {
    expect(shouldShowOmpFiveHourQuota({ planLabel, fiveHourUsedPct: 0 })).toBe(true);
    expect(
      shouldShowOmpFiveHourQuota({
        planLabel,
        fiveHourUsedPct: null,
        fiveHourResetsAt: "2026-09-03T01:00:00.000Z",
      }),
    ).toBe(true);
  });

  test("does not turn unknown usage into a five-hour window", () => {
    expect(shouldShowOmpFiveHourQuota(null)).toBe(false);
    expect(shouldShowOmpFiveHourQuota({ fiveHourUsedPct: Number.NaN })).toBe(false);
    expect(shouldShowOmpFiveHourQuota({ fiveHourUsedPct: null, fiveHourResetsAt: "" })).toBe(false);
  });
});

describe("OMP quota countdown boundaries", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  test.each([
    [93 * 60 * 60_000, "3d21h"],
    [132 * 60_000, "2h12min"],
    [1, "0h1min"],
    [0, ""],
    [-60_000, ""],
  ])("formats remaining duration %s without negative or premature reset", (remaining, expected) => {
    expect(formatOmpQuotaCountdown(new Date(now + remaining).toISOString(), now)).toBe(expected);
  });
  test("does not turn missing or invalid server timestamps into reset", () => {
    expect(formatOmpQuotaCountdown(undefined, now)).toBeNull();
    expect(formatOmpQuotaCountdown("invalid", now)).toBeNull();
  });
});

describe("Codex reset-card eligibility", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  const available = { status: "available", resetType: "codex_rate_limits", expiresAt: null };
  test("accepts only known available cards with a future or absent expiry", () => {
    expect(isOmpCodexResetCreditUsable(available, now)).toBe(true);
    expect(
      isOmpCodexResetCreditUsable(
        { ...available, expiresAt: new Date(now + 1).toISOString() },
        now,
      ),
    ).toBe(true);
    for (const patch of [
      { status: "used" },
      { status: "new_server_status" },
      { resetType: "new_server_type" },
      { expiresAt: new Date(now).toISOString() },
      { expiresAt: new Date(now - 1).toISOString() },
      { expiresAt: "invalid" },
    ])
      expect(isOmpCodexResetCreditUsable({ ...available, ...patch }, now)).toBe(false);
  });
});
