import { describe, expect, it } from "vitest";
import { deriveTurnTokenStats, formatTokenCount } from "./turn-token-stats";

describe("formatTokenCount", () => {
  it("retains the existing compact count format", () => {
    for (const [count, label] of [[0, "0"], [950, "950"], [4600, "4.6k"], [1000, "1k"], [12500, "12.5k"], [1_250_000, "1.3M"], [12.4, "12"]] as const) {
      expect(formatTokenCount(count)).toBe(label);
    }
  });
});

describe("deriveTurnTokenStats", () => {
  it("keeps missing usage unknown and rejects session aggregates", () => {
    expect(deriveTurnTokenStats(null)).toBeNull();
    expect(deriveTurnTokenStats({})).toBeNull();
    expect(deriveTurnTokenStats({ inputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(deriveTurnTokenStats({ scope: "session", outputTokens: 5000 })).toBeNull();
  });
  it("retains normal totals without requiring a speed plugin or native timing", () => {
    expect(deriveTurnTokenStats({ scope: "turn", inputTokens: 1200, outputTokens: 3400, cachedInputTokens: 800 })).toEqual({ totalTokens: 4600 });
  });
  it("uses authoritative completed replay instead of retained partial live totals", () => {
    const recorded = { scope: "turn" as const, inputTokens: 100, outputTokens: 2000 };
    const replayed = { scope: "turn" as const, inputTokens: 100, outputTokens: 1000 };
    expect(deriveTurnTokenStats(recorded, replayed)).toEqual({ totalTokens: 1100 });
    expect(deriveTurnTokenStats(recorded)).toEqual({ totalTokens: 2100 });
    expect(deriveTurnTokenStats(recorded, { scope: "session", outputTokens: 9000 })).toEqual({ totalTokens: 2100 });
  });
  it("counts output once and retains untimed output in totals", () => {
    expect(deriveTurnTokenStats({ scope: "turn", inputTokens: 10, outputTokens: 150 })).toEqual({ totalTokens: 160 });
  });
});
