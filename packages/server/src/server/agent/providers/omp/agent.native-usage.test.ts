import { setImmediate as waitForImmediate } from "node:timers/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentStreamEventPayloadSchema } from "@omp-desktop/protocol/messages";
import { OmpHarness } from "./test-utils/omp-harness.js";
import type { OmpAgentMessage, OmpSessionState } from "./rpc-types.js";
import { AgentStreamCoalescer } from "../../agent-stream-coalescer.js";
import type { AgentStreamCoalescerFlush } from "../../agent-stream-coalescer.js";

const BASE = 1_800_000_000_000;
afterEach(() => vi.restoreAllMocks());

describe("OMP native chat usage wire", () => {
  test("transmits independent own-turn 100/100 facts while quota counters remain cumulative", async () => {
    let nowMs = BASE;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const omp = new OmpHarness();
    await omp.start();
    try {
      const turnIds: string[] = [];
      for (let round = 0; round < 2; round += 1) {
        nowMs = BASE + round * 60_000;
        const turnId = await omp.requireStartTurn(`fixture prompt ${round}`);
        turnIds.push(turnId);
        const runtime = omp.runtime();
        runtime.beginTurn();
        runtime.acceptPrompt(`fixture prompt ${round}`, `fixture-user-${round}`);
        const message: Extract<OmpAgentMessage, { role: "assistant" }> = {
          role: "assistant",
          content: [{ type: "text", text: "fixture response" }],
          responseId: `fixture-request-${round}`,
          timestamp: nowMs,
          duration: 10_000,
          stopReason: "stop",
          provider: "fixture-provider",
          model: "fixture-model",
          api: "fixture-api",
          usage: { input: 100, cacheRead: 40, output: 1_000, cost: { total: 0.01 } },
        };
        runtime.emit({
          type: "message_start",
          message: { ...message, content: [], usage: undefined },
        });
        nowMs += 10_000;
        runtime.emit({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "text_delta", delta: "fixture response" },
        });
        runtime.emit({ type: "message_end", message });
        // Native session stats also include 9k tokens from delegated/side work.
        runtime.stats = {
          tokens: {
            input: (round + 1) * 100,
            cacheRead: (round + 1) * 40,
            output: (round + 1) * 1_000 + 9_000,
          },
          contextUsage: { contextWindow: 200_000, tokens: 12_000 },
        };
        runtime.finishTurn(message);
        await waitForImmediate();
      }
      const completed = omp
        .streamEvents()
        .flatMap((event) =>
          event.type === "turn_completed" ? [AgentStreamEventPayloadSchema.parse(event)] : [],
        );
      expect(completed).toHaveLength(2);
      expect(
        completed.map((event) => (event.type === "turn_completed" ? event.turnId : null)),
      ).toEqual(turnIds);
      expect(
        completed.map((event) =>
          event.type === "turn_completed" ? event.usage?.outputTokens : null,
        ),
      ).toEqual([1_000, 1_000]);
      expect(
        completed.map((event) => {
          if (event.type !== "turn_completed") return null;
          const native = event.usage!.nativeMetrics!;
          return (native.measuredOutputTokens * 1_000) / native.measuredDurationMs;
        }),
      ).toEqual([100, 100]);
      const sessionEvents = omp
        .streamEvents()
        .filter((event) => event.type === "usage_updated" && event.usage.scope === "session");
      expect(sessionEvents.at(-1)).toMatchObject({
        type: "usage_updated",
        usage: {
          scope: "session",
          outputTokens: 11_000,
          cachedInputTokens: 80,
          contextWindowUsedTokens: 12_000,
        },
      });
      expect(
        sessionEvents.every(
          (event) => event.type === "usage_updated" && event.turnId === undefined,
        ),
      ).toBe(true);
      const metadata = omp
        .timeline()
        .filter((item) => item.type === "assistant_message" && item.nativeUsage);
      expect(metadata).toHaveLength(2);
      expect(
        metadata.map((item) =>
          item.type === "assistant_message"
            ? item.nativeUsage?.nativeMetrics?.measuredDurationMs
            : null,
        ),
      ).toEqual([10_000, 10_000]);
    } finally {
      await omp.close();
    }
  });

  test("meters autonomous turns across provider cycles without resetting turn-local totals", async () => {
    let nowMs = BASE;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const omp = new OmpHarness();
    await omp.start();
    try {
      const runtime = omp.runtime();
      runtime.emit({ type: "agent_start" });
      runtime.beginTurn();
      const turnId = omp.streamEvents().findLast((event) => event.type === "turn_started")?.turnId;
      expect(turnId).toEqual(expect.any(String));
      const first: Extract<OmpAgentMessage, { role: "assistant" }> = {
        role: "assistant",
        content: [{ type: "text", text: "first autonomous cycle" }],
        responseId: "autonomous-first",
        timestamp: BASE,
        duration: 4_000,
        stopReason: "stop",
        provider: "fixture",
        model: "fixture",
        api: "fixture",
        usage: { input: 40, output: 400 },
      };
      runtime.emit({
        type: "message_start",
        message: { ...first, content: [], usage: undefined },
      });
      nowMs += 4_000;
      runtime.emit({ type: "message_end", message: first });

      const { promise: stateRequested, resolve: markStateRequested } =
        Promise.withResolvers<void>();
      const { promise: staleState, resolve: releaseStaleState } =
        Promise.withResolvers<OmpSessionState>();
      const getState = runtime.getState.bind(runtime);
      let deferNextState = true;
      runtime.getState = async () => {
        if (!deferNextState) return await getState();
        deferNextState = false;
        markStateRequested();
        return await staleState;
      };
      runtime.finishTurn(first);
      await stateRequested;

      nowMs += 2_000;
      runtime.beginTurn();
      const second = {
        ...first,
        responseId: "autonomous-second",
        timestamp: nowMs,
        duration: 6_000,
        content: [{ type: "text" as const, text: "second autonomous cycle" }],
        usage: { input: 90, output: 900 },
      };
      runtime.emit({
        type: "message_start",
        message: { ...second, content: [], usage: undefined },
      });
      releaseStaleState({ ...runtime.state, isStreaming: false, isCompacting: false });
      await waitForImmediate();

      expect(omp.completedTurnCount()).toBe(0);
      expect(
        omp
          .streamEvents()
          .findLast((event) => event.type === "usage_updated" && event.turnId === turnId),
      ).toMatchObject({
        usage: {
          scope: "turn",
          outputTokens: 400,
          nativeMetrics: {
            phase: "generating",
            inFlightStartMs: BASE + 6_000,
            measuredOutputTokens: 400,
            measuredDurationMs: 4_000,
          },
        },
      });
      expect(
        omp
          .streamEvents()
          .filter((event) => event.type === "turn_started")
          .map((event) => event.turnId),
      ).toEqual([turnId, turnId]);

      nowMs += 6_000;
      runtime.emit({ type: "message_end", message: second });
      runtime.finishTurn(second);
      await waitForImmediate();
      expect(omp.completedTurnCount()).toBe(1);
      expect(omp.streamEvents().findLast((event) => event.type === "turn_completed")).toMatchObject(
        {
          turnId,
          usage: {
            scope: "turn",
            inputTokens: 130,
            outputTokens: 1_300,
            nativeMetrics: {
              phase: "idle",
              inFlightStartMs: null,
              latestEndMs: BASE + 12_000,
              measuredOutputTokens: 1_300,
              measuredDurationMs: 10_000,
            },
          },
        },
      );

      nowMs += 1_000;
      runtime.beginTurn();
      const nextTurnId = omp
        .streamEvents()
        .findLast((event) => event.type === "turn_started")?.turnId;
      expect(nextTurnId).toEqual(expect.any(String));
      expect(nextTurnId).not.toBe(turnId);
      const next = {
        ...first,
        responseId: "autonomous-next-turn",
        timestamp: nowMs,
        duration: 5_000,
        usage: { input: 25, output: 250 },
      };
      runtime.emit({
        type: "message_start",
        message: { ...next, content: [], usage: undefined },
      });
      nowMs += 5_000;
      // This request is only accounted for by the terminal agent_end payload.
      runtime.finishTurn(next);
      await waitForImmediate();
      expect(
        omp
          .streamEvents()
          .filter((event) => event.type === "turn_completed")
          .map((event) => event.turnId),
      ).toEqual([turnId, nextTurnId]);
      expect(omp.streamEvents().findLast((event) => event.type === "turn_completed")).toMatchObject(
        {
          turnId: nextTurnId,
          usage: {
            scope: "turn",
            inputTokens: 25,
            outputTokens: 250,
            nativeMetrics: {
              phase: "idle",
              inFlightStartMs: null,
              latestEndMs: BASE + 18_000,
              measuredOutputTokens: 250,
              measuredDurationMs: 5_000,
            },
          },
        },
      );
    } finally {
      await omp.close();
    }
  });

  test("a stale completion cannot finish native metering owned by a replacement turn", async () => {
    let nowMs = BASE;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const omp = new OmpHarness();
    await omp.start();
    try {
      const runtime = omp.runtime();
      runtime.beginTurn();
      const oldTurnId = omp
        .streamEvents()
        .findLast((event) => event.type === "turn_started")?.turnId;
      const oldMessage: Extract<OmpAgentMessage, { role: "assistant" }> = {
        role: "assistant",
        content: [{ type: "text", text: "old autonomous response" }],
        responseId: "stale-autonomous-request",
        timestamp: BASE,
        duration: 4_000,
        stopReason: "stop",
        provider: "fixture",
        model: "fixture",
        api: "fixture",
        usage: { output: 400 },
      };
      runtime.emit({
        type: "message_start",
        message: { ...oldMessage, content: [], usage: undefined },
      });
      nowMs += 4_000;
      runtime.emit({ type: "message_end", message: oldMessage });

      const { promise: stateRequested, resolve: markStateRequested } =
        Promise.withResolvers<void>();
      const { promise: staleState, resolve: releaseStaleState } =
        Promise.withResolvers<OmpSessionState>();
      const getState = runtime.getState.bind(runtime);
      let deferNextState = true;
      runtime.getState = async () => {
        if (!deferNextState) return await getState();
        deferNextState = false;
        markStateRequested();
        return await staleState;
      };
      runtime.finishTurn(oldMessage);
      await stateRequested;

      nowMs += 1_000;
      await omp.interrupt("replacement");
      const currentTurnId = await omp.requireStartTurn("replacement native request");
      runtime.beginTurn();
      const current = {
        ...oldMessage,
        responseId: "replacement-request",
        timestamp: nowMs,
        duration: 6_000,
        usage: { output: 900 },
      };
      runtime.emit({
        type: "message_start",
        message: { ...current, content: [], usage: undefined },
      });
      releaseStaleState({ ...runtime.state, isStreaming: false, isCompacting: false });
      await waitForImmediate();

      expect(omp.completedTurnCount()).toBe(0);
      expect(omp.canceledTurnCount()).toBe(1);
      expect(
        omp
          .streamEvents()
          .findLast((event) => event.type === "usage_updated" && event.turnId === currentTurnId),
      ).toMatchObject({
        usage: {
          scope: "turn",
          outputTokens: 0,
          nativeMetrics: {
            phase: "generating",
            inFlightStartMs: BASE + 5_000,
            measuredOutputTokens: 0,
            measuredDurationMs: 0,
          },
        },
      });

      nowMs += 6_000;
      runtime.emit({ type: "message_end", message: current });
      runtime.finishTurn(current);
      await waitForImmediate();
      expect(
        omp
          .streamEvents()
          .filter((event) => event.type === "turn_completed" || event.type === "turn_canceled")
          .map((event) => ({ type: event.type, turnId: event.turnId })),
      ).toEqual([
        { type: "turn_canceled", turnId: oldTurnId },
        { type: "turn_completed", turnId: currentTurnId },
      ]);
      expect(omp.streamEvents().findLast((event) => event.type === "turn_completed")).toMatchObject(
        {
          turnId: currentTurnId,
          usage: {
            scope: "turn",
            outputTokens: 900,
            nativeMetrics: {
              phase: "idle",
              inFlightStartMs: null,
              latestEndMs: BASE + 11_000,
              measuredOutputTokens: 900,
              measuredDurationMs: 6_000,
            },
          },
        },
      );
    } finally {
      await omp.close();
    }
  });

  test("cancellation prevents delayed native completion from entering the next turn", async () => {
    let nowMs = BASE;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const omp = new OmpHarness();
    await omp.start();
    try {
      await omp.requireStartTurn("cancelled fixture");
      omp.runtime().beginTurn();
      const interrupted: Extract<OmpAgentMessage, { role: "assistant" }> = {
        role: "assistant",
        content: [],
        responseId: "old-request",
        timestamp: BASE,
        duration: 10_000,
        stopReason: "stop",
        model: "fixture",
        provider: "fixture",
        api: "fixture",
        usage: { output: 1_000 },
      };
      omp.runtime().emit({ type: "message_start", message: interrupted });
      nowMs += 2_000;
      await omp.interrupt();
      nowMs += 10_000;
      const currentTurnId = await omp.requireStartTurn("new fixture");
      omp.runtime().beginTurn();
      omp.runtime().emit({ type: "message_end", message: interrupted });
      const current = {
        ...interrupted,
        responseId: "new-request",
        timestamp: nowMs,
        usage: { output: 500 },
      };
      nowMs += 10_000;
      omp.runtime().emit({ type: "message_end", message: current });
      omp.runtime().finishTurn(current);
      await waitForImmediate();
      const completed = omp
        .streamEvents()
        .findLast((event) => event.type === "turn_completed" && event.turnId === currentTurnId);
      expect(completed).toMatchObject({
        usage: {
          outputTokens: 500,
          nativeMetrics: { measuredOutputTokens: 500, measuredDurationMs: 10_000 },
        },
      });
    } finally {
      await omp.close();
    }
  });
  test("preserves native footer facts when a plan body and its completion metadata coalesce", async () => {
    let nowMs = BASE;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const omp = new OmpHarness();
    const flushed: AgentStreamCoalescerFlush[] = [];
    const coalescer = new AgentStreamCoalescer({
      timers: { setTimeout, clearTimeout },
      onFlush: (event) => flushed.push(event),
    });
    await omp.start({ featureValues: { workflow_mode: "plan" } });
    try {
      await omp.requireStartTurn("draft a native plan");
      const runtime = omp.runtime();
      runtime.beginTurn();
      runtime.acceptPrompt("draft a native plan", "plan-user");
      const message: Extract<OmpAgentMessage, { role: "assistant" }> = {
        role: "assistant",
        content: [{ type: "text", text: "native plan" }],
        responseId: "plan-response",
        timestamp: BASE,
        duration: 10_000,
        stopReason: "stop",
        provider: "fixture",
        model: "fixture",
        api: "fixture",
        usage: { input: 100, output: 1_000 },
      };
      runtime.emit({
        type: "message_start",
        message: { ...message, content: [], usage: undefined },
      });
      nowMs += 10_000;
      runtime.emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", delta: "native plan" },
      });
      runtime.emit({ type: "message_end", message });
      runtime.finishTurn(message);
      await waitForImmediate();
      for (const event of omp.streamEvents()) coalescer.handle("plan-agent", event);
      coalescer.flushAll();
      const plan = flushed.find(
        (event) =>
          event.item.type === "assistant_message" &&
          event.item.presentation === "plan" &&
          event.item.nativeUsage,
      );
      expect(plan?.item).toMatchObject({
        type: "assistant_message",
        text: "native plan",
        presentation: "plan",
        nativeUsage: { outputTokens: 1_000, nativeMetrics: { measuredDurationMs: 10_000 } },
      });
    } finally {
      coalescer.flushAll();
      await omp.close();
    }
  });
});
