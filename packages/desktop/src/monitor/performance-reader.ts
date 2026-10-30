// Agent Speed v1.6.0 (MIT), METRICS 4.7, 6.10 and 6.11. OMP only; never inspect tool input/output.
import { hashId, object, timestamp, token, MAX_DURATION_MS } from "./parser.js";
import type { MonitorPerformanceAction, MonitorPerformanceResponse } from "./performance-types.js";

// A final revision can widen an already-measured interval by up to 15 min; keep its first completion position
// for one additional interval before the retained dates. Only the 30 requested calendar dates become records.
const RETENTION_HEADROOM_MS = MAX_DURATION_MS * 2;

export const PERFORMANCE_READER_LIMITS = {
  maxLineBytes: 1_048_576,
  maxEvents: 65_536,
  maxEventBytes: 8_388_608,
  maxRequestKeys: 32_768,
  maxCallKeys: 32_768,
  liveActions: 64,
};
interface AssistantEvent {
  kind: "assistant";
  key: string;
  atMs: number;
  model: string | null;
  hasUsage: boolean;
  measured: boolean;
  calls: string[];
}
interface ResultEvent {
  kind: "result";
  id: string;
  atMs: number;
  failed: boolean;
}
type PerformanceEvent = AssistantEvent | ResultEvent;
type Completion = { key: string } | { action: MonitorPerformanceAction };
export interface OmpPerformanceFacts {
  responses: MonitorPerformanceResponse[];
  actions: MonitorPerformanceAction[];
  completions: Completion[];
}

/** Raw model identity, not a display-name alias; paths, arbitrary prose and controls are rejected. */
export function performanceModel(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/@+ -]*$/.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.includes("..") ||
    value.includes("://")
  )
    return null;
  return value;
}
function milliseconds(value: unknown, positive = false): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (positive && value === 0)
  )
    return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}
function opaque(value: unknown): string | null {
  return typeof value === "string" && value.length <= 4096 ? hashId(value) : null;
}
function measured(response: MonitorPerformanceResponse): boolean {
  return (
    response.final !== false &&
    response.startMs !== null &&
    response.endMs >= response.startMs &&
    response.endMs - response.startMs <= MAX_DURATION_MS
  );
}
function sameResponse(
  a: MonitorPerformanceResponse | undefined,
  b: MonitorPerformanceResponse,
): boolean {
  return (
    a !== undefined &&
    a.model === b.model &&
    a.startMs === b.startMs &&
    a.endMs === b.endMs &&
    a.input === b.input &&
    a.cachedInput === b.cachedInput &&
    a.output === b.output &&
    a.reasoning === b.reasoning &&
    a.final === b.final
  );
}
function responseFact(
  key: string,
  message: Record<string, unknown>,
  usage: Record<string, unknown>,
  atMs: number,
): MonitorPerformanceResponse | null {
  const input = token(usage.input),
    output = token(usage.output),
    cached = token(usage.cacheRead),
    written = token(usage.cacheWrite);
  if (input + output + cached + written === 0) return null;
  const started = milliseconds(message.timestamp, true),
    duration = milliseconds(message.duration),
    completed = milliseconds(message.completedAt, true),
    stop = typeof message.stopReason === "string" ? message.stopReason : "aborted",
    failed = stop === "error" || stop === "aborted";
  return {
    key,
    model: performanceModel(message.model),
    startMs: failed ? null : started,
    endMs:
      started !== null && duration !== null
        ? Math.min(Number.MAX_SAFE_INTEGER, started + duration)
        : (completed ?? atMs),
    // The original OMP parser records no firstMs. Native ttft remains in the numeric monitor, not L.
    firstMs: null,
    final: true,
    input: input + cached + written,
    cachedInput: cached,
    output,
    reasoning: Math.min(output, token(usage.reasoningTokens)),
  };
}
function toolCalls(message: Record<string, unknown>): string[] {
  if (!Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const value of message.content) {
    const block = object(value);
    if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
    const id = opaque(block.id);
    if (id !== null) ids.push(id);
  }
  return ids;
}

/** Compact numeric completion log. JSON and all conversation/tool text die with read(). */
export class OmpPerformanceLineReader {
  readonly responses = new Map<string, MonitorPerformanceResponse>();
  readonly requests = new Set<string>();
  revision = 0;
  limited = false;
  saturated = false;
  headerSeen = false;
  lastLineMs = 0;
  private headerMs: number | null = null;
  private readonly events: PerformanceEvent[] = [];
  private readonly firstMeasured = new Set<string>();
  private readonly callKeys = new Set<string>();
  private initialModel: string | null = null;
  private eventBytes = 0;
  constructor(private floorMs = -Infinity) {}
  get retainedBytes(): number {
    return (
      this.eventBytes +
      this.responses.size * 256 +
      this.requests.size * 96 +
      this.callKeys.size * 40
    );
  }
  advanceFloor(floorMs: number): void {
    this.floorMs = floorMs;
    const threshold = floorMs - RETENTION_HEADROOM_MS;
    let cut = 0;
    for (const event of this.events) {
      if (event.kind === "assistant") {
        if (
          event.atMs >= threshold ||
          (this.responses.get(event.key)?.endMs ?? -Infinity) >= threshold
        )
          break;
        if (event.hasUsage) this.initialModel = event.model;
      } else if (event.atMs >= threshold) break;
      cut++;
    }
    if (cut) this.events.splice(0, cut);
    const retainedKeys = new Set<string>();
    this.callKeys.clear();
    for (const event of this.events) {
      if (event.kind !== "assistant") continue;
      retainedKeys.add(event.key);
      for (const id of event.calls) this.callKeys.add(id);
    }
    for (const [key, response] of this.responses)
      if (response.endMs < threshold) this.responses.delete(key);
    for (const key of this.requests) {
      if (this.responses.has(key) || retainedKeys.has(key)) continue;
      this.requests.delete(key);
      this.firstMeasured.delete(key);
    }
    this.eventBytes = this.events.reduce(
      (sum, event) => sum + (event.kind === "assistant" ? 160 + event.calls.length * 80 : 96),
      0,
    );
    this.revision++;
  }
  read(raw: string): void {
    if (this.saturated) return;
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    let entry: Record<string, unknown> | null;
    try {
      entry = object(JSON.parse(raw));
    } catch {
      if (raw.trim()) this.markGap();
      return;
    }
    if (!entry || entry.type === "title") return;
    const atMs = timestamp(entry.timestamp);
    if (entry.type === "session") {
      if (!this.headerSeen) {
        this.headerSeen = true;
        this.headerMs = atMs;
        if (atMs !== null) this.lastLineMs = atMs;
        this.revision++;
      }
      return;
    }
    if (
      !this.headerSeen ||
      typeof entry.id !== "string" ||
      atMs === null ||
      (this.headerMs !== null && atMs < this.headerMs - 2000)
    )
      return;
    this.lastLineMs = Math.max(this.lastLineMs, atMs);
    if (entry.id.length > 4096) {
      this.markGap();
      return;
    }
    this.dispatchEntry(entry.id, entry, atMs);
  }
  private dispatchEntry(entryId: string, entry: Record<string, unknown>, atMs: number): void {
    if (entry.type === "model_usage") {
      this.sideCall(entry, atMs);
      return;
    }
    const message = object(entry.message);
    if (entry.type !== "message" || !message) return;
    if (message.role === "assistant") this.assistant(entryId, message, atMs);
    else if (
      message.role === "toolResult" &&
      (this.events.length > 0 || atMs >= this.floorMs - RETENTION_HEADROOM_MS)
    ) {
      const id = opaque(message.toolCallId);
      if (id !== null) this.push({ kind: "result", id, atMs, failed: message.isError === true });
    }
  }
  private assistant(id: string, message: Record<string, unknown>, atMs: number): void {
    const usage = object(message.usage);
    if (
      typeof message.model !== "string" ||
      typeof message.provider !== "string" ||
      typeof message.api !== "string" ||
      !usage
    )
      return;
    const started = milliseconds(message.timestamp, true),
      key = hashId(`omp:${id}:${started ?? atMs}`),
      response = responseFact(key, message, usage, atMs);
    if (
      this.events.length === 0 &&
      atMs < this.floorMs - RETENTION_HEADROOM_MS &&
      (response?.endMs ?? -Infinity) < this.floorMs - RETENTION_HEADROOM_MS
    ) {
      if (response) this.initialModel = performanceModel(message.model);
      return;
    }
    if (!this.requests.has(key) && this.requests.size >= PERFORMANCE_READER_LIMITS.maxRequestKeys) {
      this.saturated = this.limited = true;
      return;
    }
    const calls = toolCalls(message);
    if (!this.acceptCalls(calls)) return;
    let first = false;
    if (response) {
      this.requests.add(key);
      if (measured(response) && !this.firstMeasured.has(key)) {
        first = true;
        this.firstMeasured.add(key);
      }
      if (response.endMs < this.floorMs - RETENTION_HEADROOM_MS) {
        this.responses.delete(key);
        this.revision++;
      } else if (!sameResponse(this.responses.get(key), response)) {
        this.responses.set(key, response);
        this.revision++;
      }
    }
    this.push({
      kind: "assistant",
      key,
      atMs,
      model: performanceModel(message.model),
      hasUsage: response !== null,
      measured: first,
      calls,
    });
  }
  private acceptCalls(calls: string[]): boolean {
    for (const id of calls) {
      if (this.callKeys.has(id)) continue;
      if (this.callKeys.size >= PERFORMANCE_READER_LIMITS.maxCallKeys) {
        this.saturated = this.limited = true;
        return false;
      }
      this.callKeys.add(id);
    }
    return true;
  }
  private sideCall(entry: Record<string, unknown>, atMs: number): void {
    const usage = object(entry.usage);
    if (
      typeof entry.model !== "string" ||
      typeof entry.provider !== "string" ||
      typeof entry.api !== "string" ||
      !usage ||
      atMs < this.floorMs - RETENTION_HEADROOM_MS
    )
      return;
    const key = hashId(`omp:${entry.id as string}:${atMs}`),
      response = responseFact(key, entry, usage, atMs);
    if (!response) return;
    if (!this.requests.has(key) && this.requests.size >= PERFORMANCE_READER_LIMITS.maxRequestKeys) {
      this.saturated = this.limited = true;
      return;
    }
    this.requests.add(key);
    // Totals-only side calls add no sample or agent-model change. Still honor a native same-key correction.
    if (!this.responses.has(key)) return;
    response.startMs = null;
    response.endMs = atMs;
    if (!sameResponse(this.responses.get(key), response)) {
      this.responses.set(key, response);
      this.revision++;
    }
  }
  private push(event: PerformanceEvent): void {
    const bytes = event.kind === "assistant" ? 160 + event.calls.length * 80 : 96;
    if (
      this.events.length >= PERFORMANCE_READER_LIMITS.maxEvents ||
      this.eventBytes + bytes > PERFORMANCE_READER_LIMITS.maxEventBytes
    ) {
      this.saturated = this.limited = true;
      return;
    }
    this.events.push(event);
    this.eventBytes += bytes;
    this.revision++;
  }
  markGap(): void {
    this.limited = true;
    // Native malformed-line handling changes no response, call identity, outcome or agent model.
    this.revision++;
  }
  facts(owns: (key: string) => boolean): OmpPerformanceFacts {
    const responses: MonitorPerformanceResponse[] = [];
    for (const [key, response] of this.responses) if (owns(key)) responses.push(response);
    const calls = new Map<string, MonitorPerformanceAction>(),
      live = new Map<string, MonitorPerformanceAction>(),
      completions: Completion[] = [];
    let model: string | null = this.initialModel;
    for (const event of this.events) {
      if (event.kind === "assistant") {
        if (!owns(event.key)) continue;
        if (event.hasUsage) model = event.model;
        if (event.measured) completions.push({ key: event.key });
        this.applyCalls(event, model, calls);
        this.applyCalls(event, model, live, PERFORMANCE_READER_LIMITS.liveActions);
      } else {
        const action = calls.get(event.id),
          current = live.get(event.id);
        if (action && action.resultMs === null) {
          action.resultMs = event.atMs;
          action.failed = event.failed;
          completions.push({ action });
        }
        if (current && current.resultMs === null) {
          current.resultMs = event.atMs;
          current.failed = event.failed;
        }
      }
    }
    return { responses, actions: [...live.values()], completions };
  }
  private applyCalls(
    event: AssistantEvent,
    model: string | null,
    calls: Map<string, MonitorPerformanceAction>,
    capacity?: number,
  ): void {
    for (const id of event.calls) {
      if (calls.has(id)) continue;
      const action: MonitorPerformanceAction = {
        callMs: event.atMs,
        resultMs: null,
        failed: null,
        model,
      };
      calls.set(id, action);
      if (capacity !== undefined && calls.size > capacity) calls.delete(calls.keys().next().value!);
    }
  }
  clear(): void {
    this.responses.clear();
    this.requests.clear();
    this.firstMeasured.clear();
    this.callKeys.clear();
    this.events.length = this.eventBytes = 0;
    this.initialModel = null;
    this.headerSeen = false;
    this.headerMs = null;
    this.lastLineMs = 0;
    this.limited = this.saturated = false;
    this.revision++;
  }
}
