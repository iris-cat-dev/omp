import { describe, expect, it } from "vitest";
import type { AgentNativeOutputMetrics } from "@omp-desktop/protocol/agent-types";
import { calculateNativeOutputRate, formatOutputTokenSpeed } from "./token-output-speed";

const NOW = 1_800_000_000_000;
const reference = { startMs: NOW - 30_000, endMs: NOW - 20_000, outputTokens: 1_000 };
function metrics(patch: Partial<AgentNativeOutputMetrics> = {}): AgentNativeOutputMetrics {
  return {
    generation: 1,
    phase: "idle",
    inFlightStartMs: null,
    lastActivityMs: NOW,
    latestEndMs: null,
    measuredOutputTokens: 0,
    measuredDurationMs: 0,
    recentRequests: [],
    agentReferences: [reference],
    modelReferences: [],
    ...patch,
  };
}

describe("native own-agent output speed", () => {
  it("uses the last three seconds, including TTFT, without a token delta sample", () => {
    const rate = calculateNativeOutputRate(
      metrics({ phase: "generating", inFlightStartMs: NOW - 1_500 }),
      NOW,
    );
    expect(rate).toEqual({ measured: 0, estimated: 50, output: 50, reference: "agent" });
  });

  it("replaces a request's estimate with its completion instead of accumulating both", () => {
    const pending = metrics({ phase: "generating", inFlightStartMs: NOW - 10_000 });
    expect(calculateNativeOutputRate(pending, NOW).estimated).toBe(100);
    const completed = metrics({
      phase: "idle",
      latestEndMs: NOW,
      measuredOutputTokens: 1_000,
      measuredDurationMs: 10_000,
      recentRequests: [{ startMs: NOW - 10_000, endMs: NOW, outputTokens: 1_000 }],
    });
    expect(calculateNativeOutputRate(completed, NOW)).toEqual({
      measured: 100,
      estimated: 0,
      output: 100,
      reference: "agent",
    });
    expect(calculateNativeOutputRate(completed, NOW + 3_000).output).toBeNull();
  });

  it("splits the window at completed requests and estimates only the next request", () => {
    const current = metrics({
      phase: "generating",
      inFlightStartMs: NOW - 2_000,
      latestEndMs: NOW - 1_000,
      recentRequests: [{ startMs: NOW - 11_000, endMs: NOW - 1_000, outputTokens: 1_000 }],
    });
    const rate = calculateNativeOutputRate(current, NOW);
    expect(rate.measured).toBeCloseTo(200 / 3);
    expect(rate.estimated).toBeCloseTo(100 / 3);
    expect(rate.output).toBeCloseTo(100);
  });

  it("never estimates during long tool waits, idle, cancellation or compaction", () => {
    for (const phase of ["tools", "idle"] as const) {
      const paused = metrics({ phase, inFlightStartMs: NOW - 60_000 });
      expect(calculateNativeOutputRate(paused, NOW).output).toBeNull();
    }
  });

  it("stops an in-flight estimate after five minutes without native activity", () => {
    const stale = metrics({
      phase: "generating",
      inFlightStartMs: NOW - 600_000,
      lastActivityMs: NOW - 300_001,
    });
    expect(calculateNativeOutputRate(stale, NOW).estimated).toBe(0);
  });

  it("retains an explainable same-model native fallback, then expires it", () => {
    const modelReference = {
      startMs: NOW - 1_210_000,
      endMs: NOW - 1_200_000,
      outputTokens: 2_000,
    };
    const fallback = metrics({
      phase: "generating",
      inFlightStartMs: NOW - 3_000,
      agentReferences: [modelReference],
      modelReferences: [modelReference],
    });
    expect(calculateNativeOutputRate(fallback, NOW)).toEqual({
      measured: 0,
      estimated: 200,
      output: 200,
      reference: "model",
    });
    expect(
      calculateNativeOutputRate({ ...fallback, lastActivityMs: NOW + 700_000 }, NOW + 700_000)
        .output,
    ).toBeNull();
  });

  it("weights the latest three own responses by native duration, not mean per-request speed", () => {
    const own = [
      { startMs: NOW - 20_000, endMs: NOW - 10_000, outputTokens: 1_000 },
      { startMs: NOW - 21_000, endMs: NOW - 20_000, outputTokens: 500 },
      { startMs: NOW - 31_000, endMs: NOW - 21_000, outputTokens: 1_000 },
      { startMs: NOW - 32_000, endMs: NOW - 31_000, outputTokens: 1_000_000 },
    ];
    const current = metrics({
      phase: "generating",
      inFlightStartMs: NOW - 3_000,
      agentReferences: own,
    });
    expect(calculateNativeOutputRate(current, NOW).output).toBeCloseTo(2_500 / 21);
  });

  it("keeps missing, failed and invalid native timing unknown instead of using the turn clock", () => {
    expect(calculateNativeOutputRate(null, NOW).output).toBeNull();
    const noReference = metrics({
      phase: "generating",
      inFlightStartMs: NOW - 10_000,
      agentReferences: [],
    });
    expect(calculateNativeOutputRate(noReference, NOW).output).toBeNull();
    expect(
      calculateNativeOutputRate({ ...noReference, inFlightStartMs: null }, NOW).output,
    ).toBeNull();
    const invalid = metrics({
      recentRequests: [{ startMs: NOW - 900_001, endMs: NOW, outputTokens: 5_000 }],
    });
    expect(calculateNativeOutputRate(invalid, NOW).measured).toBe(0);
  });
  it("keeps out-of-range request facts unknown rather than displaying infinite throughput", () => {
    const invalid = metrics({
      recentRequests: [{ startMs: NOW - 1_000, endMs: NOW, outputTokens: 1e308 }],
    });
    expect(calculateNativeOutputRate(invalid, NOW).output).toBeNull();
    expect(
      calculateNativeOutputRate(metrics({ recentRequests: Array(2_049).fill(reference) }), NOW)
        .output,
    ).toBeNull();
  });
});

describe("formatOutputTokenSpeed", () => {
  it("keeps the existing appearance without an approximation prefix", () => {
    expect(formatOutputTokenSpeed(12.345)).toBe("12.3");
    expect(formatOutputTokenSpeed(123.45)).toBe("123");
  });
});
