import { afterEach, describe, expect, it } from "vitest";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
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
import { OmpLocalMonitor } from "./collector.js";
import { MONITOR_LIMITS } from "./state.js";
import { resolveOmpMonitorRoots } from "./roots.js";
import { getBundledPricingState } from "./pricing.js";
import type { OmpMonitorCostInput } from "./pricing.js";

const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();
const directories: string[] = [];
const monitors: OmpLocalMonitor[] = [];
const originalLimits = { ...MONITOR_LIMITS };

function header(at = NOW - 60_000, cwd: string | undefined = "C:\\private\\project-alpha") {
  return {
    type: "session",
    version: 3,
    id: "private-session-id",
    timestamp: new Date(at).toISOString(),
    cwd,
  };
}

function response(id: string, start: number, output = 100, extra: Record<string, unknown> = {}) {
  return {
    type: "message",
    id,
    timestamp: new Date(start + 1_000).toISOString(),
    message: {
      role: "assistant",
      model: "model-a",
      provider: "fixture",
      api: "fixture-api",
      timestamp: start,
      duration: 1_000,
      ttft: 50,
      stopReason: "stop",
      usage: {
        input: 10,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: output + 10,
        cost: { total: 1 },
      },
      content: [{ type: "text", text: "PRIVATE PROMPT AND ANSWER MUST NEVER LEAVE THE PARSER" }],
      ...extra,
    },
  };
}

function event(id: string, at: number, message: Record<string, unknown>) {
  return { type: "message", id, timestamp: new Date(at).toISOString(), message };
}

async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "omp-local-monitor-")));
  directories.push(root);
  return root;
}

async function session(
  root: string,
  relative: string,
  records: unknown[],
  newline = true,
): Promise<string> {
  const file = path.join(root, "bucket", relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    records.map((record) => JSON.stringify(record)).join("\n") + (newline ? "\n" : ""),
  );
  return file;
}

function largeHistoryPadding() {
  return {
    type: "custom",
    customType: "tool_execution_start",
    id: "fixture-history-padding",
    timestamp: new Date(NOW - 40_000).toISOString(),
    content: "x".repeat(9 * 1_024 * 1_024),
  };
}

function monitor(root: string, clock: () => number = () => NOW): OmpLocalMonitor {
  const result = new OmpLocalMonitor({ roots: [{ path: root, label: "default" }], now: clock });
  monitors.push(result);
  return result;
}

afterEach(async () => {
  for (const current of monitors.splice(0)) current.dispose();
  Object.assign(MONITOR_LIMITS, originalLimits);
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("OMP local numeric filesystem monitor", () => {
  it("distinguishes an unavailable root from an available, empty root", async () => {
    const root = await directory();
    const missing = monitor(path.join(root, "missing"));
    expect(await missing.poll()).toMatchObject({
      status: "unavailable",
      today: { requests: 0 },
      activity: { lastResponseAt: null, peakAt: null, peakObservedAt: null },
      coverage: { roots: [{ available: false }] },
    });
    const empty = monitor(root);
    expect(await empty.poll()).toMatchObject({
      status: "ready",
      today: { requests: 0 },
      activity: { lastResponseAt: null, peakAt: null, peakObservedAt: null },
      coverage: { limited: false },
    });
  });

  it("keeps raw non-cache input, native totals, explicit zero cost and unknown prices distinct", async () => {
    const root = await directory();
    await session(root, "main.jsonl", [
      header(),
      response("normal", NOW - 5_000, 20, {
        usage: {
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 40,
          totalTokens: 160,
          cost: { total: 0 },
        },
      }),
      response("fallback", NOW - 4_000, 20, {
        usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
      }),
      response("partial", NOW - 3_000, 7, { stopReason: "aborted" }),
      response("placeholder", NOW - 2_000, 0, {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 999 },
      }),
      {
        type: "model_usage",
        id: "side",
        timestamp: new Date(NOW - 500).toISOString(),
        model: "side-model",
        provider: "fixture",
        api: "fixture-api",
        usage: { input: 1, output: 2, cost: { total: 0.5 } },
      },
    ]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.today).toMatchObject({
      requests: 4,
      failedRequests: 1,
      inputTokens: 31,
      outputTokens: 49,
      cacheReadTokens: 60,
      cacheWriteTokens: 80,
      totalTokens: 280,
      costUsd: 1.5,
      unpricedRequests: 1,
      measuredOutputTokens: 40,
      measuredDurationMs: 2_000,
    });
    expect(snapshot.activity).toEqual({
      lastResponseAt: NOW - 3_000,
      peakAt: NOW - 3_000,
      peakObservedAt: NOW - 3_000,
    });
    expect(snapshot.agents[0]).toMatchObject({
      model: "model-a",
      phase: "idle",
      ttftMs: 50,
      outputTps: 20,
    });
    expect(snapshot.days).toHaveLength(30);
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|private-session|private\\|main\.jsonl/);
  });

  it("links main, child, advisor and nested child without exposing transcript identities", async () => {
    const root = await directory();
    await session(root, "main.jsonl", [header(), response("main-call", NOW - 6_000)]);
    await session(root, "main/task.jsonl", [header(), response("child-call", NOW - 5_000)]);
    await session(root, "main/__advisor.research.jsonl", [
      header(),
      response("advisor-call", NOW - 4_000),
    ]);
    await session(root, "main/task/nested.jsonl", [header(), response("nested-call", NOW - 3_000)]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.today.requests).toBe(4);
    const main = snapshot.agents.find((agent) => agent.kind === "main")!;
    const advisor = snapshot.agents.find((agent) => agent.kind === "advisor")!;
    const child = snapshot.agents.find(
      (agent) => agent.kind === "subagent" && agent.parentId === main.id,
    )!;
    expect(advisor.parentId).toBe(main.id);
    expect(snapshot.agents.find((agent) => agent.parentId === child.id)).toBeDefined();
    expect(snapshot.agents.every((agent) => /^[a-f0-9]{32}$/.test(agent.id))).toBe(true);
    expect(snapshot.agents[0]!.id).toBe(main.id);
  });

  it("deduplicates copied logs and same-file updates, but distinguishes a reused id with a different request stamp", async () => {
    const root = await directory();
    const first = response("same-id", NOW - 4_000, 10);
    const original = await session(root, "a.jsonl", [
      header(),
      first,
      first,
      response("same-id", NOW - 2_000, 20),
    ]);
    const copy = await session(root, "b.jsonl", [header(), first]);
    await utimes(original, new Date(NOW - 10_000), new Date(NOW - 10_000));
    await utimes(copy, new Date(NOW - 9_000), new Date(NOW - 9_000));
    const current = monitor(root);
    const initial = await current.poll();
    expect(initial.today).toMatchObject({ requests: 2, outputTokens: 30 });
    expect(initial.activity).toEqual({
      lastResponseAt: NOW - 1_000,
      peakAt: NOW - 1_000,
      peakObservedAt: NOW - 1_000,
    });
    await appendFile(original, `${JSON.stringify(response("same-id", NOW - 4_000, 15))}\n`);
    const corrected = await current.poll({ refresh: true });
    expect(corrected.today).toMatchObject({
      requests: 2,
      outputTokens: 35,
    });
    expect(corrected.today.peakOutputTps).toBeCloseTo(35 / 3);
    expect(corrected.activity).toEqual(initial.activity);
    await rm(original);
    const remainingCopy = await current.poll({ refresh: true });
    expect(remainingCopy.today).toMatchObject({
      requests: 1,
      outputTokens: 10,
    });
    expect(remainingCopy.activity).toEqual({
      lastResponseAt: NOW - 3_000,
      peakAt: NOW - 3_000,
      peakObservedAt: NOW - 3_000,
    });
  });

  it("ignores inherited records older than the first fresh header minus two seconds", async () => {
    const root = await directory();
    await session(root, "fork.jsonl", [
      { type: "title", title: "private text" },
      header(NOW - 2_000),
      response("inherited", NOW - 20_000),
      header(NOW - 50_000),
      response("fresh", NOW - 2_000, 7),
    ]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.today).toMatchObject({ requests: 1, outputTokens: 7 });
  });

  it("ignores records physically preceding the header, even when the header fits the two-line probe", async () => {
    const root = await directory();
    await session(root, "main.jsonl", [
      response("before-header", NOW - 2_000, 999),
      header(NOW - 3_000),
      response("after-header", NOW - 1_000, 7),
    ]);
    expect((await monitor(root).poll()).today).toMatchObject({ requests: 1, outputTokens: 7 });
  });

  it("replaces a live estimate with native measurement and excludes pre-call and tool gaps", async () => {
    const root = await directory();
    let now = NOW;
    const file = await session(root, "main.jsonl", [
      header(),
      response("reference", NOW - 20_000, 100),
      event("user", NOW - 2_000, { role: "user", content: "private input" }),
    ]);
    const current = monitor(root, () => now);
    const generating = await current.poll();
    expect(generating.rate.measuredTps).toBe(0);
    expect(generating.rate.estimatedTps).toBeCloseTo(200 / 3);
    expect(generating.activity).toEqual({
      lastResponseAt: NOW - 19_000,
      peakAt: NOW - 19_000,
      peakObservedAt: NOW - 19_000,
    });
    now += 1_000;
    await appendFile(
      file,
      `${JSON.stringify(
        response("completed", NOW - 500, 150, {
          duration: 1_500,
          content: [
            { type: "toolCall", id: "call-a" },
            { type: "toolCall", id: "call-b" },
          ],
          stopReason: "toolUse",
        }),
      )}\n`,
    );
    const tools = await current.poll();
    expect(tools.agents[0]!.phase).toBe("tools");
    expect(tools.rate.estimatedTps).toBe(0);
    expect(tools.rate.measuredTps).toBeCloseTo(50);
    expect(tools.activity).toEqual({
      lastResponseAt: NOW + 1_000,
      peakAt: NOW + 1_000,
      peakObservedAt: NOW + 1_000,
    });
    expect(tools.series.find((point) => point.timestamp === NOW - 2_000)).toMatchObject({
      measuredTps: 0,
      estimatedTps: 0,
    });
    now += 1_000;
    await appendFile(
      file,
      `${JSON.stringify(event("tool-a", now, { role: "toolResult", toolCallId: "call-a" }))}\n`,
    );
    expect((await current.poll()).agents[0]!.phase).toBe("tools");
    now += 2_000;
    await appendFile(
      file,
      `${JSON.stringify(event("tool-b", now, { role: "toolResult", toolCallId: "call-b" }))}\n`,
    );
    expect((await current.poll()).agents[0]!.phase).toBe("generating");
    now += 1_000;
    const resumed = await current.poll();
    expect(resumed.rate.measuredTps).toBe(0);
    expect(resumed.rate.estimatedTps).toBeGreaterThan(0);
    expect(resumed.activity).toEqual(tools.activity);
    expect(resumed.series.find((point) => point.timestamp === NOW + 2_000)).toMatchObject({
      measuredTps: 0,
      estimatedTps: 0,
    });
    await appendFile(
      file,
      `${JSON.stringify(event("yield", now, { role: "toolResult", toolName: "yield", isError: false }))}\n`,
    );
    expect((await current.poll()).agents[0]!.phase).toBe("idle");
  });

  it("projects native 18.12.3 numeric completions, estimates only active output, and decays without replay spikes", async () => {
    const root = await directory();
    let now = NOW;
    // Native numeric fields only; stamps are rebased and all identity/content is fixture-owned.
    const first = {
      ...response("native-first", NOW - 5_018, 38, {
        duration: 5016.345299999986,
        completedAt: NOW - 1,
        ttft: 4647.639000000025,
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "native-tool" }],
        usage: {
          input: 12_248,
          output: 38,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12_286,
          premiumRequests: 1,
        },
      }),
      timestamp: new Date(NOW).toISOString(),
    };
    const file = await session(root, "main.jsonl", [header(NOW - 120_000), first]);
    const current = monitor(root, () => now);
    const measured = await current.poll();
    const priorSpeed = (38 * 1_000) / 5_016;
    expect(measured.status).toBe("ready");
    expect(measured.today).toMatchObject({
      requests: 1,
      inputTokens: 12_248,
      outputTokens: 38,
      totalTokens: 12_286,
      measuredOutputTokens: 38,
      measuredDurationMs: 5_016,
    });
    expect(measured.rate.measuredTps).toBeCloseTo((priorSpeed * 2_998) / 3_000);
    expect(measured.rate.estimatedTps).toBe(0);
    expect(measured.agents[0]).toMatchObject({ phase: "tools", ttftMs: 4_647 });

    now += 3_001;
    expect((await current.poll()).rate.measuredTps).toBe(0);
    await appendFile(
      file,
      `${JSON.stringify(event("native-result", now, { role: "toolResult", toolCallId: "native-tool" }))}\n`,
    );
    await current.poll();
    now += 1_000;
    const generating = await current.poll();
    expect(generating.agents[0]!.phase).toBe("generating");
    expect(generating.rate.measuredTps).toBe(0);
    expect(generating.rate.estimatedTps).toBeCloseTo(priorSpeed / 3);
    expect(generating.rate.estimatedShare).toBe(1);

    now += 2_000;
    const completedAt = now - 2;
    const second = {
      ...response("native-second", now - 1_897, 29, {
        duration: 1895.9005999999936,
        completedAt: now - 1,
        ttft: 1671.6255999999703,
        usage: {
          input: 993,
          output: 29,
          cacheRead: 12_160,
          cacheWrite: 0,
          totalTokens: 13_182,
          premiumRequests: 1,
        },
      }),
      timestamp: new Date(now).toISOString(),
    };
    const serialized = `${JSON.stringify(second)}\n`;
    await appendFile(file, serialized + serialized);
    const completed = await current.poll();
    expect(completed.today).toMatchObject({
      requests: 2,
      outputTokens: 67,
      cacheReadTokens: 12_160,
      measuredOutputTokens: 67,
      measuredDurationMs: 6_911,
    });
    expect(completed.agents[0]!.phase).toBe("idle");
    expect(completed.rate.measuredTps).toBeCloseTo(29 / 3);
    expect(completed.rate.estimatedTps).toBe(0);
    expect(completed.activity.lastResponseAt).toBe(completedAt);
    expect(JSON.stringify(completed)).not.toContain("PRIVATE PROMPT AND ANSWER");
    expect(JSON.stringify(completed)).not.toContain("native-tool");
    expect(
      completed.series.every(
        (point) => Number.isFinite(point.measuredTps) && Number.isFinite(point.estimatedTps),
      ),
    ).toBe(true);

    now += 2_000;
    const decaying = await current.poll();
    expect(decaying.rate.measuredTps).toBeCloseTo((((29 * 1_000) / 1_895) * 998) / 3_000);
    now += 1_001;
    expect((await current.poll()).rate).toEqual({
      measuredTps: 0,
      estimatedTps: 0,
      estimatedShare: 0,
      measuredThinkingTps: null,
      estimatedThinkingTps: null,
    });
    await appendFile(
      file,
      `${JSON.stringify(response("historical-replay", NOW - 60_000, 9_000))}\n`,
    );
    const replay = await current.poll();
    expect(replay.rate).toEqual({
      measuredTps: 0,
      estimatedTps: 0,
      estimatedShare: 0,
      measuredThinkingTps: null,
      estimatedThinkingTps: null,
    });
    expect(replay.today.peakOutputTps).toBe(3_000);
    expect(replay.activity.lastResponseAt).toBe(completedAt);
    expect(replay.activity.peakObservedAt).toBe(NOW - 59_000);
    expect(replay.agents[0]!.phase).toBe("idle");
  });

  it("reports concurrent output as a sum, not a false per-call average", async () => {
    const root = await directory();
    await session(root, "main.jsonl", [
      header(),
      response("main", NOW - 3_000, 300, { duration: 3_000 }),
    ]);
    await session(root, "main/child.jsonl", [
      header(),
      response("child", NOW - 3_000, 150, { duration: 3_000 }),
    ]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.rate.measuredTps).toBeCloseTo(150);
    expect(
      (snapshot.today.measuredOutputTokens * 1_000) / snapshot.today.measuredDurationMs,
    ).toBeCloseTo(75);
    expect(snapshot.today.peakOutputTps).toBeCloseTo(150);
    expect(snapshot.activity).toEqual({
      lastResponseAt: NOW,
      peakAt: NOW,
      peakObservedAt: NOW,
    });
  });

  it("reports successful unknown-timing completions without counting failures, side calls or input-only usage as response events", async () => {
    const root = await directory();
    const file = await session(root, "main.jsonl", [
      header(),
      response("unknown-timing", NOW - 10_000, 20, {
        duration: undefined,
        completedAt: NOW - 9_000,
      }),
    ]);
    const current = monitor(root);
    const completed = await current.poll();
    expect(completed.today.peakOutputTps).toBe(0);
    expect(completed.activity).toEqual({
      lastResponseAt: NOW - 9_000,
      peakAt: null,
      peakObservedAt: null,
    });
    await appendFile(
      file,
      [
        response("failed", NOW - 6_000, 1_000, { stopReason: "error" }),
        response("aborted", NOW - 5_000, 1_000, { stopReason: "aborted" }),
        {
          type: "model_usage",
          id: "side-call",
          timestamp: new Date(NOW - 1_000).toISOString(),
          model: "side-model",
          provider: "fixture",
          api: "fixture-api",
          usage: { input: 1, output: 1_000 },
        },
        response("input-only", NOW - 1_000, 0),
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const excluded = await current.poll();
    expect(excluded.today).toMatchObject({
      requests: 5,
      failedRequests: 2,
      measuredOutputTokens: 0,
      peakOutputTps: 0,
    });
    expect(excluded.activity).toEqual(completed.activity);
  });

  it("preserves actual old completion times when a backfill raises the peak, then identifies a fresh measured completion", async () => {
    const root = await directory();
    let now = NOW;
    const file = await session(root, "main.jsonl", [
      header(NOW - 2 * 60 * 60_000),
      response("baseline", NOW - 60_000, 30, { duration: 3_000 }),
    ]);
    const current = monitor(root, () => now);
    const baseline = await current.poll();
    expect(baseline.today.peakOutputTps).toBe(10);
    await appendFile(
      file,
      `${JSON.stringify(response("old-backfill", NOW - 60 * 60_000, 600, { duration: 3_000 }))}\n`,
    );
    const backfill = await current.poll();
    expect(backfill.today.peakOutputTps).toBe(200);
    expect(backfill.activity).toEqual({
      lastResponseAt: NOW - 57_000,
      peakAt: NOW - 60 * 60_000 + 3_000,
      peakObservedAt: NOW - 60 * 60_000 + 3_000,
    });
    now += 1_000;
    await appendFile(
      file,
      `${JSON.stringify(response("fresh", now - 3_000, 900, { duration: 3_000 }))}\n`,
    );
    const fresh = await current.poll();
    expect(fresh.today.peakOutputTps).toBe(300);
    expect(fresh.activity).toEqual({
      lastResponseAt: now,
      peakAt: now,
      peakObservedAt: now,
    });
    expect(current.getSnapshot()).toBe(fresh);
    expect((await current.poll()).activity).toEqual(fresh.activity);
  });

  it("attributes an earlier winning window to a genuinely fresh long response that contributed to it", async () => {
    const root = await directory();
    const file = await session(root, "main.jsonl", [
      header(NOW - 10 * 60_000),
      response("earlier-burst", NOW - 110_000, 600, { duration: 3_000 }),
      response("later-small-call", NOW - 5_000, 5),
    ]);
    const current = monitor(root);
    const before = await current.poll();
    expect(before.today.peakOutputTps).toBe(200);
    expect(before.activity).toEqual({
      lastResponseAt: NOW - 4_000,
      peakAt: NOW - 107_000,
      peakObservedAt: NOW - 107_000,
    });
    await appendFile(
      file,
      `${JSON.stringify(response("long-completion", NOW - 120_000, 12_000, { duration: 120_000 }))}\n`,
    );
    const completed = await current.poll();
    expect(completed.today.peakOutputTps).toBe(300);
    expect(completed.activity).toEqual({
      lastResponseAt: NOW,
      peakAt: NOW - 107_000,
      peakObservedAt: NOW,
    });
  });

  it("keeps the earliest tied peak window and its contributing completion across sparse long intervals", async () => {
    const root = await directory();
    await session(root, "main.jsonl", [
      header(NOW - 180_000),
      response("first-plateau", NOW - 120_000, 3_000, { duration: 30_000 }),
      response("equal-later-plateau", NOW - 30_000, 3_000, { duration: 30_000 }),
    ]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.today.peakOutputTps).toBe(100);
    expect(snapshot.activity).toEqual({
      lastResponseAt: NOW,
      peakAt: NOW - 117_000,
      peakObservedAt: NOW - 90_000,
    });
  });

  it("retains partial-second peak math and completion provenance beyond the winning window", async () => {
    const root = await directory();
    await session(root, "main.jsonl", [
      header(),
      response("fractional-buckets", NOW - 3_750, 350, { duration: 3_500 }),
    ]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.today.peakOutputTps).toBeCloseTo(275 / 3);
    expect(snapshot.activity).toEqual({
      lastResponseAt: NOW - 250,
      peakAt: NOW - 1_000,
      peakObservedAt: NOW - 250,
    });
  });

  it("bounds speed to valid native timing, normalizes short calls and never parses string TTFT", async () => {
    const root = await directory();
    await session(root, "main.jsonl", [
      header(NOW - 2_000_000),
      response("short", NOW - 10_000, 10, { duration: 0 }),
      response("no-duration", NOW - 8_000, 10, { duration: undefined, completedAt: NOW - 7_000 }),
      response("too-long", NOW - 1_000_000, 10, { duration: 900_001 }),
      response("invalid", NOW - 6_000, 10, { duration: -1 }),
      response("failed", NOW - 5_000, 10, { stopReason: "error" }),
      response("last", NOW - 2_000, 10, { duration: undefined, ttft: "50" }),
    ]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.today).toMatchObject({
      requests: 6,
      failedRequests: 1,
      measuredOutputTokens: 10,
      measuredDurationMs: 500,
    });
    expect(snapshot.agents[0]!.ttftMs).toBeNull();
    expect(snapshot.agents[0]!.outputTps).toBe(20);
  });

  it("handles pause_turn, errors and process exit, and makes silent generation idle after five minutes", async () => {
    const root = await directory();
    let now = NOW;
    const file = await session(root, "main.jsonl", [
      header(),
      response("pause", NOW - 2_000, 100, { stopDetails: { type: "pause_turn" } }),
    ]);
    const current = monitor(root, () => now);
    expect((await current.poll()).agents[0]!.phase).toBe("generating");
    now += 300_001;
    const idle = await current.poll();
    expect(idle.agents[0]!.phase).toBe("idle");
    expect(idle.rate.estimatedTps).toBe(0);
    await appendFile(file, `${JSON.stringify(event("developer", now, { role: "developer" }))}\n`);
    expect((await current.poll()).agents[0]!.phase).toBe("generating");
    await appendFile(
      file,
      `${JSON.stringify({ type: "custom", id: "exit", customType: "session_exit", timestamp: new Date(now + 1).toISOString() })}\n`,
    );
    expect((await current.poll()).agents[0]!.phase).toBe("idle");
  });

  it("uses last-three agent references and a model fallback without treating side calls as speed references", async () => {
    const root = await directory();
    await session(root, "main.jsonl", [
      header(),
      response("old", NOW - 20_000, 1_000),
      response("one", NOW - 15_000, 10),
      response("two", NOW - 10_000, 20),
      response("three", NOW - 5_000, 30),
    ]);
    await session(root, "main/child.jsonl", [
      header(),
      event("user", NOW - 1_000, { role: "user" }),
    ]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.agents.find((agent) => agent.kind === "main")!.outputTps).toBe(20);
    expect(snapshot.agents.find((agent) => agent.kind === "subagent")!.outputTps).toBe(265);
    expect(snapshot.rate.estimatedTps).toBeCloseTo(265 / 3);
  });

  it("keeps event provenance scoped and invalidates each cached scope after a real completion", async () => {
    const first = await directory();
    const second = await directory();
    let now = NOW;
    const file = await session(first, "main.jsonl", [
      header(),
      response("first-profile", NOW - 33_000, 300, { duration: 3_000 }),
    ]);
    await session(second, "other.jsonl", [
      header(NOW - 60_000, "/private/project-beta"),
      response("second-profile", NOW - 13_000, 600, { duration: 3_000 }),
    ]);
    const current = new OmpLocalMonitor({
      roots: [
        { path: first, label: "default" },
        { path: second, label: "work" },
      ],
      now: () => now,
    });
    monitors.push(current);
    const all = await current.poll();
    const firstProject = all.scopes.projects.find((label) => label.startsWith("project-alpha ["))!;
    const secondProject = all.scopes.projects.find((label) => label.startsWith("project-beta ["))!;
    const firstScope = { profile: "default", project: firstProject };
    const secondScope = { profile: "work", project: secondProject };
    const firstSnapshot = current.getSnapshot(firstScope);
    const secondSnapshot = current.getSnapshot(secondScope);
    expect(all.activity).toEqual(secondSnapshot.activity);
    expect(firstSnapshot.today.peakOutputTps).toBe(100);
    expect(firstSnapshot.activity).toEqual({
      lastResponseAt: NOW - 30_000,
      peakAt: NOW - 30_000,
      peakObservedAt: NOW - 30_000,
    });
    expect(secondSnapshot.today.peakOutputTps).toBe(200);
    expect(secondSnapshot.activity).toEqual({
      lastResponseAt: NOW - 10_000,
      peakAt: NOW - 10_000,
      peakObservedAt: NOW - 10_000,
    });
    expect(current.getSnapshot({ profile: "default", project: secondProject }).activity).toEqual({
      lastResponseAt: null,
      peakAt: null,
      peakObservedAt: null,
    });
    expect(current.getSnapshot(firstScope)).toBe(firstSnapshot);
    now += 1_000;
    await appendFile(
      file,
      `${JSON.stringify(response("fresh-first-profile", now - 3_000, 900, { duration: 3_000 }))}\n`,
    );
    await current.poll();
    expect(current.getSnapshot(firstScope)).toMatchObject({
      today: { requests: 2, peakOutputTps: 300 },
      activity: { lastResponseAt: now, peakAt: now, peakObservedAt: now },
    });
    expect(current.getSnapshot(secondScope).activity).toEqual(secondSnapshot.activity);
    expect(current.getSnapshot(secondScope).today.peakOutputTps).toBe(200);
    expect(current.getSnapshot().activity).toEqual({
      lastResponseAt: now,
      peakAt: now,
      peakObservedAt: now,
    });
  });

  it("filters every numeric projection by profile/project using one retained filesystem state", async () => {
    const first = await directory();
    const second = await directory();
    await session(first, "main.jsonl", [
      header(),
      response("first", NOW - 3_000, 300, { duration: 3_000 }),
    ]);
    await session(first, "main/child.jsonl", [
      { ...header(), cwd: undefined },
      response("child", NOW - 3_000, 60, { duration: 3_000 }),
    ]);
    await session(second, "other.jsonl", [
      header(NOW - 60_000, "/private/project-beta"),
      response("second", NOW - 3_000, 150, { duration: 3_000 }),
    ]);
    const current = new OmpLocalMonitor({
      roots: [
        { path: first, label: "default" },
        { path: second, label: "work" },
      ],
      now: () => NOW,
    });
    monitors.push(current);
    const all = await current.poll();
    expect(all.today.requests).toBe(3);
    const project = all.scopes.projects.find((label) => label.startsWith("project-alpha ["))!;
    const scoped = current.getSnapshot({ profile: "default", project });
    expect(scoped.today).toMatchObject({ requests: 2, outputTokens: 360 });
    expect(scoped.rate.measuredTps).toBe(120);
    expect(scoped.agents).toHaveLength(2);
    expect(scoped.days.at(-1)!.requests).toBe(2);
    expect(scoped.series.find((point) => point.timestamp === NOW - 1_000)!.measuredTps).toBe(120);
    expect(scoped.scopes.profiles).toEqual(["default", "work"]);
    expect(scoped.scopes.projects).toEqual([
      expect.stringMatching(/^project-alpha \[[a-f0-9]{12}\]$/),
      expect.stringMatching(/^project-beta \[[a-f0-9]{12}\]$/),
    ]);
    expect(current.getSnapshot({ profile: "work", project: null }).today.requests).toBe(1);
  });

  it("isolates unrelated actual cwd directories with the same basename using stable hashed project scopes", async () => {
    const first = await directory();
    const second = await directory();
    const firstCwd = path.join(first, "workspace", "repo");
    const secondCwd = path.join(second, "workspace", "repo");
    await mkdir(firstCwd, { recursive: true });
    await mkdir(secondCwd, { recursive: true });
    await session(first, "main.jsonl", [
      header(NOW - 60_000, firstCwd),
      response("first-repo", NOW - 3_000, 300, { duration: 3_000 }),
    ]);
    await session(second, "main.jsonl", [
      header(NOW - 60_000, secondCwd),
      response("second-repo", NOW - 3_000, 150, { duration: 3_000 }),
    ]);
    const current = new OmpLocalMonitor({
      roots: [
        { path: first, label: "default" },
        { path: second, label: "work" },
      ],
      now: () => NOW,
    });
    monitors.push(current);
    const all = await current.poll();
    expect(all.scopes.projects).toHaveLength(2);
    expect(all.scopes.projects.every((label) => /^repo \[[a-f0-9]{12}\]$/.test(label))).toBe(true);
    const firstProject = all.agents.find((agent) => agent.profile === "default")!.project;
    const secondProject = all.agents.find((agent) => agent.profile === "work")!.project;
    expect(firstProject).not.toBe(secondProject);
    expect(current.getSnapshot({ profile: null, project: firstProject })).toMatchObject({
      today: { requests: 1, outputTokens: 300 },
      rate: { measuredTps: 100 },
    });
    expect(current.getSnapshot({ profile: null, project: secondProject })).toMatchObject({
      today: { requests: 1, outputTokens: 150 },
      rate: { measuredTps: 50 },
    });
    expect((await current.poll()).scopes.projects).toEqual(all.scopes.projects);
    expect(JSON.stringify(all)).not.toContain(firstCwd);
    expect(JSON.stringify(all)).not.toContain(secondCwd);
  });

  it("preserves partial UTF-8 lines until newline and does not drop the first complete append", async () => {
    const root = await directory();
    const file = await session(root, "main.jsonl", [header()]);
    const line = Buffer.from(
      JSON.stringify(
        response("unicode", NOW - 2_000, 12, { content: [{ type: "text", text: "中文" }] }),
      ) + "\n",
    );
    const split = line.indexOf(Buffer.from("中")) + 1;
    await appendFile(file, line.subarray(0, split));
    const current = monitor(root);
    expect((await current.poll()).today.requests).toBe(0);
    await appendFile(file, line.subarray(split, line.length - 1));
    expect((await current.poll()).today.requests).toBe(0);
    await appendFile(file, "\n");
    const completed = await current.poll();
    expect(completed.today).toMatchObject({ requests: 1, outputTokens: 12 });
    expect(completed.coverage.malformedLines).toBe(0);
    await appendFile(file, `${JSON.stringify(response("next", NOW - 1_000, 15))}\n`);
    expect((await current.poll()).today.requests).toBe(2);
  });

  it("reconciles truncation, renamed replacements and fixed-size title overwrites without retaining removed totals", async () => {
    const root = await directory();
    const title =
      JSON.stringify({ type: "title", title: "old private title" }).padEnd(255, " ") + "\n";
    const file = await session(root, "main.jsonl", [header(), response("old", NOW - 4_000, 10)]);
    await writeFile(
      file,
      title + `${JSON.stringify(header())}\n${JSON.stringify(response("old", NOW - 4_000, 10))}\n`,
    );
    const current = monitor(root);
    expect((await current.poll()).today.outputTokens).toBe(10);
    const handle = await open(file, "r+");
    try {
      await handle.write(
        JSON.stringify({ type: "title", title: "new private title" }).padEnd(255, " ") + "\n",
        0,
        "utf8",
      );
    } finally {
      await handle.close();
    }
    expect((await current.poll()).today).toMatchObject({ requests: 1, outputTokens: 10 });
    await writeFile(
      file,
      `${JSON.stringify(header())}\n${JSON.stringify(response("replacement", NOW - 2_000, 20))}\n`,
    );
    expect((await current.poll()).today).toMatchObject({ requests: 1, outputTokens: 20 });
    const replacement = `${file}.new`;
    await writeFile(
      replacement,
      `${JSON.stringify(header())}\n${JSON.stringify(response("renamed", NOW - 1_000, 30))}\n`,
    );
    await rm(file);
    await rename(replacement, file);
    expect((await current.poll()).today).toMatchObject({ requests: 1, outputTokens: 30 });
    await rm(file);
    expect((await current.poll({ refresh: true })).today.requests).toBe(0);
  });

  it("re-discovers new children, skips hidden/backups, and does not follow directory links", async () => {
    const root = await directory();
    const outside = await directory();
    await session(root, "main.jsonl", [header(), response("main", NOW - 2_000)]);
    await session(root, ".hidden.jsonl", [header(), response("hidden", NOW - 2_000)]);
    await session(root, ".hidden/inside.jsonl", [header(), response("hidden-dir", NOW - 2_000)]);
    await session(root, "backup.jsonl.id.bak", [header(), response("backup", NOW - 2_000)]);
    await session(outside, "secret.jsonl", [header(), response("outside", NOW - 2_000)]);
    await symlink(
      outside,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    let now = NOW;
    const current = monitor(root, () => now);
    expect((await current.poll()).today.requests).toBe(1);
    await session(root, "main/new-child.jsonl", [header(), response("child", NOW - 1_000)]);
    now += 10_001;
    expect((await current.poll()).today.requests).toBe(2);
  });

  it("reports partial coverage for malformed UTF-8/JSON and line, record and depth caps", async () => {
    const root = await directory();
    Object.assign(MONITOR_LIMITS, { lineBytes: 1_000, records: 2 });
    const file = await session(root, "main.jsonl", [
      header(),
      response("one", NOW - 4_000),
      response("two", NOW - 3_000),
      response("three", NOW - 2_000),
    ]);
    await appendFile(file, Buffer.from([0xff, 10]));
    await appendFile(file, `[]\nnot-json\n${"x".repeat(1_001)}\n`);
    await session(root, "a/b/c/d/e/f/too-deep.jsonl", [header(), response("deep", NOW - 1_000)]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.status).toBe("partial");
    expect(snapshot.coverage).toMatchObject({ limited: true, malformedLines: 3 });
    expect(snapshot.coverage.issues).toEqual(
      expect.arrayContaining(["line_limit", "record_limit", "file_limit"]),
    );
    expect(snapshot.today.requests).toBe(2);
  });

  it("finishes an initial file backlog instead of forever statting the first recently modified files", async () => {
    const root = await directory();
    Object.assign(MONITOR_LIMITS, { pollFiles: 2 });
    for (let index = 0; index < 5; index++)
      await session(root, `${index}.jsonl`, [header(), response(`call-${index}`, NOW - 2_000, 1)]);
    const current = monitor(root);
    expect((await current.poll()).coverage.issues).toContain("scan_pending");
    await current.poll();
    const completed = await current.poll();
    expect(completed.today.requests).toBe(5);
    expect(completed.status).toBe("ready");
  });

  it("shows fresh sessions and newly discovered children ahead of a large old-log backlog", async () => {
    const root = await directory();
    Object.assign(MONITOR_LIMITS, { pollFiles: 2, pollBytes: 2_048, perFileBytes: 1_024 });
    const old = await session(root, "old.jsonl", [
      header(),
      {
        type: "custom",
        id: "large-old-record",
        timestamp: new Date(NOW - 30_000).toISOString(),
        content: "old".repeat(4_000),
      },
      response("old-response", NOW - 20_000, 1),
    ]);
    const main = await session(root, "main.jsonl", [header(), response("fresh", NOW - 2_000, 99)]);
    await utimes(old, new Date(NOW - 86_400_000), new Date(NOW - 86_400_000));
    await utimes(main, new Date(NOW - 1_000), new Date(NOW - 1_000));
    const current = monitor(root);
    const first = await current.poll();
    expect(first.today.outputTokens).toBe(99);
    // The controller/renderer hide "scanning" feeds; valid live facts must stay consumable.
    expect(first.status).toBe("partial");
    expect(first.rate.measuredTps).toBeCloseTo(33);
    expect(first.rate.estimatedTps).toBe(0);
    expect(first.coverage.issues).toContain("scan_pending");
    const child = await session(root, "main/child.jsonl", [
      header(),
      response("new-child", NOW - 1_000, 100),
    ]);
    await utimes(child, new Date(NOW), new Date(NOW));
    const next = await current.poll({ refresh: true });
    expect(next.today.outputTokens).toBe(199);
    expect(next.status).toBe("partial");
    expect(next.rate.measuredTps).toBeCloseTo(199 / 3);
    expect(next.agents.some((agent) => agent.kind === "subagent" && agent.parentId)).toBe(true);
    expect(next.coverage.issues).toContain("scan_pending");
  });

  it("reads a recent >8 MiB file's numeric tail immediately while disjoint history catches up", async () => {
    const root = await directory();
    let now = NOW;
    const latest = {
      ...response("tail-revision", NOW - 3_000, 300, {
        duration: 3_000,
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "tail-tool" }],
      }),
      timestamp: new Date(NOW).toISOString(),
    };
    const tailPadding = {
      type: "custom",
      id: "tail-window-padding",
      timestamp: new Date(NOW - 30_000).toISOString(),
      content: "",
    };
    // Exactly one MiB after the prefix newline exercises the already-aligned split too.
    tailPadding.content = "y".repeat(
      1_024 * 1_024 -
        Buffer.byteLength(JSON.stringify(tailPadding)) -
        1 -
        Buffer.byteLength(JSON.stringify(latest)) -
        1,
    );
    const file = await session(root, "large.jsonl", [
      header(NOW - 120_000),
      response("tail-revision", NOW - 3_000, 10, { duration: 3_000 }),
      response("old-peak", NOW - 60_000, 9_000),
      // A prefix timestamp must not override tail state even if it is later by wall clock.
      event("historical-user", NOW + 5_000, { role: "user" }),
      largeHistoryPadding(),
      tailPadding,
      latest,
    ]);
    await utimes(file, new Date(NOW), new Date(NOW));
    expect((await stat(file)).size).toBeGreaterThan(MONITOR_LIMITS.pollBytes);
    const current = monitor(root, () => now);
    const first = await current.poll();
    expect(first.status).toBe("partial");
    expect(first.coverage.issues).toEqual(["scan_pending"]);
    expect(first.rate.measuredTps).toBeCloseTo(100);
    expect(first.rate.estimatedTps).toBe(0);
    expect(first.today).toMatchObject({ requests: 2, outputTokens: 9_300, peakOutputTps: 3_000 });
    expect(first.agents[0]).toMatchObject({ phase: "tools", lastActivityAt: NOW });
    expect(first.activity).toEqual({
      lastResponseAt: null,
      peakAt: NOW - 59_000,
      peakObservedAt: null,
    });

    now += 1_000;
    await appendFile(
      file,
      `${JSON.stringify(event("tail-result", now, { role: "toolResult", toolCallId: "tail-tool" }))}\n`,
    );
    expect((await current.poll()).agents[0]!.phase).toBe("generating");
    now += 1_000;
    await appendFile(file, `${JSON.stringify(response("actual-append", now - 1_000, 60))}\n`);
    const live = await current.poll();
    expect(live.status).toBe("partial");
    expect(live.today).toMatchObject({ requests: 3, outputTokens: 9_360 });
    expect(live.agents[0]).toMatchObject({ phase: "idle", lastActivityAt: now });
    expect(live.activity.lastResponseAt).toBe(now);
    expect(live.activity.peakObservedAt).toBeNull();

    let completed = live;
    for (let poll = 0; poll < 8 && completed.coverage.issues.includes("scan_pending"); poll++) {
      completed = await current.poll();
      expect(completed.today).toMatchObject({ requests: 3, outputTokens: 9_360 });
      expect(completed.agents[0]).toMatchObject({ phase: "idle", lastActivityAt: now });
      expect(completed.activity).toEqual(live.activity);
    }
    expect(completed.status).toBe("ready");
    expect(completed.coverage).toMatchObject({ malformedLines: 0, limited: false });
    expect(JSON.stringify(completed)).not.toContain("fixture-history-padding");
    now += 3_001;
    expect((await current.poll()).rate).toEqual({
      measuredTps: 0,
      estimatedTps: 0,
      estimatedShare: 0,
      measuredThinkingTps: null,
      estimatedThinkingTps: null,
    });
  });

  it("resets both large-file cursors and pending fragments on replacement and truncation", async () => {
    const root = await directory();
    Object.assign(MONITOR_LIMITS, { pendingBytes: 9 * 1_024 * 1_024 + 512 });
    const file = await session(root, "replace.jsonl", [
      header(),
      largeHistoryPadding(),
      response("before-replacement", NOW - 1_000, 99),
    ]);
    await utimes(file, new Date(NOW), new Date(NOW));
    const current = monitor(root);
    expect((await current.poll()).today).toMatchObject({ requests: 1, outputTokens: 99 });
    // Leave fragments in both the unfinished history line and the live tail.
    await appendFile(file, `{"type":"message","id":"${"q".repeat(1_024)}`);
    await current.poll();
    await rename(file, `${file}.backup`);
    await session(root, "replace.jsonl", [
      header(),
      largeHistoryPadding(),
      response("after-replacement", NOW - 1_000, 77),
    ]);
    await utimes(file, new Date(NOW), new Date(NOW));
    let replaced = await current.poll({ refresh: true });
    expect(replaced.status).toBe("partial");
    expect(replaced.today).toMatchObject({ requests: 1, outputTokens: 77 });
    expect(replaced.activity.lastResponseAt).toBeNull();
    for (let poll = 0; poll < 8 && replaced.coverage.issues.includes("scan_pending"); poll++)
      replaced = await current.poll();
    expect(replaced.status).toBe("ready");
    expect(replaced.coverage).toMatchObject({ malformedLines: 0, limited: false });
    expect(replaced.today).toMatchObject({ requests: 1, outputTokens: 77 });

    await appendFile(file, `{"type":"message","id":"${"r".repeat(1_024)}`);
    await current.poll();
    await writeFile(
      file,
      `${JSON.stringify(header())}\n${JSON.stringify(response("after-truncation", NOW - 1_000, 5))}\n`,
    );
    const truncated = await current.poll();
    expect(truncated.status).toBe("ready");
    expect(truncated.today).toMatchObject({ requests: 1, outputTokens: 5 });
    expect(truncated.agents[0]!.phase).toBe("idle");
    expect(truncated.coverage).toMatchObject({ malformedLines: 0, limited: false });
  });

  it("promotes an unfinished historical file when it becomes active without replaying its prefix", async () => {
    const root = await directory();
    let now = NOW;
    const file = await session(root, "resumed.jsonl", [
      header(),
      largeHistoryPadding(),
      response("resumed-history", NOW - 20_000, 1),
    ]);
    await utimes(file, new Date(NOW - 86_400_000), new Date(NOW - 86_400_000));
    const current = monitor(root, () => now);
    const historical = await current.poll();
    expect(historical.today.requests).toBe(0);
    expect(historical.coverage.issues).toContain("scan_pending");
    now += 1_000;
    await appendFile(file, `${JSON.stringify(response("resumed-current", now - 1_000, 99))}\n`);
    await utimes(file, new Date(now), new Date(now));
    const promoted = await current.poll({ refresh: true });
    expect(promoted.status).toBe("partial");
    expect(promoted.rate.measuredTps).toBeCloseTo(33);
    expect(promoted.today).toMatchObject({ requests: 2, outputTokens: 100 });
    expect(promoted.agents[0]).toMatchObject({ phase: "idle", lastActivityAt: now });
    expect(promoted.activity.lastResponseAt).toBeNull();
    now += 1_000;
    await appendFile(file, `${JSON.stringify(response("resumed-append", now - 1_000, 3))}\n`);
    const appended = await current.poll();
    expect(appended.today).toMatchObject({ requests: 3, outputTokens: 103 });
    expect(appended.activity.lastResponseAt).toBe(now);
  });

  it.each(["reconcile", "newer-completion"] as const)(
    "reconciles multi-tool state across the physical split without rewinding a %s",
    async (mode) => {
      const root = await directory();
      let now = NOW;
      const file = await session(root, "split-tools.jsonl", [
        header(),
        response("prefix-tools", NOW - 20_000, 100, {
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "split-a" },
            { type: "toolCall", id: "split-b" },
          ],
        }),
        event("large-result-a", NOW - 2_000, {
          role: "toolResult",
          toolCallId: "split-a",
          content: "x".repeat(3 * 1_024 * 1_024),
        }),
        event("small-result-b", NOW - 1_000, { role: "toolResult", toolCallId: "split-b" }),
      ]);
      await utimes(file, new Date(NOW), new Date(NOW));
      const current = monitor(root, () => now);
      let snapshot = await current.poll();
      expect(snapshot.status).toBe("partial");
      expect(snapshot.agents[0]).toMatchObject({ phase: "tools", lastActivityAt: NOW - 1_000 });
      if (mode === "newer-completion") {
        now += 1_000;
        await appendFile(file, `${JSON.stringify(response("newer-terminal", now - 1_000, 25))}\n`);
      }
      for (let poll = 0; poll < 5 && snapshot.coverage.issues.includes("scan_pending"); poll++)
        snapshot = await current.poll();
      expect(snapshot.status).toBe("ready");
      expect(snapshot.coverage).toMatchObject({ limited: false, malformedLines: 0 });
      if (mode === "reconcile") {
        expect(snapshot.agents[0]).toMatchObject({
          phase: "generating",
          lastActivityAt: NOW - 1_000,
        });
        expect(snapshot.rate.measuredTps).toBe(0);
        expect(snapshot.rate.estimatedTps).toBeCloseTo(100 / 3);
        expect(snapshot.activity.lastResponseAt).toBeNull();
      } else {
        expect(snapshot.agents[0]).toMatchObject({ phase: "idle", lastActivityAt: now });
        expect(snapshot.rate.estimatedTps).toBe(0);
        expect(snapshot.activity.lastResponseAt).toBe(now);
      }
    },
  );

  it("treats a large line completed beyond initial EOF as a real append even through the prefix cursor", async () => {
    const root = await directory();
    let now = NOW;
    const file = await session(root, "unfinished-response.jsonl", [
      header(),
      event("unfinished-prompt", NOW - 1_000, { role: "user" }),
    ]);
    const line = JSON.stringify(
      response("unfinished-completion", NOW, 120, {
        completedAt: NOW + 1_000,
        content: [{ type: "text", text: "z".repeat(3 * 1_024 * 1_024) }],
      }),
    );
    await appendFile(file, line.slice(0, -100));
    await utimes(file, new Date(NOW), new Date(NOW));
    const current = monitor(root, () => now);
    const unfinished = await current.poll();
    expect(unfinished.status).toBe("partial");
    expect(unfinished.today.requests).toBe(0);
    expect(unfinished.agents[0]!.phase).toBe("generating");
    expect(unfinished.activity.lastResponseAt).toBeNull();
    now += 1_000;
    await appendFile(file, `${line.slice(-100)}\n`);
    let completed = await current.poll();
    for (let poll = 0; poll < 4 && completed.coverage.issues.includes("scan_pending"); poll++)
      completed = await current.poll();
    expect(completed.status).toBe("ready");
    expect(completed.today).toMatchObject({ requests: 1, outputTokens: 120 });
    expect(completed.rate.measuredTps).toBeCloseTo(40);
    expect(completed.rate.estimatedTps).toBe(0);
    expect(completed.agents[0]).toMatchObject({ phase: "idle", lastActivityAt: now });
    expect(completed.activity.lastResponseAt).toBe(now);
    expect(completed.activity.peakObservedAt).toBe(now);
    expect((await current.poll()).today.requests).toBe(1);
  });

  it("does not upgrade a captured completion or rewind tool state when its record is replayed", async () => {
    const root = await directory();
    let now = NOW;
    const current = monitor(root, () => now);
    await current.poll();
    const captured = response("captured-completion", NOW - 1_000, 300, {
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "captured-tool" }],
    });
    const file = await session(root, "captured.jsonl", [header(), largeHistoryPadding(), captured]);
    await utimes(file, new Date(NOW), new Date(NOW));
    const baseline = await current.poll({ refresh: true });
    expect(baseline.today).toMatchObject({ requests: 1, outputTokens: 300 });
    expect(baseline.activity.lastResponseAt).toBeNull();
    expect(baseline.activity.peakObservedAt).toBeNull();
    now += 500;
    const resultAt = now;
    await appendFile(
      file,
      `${JSON.stringify(
        event("captured-result", resultAt, {
          role: "toolResult",
          toolCallId: "captured-tool",
        }),
      )}\n`,
    );
    expect((await current.poll()).agents[0]!.phase).toBe("generating");
    now += 500;
    await appendFile(file, `${JSON.stringify(captured)}\n`);
    const replay = await current.poll();
    expect(replay.today).toMatchObject({ requests: 1, outputTokens: 300 });
    expect(replay.activity.lastResponseAt).toBeNull();
    expect(replay.activity.peakObservedAt).toBeNull();
    expect(replay.agents[0]).toMatchObject({ phase: "generating", lastActivityAt: resultAt });
    now += 500;
    await appendFile(
      file,
      `${JSON.stringify({ ...captured, timestamp: new Date(now).toISOString() })}\n`,
    );
    const rewrapped = await current.poll();
    expect(rewrapped.activity.lastResponseAt).toBeNull();
    expect(rewrapped.activity.peakObservedAt).toBeNull();
    expect(rewrapped.agents[0]).toMatchObject({ phase: "generating", lastActivityAt: resultAt });
    // A genuinely revised completion can qualify; it is still the same billed request.
    now += 500;
    await appendFile(
      file,
      `${JSON.stringify(response("captured-completion", NOW - 1_000, 600))}\n`,
    );
    const revised = await current.poll();
    expect(revised.today).toMatchObject({ requests: 1, outputTokens: 600 });
    expect(revised.activity.lastResponseAt).toBe(NOW);
    expect(revised.activity.peakObservedAt).toBe(NOW);
    expect(revised.agents[0]!.phase).toBe("idle");
  });

  it("resets current-day peak provenance at local midnight without losing retained completion times", async () => {
    const root = await directory();
    const day = new Date(NOW);
    day.setHours(0, 0, 0, 0);
    const midnight = day.getTime();
    let now = midnight + 1_000;
    await session(root, "main.jsonl", [
      header(midnight - 60_000),
      response("cross-midnight", midnight - 2_000, 600, { duration: 3_000 }),
    ]);
    const current = monitor(root, () => now);
    const completed = await current.poll();
    expect(completed.days.at(-2)!.peakOutputTps).toBeCloseTo(400 / 3);
    expect(completed.today).toMatchObject({ requests: 1, measuredDurationMs: 3_000 });
    expect(completed.today.peakOutputTps).toBeCloseTo(200 / 3);
    expect(completed.activity).toEqual({
      lastResponseAt: midnight + 1_000,
      peakAt: midnight + 1_000,
      peakObservedAt: midnight + 1_000,
    });
    day.setDate(day.getDate() + 1);
    now = day.getTime() + 1_000;
    const nextDay = await current.poll();
    expect(nextDay.today).toMatchObject({ requests: 0, peakOutputTps: 0 });
    expect(nextDay.activity).toEqual({
      lastResponseAt: midnight + 1_000,
      peakAt: null,
      peakObservedAt: null,
    });
    expect(nextDay.days.at(-2)!.peakOutputTps).toBeCloseTo(200 / 3);
  });

  it("uses local calendar retention, keeps inactive ancestors, and expires numeric records without a ledger", async () => {
    const root = await directory();
    let now = NOW;
    const oldDay = new Date(NOW);
    oldDay.setDate(oldDay.getDate() - 30);
    await session(root, "main.jsonl", [
      header(NOW - 86_400_000),
      response("old-parent", NOW - 8 * 60 * 60_000),
    ]);
    await session(root, "main/child.jsonl", [header(), response("new-child", NOW - 1_000)]);
    await session(root, "expired.jsonl", [
      header(oldDay.getTime() - 10_000),
      response("outside-history", oldDay.getTime()),
    ]);
    const current = monitor(root, () => now);
    const first = await current.poll();
    expect(first.today.requests).toBe(2);
    expect(first.agents).toHaveLength(2);
    expect(first.agents[1]!.parentId).toBe(first.agents[0]!.id);
    now += 31 * 86_400_000;
    const expired = await current.poll();
    expect(expired.days.every((day) => day.requests === 0)).toBe(true);
    expect(expired.activity).toEqual({
      lastResponseAt: null,
      peakAt: null,
      peakObservedAt: null,
    });
  });

  it("rejects non-numeric usage guards and caps hostile numeric facts safely", async () => {
    const root = await directory();
    await session(root, "main.jsonl", [
      header(),
      response("guard", NOW - 5_000, 1, { provider: undefined }),
      response("bad-values", NOW - 4_000, 1, {
        usage: { input: "50", output: -7, cacheRead: false, cacheWrite: null },
      }),
      response("capped", NOW - 2_000, 1, {
        usage: { input: 1e20, output: 12.9, cacheRead: 0, cacheWrite: 0, cost: { total: -1 } },
      }),
    ]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.today).toMatchObject({
      requests: 1,
      inputTokens: 1_000_000_000_000,
      outputTokens: 12,
      totalTokens: 1_000_000_000_000,
      costUsd: 0,
      unpricedRequests: 1,
    });
    expect(
      Object.values(snapshot.today).every((value) => Number.isFinite(value) && value >= 0),
    ).toBe(true);
  });

  it("reports the exact file cap as partial rather than silently omitting a queued child directory", async () => {
    const root = await directory();
    Object.assign(MONITOR_LIMITS, { files: 2 });
    await session(root, "one.jsonl", [header(), response("one", NOW - 3_000)]);
    await session(root, "two.jsonl", [header(), response("two", NOW - 2_000)]);
    await session(root, "one/child.jsonl", [header(), response("child", NOW - 1_000)]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.status).toBe("partial");
    expect(snapshot.coverage.issues).toContain("file_limit");
    expect(snapshot.coverage.discoveredFiles).toBeLessThanOrEqual(2);
  });

  it("caps pending tool state globally without claiming a forgotten batch has completed", async () => {
    const root = await directory();
    Object.assign(MONITOR_LIMITS, { pendingTools: 1 });
    const main = await session(root, "main.jsonl", [
      header(),
      response("main", NOW - 3_000, 100, {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "first" }],
      }),
    ]);
    const current = monitor(root);
    await current.poll();
    const child = await session(root, "main/child.jsonl", [
      header(),
      response("child", NOW - 2_000, 100, {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "second" }],
      }),
    ]);
    const capped = await current.poll({ refresh: true });
    expect(capped.today.requests).toBe(2);
    expect(capped.coverage.issues).toContain("record_limit");
    expect(capped.agents.every((agent) => agent.phase === "tools")).toBe(true);
    await appendFile(
      main,
      `${JSON.stringify(event("first-result", NOW - 500, { role: "toolResult", toolCallId: "first" }))}\n`,
    );
    await appendFile(
      child,
      `${JSON.stringify(event("second-result", NOW - 500, { role: "toolResult", toolCallId: "second" }))}\n`,
    );
    const finished = await current.poll();
    expect(finished.agents.find((agent) => agent.kind === "main")!.phase).toBe("generating");
    expect(finished.agents.find((agent) => agent.kind === "subagent")!.phase).toBe("tools");
  });

  it("reprices retained numeric facts by catalog version without replacing recorded cost or rescanning files", async () => {
    const root = await directory();
    await session(root, "main.jsonl", [
      header(),
      response("known", NOW - 3_000, 10, { serviceTier: "priority" }),
      response("free", NOW - 2_000, 10, {
        model: "free",
        usage: { input: 1, output: 10, cost: { total: 0 } },
      }),
      response("unknown", NOW - 1_000, 10, { model: "unknown", usage: { input: 1, output: 10 } }),
    ]);
    let version = "fixture-1";
    let multiplier = 1;
    const inputs: OmpMonitorCostInput[] = [];
    const current = new OmpLocalMonitor({
      roots: [{ path: root, label: "default" }],
      now: () => NOW,
      getPricing: () => {
        const state = getBundledPricingState();
        return { ...state, prices: { ...state.prices, version } };
      },
      estimateCost: (input) => {
        inputs.push(input);
        if (input.model === "unknown") return null;
        if (input.model === "free") return 0;
        return 0.25 * multiplier;
      },
    });
    monitors.push(current);
    const first = await current.poll();
    expect(first.today).toMatchObject({
      costUsd: 1,
      unpricedRequests: 1,
      estimatedCostUsd: 0.25,
      unestimatedRequests: 1,
    });
    expect(
      inputs.some((input) => input.provider === "fixture" && input.serviceTier === "priority"),
    ).toBe(true);
    expect((await current.poll()).today.estimatedCostUsd).toBe(0.25);

    version = "fixture-2";
    multiplier = 2;
    expect(current.getSnapshot().today).toMatchObject({
      costUsd: 1,
      unpricedRequests: 1,
      estimatedCostUsd: 0.5,
      unestimatedRequests: 1,
    });

    expect(current.getSnapshot().activity).toEqual(first.activity);
  });
});

describe("actual OMP root conventions", () => {
  it("keeps the agent override separate from named profiles and ignores XDG on Windows", async () => {
    const home = await directory();
    const override = path.join(home, "custom-agent");
    await mkdir(path.join(home, ".custom-omp", "profiles", "work", "agent", "sessions"), {
      recursive: true,
    });
    await mkdir(path.join(home, "xdg", "omp", "sessions"), { recursive: true });
    const resolved = await resolveOmpMonitorRoots({
      home,
      platform: "win32",
      env: {
        PI_CONFIG_DIR: ".custom-omp",
        PI_CODING_AGENT_DIR: override,
        XDG_DATA_HOME: path.join(home, "xdg"),
      },
    });
    expect(resolved.roots).toEqual([
      { path: path.join(override, "sessions"), label: "default" },
      {
        path: path.join(home, ".custom-omp", "profiles", "work", "agent", "sessions"),
        label: "work",
      },
    ]);
  });

  it("discovers macOS XDG default and profile roots without consulting any other agent", async () => {
    const home = await directory();
    const xdg = path.join(home, "data");
    await mkdir(path.join(xdg, "omp", "profiles", "work", "sessions"), { recursive: true });
    await mkdir(path.join(home, ".omp", "profiles", "other", "agent", "sessions"), {
      recursive: true,
    });
    const resolved = await resolveOmpMonitorRoots({
      home,
      platform: "darwin",
      env: { XDG_DATA_HOME: xdg },
    });
    expect(resolved.roots).toEqual([
      { path: path.join(xdg, "omp", "sessions"), label: "default" },
      { path: path.join(home, ".omp", "profiles", "other", "agent", "sessions"), label: "other" },
      { path: path.join(xdg, "omp", "profiles", "work", "sessions"), label: "work" },
    ]);
  });
});
