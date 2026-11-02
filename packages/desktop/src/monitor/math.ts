import type { NumericResponse } from "./parser.js";
import type { OmpMonitorPoint } from "./types.js";

/** The live dashboard keeps this dense tail; older available history is sparse, not date-limited. */
const RECENT_HISTORY_DAYS = 30;
export const LIVE_WINDOW_MS = 3_000;
export const SERIES_SECONDS = 300;

export interface MonitorCalendarDay {
  date: string;
  start: number;
  end: number;
}

/** A real local day, without constructing a calendar sequence across an untrusted timestamp span. */
export function calendarDay(atMs: number): MonitorCalendarDay | null {
  const start = new Date(atMs);
  const year = start.getFullYear();
  if (!Number.isFinite(start.getTime()) || year < 1 || year > 9999) return null;
  const date = `${year.toString().padStart(4, "0")}-${(start.getMonth() + 1).toString().padStart(2, "0")}-${start.getDate().toString().padStart(2, "0")}`;
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { date, start: start.getTime(), end: end.getTime() };
}

export function calendarDays(now: number): MonitorCalendarDay[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const result: MonitorCalendarDay[] = [];
  for (let ago = RECENT_HISTORY_DAYS - 1; ago >= 0; ago--) {
    const start = new Date(today);
    start.setDate(start.getDate() - ago);
    const day = calendarDay(start.getTime());
    if (day) result.push(day);
  }
  return result;
}

export interface EstimateInterval {
  agentId: string;
  start: number;
  end: number;
  speed: number;
  totalSpeed: number;
  /** Same speed-reference set as output; null/absent means the native split is unknown. */
  thinkingSpeed?: number | null;
}

/** A sparse per-second distribution avoids duration-sized arrays for each response. */
function addInterval(events: Map<number, number>, start: number, end: number, speed: number): void {
  if (end <= start || speed <= 0) return;
  const first = Math.floor(start / 1_000);
  const last = Math.ceil(end / 1_000) - 1;
  const pieces =
    first === last
      ? [[first, first + 1, (speed * (end - start)) / 1_000]]
      : [
          [first, first + 1, (speed * ((first + 1) * 1_000 - start)) / 1_000],
          [first + 1, last, speed],
          [last, last + 1, (speed * (end - last * 1_000)) / 1_000],
        ];
  for (const [from, to, value] of pieces) {
    if (to <= from || !value) continue;
    events.set(from, (events.get(from) ?? 0) + value);
    events.set(to, (events.get(to) ?? 0) - value);
  }
}

export interface MeasuredPeak {
  value: number;
  /** Exclusive end of the earliest winning three-second bucket window. */
  at: number | null;
  /** Latest feedback-eligible completion contributing the selected metric to that window. */
  observedAt: number | null;
}

/** OMP's native throughput total includes cached input, never billed orchestration in totalTokens. */
export function throughputTotalTokens(response: NumericResponse): number {
  return (
    response.inputTokens +
    response.cacheReadTokens +
    response.cacheWriteTokens +
    response.outputTokens
  );
}

function peakObservedAt(
  responses: readonly NumericResponse[],
  start: number,
  end: number,
  peakAt: number | null,
  metric: "output" | "total",
): number | null {
  if (peakAt === null) return null;
  let observedAt: number | null = null;
  for (const response of responses) {
    if (
      response.startMs === null ||
      response.feedbackEligible === false ||
      response.measuredDurationMs <= 0 ||
      (metric === "total" ? throughputTotalTokens(response) : response.outputTokens) <= 0
    )
      continue;
    if (
      Math.max(start, response.startMs, peakAt - LIVE_WINDOW_MS) <
      Math.min(end, response.endMs, peakAt)
    )
      observedAt = Math.max(observedAt ?? response.endMs, response.endMs);
  }
  return observedAt;
}

function liveSeries(
  measured: Map<number, number>,
  estimated: Map<number, number>,
  measuredTotal: Map<number, number>,
  estimatedTotal: Map<number, number>,
  firstSecond: number,
  lastSecond: number,
): OmpMonitorPoint[] {
  const measuredChanges = [...measured].sort((a, b) => a[0] - b[0]);
  const estimatedChanges = [...estimated].sort((a, b) => a[0] - b[0]);
  const measuredTotalChanges = [...measuredTotal].sort((a, b) => a[0] - b[0]);
  const estimatedTotalChanges = [...estimatedTotal].sort((a, b) => a[0] - b[0]);
  let measuredIndex = 0;
  let estimatedIndex = 0;
  let measuredTotalIndex = 0;
  let estimatedTotalIndex = 0;
  let measuredValue = 0;
  let estimatedValue = 0;
  let measuredTotalValue = 0;
  let estimatedTotalValue = 0;
  const series: OmpMonitorPoint[] = [];
  for (let second = firstSecond; second <= lastSecond; second++) {
    while (measuredIndex < measuredChanges.length && measuredChanges[measuredIndex]![0] <= second)
      measuredValue += measuredChanges[measuredIndex++]![1];
    while (
      estimatedIndex < estimatedChanges.length &&
      estimatedChanges[estimatedIndex]![0] <= second
    )
      estimatedValue += estimatedChanges[estimatedIndex++]![1];
    while (
      measuredTotalIndex < measuredTotalChanges.length &&
      measuredTotalChanges[measuredTotalIndex]![0] <= second
    )
      measuredTotalValue += measuredTotalChanges[measuredTotalIndex++]![1];
    while (
      estimatedTotalIndex < estimatedTotalChanges.length &&
      estimatedTotalChanges[estimatedTotalIndex]![0] <= second
    )
      estimatedTotalValue += estimatedTotalChanges[estimatedTotalIndex++]![1];
    series.push({
      timestamp: second * 1_000,
      measuredTps: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, measuredValue)),
      estimatedTps: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, estimatedValue)),
      measuredTotalTps: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, measuredTotalValue)),
      estimatedTotalTps: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, estimatedTotalValue)),
    });
  }
  return series;
}

/** Peak measured concurrent throughput, averaged over three one-second buckets. */
export function measuredPeak(
  responses: readonly NumericResponse[],
  start: number,
  end: number,
  metric: "output" | "total" = "output",
): MeasuredPeak {
  if (responses.length === 0) return { value: 0, at: null, observedAt: null };
  const events = new Map<number, number>();
  for (const response of responses) {
    if (response.startMs === null || !response.measuredDurationMs) continue;
    addInterval(
      events,
      Math.max(start, response.startMs),
      Math.min(end, response.endMs),
      ((metric === "total" ? throughputTotalTokens(response) : response.outputTokens) * 1_000) /
        response.measuredDurationMs,
    );
  }
  const entries = [...events].sort((a, b) => a[0] - b[0]);
  if (!entries.length) return { value: 0, at: null, observedAt: null };
  let cursor = entries[0]![0];
  let value = 0;
  let previous = 0;
  let beforePrevious = 0;
  let peak = 0;
  let peakAt: number | null = null;
  for (const [second, delta] of entries) {
    const gap = second - cursor;
    for (let count = 0; count < Math.min(3, gap); count++) {
      const candidate = (beforePrevious + previous + value) / 3;
      if (candidate > peak) {
        peak = candidate;
        peakAt = (cursor + count + 1) * 1_000;
      }
      beforePrevious = previous;
      previous = value;
    }
    if (gap > 3) {
      if (value > peak) {
        peak = value;
        peakAt = (cursor + 3) * 1_000;
      }
      beforePrevious = value;
      previous = value;
    }
    cursor = second;
    value = Math.max(0, value + delta);
  }
  return {
    value: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, peak)),
    at: peakAt,
    observedAt: peakObservedAt(responses, start, end, peakAt, metric),
  };
}

export interface LiveMetrics {
  measuredTps: number;
  estimatedTps: number;
  measuredTotalTps: number;
  estimatedTotalTps: number;
  estimatedShare: number;
  measuredThinkingTps: number | null;
  estimatedThinkingTps: number | null;
  series: OmpMonitorPoint[];
}

export function liveMetrics(
  responses: readonly NumericResponse[],
  estimates: readonly EstimateInterval[],
  now: number,
): LiveMetrics {
  const measured = new Map<number, number>();
  const estimated = new Map<number, number>();
  const measuredTotal = new Map<number, number>();
  const estimatedTotal = new Map<number, number>();
  const firstSecond = Math.floor(now / 1_000) - SERIES_SECONDS + 1;
  const seriesStart = firstSecond * 1_000;
  let measuredTokens = 0;
  let estimatedTokens = 0;
  let measuredTotalTokens = 0;
  let estimatedTotalTokens = 0;
  let measuredThinkingTokens: number | null = null;
  let estimatedThinkingTokens: number | null = null;
  for (const response of responses) {
    if (response.sideCall || response.startMs === null || response.measuredDurationMs <= 0)
      continue;
    const speed = (response.outputTokens * 1_000) / response.measuredDurationMs;
    const totalSpeed = (throughputTotalTokens(response) * 1_000) / response.measuredDurationMs;
    const overlap = liveOverlapMs(response.startMs, response.endMs, now);
    measuredTokens += (speed * overlap) / 1_000;
    measuredTotalTokens += (totalSpeed * overlap) / 1_000;
    if (overlap > 0 && response.reasoningKnownRequests > 0)
      measuredThinkingTokens =
        (measuredThinkingTokens ?? 0) +
        (Math.min(response.reasoningTokens, response.outputTokens) * overlap) /
          response.measuredDurationMs;
    addInterval(
      measured,
      Math.max(seriesStart, response.startMs),
      Math.min(now, response.endMs),
      speed,
    );
    addInterval(
      measuredTotal,
      Math.max(seriesStart, response.startMs),
      Math.min(now, response.endMs),
      totalSpeed,
    );
  }
  for (const estimate of estimates) {
    const overlap = liveOverlapMs(estimate.start, estimate.end, now);
    estimatedTokens += (estimate.speed * overlap) / 1_000;
    estimatedTotalTokens += (estimate.totalSpeed * overlap) / 1_000;
    if (overlap > 0 && typeof estimate.thinkingSpeed === "number")
      estimatedThinkingTokens =
        (estimatedThinkingTokens ?? 0) + (estimate.thinkingSpeed * overlap) / 1_000;
    addInterval(
      estimated,
      Math.max(seriesStart, estimate.start),
      Math.min(now, estimate.end),
      estimate.speed,
    );
    addInterval(
      estimatedTotal,
      Math.max(seriesStart, estimate.start),
      Math.min(now, estimate.end),
      estimate.totalSpeed,
    );
  }
  const series = liveSeries(
    measured,
    estimated,
    measuredTotal,
    estimatedTotal,
    firstSecond,
    Math.floor(now / 1_000),
  );
  const total = measuredTokens + estimatedTokens;
  return {
    measuredTps: Math.min(Number.MAX_SAFE_INTEGER, measuredTokens / (LIVE_WINDOW_MS / 1_000)),
    estimatedTps: Math.min(Number.MAX_SAFE_INTEGER, estimatedTokens / (LIVE_WINDOW_MS / 1_000)),
    measuredTotalTps: Math.min(
      Number.MAX_SAFE_INTEGER,
      measuredTotalTokens / (LIVE_WINDOW_MS / 1_000),
    ),
    estimatedTotalTps: Math.min(
      Number.MAX_SAFE_INTEGER,
      estimatedTotalTokens / (LIVE_WINDOW_MS / 1_000),
    ),
    estimatedShare: total > 0 ? estimatedTokens / total : 0,
    measuredThinkingTps:
      measuredThinkingTokens === null
        ? null
        : Math.min(Number.MAX_SAFE_INTEGER, measuredThinkingTokens / (LIVE_WINDOW_MS / 1_000)),
    estimatedThinkingTps:
      estimatedThinkingTokens === null
        ? null
        : Math.min(Number.MAX_SAFE_INTEGER, estimatedThinkingTokens / (LIVE_WINDOW_MS / 1_000)),
    series,
  };
}

/** Identical clipping for aggregate, agent, thinking and current-catalog cost contributions. */
export function liveOverlapMs(start: number, end: number, now: number): number {
  return Math.max(0, Math.min(now, end) - Math.max(now - LIVE_WINDOW_MS, start));
}
