import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamOmpHistory } from "./history.js";
import type { OmpAgentMessage } from "./rpc-types.js";
import { OmpNativeUsageTracker } from "./native-usage.js";
import { OmpHistoryMapper } from "./message-history.js";

type Assistant = Extract<OmpAgentMessage, { role: "assistant" }>;
const BASE = 1_800_000_000_000;
function assistant(startMs: number, patch: Partial<Assistant> = {}): Assistant {
  return {
    role: "assistant",
    content: [{ type: "text", text: "fixture response" }],
    provider: "fixture-provider",
    model: "fixture-model",
    api: "fixture-api",
    responseId: `request-${startMs}`,
    timestamp: startMs,
    duration: 10_000,
    stopReason: "stop",
    usage: { input: 100, output: 1_000, cacheRead: 40, cacheWrite: 20, cost: { total: 0.01 } },
    ...patch,
  };
}

describe("OMP own native request usage", () => {
  test("two 1000-token ten-second turns stay 100/100, including a late first-turn replay", () => {
    const tracker = new OmpNativeUsageTracker();
    const first = assistant(BASE);
    tracker.startTurn("one", BASE);
    tracker.recordAssistant(first, BASE + 10_000);
    tracker.finish(BASE + 10_000);
    const one = tracker.getUsage("one", BASE + 10_000)!;
    tracker.startTurn("two", BASE + 20_000);
    expect(tracker.recordAssistant(first, BASE + 20_100)).toBe(false);
    tracker.recordAssistant(assistant(BASE + 20_000), BASE + 30_000);
    tracker.finish(BASE + 30_000);
    const two = tracker.getUsage("two", BASE + 30_000)!;
    expect([one.outputTokens, two.outputTokens]).toEqual([1_000, 1_000]);
    expect(
      [one, two].map(
        (usage) =>
          (usage.nativeMetrics!.measuredOutputTokens * 1_000) /
          usage.nativeMetrics!.measuredDurationMs,
      ),
    ).toEqual([100, 100]);
    expect(two).toMatchObject({
      scope: "turn",
      inputTokens: 100,
      cachedInputTokens: 40,
      totalCostUsd: 0.01,
    });
    expect(tracker.getUsage("one", BASE + 30_000)).toBeUndefined();
  });

  test("long tools do not enter native duration, and duplicate ends do not stop the next request", () => {
    const tracker = new OmpNativeUsageTracker();
    tracker.startTurn("one", BASE);
    const first = assistant(BASE, {
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool", name: "task", arguments: {} }],
    });
    tracker.recordAssistant(first, BASE + 10_000);
    expect(tracker.getUsage("one", BASE + 60_000)!.nativeMetrics!.phase).toBe("tools");
    const next = assistant(BASE + 70_000);
    tracker.startRequest(next, BASE + 70_000);
    tracker.recordAssistant(first, BASE + 70_001);
    expect(tracker.getUsage("one", BASE + 70_001)!.nativeMetrics!.phase).toBe("generating");
    tracker.recordAssistant(next, BASE + 80_000);
    const usage = tracker.getUsage("one", BASE + 80_000)!;
    expect(usage.outputTokens).toBe(2_000);
    expect(usage.nativeMetrics).toMatchObject({
      measuredOutputTokens: 2_000,
      measuredDurationMs: 20_000,
      phase: "idle",
    });
  });

  test("errors and cancellation retain actual token usage, but no measured speed", () => {
    for (const stopReason of ["error", "aborted", undefined]) {
      const tracker = new OmpNativeUsageTracker();
      tracker.startTurn("one", BASE);
      tracker.recordAssistant(assistant(BASE, { stopReason }), BASE + 10_000);
      expect(tracker.getUsage("one", BASE + 10_000)).toMatchObject({
        outputTokens: 1_000,
        nativeMetrics: {
          measuredOutputTokens: 0,
          measuredDurationMs: 0,
          agentReferences: [],
          phase: "idle",
        },
      });
    }
  });

  test("normalizes the native 500ms minimum and rejects more than fifteen minutes", () => {
    for (const [duration, measuredDurationMs] of [
      [0, 500],
      [499.9, 500],
      [900_000, 900_000],
      [900_001, 0],
      [-1, 0],
    ] as const) {
      const tracker = new OmpNativeUsageTracker();
      tracker.startTurn("one", BASE);
      tracker.recordAssistant(assistant(BASE, { duration }), BASE + Math.max(0, duration));
      expect(tracker.getUsage("one", BASE + 900_001)!.nativeMetrics!.measuredDurationMs).toBe(
        measuredDurationMs,
      );
    }
  });

  test("keeps missing native timing unknown, including an untimed request with a live identity", () => {
    const tracker = new OmpNativeUsageTracker();
    tracker.startTurn("one", BASE);
    tracker.recordAssistant(assistant(BASE, { duration: undefined }), BASE + 10_000);
    const untimed = assistant(BASE + 20_000, { timestamp: undefined, duration: undefined });
    tracker.startRequest(untimed, BASE + 20_000);
    tracker.recordAssistant(untimed, BASE + 30_000);
    expect(tracker.getUsage("one", BASE + 30_000)).toMatchObject({
      outputTokens: 2_000,
      nativeMetrics: { measuredDurationMs: 0, measuredOutputTokens: 0 },
    });
  });

  test("uses native completedAt only when a native request start is also known", () => {
    const tracker = new OmpNativeUsageTracker();
    tracker.startTurn("one", BASE);
    tracker.recordAssistant(
      assistant(BASE, { duration: undefined, completedAt: BASE + 10_000 }),
      BASE + 11_000,
    );
    expect(tracker.getUsage("one", BASE + 11_000)!.nativeMetrics!.measuredDurationMs).toBe(10_000);
  });

  test("cancellation and compaction close estimates and reject old-generation completions", () => {
    const tracker = new OmpNativeUsageTracker();
    tracker.startTurn("one", BASE);
    const interrupted = assistant(BASE + 1_000);
    tracker.startRequest(interrupted, BASE + 1_000);
    const generation = tracker.getUsage("one", BASE + 1_000)!.nativeMetrics!.generation;
    tracker.pause(BASE + 2_000);
    expect(tracker.recordAssistant(interrupted, BASE + 11_000)).toBe(false);
    expect(tracker.getUsage("one", BASE + 11_000)!.nativeMetrics).toMatchObject({
      phase: "idle",
      inFlightStartMs: null,
    });
    tracker.startRequest(assistant(BASE + 12_000), BASE + 12_000);
    expect(tracker.getUsage("one", BASE + 12_000)!.nativeMetrics!.generation).toBeGreaterThan(
      generation,
    );
    tracker.finish(BASE + 13_000);
    expect(tracker.recordAssistant(assistant(BASE + 12_000), BASE + 22_000)).toBe(false);
    tracker.startTurn("two", BASE + 30_000);
    expect(tracker.getUsage("two", BASE + 30_000)).toBeUndefined();
  });

  test("seeds only native history references without charging them to a resumed turn", () => {
    const tracker = new OmpNativeUsageTracker();
    tracker.seedReference(assistant(BASE), BASE + 60_000);
    tracker.startTurn("resumed", BASE + 60_000, {
      id: "fixture-model",
      provider: "fixture-provider",
    });
    tracker.startRequest(assistant(BASE + 60_000), BASE + 60_000);
    expect(tracker.getUsage("resumed", BASE + 60_000)).toMatchObject({
      outputTokens: 0,
      nativeMetrics: {
        measuredOutputTokens: 0,
        measuredDurationMs: 0,
        agentReferences: [{ outputTokens: 1_000 }],
      },
    });
  });
});

describe("native history footer facts", () => {
  test("keeps each prompt's own cumulative requests and excludes task-result usage", () => {
    const mapper = new OmpHistoryMapper("omp");
    const events = mapper.mapMessages([
      { role: "user", content: "first" },
      assistant(BASE, {
        content: [{ type: "toolCall", id: "task", name: "task", arguments: {} }],
        stopReason: "toolUse",
      }),
      {
        role: "toolResult",
        toolCallId: "task",
        toolName: "task",
        content: "child used 9000 tokens",
      },
      assistant(BASE + 70_000),
      { role: "user", content: "second" },
      assistant(BASE + 90_000),
    ]);
    const usages = events.flatMap((event) =>
      event.type === "timeline" && event.item.type === "assistant_message" && event.item.nativeUsage
        ? [event.item.nativeUsage]
        : [],
    );
    expect(usages.map((usage) => usage.outputTokens)).toEqual([2_000, 1_000]);
    expect(usages.map((usage) => usage.nativeMetrics!.measuredDurationMs)).toEqual([
      20_000, 10_000,
    ]);
    expect(usages.every((usage) => usage.nativeMetrics!.recentRequests.length === 0)).toBe(true);
  });
});

test("fork replay exposes only this file's own native requests as speed references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-native-history-"));
  try {
    const sessionFile = join(directory, "session.jsonl");
    const entries = [
      { type: "session", id: "root", timestamp: new Date(BASE + 60_000).toISOString() },
      {
        type: "message",
        id: "copied",
        parentId: "root",
        timestamp: new Date(BASE + 10_000).toISOString(),
        message: assistant(BASE),
      },
      {
        type: "message",
        id: "near-copy",
        parentId: "copied",
        timestamp: new Date(BASE + 59_000).toISOString(),
        message: assistant(BASE + 49_000),
      },
      {
        type: "message",
        id: "user",
        parentId: "near-copy",
        timestamp: new Date(BASE + 70_000).toISOString(),
        message: { role: "user", content: "own prompt" },
      },
      {
        type: "message",
        id: "own",
        parentId: "user",
        timestamp: new Date(BASE + 80_000).toISOString(),
        message: assistant(BASE + 70_000),
      },
    ];
    await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
    const references: string[] = [];
    const usages: number[] = [];
    for await (const event of streamOmpHistory({
      sessionFile,
      provider: "omp",
      onOwnAssistant: (message) => references.push(message.responseId!),
    })) {
      if (
        event.type === "timeline" &&
        event.item.type === "assistant_message" &&
        event.item.nativeUsage
      ) {
        usages.push(event.item.nativeUsage.outputTokens!);
      }
    }
    expect(references).toEqual([`request-${BASE + 70_000}`]);
    expect(usages).toEqual([1_000]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("starts the estimate from native input and resumes only after the whole tool batch", () => {
  const tracker = new OmpNativeUsageTracker();
  tracker.seedReference(assistant(BASE - 30_000), BASE);
  tracker.startTurn("batch", BASE);
  expect(tracker.observeInput({ role: "user", content: "prompt", timestamp: BASE }, BASE)).toBe(
    true,
  );
  expect(tracker.getUsage("batch", BASE)!.nativeMetrics!.inFlightStartMs).toBe(BASE);
  tracker.recordAssistant(
    assistant(BASE, {
      stopReason: "toolUse",
      content: [
        { type: "toolCall", id: "one", name: "bash", arguments: {} },
        { type: "toolCall", id: "two", name: "bash", arguments: {} },
      ],
    }),
    BASE + 10_000,
  );
  expect(
    tracker.observeInput(
      {
        role: "toolResult",
        toolCallId: "one",
        toolName: "bash",
        content: "done",
        timestamp: BASE + 60_000,
      },
      BASE + 60_000,
    ),
  ).toBe(false);
  expect(tracker.getUsage("batch", BASE + 60_000)!.nativeMetrics!.phase).toBe("tools");
  expect(
    tracker.observeInput(
      {
        role: "toolResult",
        toolCallId: "old-turn",
        toolName: "bash",
        content: "late",
        timestamp: BASE - 1_000,
      },
      BASE + 65_000,
    ),
  ).toBe(false);
  expect(
    tracker.observeInput(
      {
        role: "toolResult",
        toolCallId: "two",
        toolName: "bash",
        content: "done",
        timestamp: BASE + 70_000,
      },
      BASE + 70_000,
    ),
  ).toBe(true);
  expect(tracker.getUsage("batch", BASE + 70_000)!.nativeMetrics).toMatchObject({
    phase: "generating",
    inFlightStartMs: BASE + 70_000,
    measuredOutputTokens: 1_000,
    measuredDurationMs: 10_000,
  });
});

test("upserts repeated own responses using maximum native token facts, never another increment", () => {
  const tracker = new OmpNativeUsageTracker();
  tracker.startTurn("upsert", BASE);
  tracker.recordAssistant(assistant(BASE), BASE + 10_000);
  tracker.recordAssistant(assistant(BASE, { usage: { output: 500 } }), BASE + 10_001);
  expect(tracker.getUsage("upsert", BASE + 10_001)!.outputTokens).toBe(1_000);
  tracker.recordAssistant(assistant(BASE, { usage: { output: 1_200 } }), BASE + 10_002);
  expect(tracker.getUsage("upsert", BASE + 10_002)).toMatchObject({
    inputTokens: 100,
    outputTokens: 1_200,
    nativeMetrics: { measuredOutputTokens: 1_200, measuredDurationMs: 10_000 },
  });
});

test("null native timing remains unknown instead of falling back to the observer clock", () => {
  const tracker = new OmpNativeUsageTracker();
  tracker.startTurn("null-duration", BASE);
  tracker.recordAssistant(assistant(BASE, { duration: null, completedAt: null }), BASE + 10_000);
  expect(tracker.getUsage("null-duration", BASE + 10_000)).toMatchObject({
    outputTokens: 1_000,
    nativeMetrics: { measuredOutputTokens: 0, measuredDurationMs: 0 },
  });
});

test("keeps ordered native requests when a tool batch is observed after its native timestamps", () => {
  const tracker = new OmpNativeUsageTracker();
  tracker.startTurn("batched", BASE);
  tracker.recordAssistant(
    assistant(BASE, {
      duration: 1_000,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool", name: "bash", arguments: {} }],
    }),
    BASE + 1_010,
  );
  tracker.pause(BASE + 1_010, "tools");
  expect(
    tracker.observeInput(
      {
        role: "toolResult",
        toolCallId: "tool",
        toolName: "bash",
        content: "done",
        timestamp: BASE + 1_002,
      },
      BASE + 1_010,
    ),
  ).toBe(true);
  const next = assistant(BASE + 1_003, { duration: 1_000 });
  tracker.startRequest(next, BASE + 1_010);
  tracker.recordAssistant(next, BASE + 2_010);
  expect(tracker.getUsage("batched", BASE + 2_010)).toMatchObject({
    outputTokens: 2_000,
    nativeMetrics: { measuredOutputTokens: 2_000, measuredDurationMs: 2_000, phase: "idle" },
  });
});
