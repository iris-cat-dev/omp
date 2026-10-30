import { useEffect, useState } from "react";
import type {
  AgentNativeOutputMetrics,
  AgentNativeOutputRequest,
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
  count: number,
): number | null {
  const recent = requests
    .filter(
      (request) =>
        validRequest(request) && request.endMs >= nowMs - ageMs && request.endMs <= nowMs,
    )
    .sort((left, right) => right.endMs - left.endMs)
    .slice(0, count);
  if (recent.length === 0) return null;
  let outputTokens = 0;
  let durationMs = 0;
  for (const request of recent) {
    outputTokens += request.outputTokens;
    durationMs += request.endMs - request.startMs;
  }
  return outputTokens / (durationMs / 1_000);
}

/** Agent Speed v1.5.0 METRICS §§6.2–6.3 (MIT); no wall-clock token-counter deltas. */
export function calculateNativeOutputRate(
  metrics: AgentNativeOutputMetrics | null | undefined,
  nowMs: number,
): NativeOutputRate {
  if (
    !metrics ||
    !Number.isFinite(nowMs) ||
    metrics.recentRequests.length > 2_048 ||
    metrics.agentReferences.length > 2_048 ||
    metrics.modelReferences.length > 2_048
  ) {
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
  const ownReference = recentReference(metrics.agentReferences, nowMs, 10 * 60_000, 3);
  const modelReference =
    ownReference === null ? recentReference(metrics.modelReferences, nowMs, 30 * 60_000, 10) : null;
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

export function formatOutputTokenSpeed(tokensPerSecond: number): string {
  return tokensPerSecond >= 100
    ? Math.round(tokensPerSecond).toString()
    : tokensPerSecond.toFixed(1);
}

export function useNativeOutputTokenSpeed(
  scopeKey: string,
  active: boolean,
  metrics: AgentNativeOutputMetrics | null | undefined,
): number | null {
  const [tick, setTick] = useState(() => ({ scopeKey, nowMs: Date.now() }));
  useEffect(() => {
    if (!active || !metrics) return;
    setTick({ scopeKey, nowMs: Date.now() });
    const timer = setInterval(() => setTick({ scopeKey, nowMs: Date.now() }), 500);
    return () => clearInterval(timer);
  }, [active, scopeKey, metrics]);
  if (!active || !metrics || tick.scopeKey !== scopeKey) return null;
  return calculateNativeOutputRate(metrics, Math.max(tick.nowMs, Date.now())).output;
}
