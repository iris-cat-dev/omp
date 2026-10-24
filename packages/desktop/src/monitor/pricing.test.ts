import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_CURRENCY_TABLE, BUNDLED_PRICE_TABLE } from "./pricing-assets.js";
import { OmpPriceCatalog, type OmpMonitorCostInput } from "./pricing.js";
import {
  DAY_MS,
  PRICE_MAX_BYTES,
  isHttpsSource,
  isObject,
  validatePriceTable,
} from "./pricing-table.js";
import {
  FX_MAX_BYTES,
  FX_PROVIDERS,
  bundledRateEntries,
  checkRateCandidate,
  mergeRates,
  parseRates,
  validateCurrencies,
} from "./pricing-rates.js";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const PRICE_URL =
  "https://raw.githubusercontent.com/zoefix/agent-speed/main/spec/assets/prices.json";
const MIRROR_URL = "https://cdn.jsdelivr.net/gh/zoefix/agent-speed@main/spec/assets/prices.json";
const currencies = validateCurrencies(BUNDLED_CURRENCY_TABLE);
const roots: string[] = [];
const catalogs: OmpPriceCatalog[] = [];
const QUOTE: OmpMonitorCostInput = {
  provider: "openai",
  model: "gpt-5",
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 1_000_000,
};
const CACHED_QUOTE: OmpMonitorCostInput = {
  provider: null,
  model: null,
  inputTokens: 100,
  outputTokens: 100,
  cacheReadTokens: 900,
  cacheWriteTokens: 0,
};
interface TestModel extends Record<string, unknown> {
  id: string;
  prices?: Record<string, unknown>;
}
interface TestTable {
  schema: number;
  version: number;
  updated: string;
  models: TestModel[];
  tests: Array<Record<string, unknown>>;
  unknown: Array<Record<string, unknown>>;
  normalize: Record<string, unknown>;
}

function newTable(): TestTable {
  const document = structuredClone(BUNDLED_PRICE_TABLE) as TestTable;
  document.version++;
  return document;
}
function quoteTable(): TestTable {
  const document = newTable();
  // USD per million tokens; cache writes intentionally use the uncached-input fallback.
  document.models.find((model) => model.id === "gpt-5")!.prices = {
    input: 2,
    cachedInput: 0.125,
    output: 10,
  };
  return document;
}
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function fxResponse(
  url: string,
  selected: Record<string, number> = { CNY: 6.7 },
  date = "2026-10-24",
): Response {
  const rates = { ...currencies.fallbackRates, ...selected };
  if (url === FX_PROVIDERS[0].url)
    return jsonResponse({
      result: "success",
      base_code: "USD",
      time_last_update_unix: Date.parse(`${date}T00:00:00Z`) / 1000,
      rates,
    });
  if (url === FX_PROVIDERS[3].url)
    return jsonResponse({ amount: 1, base: "USD", date, rates: selected });
  return jsonResponse({
    date,
    usd: Object.fromEntries(
      Object.entries(rates).map(([code, value]) => [code.toLowerCase(), value]),
    ),
  });
}
async function createCatalog(
  fetcher: typeof globalThis.fetch,
  clock: () => number = () => NOW,
  root?: string,
) {
  const cacheDir = root ?? (await mkdtemp(path.join(tmpdir(), "omp-monitor-pricing-")));
  if (!root) roots.push(cacheDir);
  const catalog = new OmpPriceCatalog({ cacheDir, fetch: fetcher, now: clock });
  catalogs.push(catalog);
  return { catalog, cacheDir };
}

// Every test owns its cache. None sends network requests or accesses OMP's real user data.
afterEach(async () => {
  for (const catalog of catalogs.splice(0)) catalog.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("real bundled API-list equivalents", () => {
  it("prices disjoint uncached/read/write/output classes without subtracting cache twice", () => {
    const table = validatePriceTable(BUNDLED_PRICE_TABLE, NOW);
    expect(table.estimateCost(QUOTE, NOW)).toBe(12.625); // 1.25 + .125 + 1.25 + 10
    expect(
      table.estimateCost(
        {
          ...QUOTE,
          model: "anthropic/claude-sonnet-4.5",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 200,
          cacheWriteTokens: 300,
        },
        NOW,
      ),
    ).toBe(0.001785);
    expect(
      table.estimateCost(
        {
          ...QUOTE,
          model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 200,
          cacheWriteTokens: 300,
        },
        NOW,
      ),
    ).toBe(0.001785);
  });

  it("preserves Python whitespace normalization without treating U+FEFF as whitespace", () => {
    const table = validatePriceTable(BUNDLED_PRICE_TABLE, NOW);
    const separators =
      "\t\n\u000b\f\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
    for (const separator of separators) {
      expect(table.estimateCost({ ...QUOTE, model: `${separator}gpt-5${separator}` }, NOW)).toBe(
        12.625,
      );
      expect(
        table.resolve(`Gemini${separator}3.1${separator}Pro${separator}(High)`, null).model?.id,
      ).toBe("gemini-3.1-pro-preview");
    }
    expect(table.resolve("\ufeffgpt-5", null).kind).toBe("unknown");
    expect(table.resolve("gpt-5\ufeff", null).kind).toBe("unknown");
  });

  it("rejects every ASCII source-URL control character before URL normalization", () => {
    expect(isHttpsSource("https://example.com/prices")).toBe(true);
    for (let codePoint = 0; codePoint <= 0x20; codePoint++) {
      expect(isHttpsSource(`https://example.com/${String.fromCodePoint(codePoint)}prices`)).toBe(
        false,
      );
    }
    expect(isHttpsSource(`https://example.com/${String.fromCodePoint(0x7f)}prices`)).toBe(false);
  });

  it("selects long-context tiers from total input, with strict above boundaries", () => {
    const table = validatePriceTable(BUNDLED_PRICE_TABLE, NOW);
    const input = {
      ...QUOTE,
      model: "gemini-2.5-pro",
      inputTokens: 190_000,
      outputTokens: 0,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 0,
    };
    expect(table.estimateCost(input, NOW)).toBe(0.23875);
    expect(table.estimateCost({ ...input, cacheReadTokens: 10_001 }, NOW)).toBe(0.4775);
  });

  it("uses fast prices only for explicit logged tiers or an explicitly recognized model id", () => {
    const table = validatePriceTable(BUNDLED_PRICE_TABLE, NOW);
    const input = { ...QUOTE, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(table.estimateCost(input, NOW)).toBe(1.25);
    expect(table.estimateCost({ ...input, serviceTier: "priority" }, NOW)).toBe(2.5);
    expect(table.estimateCost({ ...input, serviceTier: "fast" }, NOW)).toBe(2.5);
    expect(table.estimateCost({ ...input, model: "gpt-5-fast" }, NOW)).toBe(2.5);
    expect(table.estimateCost({ ...input, serviceTier: "default" }, NOW)).toBe(1.25);
    expect(table.estimateCost({ ...input, serviceTier: "flex" }, NOW)).toBeNull();
    expect(table.estimateCost({ ...input, serviceTier: "auto" }, NOW)).toBeNull();
    expect(
      table.estimateCost({ ...input, model: "claude-sonnet-4-5", serviceTier: "priority" }, NOW),
    ).toBeNull();
  });

  it.each(["deepseek-v4.1-flash-1017", "deepseek-v4.1-flash", "deepseek-flash"])(
    "prices %s as canonical Flash without charging cached input twice",
    (model) => {
      const table = validatePriceTable(BUNDLED_PRICE_TABLE, NOW);
      for (const provider of [null, "deepseek", "custom"]) {
        const quote = { ...CACHED_QUOTE, model, provider };
        expect(table.resolve(model, provider).model?.id).toBe("deepseek-flash");
        expect(table.estimateCost(quote, NOW)).toBe(0.000078);
        expect(table.estimateCost({ ...quote, inputTokens: 1000, cacheReadTokens: 0 }, NOW)).toBe(
          0.00021,
        );
        expect(table.estimateCost({ ...quote, inputTokens: 0, cacheReadTokens: 1000 }, NOW)).toBe(
          0.000063,
        );
      }
    },
  );

  it.each([
    ["2026-04-26T12:14Z", 67],
    ["2026-04-26T12:15Z", 45],
    ["2026-08-16T16:00Z", 94],
    ["2026-09-10T03:59Z", 189],
    ["2026-09-10T04:00Z", 78],
    ["2026-10-23T02:00Z", 155],
    ["2026-10-23T04:00Z", 78],
    ["2026-10-24T02:00Z", 78],
    ["2026-10-01T02:00Z", 78],
  ] as const)("keeps DeepSeek Flash periods and off-peak boundaries at %s", (at, microUsd) => {
    const table = validatePriceTable(BUNDLED_PRICE_TABLE, NOW);
    for (const model of ["deepseek-v4.1-flash-1017", "deepseek-v4.1-flash", "deepseek-flash"])
      expect(
        table.estimateCost({ ...CACHED_QUOTE, model, provider: "deepseek" }, Date.parse(at)),
      ).toBe(microUsd / 1_000_000);
  });

  it.each([
    { model: "Gemini 3.8 Flash", canonical: "gemini-3.8-flash", microUsd: 518 },
    { model: "Gemini 4 Argon", canonical: "gemini-4-argon", microUsd: 1290 },
  ])(
    "quotes the documented $model display alias even without a provider",
    ({ model, canonical, microUsd }) => {
      const table = validatePriceTable(BUNDLED_PRICE_TABLE, NOW);
      for (const provider of [null, "google", "custom"]) {
        expect(table.resolve(model, provider).model?.id).toBe(canonical);
        expect(table.estimateCost({ ...CACHED_QUOTE, model, provider }, NOW)).toBe(
          microUsd / 1_000_000,
        );
        expect(table.estimateCost({ ...CACHED_QUOTE, model: canonical, provider }, NOW)).toBe(
          microUsd / 1_000_000,
        );
      }
    },
  );

  it.each([
    ["Gemini 4 Argon", "2026-11-30T23:59:59.999Z", 1290],
    ["Gemini 4 Argon", "2026-12-01T00:00:00Z", 2580],
    ["Gemini 3.8 Flash", "2026-12-31T23:59:59.999Z", 518],
    ["Gemini 3.8 Flash", "2027-01-01T00:00:00Z", 1035],
  ] as const)("keeps %s on its published price at %s", (model, at, microUsd) => {
    const table = validatePriceTable(BUNDLED_PRICE_TABLE, NOW);
    expect(table.estimateCost({ ...CACHED_QUOTE, model }, Date.parse(at))).toBe(
      microUsd / 1_000_000,
    );
  });

  it("keeps unknown and unsafe matches unknown, while recognizing documented free/local usage", () => {
    const table = validatePriceTable(BUNDLED_PRICE_TABLE, NOW);
    for (const model of [
      null,
      "",
      " \t",
      "default-model",
      "gpt-5-made-up-discount",
      "gpt-5.999",
      "openrouter/auto",
      "codex-auto-review",
      "deepseek-v4.1-flash-9999",
      "deepseek-v4.1-flash-1017-other",
      "deepseek-unrecognized-model",
      "Gemini Unannounced Model",
      "gemini-pro-default",
      "gemini-3.1-flash",
      "neko-model-gemini-4-argon",
      "gemini-internal-router",
    ])
      for (const provider of [null, "openai", "deepseek", "google", "custom"]) {
        expect(table.resolve(model, provider).kind).toBe("unknown");
        expect(table.estimateCost({ ...QUOTE, model, provider }, NOW)).toBeNull();
      }
    for (const model of [null, "", " \t"])
      expect(table.estimateCost({ ...QUOTE, model, provider: "ollama" }, NOW)).toBeNull();
    expect(
      table.estimateCost({ ...QUOTE, model: "qwen3-coder:30b", provider: "ollama" }, NOW),
    ).toBe(0);
    expect(
      table.estimateCost({ ...QUOTE, model: "gpt-oss:120b-cloud", provider: "ollama" }, NOW),
    ).toBeNull();
    expect(table.estimateCost({ ...QUOTE, model: "deepseek/deepseek-v4-flash:free" }, NOW)).toBe(0);
    expect(table.estimateCost({ ...QUOTE, provider: "custom" }, NOW)).toBe(12.625);
  });

  it("applies current published periods/off-peak rules rather than pretending to reproduce old bills", () => {
    const table = validatePriceTable(BUNDLED_PRICE_TABLE, NOW);
    const input = {
      ...QUOTE,
      model: "deepseek-chat",
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(table.estimateCost(input, NOW)).toBe(0.14);
    expect(
      table.estimateCost({ ...input, model: "deepseek-flash" }, Date.parse("2026-10-26T02:00:00Z")),
    ).toBe(0.3);
    expect(
      table.estimateCost({ ...input, model: "deepseek-flash" }, Date.parse("2026-10-25T02:00:00Z")),
    ).toBe(0.15);
  });

  it("bounds numeric estimates and rejects invalid token inputs", () => {
    const table = validatePriceTable(BUNDLED_PRICE_TABLE, NOW);
    expect(
      table.estimateCost(
        {
          ...QUOTE,
          inputTokens: 1e20,
          outputTokens: 1e20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        NOW,
      ),
    ).toBe(1125);
    for (const inputTokens of [NaN, Infinity, -1])
      expect(table.estimateCost({ ...QUOTE, inputTokens }, NOW)).toBeNull();
  });
});

describe("table validation before cutover", () => {
  it.each([
    [
      "new schema",
      (table: TestTable) => {
        table.schema = 2;
      },
    ],
    [
      "future date",
      (table: TestTable) => {
        table.updated = "2026-11-01";
      },
    ],
    [
      "bad calendar date",
      (table: TestTable) => {
        table.updated = "2026-02-30";
      },
    ],
    [
      "duplicate id",
      (table: TestTable) => {
        table.models[1]!.id = table.models[0]!.id;
      },
    ],
    [
      "bad alias",
      (table: TestTable) => {
        table.models[0]!.aliases = ["UNTRIMMED "];
      },
    ],
    [
      "insecure source",
      (table: TestTable) => {
        table.models[0]!.source = "http://example.com";
      },
    ],
    [
      "credential source",
      (table: TestTable) => {
        table.models[0]!.source = "https://secret@example.com";
      },
    ],
    [
      "infinite price",
      (table: TestTable) => {
        table.models[0]!.prices!.input = Infinity;
      },
    ],
    [
      "price bounds",
      (table: TestTable) => {
        table.models[0]!.prices!.input = 10001;
      },
    ],
    [
      "price precision",
      (table: TestTable) => {
        table.models[0]!.prices!.input = 0.1234567;
      },
    ],
    [
      "tier fields",
      (table: TestTable) => {
        table.models[0]!.tiers = [{ above: 100, input: 1, output: 1 }];
      },
    ],
    [
      "tier ordering",
      (table: TestTable) => {
        const model = table.models.find((entry) => entry.id === "gemini-2.5-pro")!;
        model.tiers = [
          { above: 200, input: 2, cachedInput: 0.2, output: 10 },
          { above: 100, input: 3, cachedInput: 0.3, output: 15 },
        ];
      },
    ],
    [
      "unknown shadow",
      (table: TestTable) => {
        table.unknown.push({ match: "prefix", value: "claude-", reason: "shadow" });
      },
    ],
    [
      "mismatched self-test",
      (table: TestTable) => {
        table.tests[0]!.expect = "unknown";
      },
    ],
    [
      "excess model count",
      (table: TestTable) => {
        table.models = Array.from({ length: 2001 }, () => table.models[0]!);
      },
    ],
  ])("rejects %s", (_name, change) => {
    const table = newTable();
    change(table);
    expect(() => validatePriceTable(table, NOW)).toThrow();
  });
});

describe("network settings, persistence and cadence", () => {
  it("loads the persisted opt-out before any automatic or manual request, and persists a changed currency", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    const { catalog, cacheDir } = await createCatalog(fetcher);
    await writeFile(
      path.join(cacheDir, "pricing-settings.json"),
      JSON.stringify({ schema: 1, networkEnabled: false, currency: "CNY" }),
    );
    await catalog.refresh({ force: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(catalog.getState().exchangeRate).toBe(6.67476);
    await catalog.configure({ currency: "EUR" });
    await catalog.refresh({ force: true });
    expect(fetcher).not.toHaveBeenCalled();
    catalog.dispose();
    const { catalog: restarted } = await createCatalog(fetcher, () => NOW, cacheDir);
    await restarted.initialize();
    expect(restarted.getState()).toMatchObject({
      networkEnabled: false,
      currency: "EUR",
      exchangeRate: 0.889437,
    });
    await restarted.refresh({ force: true });
    expect(fetcher).not.toHaveBeenCalled();
    for (const currency of ["cny", "BTC", "__proto__", "https://example.com"])
      await expect(restarted.configure({ currency })).rejects.toThrow("unsupported currency");
    expect(restarted.getState().currency).toBe("EUR");
  });

  it("fails closed on malformed settings, preserves the file, and serializes concurrent settings changes", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>();
    const { catalog, cacheDir } = await createCatalog(fetcher);
    await writeFile(path.join(cacheDir, "pricing-settings.json"), "{broken opt-out");
    await catalog.refresh({ force: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(catalog.getState().networkEnabled).toBe(false);
    expect(await readFile(path.join(cacheDir, "pricing-settings.json"), "utf8")).toBe(
      "{broken opt-out",
    );
    await Promise.all([
      catalog.configure({ currency: "EUR" }),
      catalog.configure({ currency: "JPY" }),
    ]);
    const { catalog: restarted } = await createCatalog(fetcher, () => NOW, cacheDir);
    await restarted.refresh({ force: true });
    expect(restarted.getState()).toMatchObject({ currency: "JPY", networkEnabled: false });
    expect(fetcher).not.toHaveBeenCalled();
    const archived = (await readdir(cacheDir)).find((name) =>
      name.startsWith("pricing-settings.json.invalid-"),
    );
    expect(archived).toBeTruthy();
    expect(await readFile(path.join(cacheDir, archived!), "utf8")).toBe("{broken opt-out");
  });

  it("honors the 60-second launch delay, daily success schedule and USD's zero-FX rule", async () => {
    let now = NOW;
    const document = newTable();
    const calls: Array<{ url: string; options: RequestInit | undefined }> = [];
    const fetcher: typeof globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(document);
    };
    const { catalog } = await createCatalog(fetcher, () => now);
    await catalog.initialize();
    await catalog.refresh();
    now += 59_999;
    await catalog.refresh();
    expect(calls).toHaveLength(0);
    now++;
    await catalog.refresh();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(PRICE_URL);
    expect(calls[0]!.options).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    expect(calls[0]!.options?.headers).toEqual({ Accept: "application/json" });
    expect(catalog.getState().prices).toMatchObject({
      status: "fresh",
      version: String(document.version),
      updatedAt: document.updated,
      fetchedAt: now,
      source: PRICE_URL,
    });
    for (let tick = 0; tick < 10; tick++) {
      now += 1000;
      await catalog.refresh();
    }
    expect(calls).toHaveLength(1);
    now = NOW + 60_000 + DAY_MS - 1;
    await catalog.refresh();
    expect(calls).toHaveLength(1);
    now++;
    await catalog.refresh();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url === PRICE_URL)).toBe(true);
  });

  it("tries only the fixed mirror, adopts newer quotes, and preserves them across rejected updates and restart", async () => {
    const accepted = quoteTable();
    let mode: "mirror" | "downgrade" | "mismatch" | "rewrite" = "mirror";
    const calls: string[] = [];
    const fetcher: typeof globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (mode === "mirror" && String(url) === PRICE_URL) return jsonResponse({ schema: 1 });
      const document = structuredClone(accepted);
      if (mode !== "mirror")
        document.models.find((model) => model.id === "gpt-5")!.prices!.input = 4;
      if (mode === "downgrade") document.version--;
      if (mode === "mismatch") {
        document.version++;
        document.tests[0]!.expect = "unknown";
      }
      return jsonResponse(document);
    };
    const { catalog, cacheDir } = await createCatalog(fetcher);
    await catalog.refresh({ force: true });
    expect(calls).toEqual([PRICE_URL, MIRROR_URL]);
    expect(catalog.getState().prices).toMatchObject({
      version: String(accepted.version),
      source: MIRROR_URL,
    });
    expect(catalog.estimateCost(QUOTE)).toBe(14.125); // 2 + .125 + 2 + 10
    mode = "downgrade";
    await catalog.refresh({ force: true });
    expect(catalog.getState().prices).toMatchObject({
      version: String(accepted.version),
      status: "error",
      source: MIRROR_URL,
    });
    expect(catalog.estimateCost(QUOTE)).toBe(14.125);
    mode = "mismatch";
    await catalog.refresh({ force: true });
    expect(catalog.estimateCost(QUOTE)).toBe(14.125);
    expect(catalog.getState().prices.version).toBe(String(accepted.version));
    mode = "rewrite";
    await catalog.refresh({ force: true });
    expect(catalog.estimateCost(QUOTE)).toBe(14.125);
    catalog.dispose();
    const { catalog: restarted } = await createCatalog(fetcher, () => NOW, cacheDir);
    await restarted.initialize();
    expect(restarted.getState().prices.version).toBe(String(accepted.version));
    expect(restarted.estimateCost(QUOTE)).toBe(14.125);
  });

  it("backs off failures for an hour, then daily after the second failed price round", async () => {
    let now = NOW;
    const fetcher = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("remote error containing untrusted text"));
    const { catalog } = await createCatalog(fetcher, () => now);
    await catalog.refresh({ force: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 3_599_999;
    await catalog.refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    now++;
    await catalog.refresh();
    expect(fetcher).toHaveBeenCalledTimes(4);
    now += 3_600_000;
    await catalog.refresh();
    expect(fetcher).toHaveBeenCalledTimes(4);
    now += DAY_MS - 3_600_000;
    await catalog.refresh();
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(catalog.getState())).not.toContain("untrusted");
    expect(catalog.estimateCost(QUOTE)).toBe(12.625);
  });

  it("singleflights concurrent refreshes and rejects a transport's late response after network disable", async () => {
    let deliver: (response: Response) => void = () => {
      throw new Error("transport not started");
    };
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const calls: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    const fetcher: typeof globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), signal: options?.signal });
      markStarted();
      return new Promise<Response>((resolve) => {
        deliver = resolve;
      }); // deliberately ignores abort
    };
    const { catalog } = await createCatalog(fetcher);
    await catalog.initialize();
    const beforePrices = catalog.getState().prices;
    const beforeQuote = catalog.estimateCost(QUOTE);
    const document = newTable();
    document.models.find((model) => model.id === "gpt-5")!.prices!.input = 4;
    const first = catalog.refresh({ force: true });
    const second = catalog.refresh({ force: true });
    await started;
    expect(calls).toHaveLength(1);
    await catalog.configure({ networkEnabled: false });
    expect(calls[0]!.signal?.aborted).toBe(true);
    deliver(jsonResponse(document));
    await Promise.all([first, second]);
    await catalog.refresh({ force: true });
    expect(calls).toHaveLength(1);
    expect(catalog.getState().prices).toMatchObject({
      version: beforePrices.version,
      updatedAt: beforePrices.updatedAt,
      fetchedAt: beforePrices.fetchedAt,
      source: beforePrices.source,
    });
    expect(catalog.estimateCost(QUOTE)).toBe(beforeQuote);
  });

  it("preserves corrupt caches and unrelated data, then atomically persists a valid replacement", async () => {
    const document = quoteTable();
    const fetcher: typeof globalThis.fetch = async () => jsonResponse(document);
    const { catalog, cacheDir } = await createCatalog(fetcher);
    await writeFile(path.join(cacheDir, "prices.json"), "{corrupt user-visible evidence");
    await writeFile(path.join(cacheDir, "unrelated.txt"), "do not delete");
    await catalog.initialize();
    expect(await readFile(path.join(cacheDir, "prices.json"), "utf8")).toBe(
      "{corrupt user-visible evidence",
    );
    await catalog.refresh({ force: true });
    expect(catalog.estimateCost(QUOTE)).toBe(14.125);
    const names = await readdir(cacheDir);
    const preserved = names.find((name) => name.startsWith("prices.json.invalid-"));
    expect(preserved).toBeTruthy();
    expect(await readFile(path.join(cacheDir, preserved!), "utf8")).toBe(
      "{corrupt user-visible evidence",
    );
    expect(await readFile(path.join(cacheDir, "unrelated.txt"), "utf8")).toBe("do not delete");
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    const stored: unknown = JSON.parse(await readFile(path.join(cacheDir, "prices.json"), "utf8"));
    if (!isObject(stored)) throw new Error("invalid stored table envelope");
    expect(validatePriceTable(stored.table, NOW).document).toEqual(document);
  });
});

describe("hard body and timeout policy", () => {
  it("enforces the streaming 1-MiB limit despite a lying content-length and cancels the stream", async () => {
    let pulls = 0;
    let cancellations = 0;
    const fetcher: typeof globalThis.fetch = async (url) => {
      if (String(url) === MIRROR_URL) return jsonResponse({}, 503);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(64 << 10).fill(32));
        },
        cancel() {
          cancellations++;
        },
      });
      return new Response(body, { headers: { "content-length": "1" } });
    };
    const { catalog } = await createCatalog(fetcher);
    const beforePrices = catalog.getState().prices;
    const beforeQuote = catalog.estimateCost(QUOTE);
    await catalog.refresh({ force: true });
    expect(pulls).toBeLessThanOrEqual(PRICE_MAX_BYTES / (64 << 10) + 2);
    expect(cancellations).toBe(1);
    expect(catalog.getState().prices).toMatchObject({
      status: "error",
      version: beforePrices.version,
      fetchedAt: beforePrices.fetchedAt,
      source: beforePrices.source,
    });
    expect(catalog.estimateCost(QUOTE)).toBe(beforeQuote);
  });

  it("rejects advertised oversize, redirects, and invalid UTF-8 without replacing last-good data", async () => {
    const document = quoteTable();
    let mode: "good" | "size" | "redirect" | "utf8" = "good";
    const fetcher: typeof globalThis.fetch = async () => {
      if (mode === "good") return jsonResponse(document);
      if (mode === "size")
        return new Response("{}", { headers: { "content-length": String(PRICE_MAX_BYTES + 1) } });
      if (mode === "redirect")
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/secret" },
        });
      return new Response(new Uint8Array([0xff, 0xfe, 0xfd]));
    };
    const { catalog } = await createCatalog(fetcher);
    await catalog.refresh({ force: true });
    const beforePrices = catalog.getState().prices;
    expect(catalog.estimateCost(QUOTE)).toBe(14.125);
    for (const next of ["size", "redirect", "utf8"] as const) {
      mode = next;
      await catalog.refresh({ force: true });
      expect(catalog.getState().prices).toMatchObject({
        status: "error",
        version: beforePrices.version,
        updatedAt: beforePrices.updatedAt,
        fetchedAt: beforePrices.fetchedAt,
        source: beforePrices.source,
      });
      expect(catalog.estimateCost(QUOTE)).toBe(14.125);
    }
  });

  it("aborts after 15 seconds even when a transport ignores its signal", async () => {
    let startedResolve: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const signals: AbortSignal[] = [];
    const fetcher: typeof globalThis.fetch = async (_url, options) => {
      signals.push(options!.signal!);
      startedResolve();
      return new Promise<Response>(() => undefined);
    };
    const { catalog } = await createCatalog(fetcher);
    await catalog.initialize();
    vi.useFakeTimers();
    const refresh = catalog.refresh({ force: true });
    await started;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signals[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await refresh;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(catalog.getState().prices.status).toBe("error");
  });
});

describe("FX source validation and truthful provenance", () => {
  it("parses all documented USD-list shapes, filtering crypto while rejecting bad supported rates", () => {
    const raw = { date: "2026-10-24", usd: { cny: 6.7, usd: 1, btc: "ignored" } };
    expect(parseRates(raw, FX_PROVIDERS[1], currencies, NOW).rates).toEqual({ CNY: 6.7, USD: 1 });
    expect(
      parseRates(
        {
          result: "success",
          base_code: "USD",
          time_last_update_unix: NOW / 1000,
          rates: { CNY: 6.7 },
        },
        FX_PROVIDERS[0],
        currencies,
        NOW,
      ).rates.USD,
    ).toBe(1);
    expect(
      parseRates(
        { base: "USD", date: "2026-10-24", rates: { CNY: 6.7 } },
        FX_PROVIDERS[3],
        currencies,
        NOW,
      ).rates.CNY,
    ).toBe(6.7);
    for (const usd of [
      { cny: 0 },
      { cny: Infinity },
      { cny: "6.7" },
      { cny: 6.7, CNY: 6.8 },
      { usd: 2, cny: 6.7 },
    ])
      expect(() => parseRates({ ...raw, usd }, FX_PROVIDERS[1], currencies, NOW)).toThrow();
    expect(() =>
      parseRates({ ...raw, date: "2026-11-01" }, FX_PROVIDERS[1], currencies, NOW),
    ).toThrow();
    const reference = bundledRateEntries(currencies).CNY!;
    const parsed = parseRates(raw, FX_PROVIDERS[1], currencies, NOW);
    expect(() =>
      checkRateCandidate(
        { ...parsed, date: reference.date - 1 },
        "CNY",
        reference,
        NOW,
        reference.date,
      ),
    ).toThrow("rollback");
    expect(() =>
      checkRateCandidate(
        { ...parsed, rates: { CNY: 100, USD: 1 } },
        "CNY",
        reference,
        NOW,
        reference.date,
      ),
    ).toThrow("sanity");
  });

  it("fetches FX immediately on a new non-USD selection and follows the fixed fallback order", async () => {
    const calls: string[] = [];
    const fetcher: typeof globalThis.fetch = async (url) => {
      calls.push(String(url));
      return String(url) === FX_PROVIDERS[0].url
        ? jsonResponse({ result: "error" })
        : fxResponse(String(url));
    };
    const { catalog } = await createCatalog(fetcher);
    await catalog.configure({ currency: "CNY" });
    await catalog.refresh();
    expect(calls).toEqual([FX_PROVIDERS[0].url, FX_PROVIDERS[1].url]);
    expect(catalog.getState()).toMatchObject({
      currency: "CNY",
      exchangeRate: 6.7,
      attribution: null,
      rates: {
        status: "fresh",
        source: FX_PROVIDERS[1].url,
        updatedAt: "2026-10-24T00:00:00.000Z",
      },
    });
    await catalog.refresh();
    expect(calls).toHaveLength(2);
    await catalog.configure({ currency: "USD" });
    await catalog.refresh({ force: true });
    expect(calls.slice(2)).toEqual([PRICE_URL, MIRROR_URL]);
    expect(catalog.getState().exchangeRate).toBe(1);
  });

  it("waits 30 seconds for a persisted non-USD selection and then refreshes FX only daily", async () => {
    let now = NOW;
    const calls: string[] = [];
    const fetcher: typeof globalThis.fetch = async (url) => {
      const resource = String(url);
      calls.push(resource);
      return resource === PRICE_URL ? jsonResponse(newTable()) : fxResponse(resource);
    };
    const { catalog, cacheDir } = await createCatalog(fetcher, () => now);
    await writeFile(
      path.join(cacheDir, "pricing-settings.json"),
      JSON.stringify({ schema: 1, networkEnabled: true, currency: "CNY" }),
    );
    await catalog.initialize();
    now += 29_999;
    await catalog.refresh();
    expect(calls).toHaveLength(0);
    now++;
    await catalog.refresh();
    expect(calls).toEqual([FX_PROVIDERS[0].url]);
    now += 30_000;
    await catalog.refresh();
    expect(calls).toEqual([FX_PROVIDERS[0].url, PRICE_URL]);
    now = NOW + 30_000 + DAY_MS;
    await catalog.refresh();
    expect(calls.filter((url) => url === FX_PROVIDERS[0].url)).toHaveLength(2);
  });

  it("retains last-good rates and ExchangeRate-API attribution offline, after failures, and across restart", async () => {
    let failing = false;
    let now = NOW;
    const calls: string[] = [];
    const fetcher: typeof globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (failing) throw new Error("network unavailable");
      return String(url) === PRICE_URL
        ? jsonResponse(newTable())
        : fxResponse(String(url), { CNY: 6.8 });
    };
    const { catalog, cacheDir } = await createCatalog(fetcher, () => now);
    await catalog.configure({ currency: "CNY" });
    await catalog.refresh();
    const good = catalog.getState();
    expect(good.exchangeRate).toBe(6.8);
    expect(good.attribution).toEqual({
      label: "ExchangeRate-API",
      url: "https://www.exchangerate-api.com",
    });
    failing = true;
    now += DAY_MS;
    await catalog.refresh({ force: true });
    expect(catalog.getState()).toMatchObject({
      exchangeRate: 6.8,
      rates: {
        status: "error",
        source: good.rates.source,
        updatedAt: good.rates.updatedAt,
        fetchedAt: good.rates.fetchedAt,
      },
      attribution: good.attribution,
    });
    const attempts = calls.length;
    now += 3_599_999;
    await catalog.refresh();
    expect(calls).toHaveLength(attempts);
    await catalog.configure({ networkEnabled: false });
    catalog.dispose();
    const { catalog: restarted } = await createCatalog(fetcher, () => now, cacheDir);
    await restarted.refresh({ force: true });
    expect(restarted.getState()).toMatchObject({
      networkEnabled: false,
      currency: "CNY",
      exchangeRate: 6.8,
      attribution: good.attribution,
    });
    expect(calls).toHaveLength(attempts);
  });

  it("preserves missing Frankfurter currencies with their original dates and source", () => {
    const previous = bundledRateEntries(currencies);
    previous.CNY = {
      rate: 6.8,
      date: Date.parse("2026-10-23T00:00:00Z"),
      fetchedAt: NOW - DAY_MS,
      source: FX_PROVIDERS[0].url,
    };
    const partial = parseRates(
      { base: "USD", date: "2026-10-24", rates: { EUR: 0.9 } },
      FX_PROVIDERS[3],
      currencies,
      NOW,
    );
    expect(() => checkRateCandidate(partial, "CNY", previous.CNY, NOW, previous.CNY.date)).toThrow(
      "missing",
    );
    const merged = mergeRates(previous, partial, NOW);
    expect(merged.CNY).toBe(previous.CNY);
    expect(merged.EUR).toMatchObject({
      rate: 0.9,
      date: Date.parse("2026-10-24T00:00:00Z"),
      source: FX_PROVIDERS[3].url,
    });
  });

  it("requires agreement from two independent providers when the reference is older than 30 days", async () => {
    const now = Date.parse("2026-12-24T12:00:00Z");
    const calls: string[] = [];
    const fetcher: typeof globalThis.fetch = async (url) => {
      calls.push(String(url));
      return fxResponse(
        String(url),
        { CNY: String(url) === FX_PROVIDERS[0].url ? 6.7 : 6.8 },
        "2026-12-24",
      );
    };
    const { catalog } = await createCatalog(fetcher, () => now);
    await catalog.configure({ currency: "CNY" });
    await catalog.refresh();
    expect(calls).toEqual([FX_PROVIDERS[0].url, FX_PROVIDERS[1].url]);
    expect(catalog.getState()).toMatchObject({
      exchangeRate: 6.7,
      attribution: { label: "ExchangeRate-API" },
    });
    const reference = bundledRateEntries(currencies).CNY!;
    const first = parseRates(
      { date: "2026-12-24", usd: { cny: 6.7 } },
      FX_PROVIDERS[1],
      currencies,
      now,
    );
    const mirror = parseRates(
      { date: "2026-12-24", usd: { cny: 6.7 } },
      FX_PROVIDERS[2],
      currencies,
      now,
    );
    expect(checkRateCandidate(first, "CNY", reference, now, reference.date, mirror)).toBe(
      "needs-confirmation",
    );
  });

  it("keeps stale bundled values when providers disagree, without falsely refreshing their dates", async () => {
    const now = Date.parse("2026-12-24T12:00:00Z");
    const calls: string[] = [];
    const fetcher: typeof globalThis.fetch = async (url) => {
      const resource = String(url);
      calls.push(resource);
      let cny = 12.3;
      if (resource === FX_PROVIDERS[0].url) cny = 6.7;
      else if (resource === FX_PROVIDERS[1].url) cny = 8.8;
      return fxResponse(resource, { CNY: cny }, "2026-12-24");
    };
    const { catalog } = await createCatalog(fetcher, () => now);
    await catalog.configure({ currency: "CNY" });
    await catalog.refresh();
    expect(calls).toEqual([FX_PROVIDERS[0].url, FX_PROVIDERS[1].url, FX_PROVIDERS[3].url]);
    expect(catalog.getState()).toMatchObject({
      exchangeRate: 6.67476,
      rates: { status: "stale", updatedAt: "2026-10-22T00:00:00.000Z", fetchedAt: null },
      attribution: null,
    });
  });

  it("applies the separate 256-KiB streaming FX limit", async () => {
    let cancelled = false;
    const calls: string[] = [];
    const fetcher: typeof globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url) !== FX_PROVIDERS[0].url) return jsonResponse({}, 503);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(FX_MAX_BYTES + 1));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(stream);
    };
    const { catalog } = await createCatalog(fetcher);
    await catalog.configure({ currency: "CNY" });
    await catalog.refresh();
    expect(cancelled).toBe(true);
    expect(calls).toEqual(FX_PROVIDERS.map((provider) => provider.url));
    expect(catalog.getState().exchangeRate).toBe(6.67476);
  });

  it("cancels an old currency's flight and immediately fetches the new non-USD selection", async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let first = true;
    const signals: AbortSignal[] = [];
    const fetcher: typeof globalThis.fetch = async (url, options) => {
      signals.push(options!.signal!);
      if (first) {
        first = false;
        markStarted();
        return new Promise<Response>(() => undefined);
      }
      return fxResponse(String(url), { JPY: 158 });
    };
    const { catalog } = await createCatalog(fetcher);
    const cny = catalog.configure({ currency: "CNY" });
    await started;
    await catalog.configure({ currency: "JPY" });
    await cny;
    await catalog.refresh();
    expect(signals[0]!.aborted).toBe(true);
    expect(signals).toHaveLength(2);
    expect(catalog.getState()).toMatchObject({ currency: "JPY", exchangeRate: 158 });
  });

  it("applies serialized opt-out without waiting for an unresponsive currency request", async () => {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const requests: Array<{ signal: AbortSignal; url: string }> = [];
    const fetcher: typeof globalThis.fetch = async (url, options) => {
      requests.push({ signal: options!.signal!, url: String(url) });
      started.resolve();
      return pending.promise; // Deliberately ignores cancellation to exercise the service guard.
    };
    const { catalog } = await createCatalog(fetcher);
    let commands = Promise.resolve();
    commands = commands.then(() => catalog.configure({ currency: "CNY" }));
    await started.promise;
    commands = commands.then(() => catalog.configure({ networkEnabled: false }));
    await commands;
    expect(catalog.getState()).toMatchObject({
      currency: "CNY",
      networkEnabled: false,
      exchangeRate: 6.67476,
    });
    expect(requests[0]!.signal.aborted).toBe(true);
    pending.resolve(fxResponse(requests[0]!.url, { CNY: 6.8 }));
    await catalog.refresh({ force: true });
    expect(requests).toHaveLength(1);
    expect(catalog.getState()).toMatchObject({ exchangeRate: 6.67476, rates: { fetchedAt: null } });
  });
});
