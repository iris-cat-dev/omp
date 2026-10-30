import type {
  AgentNativeOutputMetrics,
  AgentNativeOutputRequest,
  AgentUsage,
} from "@omp-desktop/protocol/agent-types";
import type { OmpAgentMessage } from "./rpc-types.js";

// Agent Speed v1.5.0, METRICS §§3.2–3.3, 4.7 and 6.2–6.3 (MIT).
const TOKEN_CAP = 1_000_000_000_000;
const MAX_DURATION_MS = 15 * 60_000;
const REFERENCE_RETENTION_MS = 30 * 60_000;
const MAX_SEEN_REQUESTS = 65_536;
const MAX_LIVE_REQUESTS = 2_048;

type AssistantMessage = Extract<OmpAgentMessage, { role: "assistant" }>;
interface NativeRequest {
  key: string;
  model: string;
  provider: string;
  usage: AgentUsage;
  endMs: number | null;
  measured: AgentNativeOutputRequest | null;
}

function token(value: unknown): number {
  return typeof value === "number" && !Number.isNaN(value)
    ? Math.min(TOKEN_CAP, Math.max(0, Math.trunc(value)))
    : 0;
}

function nativeTimestamp(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 8_640_000_000_000_000
    ? Math.trunc(value)
    : null;
}

function requestKey(message: AssistantMessage): string | null {
  const id = message.responseId || message.entryId;
  const startMs = nativeTimestamp(message.timestamp);
  if (!id && startMs === null) return null;
  return `${id ?? ""}:${startMs ?? ""}`;
}

function requestEndMs(message: AssistantMessage, startMs: number | null): number | null {
  if (
    startMs !== null &&
    typeof message.duration === "number" &&
    Number.isFinite(message.duration) &&
    message.duration >= 0
  ) {
    return nativeTimestamp(startMs + Math.trunc(message.duration));
  }
  return nativeTimestamp(message.completedAt);
}

function isSuccessfulAssistant(message: AssistantMessage): boolean {
  return (
    typeof message.stopReason === "string" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted"
  );
}

function readMeasuredRequest(
  message: AssistantMessage,
  startMs: number | null,
  endMs: number | null,
  outputTokens: number,
): AgentNativeOutputRequest | null {
  const durationMs = startMs !== null && endMs !== null ? endMs - startMs : null;
  return isSuccessfulAssistant(message) &&
    startMs !== null &&
    endMs !== null &&
    Number.isSafeInteger(endMs) &&
    durationMs !== null &&
    durationMs >= 0 &&
    durationMs <= MAX_DURATION_MS
    ? { startMs: endMs - Math.max(500, durationMs), endMs, outputTokens }
    : null;
}

function hasAssistantTools(message: AssistantMessage): boolean {
  return (
    (message.stopReason === "toolUse" ||
      message.stopReason === "stop" ||
      message.stopReason === "length") &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "toolCall" && typeof block.id === "string")
  );
}

function readNativeRequest(message: AssistantMessage): NativeRequest | null {
  if (
    typeof message.model !== "string" ||
    typeof message.provider !== "string" ||
    typeof message.api !== "string" ||
    !message.usage ||
    typeof message.usage !== "object" ||
    Array.isArray(message.usage)
  ) {
    return null;
  }
  const key = requestKey(message);
  if (key === null) return null;
  const inputTokens = token(message.usage.input);
  const cachedInputTokens = token(message.usage.cacheRead);
  const outputTokens = token(message.usage.output);
  if (inputTokens + cachedInputTokens + outputTokens + token(message.usage.cacheWrite) === 0) {
    return null;
  }
  const cost = message.usage.cost?.total;
  const startMs = nativeTimestamp(message.timestamp);
  const endMs = requestEndMs(message, startMs);
  const measured = readMeasuredRequest(message, startMs, endMs, outputTokens);
  return {
    key,
    model: message.model,
    provider: message.provider,
    usage: {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0,
    },
    endMs,
    measured,
  };
}

export class OmpNativeUsageTracker {
  private turnId: string | null = null;
  private active = false;
  private hasNativeFacts = false;
  private generation = 0;
  private acceptAfterMs = 0;
  private phase: AgentNativeOutputMetrics["phase"] = "idle";
  private inFlightStartMs: number | null = null;
  private inFlightKey: string | null = null;
  private lastActivityMs = 0;
  private latestEndMs: number | null = null;
  private selectedModel: { model: string; provider: string } | null = null;
  private readonly turnRequests = new Map<string, NativeRequest>();
  private readonly seen = new Map<string, string>();
  private readonly references = new Map<string, NativeRequest>();
  private readonly pendingTools = new Set<string>();

  constructor(private readonly retainReferences = true) {}

  startTurn(turnId: string, nowMs: number, model?: { id: string; provider: string } | null): void {
    this.turnId = turnId;
    this.active = true;
    this.hasNativeFacts = false;
    this.generation += 1;
    this.acceptAfterMs = nowMs;
    this.phase = "idle";
    this.inFlightStartMs = null;
    this.inFlightKey = null;
    this.lastActivityMs = nowMs;
    this.latestEndMs = null;
    this.selectedModel = model ? { model: model.id, provider: model.provider } : null;
    this.turnRequests.clear();
    this.pendingTools.clear();
    this.pruneReferences(nowMs);
  }

  observeInput(
    message: Extract<OmpAgentMessage, { role: "user" | "developer" | "toolResult" }>,
    nowMs: number,
  ): boolean {
    if (!this.active) return false;
    const startMs = nativeTimestamp(message.timestamp);
    if (startMs !== null && startMs < this.acceptAfterMs) return false;
    if (message.role === "toolResult") {
      if (!this.pendingTools.has(message.toolCallId)) return false;
      if (message.toolName === "yield" && message.isError !== true) {
        this.phase = "idle";
        this.inFlightStartMs = null;
        this.inFlightKey = null;
        this.pendingTools.clear();
        this.lastActivityMs = nowMs;
        return this.hasNativeFacts;
      }
      this.pendingTools.delete(message.toolCallId);
      if (this.phase !== "tools" || this.pendingTools.size !== 0) return false;
    }
    if (startMs === null) return false;
    this.pendingTools.clear();
    this.phase = "generating";
    this.inFlightStartMs = startMs;
    this.inFlightKey = null;
    this.lastActivityMs = nowMs;
    this.hasNativeFacts = true;
    return true;
  }

  startRequest(message: AssistantMessage, nowMs: number): boolean {
    if (!this.active) return false;
    const startMs = nativeTimestamp(message.timestamp);
    const key = requestKey(message);
    if (startMs !== null && startMs < this.acceptAfterMs) return false;
    if (key && this.seen.has(key)) return false;
    this.phase = "generating";
    this.inFlightStartMs = startMs;
    this.inFlightKey = key;
    this.pendingTools.clear();
    this.lastActivityMs = nowMs;
    if (startMs !== null) this.hasNativeFacts = true;
    if (message.model && message.provider) {
      this.selectedModel = { model: message.model, provider: message.provider };
    }
    return startMs !== null;
  }

  touch(message: AssistantMessage, nowMs: number): boolean {
    if (!this.active || this.phase !== "generating") return false;
    const key = requestKey(message);
    const startMs = nativeTimestamp(message.timestamp);
    if (key !== this.inFlightKey && (startMs === null || startMs !== this.inFlightStartMs))
      return false;
    this.lastActivityMs = nowMs;
    return true;
  }

  recordAssistant(message: AssistantMessage, nowMs: number): boolean {
    if (!this.active || !this.turnId) return false;
    const startMs = nativeTimestamp(message.timestamp);
    const key = requestKey(message);
    if (!this.acceptsAssistant(startMs, key)) return false;
    const previouslyCompleted =
      key !== null && this.turnRequests.has(key) && key !== this.inFlightKey;
    const request = readNativeRequest(message);
    if (request) this.recordRequest(request, this.turnId, nowMs);
    if (previouslyCompleted) return true;
    this.updateAssistantPhase(message, request, startMs, nowMs);
    return this.hasNativeFacts;
  }

  private acceptsAssistant(startMs: number | null, key: string | null): boolean {
    if (startMs !== null && startMs < this.acceptAfterMs) return false;
    // An unidentifiable late message cannot be assigned to a new generation.
    if (startMs === null && (key === null || key !== this.inFlightKey) && this.acceptAfterMs > 0) {
      return false;
    }
    if (key && this.seen.has(key) && !this.turnRequests.has(key)) return false;
    return true;
  }

  private recordRequest(request: NativeRequest, turnId: string, nowMs: number): void {
    const previous = this.turnRequests.get(request.key);
    if (previous) {
      const usage = request.usage;
      const previousUsage = previous.usage;
      usage.inputTokens = Math.max(previousUsage.inputTokens ?? 0, usage.inputTokens ?? 0);
      usage.cachedInputTokens = Math.max(
        previousUsage.cachedInputTokens ?? 0,
        usage.cachedInputTokens ?? 0,
      );
      usage.outputTokens = Math.max(previousUsage.outputTokens ?? 0, usage.outputTokens ?? 0);
      usage.totalCostUsd = Math.max(previousUsage.totalCostUsd ?? 0, usage.totalCostUsd ?? 0);
      if (request.measured) request.measured.outputTokens = usage.outputTokens ?? 0;
    }
    this.hasNativeFacts = true;
    this.turnRequests.set(request.key, request);
    this.seen.set(request.key, turnId);
    if (this.seen.size > MAX_SEEN_REQUESTS) this.seen.delete(this.seen.keys().next().value!);
    this.rememberReference(request, nowMs);
    if (request.endMs !== null) {
      this.latestEndMs = Math.max(this.latestEndMs ?? request.endMs, request.endMs);
    }
  }

  private updateAssistantPhase(
    message: AssistantMessage,
    request: NativeRequest | null,
    startMs: number | null,
    nowMs: number,
  ): void {
    this.lastActivityMs = nowMs;
    this.inFlightStartMs = null;
    this.inFlightKey = null;
    const failed = !isSuccessfulAssistant(message);
    const hasTools = hasAssistantTools(message);
    this.phase = !failed && hasTools ? "tools" : "idle";
    this.pendingTools.clear();
    if (this.phase === "tools") {
      for (const block of message.content) {
        if (block.type === "toolCall" && typeof block.id === "string")
          this.pendingTools.add(block.id);
      }
    }
    if (
      !failed &&
      !hasTools &&
      message.stopReason === "stop" &&
      message.stopDetails?.type === "pause_turn"
    ) {
      this.phase = "generating";
      this.inFlightStartMs = request?.endMs ?? requestEndMs(message, startMs);
    }
  }

  pause(nowMs: number, phase: "tools" | "idle" = "idle"): void {
    if (!this.active) return;
    if (phase === "idle") {
      this.generation += 1;
      this.acceptAfterMs = nowMs;
      this.pendingTools.clear();
    }
    this.phase = phase;
    this.inFlightStartMs = null;
    this.inFlightKey = null;
    this.lastActivityMs = nowMs;
  }

  finish(nowMs: number): void {
    this.pause(nowMs);
    this.active = false;
  }

  seedReference(message: AssistantMessage, nowMs: number): void {
    const request = readNativeRequest(message);
    if (request) this.rememberReference(request, nowMs);
  }

  getUsage(turnId: string, nowMs: number, live = true): AgentUsage | undefined {
    if (!this.hasNativeFacts) return undefined;
    if (turnId !== this.turnId) return undefined;
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    let totalCostUsd = 0;
    let measuredOutputTokens = 0;
    let measuredDurationMs = 0;
    const recentRequests: AgentNativeOutputRequest[] = [];
    for (const request of this.turnRequests.values()) {
      inputTokens += request.usage.inputTokens ?? 0;
      cachedInputTokens += request.usage.cachedInputTokens ?? 0;
      outputTokens += request.usage.outputTokens ?? 0;
      totalCostUsd += request.usage.totalCostUsd ?? 0;
      if (request.measured) {
        measuredOutputTokens += request.measured.outputTokens;
        measuredDurationMs += request.measured.endMs - request.measured.startMs;
        if (
          live &&
          request.measured.endMs >= nowMs - 3_000 &&
          recentRequests.length <= MAX_LIVE_REQUESTS
        ) {
          recentRequests.push(request.measured);
        }
      }
    }
    this.pruneReferences(nowMs);
    const references = live
      ? [...this.references.values()].sort((a, b) => b.measured!.endMs - a.measured!.endMs)
      : [];
    const agentReferences = references
      .filter((request) => request.measured!.endMs >= nowMs - 10 * 60_000)
      .slice(0, 3)
      .map((request) => request.measured!);
    const modelReferences = references
      .filter(
        (request) =>
          this.selectedModel !== null &&
          request.model === this.selectedModel.model &&
          request.provider === this.selectedModel.provider,
      )
      .slice(0, 10)
      .map((request) => request.measured!);
    const boundedMetrics =
      recentRequests.length <= MAX_LIVE_REQUESTS &&
      Number.isSafeInteger(measuredOutputTokens) &&
      Number.isSafeInteger(measuredDurationMs);
    return {
      scope: "turn",
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalCostUsd,
      nativeMetrics: boundedMetrics
        ? {
            generation: this.generation,
            phase: live ? this.phase : "idle",
            inFlightStartMs: live ? this.inFlightStartMs : null,
            lastActivityMs: this.lastActivityMs,
            latestEndMs: this.latestEndMs,
            measuredOutputTokens,
            measuredDurationMs,
            recentRequests,
            agentReferences,
            modelReferences,
          }
        : undefined,
    };
  }

  private rememberReference(request: NativeRequest, nowMs: number): void {
    if (!this.retainReferences) return;
    if (request.measured && request.measured.endMs >= nowMs - REFERENCE_RETENTION_MS) {
      this.references.set(request.key, request);
    } else {
      this.references.delete(request.key);
    }
    this.pruneReferences(nowMs);
  }

  private pruneReferences(nowMs: number): void {
    for (const [key, request] of this.references) {
      if (request.measured!.endMs < nowMs - REFERENCE_RETENTION_MS) this.references.delete(key);
    }
  }
}
