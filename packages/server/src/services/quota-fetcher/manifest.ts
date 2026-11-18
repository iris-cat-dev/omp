import { createStoredCursorQuotaProviders } from "./providers/cursor.js";
import { createStoredZhipuQuotaProviders } from "./providers/zhipu.js";
import type { ProviderUsageFetcher, ProviderUsageFetcherFactoryOptions } from "./provider.js";

export function createProviderUsageFetchers(
  options: ProviderUsageFetcherFactoryOptions,
): ProviderUsageFetcher[] {
  return [
    ...createStoredCursorQuotaProviders({
      ...options,
      fetch: options.fetchForProvider?.("cursor") ?? options.fetch,
    }),
    ...createStoredZhipuQuotaProviders(options),
  ];
}
