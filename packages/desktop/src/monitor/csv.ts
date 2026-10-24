import type { OmpMonitorSnapshot, OmpMonitorUsage } from "./types.js";
import type { OmpMonitorExportRange } from "./view-types.js";

type CsvValue = string | number | boolean | null | undefined;
const COLUMNS = [
  "section",
  "label",
  "profile",
  "project",
  "date",
  "kind",
  "model",
  "phase",
  "requests",
  "failed_requests",
  "input_tokens_non_cached",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "recorded_cost_usd",
  "recorded_unpriced_requests",
  "current_catalog_estimate_usd",
  "catalog_unpriced_requests",
  "display_currency",
  "usd_exchange_rate",
  "recorded_cost_display",
  "catalog_estimate_display",
  "request_average_output_tps",
  "peak_measured_aggregate_output_tps",
  "measured_output_tps",
  "estimated_output_tps",
  "ttft_ms",
  "sampled_at",
  "native_process_count",
  "cpu_percent_total_capacity",
  "working_set_bytes",
  "private_bytes",
  "coverage_status",
  "coverage_limited",
  "discovered_files",
  "read_files",
  "skipped_files",
  "malformed_lines",
  "price_version",
  "price_date",
  "price_source",
  "rate_date",
  "rate_source",
  "range_start",
  "range_end",
  "notes",
] as const;

type CsvColumn = (typeof COLUMNS)[number];
type CsvRow = Partial<Record<CsvColumn, CsvValue>>;

function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = String(value);
  // Metadata may be user-controlled. Quoting alone does not stop spreadsheet formulas.
  let first = 0;
  while (first < text.length && (text.charCodeAt(first) < 32 || /\s/u.test(text[first]!))) first++;
  const prefix = text.charCodeAt(0);
  if (/[=+\-@]/u.test(text[first] ?? "") || prefix === 9 || prefix === 10 || prefix === 13)
    text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Export numeric current-log facts with scope and pricing provenance, never raw transcripts. */
export function buildMonitorCsv(
  snapshot: OmpMonitorSnapshot,
  range?: OmpMonitorExportRange,
): string {
  const { pricing, coverage, scope } = snapshot;
  const rate = pricing.exchangeRate;
  const common: CsvRow = {
    profile: scope.profile ?? "all",
    project: scope.project ?? "all",
    display_currency: pricing.currency,
    usd_exchange_rate: rate,
    sampled_at: new Date(snapshot.updatedAt).toISOString(),
    coverage_status: snapshot.status,
    coverage_limited: coverage.limited,
    discovered_files: coverage.discoveredFiles,
    read_files: coverage.readFiles,
    skipped_files: coverage.skippedFiles,
    malformed_lines: coverage.malformedLines,
    price_version: pricing.prices.version,
    price_date: pricing.prices.updatedAt,
    price_source: pricing.prices.source,
    rate_date: pricing.rates.updatedAt,
    rate_source: pricing.rates.source,
    range_start: range?.startDate,
    range_end: range?.endDate,
  };
  const usageRow = (usage: OmpMonitorUsage): CsvRow => ({
    requests: usage.requests,
    failed_requests: usage.failedRequests,
    input_tokens_non_cached: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    total_tokens: usage.totalTokens,
    recorded_cost_usd:
      usage.requests > 0 && usage.unpricedRequests === usage.requests ? null : usage.costUsd,
    recorded_unpriced_requests: usage.unpricedRequests,
    current_catalog_estimate_usd:
      usage.requests > 0 && usage.unestimatedRequests === usage.requests
        ? null
        : usage.estimatedCostUsd,
    catalog_unpriced_requests: usage.unestimatedRequests,
    recorded_cost_display:
      rate !== null && !(usage.requests > 0 && usage.unpricedRequests === usage.requests)
        ? usage.costUsd * rate
        : null,
    catalog_estimate_display:
      rate !== null && !(usage.requests > 0 && usage.unestimatedRequests === usage.requests)
        ? usage.estimatedCostUsd * rate
        : null,
    request_average_output_tps:
      usage.measuredDurationMs > 0
        ? (usage.measuredOutputTokens * 1000) / usage.measuredDurationMs
        : null,
    peak_measured_aggregate_output_tps: usage.peakOutputTps,
  });
  const rows: CsvRow[] = [];
  if (!range)
    rows.push({
      ...common,
      ...usageRow(snapshot.today),
      section: "today",
      measured_output_tps: snapshot.rate.measuredTps,
      estimated_output_tps: snapshot.rate.estimatedTps,
      notes:
        "Currently available OMP logs only; current-catalog estimates are not historic invoices. Live TPS sums concurrent outputs; request average excludes tools and includes TTFT. Not added to native /stats.",
    });
  for (const day of snapshot.days) {
    if (range && (day.date < range.startDate || day.date > range.endDate)) continue;
    rows.push({ ...common, ...usageRow(day), section: "daily", date: day.date });
  }
  if (range) return encodeRows(rows);
  for (const agent of snapshot.agents) {
    rows.push({
      ...common,
      section: "agent",
      label: agent.name,
      profile: agent.profile,
      project: agent.project,
      kind: agent.kind,
      model: agent.model,
      phase: agent.phase,
      request_average_output_tps: agent.outputTps,
      ttft_ms: agent.ttftMs,
      sampled_at: agent.lastActivityAt > 0 ? new Date(agent.lastActivityAt).toISOString() : null,
    });
  }
  const resources = snapshot.resources;
  rows.push({
    ...common,
    section: "resources",
    profile: "all identifiable native OMP processes",
    project: "all identifiable native OMP processes",
    sampled_at: new Date(resources.sampledAt).toISOString(),
    native_process_count: resources.status === "unavailable" ? null : resources.processCount,
    cpu_percent_total_capacity: resources.cpuPercent,
    working_set_bytes: resources.workingSetBytes,
    private_bytes: resources.privateBytes,
    notes: `${resources.status}${resources.reason ? `: ${resources.reason}` : ""}; native executable names only, excludes Node/Bun wrappers; RSS is not unique physical memory`,
  });
  return encodeRows(rows);
}

function encodeRows(rows: readonly CsvRow[]): string {
  const lines = [COLUMNS.map(csvCell).join(",")];
  for (const row of rows) lines.push(COLUMNS.map((column) => csvCell(row[column])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
