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
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OmpTaskMonitor, TASK_MONITOR_LIMITS } from "./task-monitor.js";
import { taskFileIdentity, TASK_FILE_LIMITS, type OmpTaskSource } from "./task-reader-file.js";
import { OmpTaskLineReader, TASK_READER_LIMITS } from "./task-reader.js";
import {
  OMP_FIXTURE_SHA256,
  OMP_MAIN_JSONL,
  OMP_REVIEWER_JSONL,
} from "../../test-fixtures/task-reader-fixtures.js";
import { calendarDays } from "./math.js";
import { createTaskRecords } from "./task-score.js";
import { OmpTaskRecordStorage } from "./task-storage.js";

const NOW = Date.parse("2026-10-27T11:00:00Z");
const START = Date.parse("2026-10-27T10:20:00Z");
const directories: string[] = [],
  monitors: OmpTaskMonitor[] = [];
const originalMonitorLimits = { ...TASK_MONITOR_LIMITS },
  originalFileLimits = { ...TASK_FILE_LIMITS },
  originalReaderLimits = { ...TASK_READER_LIMITS };
async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-task-reader-")));
  directories.push(root);
  return root;
}
function monitor(cacheDir?: string): OmpTaskMonitor {
  const m = new OmpTaskMonitor({ cacheDir });
  monitors.push(m);
  return m;
}
async function source(
  root: string,
  id: string,
  text: string,
  phase: OmpTaskSource["phase"] = "idle",
): Promise<OmpTaskSource> {
  const file = path.join(root, `${id}.jsonl`);
  await writeFile(file, text);
  return { id, path: file, phase };
}
async function drain(m: OmpTaskMonitor, sources: OmpTaskSource[], now = NOW) {
  for (let i = 0; i < 512; i++) {
    await m.poll(sources, now);
    const snapshot = m.getSnapshot(new Set(sources.map((s) => s.id)), now);
    if (!snapshot.scanning) return snapshot;
  }
  throw new Error("Task reader did not exhaust its finite fixture budget");
}
function line(id: string, t: number, message: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", id, timestamp: new Date(t).toISOString(), message });
}
function header(t = START): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id: "fictional-session",
    timestamp: new Date(t).toISOString(),
    cwd: "/private/fixture-workspace",
  });
}
function prompt(id: string, t: number, text: string): string {
  return line(id, t, { role: "user", content: [{ type: "text", text }] });
}
function call(id: string, t: number, tool: string, args: unknown, callId = id): string {
  return line(id, t, {
    role: "assistant",
    model: "fixture-model",
    provider: "fixture",
    api: "fixture",
    usage: { input: 1, output: 2 },
    timestamp: t - 100,
    content: [{ type: "toolCall", id: callId, name: tool, arguments: args }],
  });
}
function result(
  id: string,
  t: number,
  callId: string,
  text: string,
  details: Record<string, unknown> = {},
  isError = false,
): string {
  return line(id, t, {
    role: "toolResult",
    toolCallId: callId,
    toolName: "bash",
    content: [{ type: "text", text }],
    details,
    isError,
  });
}
function jsonl(...lines: string[]): string {
  return lines.join("\n") + "\n";
}
function passingText(label = "test-target"): string {
  return jsonl(
    header(),
    prompt("prompt", START + 1, `Implement ${label}`),
    call("call", START + 2, "bash", { command: `pytest ${label}.py` }),
    result("result", START + 10_002, "call", "1 passed in 0.01s", { exitCode: 0 }),
  );
}

afterEach(async () => {
  for (const m of monitors.splice(0)) m.dispose();
  Object.assign(TASK_MONITOR_LIMITS, originalMonitorLimits);
  Object.assign(TASK_FILE_LIMITS, originalFileLimits);
  Object.assign(TASK_READER_LIMITS, originalReaderLimits);
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ordered OMP task monitor", () => {
  it("reads the complete pinned main + Reviewer JSONL through real files and excludes copied pre-header history", async () => {
    expect(
      [OMP_MAIN_JSONL, OMP_REVIEWER_JSONL].map((text) =>
        createHash("sha256").update(text).digest("hex"),
      ),
    ).toEqual(OMP_FIXTURE_SHA256);
    const root = await directory(),
      main = await source(root, "main", OMP_MAIN_JSONL),
      reviewer = await source(root, "Reviewer", OMP_REVIEWER_JSONL),
      m = monitor();
    const snapshot = await drain(m, [main, reviewer]);
    expect(snapshot).toMatchObject({
      scanning: false,
      limited: false,
      current: {
        main: {
          form: "resting",
          result: { state: "failing", counts: { actions: 2, edits: 1, runs: 1, failingRuns: 1 } },
        },
        Reviewer: { result: { score: null, counts: { actions: 1, edits: 0, runs: 0 } } },
      },
    });
    expect(snapshot.records).toHaveLength(2);
    expect(snapshot.records.find((r) => r.agentId === "main")).toMatchObject({
      complete: true,
      model: "claude-opus-5-5",
      state: "failing",
      counts: { actions: 2, edits: 1, runs: 1 },
    });
    expect(snapshot.records.every((r) => r.complete)).toBe(true);
    const scoped = m.getSnapshot(new Set(["Reviewer"]), NOW);
    expect(Object.keys(scoped.current)).toEqual(["Reviewer"]);
    expect(scoped.records.map((r) => r.agentId)).toEqual(["Reviewer"]);
    expect(m.getSnapshot(new Set(), NOW)).toMatchObject({
      current: {},
      records: [],
      scanning: false,
    });
  });

  it("fairly scans more than 256 real history sources while limiting current DTOs to the requested cards", async () => {
    const root = await directory(),
      sources: OmpTaskSource[] = [];
    for (let i = 0; i < 257; i++) {
      const id = `history-${i}`,
        input = passingText(id)
          .replaceAll('"id":"call"', `"id":"call-${i}"`)
          .replace('"toolCallId":"call"', `"toolCallId":"call-${i}"`);
      sources.push(await source(root, id, input));
    }
    const m = monitor();
    await drain(m, sources);
    const all = new Set(sources.map((s) => s.id)),
      onlyLast = new Set([sources.at(-1)!.id]);
    const snapshot = m.getSnapshot(all, NOW, onlyLast);
    expect(snapshot).toMatchObject({ scanning: false, limited: false });
    expect(snapshot.records).toHaveLength(257);
    expect(Object.keys(snapshot.current)).toEqual([...onlyLast]);
    expect(snapshot.current[sources.at(-1)!.id]?.result?.state).toBe("passing");
    expect(m.getSnapshot(all, NOW, new Set()).current).toEqual({});
  }, 30_000);

  it("retains the last 30 local dates, keeps a boundary-crossing task whole, and reuses unchanged history snapshots", async () => {
    const root = await directory(),
      floor = calendarDays(NOW)[0]!.start,
      before = floor - 60 * 60_000;
    const input = jsonl(
      header(floor - 3 * 60 * 60_000),
      prompt("expired-prompt", floor - 2 * 60 * 60_000, "Expired task"),
      call("expired-read", floor - 2 * 60 * 60_000 + 1, "read", { path: "expired.ts" }),
      result("expired-result", floor - 2 * 60 * 60_000 + 2, "expired-read", "file content"),
      prompt("cross-prompt", before, "Retained task"),
      call("cross-edit", before + 1, "edit", { path: "date.ts", oldText: "old", newText: "new" }),
      result("edit-result", before + 2, "cross-edit", "Edited"),
      call("cross-test", floor + 1, "bash", { command: "pytest" }),
      result("test-result", floor + 10_001, "cross-test", "1 passed in 0.01s", { exitCode: 0 }),
    );
    const s = await source(root, "main", input),
      m = monitor(),
      snapshot = await drain(m, [s]);
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      startMs: before,
      endMs: floor + 10_001,
      state: "passing",
      counts: { edits: 1, runs: 1 },
    });
    expect(m.getSnapshot(new Set([s.id]), NOW + 1_000).records).toBe(snapshot.records);
    const tomorrow = new Date(NOW);
    tomorrow.setDate(tomorrow.getDate() + 1);
    await m.poll([s], tomorrow.getTime());
    expect(m.getSnapshot(new Set([s.id]), tomorrow.getTime()).records).toEqual([]);
  });

  it("produces the same ordered tasks under UTF-8 chunk splits and bounded poll budgets", async () => {
    const root = await directory(),
      input = OMP_MAIN_JSONL.replace("Make the date parser accept ISO weeks", "修复日期解析器 🚀"),
      s = await source(root, "main", input),
      reference = monitor();
    const expected = await drain(reference, [s]);
    TASK_MONITOR_LIMITS.pollBytes = 512;
    TASK_MONITOR_LIMITS.fileBytes = 256;
    TASK_FILE_LIMITS.chunkBytes = 37;
    const segmented = monitor();
    await segmented.poll([s], NOW);
    expect(segmented.getSnapshot(new Set(["main"]), NOW)).toMatchObject({
      scanning: true,
      current: { main: { result: null } },
    });
    expect(await drain(segmented, [s])).toEqual(expected);
  });

  it("never parses a complete-looking JSON object before its JSONL newline", async () => {
    const root = await directory(),
      body = passingText(),
      at = body.lastIndexOf("\n", body.length - 2),
      s = await source(root, "main", body.slice(0, -1)),
      m = monitor();
    await m.poll([s], NOW);
    expect(m.getSnapshot(new Set([s.id]), NOW)).toMatchObject({
      scanning: true,
      current: { main: { result: null } },
      records: [],
    });
    expect(at).toBeGreaterThan(0);
    await appendFile(s.path, "\n");
    const snapshot = await drain(m, [s]);
    expect(snapshot.current.main?.result).toMatchObject({
      state: "passing",
      counts: { actions: 1, runs: 1 },
    });
  });

  it("detects a middle rewrite plus append, resets call/result matching, and drops deleted sources", async () => {
    const root = await directory(),
      s = await source(root, "main", passingText()),
      m = monitor();
    expect((await drain(m, [s])).current.main?.result?.state).toBe("passing");
    const rewritten = passingText()
      .replace("1 passed in 0.01s", "1 failed in 0.01s")
      .replace('"exitCode":0', '"exitCode":1')
      .replace('"isError":false', '"isError":true');
    await writeFile(
      s.path,
      rewritten + prompt("next", START + 20_000, "A different task with no proof") + "\n",
    );
    const after = await drain(m, [s]);
    expect(after.records).toHaveLength(1);
    expect(after.records[0]).toMatchObject({ state: "failing", complete: true });
    expect(after.current.main?.result?.state).toBe("none");
    await rm(s.path);
    await m.poll([s], NOW);
    expect(m.getSnapshot(new Set([s.id]), NOW)).toMatchObject({
      limited: true,
      records: [],
      current: { main: { result: null } },
    });
    await m.poll([], NOW);
    expect(m.getSnapshot(new Set([s.id]), NOW).records).toEqual([]);
  });

  it("detects a same-size rewrite even when mtime is restored", async () => {
    const root = await directory(),
      original = passingText(),
      s = await source(root, "main", original),
      m = monitor();
    await drain(m, [s]);
    const before = await stat(s.path);
    const changed = original
      .replace("1 passed in 0.01s", "1 failed in 0.01s")
      .replace('"exitCode":0', '"exitCode":1');
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    await writeFile(s.path, changed);
    await utimes(s.path, before.atime, before.mtime);
    expect((await drain(m, [s])).current.main?.result?.state).toBe("failing");
  });

  it("refuses a replacement that no longer has the collector-discovered identity", async () => {
    const root = await directory(),
      s = await source(root, "main", passingText()),
      replacement = path.join(root, "replacement.jsonl"),
      m = monitor();
    s.identity = taskFileIdentity(await stat(s.path));
    await drain(m, [s]);
    await writeFile(replacement, OMP_REVIEWER_JSONL);
    await rm(s.path);
    await rename(replacement, s.path);
    await m.poll([s], NOW);
    expect(m.getSnapshot(new Set([s.id]), NOW)).toMatchObject({
      limited: true,
      records: [],
      current: { main: { result: null } },
    });
    s.identity = taskFileIdentity(await stat(s.path));
    expect((await drain(m, [s])).current.main?.result?.counts.actions).toBe(1);
  });

  it("refuses linked parent directories without traversing to an unapproved source", async () => {
    const root = await directory(),
      target = path.join(root, "real"),
      link = path.join(root, "linked");
    await mkdir(target);
    const original = await source(target, "main", passingText());
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    const s = { ...original, path: path.join(link, "main.jsonl") },
      m = monitor();
    await m.poll([s], NOW);
    expect(m.getSnapshot(new Set([s.id]), NOW)).toMatchObject({
      limited: true,
      records: [],
      current: { main: { result: null } },
    });
  });

  it("deduplicates copied requests and withdraws their prompts, then reveals an available copy when its owner disappears", async () => {
    const root = await directory(),
      a = await source(root, "a", passingText()),
      b = await source(root, "b", passingText()),
      m = monitor();
    const both = await drain(m, [a, b]);
    expect(both.records).toHaveLength(1);
    expect(both.records[0]?.agentId).toBe("a");
    expect(m.getSnapshot(new Set(["b"]), NOW).records).toEqual([]);
    expect((await drain(m, [b])).records.map((r) => r.agentId)).toEqual(["b"]);
    const duplicated = jsonl(
      header(),
      prompt("first", START + 1, "Fix date"),
      call("call", START + 2, "read", { path: "date.ts" }),
      prompt("copy", START + 3, "Copied prompt"),
      call("call", START + 2, "read", { path: "date.ts" }),
    );
    await writeFile(b.path, duplicated);
    expect((await drain(m, [b])).records[0]?.counts.actions).toBe(1);
  });

  it("uses only matching native job terminal results, leaves unsupported follow-ups unknown, and preserves actual outcome time", async () => {
    const root = await directory(),
      s = await source(
        root,
        "main",
        jsonl(
          header(),
          prompt("p", START + 1, "Run proof"),
          call("call", START + 2, "bash", { command: "pytest", async: true }),
          result("start", START + 3, "call", "partial output", {
            async: { type: "bash", jobId: "bg_1", state: "running" },
          }),
        ),
      ),
      m = monitor();
    let snapshot = await drain(m, [s]);
    expect(snapshot.current.main?.result).toMatchObject({
      score: null,
      counts: { actions: 1, runs: 0 },
    });
    await appendFile(
      s.path,
      jsonl(
        prompt("notice", START + 4, "Background job bg_1 completed successfully"),
        result("wrong", START + 5, "call", "1 passed in 0.01s", {
          async: { type: "bash", jobId: "bg_2", state: "completed" },
        }),
      ),
    );
    snapshot = await drain(m, [s]);
    expect(snapshot.records.every((r) => r.counts.runs === 0)).toBe(true);
    await appendFile(
      s.path,
      result("terminal", START + 30_002, "call", "1 passed in 0.01s", {
        async: { type: "bash", jobId: "bg_1", state: "completed" },
      }) + "\n",
    );
    snapshot = await drain(m, [s]);
    const proven = snapshot.records.find((r) => r.counts.runs === 1)!;
    expect(proven).toMatchObject({ state: "passing", firstPassMs: START + 30_002 });
    expect(proven.endMs).toBe(START + 30_002);
  });

  it("does not relabel old history as live and does not export content or digests in snapshot/cache", async () => {
    const root = await directory(),
      cache = path.join(root, "cache"),
      s = await source(root, "main", passingText("PRIVATE_COMMAND_AND_PROMPT"), "generating"),
      m = monitor(cache);
    const snapshot = await drain(m, [s]);
    expect(snapshot.current.main?.form).toBe("resting");
    const serialized = JSON.stringify(snapshot),
      cached = await readFile(path.join(cache, "omp-task-records-v150.json"), "utf8");
    for (const text of [serialized, cached]) {
      expect(text).not.toMatch(
        /PRIVATE_COMMAND_AND_PROMPT|fixture-workspace|digest|fingerprints|toolCallId|command|hunks/,
      );
      expect(text).not.toContain("test-target.py");
    }
    const restored = monitor(cache);
    TASK_MONITOR_LIMITS.fileBytes = 8;
    await restored.poll([s], NOW);
    expect(restored.getSnapshot(new Set([s.id]), NOW).current.main?.result).toBeNull();
    expect(await drain(restored, [s])).toEqual(snapshot);
  });

  it("saves and reloads real createTaskRecords snapshots with the original nine-column schema", async () => {
    const root = await directory(),
      cache = path.join(root, "cache"),
      reader = new OmpTaskLineReader();
    for (const raw of jsonl(
      header(),
      prompt("prompt", START + 1, "Implement date"),
      call("edit", START + 2, "edit", { path: "date.ts", oldText: "old", newText: "new" }),
      result("edit-result", START + 3, "edit", "Edited"),
      call("proof", START + 4, "bash", { command: "pytest" }),
      result("proof-result", START + 5004, "proof", "1 passed in 0.01s", { exitCode: 0 }),
    )
      .trimEnd()
      .split("\n"))
      reader.read(raw);
    const records = createTaskRecords(
      "main",
      reader.snapshotEvents(() => true),
      reader.notes,
      NOW,
      reader.lastLineMs,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.snapshots.length).toBeGreaterThan(0);
    expect(records[0]!.snapshots.every((row) => row.length === 9)).toBe(true);
    const storage = new OmpTaskRecordStorage(cache);
    await storage.save(records, NOW, () => true);
    expect(storage.limited).toBe(false);
    const persisted = JSON.parse(
      await readFile(path.join(cache, "omp-task-records-v150.json"), "utf8"),
    ) as { records: typeof records };
    expect(persisted.records).toEqual(records);
    const restored = new OmpTaskRecordStorage(cache);
    await restored.load(NOW);
    expect(restored.limited).toBe(false);
    const reused = restored.reuse("main", records);
    expect(reused).toEqual(records);
    expect(reused).not.toBe(records);
    storage.dispose();
    restored.dispose();
    reader.clear();
  });

  it("treats corrupt cache and bounded source gaps as unknown instead of composing a complete score", async () => {
    const root = await directory(),
      cache = path.join(root, "cache");
    await mkdir(cache);
    await writeFile(
      path.join(cache, "omp-task-records-v150.json"),
      '{"version":1,"records":[{"prompt":"PRIVATE"}]}',
    );
    const s = await source(root, "main", passingText()),
      m = monitor(cache);
    TASK_MONITOR_LIMITS.fileBytes = 8;
    await m.poll([s], NOW);
    expect(m.getSnapshot(new Set([s.id]), NOW)).toMatchObject({
      limited: true,
      scanning: true,
      records: [],
      current: { main: { result: null } },
    });
    TASK_MONITOR_LIMITS.fileBytes = originalMonitorLimits.fileBytes;
    TASK_READER_LIMITS.maxLineBytes = 128;
    const bounded = monitor();
    const snapshot = await drain(bounded, [s]);
    expect(snapshot).toMatchObject({
      limited: true,
      current: { main: { result: null } },
      records: [],
    });
    m.dispose();
    expect(m.getSnapshot(new Set([s.id]), NOW)).toEqual({
      current: {},
      records: [],
      scanning: false,
      limited: false,
    });
  });
});
