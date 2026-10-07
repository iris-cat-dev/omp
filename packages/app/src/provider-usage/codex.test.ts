import { describe, expect, test } from "vitest";
import type { OmpProviderManagement } from "@omp-desktop/protocol/messages";
import { buildCodexProviderUsage, mergeCodexProviderUsage } from "./codex";
import { deriveRemainingTone } from "./tone";
import type { ProviderUsageView } from "./types";

type OmpLoginProvider = OmpProviderManagement["loginProviders"][number];

const copy = {
  providerName: "OpenAI Codex",
  accountFallback: (number: number) => `Account ${number}`,
  fiveHour: "5-hour limit",
  weekly: "Weekly limit",
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

describe("buildCodexProviderUsage", () => {
  test("creates one usage card per account and preserves each quota window", () => {
    const providers = buildCodexProviderUsage(
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
            id: "codex_weekly",
            usedPct: 15,
            remainingPct: 85,
            percentageDisplay: "remaining",
          }),
        ],
      }),
    ]);
  });

  test("keeps stable account numbers after deletion, replacement, and reordering", () => {
    const accounts = [
      { credentialId: 30, accountNumber: 3 },
      { credentialId: 61, accountNumber: 1 },
      { credentialId: 62, accountNumber: 2 },
    ];
    const providers = buildCodexProviderUsage(
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
      buildCodexProviderUsage(
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
});

describe("mergeCodexProviderUsage", () => {
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

    expect(mergeCodexProviderUsage(view, codex, false, "2026-09-02T20:00:00.000Z")).toMatchObject({
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
      mergeCodexProviderUsage({ kind: "loading" }, codex, false, "2026-09-02T20:00:00.000Z"),
    ).toMatchObject({
      kind: "ready",
      payload: { providers: [{ providerId: "openai-codex:41" }] },
      isRefreshing: true,
    });
  });
});
