import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OmpPerformanceMonitor, PERFORMANCE_MONITOR_LIMITS } from "./performance-monitor.js";
import { performanceFileIdentity, PERFORMANCE_FILE_LIMITS } from "./performance-reader-file.js";
import type { OmpPerformanceSource } from "./performance-reader-file.js";
import { PERFORMANCE_READER_LIMITS } from "./performance-reader.js";
import { PERFORMANCE_CACHE_NAME } from "./performance-storage.js";
import { calendarDays } from "./math.js";
import { hashId } from "./parser.js";
import { poolPerformance } from "./performance.js";
import { OmpLocalMonitor } from "./collector.js";

const NOW = new Date(2026, 9, 30, 12).getTime(),
  START = NOW - 10 * 60_000;
const directories: string[] = [],
  monitors: OmpPerformanceMonitor[] = [];
const monitorLimits = { ...PERFORMANCE_MONITOR_LIMITS },
  fileLimits = { ...PERFORMANCE_FILE_LIMITS },
  readerLimits = { ...PERFORMANCE_READER_LIMITS };
async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-performance-")));
  directories.push(root);
  return root;
}
function monitor(cacheDir?: string): OmpPerformanceMonitor {
  const instance = new OmpPerformanceMonitor({ cacheDir });
  monitors.push(instance);
  return instance;
}
function header(atMs = START - 1000): string {
  return JSON.stringify({
    type: "session",
    id: "fictional-session",
    version: 3,
    timestamp: new Date(atMs).toISOString(),
    cwd: "C:\\PRIVATE\\WORKSPACE",
  });
}
function line(id: string, atMs: number, message: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", id, timestamp: new Date(atMs).toISOString(), message });
}
function response(id: string, start: number, extra: Record<string, unknown> = {}): string {
  return line(id, start + 1000, {
    role: "assistant",
    timestamp: start,
    duration: 1000,
    stopReason: "stop",
    model: "raw-model",
    provider: "fixture",
    api: "fixture",
    usage: { input: 10, output: 50, cacheRead: 90 },
    content: [{ type: "text", text: "PRIVATE PROMPT AND OUTPUT" }],
    ...extra,
  });
}
function sample(prefix = "response", start = START, count = 3): string[] {
  return Array.from({ length: count }, (_, index) =>
    response(`${prefix}-${index}`, start + index * 3000),
  );
}
function jsonl(...lines: string[]): string {
  return lines.join("\n") + "\n";
}
async function source(
  root: string,
  id: string,
  text: string,
  phase: OmpPerformanceSource["phase"] = "idle",
): Promise<OmpPerformanceSource> {
  const file = path.join(root, `${id}.jsonl`);
  await writeFile(file, text);
  return { id, path: file, phase };
}
async function drain(instance: OmpPerformanceMonitor, sources: OmpPerformanceSource[], now = NOW) {
  const ids = new Set(sources.map((item) => item.id));
  for (let poll = 0; poll < 2048; poll++) {
    await instance.poll(sources, now);
    const snapshot = instance.getSnapshot(ids, now);
    if (!snapshot.scanning) return snapshot;
  }
  throw new Error("Performance fixture did not exhaust its finite read budgets");
}
afterEach(async () => {
  for (const instance of monitors.splice(0)) instance.dispose();
  Object.assign(PERFORMANCE_MONITOR_LIMITS, monitorLimits);
  Object.assign(PERFORMANCE_FILE_LIMITS, fileLimits);
  Object.assign(PERFORMANCE_READER_LIMITS, readerLimits);
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ordered native OMP v1.6 performance monitor", () => {
  it("matches the pinned original v1.6 main and ScanCallSites numeric facts through the real OMP collector", async () => {
    const root = await directory(),
      bucket = path.join(root, "bucket"),
      mainBytes = await readFile(
        new URL("../../test-fixtures/omp-performance-v160/main.jsonl", import.meta.url),
      ),
      childBytes = await readFile(
        new URL("../../test-fixtures/omp-performance-v160/ScanCallSites.jsonl", import.meta.url),
      );
    expect(
      [mainBytes, childBytes].map((bytes) => createHash("sha256").update(bytes).digest("hex")),
    ).toEqual([
      "99a982da3b6f17bedf732e5103e8a7630b76ed1eeeed301ae18a95486809cbee",
      "1cbcdcfb7f7d9e0b08d8eeac45b9b860b3563d248d3c42b218359cd7403921f1",
    ]);
    await mkdir(path.join(bucket, "main"), { recursive: true });
    await writeFile(path.join(bucket, "main.jsonl"), mainBytes);
    await writeFile(path.join(bucket, "main", "ScanCallSites.jsonl"), childBytes);
    const fixtureNow = Date.parse("2026-10-20T10:58:20.000Z"),
      collector = new OmpLocalMonitor({
        roots: [{ path: root, label: "default" }],
        now: () => fixtureNow,
      });
    try {
      let snapshot = await collector.poll();
      for (let poll = 0; poll < 128 && snapshot.performance.scanning; poll++)
        snapshot = await collector.poll();
      expect(snapshot.today).toMatchObject({
        requests: 14,
        inputTokens: 947,
        outputTokens: 1865,
        reasoningTokens: 285,
        cacheReadTokens: 152900,
        cacheWriteTokens: 46100,
        measuredOutputTokens: 1780,
        measuredDurationMs: 38300,
      });
      const main = snapshot.performance.records.find((row) => row.model === "claude-opus-5-5"),
        child = snapshot.performance.records.find((row) => row.model === "claude-sonnet-5-5");
      // Hand-derived from upstream parser-expected.json; the child also matches its history-expected.json row.
      expect(main).toMatchObject({
        n: 7,
        outputSum: 1447,
        durationMsSum: 28300,
        reasonN: 3,
        reasonOutput: 260,
        reasonDurationMsSum: 13700,
        cacheN: 7,
        cacheInput: 132425,
        cacheCached: 93600,
        toolN: 5,
        toolFailed: 1,
        activeMs: 57952,
      });
      expect(child).toMatchObject({
        n: 4,
        outputSum: 333,
        durationMsSum: 10000,
        reasonN: 1,
        reasonOutput: 25,
        reasonDurationMsSum: 2200,
        cacheN: 4,
        cacheInput: 29015,
        cacheCached: 21700,
        toolN: 5,
        toolFailed: 1,
        activeMs: 26320,
      });
      expect(main?.toolLnSum).toBeCloseTo(34.639189507125934, 9);
      expect(child?.toolLnSum).toBeCloseTo(30.720995945033398, 9);
      expect(snapshot.performance.records).toHaveLength(2);
      for (const row of snapshot.performance.records)
        expect(row.latencyBins.every((count) => count === 0)).toBe(true);
      const evaluation = snapshot.performance.current[main!.agentId!],
        expected =
          1000 *
          Math.exp(
            (0.3 * Math.log(1447 / 28.3 / 50) +
              0.15 * Math.log(5 / (57.952 / 60) / 3) +
              0.1 * Math.log(260 / 13.7 / 20) +
              0.1 * Math.log(93600 / 132425 / 0.95) +
              0.1 * Math.log(400 / Math.exp(34.639189507125934 / 5)) +
              0.05 * Math.log(0.8 / 0.95)) /
              0.8,
          );
      expect(evaluation).toMatchObject({ n: 7, tools: 5, activeMs: 57952, provisional: true });
      expect(evaluation?.score).toBeCloseTo(expected, 9);
      expect(JSON.stringify(snapshot.performance)).not.toMatch(
        /src\/|arguments|command|thinkingSignature|parentSession|Users\/dev/,
      );
    } finally {
      collector.dispose();
    }
  });

  it("produces the original absolute score and additive per-day raw-model facts from numeric JSONL", async () => {
    const root = await directory(),
      lines = [header()];
    for (let index = 0; index < 3; index++) {
      const start = START + index * 3000;
      lines.push(
        response(`r-${index}`, start, {
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: `c-${index}`,
              name: "bash",
              arguments: { command: "PRIVATE COMMAND" },
            },
          ],
        }),
      );
      lines.push(
        line(`result-${index}`, start + 1400, {
          role: "toolResult",
          toolCallId: `c-${index}`,
          isError: index === 1,
          content: [{ type: "text", text: index === 1 ? "1 passed" : "999 failed" }],
          details: { exitCode: index === 1 ? 0 : 99 },
        }),
      );
    }
    const s = await source(root, "main", jsonl(...lines)),
      instance = monitor(),
      snapshot = await drain(instance, [s]);
    const expected =
      1000 *
      Math.exp(
        (0.15 * Math.log(100 / 7) + 0.1 * Math.log(0.9 / 0.95) + 0.05 * Math.log(2 / 3 / 0.95)) /
          0.7,
      );
    expect(snapshot.current.main).toMatchObject({
      form: "resting",
      provisional: true,
      n: 3,
      tools: 3,
      activeMs: 4200,
      model: "raw-model",
    });
    expect(snapshot.current.main?.score).toBeCloseTo(expected, 9);
    expect(
      snapshot.current.main?.components.find((component) => component.id === "L"),
    ).toMatchObject({ present: false, reason: "notRecorded" });
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      agentId: "main",
      source: "omp",
      model: "raw-model",
      n: 3,
      outputSum: 150,
      durationMsSum: 3000,
      cacheN: 3,
      cacheInput: 300,
      cacheCached: 270,
      toolN: 3,
      toolFailed: 1,
      activeMs: 4200,
    });
    expect(poolPerformance(snapshot.records, "omp").score).toBeNull();
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|arguments|command|exitCode|toolCallId/);
  });

  it("waits for JSONL finality, appends without double counting, and takes final revisions at the original completion position", async () => {
    const root = await directory(),
      body = jsonl(header(), ...sample()),
      s = await source(root, "main", body.slice(0, -1)),
      instance = monitor();
    await instance.poll([s], NOW);
    expect(instance.getSnapshot(new Set([s.id]), NOW)).toMatchObject({
      scanning: true,
      records: [],
      current: { main: { score: null } },
    });
    await appendFile(s.path, "\n");
    expect((await drain(instance, [s])).current.main?.n).toBe(3);
    await appendFile(s.path, jsonl(response("append", START + 20_000)));
    expect((await drain(instance, [s])).current.main?.n).toBe(4);
    await appendFile(
      s.path,
      jsonl(response("response-0", START, { usage: { input: 10, output: 150, cacheRead: 90 } })),
    );
    const revised = await drain(instance, [s]);
    expect(revised.current.main?.n).toBe(4);
    expect(revised.records[0]).toMatchObject({ n: 4, outputSum: 300, durationMsSum: 4000 });
    expect(instance.getSnapshot(new Set([s.id]), NOW + 1).records).toBe(revised.records);
  });

  it("preserves the 3/10 live boundaries, newest-20 cap, pooled-20 minimum and exact native staleness boundary", async () => {
    const root = await directory(),
      start = NOW - 70_000,
      s = await source(
        root,
        "main",
        jsonl(header(start - 1000), ...sample("boundary", start, 2)),
        "generating",
      ),
      instance = monitor();
    expect((await drain(instance, [s])).current.main).toMatchObject({
      n: 2,
      score: null,
      form: "none",
    });
    await appendFile(s.path, jsonl(response("boundary-2", start + 6000)));
    expect((await drain(instance, [s])).current.main).toMatchObject({
      n: 3,
      provisional: true,
      form: "live",
    });
    await appendFile(
      s.path,
      jsonl(
        ...Array.from({ length: 7 }, (_, index) =>
          response(`boundary-${index + 3}`, start + (index + 3) * 3000),
        ),
      ),
    );
    const ten = await drain(instance, [s]);
    expect(ten.current.main).toMatchObject({ n: 10, provisional: false, form: "live" });
    expect(poolPerformance(ten.records, "omp").score).toBeNull();
    await appendFile(
      s.path,
      jsonl(
        ...Array.from({ length: 11 }, (_, index) =>
          response(`boundary-${index + 10}`, start + (index + 10) * 3000),
        ),
      ),
    );
    const full = await drain(instance, [s]);
    expect(full.current.main).toMatchObject({ n: 20, provisional: false });
    expect(full.records[0]?.n).toBe(21);
    expect(poolPerformance(full.records, "omp").score).not.toBeNull();
    const lastLineMs = start + 61_000,
      staleAt = lastLineMs + 300_000;
    expect(instance.getSnapshot(new Set([s.id]), staleAt).current.main?.form).toBe("live");
    expect(instance.getSnapshot(new Set([s.id]), staleAt + 1).current.main?.form).toBe("resting");
    expect(instance.getSnapshot(new Set([s.id]), lastLineMs + 30 * 60_000).current.main?.form).toBe(
      "none",
    );
  });

  it("uses completion-order online union, not timestamp sorting or exact interval union", async () => {
    const root = await directory(),
      input = jsonl(
        header(),
        line("call", START, {
          role: "assistant",
          model: "raw-model",
          provider: "fixture",
          api: "fixture",
          usage: { input: 0, output: 0 },
          content: [{ type: "toolCall", id: "long", name: "fixture" }],
        }),
        response("one", START + 10_000, { duration: 10_000 }),
        response("two", START + 40_000, { duration: 10_000 }),
        line("result", START + 60_000, { role: "toolResult", toolCallId: "long" }),
        response("one", START + 10_000, {
          duration: 15_000,
          usage: { input: 10, output: 200, cacheRead: 90 },
        }),
      );
    const s = await source(root, "main", input),
      snapshot = await drain(monitor(), [s]);
    // The initial no-usage call has no agent model yet. Its coverage is separate from raw-model responses.
    expect(snapshot.records.find((row) => row.model === "raw-model")).toMatchObject({
      n: 2,
      outputSum: 250,
      durationMsSum: 25_000,
      activeMs: 25_000,
    });
    expect(snapshot.records.find((row) => row.model === "")).toMatchObject({
      toolN: 1,
      activeMs: 60_000,
    });
    // Give the call a model via a measured response before it, then retain the late closing interval's online gap.
    await writeFile(
      s.path,
      input.replace(
        header(),
        jsonl(header(), response("model-seed", START - 500, { duration: 0 })).trimEnd(),
      ),
    );
    const modeled = await drain(monitor(), [s]);
    expect(modeled.records).toHaveLength(1);
    expect(modeled.records[0]).toMatchObject({ n: 3, toolN: 1, activeMs: 35_500 });
  });

  it("keeps tool completion history uncapped but bounds the live action sample to 64 calls in file order", async () => {
    const root = await directory(),
      lines = [header(), ...sample("sample", START - 500)];
    for (let index = 0; index < 70; index++) {
      const atMs = START + 20_000 + index * 1000;
      lines.push(
        response(`call-${index}`, atMs - 1000, {
          usage: { input: 0, output: 0 },
          content: [{ type: "toolCall", id: `tool-${index}`, name: "fixture" }],
        }),
      );
      lines.push(
        line(`result-${index}`, atMs + 100, { role: "toolResult", toolCallId: `tool-${index}` }),
      );
    }
    const s = await source(root, "main", jsonl(...lines)),
      snapshot = await drain(monitor(), [s]);
    expect(snapshot.current.main).toMatchObject({ n: 3, tools: 64 });
    expect(snapshot.records[0]).toMatchObject({ n: 3, toolN: 70 });
  });

  it("invalidates middle rewrites plus append, rotations, deletion and parent-bound source identities", async () => {
    const root = await directory(),
      s = await source(root, "main", jsonl(header(), ...sample())),
      instance = monitor();
    expect((await drain(instance, [s])).records[0]?.outputSum).toBe(150);
    await writeFile(
      s.path,
      jsonl(
        header(),
        ...sample().map((entry) => entry.replace('"output":50', '"output":70')),
        response("next", START + 20_000),
      ),
    );
    expect((await drain(instance, [s])).records[0]).toMatchObject({ n: 4, outputSum: 260 });
    s.identity = performanceFileIdentity(await stat(s.path));
    await rename(s.path, `${s.path}.old`);
    await writeFile(s.path, jsonl(header(), ...sample("rotated")));
    expect(await drain(instance, [s])).toMatchObject({
      records: [],
      limited: true,
      current: { main: { score: null } },
    });
    s.identity = performanceFileIdentity(await stat(s.path));
    expect((await drain(instance, [s])).records[0]?.n).toBe(3);
    await rm(s.path);
    await instance.poll([s], NOW);
    expect(instance.getSnapshot(new Set([s.id]), NOW)).toMatchObject({
      records: [],
      limited: true,
      current: { main: { score: null } },
    });
    await instance.poll([], NOW);
    expect(instance.getSnapshot(new Set(), NOW)).toMatchObject({
      records: [],
      current: {},
      baselines: [],
      scanning: false,
    });
  });

  it("retains more than 256 source histories while evaluating only the explicitly requested visible card", async () => {
    const root = await directory(),
      sources: OmpPerformanceSource[] = [];
    for (let index = 0; index < 257; index++) {
      const id = `history-${index}`;
      sources.push(await source(root, id, jsonl(header(), ...sample(id))));
    }
    const instance = monitor(),
      ids = new Set(sources.map((item) => item.id)),
      currentIds = new Set([sources.at(-1)!.id]);
    for (let poll = 0; poll < 1024; poll++) {
      await instance.poll(sources, NOW);
      if (!instance.getSnapshot(ids, NOW, currentIds).scanning) break;
    }
    const snapshot = instance.getSnapshot(ids, NOW, currentIds);
    expect(snapshot).toMatchObject({ scanning: false, limited: false });
    expect(snapshot.records).toHaveLength(257);
    expect(snapshot.records.reduce((sum, row) => sum + row.n, 0)).toBe(771);
    expect(Object.keys(snapshot.current)).toEqual([...currentIds]);
    expect(snapshot.current[sources.at(-1)!.id]?.n).toBe(3);
  }, 30_000);

  it("preserves UTF-8 chunk, per-source byte/line budgets and an idle-history reservation", async () => {
    const root = await directory(),
      input = jsonl(
        header(),
        ...sample().map((entry) => entry.replace("PRIVATE PROMPT AND OUTPUT", "受控夹具 🚀")),
      ),
      idle = await source(root, "history", input),
      active: OmpPerformanceSource[] = [];
    for (let index = 0; index < 8; index++)
      active.push(
        await source(
          root,
          `active-${index}`,
          input.replaceAll("response-", `active-${index}-`),
          "generating",
        ),
      );
    PERFORMANCE_MONITOR_LIMITS.pollBytes = 4096;
    PERFORMANCE_MONITOR_LIMITS.fileBytes = 1024;
    PERFORMANCE_MONITOR_LIMITS.pollLines = 6;
    PERFORMANCE_MONITOR_LIMITS.fileLines = 2;
    PERFORMANCE_MONITOR_LIMITS.pollMs = 1000;
    PERFORMANCE_FILE_LIMITS.chunkBytes = 37;
    const instance = monitor(),
      sources = [...active, idle];
    await instance.poll(sources, NOW);
    await instance.poll(sources, NOW);
    const reserved = instance.getSnapshot(new Set(sources.map((item) => item.id)), NOW);
    expect(reserved.current.history?.n).toBe(3);
    expect(active.every((item) => reserved.current[item.id]?.n === 0)).toBe(true);
    const snapshot = await drain(instance, sources);
    expect(snapshot.records.reduce((sum, row) => sum + row.n, 0)).toBe(27);
    expect(snapshot.current.history?.n).toBe(3);
    expect(Object.values(snapshot.current).every((value) => value.n === 3)).toBe(true);
    expect(snapshot.limited).toBe(false);
  });

  it("keeps only 30 local dates, includes boundary-crossing measured intervals, and excludes future/unmeasured completions", async () => {
    const root = await directory(),
      floor = calendarDays(NOW)[0]!.start,
      s = await source(
        root,
        "main",
        jsonl(
          header(floor - 60_000),
          response("expired", floor - 40_000),
          response("overlap", floor - 20_000, { duration: 15_000 }),
          response("cross", floor - 10_000, { duration: 20_000 }),
          response("aborted", START, { stopReason: "aborted" }),
          response("too-long", START + 1000, { duration: 900_001 }),
          response("future", NOW + 1000),
        ),
      ),
      instance = monitor();
    const snapshot = await drain(instance, [s]);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({ n: 1, durationMsSum: 20_000, activeMs: 15_000 });
    expect(snapshot.current.main?.n).toBe(0);
    const future = instance.getSnapshot(new Set([s.id]), NOW + 2000);
    expect(future.records.reduce((sum, row) => sum + row.n, 0)).toBe(2);
    const tomorrow = new Date(NOW);
    tomorrow.setDate(tomorrow.getDate() + 1);
    await instance.poll([s], tomorrow.getTime());
    expect(
      instance
        .getSnapshot(new Set([s.id]), tomorrow.getTime())
        .records.every((row) => row.day > calendarDays(NOW)[0]!.date),
    ).toBe(true);
  });

  it("keeps a pre-horizon response's first completion position when a final duration revision affects retained coverage", async () => {
    const root = await directory(),
      floor = calendarDays(NOW)[0]!.start,
      oldStart = floor - 20 * 60_000,
      s = await source(
        root,
        "main",
        jsonl(
          header(oldStart - 1000),
          response("old", oldStart, { duration: 0 }),
          response("cross", floor - 10 * 60_000, { duration: 15 * 60_000 }),
          response("old", oldStart, { duration: 15 * 60_000 }),
        ),
      );
    const snapshot = await drain(monitor(), [s]);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      n: 1,
      durationMsSum: 15 * 60_000,
      activeMs: 10 * 60_000,
    });
  });

  it("uses computer-wide same-source/raw-model 14-day baselines without leaking out-of-scope owners", async () => {
    const root = await directory(),
      yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    const oldStart = yesterday.getTime() - 60_000,
      historic = await source(
        root,
        "other-project",
        jsonl(header(oldStart - 1000), ...sample("history", oldStart, 20)),
      ),
      current = await source(root, "selected-project", jsonl(header(), ...sample())),
      instance = monitor();
    await drain(instance, [historic, current]);
    const scoped = instance.getSnapshot(new Set([current.id]), NOW);
    expect(scoped.records.map((row) => row.agentId)).toEqual([current.id]);
    expect(scoped.current[current.id]?.baseline).not.toBeNull();
    expect(scoped.baselines).toEqual([
      { source: "omp", model: "raw-model", score: scoped.current[current.id]?.baseline },
    ]);
    expect(JSON.stringify(scoped)).not.toContain(historic.id);
    expect(instance.getSnapshot(new Set(), NOW)).toMatchObject({
      records: [],
      current: {},
      baselines: [],
    });
  });

  it("shares the numeric collector's canonical owner and can promote a surviving copy without double-counting", async () => {
    const root = await directory(),
      input = jsonl(header(), ...sample()),
      first = await source(root, "first", input),
      copy = await source(root, "copy", input),
      instance = monitor();
    const keys = new Set(
      sample().map((_, index) => hashId(`omp:response-${index}:${START + index * 3000}`)),
    );
    let revision = 1,
      owner = first.id;
    for (let poll = 0; poll < 64; poll++) {
      await instance.poll([copy, first], NOW, {
        revision,
        owner: (key) => (keys.has(key) ? owner : undefined),
      });
      if (!instance.getSnapshot(new Set([first.id, copy.id]), NOW).scanning) break;
    }
    const initial = instance.getSnapshot(new Set([first.id, copy.id]), NOW);
    expect(initial.records.reduce((sum, row) => sum + row.n, 0)).toBe(3);
    expect(initial.current.copy?.n).toBe(0);
    owner = copy.id;
    revision++;
    await instance.poll([copy], NOW, { revision, owner: () => owner });
    const promoted = instance.getSnapshot(new Set([copy.id]), NOW);
    expect(promoted.records[0]).toMatchObject({ agentId: copy.id, n: 3 });
    expect(promoted.current.copy?.n).toBe(3);
  });

  it("writes only the truthful v1.6 numeric schema and never trusts either legacy task data or a stale performance cache", async () => {
    const root = await directory(),
      cache = path.join(root, "cache");
    await mkdir(cache);
    await writeFile(
      path.join(cache, "omp-task-records-v150.json"),
      '{"version":1,"records":["PRIVATE LEGACY TASK"]}',
    );
    const s = await source(root, "main", jsonl(header(), ...sample())),
      first = monitor(cache);
    const snapshot = await drain(first, [s]),
      cached = await readFile(path.join(cache, PERFORMANCE_CACHE_NAME), "utf8");
    expect(JSON.parse(cached)).toMatchObject({
      schema: "omp-performance-v160",
      version: 1,
      records: snapshot.records,
    });
    expect(cached).not.toMatch(/PRIVATE|callMs|startMs|endMs|arguments|command|cwd/);
    expect(await readFile(path.join(cache, "omp-task-records-v150.json"), "utf8")).toContain(
      "PRIVATE LEGACY TASK",
    );
    await writeFile(s.path, jsonl(header()));
    const restarted = monitor(cache);
    expect((await drain(restarted, [s])).records).toEqual([]);
    const cancelled = monitor(cache),
      pending = cancelled.poll([s], NOW);
    cancelled.dispose();
    await pending;
    expect(cancelled.getSnapshot(new Set([s.id]), NOW)).toEqual({
      current: {},
      records: [],
      baselines: [],
      scanning: false,
      limited: false,
    });
  });

  it("marks malformed, oversized and invalid-UTF-8 gaps without dropping later native numeric facts", async () => {
    const root = await directory(),
      s = await source(root, "main", jsonl(header())),
      padding = JSON.stringify({
        type: "custom",
        id: "oversized",
        timestamp: new Date(START).toISOString(),
        content: "PRIVATE".repeat(256),
      });
    PERFORMANCE_READER_LIMITS.maxLineBytes = 512;
    PERFORMANCE_FILE_LIMITS.chunkBytes = 37;
    await writeFile(
      s.path,
      Buffer.concat([
        Buffer.from(jsonl(header(), "{malformed}", padding)),
        Buffer.from([255, 10]),
        Buffer.from(jsonl(...sample())),
      ]),
    );
    const snapshot = await drain(monitor(), [s]);
    expect(snapshot).toMatchObject({ scanning: false, limited: true, current: { main: { n: 3 } } });
    expect(snapshot.current.main?.score).not.toBeNull();
    expect(snapshot.records[0]?.n).toBe(3);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
  });

  it("never presents a saturated partial scan as a complete performance sample", async () => {
    const root = await directory(),
      s = await source(root, "main", jsonl(header(), ...sample()));
    PERFORMANCE_READER_LIMITS.maxEvents = 2;
    expect(await drain(monitor(), [s])).toMatchObject({
      limited: true,
      records: [],
      current: { main: { n: 0, score: null } },
    });
  });

  it("rejects symlinked source leaves and linked ancestors without opening another source", async () => {
    const root = await directory(),
      target = await source(root, "target", jsonl(header(), ...sample())),
      link = path.join(root, "linked.jsonl");
    try {
      await symlink(target.path, link, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const instance = monitor(),
      s: OmpPerformanceSource = { id: "linked", path: link, phase: "idle" };
    expect(await drain(instance, [s])).toMatchObject({
      records: [],
      limited: true,
      current: { linked: { score: null } },
    });
    const ancestor = path.join(root, "linked-folder");
    await symlink(root, ancestor, "junction");
    const throughAncestor: OmpPerformanceSource = {
      id: "ancestor",
      path: path.join(ancestor, "target.jsonl"),
      phase: "idle",
    };
    expect(await drain(instance, [throughAncestor])).toMatchObject({
      records: [],
      limited: true,
      current: { ancestor: { score: null } },
    });
  });
});
