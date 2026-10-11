import { createInstance } from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/resources/en";
import { zhCN } from "@/i18n/resources/zh-CN";
import {
  formatAgo,
  formatAmount,
  formatOmpExtraUsageUsd,
  formatProviderUsageLabel,
  formatResetLabel,
} from "./format";
import { formatOmpModelQuotaLabel } from "./omp-account";

async function translator(language: "en" | "zh-CN") {
  const instance = createInstance();
  await instance.init({
    lng: language,
    fallbackLng: "en",
    resources: {
      en: { translation: en },
      "zh-CN": { translation: zhCN },
    },
    interpolation: { escapeValue: false },
  });
  return instance.t;
}

afterEach(() => vi.useRealTimers());

describe("provider usage localization", () => {
  it("localizes stable server labels and keeps unknown provider labels", async () => {
    const t = await translator("zh-CN");

    expect(formatProviderUsageLabel("balance", "Balance", t)).toBe("余额");
    expect(formatProviderUsageLabel("team_spend", "Monthly usage", t)).toBe("月度用量");
    expect(formatProviderUsageLabel("vendor-window", "Vendor window", t)).toBe("Vendor window");
  });

  it("localizes remaining balance, reset time, and updated time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
    const t = await translator("zh-CN");
    const resetAt = "2026-09-30T00:00:00.000Z";
    const updatedAt = "2026-09-01T22:00:00.000Z";

    expect(t("providerUsage.amountLeft", { amount: formatAmount(12.5, "usd", "zh-CN") })).toBe(
      "剩余 US$12.50",
    );
    expect(formatResetLabel(resetAt, t)).toBe("28天后重置");
    expect(formatAgo(updatedAt, t)).toBe("2小时前");
  });
  it("keeps known model names and literal unknown suffixes in localized weekly labels", async () => {
    const t = await translator("zh-CN");
    expect(formatOmpModelQuotaLabel("opus", t)).toBe("Opus 每周");
    expect(formatOmpModelQuotaLabel("sonnet", t)).toBe("Sonnet 每周");
    expect(formatOmpModelQuotaLabel("new_model", t)).toBe("new_model 每周");
  });

  it("displays USD including zero without inventing money for unknown or malformed amounts", () => {
    expect(formatOmpExtraUsageUsd(12.5, "Unknown", "en-US")).toBe("$12.50");
    expect(formatOmpExtraUsageUsd(0, "Unknown", "en-US")).toBe("$0.00");
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(formatOmpExtraUsageUsd(value, "Unknown", "en-US")).toBe("Unknown");
    }
  });
});
