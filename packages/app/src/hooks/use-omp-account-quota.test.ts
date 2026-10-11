import { QueryClient } from "@tanstack/react-query";
import type { OmpProviderManagement } from "@omp-desktop/protocol/messages";
import { describe, expect, test, vi } from "vitest";

import {
  fetchOmpAccountQuotaManagement,
  ompProviderManagementQueryKey,
  refreshOmpAccountQuotaManagement,
  resolveOmpQuotaProviderId,
} from "./use-omp-account-quota";

function management(quota?: { status: "available"; weeklyUsedPct: number }): OmpProviderManagement {
  return {
    configPath: "/tmp/models.yml",
    configYaml: "providers: {}\n",
    providerModels: [],
    loginProviders: [
      {
        id: "openai-codex",
        name: "OpenAI Codex",
        available: true,
        authenticated: true,
        accounts: [
          {
            credentialId: 5,
            ...(quota
              ? {
                  quota: {
                    status: quota.status,
                    weeklyUsedPct: quota.weeklyUsedPct,
                  },
                }
              : {}),
          },
        ],
      },
    ],
  };
}

describe("fetchOmpAccountQuotaManagement", () => {
  test("retries a cold-start response that has an account without quota", async () => {
    const first = management();
    const refreshed = management({ status: "available", weeklyUsedPct: 17 });
    const getOmpProviderManagement = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(refreshed);
    const waitForRetry = vi.fn(async () => undefined);

    await expect(
      fetchOmpAccountQuotaManagement({ getOmpProviderManagement }, waitForRetry),
    ).resolves.toBe(refreshed);

    expect(waitForRetry).toHaveBeenCalledOnce();
    expect(getOmpProviderManagement).toHaveBeenCalledTimes(2);
  });

  test("does not retry an available quota response", async () => {
    const available = management({ status: "available", weeklyUsedPct: 17 });
    const getOmpProviderManagement = vi.fn(async () => available);
    const waitForRetry = vi.fn(async () => undefined);

    await expect(
      fetchOmpAccountQuotaManagement({ getOmpProviderManagement }, waitForRetry),
    ).resolves.toBe(available);

    expect(waitForRetry).not.toHaveBeenCalled();
    expect(getOmpProviderManagement).toHaveBeenCalledOnce();
  });
});

describe("shared quota/cards refresh", () => {
  test("discarding an older in-flight read prevents stale quota from overwriting a post-reset snapshot", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const older = Promise.withResolvers<OmpProviderManagement>();
    const queryKey = ompProviderManagementQueryKey("test");
    const stale = management({ status: "available", weeklyUsedPct: 100 });
    const fresh = management({ status: "available", weeklyUsedPct: 0 });
    const oldRead = queryClient
      .fetchQuery({ queryKey, queryFn: () => older.promise })
      .catch(() => undefined);
    const getOmpProviderManagement = vi.fn(async () => fresh);
    try {
      await Promise.all([
        refreshOmpAccountQuotaManagement(queryClient, { getOmpProviderManagement }, "test"),
        refreshOmpAccountQuotaManagement(queryClient, { getOmpProviderManagement }, "test"),
      ]);
      older.resolve(stale);
      await oldRead;
      expect(queryClient.getQueryData(queryKey)).toEqual(fresh);
      expect(getOmpProviderManagement).toHaveBeenCalledTimes(1);
    } finally {
      older.resolve(stale);
      await queryClient.cancelQueries();
      queryClient.clear();
    }
  });
});

describe("quota provider matching", () => {
  test("uses only the selected official provider namespace", () => {
    expect(resolveOmpQuotaProviderId("anthropic", "claude-sonnet-4-5")).toBe("anthropic");
    expect(resolveOmpQuotaProviderId("openai-codex", "gpt-5")).toBe("openai-codex");
    expect(resolveOmpQuotaProviderId("omp", "anthropic/claude-sonnet-4-5")).toBe("anthropic");
    expect(resolveOmpQuotaProviderId("omp", "openai-codex/gpt-5")).toBe("openai-codex");
    expect(resolveOmpQuotaProviderId("omp", "custom/claude-sonnet-4-5")).toBeNull();
    expect(resolveOmpQuotaProviderId("claude", "claude-sonnet-4-5")).toBeNull();
  });
});
