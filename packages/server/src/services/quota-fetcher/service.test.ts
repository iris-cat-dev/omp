import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderUsageListResponseMessageSchema,
  type ProviderUsage,
} from "../../server/messages.js";
import type { ProviderUsageFetcher } from "./provider.js";
import { ProviderUsageService } from "./service.js";

function mockFetch(handlers: Map<string, () => Response>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const key = url.toString();
    const handler = handlers.get(key);
    if (!handler) throw new Error(`Unmocked fetch: ${key}`);
    return handler();
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createLogger(): Logger {
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as Logger;
}

function usageFetcher(usage: ProviderUsage): ProviderUsageFetcher {
  return {
    providerId: usage.providerId,
    displayName: usage.displayName,
    fetchUsage: async () => usage,
  };
}

describe("ProviderUsageService", () => {
  it("returns arbitrary registered providers and windows as normalized usage data", async () => {
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      fetchers: [
        usageFetcher({
          providerId: "glm",
          displayName: "GLM coding plan",
          status: "available",
          planLabel: "GLM coding plan",
          windows: [
            {
              id: "biweekly",
              label: "Biweekly",
              usedPct: 23,
              remainingPct: 77,
              resetsAt: "2026-07-03T00:00:00.000Z",
            },
          ],
        }),
      ],
    });

    await expect(service.listUsage()).resolves.toEqual({
      fetchedAt: "2026-06-19T00:00:00.000Z",
      providers: [
        {
          providerId: "glm",
          displayName: "GLM coding plan",
          status: "available",
          planLabel: "GLM coding plan",
          windows: [
            {
              id: "biweekly",
              label: "Biweekly",
              usedPct: 23,
              remainingPct: 77,
              resetsAt: "2026-07-03T00:00:00.000Z",
            },
          ],
        },
      ],
    });
  });

  it("caches usage until forced to refresh", async () => {
    let now = Date.parse("2026-06-19T00:00:00.000Z");
    let calls = 0;
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => now,
      cacheTtlMs: 60_000,
      fetchers: [
        {
          providerId: "claude",
          displayName: "Claude",
          fetchUsage: async () => {
            calls += 1;
            return {
              providerId: "claude",
              displayName: "Claude",
              status: "available",
              planLabel: "Max 20x",
              windows: [{ id: "session", label: "Session", usedPct: calls }],
            };
          },
        },
      ],
    });

    const first = await service.listUsage();
    now += 30_000;
    const cached = await service.listUsage();
    const refreshed = await service.listUsage({ forceRefresh: true });
    service.invalidateCache();
    const invalidated = await service.listUsage();

    expect(calls).toBe(3);
    expect(cached).toBe(first);
    expect(refreshed.providers[0]?.windows[0]?.usedPct).toBe(2);
    expect(invalidated.providers[0]?.windows[0]?.usedPct).toBe(3);
  });

  it("deduplicates concurrent cache misses", async () => {
    let calls = 0;
    let resolveUsage!: (usage: ProviderUsage) => void;
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      fetchers: [
        {
          providerId: "claude",
          displayName: "Claude",
          fetchUsage: () => {
            calls += 1;
            return new Promise<ProviderUsage>((resolve) => {
              resolveUsage = resolve;
            });
          },
        },
      ],
    });

    const first = service.listUsage();
    const second = service.listUsage();

    expect(calls).toBe(1);
    resolveUsage({
      providerId: "claude",
      displayName: "Claude",
      status: "available",
      planLabel: "Max 20x",
      windows: [{ id: "session", label: "Session", usedPct: 12 }],
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(calls).toBe(1);
  });

  it("prevents invalidated or superseded in-flight reads from poisoning the cache", async () => {
    const resolvers: Array<(usage: ProviderUsage) => void> = [];
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      cacheTtlMs: 60_000,
      fetchers: [
        {
          providerId: "cursor",
          displayName: "Cursor",
          fetchUsage: () =>
            new Promise<ProviderUsage>((resolve) => {
              resolvers.push(resolve);
            }),
        },
      ],
    });

    const staleFlight = service.listUsage();
    service.invalidateCache();
    const freshFlight = service.listUsage();
    expect(resolvers).toHaveLength(2);

    resolvers[1]!({
      providerId: "cursor",
      displayName: "Cursor",
      status: "available",
      planLabel: "Enterprise",
      windows: [{ id: "cursor_models", label: "Cursor Models", usedPct: 20 }],
    });
    const freshResult = await freshFlight;

    resolvers[0]!({
      providerId: "cursor",
      displayName: "Cursor",
      status: "unavailable",
      planLabel: null,
      windows: [],
    });
    await staleFlight;

    const cached = await service.listUsage();
    expect(cached).toBe(freshResult);
    expect(cached.providers[0]?.status).toBe("available");

    const forcedFlight = service.listUsage({ forceRefresh: true });
    expect(resolvers).toHaveLength(3);
    resolvers[2]!({
      providerId: "cursor",
      displayName: "Cursor",
      status: "available",
      planLabel: "Enterprise",
      windows: [{ id: "cursor_models", label: "Cursor Models", usedPct: 35 }],
    });
    const forcedResult = await forcedFlight;
    expect(forcedResult.providers[0]?.windows[0]?.usedPct).toBe(35);
    expect(await service.listUsage()).toBe(forcedResult);
  });

  it("isolates one provider error without dropping other providers", async () => {
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      fetchers: [
        {
          providerId: "claude",
          displayName: "Claude",
          fetchUsage: async () => {
            throw new Error("Claude auth expired");
          },
        },
        usageFetcher({
          providerId: "codex",
          displayName: "Codex",
          status: "available",
          planLabel: "Pro 20x",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 29 }],
        }),
      ],
    });

    await expect(service.listUsage()).resolves.toEqual({
      fetchedAt: "2026-06-19T00:00:00.000Z",
      providers: [
        {
          providerId: "claude",
          displayName: "Claude",
          status: "error",
          planLabel: null,
          windows: [],
          balances: [],
          details: [],
          error: "Claude auth expired",
        },
        {
          providerId: "codex",
          displayName: "Codex",
          status: "available",
          planLabel: "Pro 20x",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 29 }],
        },
      ],
    });
  });
});

describe("custom provider balance capability", () => {
  it.each([
    "https://api.openai.com/v1",
    "https://api.openai.com/v1/",
    "https://api.openai.com",
    "https://API.OPENAI.COM:443/v1",
    "https://api.openai.com/v1/responses",
    "https://api.openai.com/proxy/v1",
  ])("reports unsupported official balance without sending credentials to %s", async (baseUrl) => {
    const fetchApi = vi.fn(async () => {
      throw new Error("No official usage or costs endpoint should be called");
    });
    const service = new ProviderUsageService({ logger: createLogger(), fetch: fetchApi });
    const usage = await service.fetchCustomUsage({
      providerId: "official-openai",
      displayName: "OpenAI official API",
      baseUrl,
      apiKey: "sk-model-call-key",
    });
    const response = ProviderUsageListResponseMessageSchema.parse({
      type: "provider.usage.list.response",
      payload: { requestId: "balance", fetchedAt: "2026-11-16T00:00:00Z", providers: [usage] },
    });
    expect(response.payload.providers).toEqual([
      {
        providerId: "official-openai",
        displayName: "OpenAI official API",
        status: "unavailable",
        unsupportedReason: "openai_balance_credentials",
        planLabel: null,
        windows: [],
        balances: [],
        details: [],
        error: null,
      },
    ]);
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it.each([
    ["https://third-party.example/v1", "https://third-party.example/v1/usage"],
    ["https://api.openai.com.evil.example/v1", "https://api.openai.com.evil.example/v1/usage"],
    ["https://api.openai.com@proxy.example/v1", "https://api.openai.com@proxy.example/v1/usage"],
    ["https://proxy.example/openai/v1", "https://proxy.example/openai/v1/usage"],
    ["https://api.openai.com:8443/v1", "https://api.openai.com:8443/v1/usage"],
    ["http://api.openai.com/v1", "http://api.openai.com/v1/usage"],
  ])(
    "preserves the generic usage contract for the non-official endpoint %s",
    async (baseUrl, endpoint) => {
      const fetchApi = mockFetch(new Map([[endpoint, () => jsonResponse({ remaining: 12.5 })]]));
      const service = new ProviderUsageService({ logger: createLogger(), fetch: fetchApi });
      const usage = await service.fetchCustomUsage({
        providerId: "custom",
        baseUrl,
        apiKey: "third-party-key",
      });
      expect(usage).toMatchObject({
        status: "available",
        balances: [{ id: "balance", remaining: 12.5, unit: "usd" }],
        error: null,
      });
      expect(usage.unsupportedReason).toBeUndefined();
      expect(fetchApi).toHaveBeenCalledExactlyOnceWith(
        endpoint,
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer third-party-key" }),
        }),
      );
    },
  );

  it.each(["transport", "http", "invalid-key", "parse"])(
    "sanitizes credential-bearing %s failures without reporting unsupported balance",
    async (failure) => {
      const secret = "sk-do-not-expose";
      const logger = createLogger();
      const fetchApi = vi.fn(async () => {
        if (failure === "transport") throw new Error(`Bearer ${secret}`);
        if (failure === "http") return jsonResponse({ message: secret }, 401);
        if (failure === "invalid-key") return jsonResponse({ isValid: false, message: secret });
        return jsonResponse({ remaining: secret });
      });
      const service = new ProviderUsageService({ logger, fetch: fetchApi });
      const usage = await service.fetchCustomUsage({
        providerId: "custom",
        baseUrl: "https://third-party.example/v1",
        apiKey: secret,
      });
      expect(usage).toMatchObject({
        status: "error",
        error: "Custom provider usage request failed",
        windows: [],
        balances: [],
      });
      expect(usage.unsupportedReason).toBeUndefined();
      expect(JSON.stringify(usage)).not.toContain(secret);
      expect(logger.debug).toHaveBeenCalledWith(
        { providerId: "custom" },
        "Provider usage fetch failed",
      );
    },
  );
});
