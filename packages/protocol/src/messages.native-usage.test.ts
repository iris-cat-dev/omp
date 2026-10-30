import { describe, expect, test } from "vitest";
import type { AgentUsage } from "./agent-types.js";
import { AgentStreamEventPayloadSchema, AgentTimelineItemPayloadSchema } from "./messages.js";

const usage: AgentUsage = {
  scope: "turn",
  inputTokens: 100,
  cachedInputTokens: 40,
  outputTokens: 1_000,
  nativeMetrics: {
    generation: 2,
    phase: "generating",
    inFlightStartMs: 20_000,
    lastActivityMs: 21_000,
    latestEndMs: 10_000,
    measuredOutputTokens: 1_000,
    measuredDurationMs: 10_000,
    recentRequests: [{ startMs: 500, endMs: 10_500, outputTokens: 1_000 }],
    agentReferences: [{ startMs: 500, endMs: 10_500, outputTokens: 1_000 }],
    modelReferences: [],
  },
};

describe("native own-turn usage wire", () => {
  test("preserves safe request facts on usage, completion and replay metadata", () => {
    for (const type of ["usage_updated", "turn_completed"] as const) {
      const event = { type, provider: "omp", turnId: "turn-one", usage };
      expect(AgentStreamEventPayloadSchema.parse(event)).toEqual(event);
    }
    const item = { type: "assistant_message", text: "", messageId: "request", nativeUsage: usage };
    expect(AgentTimelineItemPayloadSchema.parse(item)).toEqual(item);
  });

  test("keeps untimed native speed explicitly unknown", () => {
    const unknown: AgentUsage = {
      ...usage,
      nativeMetrics: {
        ...usage.nativeMetrics!,
        phase: "idle",
        inFlightStartMs: null,
        latestEndMs: null,
        measuredDurationMs: 0,
        measuredOutputTokens: 0,
        recentRequests: [],
        agentReferences: [],
      },
    };
    expect(
      AgentStreamEventPayloadSchema.parse({
        type: "turn_completed",
        provider: "omp",
        usage: unknown,
      }),
    ).toMatchObject({ usage: unknown });
  });

  test("rejects non-numeric native facts and out-of-contract reference arrays", () => {
    for (const field of ["measuredDurationMs", "measuredOutputTokens", "lastActivityMs"] as const) {
      expect(
        AgentStreamEventPayloadSchema.safeParse({
          type: "usage_updated",
          provider: "omp",
          usage: { ...usage, nativeMetrics: { ...usage.nativeMetrics, [field]: "1000" } },
        }).success,
      ).toBe(false);
    }
    expect(
      AgentStreamEventPayloadSchema.safeParse({
        type: "usage_updated",
        provider: "omp",
        usage: {
          ...usage,
          nativeMetrics: { ...usage.nativeMetrics, inFlightStartMs: Number.POSITIVE_INFINITY },
        },
      }).success,
    ).toBe(false);
    expect(
      AgentStreamEventPayloadSchema.safeParse({
        type: "usage_updated",
        provider: "omp",
        usage: {
          ...usage,
          nativeMetrics: {
            ...usage.nativeMetrics,
            agentReferences: Array(4).fill(usage.nativeMetrics!.agentReferences[0]),
          },
        },
      }).success,
    ).toBe(false);
  });

  test("strips transcript text from numeric native facts", () => {
    const parsed = AgentStreamEventPayloadSchema.parse({
      type: "usage_updated",
      provider: "omp",
      usage: {
        ...usage,
        nativeMetrics: {
          ...usage.nativeMetrics,
          prompt: "private prompt",
          command: "private command",
          result: "private result",
        },
      },
    });
    expect(parsed).not.toHaveProperty("usage.nativeMetrics.prompt");
    expect(parsed).not.toHaveProperty("usage.nativeMetrics.command");
    expect(parsed).not.toHaveProperty("usage.nativeMetrics.result");
  });
  test("bounds new native counters and request windows before they reach the renderer", () => {
    const request = usage.nativeMetrics!.recentRequests[0]!;
    for (const patch of [
      { measuredOutputTokens: 1e308 },
      { measuredDurationMs: 1e308 },
      { latestEndMs: Number.MAX_VALUE },
      { recentRequests: [{ ...request, outputTokens: 1e308 }] },
      { recentRequests: Array(2_049).fill(request) },
    ]) {
      expect(
        AgentStreamEventPayloadSchema.safeParse({
          type: "usage_updated",
          provider: "omp",
          usage: { ...usage, nativeMetrics: { ...usage.nativeMetrics, ...patch } },
        }).success,
      ).toBe(false);
    }
  });
});
