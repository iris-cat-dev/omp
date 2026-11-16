/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createInstance, type i18n as I18n } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerUsage } from "@/i18n/resources/provider-usage";
import { openExternalUrl } from "@/utils/open-external-url";
import { ProviderUsageCard } from "./card";
import { ProviderUsageTooltipSection } from "./tooltip-section";
import type { ProviderUsage, ProviderUsageView } from "./types";

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => undefined),
}));

let i18n: I18n;

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: { providerUsage: providerUsage.en } } },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function unsupportedUsage(): ProviderUsage {
  return {
    providerId: "official-openai",
    displayName: "OpenAI official API",
    status: "unavailable",
    unsupportedReason: "openai_balance_credentials",
    planLabel: null,
    windows: [],
    balances: [],
    details: [],
    error: null,
  };
}

function readyUsageView(usage: ProviderUsage): ProviderUsageView {
  return {
    kind: "ready",
    isRefreshing: false,
    payload: { fetchedAt: "2026-11-16T00:00:00.000Z", providers: [usage] },
  };
}

function page(surface: "settings card" | "context tooltip", usage: ProviderUsage) {
  const view = readyUsageView(usage);
  return (
    <I18nextProvider i18n={i18n}>
      {surface === "settings card" ? (
        <ProviderUsageCard usage={usage} />
      ) : (
        <ProviderUsageTooltipSection activeProviderId={usage.providerId} view={view} />
      )}
    </I18nextProvider>
  );
}

describe.each(["settings card", "context tooltip"] as const)("%s balance capability", (surface) => {
  it("offers official billing and usage navigation without inventing a balance or a request error", () => {
    render(page(surface, unsupportedUsage()));
    const notice = screen.getByTestId("provider-usage-unsupported-notice");
    const links = within(notice).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(screen.queryByTestId("provider-usage-metrics")).toBeNull();
    expect(screen.queryByTestId("provider-usage-error")).toBeNull();
    for (const link of links) fireEvent.click(link);
    expect(openExternalUrl).toHaveBeenCalledTimes(2);
    expect(openExternalUrl).toHaveBeenNthCalledWith(
      1,
      "https://platform.openai.com/settings/organization/billing/overview",
    );
    expect(openExternalUrl).toHaveBeenNthCalledWith(2, "https://platform.openai.com/usage");
  });

  it("keeps a genuine usage request failure distinct from unsupported credentials", () => {
    const usage = unsupportedUsage();
    delete usage.unsupportedReason;
    usage.status = "error";
    usage.error = "Sanitized provider request failure";
    render(page(surface, usage));
    expect(screen.getByTestId("provider-usage-error").textContent).toBe(usage.error);
    expect(screen.queryByTestId("provider-usage-unsupported-notice")).toBeNull();
    expect(screen.queryByTestId("provider-usage-metrics")).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("replaces unsupported capability with a real third-party balance, including a recorded zero", () => {
    const view = render(page(surface, unsupportedUsage()));
    const usage = unsupportedUsage();
    delete usage.unsupportedReason;
    usage.status = "available";
    usage.balances = [{ id: "balance", label: "Balance", remaining: 12.5, unit: "usd" }];
    view.rerender(page(surface, usage));
    expect(screen.queryByTestId("provider-usage-unsupported-notice")).toBeNull();
    expect(screen.queryByTestId("provider-usage-error")).toBeNull();
    expect(screen.getByTestId("provider-usage-metrics").textContent).toContain("$12.50");
    view.rerender(
      page(surface, {
        ...usage,
        balances: [{ id: "balance", label: "Balance", remaining: 0, unit: "usd" }],
      }),
    );
    expect(screen.getByTestId("provider-usage-metrics").textContent).toContain("$0.00");
    expect(screen.getByTestId("provider-usage-metrics").textContent).not.toContain("$12.50");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
