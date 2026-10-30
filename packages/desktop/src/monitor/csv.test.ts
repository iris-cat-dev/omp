import { describe, expect, it } from "vitest";
import { buildMonitorCsv } from "./csv.js";
import type { OmpMonitorSnapshot } from "./types.js";

function snapshot(): OmpMonitorSnapshot {
  const usage = {
    requests: 1,
    failedRequests: 0,
    inputTokens: 20,
    outputTokens: 10,
    reasoningTokens: 0,
    reasoningKnownRequests: 0,
    reasoningKnownOutputTokens: 0,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    totalTokens: 999,
    costUsd: 0.5,
    unpricedRequests: 0,
    estimatedCostUsd: 1.5,
    unestimatedRequests: 0,
    measuredOutputTokens: 10,
    measuredDurationMs: 500,
    peakOutputTps: 20,
  };
  const feed = {
    status: "fresh" as const,
    version: "7",
    updatedAt: "2026-10-24",
    fetchedAt: 1_792_800_000_000,
    lastAttemptAt: 1_792_800_000_000,
    source: "public.example",
  };
  return {
    updatedAt: 1_792_800_000_000,
    scope: { profile: "work", project: "=SUM(1,2)" },
    scopes: { profiles: ["work"], projects: ["=SUM(1,2)"] },
    resources: {
      status: "unavailable",
      sampledAt: 1_792_800_000_000,
      processCount: 0,
      cpuPercent: null,
      workingSetBytes: null,
      privateBytes: null,
      reason: "no_processes",
    },
    pricing: {
      networkEnabled: true,
      currency: "CNY",
      currencies: ["USD", "CNY"],
      exchangeRate: 7,
      prices: feed,
      rates: { ...feed, source: "rates.example" },
      attribution: null,
    },
    status: "ready",
    rate: {
      measuredTps: 20,
      estimatedTps: 5,
      estimatedShare: 0.2,
      measuredThinkingTps: null,
      estimatedThinkingTps: null,
    },
    activity: { lastResponseAt: null, peakAt: null, peakObservedAt: null },
    today: usage,
    days: [{ ...usage, date: "2026-10-24" }],
    tasks: { current: {}, records: [], scanning: false, limited: false },
    agents: [
      {
        id: "safe-id",
        parentId: null,
        name: '\t=HYPERLINK("https://invalid")',
        project: "=SUM(1,2)",
        profile: "work",
        kind: "main",
        model: "gpt-x",
        phase: "idle",
        lastActivityAt: 1_792_800_000_000,
        outputTps: 20,
        liveMeasuredTps: 20,
        liveEstimatedTps: 5,
        thinkingTps: null,
        liveCostUsdPerSecond: null,
        speedMode: null,
        ttftMs: null,
      },
    ],
    series: [],
    coverage: {
      roots: [{ label: "work", available: true }],
      discoveredFiles: 2,
      readFiles: 2,
      skippedFiles: 0,
      malformedLines: 0,
      limited: false,
      issues: [],
    },
  };
}

function parseCsv(csv: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        value += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if (char === "\r" && !quoted && csv[index + 1] === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      index++;
    } else value += char;
  }
  const headers = rows.shift()!;
  return rows.map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index]])),
  );
}

describe("monitor CSV", () => {
  it("exports native totals, both cost sources and currency provenance while neutralizing spreadsheet metadata", () => {
    const rows = parseCsv(buildMonitorCsv(snapshot()));
    const today = rows.find((row) => row.section === "today")!;
    expect(today).toMatchObject({
      profile: "work",
      project: "'=SUM(1,2)",
      total_tokens: "999",
      input_tokens_non_cached: "20",
      cache_read_tokens: "30",
      recorded_cost_usd: "0.5",
      current_catalog_estimate_usd: "1.5",
      display_currency: "CNY",
      usd_exchange_rate: "7",
      recorded_cost_display: "3.5",
      catalog_estimate_display: "10.5",
      price_version: "7",
      rate_source: "rates.example",
      request_average_output_tps: "20",
    });
    expect(rows.find((row) => row.section === "agent")).toMatchObject({
      label: '\'\t=HYPERLINK("https://invalid")',
      project: "'=SUM(1,2)",
      ttft_ms: "",
    });
    expect(rows.find((row) => row.section === "resources")).toMatchObject({
      cpu_percent_total_capacity: "",
      working_set_bytes: "",
      project: "all identifiable native OMP processes",
    });
  });

  it("distinguishes entirely unknown cost from a logged zero and preserves partial coverage", () => {
    const data = snapshot();
    data.status = "partial";
    data.coverage.limited = true;
    data.coverage.skippedFiles = 1;
    data.today.unpricedRequests = 1;
    data.today.unestimatedRequests = 1;
    data.pricing.exchangeRate = null;
    const unknown = parseCsv(buildMonitorCsv(data)).find((row) => row.section === "today")!;
    expect(unknown).toMatchObject({
      recorded_cost_usd: "",
      current_catalog_estimate_usd: "",
      recorded_cost_display: "",
      catalog_estimate_display: "",
      usd_exchange_rate: "",
      coverage_status: "partial",
      coverage_limited: "true",
      skipped_files: "1",
    });
    data.today.unpricedRequests = 0;
    data.today.costUsd = 0;
    expect(
      parseCsv(buildMonitorCsv(data)).find((row) => row.section === "today")?.recorded_cost_usd,
    ).toBe("0");
  });

  it("exports only the selected inclusive history dates without today's live or machine-wide rows", () => {
    const data = snapshot();
    const usage = data.today;
    data.days = [
      { ...usage, date: "2026-10-22", requests: 2, outputTokens: 22 },
      { ...usage, date: "2026-10-23", requests: 3, outputTokens: 33 },
      { ...usage, date: "2026-10-24", requests: 4, outputTokens: 44 },
    ];
    const rows = parseCsv(
      buildMonitorCsv(data, { startDate: "2026-10-23", endDate: "2026-10-24" }),
    );
    expect(rows.map((row) => [row.section, row.date, row.requests, row.output_tokens])).toEqual([
      ["daily", "2026-10-23", "3", "33"],
      ["daily", "2026-10-24", "4", "44"],
    ]);
    expect(rows[0]).toMatchObject({
      range_start: "2026-10-23",
      range_end: "2026-10-24",
      recorded_cost_usd: "0.5",
      current_catalog_estimate_usd: "1.5",
      rate_source: "rates.example",
    });
  });
});
