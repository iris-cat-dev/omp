import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { Logger } from "pino";
import { z } from "zod";
import type { ProviderUsage, ProviderUsageWindow } from "../../../server/messages.js";
import type {
  ProviderApiFetch,
  ProviderUsageFetcher,
  ProviderUsageFetcherFactoryOptions,
} from "../provider.js";
import { resolveOmpDiagnosticPaths } from "../../../server/agent/providers/omp/provider-config.js";
import { fetchProviderApi, unavailableUsage, windowFromUsedPct } from "../usage.js";

const QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const QuotaResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z
    .object({
      level: z.string().optional(),
      limits: z.array(
        z.object({
          type: z.string().optional(),
          unit: z.unknown().optional(),
          percentage: z.unknown().optional(),
          nextResetTime: z.unknown().optional(),
        }),
      ),
    })
    .optional(),
});

const moduleRequire = createRequire(import.meta.url);
const StoredApiKeySchema = z.object({ key: z.string().trim().min(1) });

interface ZhipuCredentialDatabase {
  prepare(sql: string): { all(): Array<{ id?: unknown; data?: unknown }> };
  close(): void;
}

export function createStoredZhipuQuotaProviders(
  options: ProviderUsageFetcherFactoryOptions & { agentDbPath?: string },
): ProviderUsageFetcher[] {
  const agentDbPath = options.agentDbPath ?? resolveOmpDiagnosticPaths(process.env).agentDb;
  if (!existsSync(agentDbPath)) return [];
  try {
    const { DatabaseSync } = moduleRequire("node:sqlite") as {
      DatabaseSync: new (path: string, options: { readOnly: true }) => ZhipuCredentialDatabase;
    };
    const database = new DatabaseSync(agentDbPath, { readOnly: true });
    try {
      const credentials = database
        .prepare(
          `SELECT id, data FROM auth_credentials
           WHERE provider = 'zhipu-coding-plan' AND credential_type = 'api_key'
             AND disabled_cause IS NULL ORDER BY id`,
        )
        .all();
      const providers: ProviderUsageFetcher[] = [];
      for (const credential of credentials) {
        if (typeof credential.id !== "number" || typeof credential.data !== "string") continue;
        let data: unknown;
        try {
          data = JSON.parse(credential.data);
        } catch {
          continue;
        }
        const parsed = StoredApiKeySchema.safeParse(data);
        if (!parsed.success) continue;
        providers.push(
          new ZhipuQuotaProvider({
            ...options,
            providerId: `zhipu-coding-plan:${credential.id}`,
            displayName: `Zhipu · Key #${credential.id}`,
            baseUrl: "https://open.bigmodel.cn",
            apiKey: parsed.data.key,
          }),
        );
      }
      return providers;
    } finally {
      database.close();
    }
  } catch {
    options.logger.debug("Failed to read stored Zhipu usage credentials");
    return [];
  }
}

export interface ZhipuQuotaProviderOptions {
  providerId: string;
  displayName?: string;
  baseUrl: string;
  apiKey: string;
  logger: Logger;
  fetch?: ProviderApiFetch;
}

/** Match the China service by hostname, not a substring of a URL or a provider ID. */
export function isZhipuProviderBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "open.bigmodel.cn";
  } catch {
    return false;
  }
}

function isCanonicalBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "open.bigmodel.cn" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function resetTime(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const numeric = typeof value === "number" || /^\d+$/.test(value) ? Number(value) : null;
  if (numeric !== null && (!Number.isFinite(numeric) || numeric <= 0)) return null;
  const parsed =
    numeric !== null
      ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
      : new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() > 0 ? parsed.toISOString() : null;
}

export class ZhipuQuotaProvider implements ProviderUsageFetcher {
  readonly providerId: string;
  readonly displayName: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: ZhipuQuotaProviderOptions) {
    this.providerId = options.providerId;
    this.displayName = options.displayName ?? options.providerId;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    if (!isCanonicalBaseUrl(this.baseUrl)) {
      return unavailableUsage({ ...this, error: "Invalid Zhipu endpoint" });
    }
    if (!this.apiKey.trim()) return unavailableUsage(this);

    let body: unknown;
    try {
      // Never follow a redirect with an Authorization header, even to the same host.
      const response = await fetchProviderApi(this.fetchApi, QUOTA_URL, {
        method: "GET",
        redirect: "manual",
        headers: {
          Authorization: this.apiKey,
          Accept: "application/json",
          "Accept-Language": "en-US,en",
        },
      });
      if (response.status === 401 || response.status === 403) return unavailableUsage(this);
      if (!response.ok) throw new Error("Zhipu quota request failed");
      body = await response.json();
    } catch {
      // Transport errors, including invalid JSON, can embed request headers or response bodies.
      throw new Error("Zhipu quota request failed");
    }

    const parsed = QuotaResponseSchema.safeParse(body);
    if (parsed.success && parsed.data.success === false)
      throw new Error("Zhipu credential rejected or Coding Plan unavailable");
    if (!parsed.success || !parsed.data.data) throw new Error("Invalid Zhipu quota response");

    const windows: ProviderUsageWindow[] = [];
    const seen = new Set<string>();
    for (const limit of parsed.data.data.limits) {
      const isTokenQuota = limit.type === "TOKENS_LIMIT" || limit.type === "CREDIT_LIMIT";
      const window =
        isTokenQuota && limit.unit === 3
          ? { id: "five-hour", label: "5 hours" }
          : isTokenQuota && limit.unit === 6
            ? { id: "weekly", label: "Weekly" }
            : limit.type === "TIME_LIMIT"
              ? { id: "tool-calls", label: "Tool calls" }
              : null;
      if (!window || seen.has(window.id)) continue;
      seen.add(window.id);
      const usedPct =
        typeof limit.percentage === "number" &&
        Number.isFinite(limit.percentage) &&
        limit.percentage >= 0 &&
        limit.percentage <= 100
          ? limit.percentage
          : null;
      windows.push(
        windowFromUsedPct({
          ...window,
          utilizationPct: usedPct,
          resetsAt: resetTime(limit.nextResetTime),
        }),
      );
    }
    if (
      windows.length === 0 ||
      windows.every((window) => window.usedPct === null && window.resetsAt === null)
    )
      return unavailableUsage(this);

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: parsed.data.data.level ?? null,
      sourceLabel: "Zhipu Coding Plan",
      fetchedAt: new Date().toISOString(),
      windows,
      balances: [],
      details: [],
      error: null,
    };
  }
}
