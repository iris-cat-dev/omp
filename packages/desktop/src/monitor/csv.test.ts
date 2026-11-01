import { describe, expect, it } from "vitest";
import { buildMonitorCsv, buildMonitorModeCsv } from "./csv.js";
import type { OmpMonitorModeBreakdown, OmpMonitorSnapshot } from "./types.js";

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
    peakTotalTps: 200,
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
      autoSyncPrices: true,
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
      measuredTotalTps: 200,
      estimatedTotalTps: 50,
      estimatedShare: 0.2,
      measuredThinkingTps: null,
      estimatedThinkingTps: null,
    },
    activity: {
      lastResponseAt: null,
      peakAt: null,
      peakObservedAt: null,
      totalPeakAt: null,
      totalPeakObservedAt: null,
    },
    today: usage,
    days: [{ ...usage, date: "2026-10-24", agentCount: 1 }],
    breakdowns: { models: [], modes: [] },
    historyRange: {
      startDate: "2026-10-24",
      endDate: "2026-10-24",
      limited: false,
      scanning: false,
    },
    performance: { current: {}, records: [], baselines: [], scanning: false, limited: false },
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
        totalTps: 200,
        liveMeasuredTps: 20,
        liveEstimatedTps: 5,
        liveMeasuredTotalTps: 200,
        liveEstimatedTotalTps: 50,
        thinkingTps: null,
        liveCostUsdPerSecond: null,
        speedMode: null,
        effortMode: null,
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

function modeRow(patch: Partial<OmpMonitorModeBreakdown> = {}): OmpMonitorModeBreakdown {
  return {
    date: "2026-10-23",
    source: "omp",
    model: "model-a",
    kind: "effort",
    value: "high",
    evidence: "selected",
    provider: null,
    requests: 1,
    outputTokens: 100,
    measuredOutputTokens: 100,
    measuredDurationMs: 1_000,
    ...patch,
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
      { ...usage, date: "2026-10-22", requests: 2, outputTokens: 22, agentCount: 1 },
      { ...usage, date: "2026-10-23", requests: 3, outputTokens: 33, agentCount: 1 },
      { ...usage, date: "2026-10-24", requests: 4, outputTokens: 44, agentCount: 1 },
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

  it("exports real sparse older dates and leaves a legitimate empty interior range empty", () => {
    const data = snapshot();
    data.historyRange.startDate = "2024-01-02";
    data.days.unshift({
      ...data.today,
      date: "2024-01-02",
      agentCount: 1,
      requests: 2,
      outputTokens: 22,
    });
    data.breakdowns.modes = [modeRow({ date: "2024-01-02", value: null, evidence: null })];
    const old = { startDate: "2024-01-02", endDate: "2024-12-31" };
    expect(parseCsv(buildMonitorCsv(data, old))).toEqual([
      expect.objectContaining({ date: "2024-01-02", requests: "2", output_tokens: "22" }),
    ]);
    expect(parseCsv(buildMonitorModeCsv(data, { ...old, kind: "effort" }))).toEqual([
      expect.objectContaining({ date: "2024-01-02", mode: "unknown", evidence: "unknown" }),
    ]);
    const empty = { startDate: "2025-02-01", endDate: "2025-03-01" };
    expect(parseCsv(buildMonitorCsv(data, empty))).toEqual([]);
    expect(parseCsv(buildMonitorModeCsv(data, { ...empty, kind: "effort" }))).toEqual([]);
  });
});

describe("native monitor mode CSV", () => {
  it("combines only identical native detail rows inside the selected inclusive range and pools measured speed", () => {
    const data = snapshot();
    data.breakdowns.modes = [
      modeRow({ date: "2026-10-22", requests: 99, outputTokens: 9_900 }),
      modeRow({
        date: "2026-10-24",
        model: "model-b",
        value: null,
        evidence: null,
        outputTokens: 30,
        measuredOutputTokens: 0,
        measuredDurationMs: 0,
      }),
      modeRow({ outputTokens: 600, measuredOutputTokens: 600, measuredDurationMs: 3_000 }),
      modeRow({
        evidence: "recorded",
        outputTokens: 50,
        measuredOutputTokens: 50,
        measuredDurationMs: 500,
      }),
      modeRow({
        date: "2026-10-24",
        value: "low",
        outputTokens: 200,
        measuredOutputTokens: 200,
        measuredDurationMs: 2_000,
      }),
      modeRow(),
      modeRow({ date: "2026-10-25", requests: 88, outputTokens: 8_800 }),
      modeRow({
        date: "2026-10-24",
        kind: "speed",
        value: "fast",
        provider: "openai",
        outputTokens: 900,
        measuredOutputTokens: 900,
      }),
    ];
    const before = JSON.stringify(data.breakdowns);
    const csv = buildMonitorModeCsv(data, {
      startDate: "2026-10-23",
      endDate: "2026-10-24",
      kind: "effort",
    });
    const rows = parseCsv(csv);
    expect(csv.split("\r\n")[0]).toBe(
      "date,source,model,kind,mode,evidence,provider,requests,output_tokens,measured_output_tokens,measured_ms,avg_speed_tok_s",
    );
    expect(
      rows.map((row) => [
        row.date,
        row.model,
        row.mode,
        row.evidence,
        row.requests,
        row.output_tokens,
        row.measured_output_tokens,
        row.measured_ms,
        row.avg_speed_tok_s,
      ]),
    ).toEqual([
      ["2026-10-23", "model-a", "high", "recorded", "1", "50", "50", "500", "100.0"],
      ["2026-10-23", "model-a", "high", "selected", "2", "700", "700", "4000", "175.0"],
      ["2026-10-24", "model-a", "low", "selected", "1", "200", "200", "2000", "100.0"],
      ["2026-10-24", "model-b", "unknown", "unknown", "1", "30", "0", "0", ""],
    ]);
    expect(rows.every((row) => row.source === "omp" && row.kind === "effort")).toBe(true);
    expect(rows.reduce((sum, row) => sum + Number(row.requests), 0)).toBe(5);
    expect(rows.reduce((sum, row) => sum + Number(row.output_tokens), 0)).toBe(980);
    expect(rows.reduce((sum, row) => sum + Number(row.measured_output_tokens), 0)).toBe(950);
    expect(rows.reduce((sum, row) => sum + Number(row.measured_ms), 0)).toBe(6_500);
    expect(JSON.stringify(data.breakdowns)).toBe(before);
    expect(csv).not.toMatch(/HYPERLINK|resources|price_version|9999|standard/i);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("keeps selected, recorded, provider and date detail distinct while conserving known and unknown speed", () => {
    const data = snapshot();
    const fast = { kind: "speed", value: "fast", provider: "openai" } as const;
    data.breakdowns.modes = [
      modeRow(fast),
      modeRow({ ...fast, evidence: "recorded" }),
      modeRow({ ...fast, provider: "google" }),
      modeRow({ ...fast, date: "2026-10-24" }),
      modeRow({
        kind: "speed",
        model: null,
        value: null,
        evidence: null,
        outputTokens: 10,
        measuredOutputTokens: 0,
        measuredDurationMs: 0,
      }),
      modeRow({ value: "max", outputTokens: 900 }),
    ];
    const rows = parseCsv(
      buildMonitorModeCsv(data, {
        startDate: "2026-10-23",
        endDate: "2026-10-24",
        kind: "speed",
      }),
    );
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.mode === "fast")).toHaveLength(4);
    expect(rows.filter((row) => row.mode === "unknown")).toEqual([
      expect.objectContaining({
        model: "",
        evidence: "unknown",
        provider: "",
        output_tokens: "10",
        avg_speed_tok_s: "",
      }),
    ]);
    expect(rows.reduce((sum, row) => sum + Number(row.requests), 0)).toBe(5);
    expect(rows.reduce((sum, row) => sum + Number(row.output_tokens), 0)).toBe(410);
    expect(rows.filter((row) => row.provider === "google")).toHaveLength(1);
    expect(rows.filter((row) => row.evidence === "recorded")).toHaveLength(1);
    expect(rows.some((row) => row.mode === "standard")).toBe(false);
  });

  it.each([
    ['=HYPERLINK("https://invalid")', '\'=HYPERLINK("https://invalid")'],
    [" \t+SUM(1,2)", "' \t+SUM(1,2)"],
    ["\tmodel", "'\tmodel"],
    ['model,\r\n"quoted"', 'model,\r\n"quoted"'],
  ])("round-trips native model metadata safely: %s", (model, expected) => {
    const data = snapshot();
    data.breakdowns.modes = [
      modeRow({
        model,
        value: "future-effort",
        measuredOutputTokens: 1,
        measuredDurationMs: 3_000,
      }),
    ];
    const rows = parseCsv(
      buildMonitorModeCsv(data, {
        startDate: "2026-10-23",
        endDate: "2026-10-23",
        kind: "effort",
      }),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        model: expected,
        mode: "future-effort",
        avg_speed_tok_s: "0.3",
      }),
    ]);
  });

  it("preserves real zero measured speed and emits only the native header for an empty selection", () => {
    const data = snapshot();
    data.breakdowns.modes = [modeRow({ measuredOutputTokens: 0 })];
    expect(
      parseCsv(
        buildMonitorModeCsv(data, {
          startDate: "2026-10-23",
          endDate: "2026-10-23",
          kind: "effort",
        }),
      )[0]!.avg_speed_tok_s,
    ).toBe("0.0");
    const csv = buildMonitorModeCsv(data, {
      startDate: "2026-10-24",
      endDate: "2026-10-24",
      kind: "effort",
    });
    expect(parseCsv(csv)).toEqual([]);
    expect(csv.split("\r\n")).toHaveLength(2);
  });
});
