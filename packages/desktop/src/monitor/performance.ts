// Agent Speed v1.6.0 (MIT), ca460d7f899e7adc73391ea706b729f1fc481fde.
// Port of spec/tools/perf_score.py: METRICS 3.3, 6.9 and 6.11. No log readers or reporters.
/*
MIT License

Copyright (c) 2026 zoefix

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import type {
  MonitorPerformanceAction,
  MonitorPerformanceAgent,
  MonitorPerformanceComponent,
  MonitorPerformanceComponentId,
  MonitorPerformanceEvaluation,
  MonitorPerformancePooled,
  MonitorPerformanceRangeRow,
  MonitorPerformanceRecord,
  MonitorPerformanceResponse,
  MonitorPerformanceSetValue,
  MonitorPerformanceSums,
} from "./performance-types.js";

export interface MonitorPerformanceSetAgent {
  id: string;
  lastLineMs?: number | null;
  /** The native monitor snapshot's name for the same last-line timestamp. */
  lastActivityAt?: number | null;
}
export interface MonitorPerformanceRecorder {
  response(agentId: string, source: string, response: MonitorPerformanceResponse): void;
  action(agentId: string, source: string, action: MonitorPerformanceAction): void;
  rows(): MonitorPerformanceRecord[];
}
export interface MonitorPerformanceModel {
  evaluate(
    agent: MonitorPerformanceAgent,
    responses: readonly MonitorPerformanceResponse[],
    actions: readonly MonitorPerformanceAction[],
    nowMs: number,
    records?: readonly MonitorPerformanceRecord[],
    today?: string,
  ): MonitorPerformanceEvaluation;
  highest(
    agents: readonly MonitorPerformanceSetAgent[],
    values: Readonly<Record<string, Pick<MonitorPerformanceEvaluation, "form" | "score">>>,
  ): MonitorPerformanceSetValue;
  pool(records: readonly MonitorPerformanceSums[], source: string): MonitorPerformancePooled;
  baseline(
    records: readonly MonitorPerformanceRecord[],
    source: string,
    model: string,
    today: string,
  ): number | null;
  range(
    records: readonly MonitorPerformanceRecord[],
    first: string,
    last: string,
    source?: string | null,
  ): MonitorPerformanceRangeRow[];
  createRecorder(dayOf: (ms: number) => string | null): MonitorPerformanceRecorder;
}
interface PerformanceMeasure {
  value: number | null;
  samples: number;
}
interface PerformanceInterval {
  start: number;
  end: number;
}
interface PerformanceCombination {
  components: MonitorPerformanceComponent[];
  score: number | null;
}
interface PerformanceRangeGroup {
  source: string;
  model: string;
  records: MonitorPerformanceRecord[];
}
interface PerformanceCallFacts {
  tools: number;
  logs: number;
  failed: number;
}

/** This function is embedded independently in the board sandbox: keep it closure-free. */
export function highestPerformanceValue(
  agents: readonly MonitorPerformanceSetAgent[],
  values: Readonly<Record<string, Pick<MonitorPerformanceEvaluation, "form" | "score">>>,
): MonitorPerformanceSetValue {
  for (let pass = 0; pass < 2; pass++) {
    const form = pass === 0 ? "live" : "resting";
    let best: number | null = null;
    let supplier: string | null = null;
    let latest = 0;
    for (const candidate of agents) {
      const value = values[candidate.id];
      if (value?.form !== form || value.score === null) continue;
      const at = candidate.lastLineMs ?? candidate.lastActivityAt ?? 0;
      const newer =
        at > latest || (at === latest && (supplier === null || candidate.id < supplier));
      if (best === null || value.score > best || (value.score === best && newer)) {
        best = value.score;
        supplier = candidate.id;
        latest = at;
      }
    }
    if (best !== null) {
      const magnitude = Math.floor(Math.abs(best) + 0.5);
      const shown = best < 0 && magnitude !== 0 ? -magnitude : magnitude;
      return { form, score: best, shown, agent: supplier };
    }
  }
  return { form: "none", score: null, shown: null, agent: null };
}

/** One factory supplies Node and the static browser expression; all runtime dependencies are local. */
function createPerformanceModel(
  highest: MonitorPerformanceModel["highest"],
): MonitorPerformanceModel {
  const ids: MonitorPerformanceComponentId[] = ["T", "L", "N", "R", "H", "U", "S"];
  const weights = [0.3, 0.2, 0.15, 0.1, 0.1, 0.1, 0.05];
  const sources = [
    "codex",
    "claudeCode",
    "claudeDesktop",
    "deepseek",
    "opencode",
    "gemini",
    "omp",
    "antigravity",
    "workbuddy",
    "workbuddyAi",
    "zcode",
    "kimi",
    "grokBuild",
    "pi",
    "openclaw",
    "hermes",
    "droid",
  ];
  const latencySources: Record<string, true> = {
    codex: true,
    claudeCode: true,
    claudeDesktop: true,
  };
  const actionSources: Record<string, true> = {
    codex: true,
    claudeCode: true,
    claudeDesktop: true,
    omp: true,
    pi: true,
    openclaw: true,
    droid: true,
  };
  // Exact integer E_0 ... E_64 from the upstream fixture, not floating-point ceilings.
  const edges = [
    100, 119, 142, 169, 200, 238, 283, 337, 400, 476, 566, 673, 800, 952, 1132, 1346, 1600, 1903,
    2263, 2691, 3200, 3806, 4526, 5382, 6400, 7611, 9051, 10764, 12800, 15222, 18102, 21527, 25600,
    30444, 36204, 43054, 51200, 60888, 72408, 86108, 102400, 121775, 144816, 172216, 204800, 243550,
    289631, 344432, 409600, 487100, 579262, 688863, 819200, 974199, 1158524, 1377725, 1638400,
    1948397, 2317048, 2755450, 3276800, 3896794, 4634096, 5510899, 6553600,
  ];
  const sample: MonitorPerformanceResponse[] = [];
  const latencies: number[] = [];
  const intervals: PerformanceInterval[] = [];
  const intervalPool = Array.from({ length: 84 }, () => ({ start: 0, end: 0 }));
  const measures: PerformanceMeasure[] = Array.from({ length: 7 }, () => ({
    value: null,
    samples: 0,
  }));
  const callFacts: PerformanceCallFacts = { tools: 0, logs: 0, failed: 0 };

  function ordinal(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
  function utf8Point(text: string, offset: number): number {
    const point = text.codePointAt(offset)!;
    return point >= 0xd800 && point <= 0xdfff ? 0xfffd : point;
  }
  // UTF-8 byte order is scalar-value order. Do not allocate an encoded array for each comparison.
  function utf8Order(left: string, right: string): number {
    let a = 0;
    let b = 0;
    while (a < left.length && b < right.length) {
      const first = utf8Point(left, a);
      const second = utf8Point(right, b);
      if (first !== second) return first - second;
      a += first > 0xffff ? 2 : 1;
      b += second > 0xffff ? 2 : 1;
    }
    return left.length - a - (right.length - b);
  }
  function sourceOrder(left: string, right: string): number {
    return sources.indexOf(left) - sources.indexOf(right) || ordinal(left, right);
  }
  function rounded(value: number): number {
    const magnitude = Math.floor(Math.abs(value) + 0.5);
    return value < 0 && magnitude !== 0 ? -magnitude : magnitude;
  }
  function numericOrder(left: number, right: number): number {
    return left - right;
  }
  function measuredStart(response: MonitorPerformanceResponse): number | null {
    const start = response.startMs;
    const end = response.endMs;
    if (response.final === false || start == null || end < start || end - start > 900_000)
      return null;
    return Math.min(start, end - 500);
  }
  function latencyOf(response: MonitorPerformanceResponse): number | null {
    const first = response.firstMs;
    const start = response.startMs;
    if (first == null || start == null || first < start) return null;
    return first - start;
  }
  function newestFirst(
    left: MonitorPerformanceResponse,
    right: MonitorPerformanceResponse,
  ): number {
    return right.endMs - left.endMs || ordinal(left.key, right.key);
  }
  function selectSample(responses: readonly MonitorPerformanceResponse[], now: number): void {
    sample.length = 0;
    for (const response of responses) {
      if (
        response.endMs < now - 1_800_000 ||
        response.endMs > now ||
        measuredStart(response) === null
      )
        continue;
      let at = 0;
      while (at < sample.length && newestFirst(sample[at]!, response) <= 0) at++;
      if (at >= 20) continue;
      for (let index = Math.min(sample.length, 19); index > at; index--)
        sample[index] = sample[index - 1]!;
      sample[at] = response;
    }
  }
  function addInterval(start: number, end: number): void {
    const interval = intervalPool[intervals.length]!;
    interval.start = start;
    interval.end = end;
    intervals.push(interval);
  }
  function intervalOrder(left: PerformanceInterval, right: PerformanceInterval): number {
    return left.start - right.start || left.end - right.end;
  }
  function unionLength(): number {
    intervals.sort(intervalOrder);
    let total = 0;
    let start: number | null = null;
    let end = 0;
    for (const interval of intervals) {
      if (interval.end <= interval.start) continue;
      if (start === null || interval.start > end) {
        if (start !== null) total += end - start;
        start = interval.start;
        end = interval.end;
      } else {
        end = Math.max(end, interval.end);
      }
    }
    return total + (start === null ? 0 : end - start);
  }
  function resetMeasures(): void {
    for (const measure of measures) {
      measure.value = null;
      measure.samples = 0;
    }
  }
  function setMeasure(index: number, value: number | null, count: number): void {
    measures[index]!.value = value;
    measures[index]!.samples = count;
  }
  function notRecorded(id: MonitorPerformanceComponentId, source: string): boolean {
    if (id === "L") return latencySources[source] !== true;
    if (id === "N" || id === "U" || id === "S") return actionSources[source] !== true;
    if (id === "R") return source === "deepseek";
    return id === "H" && source === "hermes";
  }
  function rawRatio(index: number, value: number): number {
    switch (index) {
      case 0:
        return value / 50;
      case 1:
        return 5000 / Math.max(value, 250);
      case 2:
        return value / 3;
      case 3:
        return value / 20;
      case 4:
        return value / 0.95;
      case 5:
        return 400 / value;
      default:
        return value / 0.95;
    }
  }
  function combine(source: string): PerformanceCombination {
    const components: MonitorPerformanceComponent[] = [];
    let logSum = 0;
    let weightSum = 0;
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index]!;
      const { value, samples } = measures[index]!;
      if (value === null) {
        components.push({
          id,
          present: false,
          reason: notRecorded(id, source) ? "notRecorded" : "fewSamples",
          samples,
          measure: null,
          ratio: null,
          subScore: null,
        });
        continue;
      }
      const raw = rawRatio(index, value);
      const ratio = index === 0 ? Math.max(0.01, raw) : Math.min(20, Math.max(0.05, raw));
      components.push({
        id,
        present: true,
        reason: null,
        samples,
        measure: value,
        ratio,
        subScore: 1000 * ratio,
      });
      logSum = logSum + weights[index]! * Math.log(ratio);
      weightSum = weightSum + weights[index]!;
    }
    return { components, score: weightSum > 0 ? 1000 * Math.exp(logSum / weightSum) : null };
  }
  function measureResponses(source: string): void {
    let output = 0;
    let duration = 0;
    let thought = 0;
    let reason = 0;
    let reasonMs = 0;
    let cached = 0;
    let cacheInput = 0;
    let cacheCached = 0;
    latencies.length = 0;
    for (const response of sample) {
      const ms = response.endMs - measuredStart(response)!;
      output += response.output;
      duration += ms;
      const latency = latencyOf(response);
      if (latency !== null) latencies.push(latency);
      const reasoning = Math.min(response.reasoning ?? 0, response.output);
      if (reasoning > 0) {
        thought++;
        reason += reasoning;
        reasonMs += ms;
      }
      if (response.input > 0) {
        cached++;
        cacheInput += response.input;
        cacheCached += response.cachedInput;
      }
    }
    latencies.sort(numericOrder);
    const mid = Math.floor(latencies.length / 2);
    let median: number | null = null;
    if (latencies.length >= 3) {
      median = latencies.length % 2 ? latencies[mid]! : (latencies[mid - 1]! + latencies[mid]!) / 2;
    }
    setMeasure(0, output / (duration / 1000), sample.length);
    setMeasure(1, median, latencies.length);
    if (source !== "deepseek")
      setMeasure(3, thought >= 3 ? reason / (reasonMs / 1000) : null, thought);
    if (source !== "hermes") setMeasure(4, cached >= 3 ? cacheCached / cacheInput : null, cached);
  }
  function measureCalls(
    source: string,
    count: number,
    logs: number,
    failed: number,
    active: number,
  ): void {
    const present = actionSources[source] === true && count >= 3;
    setMeasure(2, present && active > 0 ? count / (active / 60_000) : null, count);
    setMeasure(5, present ? Math.exp(logs / count) : null, count);
    setMeasure(6, present ? 1 - failed / count : null, count);
  }
  function measureActions(
    actions: readonly MonitorPerformanceAction[],
    spanStart: number | null,
    now: number,
  ): void {
    callFacts.tools = 0;
    callFacts.logs = 0;
    callFacts.failed = 0;
    if (spanStart === null) return;
    for (let index = Math.max(0, actions.length - 64); index < actions.length; index++) {
      const action = actions[index]!;
      const end = action.resultMs;
      if (end == null || action.callMs < spanStart || end > now) continue;
      const duration = end - action.callMs;
      if (duration < 0 || duration > 900_000) continue;
      callFacts.tools++;
      callFacts.logs = callFacts.logs + Math.log(Math.max(duration, 50));
      if (action.failed === true) callFacts.failed++;
      addInterval(action.callMs, end);
    }
  }
  function compareWithBaseline(
    value: MonitorPerformanceEvaluation,
    records: readonly MonitorPerformanceRecord[] | undefined,
    source: string,
    today: string | undefined,
  ): void {
    if (value.score === null || records === undefined || today === undefined) return;
    const base = baseline(records, source, value.model ?? "", today);
    if (base === null) return;
    value.baseline = base;
    value.vsUsual = value.score / base - 1;
    value.vsUsualPercent = rounded(100 * value.vsUsual);
  }
  function evaluate(
    agent: MonitorPerformanceAgent,
    responses: readonly MonitorPerformanceResponse[],
    actions: readonly MonitorPerformanceAction[],
    nowMs: number,
    records?: readonly MonitorPerformanceRecord[],
    today?: string,
  ): MonitorPerformanceEvaluation {
    selectSample(responses, nowMs);
    resetMeasures();
    intervals.length = 0;
    let spanStartMs: number | null = null;
    for (const response of sample) {
      const start = measuredStart(response)!;
      spanStartMs = spanStartMs === null ? start : Math.min(start, spanStartMs);
      addInterval(start, response.endMs);
    }
    measureActions(actions, sample.length >= 3 ? spanStartMs : null, nowMs);
    const activeMs = unionLength();
    if (sample.length >= 3) {
      measureResponses(agent.source);
      measureCalls(agent.source, callFacts.tools, callFacts.logs, callFacts.failed, activeMs);
    } else {
      setMeasure(0, null, sample.length);
    }
    const { components, score } = combine(agent.source);
    const stale = agent.lastLineMs != null && nowMs - agent.lastLineMs > 300_000;
    let form: MonitorPerformanceEvaluation["form"] = "none";
    if (score !== null) form = agent.phase === "idle" || stale ? "resting" : "live";
    const model = sample[0]?.model ?? null;
    const result: MonitorPerformanceEvaluation = {
      form,
      score,
      shown: score === null ? null : rounded(score),
      provisional: score !== null && sample.length < 10,
      n: sample.length,
      tools: callFacts.tools,
      activeMs,
      spanStartMs,
      model,
      components,
      baseline: null,
      vsUsual: null,
      vsUsualPercent: null,
    };
    compareWithBaseline(result, records, agent.source, today);
    return result;
  }
  function emptySums(): MonitorPerformanceSums {
    return {
      n: 0,
      outputSum: 0,
      durationMsSum: 0,
      latencyBins: Array.from({ length: 64 }, () => 0),
      reasonN: 0,
      reasonOutput: 0,
      reasonDurationMsSum: 0,
      cacheN: 0,
      cacheInput: 0,
      cacheCached: 0,
      toolN: 0,
      toolLnSum: 0,
      toolFailed: 0,
      activeMs: 0,
    };
  }
  function addSums(total: MonitorPerformanceSums, record: MonitorPerformanceSums): void {
    total.n += record.n;
    total.outputSum += record.outputSum;
    total.durationMsSum += record.durationMsSum;
    for (let index = 0; index < 64; index++)
      total.latencyBins[index]! += record.latencyBins[index]!;
    total.reasonN += record.reasonN;
    total.reasonOutput += record.reasonOutput;
    total.reasonDurationMsSum += record.reasonDurationMsSum;
    total.cacheN += record.cacheN;
    total.cacheInput += record.cacheInput;
    total.cacheCached += record.cacheCached;
    total.toolN += record.toolN;
    total.toolLnSum = total.toolLnSum + record.toolLnSum;
    total.toolFailed += record.toolFailed;
    total.activeMs += record.activeMs;
  }
  function pooledLatency(bins: readonly number[]): void {
    let count = 0;
    for (const bin of bins) count += bin;
    setMeasure(1, null, count);
    if (count < 3) return;
    const target = Math.floor((count + 1) / 2);
    let seen = 0;
    for (let index = 0; index < bins.length; index++) {
      seen += bins[index]!;
      if (seen >= target) {
        setMeasure(1, 100 * 2 ** ((2 * index + 1) / 8), count);
        return;
      }
    }
  }
  function pool(
    records: readonly MonitorPerformanceSums[],
    source: string,
  ): MonitorPerformancePooled {
    const sums = emptySums();
    for (const record of records) addSums(sums, record);
    resetMeasures();
    setMeasure(0, sums.n >= 3 ? sums.outputSum / (sums.durationMsSum / 1000) : null, sums.n);
    pooledLatency(sums.latencyBins);
    setMeasure(
      3,
      sums.reasonN >= 3 ? sums.reasonOutput / (sums.reasonDurationMsSum / 1000) : null,
      sums.reasonN,
    );
    setMeasure(4, sums.cacheN >= 3 ? sums.cacheCached / sums.cacheInput : null, sums.cacheN);
    const count = sums.toolN;
    setMeasure(2, count >= 3 && sums.activeMs > 0 ? count / (sums.activeMs / 60_000) : null, count);
    setMeasure(5, count >= 3 ? Math.exp(sums.toolLnSum / count) : null, count);
    setMeasure(6, count >= 3 ? 1 - sums.toolFailed / count : null, count);
    const combined = combine(source);
    const score = sums.n >= 20 ? combined.score : null;
    return {
      n: sums.n,
      tools: count,
      activeMs: sums.activeMs,
      score,
      shown: score === null ? null : rounded(score),
      components: combined.components,
    };
  }
  // Date arithmetic is on civil date labels, not 24-hour local timestamp durations (DST-safe).
  function dayMs(text: string): number | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const date = new Date(text + "T00:00:00.000Z");
    const ms = date.getTime();
    if (!Number.isFinite(ms) || date.toISOString().slice(0, 10) !== text) return null;
    return ms;
  }
  function dayAt(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }
  function baseline(
    records: readonly MonitorPerformanceRecord[],
    source: string,
    model: string,
    today: string,
  ): number | null {
    const ms = dayMs(today);
    if (ms === null) return null;
    const first = dayAt(ms - 14 * 86_400_000);
    const last = dayAt(ms - 86_400_000);
    const chosen: MonitorPerformanceRecord[] = [];
    for (const record of records) {
      if (
        record.source === source &&
        record.model === model &&
        record.day >= first &&
        record.day <= last
      ) {
        chosen.push(record);
      }
    }
    return pool(chosen, source).score;
  }
  function rangeGroups(
    records: readonly MonitorPerformanceRecord[],
    first: string,
    last: string,
    source?: string | null,
  ): PerformanceRangeGroup[] {
    const bySource = new Map<string, Map<string, PerformanceRangeGroup>>();
    const groups: PerformanceRangeGroup[] = [];
    for (const record of records) {
      if (record.day < first || record.day > last || (source != null && record.source !== source))
        continue;
      let models = bySource.get(record.source);
      if (!models) {
        models = new Map();
        bySource.set(record.source, models);
      }
      let group = models.get(record.model);
      if (!group) {
        group = { source: record.source, model: record.model, records: [] };
        models.set(record.model, group);
        groups.push(group);
      }
      group.records.push(record);
    }
    return groups;
  }
  function rangeOrder(left: MonitorPerformanceRangeRow, right: MonitorPerformanceRangeRow): number {
    return (
      sourceOrder(left.source, right.source) ||
      right.n - left.n ||
      utf8Order(left.model, right.model)
    );
  }
  function range(
    records: readonly MonitorPerformanceRecord[],
    first: string,
    last: string,
    source?: string | null,
  ): MonitorPerformanceRangeRow[] {
    const firstMs = dayMs(first);
    const lastMs = dayMs(last);
    if (firstMs === null || lastMs === null || firstMs > lastMs) return [];
    const days: string[] = [];
    for (let ms = firstMs; ms <= lastMs; ms += 86_400_000) days.push(dayAt(ms));
    const rows: MonitorPerformanceRangeRow[] = [];
    for (const group of rangeGroups(records, first, last, source)) {
      const trend: MonitorPerformanceRangeRow["trend"] = [];
      for (const day of days) {
        const daily = group.records.filter((record) => record.day === day);
        trend.push({ day, score: pool(daily, group.source).score });
      }
      rows.push({
        source: group.source,
        model: group.model,
        ...pool(group.records, group.source),
        trend,
      });
    }
    rows.sort(rangeOrder);
    return rows;
  }
  function latencyBin(ms: number): number {
    let low = 1;
    let high = 63;
    let reached = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (ms >= edges[mid]!) {
        reached = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return reached;
  }
  function recordOrder(left: MonitorPerformanceRecord, right: MonitorPerformanceRecord): number {
    return (
      ordinal(left.day, right.day) ||
      sourceOrder(left.source, right.source) ||
      utf8Order(left.model, right.model)
    );
  }
  function createRecorder(dayOf: (ms: number) => string | null): MonitorPerformanceRecorder {
    const byDay = new Map<string, Map<string, Map<string, MonitorPerformanceRecord>>>();
    const records: MonitorPerformanceRecord[] = [];
    const coverage = new Map<string, Map<string, number>>();
    function record(day: string, source: string, model: string): MonitorPerformanceRecord {
      let daySources = byDay.get(day);
      if (!daySources) {
        daySources = new Map();
        byDay.set(day, daySources);
      }
      let models = daySources.get(source);
      if (!models) {
        models = new Map();
        daySources.set(source, models);
      }
      let held = models.get(model);
      if (!held) {
        held = { day, source, model, ...emptySums() };
        models.set(model, held);
        records.push(held);
      }
      return held;
    }
    function active(
      agentId: string,
      rec: MonitorPerformanceRecord,
      start: number,
      end: number,
    ): void {
      let models = coverage.get(agentId);
      if (!models) {
        models = new Map();
        coverage.set(agentId, models);
      }
      const covered = models.get(rec.model);
      const added = Math.max(0, end - (covered === undefined ? start : Math.max(start, covered)));
      models.set(rec.model, covered === undefined ? end : Math.max(covered, end));
      rec.activeMs += added;
    }
    function response(agentId: string, source: string, value: MonitorPerformanceResponse): void {
      const start = measuredStart(value);
      if (start === null) return;
      const day = dayOf(value.endMs);
      if (day === null) return;
      const rec = record(day, source, value.model || "");
      const duration = value.endMs - start;
      rec.n++;
      rec.outputSum += value.output;
      rec.durationMsSum += duration;
      const latency = latencyOf(value);
      if (latency !== null) rec.latencyBins[latencyBin(latency)]!++;
      const reasoning = Math.min(value.reasoning ?? 0, value.output);
      if (source !== "deepseek" && reasoning > 0) {
        rec.reasonN++;
        rec.reasonOutput += reasoning;
        rec.reasonDurationMsSum += duration;
      }
      if (source !== "hermes" && value.input > 0) {
        rec.cacheN++;
        rec.cacheInput += value.input;
        rec.cacheCached += value.cachedInput;
      }
      active(agentId, rec, start, value.endMs);
    }
    function action(agentId: string, source: string, value: MonitorPerformanceAction): void {
      const end = value.resultMs;
      if (end == null) return;
      const duration = end - value.callMs;
      if (duration < 0 || duration > 900_000) return;
      const day = dayOf(end);
      if (day === null) return;
      const rec = record(day, source, value.model || "");
      rec.toolN++;
      rec.toolLnSum = rec.toolLnSum + Math.log(Math.max(duration, 50));
      if (value.failed === true) rec.toolFailed++;
      active(agentId, rec, value.callMs, end);
    }
    function rows(): MonitorPerformanceRecord[] {
      const result: MonitorPerformanceRecord[] = [];
      for (const value of records)
        result.push({ ...value, latencyBins: value.latencyBins.slice() });
      result.sort(recordOrder);
      return result;
    }
    return { response, action, rows };
  }
  return { evaluate, highest, pool, baseline, range, createRecorder };
}

const performanceModel = createPerformanceModel(highestPerformanceValue);
export const evaluatePerformance = performanceModel.evaluate;
export const poolPerformance = performanceModel.pool;
export const performanceBaseline = performanceModel.baseline;
export const performanceRange = performanceModel.range;
export const createPerformanceRecorder = performanceModel.createRecorder;
/** Expression only: no eval, network, imports or Node globals inside the resulting model. */
export const PERFORMANCE_MODEL_SCRIPT = `(${createPerformanceModel.toString()})(${highestPerformanceValue.toString()})`;
