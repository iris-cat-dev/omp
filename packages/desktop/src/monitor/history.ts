import { calendarDay, calendarDays, measuredPeak } from "./math.js";
import type { MeasuredPeak, MonitorCalendarDay } from "./math.js";
import { emptyUsage } from "./parser.js";
import type { NumericResponse } from "./parser.js";
import type { OmpMonitorCostInput } from "./pricing.js";
import type {
  OmpMonitorBreakdownCounts,
  OmpMonitorBreakdowns,
  OmpMonitorDay,
  OmpMonitorModelBreakdown,
  OmpMonitorModeBreakdown,
  OmpMonitorScope,
  OmpMonitorUsage,
} from "./types.js";

const USAGE_FIELDS = Object.keys(emptyUsage()) as Array<keyof OmpMonitorUsage>;
const BREAKDOWN_FIELDS = [
  "requests",
  "outputTokens",
  "measuredOutputTokens",
  "measuredDurationMs",
] as const;
const MODEL_COST_FIELDS = [
  "costUsd",
  "unpricedRequests",
  "estimatedCostUsd",
  "unestimatedRequests",
] as const;
const MODE_KINDS = ["effort", "speed"] as const;
export interface HistoryProjection {
  days: OmpMonitorDay[];
  breakdowns: OmpMonitorBreakdowns;
  /** Peak provenance aligned with days, kept out of additive usage fields. */
  peaks: MeasuredPeak[];
  totalPeaks: MeasuredPeak[];
  startDate: string | null;
  endDate: string;
  lastResponseAt: number | null;
  limited: boolean;
}
interface CachedHistory extends HistoryProjection {
  version: string;
}
interface CachedQuote {
  version: string;
  cost: number | null;
}

function usageContribution(
  field: keyof OmpMonitorUsage,
  response: NumericResponse,
  cost: number | null,
): number {
  if (field === "estimatedCostUsd") return cost ?? 0;
  if (field === "unestimatedRequests") return cost === null ? 1 : 0;
  return response[field];
}

function addUsage(day: OmpMonitorDay, response: NumericResponse, cost: number | null): boolean {
  let limited = false;
  for (const field of USAGE_FIELDS) {
    if (field === "peakOutputTps" || field === "peakTotalTps") continue;
    const sum = day[field] + usageContribution(field, response, cost);
    if (sum > Number.MAX_SAFE_INTEGER) limited = true;
    day[field] = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, sum));
  }
  return limited;
}

function addBreakdownCounts(target: OmpMonitorBreakdownCounts, response: NumericResponse): boolean {
  let limited = false;
  for (const field of BREAKDOWN_FIELDS) {
    const sum = target[field] + response[field];
    if (sum > Number.MAX_SAFE_INTEGER) limited = true;
    target[field] = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, sum));
  }
  return limited;
}

function recordBreakdowns(
  date: string,
  models: Map<string | null, OmpMonitorModelBreakdown>,
  modes: Map<string, OmpMonitorModeBreakdown>,
  response: NumericResponse,
  cost: number | null,
): boolean {
  let model = models.get(response.model);
  if (!model) {
    model = {
      date,
      source: "omp",
      model: response.model,
      requests: 0,
      outputTokens: 0,
      measuredOutputTokens: 0,
      measuredDurationMs: 0,
      costUsd: 0,
      unpricedRequests: 0,
      estimatedCostUsd: 0,
      unestimatedRequests: 0,
    };
    models.set(response.model, model);
  }
  let limited = addBreakdownCounts(model, response);
  for (const field of MODEL_COST_FIELDS) {
    const sum = model[field] + usageContribution(field, response, cost);
    if (sum > Number.MAX_SAFE_INTEGER) limited = true;
    model[field] = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, sum));
  }
  for (const kind of MODE_KINDS) {
    const fact = kind === "effort" ? response.effortMode : response.speedMode;
    const key = JSON.stringify([response.model, kind, fact?.value, fact?.evidence, fact?.provider]);
    let mode = modes.get(key);
    if (!mode) {
      mode = {
        date,
        source: "omp",
        model: response.model,
        kind,
        value: fact?.value ?? null,
        evidence: fact?.evidence ?? null,
        provider: fact?.provider ?? null,
        requests: 0,
        outputTokens: 0,
        measuredOutputTokens: 0,
        measuredDurationMs: 0,
      };
      modes.set(key, mode);
    }
    limited = addBreakdownCounts(mode, response) || limited;
  }
  return limited;
}

interface HistoryDayBucket {
  calendar: MonitorCalendarDay;
  usage: OmpMonitorDay;
  models: Map<string | null, OmpMonitorModelBreakdown>;
  modes: Map<string, OmpMonitorModeBreakdown>;
  intervals: NumericResponse[];
  agents: Set<string>;
}

function dayBucket(
  day: MonitorCalendarDay,
  buckets: Map<string, HistoryDayBucket>,
): HistoryDayBucket {
  const previous = buckets.get(day.date);
  if (previous) return previous;
  const bucket: HistoryDayBucket = {
    calendar: day,
    usage: { date: day.date, agentCount: 0, ...emptyUsage() },
    models: new Map(),
    modes: new Map(),
    intervals: [],
    agents: new Set(),
  };
  buckets.set(day.date, bucket);
  return bucket;
}

function addPeakIntervals(
  response: NumericResponse,
  today: MonitorCalendarDay,
  buckets: Map<string, HistoryDayBucket>,
): boolean {
  if (response.startMs === null) return false;
  const first = calendarDay(response.startMs);
  const last = calendarDay(response.endMs - 1);
  if (!first || !last) return true;
  // A validated measured request lasts at most 15 minutes: only its two endpoint days can overlap.
  if (first.date <= today.date) dayBucket(first, buckets).intervals.push(response);
  if (last.date !== first.date && last.date <= today.date)
    dayBucket(last, buckets).intervals.push(response);
  return false;
}

function finishHistoryDays(
  buckets: Map<string, HistoryDayBucket>,
  projection: HistoryProjection,
): void {
  // Sparse older days are bounded by retained records, not the distance to an arbitrary year.
  const ordered = [...buckets.values()].sort((a, b) => a.calendar.start - b.calendar.start);
  for (const bucket of ordered) {
    const { start, end } = bucket.calendar;
    const peak = measuredPeak(bucket.intervals, start, end);
    const totalPeak = measuredPeak(bucket.intervals, start, end, "total");
    if (
      (peak.value > 0 || totalPeak.value > 0) &&
      (projection.startDate === null || bucket.calendar.date < projection.startDate)
    )
      projection.startDate = bucket.calendar.date;
    bucket.usage.peakOutputTps = peak.value;
    bucket.usage.peakTotalTps = totalPeak.value;
    bucket.usage.agentCount = bucket.agents.size;
    projection.days.push(bucket.usage);
    projection.peaks.push(peak);
    projection.totalPeaks.push(totalPeak);
    for (const row of bucket.models.values()) projection.breakdowns.models.push(row);
    for (const row of bucket.modes.values()) projection.breakdowns.modes.push(row);
  }
}

/** Cached current-catalog projections of retained numeric facts, never a persistent ledger. */
export class OmpMonitorHistory {
  private readonly quotes = new WeakMap<OmpMonitorCostInput, CachedQuote>();
  private readonly histories = new Map<string, CachedHistory>();

  constructor(private readonly estimateCost?: (usage: OmpMonitorCostInput) => number | null) {}

  getDays(
    scope: OmpMonitorScope,
    responses: readonly NumericResponse[],
    now: number,
    revision: number,
    priceVersion: string,
  ): HistoryProjection {
    const recent = calendarDays(now);
    const today = recent.at(-1)!;
    const key = JSON.stringify(scope);
    const version = `${revision}:${today.start}:${priceVersion}`;
    const cached = this.histories.get(key);
    if (cached?.version === version) return cached;
    const buckets = new Map<string, HistoryDayBucket>();
    for (const day of recent) dayBucket(day, buckets);
    let lastResponseAt: number | null = null;
    let startDate: string | null = null;
    let limited = false;
    for (const response of responses) {
      const day = calendarDay(response.endMs);
      if (!day) {
        limited = true;
        continue;
      }
      if (
        response.feedbackEligible !== false &&
        !response.sideCall &&
        response.failedRequests === 0 &&
        response.outputTokens > 0
      )
        lastResponseAt = Math.max(lastResponseAt ?? response.endMs, response.endMs);
      if (day.date <= today.date) {
        const bucket = dayBucket(day, buckets);
        bucket.agents.add(response.agentId);
        const cost = this.quoteCost(response, priceVersion);
        if (startDate === null || day.date < startDate) startDate = day.date;
        limited = addUsage(bucket.usage, response, cost) || limited;
        limited =
          recordBreakdowns(day.date, bucket.models, bucket.modes, response, cost) || limited;
      }
      limited = addPeakIntervals(response, today, buckets) || limited;
    }
    const result: CachedHistory = {
      version,
      days: [],
      breakdowns: { models: [], modes: [] },
      peaks: [],
      totalPeaks: [],
      lastResponseAt,
      startDate,
      endDate: today.date,
      limited,
    };
    finishHistoryDays(buckets, result);
    if (this.histories.size >= 9 && !this.histories.has(key))
      this.histories.delete(this.histories.keys().next().value!);
    this.histories.set(key, result);
    return result;
  }

  clear(): void {
    this.histories.clear();
  }

  /** Share retained-response identity and catalog-version quotes with the live projection. */
  quoteCost(response: OmpMonitorCostInput, version: string): number | null {
    const cached = this.quotes.get(response);
    if (cached?.version === version) return cached.cost;
    const value = this.estimateCost?.(response) ?? null;
    const cost =
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.min(1_000_000_000, value)
        : null;
    this.quotes.set(response, { version, cost });
    return cost;
  }
}

export function currentDayUsage(days: readonly OmpMonitorDay[]): OmpMonitorUsage {
  const today = emptyUsage();
  const current = days.at(-1)!;
  for (const field of USAGE_FIELDS) today[field] = current[field];
  return today;
}
