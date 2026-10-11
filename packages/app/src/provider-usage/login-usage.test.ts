import { describe, expect, test } from "vitest";
import { resolveLoginProviderUsages, selectProviderUsages } from "./login-usage";
import type { ProviderUsage, ProviderUsageView } from "./types";

function cursorUsage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    providerId: "cursor",
    displayName: "Cursor",
    status: "available",
    planLabel: null,
    sourceLabel: "Cursor",
    windows: [],
    balances: [
      {
        id: "team_spend",
        label: "Monthly usage",
        used: 480.13,
        remaining: 519.87,
        limit: 1000,
        unit: "usd",
        resetsAt: "2026-09-30T00:00:00.000Z",
      },
    ],
    details: [],
    error: null,
    ...overrides,
  };
}

function readyView(providers: ProviderUsage[]): ProviderUsageView {
  return {
    kind: "ready",
    payload: { providers, fetchedAt: "2026-09-20T00:00:00.000Z" },
    isRefreshing: false,
  };
}

describe("resolveLoginProviderUsages", () => {
  test("returns cursor usage for the matching signed-in provider", () => {
    expect(resolveLoginProviderUsages(readyView([cursorUsage()]), "cursor")).toEqual([
      cursorUsage(),
    ]);
  });

  test("ignores Codex login providers that already have account quota", () => {
    expect(
      resolveLoginProviderUsages(
        readyView([cursorUsage({ providerId: "openai-codex", displayName: "Codex" })]),
        "openai-codex",
      ),
    ).toEqual([]);
  });

  test("returns no usage when the payload has nothing to render", () => {
    expect(
      resolveLoginProviderUsages(readyView([cursorUsage({ balances: [], windows: [] })]), "cursor"),
    ).toEqual([]);
    expect(resolveLoginProviderUsages({ kind: "loading" }, "cursor")).toEqual([]);
    expect(
      resolveLoginProviderUsages(readyView([cursorUsage({ status: "unavailable" })]), "cursor"),
    ).toEqual([]);
  });

  test("keeps failed and available Zhipu credentials separately without selecting the first", () => {
    const failed = cursorUsage({
      providerId: "zhipu-coding-plan:5",
      status: "unavailable",
      balances: [],
      error: "Zhipu credential rejected",
    });
    const available = cursorUsage({
      providerId: "zhipu-coding-plan:6",
      balances: [],
      windows: [
        { id: "five-hour", label: "5 hours", usedPct: 1, remainingPct: 99, resetsAt: null },
        { id: "weekly", label: "Weekly", usedPct: 1, remainingPct: 99, resetsAt: null },
      ],
    });
    const providers = [cursorUsage(), failed, available];
    expect(resolveLoginProviderUsages(readyView(providers), "zhipu-coding-plan")).toEqual([
      failed,
      available,
    ]);
    expect(selectProviderUsages(providers, "ZHIPU-CODING-PLAN")).toEqual([failed, available]);
    expect(selectProviderUsages(providers, "zhipu-coding-plan:6")).toEqual([available]);
    expect(selectProviderUsages(providers, "zhipu")).toEqual([]);
    const claudeAccounts = [
      cursorUsage({ providerId: "anthropic:7", displayName: "Claude · First" }),
      cursorUsage({ providerId: "anthropic:8", displayName: "Claude · Second" }),
    ];
    expect(selectProviderUsages([...providers, ...claudeAccounts], "ANTHROPIC")).toEqual(
      claudeAccounts,
    );
    expect(selectProviderUsages(claudeAccounts, "anthropic:8")).toEqual([claudeAccounts[1]]);
    expect(resolveLoginProviderUsages(readyView(claudeAccounts), "anthropic")).toEqual([]);
  });
});
