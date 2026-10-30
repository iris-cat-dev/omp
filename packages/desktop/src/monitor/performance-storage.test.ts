import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OmpPerformanceStorage, PERFORMANCE_CACHE_NAME } from "./performance-storage.js";
import type { MonitorPerformanceRecord } from "./performance-types.js";
import { calendarDays } from "./math.js";

const NOW = new Date(2026, 9, 30, 12).getTime(),
  directories: string[] = [],
  stores: OmpPerformanceStorage[] = [];
async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-performance-cache-")));
  directories.push(root);
  return root;
}
function storage(root: string): OmpPerformanceStorage {
  const store = new OmpPerformanceStorage(root);
  stores.push(store);
  return store;
}
function record(day = calendarDays(NOW).at(-1)!.date): MonitorPerformanceRecord {
  return {
    agentId: "0123456789abcdef0123456789abcdef",
    day,
    source: "omp",
    model: "raw-model",
    n: 3,
    outputSum: 150,
    durationMsSum: 3000,
    latencyBins: Array.from({ length: 64 }, () => 0),
    reasonN: 0,
    reasonOutput: 0,
    reasonDurationMsSum: 0,
    cacheN: 3,
    cacheInput: 300,
    cacheCached: 270,
    toolN: 0,
    toolLnSum: 0,
    toolFailed: 0,
    activeMs: 3000,
  };
}
function envelope(records: unknown[]): string {
  return JSON.stringify({ schema: "omp-performance-v160", version: 1, records });
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose();
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("v1.6 numeric-only cache boundary", () => {
  it("whitelists cached fields and only reuses exact freshly read numeric records", async () => {
    const root = await directory(),
      expected = record();
    await writeFile(
      path.join(root, PERFORMANCE_CACHE_NAME),
      envelope([{ ...expected, text: "PRIVATE PROMPT", path: "C:\\PRIVATE" }]),
    );
    const store = storage(root);
    await store.load(NOW);
    const fresh = [expected],
      reused = store.reuse(expected.agentId!, fresh);
    expect(store.limited).toBe(false);
    expect(reused).toEqual(fresh);
    expect(JSON.stringify(reused)).not.toMatch(/PRIVATE|text|path/);
    const corrected = [{ ...expected, outputSum: 200 }];
    expect(store.reuse(expected.agentId!, corrected)[0]?.outputSum).toBe(200);
  });

  it.each([
    { source: "other-app" },
    { model: "C:\\PRIVATE\\model" },
    { agentId: "/PRIVATE/path" },
    { n: -1 },
    { n: 0.5 },
    { toolLnSum: Infinity },
    { cacheCached: 301 },
    { reasonN: 4 },
    { latencyBins: [1, 2, 3] },
    { latencyBins: Array.from({ length: 64 }, () => 1) },
  ])("rejects invalid or privacy-unsafe cached sums %j", async (changed) => {
    const root = await directory();
    await writeFile(
      path.join(root, PERFORMANCE_CACHE_NAME),
      envelope([{ ...record(), ...changed }]),
    );
    const store = storage(root);
    await store.load(NOW);
    expect(store.limited).toBe(true);
    const freshlyRead = [record()];
    expect(store.reuse(freshlyRead[0]!.agentId!, freshlyRead)).toBe(freshlyRead);
  });

  it("never interprets the legacy task schema, including when renamed to the new cache filename", async () => {
    const root = await directory();
    await writeFile(
      path.join(root, PERFORMANCE_CACHE_NAME),
      JSON.stringify({ version: 1, records: [{ ...record(), score: 100, state: "passing" }] }),
    );
    const store = storage(root);
    await store.load(NOW);
    expect(store.limited).toBe(true);
    const freshlyRead = [record()];
    expect(store.reuse(freshlyRead[0]!.agentId!, freshlyRead)).toBe(freshlyRead);
  });

  it("persists exactly the retained 30 local dates and does not publish an aborted save", async () => {
    const root = await directory(),
      dates = calendarDays(NOW),
      expired = new Date(dates[0]!.start),
      future = new Date(NOW);
    expired.setDate(expired.getDate() - 1);
    future.setDate(future.getDate() + 1);
    const before = calendarDays(expired.getTime()).at(-1)!.date,
      after = calendarDays(future.getTime()).at(-1)!.date,
      store = storage(root),
      retained = [record(dates[0]!.date), record(dates.at(-1)!.date)];
    await store.save([record(before), ...retained, record(after)], NOW, () => true);
    const text = await readFile(path.join(root, PERFORMANCE_CACHE_NAME), "utf8");
    expect(JSON.parse(text).records).toEqual(retained);
    await store.save([{ ...record(), outputSum: 999 }], NOW, () => false);
    expect(await readFile(path.join(root, PERFORMANCE_CACHE_NAME), "utf8")).toBe(text);
    store.dispose();
    await store.save([], NOW, () => true);
    expect(await readFile(path.join(root, PERFORMANCE_CACHE_NAME), "utf8")).toBe(text);
  });
});
