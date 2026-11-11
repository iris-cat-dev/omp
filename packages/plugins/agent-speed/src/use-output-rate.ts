import { useEffect, useState } from "react";
import type { AgentNativeOutputMetrics } from "@omp-desktop/protocol/agent-types";
import { calculateNativeOutputRate, type NativeOutputRate } from "./metrics";

export function turnMetricKey(hostId: string, agentId: string, turnId: string | null): string {
  return JSON.stringify([hostId, agentId, turnId]);
}

export function useOutputRate(
  scopeKey: string,
  active: boolean,
  metrics: AgentNativeOutputMetrics | null | undefined,
  signal: AbortSignal,
): NativeOutputRate | null {
  const [tick, setTick] = useState(() => ({ scopeKey, nowMs: Date.now(), visible: true }));
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const updateVisibility = () => {
      stop();
      const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
      setTick({ scopeKey, nowMs: Date.now(), visible });
      if (active && metrics && visible && !signal.aborted) {
        timer = setInterval(() => setTick({ scopeKey, nowMs: Date.now(), visible: true }), 500);
      }
    };
    updateVisibility();
    signal.addEventListener("abort", stop);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      stop();
      signal.removeEventListener("abort", stop);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [active, scopeKey, metrics, signal]);
  if (!active || !metrics || signal.aborted || !tick.visible || tick.scopeKey !== scopeKey) return null;
  return calculateNativeOutputRate(metrics, Math.max(tick.nowMs, Date.now()));
}
