import { createHash } from "node:crypto";
import path from "node:path";
import type { OmpMonitorExecutionModeFact, OmpMonitorPhase, OmpMonitorUsage } from "./types.js";

export const TOKEN_LIMIT = 1_000_000_000_000;
export const MAX_DURATION_MS = 15 * 60_000;
export const MAX_TOOL_CALLS = 512;
const MAX_MODE_BRANCHES = 65_536;
const MAX_STAMP = Number.MAX_SAFE_INTEGER;
const COMPLETION_STOP_KEYS: Record<string, true> = {
  stop: true,
  toolUse: true,
  length: true,
  error: true,
  aborted: true,
  pause_turn: true,
};
type JsonObject = Record<string, unknown>;
type SelectedTiers = ReadonlyMap<string, OmpMonitorExecutionModeFact>;
interface SelectedModes {
  tiers: SelectedTiers;
  effort: OmpMonitorExecutionModeFact | null;
}
interface ModeSelection<T> {
  parentId: string | null;
  /** Missing ancestors remain unresolved while the disjoint history cursor catches up. */
  resolved: T | undefined;
}
type ModeSelections = { [K in keyof SelectedModes]: ModeSelection<SelectedModes[K]> };
interface ModeBranch extends ModeSelections {
  at: number;
  position: number;
}
const OMP_MODE_FAMILIES = ["openai", "anthropic", "google"] as const;
const EMPTY_TIERS: SelectedTiers = new Map();
const EMPTY_TIER_SELECTION: ModeSelection<SelectedTiers> = {
  parentId: null,
  resolved: EMPTY_TIERS,
};
const EMPTY_EFFORT_SELECTION: ModeSelection<SelectedModes["effort"]> = {
  parentId: null,
  resolved: null,
};

export interface NumericResponse extends OmpMonitorUsage {
  key: string;
  agentId: string;
  model: string | null;
  provider: string | null;
  serviceTier: string | null;
  speedMode: OmpMonitorExecutionModeFact | null;
  effortMode: OmpMonitorExecutionModeFact | null;
  endMs: number;
  startMs: number | null;
  ttftMs: number | null;
  sideCall: boolean;
  /** Hash of safe stop/pause keys and hashed tool IDs, never message text. */
  completionState: string;
  /** Fast-tail baseline/history facts are measured, but cannot announce a live completion. */
  feedbackEligible?: boolean;
}

export interface NumericSink {
  otherOwner(key: string): boolean;
  /** False for a replay/older revision; numeric billing corrections may still be retained. */
  upsert(response: NumericResponse): boolean;
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

function readStopReason(message: JsonObject): string {
  return typeof message.stopReason === "string" ? message.stopReason : "aborted";
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
  return modeIdentifier(message.serviceTier, 64);
}

function modeIdentifier(value: unknown, limit: number): string | null {
  return typeof value === "string" &&
    value.length <= limit &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    ? value
    : null;
}

function providerFamily(value: unknown): string | null {
  switch (value) {
    case "anthropic":
      return "anthropic";
    case "openai":
    case "openai-codex":
    case "azure":
    case "azure-openai-responses":
      return "openai";
    case "google":
    case "google-gemini-cli":
    case "google-antigravity":
    case "google-vertex":
      return "google";
    default:
      return null;
  }
}

/** Agent Speed EXECUTION-MODES / OmpTier (MIT); unknown providers never gain OpenAI aliases. */
function tierFact(
  raw: unknown,
  provider: string | null,
  evidence: OmpMonitorExecutionModeFact["evidence"],
): OmpMonitorExecutionModeFact | null {
  const tier = modeIdentifier(raw, 64);
  if (!tier || !provider) return null;
  let value = tier.toLowerCase();
  if (provider === "openai" && value === "default") value = "standard";
  else if (value === "priority") value = "fast";
  return { value, evidence, provider };
}

function resolvedTier(
  fact: OmpMonitorExecutionModeFact | null | undefined,
): OmpMonitorExecutionModeFact | null {
  if (!fact) return null;
  switch (fact.value) {
    case "auto":
    case "inherit":
    case "inherited":
    case "unknown":
    case "none":
      return null;
    default:
      return fact;
  }
}

function selectedTiers(raw: unknown): SelectedTiers {
  const values = object(raw);
  const facts = new Map<string, OmpMonitorExecutionModeFact>();
  // Only these provider-family map keys have verified native OMP semantics.
  for (const family of OMP_MODE_FAMILIES) {
    const fact = tierFact(values?.[family], family, "selected");
    if (fact) facts.set(family, fact);
  }
  return facts;
}

function recordedTier(message: JsonObject): OmpMonitorExecutionModeFact | null {
  if (Array.isArray(message.disabledFeatures) && message.disabledFeatures.includes("priority"))
    return null;
  return tierFact(message.serviceTier, providerFamily(message.provider), "recorded");
}

/** Native effort is independent of tier; `auto` and an undefined level are never reasoning off. */
function effortFact(
  raw: unknown,
  evidence: OmpMonitorExecutionModeFact["evidence"],
): OmpMonitorExecutionModeFact | null {
  const identifier = modeIdentifier(raw, 64);
  if (!identifier) return null;
  let value = identifier.toLowerCase();
  switch (value) {
    case "auto":
    case "default":
    case "inherit":
    case "inherited":
    case "unknown":
    case "thinking_level_unspecified":
      return null;
    case "none":
    case "disabled":
      value = "off";
      break;
    case "enabled":
      value = "on";
      break;
  }
  return { value, evidence, provider: null };
}

function recordedEffort(message: JsonObject): OmpMonitorExecutionModeFact | null {
  const effort = object(object(message.requestControls)?.effort);
  // A native string tail wins even if unresolved/unsafe; only a non-string falls back to topLevel.
  const raw = typeof effort?.tail === "string" ? effort.tail : effort?.topLevel;
  return effortFact(raw, "recorded");
}

function nativeReasoning(usage: JsonObject, output: number): number | null {
  const value = usage.reasoningTokens;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(output, token(value))
    : null;
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
    reasoningTokens: 0,
    reasoningKnownRequests: 0,
    reasoningKnownOutputTokens: 0,
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
    peakTotalTps: 0,
  };
}

/** OMP-only numeric state machine, inspired by Agent Speed METRICS §4.7 (MIT). */
export class OmpNumericParser {
  headerSeen = false;
  headerMs: number | null = null;
  project = "";
  projectId = "";
  model: string | null = null;
  provider: string | null = null;
  ttftMs: number | null = null;
  phase: OmpMonitorPhase = "idle";
  inFlightStartMs: number | null = null;
  lastActivityAt = 0;
  private stateAt = -Infinity;
  private statePosition = -Infinity;
  private mergeToolResults = false;
  private lostToolResultPosition = -Infinity;
  private readonly completedToolCalls = new Map<string, { position: number; at: number }>();
  private lastToolResultPosition = -Infinity;
  private lastToolResultAt: number | null = null;
  private responseChanged = true;
  private readonly responseToolCalls: string[] = [];
  private responseToolOverflow = false;
  private readonly pendingToolCalls = new Set<string>();
  private toolOverflow = false;
  private readonly modeBranches = new Map<string, ModeBranch>();
  private currentModeBranch: ModeBranch | null = null;
  private currentRecordedTier: OmpMonitorExecutionModeFact | null = null;
  private currentRecordedEffort: OmpMonitorExecutionModeFact | null = null;
  private modeAt = -Infinity;
  private modePosition = -Infinity;

  constructor(private readonly agentId: string) {}

  get retainedToolCount(): number {
    return this.pendingToolCalls.size + this.completedToolCalls.size;
  }

  get speedMode(): OmpMonitorExecutionModeFact | null {
    return resolvedTier(
      this.currentRecordedTier ??
        (this.provider && this.currentModeBranch
          ? this.resolveMode(this.currentModeBranch, "tiers")?.get(this.provider)
          : null),
    );
  }

  get effortMode(): OmpMonitorExecutionModeFact | null {
    return (
      this.currentRecordedEffort ??
      (this.currentModeBranch ? this.resolveMode(this.currentModeBranch, "effort") : null) ??
      null
    );
  }

  startTailMerge(): void {
    this.mergeToolResults = true;
  }

  finishTailMerge(): boolean {
    if (!this.mergeToolResults) return false;
    this.mergeToolResults = false;
    this.completedToolCalls.clear();
    return true;
  }

  apply(value: unknown, sink: NumericSink, historyOnly = false, position = 0): void {
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
    const assistant = entry.type === "message" && object(entry.message)?.role === "assistant";
    if (!historyOnly && !assistant) this.lastActivityAt = Math.max(this.lastActivityAt, ts);
    if (entry.id.length > 4_096) {
      sink.limit();
      return;
    }
    this.applyRecord(entry, ts, sink, historyOnly, position);
  }

  private applyRecord(
    entry: JsonObject,
    ts: number,
    sink: NumericSink,
    historyOnly: boolean,
    position: number,
  ): void {
    const branch = this.rememberModeBranch(entry, ts, position, sink);
    this.selectModeBranch(branch, ts, position);
    if (this.applySessionExit(entry, ts, position)) return;
    if (entry.type === "model_usage") {
      this.assistant(entry, entry, ts, true, sink, branch);
      return;
    }
    if (entry.type === "message") this.applyMessage(entry, ts, sink, branch, historyOnly, position);
  }

  private applySessionExit(entry: JsonObject, ts: number, position: number): boolean {
    if (
      !this.acceptsState(ts, position) ||
      entry.type !== "custom" ||
      entry.customType !== "session_exit"
    )
      return false;
    this.beginState(ts, position);
    this.setPhase("idle", ts, null);
    this.clearTools();
    return true;
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

  private rememberModeBranch(
    entry: JsonObject,
    at: number,
    position: number,
    sink: NumericSink,
  ): ModeBranch {
    const id = hashId(entry.id as string);
    const previous = this.modeBranches.get(id);
    if (previous && (position > 0 ? position < previous.position : at < previous.at))
      return previous;
    const parentId =
      typeof entry.parentId === "string" && entry.parentId.length <= 4_096
        ? hashId(entry.parentId)
        : null;
    const inherited = parentId ? this.modeBranches.get(parentId) : undefined;
    // Reuse unchanged selections in O(1), even while their shared ancestor is outside the tail.
    let tiers =
      inherited?.tiers ??
      (parentId === null ? EMPTY_TIER_SELECTION : { parentId, resolved: undefined });
    let effort =
      inherited?.effort ??
      (parentId === null ? EMPTY_EFFORT_SELECTION : { parentId, resolved: undefined });
    if (entry.type === "service_tier_change" && Object.hasOwn(entry, "serviceTier"))
      tiers = { parentId: null, resolved: selectedTiers(entry.serviceTier) };
    if (entry.type === "thinking_level_change" && Object.hasOwn(entry, "thinkingLevel")) {
      effort = { parentId: null, resolved: effortFact(entry.thinkingLevel, "selected") };
    }
    const branch: ModeBranch = { at, position, tiers, effort };
    if (!this.modeBranches.has(id) && this.modeBranches.size >= MAX_MODE_BRANCHES) {
      this.modeBranches.clear();
      sink.limit();
    }
    this.modeBranches.set(id, branch);
    return branch;
  }

  private resolveMode<K extends keyof SelectedModes>(
    branch: ModeSelections,
    kind: K,
  ): SelectedModes[K] | undefined {
    const selection: ModeSelection<SelectedModes[K]> = branch[kind];
    if (selection.resolved !== undefined) return selection.resolved;
    if (!selection.parentId || !this.modeBranches.has(selection.parentId)) return undefined;
    let current: ModeSelection<SelectedModes[K]> | undefined = selection;
    const pending: Array<ModeSelection<SelectedModes[K]>> = [];
    const visited = new Set<ModeSelection<SelectedModes[K]>>();
    while (current && !visited.has(current)) {
      if (current.resolved !== undefined) {
        for (const node of pending) node.resolved = current.resolved;
        return current.resolved;
      }
      visited.add(current);
      pending.push(current);
      const parent: string | null = current.parentId;
      const inherited: ModeSelections | undefined = parent
        ? this.modeBranches.get(parent)
        : undefined;
      if (parent && !inherited) {
        for (const node of pending) node.parentId = parent;
        return undefined;
      }
      current = inherited?.[kind];
    }
    return undefined;
  }

  private selectModeBranch(
    branch: ModeBranch,
    at: number,
    position: number,
    tier: OmpMonitorExecutionModeFact | null = null,
    effort: OmpMonitorExecutionModeFact | null = null,
  ): void {
    if (position > 0 ? position < this.modePosition : at < this.modeAt) return;
    if (position > 0) this.modePosition = position;
    this.modeAt = at;
    this.currentModeBranch = branch;
    this.currentRecordedTier = tier;
    this.currentRecordedEffort = effort;
  }

  private responseSpeedMode(
    branch: ModeBranch,
    message: JsonObject,
    sideCall: boolean,
  ): OmpMonitorExecutionModeFact | null {
    const family = providerFamily(message.provider);
    return resolvedTier(
      (sideCall ? null : recordedTier(message)) ??
        (family ? this.resolveMode(branch, "tiers")?.get(family) : null),
    );
  }

  private responseEffortMode(
    branch: ModeBranch,
    message: JsonObject,
    sideCall: boolean,
  ): OmpMonitorExecutionModeFact | null {
    if (sideCall) return null;
    return recordedEffort(message) ?? this.resolveMode(branch, "effort") ?? null;
  }

  private applyMessage(
    entry: JsonObject,
    ts: number,
    sink: NumericSink,
    branch: ModeBranch,
    historyOnly: boolean,
    position: number,
  ): void {
    const message = object(entry.message);
    if (!message) return;
    switch (message.role) {
      case "user":
      case "developer":
        if (this.acceptsState(ts, position)) {
          this.beginState(ts, position);
          this.setPhase("generating", ts, ts);
        }
        break;
      case "assistant":
        this.assistant(entry, message, ts, false, sink, branch, historyOnly, position);
        break;
      case "toolResult":
        this.applyToolResult(message, ts, position, sink);
        break;
    }
  }

  private applyToolResult(
    message: JsonObject,
    ts: number,
    position: number,
    sink: NumericSink,
  ): void {
    if (!this.acceptsState(ts, position)) return;
    if (message.toolName === "yield" && message.isError !== true) {
      this.beginState(ts, position);
      this.setPhase("idle", ts, null);
      return;
    }
    if (typeof message.toolCallId !== "string" || message.toolCallId.length > 4_096) return;
    const id = hashId(message.toolCallId);
    const completed = this.completedToolCalls.get(id);
    if (completed && completed.position >= position) return;
    const matched = this.pendingToolCalls.delete(id);
    if (this.mergeToolResults) {
      if (
        !completed &&
        (this.completedToolCalls.size >= MAX_TOOL_CALLS ||
          !sink.acceptTools(this.retainedToolCount + 1))
      ) {
        this.lostToolResultPosition = Math.max(this.lostToolResultPosition, position);
        this.toolOverflow = true;
        sink.limit();
      } else {
        this.completedToolCalls.set(id, { position, at: ts });
      }
    }
    if (matched) {
      if (position >= this.lastToolResultPosition) {
        this.lastToolResultPosition = position;
        this.lastToolResultAt = ts;
      }
      if (this.phase === "tools" && !this.toolOverflow && this.pendingToolCalls.size === 0) {
        const at = this.lastToolResultAt ?? ts;
        this.setPhase("generating", at, at);
      }
    }
  }

  discardStaleTools(now: number): void {
    if (now - this.lastActivityAt <= 300_000 || this.retainedToolCount === 0) return;
    this.pendingToolCalls.clear();
    for (const completed of this.completedToolCalls.values())
      this.lostToolResultPosition = Math.max(this.lostToolResultPosition, completed.position);
    this.completedToolCalls.clear();
    // A delayed result cannot prove that every forgotten call completed.
    this.toolOverflow = true;
  }

  private assistant(
    entry: JsonObject,
    message: JsonObject,
    ts: number,
    sideCall: boolean,
    sink: NumericSink,
    branch: ModeBranch,
    historyOnly = false,
    position = 0,
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
      this.emit(message, usage, key, start, ts, sideCall, sink, branch);
      return;
    }
    const end = this.emit(message, usage, key, start, ts, sideCall, sink, branch);
    if (sideCall || !this.acceptsState(ts, position)) return;
    const hasUsage =
      token(usage.input) + token(usage.output) + token(usage.cacheRead) + token(usage.cacheWrite) >
      0;
    if (hasUsage) {
      this.selectModeBranch(branch, ts, position, recordedTier(message), recordedEffort(message));
      this.model = modelLabel(message.model as string);
      this.provider = providerFamily(message.provider);
      this.ttftMs = readTtft(message);
    }
    // Metadata-only replacements update current facts without replaying a completion's live phase.
    if (!this.responseChanged) return;
    if (!historyOnly) this.lastActivityAt = Math.max(this.lastActivityAt, ts);
    this.beginState(ts, position);
    this.applyAssistantPhase(message, ts, end, sink, position);
  }

  private applyAssistantPhase(
    message: JsonObject,
    ts: number,
    end: number,
    sink: NumericSink,
    position: number,
  ): void {
    const reason = readStopReason(message);
    if (reason === "error" || reason === "aborted") {
      this.clearTools();
      this.setPhase("idle", ts, null);
      return;
    }
    this.clearTools();
    const calls = this.responseToolCalls;
    this.toolOverflow ||= this.responseToolOverflow;
    if (
      (calls.length || this.toolOverflow) &&
      (reason === "toolUse" || reason === "stop" || reason === "length")
    ) {
      this.acceptToolCalls(calls, ts, position, sink);
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

  private readToolCalls(message: JsonObject, sink: NumericSink): void {
    const calls = this.responseToolCalls;
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      const call = object(block);
      if (call?.type !== "toolCall" || typeof call.id !== "string") continue;
      if (call.id.length > 4_096 || calls.length >= MAX_TOOL_CALLS) {
        this.responseToolOverflow = true;
        sink.limit();
        break;
      }
      calls.push(hashId(call.id));
    }
    if (calls.length > 1) calls.sort();
  }

  private acceptToolCalls(calls: string[], ts: number, position: number, sink: NumericSink): void {
    let pending = 0;
    for (const id of calls) {
      const completed = this.completedToolCalls.get(id);
      if (!completed || completed.position <= position) pending++;
    }
    if (!sink.acceptTools(pending + this.completedToolCalls.size)) {
      calls.length = 0;
      this.toolOverflow = true;
      sink.limit();
    }
    this.pendingToolCalls.clear();
    for (const id of calls) {
      const completed = this.completedToolCalls.get(id);
      if (completed && completed.position > position) {
        if (completed.position > this.lastToolResultPosition) {
          this.lastToolResultPosition = completed.position;
          this.lastToolResultAt = completed.at;
        }
      } else {
        this.pendingToolCalls.add(id);
      }
    }
    if (!this.toolOverflow && this.pendingToolCalls.size === 0) {
      const at = this.lastToolResultAt ?? ts;
      this.setPhase("generating", at, at);
    } else {
      this.setPhase("tools", ts, null);
    }
  }

  private emit(
    message: JsonObject,
    usage: JsonObject,
    key: string,
    start: number | null,
    ts: number,
    sideCall: boolean,
    sink: NumericSink,
    branch: ModeBranch,
  ): number {
    this.responseChanged = true;
    this.responseToolCalls.length = 0;
    this.responseToolOverflow = false;
    const reason = readStopReason(message);
    const failed = !sideCall && (reason === "error" || reason === "aborted");
    if (!sideCall && !failed) this.readToolCalls(message, sink);
    const duration = sideCall ? null : milliseconds(message.duration, false);
    const completedAt = milliseconds(message.completedAt, true);
    const end =
      start !== null && duration !== null
        ? Math.min(MAX_STAMP, start + duration)
        : (completedAt ?? ts);
    const inputTokens = token(usage.input);
    const outputTokens = token(usage.output);
    const reasoningTokens = nativeReasoning(usage, outputTokens);
    const cacheReadTokens = token(usage.cacheRead);
    const cacheWriteTokens = token(usage.cacheWrite);
    const countedTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    if (countedTokens === 0) return end;
    // Missing/invalid native duration is unknown, not a guessed user-to-response interval.
    const normalizedDuration = measuredDuration(start, duration, sideCall, failed);
    const measured = normalizedDuration > 0;
    const cost = recordedCost(usage);
    this.responseChanged = sink.upsert({
      key,
      agentId: this.agentId,
      model: modelLabel(message.model as string),
      endMs: end,
      provider: modelLabel(message.provider as string),
      serviceTier: serviceTier(message),
      speedMode: this.responseSpeedMode(branch, message, sideCall),
      effortMode: this.responseEffortMode(branch, message, sideCall),
      startMs: measured ? end - normalizedDuration : null,
      ttftMs: sideCall ? null : readTtft(message),
      sideCall,
      completionState: this.completionState(message, reason, sideCall),
      requests: 1,
      failedRequests: failed ? 1 : 0,
      inputTokens,
      outputTokens,
      reasoningTokens: reasoningTokens ?? 0,
      reasoningKnownRequests: reasoningTokens === null ? 0 : 1,
      reasoningKnownOutputTokens: reasoningTokens === null ? 0 : outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: totalTokens(usage, countedTokens),
      costUsd: cost ?? 0,
      unpricedRequests: cost === null ? 1 : 0,
      estimatedCostUsd: 0,
      unestimatedRequests: 1,
      measuredOutputTokens: measured ? outputTokens : 0,
      measuredDurationMs: normalizedDuration,
      peakOutputTps: 0,
      peakTotalTps: 0,
    });
    return end;
  }

  private completionState(message: JsonObject, reason: string, sideCall: boolean): string {
    if (sideCall) return "side";
    return hashId(
      `${COMPLETION_STOP_KEYS[reason] === true ? reason : "other"}:` +
        `${object(message.stopDetails)?.type === "pause_turn" ? 1 : 0}:` +
        `${this.responseToolOverflow ? 1 : 0}:${this.responseToolCalls.join(":")}`,
    );
  }

  private acceptsState(at: number, position: number): boolean {
    return position > 0 ? position >= this.statePosition : at >= this.stateAt;
  }

  private beginState(at: number, position: number): void {
    if (position > 0) this.statePosition = position;
    this.stateAt = at;
    this.lastToolResultPosition = -Infinity;
    this.lastToolResultAt = null;
    for (const [id, completed] of this.completedToolCalls)
      if (completed.position <= position) this.completedToolCalls.delete(id);
    this.clearTools();
  }

  private clearTools(): void {
    this.pendingToolCalls.clear();
    this.toolOverflow = this.mergeToolResults && this.lostToolResultPosition > this.statePosition;
  }

  private setPhase(phase: OmpMonitorPhase, at: number, start: number | null): void {
    this.stateAt = at;
    this.phase = phase;
    this.inFlightStartMs = phase === "generating" ? start : null;
  }
}
