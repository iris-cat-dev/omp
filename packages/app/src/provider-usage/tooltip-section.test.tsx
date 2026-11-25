/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, test, vi } from "vitest";
import { en } from "@/i18n/resources/en";
import { ProviderUsageTooltipSection } from "./tooltip-section";
import type { ProviderUsage, ProviderUsageView } from "./types";
import type { OmpProviderAccountQuota } from "@omp-desktop/protocol/messages";
import { buildOmpAccountProviderUsage } from "./omp-account";
import { formatOmpQuotaResetTime } from "@/components/omp-provider-quota";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <ProviderUsageTooltipSection
        activeProviderId={activeProviderId}
        view={readyUsageView(providers)}
      />
    </I18nextProvider>,
  );
  return {
    get text() { return container.textContent ?? ""; },
    get bars() { return within(container).queryAllByRole("progressbar"); },
    queries: within(container),
  };
}

const codexAccounts = [
  usage("openai-codex:11", "Codex · Work", 42),
  usage("openai-codex:22", "Codex · Personal", 85),
];

describe("provider usage tooltip account selection", () => {
  test("shows labelled Codex accounts with their own remaining quotas for the namespace", async () => {
    const { text } = await renderUsage("openai-codex", [
      ...codexAccounts,
      usage("my-glm", "GLM Plan", 20),
    ]);
    expect(text).toContain("Codex · Work");
    expect(text).toContain("58%");
    expect(text).toContain("Codex · Personal");
    expect(text).toContain("15%");
    expect(text).not.toContain("GLM Plan");
  });

  test("multiple normalized accounts stay distinguishable while their metadata is collapsed", async () => {
    const view = await renderUsage("openai-codex", codexAccounts.map((account, index) => ({
      ...account,
      accountLabel: index === 0 ? "Work" : "Personal",
      sourceLabel: "Codex",
      planLabel: index === 0 ? "Pro200" : "Plus",
    })));
    const work = view.queries.getByRole("button", { name: "Codex Work" });
    const personal = view.queries.getByRole("button", { name: "Codex Personal" });
    expect(view.text).not.toContain("Pro200");
    expect(view.text).not.toContain("Plus");
    fireEvent.click(personal);
    expect(view.text).toContain("Plus");
    expect(view.text).not.toContain("Pro200");
    expect(work.getAttribute("aria-expanded")).toBe("false");
  });

  test("a credential-specific request never includes another account", async () => {
    const { text } = await renderUsage("openai-codex:22", codexAccounts);
    expect(text).toContain("Codex · Personal");
    expect(text).toContain("15%");
    expect(text).not.toContain("Codex · Work");
    expect(text).not.toContain("58%");
  });

  test("a configured provider matches only its own namespace", async () => {
    const { text } = await renderUsage("my-glm", [
      ...codexAccounts,
      usage("my-glm", "GLM Plan", 20),
    ]);
    expect(text).toContain("GLM Plan");
    expect(text).not.toContain("Codex ·");
    expect((await renderUsage("unknown", codexAccounts)).text).toBe("");
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
    const view = await renderUsage("anthropic", providers);
    const { text, bars } = view;
    expect(text).toContain("5-hour");
    expect(text).toContain("Limit reached");
    expect(text).toContain("Usage query rate-limited");
    expect(text).toContain("not a quota reset");
    expect(text).toContain(formatOmpQuotaResetTime(accounts[0]?.quota.queryError.retryAt, "en"));
    const resetAt = formatOmpQuotaResetTime(accounts[0]?.quota.fiveHourResetsAt, "en");
    expect(text).not.toContain(resetAt);
    expect(text).toContain("Awaiting server verification");
    expect(bars).toHaveLength(0);
    expect(text).not.toMatch(/\d%/);
    fireEvent.click(view.queries.getByRole("button", { name: /Claude/ }));
    expect(view.text).toContain(resetAt);
    expect(view.text).toContain("not a quota reset");
  });

  test("keeps an unknown model 429 separate from the unknown five-hour row", async () => {
    const { text, bars } = await renderUsage("anthropic", [
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
    expect(text).toContain("Usage query authentication failed");
    expect(text).toContain("Model requests rate-limited (window unknown)");
    expect(text).toContain("Usage temporarily unavailable");
    expect(text).not.toContain("Limit reached");
    expect(text).not.toMatch(/\d%/);
    expect(bars).toHaveLength(0);
  });

  test("discloses the selected credential, precise credit, reset and freshness without duplicating the quota", async () => {
    const resetsAt = "2099-12-30T08:00:00Z";
    const exact = "9007199254740993.0000100";
    const account: ProviderUsage = {
      ...usage("openai-codex:71", "OpenAI Codex · Work", 55),
      accountLabel: "Work",
      sourceLabel: "OpenAI Codex",
      planLabel: "Pro200",
      fetchedAt: "2026-01-01T08:00:00Z",
      windows: [{ id: "weekly", label: "Weekly", usedPct: 55, percentageDisplay: "remaining", resetsAt }],
      accountQuota: { status: "available", credits: { hasCredits: true, unlimited: false, balance: exact } },
      details: [{ id: "codex_credits", label: "Codex credits", value: `Remaining: ${exact} credits` }],
    };
    const view = await renderUsage("openai-codex:71", [account]);
    const heading = view.queries.getByRole("button", { name: /OpenAI Codex/ });
    const reset = formatOmpQuotaResetTime(resetsAt, "en");
    expect(view.text).toContain("45% left");
    expect(view.bars).toHaveLength(1);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    for (const secondary of ["Work", "Pro200", "Credit balance", exact, reset, "Updated"]) {
      expect(view.text).not.toContain(secondary);
    }
    fireEvent.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    for (const secondary of ["Work", "Pro200", "Credit balance", exact, reset, "Updated"]) {
      expect(view.text).toContain(secondary);
    }
    expect(view.bars).toHaveLength(1);
    fireEvent.click(heading);
    expect(view.text).not.toContain(exact);
    expect(view.text).toContain("45% left");
  });

  test("prioritizes a known credit over an unknown quota and discloses its exact decimal", async () => {
    const exact = "9007199254740993.0000100";
    const view = await renderUsage("openai-codex", [{
      providerId: "openai-codex:71",
      displayName: "Codex",
      status: "available",
      planLabel: null,
      windows: [{ id: "weekly", label: "Weekly", usedPct: null, percentageDisplay: "remaining" }],
      accountQuota: { status: "available", credits: { unlimited: false, hasCredits: true, balance: exact } },
      details: [{ id: "codex_credits", label: "Codex credits", value: `Remaining: ${exact} credits` }],
    }]);
    expect(view.text).toContain("Credit balance");
    expect(view.text).toContain("≈");
    expect(view.text).not.toContain(exact);
    expect(view.text).not.toContain("Weekly");
    expect(view.bars).toHaveLength(0);
    fireEvent.click(view.queries.getByRole("button", { name: /Codex/ }));
    expect(view.text).toContain(exact);
    expect(view.text).toContain("Usage temporarily unavailable");
  });

  test("keeps a restricted secondary window visible and discloses ordinary windows and extra usage", async () => {
    const view = await renderUsage("anthropic", [{
      ...usage("anthropic:7", "Claude", 50),
      windows: [
        { id: "five-hour", label: "5-hour", usedPct: 40, percentageDisplay: "remaining" },
        { id: "sonnet", label: "Sonnet weekly", usedPct: 100, percentageDisplay: "remaining" },
        { id: "opus", label: "Opus weekly", usedPct: 25, percentageDisplay: "remaining" },
      ],
      extraUsage: { enabled: true, usedUsd: 12.5, monthlyLimitUsd: 20, usedPct: 62.5 },
    }]);
    expect(view.bars.map((bar) => bar.getAttribute("aria-valuenow"))).toEqual(["60", "0"]);
    expect(view.text).toContain("Sonnet weekly");
    expect(view.text).not.toContain("Opus weekly");
    expect(view.text).not.toContain("Extra usage");
    fireEvent.click(view.queries.getByRole("button", { name: /Claude/ }));
    expect(view.bars.map((bar) => bar.getAttribute("aria-valuenow"))).toEqual(["60", "0", "75"]);
    expect(view.text).toContain("Opus weekly");
    expect(view.text).toContain("$12.50");
    expect(view.queries.getByRole("link")).toBeTruthy();
  });

  test("a generic balance headline discloses accurate units, precision and secondary fields", async () => {
    const view = await renderUsage("gateway", [{
      ...usage("gateway", "Gateway", 0),
      windows: [],
      balances: [
        { id: "balance", label: "Balance", unit: "usd", remaining: 12345678.12345 },
        { id: "quota", label: "Requests", unit: "requests", used: 10, limit: 20 },
      ],
      details: [{ id: "restricted", label: "Access", value: "Read-only", tone: "warning" }],
    }]);
    expect(view.text).toContain("≈$12.3M left");
    expect(view.text).toContain("Read-only");
    expect(view.text).not.toContain("API key quota");
    fireEvent.click(view.queries.getByRole("button", { name: /Gateway/ }));
    expect(view.text).toContain("$12,345,678.12345 left");
    expect(view.text).toContain("API key quota");
    expect(view.text).toContain("10 / 20 used");
  });

  test("a sole balance remains visible without a disclosure that would reveal nothing", async () => {
    const view = await renderUsage("wallet", [{
      ...usage("wallet", "Wallet provider", 0),
      windows: [],
      balances: [{ id: "balance", label: "Balance", unit: "usd", remaining: 12.5 }],
    }]);
    expect(view.text).toContain("$12.50 left");
    expect(view.queries.queryByRole("button")).toBeNull();
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
    const failed = await renderUsage("openai-codex", retained);
    expect(failed.bars.map((bar) => bar.getAttribute("aria-valuenow"))).toEqual(["54"]);
    expect(failed.text).toContain("54%");
    expect(failed.text).toContain(formatOmpQuotaResetTime(observedAt, "en"));
    expect(failed.text).not.toContain(formatOmpQuotaResetTime(failedAt, "en"));
    const recovered = await renderUsage(
      "openai-codex",
      codexUsage({ status: "available", weeklyUsedPct: 49, fetchedAt: failedAt }),
    );
    expect(recovered.bars.map((bar) => bar.getAttribute("aria-valuenow"))).toEqual(["51"]);
    expect(recovered.text).toContain("51%");
    expect(recovered.text).not.toContain("54%");
    expect(recovered.text).not.toContain(formatOmpQuotaResetTime(observedAt, "en"));
    const exhausted = await renderUsage(
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
    expect(exhausted.bars.map((bar) => bar.getAttribute("aria-valuenow"))).toEqual(["0"]);
    expect(exhausted.text).toMatch(/(?:^|\D)0%/);
    expect(exhausted.text).toContain(formatOmpQuotaResetTime(observedAt, "en"));
    expect(exhausted.text).not.toContain("Limit reached");
    const auth = await renderUsage(
      "openai-codex",
      codexUsage({
        status: "unavailable",
        weeklyUsedPct: null,
        queryError: { kind: "authentication" },
      }),
    );
    expect(auth.bars).toHaveLength(0);
    expect(auth.text).not.toMatch(/\d%/);
    expect(auth.text).not.toContain(formatOmpQuotaResetTime(observedAt, "en"));
  });
});
