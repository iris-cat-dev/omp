import { createHash } from "node:crypto";
import path from "node:path";
import type { OmpMonitorPhase, OmpMonitorUsage } from "./types.js";

export const TOKEN_LIMIT = 1_000_000_000_000;
export const MAX_DURATION_MS = 15 * 60_000;
export const MAX_TOOL_CALLS = 512;
const MAX_STAMP = Number.MAX_SAFE_INTEGER;
type JsonObject = Record<string, unknown>;

export interface NumericResponse extends OmpMonitorUsage {
  key: string;
  agentId: string;
  model: string | null;
  provider: string | null;
  serviceTier: string | null;
  endMs: number;
  startMs: number | null;
  ttftMs: number | null;
  sideCall: boolean;
}

export interface NumericSink {
  otherOwner(key: string): boolean;
  upsert(response: NumericResponse): void;
  limit(): void;
  acceptTools(count: number): boolean;
}

export function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value || value.length > 160) return fallback;
  // Labels are metadata, never a free-form title, message, or filesystem path.
  for (let position = 0; position < value.length; position++) {
    const code = value.charCodeAt(position);
    if (code < 32 || code === 127 || code === 47 || code === 92) return fallback;
  }
  if (/^[A-Za-z]:/.test(value)) return fallback;
  return value.trim() || fallback;
}

function modelLabel(value: string): string | null {
  if (!value || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9_.:/@+ -]*$/.test(value)) return null;
  if (/^[A-Za-z]:[\\/]/.test(value) || value.includes("..") || value.includes("://")) return null;
  return value;
}

export function token(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) return 0;
  return Math.min(TOKEN_LIMIT, Math.trunc(value));
}

function milliseconds(value: unknown, positive: boolean): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive ? value <= 0 : value < 0))
    return null;
  return Math.min(MAX_STAMP, Math.trunc(value));
}

function readTtft(message: JsonObject): number | null {
  const value = milliseconds(message.ttft, false);
  return value !== null && value <= MAX_DURATION_MS ? value : null;
}

function recordedCost(usage: JsonObject): number | null {
  const value = object(usage.cost)?.total;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(1_000_000_000, value);
}

function totalTokens(usage: JsonObject, rawSum: number): number {
  const native = usage.totalTokens;
  if (typeof native === "number" && !Number.isNaN(native) && native >= 0) return token(native);
  return Math.min(TOKEN_LIMIT, rawSum);
}

function measuredDuration(
  start: number | null,
  duration: number | null,
  sideCall: boolean,
  failed: boolean,
): number {
  if (sideCall || failed || start === null || duration === null || duration > MAX_DURATION_MS)
    return 0;
  return Math.max(500, duration);
}

function serviceTier(message: JsonObject): string | null {
  if (typeof message.serviceTier !== "string") return null;
  return safeLabel(message.serviceTier, "") || null;
}

/** Strict zoned ISO timestamp; Date.parse alone accepts invalid dates and zone-less local time. */
export function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):?(\d{2}))$/.exec(
      value,
    );
  if (!match) return null;
  const [, y, m, d, h, minute, second, fraction, zone, sign, zoneH, zoneM] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const hour = Number(h);
  const min = Number(minute);
  const sec = Number(second);
  const offsetH = Number(zoneH ?? 0);
  const offsetM = Number(zoneM ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    min > 59 ||
    sec > 59 ||
    offsetH > 23 ||
    offsetM > 59
  )
    return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, min, sec, Number((fraction ?? "").padEnd(3, "0").slice(0, 3)));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  const offset =
    zone.toLowerCase() === "z" ? 0 : (offsetH * 60 + offsetM) * (sign === "+" ? 1 : -1);
  return date.getTime() - offset * 60_000;
}

export function emptyUsage(): OmpMonitorUsage {
  return {
    requests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedRequests: 0,
    estimatedCostUsd: 0,
    unestimatedRequests: 0,
    measuredOutputTokens: 0,
    measuredDurationMs: 0,
    peakOutputTps: 0,
  };
}

/** OMP-only numeric state machine, inspired by Agent Speed METRICS §4.7 (MIT). */
export class OmpNumericParser {
  headerSeen = false;
  headerMs: number | null = null;
  project = "";
  projectId = "";
  model: string | null = null;
  ttftMs: number | null = null;
  phase: OmpMonitorPhase = "idle";
  inFlightStartMs: number | null = null;
  lastActivityAt = 0;
  private stateAt = -Infinity;
  private readonly pendingToolCalls = new Set<string>();
  private toolOverflow = false;

  constructor(private readonly agentId: string) {}

  get pendingToolCount(): number {
    return this.pendingToolCalls.size;
  }

  apply(value: unknown, sink: NumericSink): void {
    const entry = object(value);
    if (!entry || entry.type === "title") return;
    const ts = timestamp(entry.timestamp);
    if (entry.type === "session") {
      this.applyHeader(entry, ts, sink);
      return;
    }
    if (
      !this.headerSeen ||
      typeof entry.id !== "string" ||
      ts === null ||
      (this.headerMs !== null && ts < this.headerMs - 2_000)
    )
      return;
    this.lastActivityAt = Math.max(this.lastActivityAt, ts);
    if (entry.id.length > 4_096) {
      sink.limit();
      return;
    }
    if (entry.type === "custom" && entry.customType === "session_exit" && ts >= this.stateAt) {
      this.setPhase("idle", ts, null);
      this.clearTools();
      return;
    }
    if (entry.type === "model_usage") {
      this.assistant(entry, entry, ts, true, sink);
      return;
    }
    if (entry.type === "message") this.applyMessage(entry, ts, sink);
  }

  private applyHeader(entry: JsonObject, ts: number | null, sink: NumericSink): void {
    if (this.headerSeen) return;
    this.headerSeen = true;
    this.headerMs = ts;
    this.setProject(entry.cwd, sink);
    if (ts !== null) this.lastActivityAt = ts;
  }

  private setProject(cwd: unknown, sink: NumericSink): void {
    if (typeof cwd !== "string" || !cwd.length) return;
    if (cwd.length > 4_096) {
      sink.limit();
      return;
    }
    const windows = /^[A-Za-z]:[\\/]|^[\\/]{2}/.test(cwd);
    const normalized = windows
      ? path.win32.normalize(cwd).replace(/\\/g, "/").toLowerCase()
      : path.posix.normalize(cwd);
    const canonical = normalized.replace(/\/+$/, "") || normalized;
    this.projectId = hashId(canonical);
    const parts = canonical.split("/").filter(Boolean);
    const name = safeLabel(parts.at(-1), "Root").slice(0, 145);
    // Always include identity: another 'repo' must not invalidate an open scope.
    this.project = `${name} [${this.projectId.slice(0, 12)}]`;
  }

  private applyMessage(entry: JsonObject, ts: number, sink: NumericSink): void {
    const message = object(entry.message);
    if (!message) return;
    switch (message.role) {
      case "user":
      case "developer":
        if (ts >= this.stateAt) this.clearTools();
        this.setPhase("generating", ts, ts);
        break;
      case "assistant":
        this.assistant(entry, message, ts, false, sink);
        break;
      case "toolResult":
        this.applyToolResult(message, ts);
        break;
    }
  }

  private applyToolResult(message: JsonObject, ts: number): void {
    if (ts < this.stateAt) return;
    if (typeof message.toolCallId === "string" && message.toolCallId.length <= 4_096)
      this.pendingToolCalls.delete(hashId(message.toolCallId));
    if (message.toolName === "yield" && message.isError !== true) {
      this.clearTools();
      this.setPhase("idle", ts, null);
    } else if (this.phase === "tools" && !this.toolOverflow && this.pendingToolCalls.size === 0) {
      this.setPhase("generating", ts, ts);
    }
  }

  discardStaleTools(now: number): void {
    if (now - this.lastActivityAt <= 300_000 || !this.pendingToolCalls.size) return;
    this.pendingToolCalls.clear();
    // A delayed result cannot prove that every forgotten call completed.
    this.toolOverflow = true;
  }

  private assistant(
    entry: JsonObject,
    message: JsonObject,
    ts: number,
    sideCall: boolean,
    sink: NumericSink,
  ): void {
    const usage = object(message.usage);
    if (
      typeof message.model !== "string" ||
      typeof message.provider !== "string" ||
      typeof message.api !== "string" ||
      !usage
    )
      return;
    const start = sideCall ? null : milliseconds(message.timestamp, true);
    const key = hashId(`omp:${entry.id as string}:${sideCall ? ts : (start ?? ts)}`);
    if (sink.otherOwner(key)) {
      // Keep only numeric duplicate candidates, so deleting the original can reveal an available copy.
      this.emit(message, usage, key, start, ts, sideCall, sink);
      return;
    }
    const end = this.emit(message, usage, key, start, ts, sideCall, sink);
    if (sideCall || ts < this.stateAt) return;
    this.applyAssistantPhase(message, usage, ts, end, sink);
  }

  private applyAssistantPhase(
    message: JsonObject,
    usage: JsonObject,
    ts: number,
    end: number,
    sink: NumericSink,
  ): void {
    const reason = typeof message.stopReason === "string" ? message.stopReason : "aborted";
    const hasUsage =
      token(usage.input) + token(usage.output) + token(usage.cacheRead) + token(usage.cacheWrite) >
      0;
    if (hasUsage) {
      this.model = modelLabel(message.model as string);
      this.ttftMs = readTtft(message);
    }
    if (reason === "error" || reason === "aborted") {
      this.clearTools();
      this.setPhase("idle", ts, null);
      return;
    }
    this.clearTools();
    const calls = this.toolCallIds(message, sink);
    if (
      (calls.length || this.toolOverflow) &&
      (reason === "toolUse" || reason === "stop" || reason === "length")
    ) {
      this.acceptToolCalls(calls, ts, sink);
    } else if (
      (reason === "stop" && object(message.stopDetails)?.type === "pause_turn") ||
      reason === "pause_turn"
    ) {
      this.clearTools();
      this.setPhase("generating", ts, end);
    } else {
      this.clearTools();
      this.setPhase("idle", ts, null);
    }
  }

  private toolCallIds(message: JsonObject, sink: NumericSink): string[] {
    const calls: string[] = [];
    if (!Array.isArray(message.content)) return calls;
    for (const block of message.content) {
      const call = object(block);
      if (call?.type !== "toolCall" || typeof call.id !== "string") continue;
      if (call.id.length > 4_096 || calls.length >= MAX_TOOL_CALLS) {
        this.toolOverflow = true;
        sink.limit();
        break;
      }
      calls.push(hashId(call.id));
    }
    return calls;
  }

  private acceptToolCalls(calls: string[], ts: number, sink: NumericSink): void {
    if (!sink.acceptTools(calls.length)) {
      calls.length = 0;
      this.toolOverflow = true;
      sink.limit();
    }
    this.pendingToolCalls.clear();
    for (const id of calls) this.pendingToolCalls.add(id);
    this.setPhase("tools", ts, null);
  }

  private emit(
    message: JsonObject,
    usage: JsonObject,
    key: string,
    start: number | null,
    ts: number,
    sideCall: boolean,
    sink: NumericSink,
  ): number {
    const duration = sideCall ? null : milliseconds(message.duration, false);
    const completedAt = milliseconds(message.completedAt, true);
    const end =
      start !== null && duration !== null
        ? Math.min(MAX_STAMP, start + duration)
        : (completedAt ?? ts);
    const inputTokens = token(usage.input);
    const outputTokens = token(usage.output);
    const cacheReadTokens = token(usage.cacheRead);
    const cacheWriteTokens = token(usage.cacheWrite);
    if (!(inputTokens || outputTokens || cacheReadTokens || cacheWriteTokens)) return end;
    const reason = typeof message.stopReason === "string" ? message.stopReason : "aborted";
    const failed = !sideCall && (reason === "error" || reason === "aborted");
    // Missing/invalid native duration is unknown, not a guessed user-to-response interval.
    const normalizedDuration = measuredDuration(start, duration, sideCall, failed);
    const measured = normalizedDuration > 0;
    const cost = recordedCost(usage);
    sink.upsert({
      key,
      agentId: this.agentId,
      model: modelLabel(message.model as string),
      endMs: end,
      provider: modelLabel(message.provider as string),
      serviceTier: serviceTier(message),
      startMs: measured ? end - normalizedDuration : null,
      ttftMs: sideCall ? null : readTtft(message),
      sideCall,
      requests: 1,
      failedRequests: failed ? 1 : 0,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: totalTokens(
        usage,
        inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      ),
      costUsd: cost ?? 0,
      unpricedRequests: cost === null ? 1 : 0,
      estimatedCostUsd: 0,
      unestimatedRequests: 1,
      measuredOutputTokens: measured ? outputTokens : 0,
      measuredDurationMs: normalizedDuration,
      peakOutputTps: 0,
    });
    return end;
  }

  private clearTools(): void {
    this.pendingToolCalls.clear();
    this.toolOverflow = false;
  }

  private setPhase(phase: OmpMonitorPhase, at: number, start: number | null): void {
    if (at < this.stateAt) return;
    this.stateAt = at;
    this.phase = phase;
    this.inFlightStartMs = phase === "generating" ? start : null;
  }
}
