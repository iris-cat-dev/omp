import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { ProviderUsageService } from "../service.js";
import { createStoredZhipuQuotaProviders, ZhipuQuotaProvider } from "./zhipu.js";

const canonical = "https://open.bigmodel.cn/api/anthropic";
const endpoint = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const key = "secret-zhipu-key";
const logger = pino({ level: "silent" });

function provider(baseUrl: string, fetchApi: typeof fetch, apiKey = key): ZhipuQuotaProvider {
  return new ZhipuQuotaProvider({ providerId: "glm-cn", baseUrl, apiKey, fetch: fetchApi, logger });
}

describe("Zhipu Coding Plan quota", () => {
  it("requests only the canonical quota endpoint with raw Authorization and real windows", async () => {
    const fetchApi = vi.fn(async () =>
      Response.json({
        success: true,
        data: {
          level: "pro",
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: 42, nextResetTime: 1737651600000 },
            { type: "TOKENS_LIMIT", unit: 6, percentage: 91, nextResetTime: 1737910800000 },
            { type: "TIME_LIMIT", unit: 5, percentage: 67 },
            { type: "TIME_LIMIT", unit: 5, percentage: 99 },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    const usage = await provider(canonical, fetchApi).fetchUsage();
    expect(fetchApi).toHaveBeenCalledOnce();
    expect(fetchApi).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: expect.objectContaining({ Authorization: key }),
      }),
    );
    expect(usage).toMatchObject({
      providerId: "glm-cn",
      status: "available",
      planLabel: "pro",
      balances: [],
    });
    expect(usage.windows).toEqual([
      {
        id: "five-hour",
        label: "5 hours",
        usedPct: 42,
        remainingPct: 58,
        resetsAt: new Date(1737651600000).toISOString(),
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPct: 91,
        remainingPct: 9,
        resetsAt: new Date(1737910800000).toISOString(),
      },
      { id: "tool-calls", label: "Tool calls", usedPct: 67, remainingPct: 33, resetsAt: null },
    ]);
  });

  it("recognizes the live Max CREDIT_LIMIT response as five-hour and weekly usage", async () => {
    const fetchApi = vi.fn(async () =>
      Response.json({
        code: 200,
        success: true,
        data: {
          level: "max",
          limits: [
            { type: "CREDIT_LIMIT", unit: 3, percentage: 1, nextResetTime: 1791465598792 },
            { type: "CREDIT_LIMIT", unit: 6, percentage: 1, nextResetTime: 1791646938998 },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    expect(await provider(canonical, fetchApi).fetchUsage()).toMatchObject({
      status: "available",
      planLabel: "max",
      windows: [
        {
          id: "five-hour",
          usedPct: 1,
          remainingPct: 99,
          resetsAt: new Date(1791465598792).toISOString(),
        },
        {
          id: "weekly",
          usedPct: 1,
          remainingPct: 99,
          resetsAt: new Date(1791646938998).toISOString(),
        },
      ],
    });
  });

  it("isolates rejected stored keys and excludes disabled, malformed and other-provider credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zhipu-quota-"));
    const agentDbPath = join(dir, "agent.db");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...params: unknown[]): void };
        close(): void;
      };
    };
    const database = new DatabaseSync(agentDbPath);
    try {
      database.exec(
        "CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT)",
      );
      const insert = database.prepare("INSERT INTO auth_credentials VALUES (?, ?, ?, ?, ?)");
      insert.run(5, "zhipu-coding-plan", "api_key", JSON.stringify({ key: "rejected-key" }), null);
      insert.run(6, "zhipu-coding-plan", "api_key", JSON.stringify({ key: "valid-key" }), null);
      insert.run(
        7,
        "zhipu-coding-plan",
        "api_key",
        JSON.stringify({ key: "disabled-key" }),
        "deleted",
      );
      insert.run(8, "zhipu-coding-plan", "api_key", "invalid-json", null);
      insert.run(9, "zai", "api_key", JSON.stringify({ key: "other-key" }), null);
      const fetchApi = vi.fn(async (_url: Parameters<typeof fetch>[0], options?: RequestInit) =>
        new Headers(options?.headers).get("Authorization") === "valid-key"
          ? Response.json({
              success: true,
              data: {
                level: "max",
                limits: [
                  { type: "CREDIT_LIMIT", unit: 3, percentage: 1 },
                  { type: "CREDIT_LIMIT", unit: 6, percentage: 2 },
                ],
              },
            })
          : Response.json({ code: 1000, success: false }),
      ) as unknown as typeof fetch;
      const service = new ProviderUsageService({
        logger,
        fetchers: createStoredZhipuQuotaProviders({ logger, fetch: fetchApi, agentDbPath }),
      });
      const result = await service.listUsage();
      expect(result.providers).toMatchObject([
        {
          providerId: "zhipu-coding-plan:5",
          status: "error",
          windows: [],
          error: "Zhipu credential rejected or Coding Plan unavailable",
        },
        {
          providerId: "zhipu-coding-plan:6",
          status: "available",
          planLabel: "max",
          windows: [
            { id: "five-hour", usedPct: 1, remainingPct: 99 },
            { id: "weekly", usedPct: 2, remainingPct: 98 },
          ],
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("valid-key");
      expect(JSON.stringify(result)).not.toContain("rejected-key");
      insert.run(10, "zhipu-coding-plan", "api_key", JSON.stringify({ key: "valid-key" }), null);
      database
        .prepare("UPDATE auth_credentials SET disabled_cause = ? WHERE id = ?")
        .run("deleted", 6);
      const refreshed = await new ProviderUsageService({
        logger,
        fetchers: createStoredZhipuQuotaProviders({ logger, fetch: fetchApi, agentDbPath }),
      }).listUsage();
      expect(refreshed.providers.map((usage) => usage.providerId)).toEqual([
        "zhipu-coding-plan:5",
        "zhipu-coding-plan:10",
      ]);
    } finally {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not invent a weekly quota, balance, reset or percentage from unknown values", async () => {
    const fetchApi = vi.fn(async () =>
      Response.json({
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: "unknown", nextResetTime: 1737651600000 },
            { type: "TOKENS_LIMIT", unit: 42, percentage: 99 },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    const usage = await provider(canonical, fetchApi).fetchUsage();
    expect(usage.status).toBe("available");
    expect(usage.windows).toEqual([
      {
        id: "five-hour",
        label: "5 hours",
        usedPct: null,
        remainingPct: null,
        resetsAt: new Date(1737651600000).toISOString(),
      },
    ]);
    expect(usage.balances).toEqual([]);
  });

  it("retains a five-hour percentage without a reset and rejects epoch/invalid quota values", async () => {
    const fetchApi = vi.fn(async () =>
      Response.json({
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: 35 },
            { type: "TOKENS_LIMIT", unit: 6, percentage: "unknown", nextResetTime: 0 },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    const usage = await provider(canonical, fetchApi).fetchUsage();
    expect(usage.status).toBe("available");
    expect(usage.windows).toEqual([
      { id: "five-hour", label: "5 hours", usedPct: 35, remainingPct: 65, resetsAt: null },
      { id: "weekly", label: "Weekly", usedPct: null, remainingPct: null, resetsAt: null },
    ]);
  });

  it.each([
    "http://open.bigmodel.cn/api/anthropic",
    "https://open.bigmodel.cn:8443/api/anthropic",
    "https://open.bigmodel.cn.evil.example/api/anthropic",
    "https://open.bigmodel.cn@evil.example/api/anthropic",
    "https://user@open.bigmodel.cn/api/anthropic",
  ])("never sends the key to a noncanonical URL: %s", async (baseUrl) => {
    const fetchApi = vi.fn();
    const usage = await provider(baseUrl, fetchApi as unknown as typeof fetch).fetchUsage();
    expect(fetchApi).not.toHaveBeenCalled();
    expect(usage.status).not.toBe("available");
    expect(JSON.stringify(usage)).not.toContain(key);
  });

  it("does not issue a request without credentials and does not follow redirects", async () => {
    const fetchApi = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: "https://evil.example/key" } }),
    ) as unknown as typeof fetch;
    expect((await provider(canonical, fetchApi, " ").fetchUsage()).status).toBe("unavailable");
    expect(fetchApi).not.toHaveBeenCalled();
    await expect(provider(canonical, fetchApi).fetchUsage()).rejects.toThrow(
      "Zhipu quota request failed",
    );
    expect(fetchApi).toHaveBeenCalledOnce();
    expect(fetchApi).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("treats rejected credentials and unrecognized quota types as unavailable", async () => {
    const denied = vi.fn(
      async () => new Response(null, { status: 403 }),
    ) as unknown as typeof fetch;
    expect((await provider(canonical, denied).fetchUsage()).status).toBe("unavailable");
    const unknown = vi.fn(async () =>
      Response.json({ data: { limits: [{ type: "OTHER_LIMIT", unit: 5, percentage: 20 }] } }),
    ) as unknown as typeof fetch;
    expect((await provider(canonical, unknown).fetchUsage()).status).toBe("unavailable");
  });
  it("routes canonical models.yml credentials through the dedicated service and redacts errors", async () => {
    const fetchApi = vi.fn(async () =>
      Response.json({
        data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 20 }] },
      }),
    ) as unknown as typeof fetch;
    const service = new ProviderUsageService({ logger, fetchers: [], fetch: fetchApi });
    const config = { providerId: "my-glm", baseUrl: canonical, apiKey: key };
    expect(await service.fetchCustomUsage(config)).toMatchObject({
      providerId: "my-glm",
      status: "available",
      windows: [{ id: "five-hour", usedPct: 20 }],
    });
    expect(fetchApi).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({ Authorization: key }),
      }),
    );

    const failed = new ProviderUsageService({
      logger,
      fetchers: [],
      fetch: (async () => {
        throw new Error(`${key} network failure`);
      }) as typeof fetch,
    });
    const result = await failed.fetchCustomUsage(config);
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("never surfaces upstream response or transport secrets", async () => {
    const invalidJson = vi.fn(
      async () => new Response(`invalid ${key}`, { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(provider(canonical, invalidJson).fetchUsage()).rejects.toThrow(
      "Zhipu quota request failed",
    );
    const rejected = vi.fn(async () => {
      throw new Error(`Authorization: ${key}`);
    }) as unknown as typeof fetch;
    await expect(provider(canonical, rejected).fetchUsage()).rejects.toThrow(
      /^Zhipu quota request failed$/,
    );
  });

  it("does not fall through to generic custom usage on an insecure Zhipu origin", async () => {
    const fetchApi = vi.fn();
    const service = new ProviderUsageService({
      logger,
      fetchers: [],
      fetch: fetchApi as unknown as typeof fetch,
    });
    const usage = await service.fetchCustomUsage({
      providerId: "team-glm",
      baseUrl: "http://open.bigmodel.cn/api/anthropic",
      apiKey: key,
    });
    expect(fetchApi).not.toHaveBeenCalled();
    expect(usage.status).toBe("error");
    expect(JSON.stringify(usage)).not.toContain(key);
  });

  it("continues using the generic custom provider for non-Zhipu origins", async () => {
    const fetchApi = vi.fn(async () =>
      Response.json({ remaining: 12, unit: "USD" }),
    ) as unknown as typeof fetch;
    const service = new ProviderUsageService({ logger, fetchers: [], fetch: fetchApi });
    const usage = await service.fetchCustomUsage({
      providerId: "mintcat",
      baseUrl: "https://codex.mintcat.work",
      apiKey: key,
    });
    expect(usage).toMatchObject({ providerId: "mintcat", status: "available" });
    expect(fetchApi).toHaveBeenCalledWith(
      "https://codex.mintcat.work/v1/usage",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${key}` }),
      }),
    );
  });
});
