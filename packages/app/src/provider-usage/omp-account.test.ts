import { describe, expect, test } from "vitest";
import type { OmpProviderManagement } from "@omp-desktop/protocol/messages";
import { buildOmpAccountProviderUsage, mergeOmpAccountProviderUsage } from "./omp-account";
import { deriveRemainingTone } from "./tone";
import type { ProviderUsageView } from "./types";

type OmpLoginProvider = OmpProviderManagement["loginProviders"][number];

const copy = {
  providerId: "openai-codex" as const,
  providerName: "OpenAI Codex",
  accountFallback: (number: number) => `Account ${number}`,
  fiveHour: "5-hour limit",
  weekly: "Weekly limit",
  modelWeekly: (model: string) => `${model} weekly`,
};

function codexProvider(accounts: NonNullable<OmpLoginProvider["accounts"]>): OmpLoginProvider {
  return {
    id: "openai-codex",
    name: "ChatGPT Plus/Pro (Codex Subscription)",
    available: true,
    authenticated: true,
    accounts,
  };
}

describe("buildOmpAccountProviderUsage", () => {
  test("creates one usage card per account and preserves each quota window", () => {
    const providers = buildOmpAccountProviderUsage(
      {
        provider: codexProvider([
          {
            credentialId: 41,
            identityKey: "email:alice@example.com|org:personal",
            quota: {
              status: "available",
              planLabel: "plus",
              fiveHourUsedPct: 25,
              fiveHourResetsAt: "2026-09-03T01:00:00.000Z",
              weeklyUsedPct: 40,
              weeklyResetsAt: "2026-09-08T01:00:00.000Z",
              fetchedAt: "2026-09-02T20:00:00.000Z",
            },
          },
          {
            credentialId: 42,
            identityKey: "email:bob@example.com|org:team",
            quota: {
              status: "available",
              planLabel: "pro",
              fiveHourUsedPct: 10,
              weeklyUsedPct: 15,
              weeklyResetsAt: "2026-09-09T01:00:00.000Z",
              fetchedAt: "2026-09-02T20:00:00.000Z",
            },
          },
        ]),
        accounts: [
          {
            credentialId: 41,
            identityKey: "email:alice@example.com|org:personal",
            note: "Personal",
            quota: {
              status: "available",
              planLabel: "plus",
              fiveHourUsedPct: 25,
              fiveHourResetsAt: "2026-09-03T01:00:00.000Z",
              weeklyUsedPct: 40,
              weeklyResetsAt: "2026-09-08T01:00:00.000Z",
              fetchedAt: "2026-09-02T20:00:00.000Z",
            },
          },
          {
            credentialId: 42,
            identityKey: "email:bob@example.com|org:team",
            quota: {
              status: "available",
              planLabel: "pro",
              fiveHourUsedPct: 10,
              weeklyUsedPct: 15,
              weeklyResetsAt: "2026-09-09T01:00:00.000Z",
              fetchedAt: "2026-09-02T20:00:00.000Z",
            },
          },
        ],
        error: null,
        updatedAt: "2026-09-02T20:00:00.000Z",
      },
      copy,
    );

    expect(providers).toEqual([
      expect.objectContaining({
        providerId: "openai-codex:41",
        displayName: "OpenAI Codex · Personal",
        status: "available",
        planLabel: "plus",
        windows: [
          expect.objectContaining({
            id: "codex_five_hour",
            usedPct: 25,
            remainingPct: 75,
            percentageDisplay: "remaining",
          }),
          expect.objectContaining({
            id: "codex_weekly",
            usedPct: 40,
            remainingPct: 60,
            percentageDisplay: "remaining",
          }),
        ],
      }),
      expect.objectContaining({
        providerId: "openai-codex:42",
        displayName: "OpenAI Codex · bob@example.com",
        status: "available",
        planLabel: "pro",
        windows: [
          expect.objectContaining({
            id: "codex_five_hour",
            usedPct: 10,
            remainingPct: 90,
            percentageDisplay: "remaining",
          }),
          expect.objectContaining({
            id: "codex_weekly",
            usedPct: 15,
            remainingPct: 85,
            percentageDisplay: "remaining",
          }),
        ],
      }),
    ]);
  });

  test("only creates reported windows and never treats unknown usage as 100% remaining", () => {
    const accounts = [
      {
        credentialId: 1,
        quota: {
          status: "available" as const,
          planLabel: "pro",
          fiveHourUsedPct: null,
          weeklyUsedPct: null,
          weeklyResetsAt: "2026-09-08T01:00:00.000Z",
          fetchedAt: "2026-09-02T20:00:00.000Z",
        },
      },
      {
        credentialId: 2,
        quota: {
          status: "available" as const,
          planLabel: "pro",
          fiveHourUsedPct: 0,
          fiveHourResetsAt: "2026-09-03T01:00:00.000Z",
          weeklyUsedPct: 100,
          fetchedAt: "2026-09-02T20:00:00.000Z",
        },
      },
      {
        credentialId: 3,
        quota: {
          status: "available" as const,
          planLabel: "plus",
          fiveHourUsedPct: null,
          fiveHourResetsAt: "2026-09-03T01:00:00.000Z",
          weeklyUsedPct: null,
          fetchedAt: "2026-09-02T20:00:00.000Z",
        },
      },
    ];
    const providers = buildOmpAccountProviderUsage(
      { provider: codexProvider(accounts), accounts, error: null, updatedAt: null },
      copy,
    );
    expect(providers[0]?.windows).toEqual([
      expect.objectContaining({
        id: "codex_weekly",
        usedPct: null,
        remainingPct: null,
        resetsAt: "2026-09-08T01:00:00.000Z",
      }),
    ]);
    expect(providers[1]?.windows).toEqual([
      expect.objectContaining({
        id: "codex_five_hour",
        usedPct: 0,
        remainingPct: 100,
      }),
      expect.objectContaining({
        id: "codex_weekly",
        usedPct: 100,
        remainingPct: 0,
      }),
    ]);
    expect(providers[2]?.windows).toEqual([
      expect.objectContaining({
        id: "codex_five_hour",
        usedPct: null,
        remainingPct: null,
        resetsAt: "2026-09-03T01:00:00.000Z",
      }),
    ]);
  });

  test("keeps stable account numbers after deletion, replacement, and reordering", () => {
    const accounts = [
      { credentialId: 30, accountNumber: 3 },
      { credentialId: 61, accountNumber: 1 },
      { credentialId: 62, accountNumber: 2 },
    ];
    const providers = buildOmpAccountProviderUsage(
      {
        provider: codexProvider(accounts),
        accounts,
        error: null,
        updatedAt: null,
      },
      copy,
    );
    expect(providers.map(({ providerId, displayName }) => ({ providerId, displayName }))).toEqual([
      { providerId: "openai-codex:30", displayName: "OpenAI Codex · Account 3" },
      { providerId: "openai-codex:61", displayName: "OpenAI Codex · Account 1" },
      { providerId: "openai-codex:62", displayName: "OpenAI Codex · Account 2" },
    ]);
  });

  test("shows an unavailable Codex card when no subscription account is signed in", () => {
    expect(
      buildOmpAccountProviderUsage(
        {
          provider: codexProvider([]),
          accounts: [],
          error: null,
          updatedAt: "2026-09-02T20:00:00.000Z",
        },
        copy,
      ),
    ).toEqual([
      expect.objectContaining({
        providerId: "openai-codex",
        displayName: "OpenAI Codex",
        status: "unavailable",
        windows: [],
      }),
    ]);
  });

  test("uses remaining-capacity tones for Codex quota bars", () => {
    expect(deriveRemainingTone(39)).toBe("ok");
    expect(deriveRemainingTone(30)).toBe("warning");
    expect(deriveRemainingTone(0)).toBe("danger");
  });

  test("keeps each Claude account's model windows and spending without filling unknowns", () => {
    const accounts: NonNullable<OmpLoginProvider["accounts"]> = [
      {
        credentialId: 71,
        identityKey: "email:first@example.com",
        quota: {
          status: "available",
          fiveHourUsedPct: 20,
          weeklyUsedPct: 35,
          modelWindows: [
            { model: "opus", usedPct: 60, resetsAt: "2026-10-15T10:00:00.000Z" },
            { model: "new_model", usedPct: null, resetsAt: null },
          ],
          extraUsage: { enabled: true, usedUsd: 1.23, monthlyLimitUsd: null, usedPct: null },
        },
      },
      {
        credentialId: 72,
        quota: {
          status: "available",
          weeklyUsedPct: 80,
          extraUsage: { enabled: false, usedUsd: null, monthlyLimitUsd: 0, usedPct: null },
        },
      },
      { credentialId: 73, quota: { status: "available", weeklyUsedPct: 10 } },
    ];
    const provider = { ...codexProvider(accounts), id: "anthropic", name: "Claude" };
    const usage = buildOmpAccountProviderUsage(
      { provider, accounts, error: null, updatedAt: null },
      { ...copy, providerId: "anthropic", providerName: "Claude" },
    );
    expect(usage.map((account) => account.providerId)).toEqual([
      "anthropic:71",
      "anthropic:72",
      "anthropic:73",
    ]);
    expect(usage[0]?.windows).toEqual([
      expect.objectContaining({ id: "anthropic_five_hour", remainingPct: 80 }),
      expect.objectContaining({ id: "anthropic_weekly", remainingPct: 65 }),
      expect.objectContaining({
        id: "anthropic_weekly_opus",
        label: "opus weekly",
        remainingPct: 40,
        resetsAt: "2026-10-15T10:00:00.000Z",
      }),
      expect.objectContaining({
        label: "new_model weekly",
        usedPct: null,
        remainingPct: null,
        resetsAt: null,
      }),
    ]);
    expect(usage[0]?.extraUsage).toEqual(accounts[0]?.quota?.extraUsage);
    expect(usage[1]?.windows).toEqual([
      expect.objectContaining({ id: "anthropic_weekly", remainingPct: 20 }),
    ]);
    expect(usage[1]?.extraUsage).toEqual(accounts[1]?.quota?.extraUsage);
    expect(usage[2]?.extraUsage).toBeUndefined();
  });
});

describe("mergeOmpAccountProviderUsage", () => {
  test("prepends Codex accounts while retaining other provider usage", () => {
    const view: ProviderUsageView = {
      kind: "ready",
      payload: {
        fetchedAt: "2026-09-02T20:00:00.000Z",
        providers: [
          {
            providerId: "cursor",
            displayName: "Cursor",
            status: "unavailable",
            planLabel: null,
            windows: [],
          },
        ],
      },
      isRefreshing: false,
    };
    const codex = [
      {
        providerId: "openai-codex:41",
        displayName: "OpenAI Codex · alice@example.com",
        status: "available" as const,
        planLabel: "plus",
        windows: [],
      },
    ];

    expect(
      mergeOmpAccountProviderUsage(view, codex, false, "2026-09-02T20:00:00.000Z"),
    ).toMatchObject({
      kind: "ready",
      payload: {
        providers: [{ providerId: "openai-codex:41" }, { providerId: "cursor" }],
      },
      isRefreshing: false,
    });
  });

  test("shows ready Codex data while the generic provider request is still loading", () => {
    const codex = [
      {
        providerId: "openai-codex:41",
        displayName: "OpenAI Codex · alice@example.com",
        status: "available" as const,
        planLabel: "plus",
        windows: [],
      },
    ];

    expect(
      mergeOmpAccountProviderUsage({ kind: "loading" }, codex, false, "2026-09-02T20:00:00.000Z"),
    ).toMatchObject({
      kind: "ready",
      payload: { providers: [{ providerId: "openai-codex:41" }] },
      isRefreshing: true,
    });
  });

  test("replaces both official summaries while retaining unrelated namespaces", () => {
    const accounts = ["openai-codex:41", "anthropic:71", "anthropic:72"].map((providerId) => ({
      providerId,
      displayName: providerId,
      status: "available" as const,
      planLabel: null,
      windows: [],
    }));
    const existing = ["anthropic", "anthropic:99", "openai-codex", "anthropic-custom"].map(
      (providerId) => Object.assign({}, accounts[0], { providerId }),
    );
    const result = mergeOmpAccountProviderUsage(
      {
        kind: "ready",
        payload: { fetchedAt: "2026-10-11T00:00:00.000Z", providers: existing },
        isRefreshing: false,
      },
      accounts,
      false,
      "2026-10-11T00:00:00.000Z",
    );
    expect(
      result.kind === "ready" && result.payload.providers.map((account) => account.providerId),
    ).toEqual(["openai-codex:41", "anthropic:71", "anthropic:72", "anthropic-custom"]);
  });
});
