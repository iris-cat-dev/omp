import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
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
import { OmpLocalMonitor } from "./collector.js";
import { OmpMonitorHistory } from "./history.js";
import { calendarDay } from "./math.js";
import { MONITOR_LIMITS, RECENT_MS } from "./state.js";
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
    expect(snapshot.activity).toMatchObject({
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

  it("projects native v1.6.1 effort and family speed from the original branch fixture without changing accounting", async () => {
    const root = await directory();
    const bytes = await readFile(
      new URL("../../test-fixtures/omp-execution-modes-v161/branch.jsonl", import.meta.url),
    );
    const bucket = path.join(root, "bucket");
    await mkdir(bucket);
    await writeFile(path.join(bucket, "branch.jsonl"), bytes);
    const snapshot = await monitor(root, () => Date.parse("2026-10-20T11:31:03.000Z")).poll();
    expect(snapshot.today).toMatchObject({
      requests: 6,
      failedRequests: 0,
      inputTokens: 640,
      outputTokens: 355,
      totalTokens: 995,
      measuredOutputTokens: 350,
      measuredDurationMs: 7_400,
    });
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]).toMatchObject({
      model: "claude-opus-5-5",
      phase: "idle",
      effortMode: { value: "high", evidence: "selected", provider: null },
      speedMode: { value: "standard", evidence: "selected", provider: "anthropic" },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /b4a700|requestControls|thinkingLevel|\/Users\/dev|One\.|Five\./,
    );
  });

  it("exposes actual total-rate and peak provenance without changing billed totals or output peaks", async () => {
    const root = await directory();
    await session(root, "total.jsonl", [
      header(),
      response("output-winner", NOW - 12_000, 300),
      response("total-winner", NOW - 2_000, 30, {
        usage: { input: 3_000, output: 30, totalTokens: 999_999, cost: { total: 0 } },
      }),
    ]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.rate.measuredTps).toBe(10);
    expect(snapshot.rate.measuredTotalTps).toBe(1_010);
    expect(snapshot.rate.estimatedTotalTps).toBe(0);
    expect(snapshot.today).toMatchObject({
      totalTokens: 1_000_309,
      peakOutputTps: 100,
      peakTotalTps: 1_010,
    });
    expect(snapshot.activity).toEqual({
      lastResponseAt: NOW - 1_000,
      peakAt: NOW - 11_000,
      peakObservedAt: NOW - 11_000,
      totalPeakAt: NOW - 1_000,
      totalPeakObservedAt: NOW - 1_000,
    });
    expect(snapshot.agents[0]!.liveMeasuredTotalTps).toBe(1_010);
    expect(snapshot.breakdowns.models.reduce((sum, row) => sum + row.requests, 0)).toBe(2);
    expect(
      snapshot.breakdowns.modes
        .filter((row) => row.kind === "effort")
        .reduce((sum, row) => sum + row.requests, 0),
    ).toBe(2);
  });

  it("replaces mode-only response facts without counting a completion again or rewinding live tools", async () => {
    const root = await directory();
    let now = NOW;
    const history = vi.spyOn(OmpMonitorHistory.prototype, "getDays");
    try {
      const selectedTier = {
        type: "service_tier_change",
        id: "tier",
        timestamp: new Date(NOW - 4_000).toISOString(),
        serviceTier: { openai: "priority" },
      };
      const selectedEffort = {
        type: "thinking_level_change",
        id: "effort",
        parentId: "tier",
        timestamp: new Date(NOW - 3_000).toISOString(),
        thinkingLevel: "high",
      };
      const captured = {
        ...response("request", NOW - 2_000, 300, {
          provider: "openai",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "running-tool" }],
        }),
        parentId: "effort",
      };
      const file = await session(root, "modes.jsonl", [
        header(),
        selectedTier,
        selectedEffort,
        captured,
      ]);
      const current = monitor(root, () => now);
      const initial = await current.poll();
      expect(initial.agents[0]).toMatchObject({
        phase: "tools",
        effortMode: { value: "high", evidence: "selected", provider: null },
        speedMode: { value: "fast", evidence: "selected", provider: "openai" },
      });
      now += 500;
      await appendFile(
        file,
        `${JSON.stringify(
          event("tool-result", now, {
            role: "toolResult",
            toolCallId: "running-tool",
          }),
        )}\n`,
      );
      const running = await current.poll();
      expect(running.agents[0]!.phase).toBe("generating");
      const resultAt = now;
      now += 500;
      const corrected = {
        ...captured,
        timestamp: new Date(now).toISOString(),
        message: {
          ...captured.message,
          serviceTier: "default",
          requestControls: { effort: { tail: "max" } },
        },
      };
      await appendFile(file, `${JSON.stringify(corrected)}\n`);
      const replaced = await current.poll();
      expect(replaced.today).toEqual(initial.today);
      expect(replaced.activity).toEqual(initial.activity);
      expect(replaced.agents[0]).toMatchObject({
        phase: "generating",
        lastActivityAt: resultAt,
        effortMode: { value: "max", evidence: "recorded", provider: null },
        speedMode: { value: "standard", evidence: "recorded", provider: "openai" },
      });
      expect(replaced.breakdowns.modes.filter((row) => row.kind === "effort")).toEqual([
        expect.objectContaining({
          value: "max",
          evidence: "recorded",
          requests: 1,
          outputTokens: 300,
        }),
      ]);
      const recorded = history.mock.lastCall!;
      expect(recorded[1]).toHaveLength(1);
      expect(recorded[1][0]).toMatchObject({
        effortMode: { value: "max", evidence: "recorded", provider: null },
        speedMode: { value: "standard", evidence: "recorded", provider: "openai" },
      });
      const revision = recorded[3];
      now += 500;
      await appendFile(file, `${JSON.stringify(corrected)}\n`);
      const unchanged = await current.poll();
      expect(history.mock.lastCall![3]).toBe(revision);
      expect(unchanged.today).toEqual(initial.today);
      expect(unchanged.agents[0]).toMatchObject({
        phase: "generating",
        lastActivityAt: resultAt,
        effortMode: { value: "max", evidence: "recorded", provider: null },
      });
    } finally {
      history.mockRestore();
    }
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
    expect(initial.activity).toMatchObject({
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
    expect(remainingCopy.activity).toMatchObject({
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
    expect(generating.activity).toMatchObject({
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
    expect(tools.activity).toMatchObject({
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
      measuredTotalTps: 0,
      estimatedTotalTps: 0,
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
      measuredTotalTps: 0,
      estimatedTotalTps: 0,
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
    expect(snapshot.activity).toMatchObject({
      lastResponseAt: NOW,
      peakAt: NOW,
      peakObservedAt: NOW,
    });
  });

  it("keeps output-response feedback separate from valid input-only total peaks", async () => {
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
    expect(completed.activity).toMatchObject({
      lastResponseAt: NOW - 9_000,
      peakAt: null,
      peakObservedAt: null,
      totalPeakAt: null,
      totalPeakObservedAt: null,
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
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const excluded = await current.poll();
    expect(excluded.today).toMatchObject({
      requests: 4,
      failedRequests: 2,
      measuredOutputTokens: 0,
      peakOutputTps: 0,
      peakTotalTps: 0,
    });
    expect(excluded.activity).toEqual(completed.activity);

    // Native TodayLedger measures input-only intervals for total throughput, not output feedback.
    await appendFile(file, `${JSON.stringify(response("input-only", NOW - 1_000, 0))}\n`);
    const inputOnly = await current.poll();
    expect(inputOnly.today).toMatchObject({
      requests: 5,
      failedRequests: 2,
      measuredOutputTokens: 0,
      measuredDurationMs: 1_000,
      peakOutputTps: 0,
    });
    expect(inputOnly.today.peakTotalTps).toBeCloseTo(10 / 3);
    expect(inputOnly.rate.measuredTps).toBe(0);
    expect(inputOnly.rate.measuredTotalTps).toBeCloseTo(10 / 3);
    expect(inputOnly.activity).toEqual({
      ...completed.activity,
      totalPeakAt: NOW,
      totalPeakObservedAt: NOW,
    });
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
    expect(backfill.activity).toMatchObject({
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
    expect(fresh.activity).toMatchObject({
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
    expect(before.activity).toMatchObject({
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
    expect(completed.activity).toMatchObject({
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
    expect(snapshot.activity).toMatchObject({
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
    expect(snapshot.activity).toMatchObject({
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

  it("does not revive an old completed session for eval snapshots or normal disposal", async () => {
    const root = await directory();
    let now = NOW;
    const completedAt = NOW - RECENT_MS - 1_000;
    const file = await session(root, "main.jsonl", [
      header(completedAt - 10_000),
      response("completed", completedAt - 1_000),
    ]);
    const current = monitor(root, () => now);
    const before = await current.poll();
    expect(before.agents).toEqual([]);
    expect(before.today.requests).toBe(1);
    for (const snapshot of [
      {
        type: "custom_message",
        customType: "eval-state-context",
        content: "snapshot",
        display: false,
      },
      {
        type: "message",
        message: { role: "custom", customType: "eval-state-context", content: "snapshot" },
      },
      { type: "custom", customType: "session_exit", data: { reason: "dispose", kind: "normal" } },
    ]) {
      now++;
      await appendFile(
        file,
        `${JSON.stringify({ id: `management-${now}`, timestamp: new Date(now).toISOString(), ...snapshot })}\n`,
      );
      const after = await current.poll();
      expect(after.agents).toEqual([]);
      expect(after.today).toEqual(before.today);
      expect(after.activity.lastResponseAt).toBe(completedAt);
    }
  });

  it.each(["user", "developer"])(
    "keeps zero-token %s, TTFT wait and tool activity visible without treating exit as activity",
    async (role) => {
      const root = await directory();
      let now = NOW;
      const file = await session(root, "main.jsonl", [
        header(NOW - RECENT_MS - 10_000),
        event("request", now, { role, content: "start" }),
      ]);
      const current = monitor(root, () => now);
      const waiting = await current.poll();
      expect(waiting.agents).toHaveLength(1);
      expect(waiting.agents[0]).toMatchObject({
        phase: "generating",
        lastActivityAt: now,
        ttftMs: null,
        liveMeasuredTps: 0,
        liveEstimatedTps: 0,
      });
      now += 1_000;
      await appendFile(
        file,
        `${JSON.stringify(
          response("tool-call", now - 1_000, 0, {
            stopReason: "toolUse",
            usage: { input: 0, output: 0 },
            content: [{ type: "toolCall", id: "call", name: "eval", arguments: {} }],
          }),
        )}\n`,
      );
      const tools = await current.poll();
      expect(tools.agents[0]).toMatchObject({
        phase: "tools",
        lastActivityAt: now,
        liveMeasuredTps: 0,
        liveEstimatedTps: 0,
      });
      now += 1_000;
      await appendFile(
        file,
        `${JSON.stringify(event("result", now, { role: "toolResult", toolCallId: "call", toolName: "eval" }))}\n`,
      );
      expect((await current.poll()).agents[0]).toMatchObject({
        phase: "generating",
        lastActivityAt: now,
        liveMeasuredTps: 0,
        liveEstimatedTps: 0,
      });
      const lastBusinessAt = now;
      now += 1_000;
      await appendFile(
        file,
        `${JSON.stringify({ type: "custom", id: "exit", customType: "session_exit", timestamp: new Date(now).toISOString(), data: { reason: "dispose", kind: "normal" } })}\n`,
      );
      const exited = await current.poll();
      expect(exited.agents[0]).toMatchObject({
        phase: "idle",
        lastActivityAt: lastBusinessAt,
        liveMeasuredTps: 0,
        liveEstimatedTps: 0,
      });
      expect(exited.today.requests).toBe(0);
      now = lastBusinessAt + RECENT_MS;
      expect((await current.poll()).agents).toHaveLength(1);
      now++;
      expect((await current.poll()).agents).toEqual([]);
    },
  );

  it("keeps a real zero-output completion and recorded TTFT visible at zero tok/s", async () => {
    const root = await directory();
    await session(root, "main.jsonl", [
      header(NOW - RECENT_MS - 10_000),
      response("zero-output", NOW - 1_000, 0, { ttft: 0 }),
    ]);
    const snapshot = await monitor(root).poll();
    expect(snapshot.today).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 0 });
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]).toMatchObject({
      phase: "idle",
      lastActivityAt: NOW,
      ttftMs: 0,
      liveMeasuredTps: 0,
      liveEstimatedTps: 0,
    });
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
    expect(firstSnapshot.activity).toMatchObject({
      lastResponseAt: NOW - 30_000,
      peakAt: NOW - 30_000,
      peakObservedAt: NOW - 30_000,
    });
    expect(secondSnapshot.today.peakOutputTps).toBe(200);
    expect(secondSnapshot.activity).toMatchObject({
      lastResponseAt: NOW - 10_000,
      peakAt: NOW - 10_000,
      peakObservedAt: NOW - 10_000,
    });
    expect(
      current.getSnapshot({ profile: "default", project: secondProject }).activity,
    ).toMatchObject({
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
    expect(current.getSnapshot().activity).toMatchObject({
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
    const firstBreakdowns = current.getSnapshot({
      profile: null,
      project: firstProject,
    }).breakdowns;
    const secondBreakdowns = current.getSnapshot({
      profile: null,
      project: secondProject,
    }).breakdowns;
    expect(firstBreakdowns.models.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(300);
    expect(secondBreakdowns.models.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(150);
    expect(firstBreakdowns.modes.filter((row) => row.kind === "effort")).toEqual([
      expect.objectContaining({ value: null, evidence: null, requests: 1, outputTokens: 300 }),
    ]);
    expect(secondBreakdowns.modes.filter((row) => row.kind === "speed")).toEqual([
      expect.objectContaining({ value: null, evidence: null, requests: 1, outputTokens: 150 }),
    ]);
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
    expect(first.activity).toMatchObject({
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
      measuredTotalTps: 0,
      estimatedTotalTps: 0,
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
    expect(completed.activity).toMatchObject({
      lastResponseAt: midnight + 1_000,
      peakAt: midnight + 1_000,
      peakObservedAt: midnight + 1_000,
    });
    day.setDate(day.getDate() + 1);
    now = day.getTime() + 1_000;
    const nextDay = await current.poll();
    expect(nextDay.today).toMatchObject({ requests: 0, peakOutputTps: 0 });
    expect(nextDay.activity).toMatchObject({
      lastResponseAt: midnight + 1_000,
      peakAt: null,
      peakObservedAt: null,
    });
    expect(nextDay.days.at(-2)!.peakOutputTps).toBeCloseTo(200 / 3);
  });

  it("retains available older local history and ancestors without claiming recovery after sources disappear", async () => {
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
    const firstDate = calendarDay(oldDay.getTime() + 1_000)!.date;
    expect(first.days.reduce((sum, day) => sum + day.requests, 0)).toBe(3);
    expect(first.days).toHaveLength(31);
    expect(first.historyRange).toEqual({
      startDate: firstDate,
      endDate: calendarDay(NOW)!.date,
      limited: false,
      scanning: false,
    });
    now += 31 * 86_400_000;
    const retained = await current.poll();
    expect(retained.today.requests).toBe(0);
    expect(retained.days.reduce((sum, day) => sum + day.requests, 0)).toBe(3);
    expect(retained.historyRange.startDate).toBe(firstDate);
    expect(retained.historyRange.endDate).toBe(calendarDay(now)!.date);
    expect(retained.activity).toMatchObject({
      lastResponseAt: NOW,
      peakAt: null,
      peakObservedAt: null,
    });
    await rm(path.join(root, "bucket"), { recursive: true });
    const missing = await current.poll({ refresh: true });
    expect(missing.days.every((day) => day.requests === 0)).toBe(true);
    expect(missing.historyRange.startDate).toBeNull();
    expect(missing.performance.records).toEqual([]);
  });

  it("keeps 90-day, year and older-than-year facts scoped to their real available logs", async () => {
    const firstRoot = await directory();
    const secondRoot = await directory();
    const dates = [45, 120, 400].map((ago) => {
      const at = new Date(NOW);
      at.setDate(at.getDate() - ago);
      return at.getTime();
    });
    for (let index = 0; index < dates.length; index++) {
      const at = dates[index]!;
      await session(firstRoot, `archive-${index}.jsonl`, [
        header(at - 1_000),
        response(`archive-${index}`, at, (index + 1) * 100, {
          provider: "openai",
          serviceTier: "priority",
          requestControls: { effort: { topLevel: "high" } },
        }),
      ]);
    }
    await session(secondRoot, "current.jsonl", [header(), response("current", NOW - 1_000, 40)]);
    const current = new OmpLocalMonitor({
      roots: [
        { path: firstRoot, label: "default" },
        { path: secondRoot, label: "work" },
      ],
      now: () => NOW,
    });
    monitors.push(current);
    await current.poll();
    const archived = current.getSnapshot({ profile: "default", project: null });
    const live = current.getSnapshot({ profile: "work", project: null });
    expect(archived.today.requests).toBe(0);
    expect(archived.days).toHaveLength(33);
    expect(archived.days.reduce((sum, day) => sum + day.requests, 0)).toBe(3);
    expect(archived.historyRange).toEqual({
      startDate: calendarDay(dates[2]! + 1_000)!.date,
      endDate: calendarDay(NOW)!.date,
      limited: false,
      scanning: false,
    });
    expect(archived.breakdowns.models.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(600);
    expect(
      archived.breakdowns.modes
        .filter((row) => row.kind === "effort")
        .every((row) => row.value === "high" && row.evidence === "recorded"),
    ).toBe(true);
    expect(live.historyRange.startDate).toBe(calendarDay(NOW)!.date);
    expect(live.days.reduce((sum, day) => sum + day.requests, 0)).toBe(1);
    expect(live.today.outputTokens).toBe(40);
  });

  it("does not let old archive backfill evict live facts at the unchanged record cap", async () => {
    const root = await directory();
    Object.assign(MONITOR_LIMITS, { records: 2 });
    const oldAt = new Date(NOW);
    oldAt.setFullYear(oldAt.getFullYear() - 2);
    const file = await session(root, "priority.jsonl", [
      header(oldAt.getTime() - 10_000),
      response("live", NOW - 2_000, 100),
      response("archive-newer", oldAt.getTime(), 10),
      response("archive-older", oldAt.getTime() - 2_000, 20),
    ]);
    let now = NOW;
    const current = monitor(root, () => now);
    const initial = await current.poll();
    expect(initial.today).toMatchObject({ requests: 1, outputTokens: 100 });
    expect(initial.days.reduce((sum, day) => sum + day.requests, 0)).toBe(2);
    expect(initial.historyRange.limited).toBe(true);
    expect(initial.coverage.issues).toContain("record_limit");
    expect(initial.performance.limited).toBe(true);
    now += 3_000;
    await appendFile(file, `${JSON.stringify(response("next-live", now - 1_000, 200))}\n`);
    const next = await current.poll();
    expect(next.today).toMatchObject({ requests: 2, outputTokens: 300 });
    expect(next.days.reduce((sum, day) => sum + day.requests, 0)).toBe(2);
    expect(next.historyRange.startDate).toBe(calendarDay(now)!.date);
    expect(next.historyRange.limited).toBe(true);
  });

  it("reorders the bounded retention heap when an existing request's measured end is corrected", async () => {
    const root = await directory();
    Object.assign(MONITOR_LIMITS, { records: 3 });
    const file = await session(root, "corrections.jsonl", [
      header(),
      response("a", NOW - 6_000, 10),
      response("b", NOW - 4_000, 20),
      response("c", NOW - 2_000, 30),
    ]);
    let now = NOW;
    const current = monitor(root, () => now);
    expect((await current.poll()).today.requests).toBe(3);
    await appendFile(
      file,
      `${JSON.stringify(response("a", NOW - 6_000, 10, { duration: 5_000 }))}\n`,
    );
    await current.poll();
    now += 2_000;
    await appendFile(file, `${JSON.stringify(response("d", NOW, 40))}\n`);
    const retained = await current.poll();
    expect(retained.today).toMatchObject({ requests: 3, outputTokens: 80 });
    expect(retained.coverage.issues).toContain("record_limit");
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

  it("scores current timed requests while a large native session keeps growing during history scans", async () => {
    const root = await directory();
    let now = NOW;
    const file = await session(root, "growing.jsonl", [
      header(NOW - 120_000),
      largeHistoryPadding(),
      ...Array.from({ length: 20 }, (_, index) =>
        response(`current-${index}`, NOW - 60_000 + index * 2000, 100),
      ),
    ]);
    await utimes(file, new Date(now), new Date(now));
    const current = monitor(root, () => now);
    for (let poll = 0; poll < 8; poll++) {
      await appendFile(
        file,
        `${JSON.stringify(event(`user-${poll}`, now, { role: "user", content: "fixture" }))}\n`,
      );
      const snapshot = await current.poll();
      expect(snapshot.today.requests).toBe(20);
      expect(snapshot.performance.scanning).toBe(true);
      const value = snapshot.performance.current[snapshot.agents[0]!.id]!;
      expect(value.n).toBe(20);
      expect(value.score).not.toBeNull();
      expect(value.components.find((component) => component.id === "T")).toMatchObject({
        samples: 20,
        measure: 100,
      });
      now += 1000;
    }
  });

  it("keeps complete timed requests before an unfinished row, counts its completion once, and ages the live sample", async () => {
    const root = await directory();
    let now = NOW;
    const file = await session(root, "unfinished.jsonl", [
      header(),
      ...Array.from({ length: 3 }, (_, index) =>
        response(`complete-${index}`, NOW - 20_000 + index * 2000, 100),
      ),
    ]);
    const next = JSON.stringify(response("unfinished", NOW - 2000, 200));
    await appendFile(file, next.slice(0, next.length - 10));
    const current = monitor(root, () => now);
    let snapshot = await current.poll();
    const id = snapshot.agents[0]!.id;
    expect(snapshot.performance.current[id]?.n).toBe(3);
    expect(snapshot.performance.current[id]?.score).not.toBeNull();
    await appendFile(file, next.slice(-10) + "\n");
    snapshot = await current.poll();
    expect(snapshot.performance.current[id]?.n).toBe(4);
    expect((await current.poll()).performance.current[id]?.n).toBe(4);
    now += 30 * 60_000;
    await appendFile(
      file,
      `${JSON.stringify(event("new-task-without-completion", now, { role: "user" }))}\n`,
    );
    expect((await current.poll()).performance.current[id]).toMatchObject({ n: 0, score: null });
  });

  it("preserves original OMP timing fallbacks and exclusions while historical EOF is pending", async () => {
    const root = await directory();
    const file = await session(root, "native-timing.jsonl", [
      header(NOW - 40 * 60_000),
      response("normal", NOW - 20_000),
      response("completed-at", NOW - 16_000, 100, {
        duration: undefined,
        completedAt: NOW - 15_000,
      }),
      response("entry-end", NOW - 12_000, 100, { duration: undefined }),
      response("tool-use", NOW - 8000, 100, {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "live-tool", name: "fixture", arguments: {} }],
      }),
      response("missing-start", NOW - 6000, 100, { timestamp: undefined }),
      response("failed", NOW - 5000, 100, { stopReason: "error" }),
      response("aborted", NOW - 4000, 100, { stopReason: "aborted" }),
      response("missing-stop", NOW - 3000, 100, { stopReason: undefined }),
      response("expired", NOW - 30 * 60_000 - 2000),
      response("future", NOW + 1000),
      {
        type: "model_usage",
        id: "side-only",
        timestamp: new Date(NOW - 1000).toISOString(),
        model: "model-a",
        provider: "fixture",
        api: "fixture-api",
        usage: { input: 10, output: 100 },
      },
    ]);
    await appendFile(file, '{"type":"message"');
    const current = monitor(root);
    let snapshot = await current.poll();
    const id = snapshot.agents[0]!.id;
    expect(snapshot.performance.current[id]?.n).toBe(4);
    expect(
      snapshot.performance.current[id]?.components.find((value) => value.id === "T"),
    ).toMatchObject({ measure: 100, samples: 4 });
    expect(
      snapshot.performance.current[id]?.components.find((value) => value.id === "L"),
    ).toMatchObject({ reason: "notRecorded" });
    await writeFile(
      file,
      [
        JSON.stringify(header()),
        JSON.stringify(response("replacement", NOW - 2000)),
        '{"type":"message"',
      ].join("\n"),
    );
    snapshot = await current.poll();
    expect(snapshot.performance.current[id]).toMatchObject({ n: 1, score: null });
  });

  it("derives v1.6 performance from the canonical native requests without changing billing, TTFT, reasoning or scopes", async () => {
    const defaultRoot = await directory(),
      workRoot = await directory(),
      shared = Array.from({ length: 3 }, (_, index) =>
        response(`shared-${index}`, NOW - 30_000 + index * 3000, 50, {
          usage: {
            input: 10,
            output: 50,
            reasoningTokens: 20,
            cacheRead: 30,
            cacheWrite: 40,
            cost: { total: 1 },
          },
        }),
      );
    await session(defaultRoot, "main.jsonl", [
      header(),
      ...shared,
      {
        type: "model_usage",
        id: "side-only",
        timestamp: new Date(NOW - 1000).toISOString(),
        model: "side-model",
        provider: "fixture",
        api: "fixture",
        usage: { input: 1, output: 2, cost: { total: 0.5 } },
      },
    ]);
    await session(workRoot, "copy.jsonl", [header(), ...shared]);
    await session(workRoot, "own.jsonl", [
      header(NOW - 60_000, "C:\\controlled\\project-beta"),
      ...Array.from({ length: 3 }, (_, index) =>
        response(`own-${index}`, NOW - 20_000 + index * 3000, 100),
      ),
    ]);
    const current = new OmpLocalMonitor({
      roots: [
        { path: defaultRoot, label: "default" },
        { path: workRoot, label: "work" },
      ],
      now: () => NOW,
    });
    monitors.push(current);
    let snapshot = await current.poll();
    for (let poll = 0; poll < 128 && snapshot.performance.scanning; poll++)
      snapshot = await current.poll();
    expect(snapshot.today).toMatchObject({
      requests: 7,
      costUsd: 6.5,
      outputTokens: 452,
      reasoningTokens: 60,
    });
    expect(snapshot.performance.records.reduce((sum, row) => sum + row.n, 0)).toBe(6);
    expect(
      Object.values(snapshot.performance.current).reduce((sum, value) => sum + value.n, 0),
    ).toBe(6);
    expect(
      snapshot.agents
        .filter((agent) => agent.model === "model-a")
        .every((agent) => agent.ttftMs === 50),
    ).toBe(true);
    expect(snapshot.performance.records.filter((row) => row.cacheCached > 0)).toEqual([
      expect.objectContaining({
        n: 3,
        cacheInput: 240,
        cacheCached: 90,
        reasonN: 3,
        reasonOutput: 60,
      }),
    ]);
    const project = snapshot.scopes.projects.find((label) => label.startsWith("project-beta ["));
    expect(project).toBeDefined();
    const scoped = current.getSnapshot({ profile: "work", project: project! });
    expect(scoped.today.requests).toBe(3);
    expect(scoped.performance.records.reduce((sum, row) => sum + row.n, 0)).toBe(3);
    expect(
      scoped.performance.records.every((row) => /^[a-f0-9]{32}$/.test(row.agentId ?? "")),
    ).toBe(true);
    expect(snapshot).not.toHaveProperty("tasks");
    expect(JSON.stringify(snapshot.performance)).not.toMatch(
      /PRIVATE|controlled|project-beta|model_usage|command|arguments/,
    );
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
