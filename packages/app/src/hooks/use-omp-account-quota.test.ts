import { QueryClient } from "@tanstack/react-query";
import type {
  OmpProviderAccountQuota,
  OmpProviderManagement,
} from "@omp-desktop/protocol/messages";
import { describe, expect, test, vi } from "vitest";

import {
  fetchOmpAccountQuotaManagement,
  ompProviderManagementQueryKey,
  ompProviderManagementRefetchInterval,
  ompProviderManagementStaleTime,
  refreshOmpAccountQuotaManagement,
  resolveOmpQuotaProviderId,
} from "./use-omp-account-quota";

function management(quota?: OmpProviderAccountQuota): OmpProviderManagement {
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
            ...(quota ? { quota } : {}),
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

  test.each(["network", "authentication", "rate_limited", "invalid_response"] as const)(
    "does not immediately repeat a classified %s failure",
    async (kind) => {
      const failed = management({
        status: kind === "authentication" ? "unavailable" : "error",
        weeklyUsedPct: null,
        queryError: { kind },
      });
      const getOmpProviderManagement = vi.fn(async () => failed);
      const waitForRetry = vi.fn(async () => undefined);
      expect(await fetchOmpAccountQuotaManagement({ getOmpProviderManagement }, waitForRetry)).toBe(
        failed,
      );
      expect(getOmpProviderManagement).toHaveBeenCalledTimes(1);
      expect(waitForRetry).not.toHaveBeenCalled();
    },
  );
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

describe("bounded Codex quota recovery", () => {
  const failed = management({ status: "error", queryError: { kind: "network" } });

  test("shares two short recovery checks, then normal polling, and rearms after success", () => {
    const queryClient = new QueryClient();
    const queryKey = ompProviderManagementQueryKey("recover");
    try {
      queryClient.setQueryData(queryKey, failed);
      const query = queryClient.getQueryCache().find<OmpProviderManagement>({ queryKey })!;
      expect(ompProviderManagementRefetchInterval(query)).toBe(30_000);
      expect(ompProviderManagementRefetchInterval(query)).toBe(30_000);
      queryClient.setQueryData(queryKey, failed);
      expect(ompProviderManagementRefetchInterval(query)).toBe(60_000);
      queryClient.setQueryData(queryKey, failed);
      expect(ompProviderManagementRefetchInterval(query)).toBe(300_000);
      queryClient.setQueryData(queryKey, failed);
      expect(ompProviderManagementRefetchInterval(query)).toBe(300_000);
      queryClient.setQueryData(queryKey, management({ status: "available", weeklyUsedPct: 49 }));
      expect(ompProviderManagementRefetchInterval(query)).toBe(300_000);
      queryClient.setQueryData(queryKey, failed);
      expect(ompProviderManagementRefetchInterval(query)).toBe(30_000);
    } finally {
      queryClient.clear();
    }
  });

  test("RPC rejects during recovery also consume the bounded recovery checks", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryKey = ompProviderManagementQueryKey("reject");
    try {
      queryClient.setQueryData(queryKey, failed);
      const query = queryClient.getQueryCache().find<OmpProviderManagement>({ queryKey })!;
      expect(ompProviderManagementRefetchInterval(query)).toBe(30_000);
      const queryFn = async () => {
        throw new Error("Disconnected");
      };
      await expect(queryClient.fetchQuery({ queryKey, queryFn, staleTime: 0 })).rejects.toThrow(
        "Disconnected",
      );
      expect(ompProviderManagementRefetchInterval(query)).toBe(60_000);
      await expect(queryClient.fetchQuery({ queryKey, queryFn, staleTime: 0 })).rejects.toThrow(
        "Disconnected",
      );
      expect(ompProviderManagementRefetchInterval(query)).toBe(300_000);
    } finally {
      queryClient.clear();
    }
  });

  test("honors the query Retry-After deadline and does not confuse it with quota reset", () => {
    const queryClient = new QueryClient();
    const queryKey = ompProviderManagementQueryKey("limited");
    const now = Date.now();
    const limited = management({
      status: "error",
      fetchedAt: new Date(now).toISOString(),
      weeklyResetsAt: new Date(now + 604_800_000).toISOString(),
      queryError: {
        kind: "rate_limited",
        httpStatus: 429,
        retryAt: new Date(now + 120_000).toISOString(),
      },
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      queryClient.setQueryData(queryKey, limited);
      const query = queryClient.getQueryCache().find<OmpProviderManagement>({ queryKey })!;
      expect(ompProviderManagementStaleTime(limited)).toBe(120_000);
      expect(ompProviderManagementRefetchInterval(query)).toBe(120_000);
      clock.mockReturnValue(now + 120_000);
      expect(ompProviderManagementRefetchInterval(query)).toBe(30_000);
    } finally {
      clock.mockRestore();
      queryClient.clear();
    }
  });

  test.each(["authentication", "invalid_response"] as const)(
    "does not automatically accelerate %s failures",
    (kind) => {
      const queryClient = new QueryClient();
      const queryKey = ompProviderManagementQueryKey(kind);
      const result = management({ status: "error", queryError: { kind } });
      try {
        queryClient.setQueryData(queryKey, result);
        const query = queryClient.getQueryCache().find<OmpProviderManagement>({ queryKey })!;
        expect(ompProviderManagementRefetchInterval(query)).toBe(300_000);
        expect(ompProviderManagementStaleTime(result)).toBe(300_000);
      } finally {
        queryClient.clear();
      }
    },
  );
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
