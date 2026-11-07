import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, test, vi } from "vitest";
import { en } from "@/i18n/resources/en";
import { ProviderUsageTooltipSection } from "./tooltip-section";
import type { ProviderUsage, ProviderUsageView } from "./types";
import type { OmpProviderAccountQuota } from "@omp-desktop/protocol/messages";
import { buildOmpAccountProviderUsage } from "./omp-account";
import { formatOmpQuotaResetTime } from "@/components/omp-provider-quota";

afterEach(() => vi.restoreAllMocks());

function usage(providerId: string, displayName: string, usedPct: number): ProviderUsage {
  return {
    providerId,
    displayName,
    status: "available",
    planLabel: null,
    windows: [{ id: "codex_weekly", label: "Weekly", usedPct, percentageDisplay: "remaining" }],
  };
}

function readyUsageView(providers: ProviderUsage[]): ProviderUsageView {
  return {
    kind: "ready",
    payload: { fetchedAt: "2026-10-08T00:00:00.000Z", providers },
    isRefreshing: false,
  };
}

async function renderUsage(activeProviderId: string, providers: ProviderUsage[]) {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ProviderUsageTooltipSection
        activeProviderId={activeProviderId}
        view={readyUsageView(providers)}
      />
    </I18nextProvider>,
  );
}

const codexAccounts = [
  usage("openai-codex:11", "Codex · Work", 42),
  usage("openai-codex:22", "Codex · Personal", 85),
];

describe("provider usage tooltip account selection", () => {
  test("shows labelled Codex accounts with their own remaining quotas for the namespace", async () => {
    const html = await renderUsage("openai-codex", [
      ...codexAccounts,
      usage("my-glm", "GLM Plan", 20),
    ]);
    expect(html).toContain("Codex · Work");
    expect(html).toContain("58%");
    expect(html).toContain("Codex · Personal");
    expect(html).toContain("15%");
    expect(html).not.toContain("GLM Plan");
  });

  test("a credential-specific request never includes another account", async () => {
    const html = await renderUsage("openai-codex:22", codexAccounts);
    expect(html).toContain("Codex · Personal");
    expect(html).toContain("15%");
    expect(html).not.toContain("Codex · Work");
    expect(html).not.toContain("58%");
  });

  test("a configured provider matches only its own namespace", async () => {
    const html = await renderUsage("my-glm", [...codexAccounts, usage("my-glm", "GLM Plan", 20)]);
    expect(html).toContain("GLM Plan");
    expect(html).not.toContain("Codex ·");
    expect(await renderUsage("unknown", codexAccounts)).toBe("");
  });

  test("renders failed Claude reads with a trusted reached-only window and distinct retry times", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T11:00:00Z"));
    const accounts = [
      {
        credentialId: 71,
        quota: {
          status: "error" as const,
          fiveHourUsedPct: null,
          fiveHourLimitReached: true,
          fiveHourResetsAt: "2026-01-01T10:00:00.000Z",
          queryError: {
            kind: "rate_limited" as const,
            httpStatus: 429,
            retryAt: "2026-01-01T08:00:39.000Z",
          },
        },
      },
    ];
    const providers = buildOmpAccountProviderUsage(
      {
        provider: { id: "anthropic", name: "Claude", available: true, authenticated: true },
        accounts,
        error: null,
        updatedAt: "2026-01-01T08:00:00.000Z",
      },
      {
        providerId: "anthropic",
        providerName: "Claude",
        fiveHour: "5-hour limit",
        weekly: "Weekly",
        modelWeekly: (model) => model,
        accountFallback: (number) => `Account ${number}`,
      },
    );
    const html = await renderUsage("anthropic", providers);
    expect(html).toContain("5-hour");
    expect(html).toContain("Limit reached");
    expect(html).toContain("Usage query rate-limited");
    expect(html).toContain("not a quota reset");
    expect(html).toContain(formatOmpQuotaResetTime(accounts[0]?.quota.queryError.retryAt, "en"));
    expect(html).toContain(formatOmpQuotaResetTime(accounts[0]?.quota.fiveHourResetsAt, "en"));
    expect(html).toContain("Awaiting server verification");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("100%");
  });

  test("keeps an unknown model 429 separate from the unknown five-hour row", async () => {
    const html = await renderUsage("anthropic", [
      {
        providerId: "anthropic:72",
        displayName: "Claude · Account 2",
        status: "error",
        planLabel: null,
        windows: [
          {
            id: "anthropic_five_hour",
            label: "5-hour limit",
            usedPct: null,
            remainingPct: null,
            percentageDisplay: "remaining",
          },
        ],
        accountQuota: {
          status: "error",
          queryError: { kind: "authentication" },
          modelRateLimit: { scope: "unknown", resetsAt: null, observedAt: "2026-01-01T08:00:00Z" },
        },
      },
    ]);
    expect(html).toContain("Usage query authentication failed");
    expect(html).toContain("Model requests rate-limited (window unknown)");
    expect(html).toContain("Usage temporarily unavailable");
    expect(html).not.toContain("Limit reached");
    expect(html).not.toContain("100%");
    expect(html).not.toContain("0%");
  });

  test("dates retained Codex values as the last observation and replaces them on recovery", async () => {
    const observedAt = "2026-01-01T08:00:00.000Z";
    const failedAt = "2026-01-01T09:00:00.000Z";
    function codexUsage(quota: OmpProviderAccountQuota) {
      return buildOmpAccountProviderUsage(
        {
          provider: { id: "openai-codex", name: "Codex", available: true, authenticated: true },
          accounts: [{ credentialId: 71, quota }],
          error: null,
          updatedAt: failedAt,
        },
        {
          providerId: "openai-codex",
          providerName: "Codex",
          accountFallback: (number) => `Account ${number}`,
          fiveHour: "5-hour",
          weekly: "Weekly",
          modelWeekly: (model) => model,
          codexCreditsLabel: "Credits",
          codexCreditsSummary: () => "Unknown",
        },
      );
    }
    const retained = codexUsage({
      status: "error",
      weeklyUsedPct: 46,
      lastSuccessfulAt: observedAt,
      fetchedAt: failedAt,
      queryError: { kind: "network" },
    });
    const failedHtml = await renderUsage("openai-codex", retained);
    expect(failedHtml).toContain("54%");
    expect(failedHtml).toContain(formatOmpQuotaResetTime(observedAt, "en"));
    expect(failedHtml).not.toContain(formatOmpQuotaResetTime(failedAt, "en"));
    const recoveredHtml = await renderUsage(
      "openai-codex",
      codexUsage({ status: "available", weeklyUsedPct: 49, fetchedAt: failedAt }),
    );
    expect(recoveredHtml).toContain("51%");
    expect(recoveredHtml).not.toContain("54%");
    expect(recoveredHtml).not.toContain(formatOmpQuotaResetTime(observedAt, "en"));
    const exhaustedHtml = await renderUsage(
      "openai-codex",
      codexUsage({
        status: "error",
        weeklyUsedPct: 100,
        fiveHourLimitReached: true,
        lastSuccessfulAt: observedAt,
        fetchedAt: failedAt,
        queryError: { kind: "network" },
      }),
    );
    expect(exhaustedHtml).toContain("0%");
    expect(exhaustedHtml).toContain(formatOmpQuotaResetTime(observedAt, "en"));
    expect(exhaustedHtml).not.toContain("Limit reached");
    const authHtml = await renderUsage(
      "openai-codex",
      codexUsage({
        status: "unavailable",
        weeklyUsedPct: null,
        queryError: { kind: "authentication" },
      }),
    );
    expect(authHtml).not.toContain("0%");
    expect(authHtml).not.toContain("100%");
    expect(authHtml).not.toContain(formatOmpQuotaResetTime(observedAt, "en"));
  });
});
