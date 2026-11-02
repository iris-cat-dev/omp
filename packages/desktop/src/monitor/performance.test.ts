// Agent Speed v1.6.0 (MIT), ca460d7f899e7adc73391ea706b729f1fc481fde.
// Complete upstream golden numeric vectors, exercised through both Node and the isolated browser model.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  createPerformanceRecorder,
  evaluatePerformance,
  highestPerformanceValue,
  PERFORMANCE_MODEL_SCRIPT,
  performanceBaseline,
  performanceRange,
  poolPerformance,
  type MonitorPerformanceModel,
} from "./performance.js";
import type {
  MonitorPerformanceAction,
  MonitorPerformanceAgent,
  MonitorPerformanceEvaluation,
  MonitorPerformancePooled,
  MonitorPerformanceRangeRow,
  MonitorPerformanceRecord,
  MonitorPerformanceResponse,
  MonitorPerformanceSetValue,
  MonitorPerformanceSums,
} from "./performance-types.js";

interface GoldenAgentQuery {
  nowMs: number;
  expect: Record<string, MonitorPerformanceEvaluation>;
}
interface GoldenAgentCase {
  name: string;
  agents: MonitorPerformanceAgent[];
  responses: MonitorPerformanceResponse[];
  actions?: Record<string, MonitorPerformanceAction[]>;
  history?: MonitorPerformanceRecord[];
  today?: string;
  queries: GoldenAgentQuery[];
}
interface GoldenSetGroup extends MonitorPerformanceSetValue {
  members: string[];
}
interface GoldenSetCase {
  name: string;
  agents: MonitorPerformanceAgent[];
  values: Record<string, Pick<MonitorPerformanceEvaluation, "form" | "score">>;
  expect: { all: MonitorPerformanceSetValue; groups: Record<string, GoldenSetGroup> };
}
interface GoldenCompletion {
  response?: MonitorPerformanceResponse;
  action?: MonitorPerformanceAction;
}
interface GoldenDayCase {
  name: string;
  agents: Array<{ id: string; source: string; events: GoldenCompletion[] }>;
  expect: MonitorPerformanceRecord[];
}
interface GoldenPooledCase {
  name: string;
  source: string;
  records: MonitorPerformanceSums[];
  expect: MonitorPerformancePooled;
}
interface GoldenBaselineCase {
  name: string;
  source: string;
  model: string;
  today: string;
  records: MonitorPerformanceRecord[];
  expect: number | null;
}
interface GoldenRangeCase {
  name: string;
  first: string;
  last: string;
  source?: string;
  records: MonitorPerformanceRecord[];
  expect: MonitorPerformanceRangeRow[];
}
interface GoldenFixture {
  edges: number[];
  latencyBins: Array<{ ms: number; expect: number }>;
  agents: GoldenAgentCase[];
  sets: GoldenSetCase[];
  days: GoldenDayCase[];
  pooled: GoldenPooledCase[];
  baseline: GoldenBaselineCase[];
  range: GoldenRangeCase[];
}
const golden = JSON.parse(
  readFileSync(new URL("../../test-fixtures/perf-score-cases.json", import.meta.url), "utf8"),
) as GoldenFixture;

/** The upstream comparison: exact structure, numeric tolerance 1e-9 relative above 1. */
function assertGolden(actual: unknown, expected: unknown, at = "value"): void {
  if (typeof expected === "number") {
    expect(typeof actual, at).toBe("number");
    const number = actual as number;
    const tolerance = 1e-9 * Math.max(1, Math.abs(number), Math.abs(expected));
    expect(Math.abs(number - expected), at).toBeLessThanOrEqual(tolerance);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), at).toBe(true);
    const items = actual as unknown[];
    expect(items.length, at).toBe(expected.length);
    for (let index = 0; index < expected.length; index++) {
      assertGolden(items[index], expected[index], `${at}[${index}]`);
    }
    return;
  }
  if (expected !== null && typeof expected === "object") {
    expect(actual !== null && typeof actual === "object" && !Array.isArray(actual), at).toBe(true);
    const fields = actual as Record<string, unknown>;
    const wanted = expected as Record<string, unknown>;
    expect(Object.keys(fields).sort(), at).toEqual(Object.keys(wanted).sort());
    for (const key of Object.keys(wanted)) assertGolden(fields[key], wanted[key], `${at}.${key}`);
    return;
  }
  expect(actual, at).toBe(expected);
}
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function response(overrides: Partial<MonitorPerformanceResponse> = {}): MonitorPerformanceResponse {
  return {
    key: "response",
    model: "m",
    startMs: 0,
    endMs: 1000,
    input: 0,
    cachedInput: 0,
    output: 50,
    ...overrides,
  };
}
function batch(count: number, output = 50): MonitorPerformanceResponse[] {
  return Array.from({ length: count }, (_, index) =>
    response({
      key: `r${index}`,
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      output,
    }),
  );
}
function agent(overrides: Partial<MonitorPerformanceAgent> = {}): MonitorPerformanceAgent {
  return { id: "a", source: "omp", phase: "generating", ...overrides };
}
function bucket(model: MonitorPerformanceModel, ms: number): number {
  const recorder = model.createRecorder(utcDay);
  recorder.response("latency", "codex", response({ firstMs: ms }));
  const bins = recorder.rows()[0]!.latencyBins;
  expect(bins.reduce((sum, count) => sum + count, 0)).toBe(1);
  return bins.findIndex((count) => count === 1);
}
function setGroups(agents: readonly MonitorPerformanceAgent[]): Record<string, string[]> {
  const ids = new Set(agents.map((value) => value.id));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const value of agents) {
    if (value.parentId && value.parentId !== value.id && ids.has(value.parentId)) {
      const siblings = children.get(value.parentId) ?? [];
      siblings.push(value.id);
      children.set(value.parentId, siblings);
    } else {
      roots.push(value.id);
    }
  }
  const result: Record<string, string[]> = {};
  for (const root of roots) {
    const pending = [root];
    const members: string[] = [];
    while (pending.length > 0) {
      const current = pending.pop()!;
      members.push(current);
      const subs = children.get(current) ?? [];
      for (let index = subs.length - 1; index >= 0; index--) pending.push(subs[index]!);
    }
    result[root] = members;
  }
  return result;
}
function setValues(
  model: MonitorPerformanceModel,
  fixture: GoldenSetCase,
): GoldenSetCase["expect"] {
  const groups: Record<string, GoldenSetGroup> = {};
  for (const [root, members] of Object.entries(setGroups(fixture.agents))) {
    const own = fixture.agents.filter((value) => members.includes(value.id));
    groups[root] = { members, ...model.highest(own, fixture.values) };
  }
  return { all: model.highest(fixture.agents, fixture.values), groups };
}
function dayRecords(
  model: MonitorPerformanceModel,
  fixture: GoldenDayCase,
): MonitorPerformanceRecord[] {
  const recorder = model.createRecorder(utcDay);
  for (const owner of fixture.agents) {
    for (const event of owner.events) {
      if (event.response) recorder.response(owner.id, owner.source, event.response);
      else recorder.action(owner.id, owner.source, event.action!);
    }
  }
  return recorder.rows();
}
function agentValues(
  model: MonitorPerformanceModel,
  fixture: GoldenAgentCase,
  query: GoldenAgentQuery,
): Record<string, MonitorPerformanceEvaluation> {
  const values: Record<string, MonitorPerformanceEvaluation> = {};
  for (const owner of fixture.agents) {
    values[owner.id] = model.evaluate(
      owner,
      fixture.responses.filter((value) => value.agentId === owner.id),
      fixture.actions?.[owner.id] ?? [],
      query.nowMs,
      fixture.history,
      fixture.today,
    );
  }
  return values;
}
function registerGoldenTests(model: MonitorPerformanceModel): void {
  it.each(golden.latencyBins)("latency bucket at $ms ms", (fixture) => {
    expect(bucket(model, fixture.ms)).toBe(fixture.expect);
  });
  it("buckets every integer edge from E0 through E64 without floating-point ceilings", () => {
    expect(golden.edges).toHaveLength(65);
    golden.edges.forEach((edge, index) => {
      expect(bucket(model, edge)).toBe(Math.min(63, index));
      expect(bucket(model, edge - 1)).toBe(Math.min(63, Math.max(0, index - 1)));
    });
  });
  it.each(golden.agents)("agent golden: $name", (fixture) => {
    for (const query of fixture.queries)
      assertGolden(agentValues(model, fixture, query), query.expect);
  });
  it.each(golden.sets)("set and group golden: $name", (fixture) => {
    assertGolden(setValues(model, fixture), fixture.expect);
  });
  it.each(golden.days)("day records golden: $name", (fixture) => {
    assertGolden(dayRecords(model, fixture), fixture.expect);
  });
  it.each(golden.pooled)("pooled golden: $name", (fixture) => {
    assertGolden(model.pool(fixture.records, fixture.source), fixture.expect);
  });
  it.each(golden.baseline)("baseline golden: $name", (fixture) => {
    assertGolden(
      model.baseline(fixture.records, fixture.source, fixture.model, fixture.today),
      fixture.expect,
    );
  });
  it.each(golden.range)("range golden: $name", (fixture) => {
    assertGolden(
      model.range(fixture.records, fixture.first, fixture.last, fixture.source),
      fixture.expect,
    );
  });
}
function registerSampleTests(model: MonitorPerformanceModel): void {
  it("uses final valid intervals, a 500 ms floor, and original rather than floored latency starts", () => {
    const responses = [
      response({ key: "zero", startMs: 1000, endMs: 1000, output: 25 }),
      response({ key: "short", startMs: 1500, endMs: 1999, output: 25 }),
      response({ key: "floor", startMs: 2000, endMs: 2500, output: 25 }),
      response({ key: "missing", startMs: null }),
      response({ key: "reversed", startMs: 1001, endMs: 1000 }),
      response({ key: "long", startMs: -900001, endMs: 0 }),
      response({ key: "partial", final: false }),
      response({ key: "future", endMs: 2501 }),
    ];
    const value = model.evaluate(agent(), responses, [], 2500);
    expect(value.n).toBe(3);
    expect(value.spanStartMs).toBe(500);
    expect(value.activeMs).toBe(1500);
    assertGolden(value.score, 1000);
    const short = batch(3).map((timedResponse) =>
      response({
        startMs: timedResponse.endMs,
        endMs: timedResponse.endMs,
        firstMs: timedResponse.endMs,
      }),
    );
    const latency = model.evaluate(agent({ source: "codex" }), short, [], 3000).components[1]!;
    expect(latency.measure).toBe(0);
    expect(latency.ratio).toBe(20);
  });
  it.each([2, 3, 9, 10, 20, 21])(
    "requires three and marks provisional only below ten (n=%i)",
    (count) => {
      const value = model.evaluate(agent(), batch(count), [], 30_000);
      expect(value.n).toBe(Math.min(20, count));
      expect(value.form).toBe(count < 3 ? "none" : "live");
      expect(value.provisional).toBe(count >= 3 && count < 10);
      if (count < 3) {
        expect(value.score).toBeNull();
        expect(value.components.every((component) => !component.present)).toBe(true);
      } else {
        assertGolden(value.score, 1000);
      }
    },
  );
  it("has an uncapped throughput component and renormalizes missing weights instead of punishing them", () => {
    const normal = model.evaluate(agent(), batch(3), [], 3000);
    const doubled = model.evaluate(agent(), batch(3, 100), [], 3000);
    const veryFast = model.evaluate(agent(), batch(3, 1_000_000), [], 3000);
    const zero = model.evaluate(agent(), batch(3, 0), [], 3000);
    expect(normal.components.map((value) => value.id)).toEqual(["T", "L", "N", "R", "H", "U", "S"]);
    expect(normal.components.filter((value) => value.present).map((value) => value.id)).toEqual([
      "T",
    ]);
    assertGolden(doubled.score, normal.score! * 2);
    assertGolden(veryFast.score, 20_000_000);
    expect(veryFast.components[0]!.ratio).toBe(20_000);
    assertGolden(zero.score, 10);
  });
  it("uses UTF-16 key order at the sample boundary, not Unicode scalar or locale order", () => {
    const responses = Array.from({ length: 19 }, (_, index) => response({ key: `A${index}` }));
    responses.push(
      response({ key: "\uE000", output: 9000 }),
      response({ key: "😀", output: 1000 }),
    );
    const value = model.evaluate(agent(), responses, [], 1000);
    expect(value.n).toBe(20);
    expect(value.components[0]!.measure).toBe(97.5);
    assertGolden(value.score, 1950);
  });
  it("uses inclusive 30-minute and staleness boundaries and does not decay a resting score", () => {
    const responses = batch(3);
    const owner = agent({ lastLineMs: 3000 });
    const live = model.evaluate(owner, responses, [], 303000);
    const resting = model.evaluate(owner, responses, [], 303001);
    expect(live.form).toBe("live");
    expect(resting.form).toBe("resting");
    expect(resting.score).toBe(live.score);
    expect(model.evaluate(owner, responses, [], 1_801_000).n).toBe(3);
    expect(model.evaluate(owner, responses, [], 1_801_001).n).toBe(2);
  });
}
function registerCallTests(model: MonitorPerformanceModel): void {
  it("caps stored calls before filtering, accepts zero duration, and treats unknown failure as not failed", () => {
    const actions = Array.from({ length: 65 }, (_, index) => ({
      callMs: 100,
      resultMs: index === 64 ? null : 100,
      failed: index === 1 ? true : null,
    }));
    const value = model.evaluate(agent(), batch(3), actions, 3000);
    expect(value.tools).toBe(63);
    expect(value.activeMs).toBe(3000);
    assertGolden(value.components[5]!.measure, 50);
    assertGolden(value.components[6]!.measure, 1 - 1 / 63);
  });
  it("accepts the exact 15-minute tool limit and rejects outside-span, future, negative and missing results", () => {
    const actions: MonitorPerformanceAction[] = [
      { callMs: 0, resultMs: 900000 },
      { callMs: 1, resultMs: 900001 },
      { callMs: 2, resultMs: 900002 },
      { callMs: 0, resultMs: 900001 },
      { callMs: -1, resultMs: 0 },
      { callMs: 999999, resultMs: 1000001 },
      { callMs: 2, resultMs: 1 },
      { callMs: 0, resultMs: null },
    ];
    const value = model.evaluate(agent(), batch(3), actions, 1_000_000);
    expect(value.tools).toBe(3);
    expect(value.activeMs).toBe(900002);
  });
  it("uses exact interval union live but the original online union for completion history", () => {
    const responses = [
      response({ key: "A", startMs: 0, endMs: 1000 }),
      response({ key: "B", startMs: 2000, endMs: 3000 }),
      response({ key: "C", startMs: 500, endMs: 3500 }),
    ];
    const recorder = model.createRecorder(utcDay);
    for (const value of responses) recorder.response("a", "omp", value);
    expect(recorder.rows()[0]!.activeMs).toBe(2500);
    const live = model.evaluate(agent(), responses, [{ callMs: 700, resultMs: 2700 }], 3500);
    expect(live.activeMs).toBe(3500);
    expect(live.tools).toBe(1);
  });
}
function registerSetTests(model: MonitorPerformanceModel): void {
  it("chooses unrounded scores first, then latest time, then ordinal id, with native timestamps accepted", () => {
    const values: GoldenSetCase["values"] = {
      "😀": { form: "live", score: 1000.49 },
      "\uE000": { form: "live", score: 1000.49 },
      newer: { form: "live", score: 1000.48 },
      resting: { form: "resting", score: 1_000_000 },
    };
    const members = [
      { id: "\uE000", lastActivityAt: 10 },
      { id: "😀", lastActivityAt: 10 },
      { id: "newer", lastActivityAt: 20 },
      { id: "resting", lastActivityAt: 30 },
    ];
    expect(model.highest(members, values)).toEqual({
      form: "live",
      score: 1000.49,
      shown: 1000,
      agent: "😀",
    });
    expect(
      model.highest([{ id: "😀", lastLineMs: 5, lastActivityAt: 100 }, members[0]!], values).agent,
    ).toBe("\uE000");
    expect(model.highest([], values)).toEqual({
      form: "none",
      score: null,
      shown: null,
      agent: null,
    });
    expect(model.highest([{ id: "missing" }], values).form).toBe("none");
  });
}
function registerHistoryTests(model: MonitorPerformanceModel): void {
  it("uses injectable civil-day labels, assigns whole intervals to completion day, and excludes missing dates", () => {
    const end = Date.parse("2026-10-29T23:59:59.000Z");
    const utc = model.createRecorder(utcDay);
    const local = model.createRecorder((ms) => utcDay(ms + 2 * 3_600_000));
    const value = response({ startMs: end - 2000, endMs: end });
    utc.response("a", "omp", value);
    local.response("a", "omp", value);
    expect(utc.rows()[0]!.day).toBe("2026-10-29");
    expect(local.rows()[0]!.day).toBe("2026-10-30");
    expect(local.rows()[0]!.activeMs).toBe(2000);
    const missing = model.createRecorder((ms) => (ms === 5000 ? null : "1970-01-01"));
    missing.response("a", "omp", response({ endMs: 5000 }));
    missing.action("a", "omp", { callMs: 0, resultMs: 5000 });
    missing.response("a", "omp", response());
    expect(missing.rows()[0]!.n).toBe(1);
    expect(missing.rows()[0]!.toolN).toBe(0);
    expect(missing.rows()[0]!.activeMs).toBe(1000);
  });
  it("keeps coverage independent per agent/model, has no 64-call history cap, and returns isolated row snapshots", () => {
    const recorder = model.createRecorder(utcDay);
    recorder.response("a", "omp", response());
    recorder.response("b", "omp", response());
    recorder.response("a", "omp", response({ model: "other" }));
    for (let index = 0; index < 65; index++) {
      recorder.action("a", "omp", { callMs: 1000, resultMs: 1050, model: "m" });
    }
    const rows = recorder.rows();
    const main = rows.find((value) => value.model === "m")!;
    expect(main.n).toBe(2);
    expect(main.toolN).toBe(65);
    expect(main.activeMs).toBe(2050);
    expect(rows.find((value) => value.model === "other")!.activeMs).toBe(1000);
    main.n = 999;
    main.latencyBins[0] = 999;
    const again = recorder.rows().find((value) => value.model === "m")!;
    expect(again.n).toBe(2);
    expect(again.latencyBins[0]).toBe(0);
  });
  it("orders history models by UTF-8 rather than the live sample's UTF-16 tie order", () => {
    const recorder = model.createRecorder(utcDay);
    for (const modelName of ["😀", "\uE000"]) {
      for (const value of batch(20)) recorder.response("a", "omp", { ...value, model: modelName });
    }
    const rows = recorder.rows();
    expect(rows.map((value) => value.model)).toEqual(["\uE000", "😀"]);
    const range = model.range(rows, "1970-01-01", "1970-01-03");
    expect(range.map((value) => value.model)).toEqual(["\uE000", "😀"]);
    for (const row of range) {
      assertGolden(row.score, 1000);
      expect(row.trend).toEqual([
        { day: "1970-01-01", score: row.score },
        { day: "1970-01-02", score: null },
        { day: "1970-01-03", score: null },
      ]);
    }
  });
  it("sums records additively before scoring and keeps the 20-response threshold distinct from presence", () => {
    const recorder = model.createRecorder(utcDay);
    const values = batch(20);
    for (const value of values) recorder.response("a", "omp", value);
    const full = model.pool(recorder.rows(), "omp");
    const part = model.createRecorder(utcDay);
    for (const value of values.slice(0, 19)) part.response("a", "omp", value);
    const below = model.pool(part.rows(), "omp");
    expect(below.score).toBeNull();
    expect(below.components[0]!.present).toBe(true);
    const last = model.createRecorder(utcDay);
    last.response("b", "omp", values[19]!);
    const split = model.pool([...part.rows(), ...last.rows()], "omp");
    assertGolden(split, full);
    expect(model.range(recorder.rows(), "1970-01-02", "1970-01-01")).toEqual([]);
    expect(model.baseline(recorder.rows(), "omp", "m", "invalid")).toBeNull();
  });
  it("shows a small negative comparison as positive zero, as Python's integer rounding does", () => {
    const recorder = model.createRecorder(utcDay);
    for (const value of batch(20)) recorder.response("a", "omp", value);
    const value = model.evaluate(agent(), batch(3, 49.9), [], 3000, recorder.rows(), "1970-01-02");
    expect(value.vsUsual).toBeLessThan(0);
    expect(value.vsUsualPercent).toBe(0);
    expect(Object.is(value.vsUsualPercent, -0)).toBe(false);
  });
  it("uses exactly the prior 14 local dates, never today's data, across month and DST boundaries", () => {
    const recorder = model.createRecorder(utcDay);
    for (const value of batch(20)) recorder.response("a", "omp", value);
    const record = recorder.rows()[0]!;
    const records = [
      { ...record, day: "2026-10-18", n: 1 },
      { ...record, day: "2026-10-31", n: 19 },
      { ...record, day: "2026-10-17", outputSum: 1_000_000_000 },
      { ...record, day: "2026-11-01", outputSum: 1_000_000_000 },
      { ...record, day: "2026-10-25", model: "another", outputSum: 1_000_000_000 },
    ];
    assertGolden(model.baseline(records, "omp", "m", "2026-11-01"), 1000);
    expect(model.baseline([records[1]!], "omp", "m", "2026-11-01")).toBeNull();
  });
}
const nodeModel: MonitorPerformanceModel = {
  evaluate: evaluatePerformance,
  highest: highestPerformanceValue,
  pool: poolPerformance,
  baseline: performanceBaseline,
  range: performanceRange,
  createRecorder: createPerformanceRecorder,
};
const sandboxModel = runInNewContext(
  PERFORMANCE_MODEL_SCRIPT,
  {},
  {
    contextCodeGeneration: { strings: false, wasm: false },
  },
) as MonitorPerformanceModel;
for (const [name, model] of [
  ["Node", nodeModel],
  ["isolated browser", sandboxModel],
] as const) {
  describe(`Agent Speed v1.6 performance — ${name}`, () => {
    registerGoldenTests(model);
    registerSampleTests(model);
    registerCallTests(model);
    registerSetTests(model);
    registerHistoryTests(model);
  });
}
it("embeds the standalone highest function without any imported closure", () => {
  const highest = runInNewContext(
    `(${highestPerformanceValue.toString()})`,
    {},
    {
      contextCodeGeneration: { strings: false, wasm: false },
    },
  ) as MonitorPerformanceModel["highest"];
  for (const fixture of golden.sets)
    assertGolden(highest(fixture.agents, fixture.values), fixture.expect.all);
});
