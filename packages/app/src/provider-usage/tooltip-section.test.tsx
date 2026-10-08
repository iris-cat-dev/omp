import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { describe, expect, test } from "vitest";
import { en } from "@/i18n/resources/en";
import { ProviderUsageTooltipSection } from "./tooltip-section";
import type { ProviderUsage } from "./types";

function usage(providerId: string, displayName: string, usedPct: number): ProviderUsage {
  return {
    providerId,
    displayName,
    status: "available",
    planLabel: null,
    windows: [{ id: "codex_weekly", label: "Weekly", usedPct, percentageDisplay: "remaining" }],
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
        view={{
          kind: "ready",
          payload: { fetchedAt: "2026-10-08T00:00:00.000Z", providers },
          isRefreshing: false,
        }}
      />
    </I18nextProvider>,
  );
}

const accounts = [
  usage("openai-codex:11", "Codex · Work", 42),
  usage("openai-codex:22", "Codex · Personal", 85),
];

describe("provider usage tooltip account selection", () => {
  test("shows labelled Codex accounts with their own remaining quotas for the namespace", async () => {
    const html = await renderUsage("openai-codex", [...accounts, usage("my-glm", "GLM Plan", 20)]);
    expect(html).toContain("Codex · Work");
    expect(html).toContain("58%");
    expect(html).toContain("Codex · Personal");
    expect(html).toContain("15%");
    expect(html).not.toContain("GLM Plan");
  });

  test("a credential-specific request never includes another account", async () => {
    const html = await renderUsage("openai-codex:22", accounts);
    expect(html).toContain("Codex · Personal");
    expect(html).toContain("15%");
    expect(html).not.toContain("Codex · Work");
    expect(html).not.toContain("58%");
  });

  test("a configured provider matches only its own namespace", async () => {
    const html = await renderUsage("my-glm", [...accounts, usage("my-glm", "GLM Plan", 20)]);
    expect(html).toContain("GLM Plan");
    expect(html).not.toContain("Codex ·");
    expect(await renderUsage("unknown", accounts)).toBe("");
  });
});
