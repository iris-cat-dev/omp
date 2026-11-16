import { useEffect, useState } from "react";
import type {
  AgentNativeOutputMetrics,
  AgentNativeOutputRequest,
  AgentUsage,
} from "@omp-desktop/protocol/agent-types";

const LIVE_WINDOW_MS = 3_000;

export interface NativeOutputRate {
  measured: number;
  estimated: number;
  output: number | null;
  reference: "agent" | "model" | null;
}

function overlap(startMs: number, endMs: number, windowStartMs: number, nowMs: number): number {
  return Math.max(0, Math.min(endMs, nowMs) - Math.max(startMs, windowStartMs));
}

function validRequest(request: AgentNativeOutputRequest): boolean {
  const durationMs = request.endMs - request.startMs;
  return (
    Number.isFinite(request.startMs) &&
    Number.isFinite(request.endMs) &&
    durationMs >= 500 &&
    durationMs <= 15 * 60_000 &&
    Number.isFinite(request.outputTokens) &&
    request.outputTokens <= 1_000_000_000_000 &&
    request.outputTokens >= 0
  );
}

function recentReference(
  requests: readonly AgentNativeOutputRequest[],
  nowMs: number,
  ageMs: number,
): number | null {
  // The protocol bounds references to three own requests or ten same-model requests.
  let outputTokens = 0;
  let durationMs = 0;
  for (const request of requests) {
    if (!validRequest(request) || request.endMs < nowMs - ageMs || request.endMs > nowMs) continue;
    outputTokens += request.outputTokens;
    durationMs += request.endMs - request.startMs;
  }
  return durationMs > 0 ? outputTokens / (durationMs / 1_000) : null;
}

/** Native request metering retained from Agent Speed v1.5.0 (MIT). */
export function calculateNativeOutputRate(
  metrics: AgentNativeOutputMetrics | null | undefined,
  nowMs: number,
): NativeOutputRate {
  if (!metrics || !Number.isFinite(nowMs)) {
    return { measured: 0, estimated: 0, output: null, reference: null };
  }
  const windowStartMs = nowMs - LIVE_WINDOW_MS;
  let measuredTokens = 0;
  for (const request of metrics.recentRequests) {
    if (!validRequest(request)) continue;
    measuredTokens +=
      request.outputTokens *
      (overlap(request.startMs, request.endMs, windowStartMs, nowMs) /
        (request.endMs - request.startMs));
  }
  const ownReference = recentReference(metrics.agentReferences, nowMs, 10 * 60_000);
  const modelReference =
    ownReference === null ? recentReference(metrics.modelReferences, nowMs, 30 * 60_000) : null;
  let reference: NativeOutputRate["reference"] = null;
  if (ownReference !== null) reference = "agent";
  else if (modelReference !== null) reference = "model";
  const referenceSpeed = ownReference ?? modelReference;
  let estimatedTokens = 0;
  if (
    metrics.phase === "generating" &&
    metrics.inFlightStartMs !== null &&
    Number.isFinite(metrics.inFlightStartMs) &&
    nowMs - metrics.lastActivityMs <= 300_000 &&
    referenceSpeed !== null
  ) {
    const estimateStart = Math.max(
      metrics.inFlightStartMs,
      metrics.latestEndMs ?? metrics.inFlightStartMs,
    );
    estimatedTokens =
      (referenceSpeed * overlap(estimateStart, nowMs, windowStartMs, nowMs)) / 1_000;
  }
  const measured = measuredTokens / (LIVE_WINDOW_MS / 1_000);
  const estimated = estimatedTokens / (LIVE_WINDOW_MS / 1_000);
  const output = measured + estimated;
  return Number.isFinite(output)
    ? { measured, estimated, output: output > 0 ? output : null, reference }
    : { measured: 0, estimated: 0, output: null, reference: null };
}

/** Replay is authoritative; only this turn's valid native requests contribute. */
export function calculateCompletedOutputRate(
  recordedUsage: AgentUsage | null | undefined,
  replayedUsage?: AgentUsage | null,
): number | null {
  const usage =
    replayedUsage?.scope === "session" ? recordedUsage : (replayedUsage ?? recordedUsage);
  if (usage?.scope === "session") return null;
  const native = usage?.nativeMetrics;
  const outputTokens = usage?.outputTokens;
  if (
    !native ||
    !Number.isSafeInteger(native.measuredDurationMs) ||
    native.measuredDurationMs < 500 ||
    !Number.isSafeInteger(native.measuredOutputTokens) ||
    native.measuredOutputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    native.measuredOutputTokens > outputTokens
  ) {
    return null;
  }
  return native.measuredOutputTokens / (native.measuredDurationMs / 1_000);
}

export function formatOutputTokenSpeed(tokensPerSecond: number): string {
  return tokensPerSecond >= 100
    ? Math.round(tokensPerSecond).toString()
    : tokensPerSecond.toFixed(1);
}

export function useNativeOutputRate(
  scopeKey: string,
  active: boolean,
  metrics: AgentNativeOutputMetrics | null | undefined,
): NativeOutputRate | null {
  const [tick, setTick] = useState(() => ({
    scopeKey,
    nowMs: Date.now(),
    visible: typeof document === "undefined" || document.visibilityState !== "hidden",
  }));
  useEffect(() => {
    if (!active || !metrics) return;
    let timer: number | NodeJS.Timeout | undefined;
    const updateVisibility = () => {
      clearInterval(timer);
      const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
      setTick({ scopeKey, nowMs: Date.now(), visible });
      if (visible) {
        timer = setInterval(() => setTick({ scopeKey, nowMs: Date.now(), visible: true }), 500);
      }
    };
    updateVisibility();
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      clearInterval(timer);
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [active, scopeKey, metrics]);
  if (!active || !metrics || !tick.visible || tick.scopeKey !== scopeKey) return null;
  return calculateNativeOutputRate(metrics, Math.max(tick.nowMs, Date.now()));
}
