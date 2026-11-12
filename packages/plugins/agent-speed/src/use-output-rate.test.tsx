// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentNativeOutputMetrics } from "@omp-desktop/protocol/agent-types";
import { turnMetricKey, useOutputRate } from "./use-output-rate";

const NOW = 1800000000000;
const metrics: AgentNativeOutputMetrics = {
  generation: 1, phase: "generating", inFlightStartMs: NOW - 1500,
  lastActivityMs: NOW, latestEndMs: null, measuredOutputTokens: 0, measuredDurationMs: 0,
  recentRequests: [], modelReferences: [],
  agentReferences: [{ startMs: NOW - 30000, endMs: NOW - 20000, outputTokens: 1000 }],
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
});

describe("scoped plugin metric refresh", () => {
  it("retains 500ms refresh only for a visible active context", () => {
    const controller = new AbortController();
    const { result, rerender } = renderHook(({ active }) => useOutputRate("turn", active, metrics, controller.signal), { initialProps: { active: true } });
    expect(result.current?.output).toBe(50);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current?.output).toBeCloseTo(200 / 3);
    rerender({ active: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current).toBeNull();
  });
  it("stops refresh on browser hiding, activation abort and unmount", () => {
    const controller = new AbortController();
    const { result, unmount } = renderHook(() => useOutputRate("turn", true, metrics, controller.signal));
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current).toBeNull();
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(vi.getTimerCount()).toBe(1);
    act(() => controller.abort());
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not collide host/agent/turn keys or borrow another context's tick", () => {
    expect(turnMetricKey("a:b", "c", "d")).not.toBe(turnMetricKey("a", "b:c", "d"));
    const controller = new AbortController();
    const other = { ...metrics, agentReferences: [{ startMs: NOW - 30000, endMs: NOW - 20000, outputTokens: 2000 }] };
    const { result, rerender } = renderHook(({ key, facts }) => useOutputRate(key, true, facts, controller.signal), { initialProps: { key: "first", facts: metrics } });
    expect(result.current?.output).toBe(50);
    rerender({ key: "second", facts: other });
    expect(result.current?.output).toBe(100);
    expect(vi.getTimerCount()).toBe(1);
  });
  it("does not allocate refresh timers without native samples or on disabled activation", () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = renderHook(() => useOutputRate("turn", true, metrics, controller.signal));
    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
