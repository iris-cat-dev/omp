// USD lists only. Fallback data is the upstream currency-api CC0 snapshot, not ExchangeRate-API data.
import { DAY_MS, dateMillis, isHttpsSource, isObject } from "./pricing-table.js";

export const FX_MAX_BYTES = 256 << 10;
export const FX_PROVIDERS = [
  { url: "https://open.er-api.com/v6/latest/USD", shape: "er-api", family: "er-api" },
  {
    url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
    shape: "fawaz",
    family: "fawaz",
  },
  {
    url: "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
    shape: "fawaz",
    family: "fawaz",
  },
  {
    url: "https://api.frankfurter.dev/v1/latest?base=USD",
    shape: "frankfurter",
    family: "frankfurter",
  },
] as const;
export type FxProvider = (typeof FX_PROVIDERS)[number];
export interface CurrencyCatalog {
  codes: string[];
  fallbackDate: number;
  fallbackSource: string;
  fallbackRates: Record<string, number>;
}
export interface RateEntry {
  rate: number;
  date: number;
  fetchedAt: number | null;
  source: string;
}
export interface ParsedRates {
  provider: FxProvider;
  date: number;
  rates: Record<string, number>;
}
export const FX_ATTRIBUTION = {
  label: "ExchangeRate-API",
  url: "https://www.exchangerate-api.com",
} as const;

export function validRate(value: unknown): value is number {
  // All supported fiat currencies are well inside these conservative, finite bounds.
  return typeof value === "number" && Number.isFinite(value) && value >= 1e-12 && value <= 1e12;
}

interface CurrencyDefinition extends Record<string, unknown> {
  code: string;
  common: number | null;
}

function validateCurrencyPresentation(value: Record<string, unknown>): void {
  if (
    typeof value.digits !== "number" ||
    !Number.isInteger(value.digits) ||
    value.digits < 0 ||
    value.digits > 3
  )
    throw new Error("invalid currency precision");
  if (
    typeof value.symbol !== "string" ||
    !value.symbol.length ||
    value.symbol.trim() !== value.symbol
  )
    throw new Error("invalid currency symbol");
  if (value.symbols === undefined) return;
  if (
    !isObject(value.symbols) ||
    Object.entries(value.symbols).some(
      ([key, symbol]) =>
        !["zh-Hant", "zh-Hans", "en", "ja"].includes(key) ||
        typeof symbol !== "string" ||
        !symbol.length,
    )
  )
    throw new Error("invalid localized currency symbol");
}

function validateCurrencyDefinition(value: unknown): asserts value is CurrencyDefinition {
  if (
    !isObject(value) ||
    Object.keys(value).some(
      (key) => !["code", "digits", "symbol", "symbols", "common"].includes(key),
    )
  )
    throw new Error("invalid currency entry");
  if (typeof value.code !== "string" || !/^[A-Z]{3}$/u.test(value.code))
    throw new Error("invalid currency code");
  validateCurrencyPresentation(value);
  if (
    value.common !== null &&
    (typeof value.common !== "number" || !Number.isInteger(value.common) || value.common < 1)
  )
    throw new Error("invalid currency rank");
}

function validateCurrencyFallback(value: unknown, codes: string[]): CurrencyCatalog {
  if (
    !isObject(value) ||
    value.base !== "USD" ||
    !isHttpsSource(value.source) ||
    !isObject(value.rates)
  )
    throw new Error("invalid fallback rates");
  const fallbackDate = dateMillis(value.date);
  if (Object.keys(value.rates).length !== codes.length)
    throw new Error("incomplete fallback rates");
  const fallbackRates: Record<string, number> = {};
  for (const code of codes) {
    const rate = value.rates[code];
    if (!validRate(rate) || (code === "USD" && rate !== 1))
      throw new Error("invalid fallback rate");
    fallbackRates[code] = rate;
  }
  return { codes, fallbackDate, fallbackSource: value.source, fallbackRates };
}

export function validateCurrencies(document: unknown): CurrencyCatalog {
  if (
    !isObject(document) ||
    document.schema !== 1 ||
    !Array.isArray(document.currencies) ||
    document.currencies.length !== 38
  )
    throw new Error("invalid currency catalog");
  const codes: string[] = [];
  const common: number[] = [];
  for (const raw of document.currencies) {
    validateCurrencyDefinition(raw);
    if (codes.includes(raw.code)) throw new Error("invalid currency code");
    if (raw.common !== null) common.push(raw.common);
    codes.push(raw.code);
  }
  if (
    !codes.includes("USD") ||
    common.sort((a, b) => a - b).some((rank, index) => rank !== index + 1)
  )
    throw new Error("invalid currency ordering");
  return validateCurrencyFallback(document.fallbackRates, codes);
}

export function bundledRateEntries(currencies: CurrencyCatalog): Record<string, RateEntry> {
  return Object.fromEntries(
    currencies.codes.map((code) => [
      code,
      {
        rate: currencies.fallbackRates[code]!,
        date: currencies.fallbackDate,
        fetchedAt: null,
        source: currencies.fallbackSource,
      },
    ]),
  );
}

function providerRateDate(document: Record<string, unknown>, provider: FxProvider): number {
  if (provider.shape === "er-api") {
    if (
      document.result !== "success" ||
      document.base_code !== "USD" ||
      typeof document.time_last_update_unix !== "number" ||
      !Number.isSafeInteger(document.time_last_update_unix) ||
      document.time_last_update_unix <= 0
    )
      throw new Error("invalid USD rate response");
    return document.time_last_update_unix * 1000;
  }
  if (
    provider.shape === "frankfurter" &&
    (document.base !== "USD" || (document.amount !== undefined && document.amount !== 1))
  )
    throw new Error("invalid USD rate base");
  return dateMillis(document.date);
}

export function parseRates(
  document: unknown,
  provider: FxProvider,
  currencies: CurrencyCatalog,
  now: number,
): ParsedRates {
  if (!isObject(document)) throw new Error("invalid rate object");
  const date = providerRateDate(document, provider);
  const raw = provider.shape === "fawaz" ? document.usd : document.rates;
  if (!Number.isSafeInteger(date) || date <= 0 || date > now + 2 * DAY_MS || !isObject(raw))
    throw new Error("invalid rate date or list");
  const rates: Record<string, number> = {};
  for (const [code, value] of Object.entries(raw)) {
    const upper = code.toUpperCase();
    if (!currencies.codes.includes(upper)) continue;
    if (Object.hasOwn(rates, upper) || !validRate(value) || (upper === "USD" && value !== 1))
      throw new Error("invalid supported rate");
    rates[upper] = value;
  }
  rates.USD = 1;
  return { provider, date, rates };
}

/** A stale reference needs two independent providers, not two mirrors of currency-api. */
export function checkRateCandidate(
  candidate: ParsedRates,
  selected: string,
  reference: RateEntry,
  now: number,
  latestDate: number,
  other?: ParsedRates,
): "accepted" | "needs-confirmation" {
  if (candidate.date < latestDate || candidate.date < reference.date)
    throw new Error("rate date rollback");
  const rate = candidate.rates[selected];
  if (!validRate(rate)) throw new Error("selected rate missing");
  if (now - reference.date <= 30 * DAY_MS) {
    if (rate < reference.rate * 0.5 || rate > reference.rate * 2)
      throw new Error("rate outside sanity bounds");
    return "accepted";
  }
  if (
    !other ||
    other.provider.family === candidate.provider.family ||
    !validRate(other.rates[selected])
  )
    return "needs-confirmation";
  if (Math.abs(rate - other.rates[selected]!) > other.rates[selected]! * 0.03)
    throw new Error("rate providers disagree");
  return "accepted";
}

/** Missing currencies keep both their old value and their original date/source. */
export function mergeRates(
  previous: Record<string, RateEntry>,
  accepted: ParsedRates,
  now: number,
  confirmation?: ParsedRates,
): Record<string, RateEntry> {
  const entries = { ...previous };
  for (const [code, rate] of Object.entries(accepted.rates)) {
    const reference = previous[code];
    if (!reference || code === "USD" || accepted.date < reference.date) continue;
    if (now - reference.date > 30 * DAY_MS) {
      const other = confirmation?.rates[code];
      if (
        !validRate(other) ||
        confirmation!.provider.family === accepted.provider.family ||
        Math.abs(rate - other) > other * 0.03
      )
        continue;
    } else if (rate < reference.rate * 0.5 || rate > reference.rate * 2) continue;
    entries[code] = { rate, date: accepted.date, fetchedAt: now, source: accepted.provider.url };
  }
  return entries;
}
