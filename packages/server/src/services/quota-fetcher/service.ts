import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { CustomQuotaProvider, type CustomQuotaProviderOptions } from "./providers/custom.js";
import { ZhipuQuotaProvider, isZhipuProviderBaseUrl } from "./providers/zhipu.js";
import { unavailableUsage } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers: ProviderUsageFetcher[] | undefined;
  private readonly fetchApi: ProviderApiFetch | undefined;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.fetchers = options.fetchers;
    this.fetchApi = options.fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    if (
      !options?.forceRefresh &&
      this.cached &&
      nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
    ) {
      return this.cached.result;
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchFreshUsage(nowMs);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  async fetchCustomUsage(
    options: Omit<CustomQuotaProviderOptions, "logger" | "fetch">,
  ): Promise<ProviderUsage> {
    const fetcher = isZhipuProviderBaseUrl(options.baseUrl)
      ? new ZhipuQuotaProvider({ ...options, logger: this.logger, fetch: this.fetchApi })
      : new CustomQuotaProvider({ ...options, logger: this.logger, fetch: this.fetchApi });
    try {
      return await fetcher.fetchUsage();
    } catch {
      // Do not propagate fetch/parse errors: their messages can contain credentials.
      this.logger.debug({ providerId: fetcher.providerId }, "Provider usage fetch failed");
      return unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        error: isZhipuProviderBaseUrl(options.baseUrl)
          ? "Zhipu usage request failed"
          : "Custom provider usage request failed",
      });
    }
  }

  private async fetchFreshUsage(nowMs: number): Promise<ProviderUsageListResult> {
    // Discover login credentials on each refresh, not just at daemon startup.
    const fetchers =
      this.fetchers ?? createProviderUsageFetchers({ logger: this.logger, fetch: this.fetchApi });
    const settled = await Promise.allSettled(fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = fetchers[index];
      if (result.status === "fulfilled") {
        return result.value;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    this.cached = { fetchedAtMs: nowMs, result };
    return result;
  }
}
