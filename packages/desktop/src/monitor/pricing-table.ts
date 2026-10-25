// Model matching and table rules adapted from zoefix/agent-speed (MIT), spec/METRICS 9.
// Quotes here are current public API-list equivalents, never recorded OMP bills.
export interface OmpMonitorCostInput {
  provider: string | null;
  model: string | null;
  /** OMP's uncached input bucket: cache tokens are already separate. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  serviceTier?: string | null;
}

const PRICE_FIELDS = ["input", "cachedInput", "cacheWrite", "cacheWrite1h", "output"] as const;
type PriceField = (typeof PRICE_FIELDS)[number];
type Prices = Record<PriceField, number>;
interface Tier {
  above: number;
  prices: Prices;
}
interface Pricing {
  prices: Prices;
  tiers: Tier[];
  offPeak?: OffPeak;
}
interface OffPeak extends Pricing {
  windows: Array<[number, number]>;
  weekdays: number[];
  dates: string[];
}
interface Period {
  from: number;
  to: number;
  pricing: Pricing;
}
interface Model {
  id: string;
  free: boolean;
  aliases: string[];
  pricing?: Pricing;
  fast?: Pricing;
  periods: Period[];
}
const NORMALIZE_LISTS = [
  "freeProviders",
  "cloudSuffixes",
  "bedrockRegions",
  "bedrockVendors",
  "freeSuffixes",
  "variantSuffixes",
  "fastSuffixes",
  "dateSuffixPrefixes",
  "dotHyphenPrefixes",
] as const;
type Normalization = Record<(typeof NORMALIZE_LISTS)[number], string[]> & {
  rewrites: Array<{ prefix: string; to: string }>;
  modifierSuffixes: Array<{ prefix: string; suffixes: string[] }>;
};
interface UnknownRule {
  match: "prefix" | "exact";
  value: string;
}
export interface ModelResolution {
  kind: "priced" | "free" | "unknown";
  model?: Model;
  fast: boolean;
}

const MODEL_KEYS = [
  "id",
  "provider",
  "name",
  "status",
  "free",
  "prices",
  "tiers",
  "offPeak",
  "periods",
  "fast",
  "aliases",
  "source",
  "checked",
  "note",
];
const FREE_KEYS = [
  "id",
  "provider",
  "name",
  "status",
  "free",
  "aliases",
  "source",
  "checked",
  "note",
];
const MAX_TOKENS = 100_000_000;
export const PRICE_MAX_BYTES = 1 << 20;
export const DAY_MS = 86_400_000;

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function requireObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("invalid object");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 4096)
    throw new Error("invalid text");
  return value;
}
/** Python str.isspace(), including ASCII separators but deliberately excluding U+FEFF. */
function isPythonWhitespace(codePoint: number): boolean {
  if (codePoint >= 0x09 && codePoint <= 0x0d) return true;
  if (codePoint >= 0x1c && codePoint <= 0x20) return true;
  if (codePoint >= 0x2000 && codePoint <= 0x200a) return true;
  switch (codePoint) {
    case 0x85:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return true;
    default:
      return false;
  }
}

function trim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isPythonWhitespace(value.codePointAt(start)!)) start++;
  while (end > start && isPythonWhitespace(value.codePointAt(end - 1)!)) end--;
  return value.slice(start, end);
}

function collapsePythonWhitespace(value: string): string {
  let result = "";
  let segment = 0;
  let index = 0;
  while (index < value.length) {
    if (!isPythonWhitespace(value.codePointAt(index)!)) {
      index++;
      continue;
    }
    result += value.slice(segment, index) + " ";
    do {
      index++;
    } while (index < value.length && isPythonWhitespace(value.codePointAt(index)!));
    segment = index;
  }
  if (segment === 0) return value;
  return result + value.slice(segment);
}
function lowerText(value: unknown): string {
  const result = text(value);
  if (result !== trim(result).toLowerCase()) throw new Error("invalid lowercase text");
  return result;
}
function list(value: unknown, max = 2000): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("invalid list");
  return value;
}
function lowerList(value: unknown): string[] {
  const result = list(value).map(lowerText);
  if (new Set(result).size !== result.length) throw new Error("duplicate string");
  return result;
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("unknown field");
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  onlyKeys(value, keys);
  if (Object.keys(value).length !== keys.length) throw new Error("missing field");
}
export function dateMillis(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new Error("invalid date");
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value)
    throw new Error("invalid date");
  return ms;
}
function instantMillis(value: unknown): number {
  if (typeof value !== "string") throw new Error("invalid instant");
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return dateMillis(value);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\dZ$/u.test(value))
    throw new Error("invalid instant");
  dateMillis(value.slice(0, 10));
  return Date.parse(value);
}
export function isHttpsSource(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  for (let index = 0; index < value.length; index++) {
    const codePoint = value.codePointAt(index)!;
    if (codePoint <= 0x20 || codePoint === 0x7f) return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}
/** Exact decimal validation, without tolerances that admit a seventh decimal. */
function microPrice(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10_000)
    throw new Error("invalid price");
  const [mantissa, exponent] = String(value).split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const digits = whole! + fraction;
  const scale = 6 + Number(exponent ?? 0) - fraction.length;
  if (scale < 0 && !digits.endsWith("0".repeat(-scale))) throw new Error("price precision");
  const micro =
    scale < 0 ? BigInt(digits) / 10n ** BigInt(-scale) : BigInt(digits) * 10n ** BigInt(scale);
  return Number(micro);
}
function priceSet(value: unknown, tier: boolean): { prices: Prices; fields: string[] } {
  const obj = requireObject(value);
  onlyKeys(obj, tier ? [...PRICE_FIELDS, "above"] : PRICE_FIELDS);
  const input = microPrice(obj.input);
  const output = microPrice(obj.output);
  const cachedInput = obj.cachedInput == null ? input : microPrice(obj.cachedInput);
  const cacheWrite = obj.cacheWrite == null ? input : microPrice(obj.cacheWrite);
  const cacheWrite1h = obj.cacheWrite1h == null ? cacheWrite : microPrice(obj.cacheWrite1h);
  return {
    prices: { input, output, cachedInput, cacheWrite, cacheWrite1h },
    fields: PRICE_FIELDS.filter((key) => obj[key] != null),
  };
}
function pricing(value: unknown, allowed: readonly string[], allowOffPeak = true): Pricing {
  const obj = requireObject(value);
  onlyKeys(obj, allowed);
  const base = priceSet(obj.prices, false);
  let previous = 0;
  const tiers = list(obj.tiers ?? []).map((raw) => {
    const tier = requireObject(raw);
    const parsed = priceSet(tier, true);
    if (
      typeof tier.above !== "number" ||
      !Number.isSafeInteger(tier.above) ||
      tier.above <= previous
    )
      throw new Error("invalid tier threshold");
    if (parsed.fields.join(",") !== base.fields.join(","))
      throw new Error("inconsistent tier prices");
    previous = tier.above;
    return { above: tier.above, prices: parsed.prices };
  });
  const result: Pricing = { prices: base.prices, tiers };
  if (obj.offPeak !== undefined) {
    if (!allowOffPeak) throw new Error("nested off-peak prices");
    const rule = requireObject(obj.offPeak);
    const parsed = pricing(
      rule,
      ["peakUtc", "peakWeekdays", "offPeakDates", "prices", "tiers"],
      false,
    );
    const windows = list(rule.peakUtc).map((raw) => {
      if (typeof raw !== "string" || !/^\d{2}:\d{2}-\d{2}:\d{2}$/u.test(raw))
        throw new Error("invalid peak window");
      const start = Number(raw.slice(0, 2)) * 60 + Number(raw.slice(3, 5));
      const end = Number(raw.slice(6, 8)) * 60 + Number(raw.slice(9, 11));
      if (
        Number(raw.slice(3, 5)) > 59 ||
        Number(raw.slice(9, 11)) > 59 ||
        start < 0 ||
        start >= end ||
        end > 1440
      )
        throw new Error("invalid peak window");
      return [start, end] as [number, number];
    });
    const weekdays = list(rule.peakWeekdays).map((day) => {
      if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7)
        throw new Error("invalid weekday");
      return day;
    });
    if (!windows.length || !weekdays.length) throw new Error("empty peak rule");
    const dates = list(rule.offPeakDates ?? []).map((day) => {
      dateMillis(day);
      return day as string;
    });
    result.offPeak = { ...parsed, windows, weekdays, dates };
  }
  return result;
}
function normalization(value: unknown): Normalization {
  const obj = requireObject(value);
  exactKeys(obj, [...NORMALIZE_LISTS, "rewrites", "modifierSuffixes"]);
  const lists = Object.fromEntries(
    NORMALIZE_LISTS.map((key) => [key, lowerList(obj[key])]),
  ) as Record<(typeof NORMALIZE_LISTS)[number], string[]>;
  const rewrites = list(obj.rewrites).map((raw) => {
    const rule = requireObject(raw);
    exactKeys(rule, ["prefix", "to"]);
    const pair = lowerList([rule.prefix, rule.to]);
    return { prefix: pair[0]!, to: pair[1]! };
  });
  const modifierSuffixes = list(obj.modifierSuffixes).map((raw) => {
    const rule = requireObject(raw);
    exactKeys(rule, ["prefix", "suffixes"]);
    return { prefix: lowerText(rule.prefix), suffixes: lowerList(rule.suffixes) };
  });
  return { ...lists, rewrites, modifierSuffixes };
}

function offPeakApplies(rule: OffPeak, now: number): boolean {
  const at = new Date(now);
  const weekday = at.getUTCDay() || 7;
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  return (
    rule.dates.includes(at.toISOString().slice(0, 10)) ||
    !rule.weekdays.includes(weekday) ||
    !rule.windows.some(([start, end]) => start <= minute && minute < end)
  );
}

function currentModelPricing(model: Model, now: number, fast: boolean): Pricing | undefined {
  if (fast) return model.fast;
  const period = model.periods.find((entry) => entry.from <= now && now < entry.to);
  const selected = period?.pricing ?? model.pricing;
  if (!selected) return undefined;
  if (selected.offPeak && offPeakApplies(selected.offPeak, now)) return selected.offPeak;
  return selected;
}

function validTokenCount(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Integer pico-USD; the per-class cap is applied only after selecting the context tier. */
function tokenClassPicoUsd(tokens: number, price: number): bigint {
  return BigInt(Math.min(MAX_TOKENS, Math.trunc(tokens))) * BigInt(price);
}

function quotePricing(modelPricing: Pricing, input: OmpMonitorCostInput): number {
  // Context includes every input class, but the billed classes remain disjoint.
  const totalInput =
    Math.min(1e12, Math.trunc(input.inputTokens)) +
    Math.min(1e12, Math.trunc(input.cacheReadTokens)) +
    Math.min(1e12, Math.trunc(input.cacheWriteTokens));
  let prices = modelPricing.prices;
  for (const tier of modelPricing.tiers) if (totalInput > tier.above) prices = tier.prices;
  const pico =
    tokenClassPicoUsd(input.inputTokens, prices.input) +
    tokenClassPicoUsd(input.cacheReadTokens, prices.cachedInput) +
    tokenClassPicoUsd(input.cacheWriteTokens, prices.cacheWrite) +
    tokenClassPicoUsd(input.outputTokens, prices.output);
  return Number((pico + 500_000n) / 1_000_000n) / 1_000_000;
}

export class ValidatedPriceTable {
  private readonly byKey = new Map<string, Model>();
  private readonly unknownExact = new Set<string>();
  private readonly unknownPrefixes: string[] = [];
  private readonly resolutions = new Map<string, ModelResolution>();

  constructor(
    readonly version: number,
    readonly updated: string,
    readonly document: unknown,
    private readonly normalize: Normalization,
    models: Model[],
    unknown: UnknownRule[],
  ) {
    for (const model of models) {
      this.byKey.set(model.id, model);
      for (const alias of model.aliases) this.byKey.set(alias, model);
    }
    for (const rule of unknown) {
      if (rule.match === "exact") this.unknownExact.add(rule.value);
      else this.unknownPrefixes.push(rule.value);
    }
  }

  resolve(model: string | null, provider: string | null): ModelResolution {
    if (
      (model !== null && (typeof model !== "string" || model.length > 4096)) ||
      (provider !== null && (typeof provider !== "string" || provider.length > 4096))
    )
      return { kind: "unknown", fast: false };
    const cacheKey = JSON.stringify([model, provider]);
    const cached = this.resolutions.get(cacheKey);
    if (cached) return cached;
    const result = this.compute(model, provider);
    if (this.resolutions.size >= 4096) this.resolutions.clear();
    this.resolutions.set(cacheKey, result);
    return result;
  }

  private compute(model: string | null, provider: string | null): ModelResolution {
    const n = this.normalize;
    const unknown: ModelResolution = { kind: "unknown", fast: false };
    if (
      provider &&
      n.freeProviders.includes(trim(provider).toLowerCase()) &&
      !(model && n.cloudSuffixes.some((suffix) => trim(model).toLowerCase().endsWith(suffix)))
    )
      return { kind: "free", fast: false };
    if (!model || !trim(model)) return unknown;
    for (const [key, fast] of this.candidates(model)) {
      if (key === null) return { kind: "free", fast: false };
      const match = this.byKey.get(key);
      if (match) {
        if (match.free) return { kind: "free", model: match, fast: false };
        if (fast && !match.fast) return unknown;
        return { kind: "priced", model: match, fast };
      }
      if (
        this.unknownExact.has(key) ||
        this.unknownPrefixes.some((prefix) => key.startsWith(prefix))
      )
        return unknown;
    }
    return unknown;
  }

  private *candidates(model: string): Generator<[string | null, boolean]> {
    const n = this.normalize;
    let key = trim(collapsePythonWhitespace(model.replace(/\[[^\]]*\]/gu, " "))).toLowerCase();
    yield [key, false];
    if (key.includes("/")) {
      key = key.slice(key.lastIndexOf("/") + 1);
      yield [key, false];
    }
    for (const region of n.bedrockRegions) {
      const rest = key.slice(region.length + 1);
      if (
        key.startsWith(`${region}.`) &&
        n.bedrockVendors.some((vendor) => rest.startsWith(`${vendor}.`))
      ) {
        key = rest;
        break;
      }
    }
    for (const vendor of n.bedrockVendors) {
      if (key.startsWith(`${vendor}.`)) {
        key = key
          .slice(vendor.length + 1)
          .replace(/-v\p{Decimal_Number}+(?::\p{Decimal_Number}+)?$/u, "");
        break;
      }
    }
    key = key.replace(/@(\p{Decimal_Number}{8})$/u, "-$1").replace(/@[^@/]*$/u, "");
    yield [key, false];
    if (n.freeSuffixes.some((suffix) => key.length > suffix.length && key.endsWith(suffix))) {
      yield [null, false];
      return;
    }
    key = this.stripSuffixes(key, n.variantSuffixes, 0);
    yield [key, false];
    for (const rule of n.rewrites) {
      if (key.startsWith(rule.prefix)) {
        key = rule.to + key.slice(rule.prefix.length);
        break;
      }
    }
    yield [key, false];
    let fast = false;
    for (const suffix of n.fastSuffixes) {
      if (key.length > suffix.length && key.endsWith(suffix)) {
        key = key.slice(0, -suffix.length);
        fast = true;
        break;
      }
    }
    if (fast) yield [key, true];
    if (n.dateSuffixPrefixes.some((prefix) => key.startsWith(prefix)))
      key = key.replace(/-\p{Decimal_Number}{8}$/u, "");
    yield [key, fast];
    for (const rule of n.modifierSuffixes) {
      if (key.startsWith(rule.prefix)) {
        key = this.stripSuffixes(key, rule.suffixes, rule.prefix.length);
        break;
      }
    }
    yield [key, fast];
    if (n.dotHyphenPrefixes.some((prefix) => key.startsWith(prefix)))
      key = key.replaceAll(".", "-");
    yield [key, fast];
  }

  private stripSuffixes(key: string, suffixes: string[], minimum: number): string {
    let stripped = true;
    while (stripped) {
      stripped = false;
      for (const suffix of suffixes) {
        if (key.length > minimum + suffix.length && key.endsWith(suffix)) {
          key = key.slice(0, -suffix.length);
          stripped = true;
        }
      }
    }
    return key;
  }

  estimateCost(input: OmpMonitorCostInput, now: number): number | null {
    if (typeof input.model !== "string" || !trim(input.model)) return null;
    if (input.serviceTier != null && typeof input.serviceTier !== "string") return null;
    if (
      !validTokenCount(input.inputTokens) ||
      !validTokenCount(input.cacheReadTokens) ||
      !validTokenCount(input.cacheWriteTokens) ||
      !validTokenCount(input.outputTokens)
    )
      return null;
    const resolution = this.resolve(input.model, input.provider);
    if (resolution.kind === "unknown") return null;
    if (resolution.kind === "free") return 0;
    const tier = input.serviceTier?.trim().toLowerCase();
    const fast = resolution.fast || tier === "priority" || tier === "fast";
    if (tier && !["priority", "fast", "none", "default", "standard"].includes(tier)) return null;
    const selected = currentModelPricing(resolution.model!, now, fast);
    if (!selected) return null;
    return quotePricing(selected, input);
  }
}

function validateProviders(value: unknown): Record<string, unknown> {
  const providers = requireObject(value);
  const entries = Object.entries(providers);
  if (!entries.length || entries.length > 2000) throw new Error("invalid providers");
  for (const [key, raw] of entries) {
    const provider = requireObject(raw);
    if (
      !/^[a-z0-9][a-z0-9._:+-]*$/u.test(key) ||
      !isHttpsSource(provider.url) ||
      !trim(text(provider.name))
    )
      throw new Error("invalid provider");
  }
  return providers;
}

function validatePricePeriods(value: unknown): Period[] {
  const periods: Period[] = [];
  for (const raw of list(value)) {
    const period = requireObject(raw);
    if (period.from === undefined && period.to === undefined)
      throw new Error("unbounded price period");
    const from = period.from === undefined ? -Infinity : instantMillis(period.from);
    const to = period.to === undefined ? Infinity : instantMillis(period.to);
    if (from >= to || (period.note !== undefined && typeof period.note !== "string"))
      throw new Error("invalid price period");
    for (const existing of periods) {
      if (from < existing.to && existing.from < to) throw new Error("overlapping price periods");
    }
    periods.push({
      from,
      to,
      pricing: pricing(period, ["from", "to", "prices", "tiers", "offPeak", "note"]),
    });
  }
  return periods;
}

function registerModelIdentity(keys: Set<string>, key: string): void {
  if (keys.has(key)) throw new Error("duplicate model identity");
  keys.add(key);
}

function validatePriceModel(
  raw: unknown,
  providers: Record<string, unknown>,
  updated: string,
  keys: Set<string>,
): Model {
  const entry = requireObject(raw);
  const id = text(entry.id);
  if (
    !/^[a-z0-9][a-z0-9._:+-]*$/u.test(id) ||
    typeof entry.provider !== "string" ||
    !Object.hasOwn(providers, entry.provider)
  )
    throw new Error("invalid model identity");
  if (
    !trim(text(entry.name)) ||
    !["current", "preview", "legacy", "deprecated", "retired"].includes(text(entry.status))
  )
    throw new Error("invalid model metadata");
  if (!isHttpsSource(entry.source)) throw new Error("invalid model source");
  dateMillis(entry.checked);
  if (
    (entry.checked as string) > updated ||
    (entry.note !== undefined && typeof entry.note !== "string")
  )
    throw new Error("invalid model date or note");
  const aliases = lowerList(entry.aliases ?? []);
  registerModelIdentity(keys, id);
  for (const alias of aliases) registerModelIdentity(keys, alias);
  const model: Model = { id, free: entry.free === true, aliases, periods: [] };
  if (entry.free === true) {
    onlyKeys(entry, FREE_KEYS);
    return model;
  }
  if (entry.free !== undefined) throw new Error("invalid free flag");
  model.pricing = pricing(entry, MODEL_KEYS);
  if (entry.fast !== undefined) model.fast = pricing(entry.fast, ["prices", "tiers"], false);
  model.periods = validatePricePeriods(entry.periods ?? []);
  return model;
}

function validateUnknownRules(rulesDocument: unknown, keys: Set<string>): UnknownRule[] {
  const unknown: UnknownRule[] = [];
  for (const raw of list(rulesDocument)) {
    const rule = requireObject(raw);
    if (rule.match !== "prefix" && rule.match !== "exact") throw new Error("invalid unknown rule");
    const value = lowerText(rule.value);
    text(rule.reason);
    for (const key of keys) {
      if (rule.match === "exact" ? key === value : key.startsWith(value))
        throw new Error("unknown rule shadows a model");
    }
    unknown.push({ match: rule.match, value });
  }
  return unknown;
}

function verifyModelIdentity(table: ValidatedPriceTable, model: Model, key: string): void {
  const resolution = table.resolve(key, null);
  if (
    resolution.model !== model ||
    resolution.fast ||
    resolution.kind !== (model.free ? "free" : "priced")
  )
    throw new Error("model fails its identity test");
}

function verifyTableSelfTests(table: ValidatedPriceTable, value: unknown): void {
  for (const raw of list(value, 10_000)) {
    const test = requireObject(raw);
    if (
      !Object.hasOwn(test, "model") ||
      (test.model !== null && typeof test.model !== "string") ||
      (test.provider != null && typeof test.provider !== "string")
    )
      throw new Error("invalid price self-test");
    const expect = text(test.expect);
    const resolution = table.resolve(test.model, test.provider ?? null);
    let label: string = resolution.kind;
    if (resolution.kind === "priced") {
      label = resolution.model!.id;
      if (resolution.fast) label += " fast";
    }
    if (label !== expect) throw new Error("price self-test failed");
  }
}

/** Rejects malformed or incompatible data before it can replace a last-good catalog. */
export function validatePriceTable(document: unknown, now: number): ValidatedPriceTable {
  const obj = requireObject(document);
  if (obj.schema !== 1) throw new Error("unsupported price schema");
  if (typeof obj.version !== "number" || !Number.isSafeInteger(obj.version) || obj.version < 1)
    throw new Error("invalid price version");
  const updated = text(obj.updated);
  if (dateMillis(updated) > now + 2 * DAY_MS) throw new Error("future price date");
  if (obj.currency !== "USD" || obj.unit !== "perMillionTokens")
    throw new Error("invalid price units");
  const providers = validateProviders(obj.providers);
  const norm = normalization(obj.normalize);
  const rawModels = list(obj.models);
  if (!rawModels.length) throw new Error("empty price table");
  const keys = new Set<string>();
  const models = rawModels.map((raw) => validatePriceModel(raw, providers, updated, keys));
  const unknown = validateUnknownRules(obj.unknown ?? [], keys);
  const table = new ValidatedPriceTable(obj.version, updated, document, norm, models, unknown);
  for (const model of models) {
    verifyModelIdentity(table, model, model.id);
    for (const alias of model.aliases) verifyModelIdentity(table, model, alias);
  }
  verifyTableSelfTests(table, obj.tests ?? []);
  return table;
}
