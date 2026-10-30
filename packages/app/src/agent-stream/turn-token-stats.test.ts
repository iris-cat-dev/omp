import { describe, expect, it } from "vitest";
import type { AgentNativeOutputMetrics, AgentUsage } from "@omp-desktop/protocol/agent-types";

import { deriveTurnTokenStats, formatTokenCount } from "./turn-token-stats";

describe("formatTokenCount", () => {
  it("keeps small counts as-is", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(950)).toBe("950");
  });

  it("compacts thousands with a k suffix", () => {
    expect(formatTokenCount(4600)).toBe("4.6k");
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(12500)).toBe("12.5k");
  });

  it("compacts millions with an M suffix", () => {
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });

  it("rounds fractional counts", () => {
    expect(formatTokenCount(12.4)).toBe("12");
  });
});

describe("deriveTurnTokenStats", () => {
  const native: AgentNativeOutputMetrics = {
    generation: 1,
    phase: "idle",
    inFlightStartMs: null,
    lastActivityMs: 10_000,
    latestEndMs: 10_000,
    measuredOutputTokens: 1_000,
    measuredDurationMs: 10_000,
    recentRequests: [],
    agentReferences: [],
    modelReferences: [],
  };

  it("returns null without tokens and rejects session aggregates", () => {
    expect(deriveTurnTokenStats(null)).toBeNull();
    expect(deriveTurnTokenStats({})).toBeNull();
    expect(deriveTurnTokenStats({ inputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(deriveTurnTokenStats({ scope: "session", outputTokens: 5_000 })).toBeNull();
  });

  it("keeps provider input/output and cache semantics unchanged", () => {
    const usage: AgentUsage = {
      scope: "turn",
      inputTokens: 1_200,
      outputTokens: 3_400,
      cachedInputTokens: 800,
    };
    expect(deriveTurnTokenStats(usage)).toEqual({ totalTokens: 4_600, avgTokensPerSecond: null });
  });

  it("shows 100/100 for two distinct 1000-token native ten-second turns", () => {
    const first = deriveTurnTokenStats({
      scope: "turn",
      outputTokens: 1_000,
      nativeMetrics: native,
    });
    const second = deriveTurnTokenStats({
      scope: "turn",
      outputTokens: 1_000,
      nativeMetrics: { ...native, generation: 2 },
    });
    expect(first).toEqual({ totalTokens: 1_000, avgTokensPerSecond: 100 });
    expect(second).toEqual(first);
  });

  it("divides only the valid requests, excluding tools, failed and untimed output", () => {
    const usage: AgentUsage = {
      scope: "turn",
      outputTokens: 2_500,
      nativeMetrics: { ...native, measuredOutputTokens: 2_000, measuredDurationMs: 20_000 },
    };
    expect(deriveTurnTokenStats(usage)).toEqual({ totalTokens: 2_500, avgTokensPerSecond: 100 });
  });

  it("replaces a disconnected in-flight footer sample with its completed replay facts", () => {
    const stale: AgentUsage = {
      scope: "turn",
      outputTokens: 0,
      nativeMetrics: { ...native, measuredOutputTokens: 0, measuredDurationMs: 0 },
    };
    const replayed: AgentUsage = {
      scope: "turn",
      inputTokens: 100,
      outputTokens: 1_000,
      nativeMetrics: native,
    };
    expect(deriveTurnTokenStats(stale, replayed)).toEqual({
      totalTokens: 1_100,
      avgTokensPerSecond: 100,
    });
  });

  it("uses authoritative replay totals instead of a retained partial or overcounted live sample", () => {
    const recorded: AgentUsage = {
      scope: "turn",
      inputTokens: 100,
      outputTokens: 2_000,
      nativeMetrics: { ...native, measuredOutputTokens: 2_000 },
    };
    const replayed: AgentUsage = {
      scope: "turn",
      inputTokens: 100,
      outputTokens: 1_000,
      nativeMetrics: native,
    };
    expect(deriveTurnTokenStats(recorded, replayed)).toEqual({
      totalTokens: 1_100,
      avgTokensPerSecond: 100,
    });
    expect(deriveTurnTokenStats(recorded)).toEqual({
      totalTokens: 2_100,
      avgTokensPerSecond: 200,
    });
    expect(deriveTurnTokenStats(recorded, { scope: "session", outputTokens: 9_000 })).toEqual({
      totalTokens: 2_100,
      avgTokensPerSecond: 200,
    });
  });

  it("never guesses a native duration from Worked for or missing metadata", () => {
    expect(deriveTurnTokenStats({ outputTokens: 240 })?.avgTokensPerSecond).toBeNull();
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        deriveTurnTokenStats({
          outputTokens: 240,
          nativeMetrics: { ...native, measuredDurationMs: duration },
        })?.avgTokensPerSecond,
      ).toBeNull();
    }
  });
  it("retains a measured zero but rejects impossible totals and overflowing native facts", () => {
    expect(
      deriveTurnTokenStats({
        inputTokens: 100,
        outputTokens: 0,
        nativeMetrics: { ...native, measuredOutputTokens: 0, measuredDurationMs: 500 },
      }),
    ).toEqual({ totalTokens: 100, avgTokensPerSecond: 0 });
    for (const patch of [
      { measuredOutputTokens: 1e308 },
      { measuredDurationMs: 1e308 },
      { measuredOutputTokens: 1_001 },
      { measuredDurationMs: 499 },
    ]) {
      expect(
        deriveTurnTokenStats({
          outputTokens: 1_000,
          nativeMetrics: { ...native, ...patch },
        })?.avgTokensPerSecond,
      ).toBeNull();
    }
  });
});
