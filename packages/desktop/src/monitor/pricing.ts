import { randomUUID } from "node:crypto";
import { open, mkdir, rename, rm, lstat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  BUNDLED_CURRENCY_TABLE,
  BUNDLED_PRICE_TABLE,
  BUNDLED_PRICING_METADATA,
} from "./pricing-assets.js";
import {
  DAY_MS,
  PRICE_MAX_BYTES,
  ValidatedPriceTable,
  dateMillis,
  isObject,
  validatePriceTable,
  type OmpMonitorCostInput,
} from "./pricing-table.js";
import {
  FX_ATTRIBUTION,
  FX_MAX_BYTES,
  FX_PROVIDERS,
  bundledRateEntries,
  checkRateCandidate,
  mergeRates,
  parseRates,
  validRate,
  validateCurrencies,
  type CurrencyCatalog,
  type ParsedRates,
  type RateEntry,
} from "./pricing-rates.js";
import type { OmpMonitorDataFeed, OmpMonitorPricing } from "./types.js";

export type { OmpMonitorCostInput } from "./pricing-table.js";

const PRICE_URLS = [
  "https://raw.githubusercontent.com/zoefix/agent-speed/main/spec/assets/prices.json",
  "https://cdn.jsdelivr.net/gh/zoefix/agent-speed@main/spec/assets/prices.json",
] as const;
type FixedResource = (typeof PRICE_URLS)[number] | (typeof FX_PROVIDERS)[number]["url"];
const HOUR_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 15_000;
const SETTINGS_FILE = "pricing-settings.json";
const PRICES_FILE = "prices.json";
const RATES_FILE = "rates.json";
const PRICE_CACHE_CAP = PRICE_MAX_BYTES + (64 << 10);
const SETTINGS_CAP = 4096;
let bundled: { prices: ValidatedPriceTable; currencies: CurrencyCatalog } | undefined;

function bundledCatalogs(): { prices: ValidatedPriceTable; currencies: CurrencyCatalog } {
  bundled ??= {
    prices: validatePriceTable(
      BUNDLED_PRICE_TABLE,
      dateMillis(BUNDLED_PRICING_METADATA.priceTable.updated),
    ),
    currencies: validateCurrencies(BUNDLED_CURRENCY_TABLE),
  };
  return bundled;
}

/** Disk-free, network-free fallback for collectors that are not attached to an open monitor. */
export function getBundledPricingState(): OmpMonitorPricing {
  const { prices, currencies } = bundledCatalogs();
  return {
    networkEnabled: false,
    currency: "USD",
    currencies: [...currencies.codes],
    prices: {
      status: "bundled",
      version: String(prices.version),
      updatedAt: prices.updated,
      fetchedAt: null,
      lastAttemptAt: null,
      source: `Bundled: ${BUNDLED_PRICING_METADATA.priceTable.url}`,
    },
    rates: {
      status: "bundled",
      version: "USD",
      updatedAt: null,
      fetchedAt: null,
      lastAttemptAt: null,
      source: "USD (base currency)",
    },
    exchangeRate: 1,
    attribution: null,
  };
}

function storedStamp(value: unknown, now: number): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > now + 2 * DAY_MS
  )
    throw new Error("invalid cache timestamp");
  return Math.min(value, now);
}

interface CachedSettings {
  networkEnabled: boolean;
  currency: string;
}
interface CachedPrices {
  table: ValidatedPriceTable;
  source: string;
  fetchedAt: number | null;
  lastAttemptAt: number | null;
  failures: number;
}
interface CachedRates {
  entries: Record<string, RateEntry>;
  lastAttemptAt: number | null;
  lastFailureAt: number | null;
}

function validateCachedSettings(value: unknown, currencies: CurrencyCatalog): CachedSettings {
  if (
    !isObject(value) ||
    value.schema !== 1 ||
    typeof value.networkEnabled !== "boolean" ||
    typeof value.currency !== "string" ||
    !currencies.codes.includes(value.currency)
  )
    throw new Error("invalid pricing settings");
  return { networkEnabled: value.networkEnabled, currency: value.currency };
}

function validateCachedPrices(value: unknown, now: number): CachedPrices {
  if (
    !isObject(value) ||
    value.schema !== 1 ||
    typeof value.source !== "string" ||
    !(PRICE_URLS as readonly string[]).includes(value.source) ||
    typeof value.failures !== "number" ||
    !Number.isSafeInteger(value.failures) ||
    value.failures < 0 ||
    value.failures > 1_000_000
  )
    throw new Error("invalid price cache");
  return {
    table: validatePriceTable(value.table, now),
    source: value.source,
    fetchedAt: storedStamp(value.fetchedAt, now),
    lastAttemptAt: storedStamp(value.lastAttemptAt, now),
    failures: value.failures,
  };
}

function validateCachedRateSource(
  entry: RateEntry,
  code: string,
  currencies: CurrencyCatalog,
): void {
  if (entry.fetchedAt === null) {
    if (
      entry.source !== currencies.fallbackSource ||
      entry.date !== currencies.fallbackDate ||
      entry.rate !== currencies.fallbackRates[code]
    )
      throw new Error("invalid fallback provenance");
    return;
  }
  if (!FX_PROVIDERS.some((provider) => provider.url === entry.source))
    throw new Error("invalid cached rate source");
}

function validateCachedRateEntry(
  value: unknown,
  code: string,
  currencies: CurrencyCatalog,
  now: number,
): RateEntry {
  if (
    !isObject(value) ||
    !validRate(value.rate) ||
    (code === "USD" && value.rate !== 1) ||
    typeof value.date !== "number" ||
    !Number.isSafeInteger(value.date) ||
    value.date <= 0 ||
    value.date > now + 2 * DAY_MS ||
    typeof value.source !== "string"
  )
    throw new Error("invalid cached rate");
  const entry: RateEntry = {
    rate: value.rate,
    date: value.date,
    fetchedAt: storedStamp(value.fetchedAt, now),
    source: value.source,
  };
  validateCachedRateSource(entry, code, currencies);
  const fallback = currencies.fallbackRates[code]!;
  if (
    now - currencies.fallbackDate <= 30 * DAY_MS &&
    (entry.rate < fallback * 0.5 || entry.rate > fallback * 2)
  )
    throw new Error("implausible cached rate");
  return entry;
}

function validateCachedRates(
  value: unknown,
  currencies: CurrencyCatalog,
  now: number,
): CachedRates {
  if (
    !isObject(value) ||
    value.schema !== 1 ||
    !isObject(value.entries) ||
    Object.keys(value.entries).length !== currencies.codes.length
  )
    throw new Error("invalid rate cache");
  const entries = bundledRateEntries(currencies);
  for (const code of currencies.codes) {
    const entry = validateCachedRateEntry(value.entries[code], code, currencies, now);
    if (entry.date >= entries[code]!.date) entries[code] = entry;
  }
  return {
    entries,
    lastAttemptAt: storedStamp(value.lastAttemptAt, now),
    lastFailureAt: storedStamp(value.lastFailureAt, now),
  };
}

/** Strict, streaming body cap and a timeout that includes reading the response body. */
async function downloadJson(
  fetcher: typeof globalThis.fetch,
  url: FixedResource,
  cap: number,
  signal: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort();
  };
  const { promise: aborted, reject: rejectAborted } = Promise.withResolvers<never>();
  controller.signal.addEventListener(
    "abort",
    () => {
      rejectAborted(new Error("request aborted"));
    },
    { once: true },
  );
  signal.addEventListener("abort", forwardAbort, { once: true });
  if (signal.aborted) controller.abort();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  const operation = async (): Promise<unknown> => {
    if (controller.signal.aborted) throw new Error("request aborted");
    const response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("request aborted");
    }
    if (!response.ok || response.redirected || (response.url && response.url !== url)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("unusable response");
    }
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > cap)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("response exceeds size limit");
    }
    if (!response.body) throw new Error("empty response");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (controller.signal.aborted) throw new Error("request aborted");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > cap) {
        controller.abort();
        throw new Error("response exceeds size limit");
      }
      chunks.push(chunk.value);
    }
    finished = true;
    const bytes = Buffer.concat(chunks, size);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  };
  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", forwardAbort);
    if (!finished) {
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    }
  }
}

export class OmpPriceCatalog {
  private readonly cacheDir: string;
  private readonly now: () => number;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly currencies: CurrencyCatalog;
  private prices: ValidatedPriceTable;
  private entries: Record<string, RateEntry>;
  private currency = "USD";
  private networkEnabled = true;
  private initialized: Promise<void> | undefined;
  private disposed = false;
  private priceLaunchAt = 0;
  private ratesLaunchAt = 0;
  private priceFetchedAt: number | null = null;
  private priceAttemptAt: number | null = null;
  private priceFailures = 0;
  private priceSource = `Bundled: ${BUNDLED_PRICING_METADATA.priceTable.url}`;
  private rateAttemptAt: number | null = null;
  private rateFailureAt: number | null = null;
  private priceController: AbortController | undefined;
  private rateController: AbortController | undefined;
  private priceFlight: Promise<void> | undefined;
  private rateFlight: Promise<void> | undefined;
  private readonly invalidCaches = new Set<string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(options: { cacheDir: string; now?: () => number; fetch?: typeof globalThis.fetch }) {
    this.cacheDir = options.cacheDir;
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? globalThis.fetch;
    const catalogs = bundledCatalogs();
    this.prices = catalogs.prices;
    this.currencies = catalogs.currencies;
    this.entries = bundledRateEntries(catalogs.currencies);
  }

  initialize(): Promise<void> {
    this.initialized ??= this.load();
    return this.initialized;
  }

  private async load(): Promise<void> {
    // No request is issued here: persisted opt-out is resolved before refresh can run.
    const now = this.now();
    this.priceLaunchAt = now + 60_000;
    this.ratesLaunchAt = now + 30_000;
    await this.loadSettings();
    await this.loadPrices(now);
    await this.loadRates(now);
  }

  private async loadSettings(): Promise<void> {
    const value = await this.readCache(SETTINGS_FILE, SETTINGS_CAP);
    if (value === undefined) {
      if (this.invalidCaches.has(SETTINGS_FILE)) this.networkEnabled = false;
      return;
    }
    try {
      const settings = validateCachedSettings(value, this.currencies);
      this.networkEnabled = settings.networkEnabled;
      this.currency = settings.currency;
    } catch {
      this.invalidCaches.add(SETTINGS_FILE);
      this.networkEnabled = false;
    }
  }

  private async loadPrices(now: number): Promise<void> {
    const value = await this.readCache(PRICES_FILE, PRICE_CACHE_CAP);
    if (value === undefined) return;
    try {
      const cached = validateCachedPrices(value, now);
      const table = cached.table;
      if (table.version < this.prices.version || table.updated < this.prices.updated) return;
      // Equal versions always keep this build's bundled data, not a rewritten same-version download.
      if (table.version > this.prices.version) this.prices = table;
      if (table.version !== this.prices.version || table.updated !== this.prices.updated) return;
      this.priceFetchedAt = cached.fetchedAt;
      this.priceAttemptAt = cached.lastAttemptAt;
      this.priceFailures = cached.failures;
      if (cached.fetchedAt !== null) this.priceSource = cached.source;
    } catch {
      this.invalidCaches.add(PRICES_FILE);
    }
  }

  private async loadRates(now: number): Promise<void> {
    const value = await this.readCache(RATES_FILE, FX_MAX_BYTES);
    if (value === undefined) return;
    try {
      const cached = validateCachedRates(value, this.currencies, now);
      this.entries = cached.entries;
      this.rateAttemptAt = cached.lastAttemptAt;
      this.rateFailureAt = cached.lastFailureAt;
    } catch {
      this.invalidCaches.add(RATES_FILE);
    }
  }

  private priceFeed(now: number): OmpMonitorDataFeed {
    let status: OmpMonitorDataFeed["status"] = "fresh";
    if (this.priceController && !this.priceController.signal.aborted) status = "updating";
    else if (this.priceFailures) status = "error";
    else if (this.priceFetchedAt === null) status = "bundled";
    else if (now - this.priceFetchedAt >= DAY_MS) status = "stale";
    return {
      status,
      version: String(this.prices.version),
      updatedAt: this.prices.updated,
      fetchedAt: this.priceFetchedAt,
      lastAttemptAt: this.priceAttemptAt,
      source: this.priceSource,
    };
  }

  private rateFeed(now: number): OmpMonitorDataFeed {
    if (this.currency === "USD") {
      return {
        status: "bundled",
        version: "USD",
        updatedAt: null,
        fetchedAt: null,
        lastAttemptAt: null,
        source: "USD (base currency)",
      };
    }
    const entry = this.entries[this.currency]!;
    let status: OmpMonitorDataFeed["status"] = "fresh";
    if (this.rateController && !this.rateController.signal.aborted) status = "updating";
    else if (now - entry.date > 7 * DAY_MS) status = "stale";
    else if (this.rateFailureAt !== null) status = "error";
    else if (entry.fetchedAt === null) status = "bundled";
    const updatedAt = new Date(entry.date).toISOString();
    return {
      status,
      version: updatedAt.slice(0, 10),
      updatedAt,
      fetchedAt: entry.fetchedAt,
      lastAttemptAt: this.rateAttemptAt,
      source: entry.fetchedAt === null ? `Bundled (CC0): ${entry.source}` : entry.source,
    };
  }

  getState(): OmpMonitorPricing {
    const now = this.now();
    const entry = this.entries[this.currency]!;
    const usd = this.currency === "USD";
    return {
      networkEnabled: this.networkEnabled,
      currency: this.currency,
      currencies: [...this.currencies.codes],
      prices: this.priceFeed(now),
      rates: this.rateFeed(now),
      exchangeRate: usd ? 1 : entry.rate,
      attribution:
        !usd && entry.source === FX_PROVIDERS[0].url && entry.fetchedAt !== null
          ? { ...FX_ATTRIBUTION }
          : null,
    };
  }

  async configure(patch: { networkEnabled?: boolean; currency?: string }): Promise<void> {
    if (patch.networkEnabled !== undefined && typeof patch.networkEnabled !== "boolean")
      throw new Error("invalid network setting");
    if (
      patch.currency !== undefined &&
      (typeof patch.currency !== "string" || !this.currencies.codes.includes(patch.currency))
    )
      throw new Error("unsupported currency");
    await this.initialize();
    if (this.disposed) return;
    const currencyChanged = patch.currency !== undefined && patch.currency !== this.currency;
    const enabling = patch.networkEnabled === true && !this.networkEnabled;
    if (patch.networkEnabled !== undefined) this.networkEnabled = patch.networkEnabled;
    if (patch.currency !== undefined) this.currency = patch.currency;
    if (!this.networkEnabled) {
      this.priceController?.abort();
      this.rateController?.abort();
    } else if (enabling) {
      this.priceLaunchAt = this.now() + 60_000;
      this.ratesLaunchAt = this.now() + 30_000;
    }
    if (currencyChanged) this.rateController?.abort();
    const currency = this.currency;
    await this.persist(SETTINGS_FILE, { schema: 1, networkEnabled: this.networkEnabled, currency });
    if (currencyChanged && currency !== "USD") {
      // Settings commands must never wait for network I/O: a queued opt-out must
      // reach the abort path even if every rate provider is stalled.
      void (this.rateFlight ?? Promise.resolve())
        .then(() => {
          if (this.currency === currency && this.networkEnabled && !this.disposed)
            return this.refreshRates(false, true);
          return undefined;
        })
        .catch(() => undefined);
    }
  }

  async refresh(options?: { force?: boolean }): Promise<void> {
    await this.initialize();
    if (!this.networkEnabled || this.disposed) return;
    await Promise.all([
      this.refreshPrices(options?.force === true),
      this.refreshRates(options?.force === true, false),
    ]);
  }

  estimateCost(input: OmpMonitorCostInput): number | null {
    return this.prices.estimateCost(input, this.now());
  }

  private refreshPrices(force: boolean): Promise<void> {
    if (this.priceFlight) return this.priceFlight;
    const now = this.now();
    let due = this.priceLaunchAt;
    if (this.priceFailures && this.priceAttemptAt !== null) {
      const delay = this.priceFailures === 1 ? HOUR_MS : DAY_MS;
      due = this.priceAttemptAt + delay;
    } else if (this.priceFetchedAt !== null) due = this.priceFetchedAt + DAY_MS;
    if (
      !this.networkEnabled ||
      this.disposed ||
      (!force && now < Math.max(this.priceLaunchAt, due))
    )
      return Promise.resolve();
    const controller = new AbortController();
    this.priceController = controller;
    this.priceAttemptAt = now;
    const flight = this.runPrices(controller).finally(() => {
      if (this.priceController === controller) {
        this.priceController = undefined;
        this.priceFlight = undefined;
      }
    });
    this.priceFlight = flight;
    return flight;
  }

  private async runPrices(controller: AbortController): Promise<void> {
    for (const url of PRICE_URLS) {
      if (!this.priceActive(controller)) return;
      try {
        const document = await downloadJson(this.fetcher, url, PRICE_MAX_BYTES, controller.signal);
        if (!this.priceActive(controller)) return;
        const table = validatePriceTable(document, this.now());
        if (
          table.version < this.prices.version ||
          table.updated < this.prices.updated ||
          (table.version === this.prices.version && table.updated !== this.prices.updated)
        )
          throw new Error("price table downgrade");
        if (!this.priceActive(controller)) return;
        if (table.version > this.prices.version) this.prices = table;
        this.priceFetchedAt = this.now();
        this.priceSource = url;
        this.priceFailures = 0;
        await this.persistPrices();
        return;
      } catch {
        // Only fixed resources are attempted. Remote bodies/errors are never exposed or logged.
        if (!this.priceActive(controller)) return;
      }
    }
    if (!this.priceActive(controller)) return;
    this.priceFailures = Math.min(this.priceFailures + 1, 1_000_000);
    await this.persistPrices();
  }

  private priceActive(controller: AbortController): boolean {
    return (
      !this.disposed &&
      this.networkEnabled &&
      !controller.signal.aborted &&
      this.priceController === controller
    );
  }

  private refreshRates(force: boolean, selection: boolean): Promise<void> {
    if (this.rateFlight) return this.rateFlight;
    if (!this.networkEnabled || this.disposed || this.currency === "USD") return Promise.resolve();
    const now = this.now();
    const selected = this.entries[this.currency]!;
    const dailyDue = selected.fetchedAt === null || now - selected.fetchedAt >= DAY_MS;
    if (
      !force &&
      (!dailyDue ||
        (!selection && now < this.ratesLaunchAt) ||
        (this.rateFailureAt !== null && now - this.rateFailureAt < HOUR_MS))
    )
      return Promise.resolve();
    const controller = new AbortController();
    this.rateController = controller;
    this.rateAttemptAt = now;
    const currency = this.currency;
    const flight = this.runRates(controller, currency).finally(() => {
      if (this.rateController === controller) {
        this.rateController = undefined;
        this.rateFlight = undefined;
      }
    });
    this.rateFlight = flight;
    return flight;
  }

  private async runRates(controller: AbortController, currency: string): Promise<void> {
    const reference = this.entries[currency]!;
    const latestDate = Math.max(...Object.values(this.entries).map((entry) => entry.date));
    const pending: ParsedRates[] = [];
    let fawazPrimaryUsable = false;
    for (const provider of FX_PROVIDERS) {
      if (!this.ratesActive(controller, currency)) return;
      // jsDelivr and Pages are mirrors, not independent evidence for a stale reference.
      if (provider.url === FX_PROVIDERS[2].url && fawazPrimaryUsable) continue;
      try {
        const document = await downloadJson(
          this.fetcher,
          provider.url,
          FX_MAX_BYTES,
          controller.signal,
        );
        if (!this.ratesActive(controller, currency)) return;
        const parsed = parseRates(document, provider, this.currencies, this.now());
        const verdict = checkRateCandidate(parsed, currency, reference, this.now(), latestDate);
        if (provider.url === FX_PROVIDERS[1].url) fawazPrimaryUsable = true;
        let accepted = parsed;
        let confirmation: ParsedRates | undefined;
        if (verdict === "needs-confirmation") {
          const first = pending.find((candidate) => {
            try {
              return (
                checkRateCandidate(
                  candidate,
                  currency,
                  reference,
                  this.now(),
                  latestDate,
                  parsed,
                ) === "accepted"
              );
            } catch {
              return false;
            }
          });
          if (!first) {
            pending.push(parsed);
            continue;
          }
          accepted = first;
          confirmation = parsed;
        }
        if (!this.ratesActive(controller, currency)) return;
        const entries = mergeRates(this.entries, accepted, this.now(), confirmation);
        if (entries[currency] === this.entries[currency])
          throw new Error("selected rate not accepted");
        this.entries = entries;
        this.rateFailureAt = null;
        await this.persistRates();
        return;
      } catch {
        if (!this.ratesActive(controller, currency)) return;
      }
    }
    if (!this.ratesActive(controller, currency)) return;
    this.rateFailureAt = this.now();
    await this.persistRates();
  }

  private ratesActive(controller: AbortController, currency: string): boolean {
    return (
      !this.disposed &&
      this.networkEnabled &&
      this.currency === currency &&
      this.currency !== "USD" &&
      !controller.signal.aborted &&
      this.rateController === controller
    );
  }

  private persistPrices(): Promise<void> {
    const source = (PRICE_URLS as readonly string[]).includes(this.priceSource)
      ? this.priceSource
      : PRICE_URLS[0];
    return this.persist(PRICES_FILE, {
      schema: 1,
      table: this.prices.document,
      source,
      fetchedAt: this.priceFetchedAt,
      lastAttemptAt: this.priceAttemptAt,
      failures: this.priceFailures,
    });
  }

  private persistRates(): Promise<void> {
    return this.persist(RATES_FILE, {
      schema: 1,
      entries: this.entries,
      lastAttemptAt: this.rateAttemptAt,
      lastFailureAt: this.rateFailureAt,
    });
  }

  private async readCache(name: string, cap: number): Promise<unknown | undefined> {
    let handle: FileHandle | undefined;
    try {
      const file = path.join(this.cacheDir, name);
      const entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > cap)
        throw new Error("invalid cache file");
      handle = await open(file, "r");
      const info = await handle.stat();
      if (!info.isFile() || info.size > cap) throw new Error("invalid cache file");
      // A file that grows after stat is still bounded, rather than readFile()-allocated without a limit.
      const bytes = Buffer.alloc(Math.min(info.size + 1, cap + 1));
      let size = 0;
      while (size < bytes.length) {
        const chunk = await handle.read(bytes, size, bytes.length - size, null);
        if (!chunk.bytesRead) break;
        size += chunk.bytesRead;
      }
      if (size > cap || size > info.size) throw new Error("growing cache file");
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
      ) as unknown;
    } catch (error) {
      if (!(isObject(error) && error.code === "ENOENT")) this.invalidCaches.add(name);
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private persist(name: string, value: unknown): Promise<void> {
    const content = JSON.stringify(value);
    this.writes = this.writes.then(() => this.writeCacheFile(name, content));
    return this.writes;
  }

  private async writeCacheFile(name: string, content: string): Promise<void> {
    const target = path.join(this.cacheDir, name);
    const temporary = path.join(this.cacheDir, `.${name}.${randomUUID()}.tmp`);
    try {
      await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(content, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      // Keep corrupt files as evidence; never remove them or unrelated cache-directory contents.
      if (this.invalidCaches.has(name)) {
        try {
          await rename(target, `${target}.invalid-${randomUUID()}`);
        } catch (error) {
          if (!(isObject(error) && error.code === "ENOENT")) throw error;
        }
        this.invalidCaches.delete(name);
      }
      await rename(temporary, target);
    } catch {
      // Read-only/unavailable storage is not a reason to stop local/offline monitoring.
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.priceController?.abort();
    this.rateController?.abort();
  }
}
