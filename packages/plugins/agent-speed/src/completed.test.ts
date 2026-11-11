import { describe, expect, it } from "vitest";
import type { AgentNativeOutputMetrics, AgentUsage } from "@omp-desktop/protocol/agent-types";
import { calculateCompletedOutputRate } from "./completed";

const native: AgentNativeOutputMetrics = {
  generation: 1, phase: "idle", inFlightStartMs: null, lastActivityMs: 10000,
  latestEndMs: 10000, measuredOutputTokens: 1000, measuredDurationMs: 10000,
  recentRequests: [], agentReferences: [], modelReferences: [],
};
const recorded: AgentUsage = { scope: "turn", inputTokens: 100, outputTokens: 2000, nativeMetrics: { ...native, measuredOutputTokens: 2000 } };

describe("completed own-agent native output speed", () => {
  it("retains identical output for distinct native turns", () => {
    expect(calculateCompletedOutputRate({ scope: "turn", outputTokens: 1000, nativeMetrics: native })).toBe(100);
    expect(calculateCompletedOutputRate({ scope: "turn", outputTokens: 1000, nativeMetrics: { ...native, generation: 2 } })).toBe(100);
  });
  it("uses only measured own output and request durations, not total output or Worked for", () => {
    expect(calculateCompletedOutputRate({ scope: "turn", inputTokens: 10, outputTokens: 150, nativeMetrics: { ...native, measuredOutputTokens: 120, measuredDurationMs: 3000 } })).toBe(40);
    expect(calculateCompletedOutputRate({ scope: "turn", outputTokens: 2500, nativeMetrics: { ...native, measuredOutputTokens: 2000, measuredDurationMs: 20000 } })).toBe(100);
  });
  it("prefers replay over a retained disconnected or overcounted sample", () => {
    const replayed: AgentUsage = { scope: "turn", outputTokens: 1000, nativeMetrics: native };
    expect(calculateCompletedOutputRate(recorded, replayed)).toBe(100);
    expect(calculateCompletedOutputRate({ scope: "turn", outputTokens: 0 }, replayed)).toBe(100);
    expect(calculateCompletedOutputRate(recorded)).toBe(200);
    expect(calculateCompletedOutputRate(recorded, { scope: "session", outputTokens: 9000 })).toBe(200);
  });
  it("never borrows session totals or invents missing timing", () => {
    expect(calculateCompletedOutputRate(null)).toBeNull();
    expect(calculateCompletedOutputRate({ scope: "session", outputTokens: 1000, nativeMetrics: native })).toBeNull();
    expect(calculateCompletedOutputRate({ outputTokens: 240 })).toBeNull();
    for (const duration of [0, -1, 499, Number.NaN, Number.POSITIVE_INFINITY, 1e308]) {
      expect(calculateCompletedOutputRate({ outputTokens: 1000, nativeMetrics: { ...native, measuredDurationMs: duration } })).toBeNull();
    }
  });
  it("retains a valid measured zero and rejects impossible output facts", () => {
    expect(calculateCompletedOutputRate({ inputTokens: 100, outputTokens: 0, nativeMetrics: { ...native, measuredOutputTokens: 0, measuredDurationMs: 500 } })).toBe(0);
    for (const output of [1001, -1, 1e308]) {
      expect(calculateCompletedOutputRate({ outputTokens: 1000, nativeMetrics: { ...native, measuredOutputTokens: output } })).toBeNull();
    }
  });
});
