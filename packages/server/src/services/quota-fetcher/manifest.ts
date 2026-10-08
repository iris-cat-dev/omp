import { CursorQuotaProvider } from "./providers/cursor.js";
import { createStoredZhipuQuotaProviders } from "./providers/zhipu.js";
import type {
  ProviderUsageFetcher,
  ProviderUsageFetcherFactoryOptions,
  ProviderUsageFetcherManifestEntry,
} from "./provider.js";

export const PROVIDER_USAGE_FETCHERS: readonly ProviderUsageFetcherManifestEntry[] = [
  {
    providerId: "cursor",
    create: (options) => new CursorQuotaProvider(options),
  },
];

export function createProviderUsageFetchers(
  options: ProviderUsageFetcherFactoryOptions,
): ProviderUsageFetcher[] {
  return [
    ...PROVIDER_USAGE_FETCHERS.map((entry) => entry.create(options)),
    ...createStoredZhipuQuotaProviders(options),
  ];
}
