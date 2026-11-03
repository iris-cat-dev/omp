import type { ToolCallDetail } from "../../agent-sdk-types.js";
import type { OmpSubagentLifecyclePayload, OmpSubagentProgressPayload } from "./rpc-types.js";

export interface OmpSubagentCardTimer {
  readonly token: unknown;
}

export interface OmpSubagentCardScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): OmpSubagentCardTimer;
  clearTimeout(timer: OmpSubagentCardTimer): void;
}

export interface OmpSubagentCardTrackerOptions {
  scheduler?: OmpSubagentCardScheduler;
  emitToolCall?: (toolCallId: string) => boolean;
}

interface OmpSubagentLogLine {
  key: string;
  text: string;
}

interface OmpSubagentCardItem {
  id: string;
  run: number;
  parentToolCallIds: Set<string>;
  currentToolKey?: string;
  pendingToolLines: Map<string, { text: string; startMs: number }>;
  outputSnapshot: string[];
  index: number;
  description?: string;
  agent?: string;
  status?: "pending" | "running" | "completed" | "failed" | "aborted";
  childSessionId?: string;
  lines: OmpSubagentLogLine[];
  lineKeys: Set<string>;
}

interface OmpSubagentCardState {
  items: Map<string, OmpSubagentCardItem>;
  emitToolCall: (toolCallId: string) => boolean;
  lastEmitMs: number | null;
  trailingTimer: OmpSubagentCardTimer | null;
  dirty: boolean;
}

const MAX_LOG_LINES_PER_ITEM = 200;
const MAX_LOG_LINE_CHARS = 240;
const THROTTLE_INTERVAL_MS = 500;

export function createOmpSubagentCardScheduler(): OmpSubagentCardScheduler {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => ({ token: setTimeout(callback, delayMs) }),
    clearTimeout: (timer) => {
      clearTimeout(timer.token as ReturnType<typeof setTimeout>);
    },
  };
}

export class OmpSubagentCardTracker {
  private readonly scheduler: OmpSubagentCardScheduler;
  private readonly emitToolCall: (toolCallId: string) => boolean;
  private readonly states = new Map<string, OmpSubagentCardState>();
  private readonly children = new Map<string, OmpSubagentCardItem>();

  constructor(options: OmpSubagentCardTrackerOptions) {
    this.scheduler = options.scheduler ?? createOmpSubagentCardScheduler();
    this.emitToolCall = options.emitToolCall ?? (() => false);
  }

  handleLifecycle(
    payload: OmpSubagentLifecyclePayload,
    emitToolCall: (toolCallId: string) => boolean = this.emitToolCall,
  ): void {
    const item = this.upsertItem({
      id: payload.id,
      index: payload.index,
      agent: payload.agent,
      description: payload.description,
      childSessionId: payload.sessionFile,
    });
    if (payload.status === "started") {
      item.run += 1;
      item.status = "running";
      item.currentToolKey = undefined;
      item.pendingToolLines.clear();
      item.outputSnapshot = [];
    } else if (!item.status || item.status === "running" || item.status === "pending") {
      item.status = payload.status;
    }
    this.bindParent(item, payload.parentToolCallId, emitToolCall);
    if (payload.status === "started" || payload.status === item.status) {
      this.appendLine(item, `${payload.status === "started" ? "lifecycle" : "status"}:${item.run}:${payload.status}`, `${payload.id} ${payload.status}`);
    }
    for (const parentId of item.parentToolCallIds) this.requestEmit(parentId);
  }

  handleProgress(
    payload: OmpSubagentProgressPayload,
    emitToolCall: (toolCallId: string) => boolean = this.emitToolCall,
  ): void {
    const item = this.upsertItem({
      id: payload.progress.id,
      index: payload.index,
      agent: payload.agent,
      description: payload.progress.description ?? payload.assignment,
      childSessionId: payload.sessionFile,
    });
    const terminal = item.status === "completed" || item.status === "failed" || item.status === "aborted";
    if (!terminal) item.status = payload.progress.status;
    this.bindParent(item, payload.parentToolCallId, emitToolCall);
    const currentToolLine = !terminal && payload.progress.status === "running" && payload.progress.currentTool
      ? summarizeTool({ tool: payload.progress.currentTool, args: payload.progress.currentToolArgs, startMs: payload.progress.currentToolStartMs })
      : null;
    const currentToolKey = currentToolLine ? `${payload.progress.currentTool}:${payload.progress.currentToolStartMs ?? ""}` : undefined;
    const currentToolChanged = currentToolLine !== null && currentToolKey !== item.currentToolKey;
    item.currentToolKey = currentToolKey;
    if (currentToolLine) {
      const key = `current:${item.run}:${currentToolKey}`;
      this.appendLine(item, key, currentToolLine.text);
      if (typeof payload.progress.currentToolStartMs === "number") {
        item.pendingToolLines.set(key, { text: currentToolLine.text, startMs: payload.progress.currentToolStartMs });
      }
    }

    for (const tool of payload.progress.recentTools ?? []) {
      const line = summarizeTool(tool);
      if (line) {
        const key = `tool:${item.run}:${line.key}`;
        if (item.lineKeys.has(key)) continue;
        let matched = false;
        for (const [pendingKey, pending] of item.pendingToolLines) {
          if (pending.text !== line.text || typeof tool.endMs !== "number" || tool.endMs < pending.startMs) continue;
          item.pendingToolLines.delete(pendingKey);
          const existing = item.lines.find((candidate) => candidate.key === pendingKey);
          if (!existing) continue;
          item.lineKeys.delete(pendingKey);
          existing.key = key;
          item.lineKeys.add(key);
          matched = true;
          break;
        }
        if (!matched) this.appendLine(item, key, line.text);
      }
    }

    const outputs = readOutputLines(payload.progress.recentOutput);
    const previousOutputs = item.outputSnapshot;
    if (
      outputs.length > 0 && outputs.length === previousOutputs.length &&
      outputs.slice(0, -1).every((output, index) => output === previousOutputs[index]) &&
      outputs.at(-1)!.startsWith(previousOutputs.at(-1)!)
    ) {
      const previousKey = `output:${item.run}:${previousOutputs.at(-1)!}`;
      const existing = item.lines.find((line) => line.key === previousKey);
      if (existing) {
        item.lineKeys.delete(previousKey);
        existing.key = `output:${item.run}:${outputs.at(-1)!}`;
        existing.text = normalizeLine(outputs.at(-1)!)!;
        item.lineKeys.add(existing.key);
      }
    }
    for (const output of outputs) this.appendLine(item, `output:${item.run}:${output}`, output);
    if (payload.progress.recentOutput !== undefined) item.outputSnapshot = outputs;

    if (!terminal && payload.progress.status !== "running") {
      this.appendLine(item, `status:${item.run}:${payload.progress.status}`, `${payload.progress.id} ${payload.progress.status}`);
    }
    for (const parentId of item.parentToolCallIds) {
      if (currentToolChanged) this.emitNow(parentId, this.stateFor(parentId));
      else this.requestEmit(parentId);
    }
  }

  markCanceled(childId: string): void {
    const item = this.children.get(childId);
    if (!item || (item.status !== "running" && item.status !== "pending")) return;
    item.status = "aborted";
    item.currentToolKey = undefined;
    this.appendLine(item, `status:${item.run}:aborted`, `${childId} aborted`);
    for (const parentId of item.parentToolCallIds) this.emitNow(parentId, this.stateFor(parentId));
  }

  detailFor(toolCallId: string, baseDetail: ToolCallDetail): ToolCallDetail {
    if (baseDetail.type !== "sub_agent") {
      return baseDetail;
    }
    const state = this.states.get(toolCallId);
    if (!state) {
      return baseDetail;
    }
    const items = [...state.items.values()].sort((left, right) => left.index - right.index);
    const firstItem = items[0];
    if (!firstItem) {
      return baseDetail;
    }

    const detail: ToolCallDetail = {
      type: "sub_agent",
      ...(baseDetail.subAgentType ? { subAgentType: baseDetail.subAgentType } : {}),
      ...((baseDetail.description ?? firstItem.description)
        ? { description: baseDetail.description ?? firstItem.description }
        : {}),
      ...((firstItem.childSessionId ?? baseDetail.childSessionId)
        ? { childSessionId: firstItem.childSessionId ?? baseDetail.childSessionId }
        : {}),
      log: buildLog(items, baseDetail.log),
    };
    return baseDetail.actions ? { ...detail, actions: baseDetail.actions } : detail;
  }

  flush(toolCallId: string): void {
    const state = this.states.get(toolCallId);
    if (!state || !state.dirty) {
      return;
    }
    this.emitNow(toolCallId, state);
  }

  delete(toolCallId: string): void {
    const state = this.states.get(toolCallId);
    if (state?.trailingTimer) {
      this.scheduler.clearTimeout(state.trailingTimer);
    }
    this.states.delete(toolCallId);
    for (const item of state?.items.values() ?? []) item.parentToolCallIds.delete(toolCallId);
  }

  clear(): void {
    for (const toolCallId of this.states.keys()) {
      this.delete(toolCallId);
    }
    this.children.clear();
  }

  private upsertItem(input: {
    id: string;
    index: number;
    agent?: string;
    description?: string;
    childSessionId?: string;
  }): OmpSubagentCardItem {
    const existing = this.children.get(input.id);
    if (existing) {
      existing.index = input.index;
      existing.agent = readTrimmedString(input.agent) ?? existing.agent;
      existing.description = readTrimmedString(input.description) ?? existing.description;
      existing.childSessionId = readTrimmedString(input.childSessionId) ?? existing.childSessionId;
      return existing;
    }
    const item: OmpSubagentCardItem = {
      id: input.id, run: 0, parentToolCallIds: new Set(), index: input.index,
      lines: [], lineKeys: new Set(), pendingToolLines: new Map(), outputSnapshot: [],
      agent: readTrimmedString(input.agent),
      description: readTrimmedString(input.description),
      childSessionId: readTrimmedString(input.childSessionId),
    };
    this.children.set(input.id, item);
    return item;
  }

  private bindParent(item: OmpSubagentCardItem, parentId: string | undefined, emitToolCall: (toolCallId: string) => boolean): void {
    const id = readTrimmedString(parentId);
    if (id) item.parentToolCallIds.add(id);
    for (const toolCallId of item.parentToolCallIds) {
      const state = this.stateFor(toolCallId);
      state.items.set(item.id, item);
      state.emitToolCall = emitToolCall;
    }
  }

  private stateFor(parentToolCallId: string): OmpSubagentCardState {
    const existing = this.states.get(parentToolCallId);
    if (existing) {
      return existing;
    }
    const state: OmpSubagentCardState = {
      items: new Map(),
      emitToolCall: this.emitToolCall,
      lastEmitMs: null,
      trailingTimer: null,
      dirty: false,
    };
    this.states.set(parentToolCallId, state);
    return state;
  }

  private appendLine(item: OmpSubagentCardItem, key: string, text: string): void {
    const normalizedText = normalizeLine(text);
    if (!normalizedText) {
      return;
    }
    if (item.lineKeys.has(key)) {
      const existing = item.lines.find((line) => line.key === key);
      if (existing) existing.text = normalizedText;
      return;
    }
    item.lines.push({ key, text: normalizedText });
    item.lineKeys.add(key);
    while (item.lines.length > MAX_LOG_LINES_PER_ITEM) {
      const removed = item.lines.shift();
      if (removed) {
        item.lineKeys.delete(removed.key);
        item.pendingToolLines.delete(removed.key);
      }
    }
  }

  private requestEmit(toolCallId: string): void {
    const state = this.stateFor(toolCallId);
    const now = this.scheduler.now();
    const elapsedMs = state.lastEmitMs === null ? THROTTLE_INTERVAL_MS : now - state.lastEmitMs;
    if (elapsedMs >= THROTTLE_INTERVAL_MS) {
      this.emitNow(toolCallId, state);
      return;
    }

    state.dirty = true;
    if (state.trailingTimer) {
      return;
    }
    state.trailingTimer = this.scheduler.setTimeout(() => {
      state.trailingTimer = null;
      if (state.dirty) {
        this.emitNow(toolCallId, state);
      }
    }, THROTTLE_INTERVAL_MS - elapsedMs);
  }

  private emitNow(toolCallId: string, state: OmpSubagentCardState): void {
    if (state.trailingTimer) {
      this.scheduler.clearTimeout(state.trailingTimer);
      state.trailingTimer = null;
    }
    state.dirty = false;
    if (state.emitToolCall(toolCallId)) {
      state.lastEmitMs = this.scheduler.now();
    } else {
      // Native frames can beat the parent's argument stream. Keep the record pending for flush.
      state.dirty = true;
    }
  }
}

function buildLog(items: OmpSubagentCardItem[], fallback: string): string {
  const itemCount = Math.max(...items.map((item) => item.index)) + 1;
  const lines = items.flatMap((item) => {
    const prefix = itemCount > 1 ? `[${item.index + 1}/${itemCount}] ` : "";
    return item.lines.map((line) => `${prefix}${line.text}`);
  });
  return lines.length > 0 ? lines.join("\n") : fallback;
}

function summarizeTool(tool: Record<string, unknown> | null): OmpSubagentLogLine | null {
  if (!tool) {
    return null;
  }
  const toolName = readTrimmedString(tool.tool) ?? readTrimmedString(tool.name);
  if (!toolName) {
    return null;
  }
  const args = summarizeUnknown(tool.args) ?? summarizeUnknown(tool.input);
  const endMs = typeof tool.endMs === "number" ? `:${tool.endMs}` : "";
  const startMs = typeof tool.startMs === "number" ? `:${tool.startMs}` : "";
  return {
    key: `${toolName}:${args ?? ""}${startMs}${endMs}`,
    text: args ? `[${toolName}] ${args}` : `[${toolName}]`,
  };
}

function readOutputLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const text =
      readTrimmedString(item) ??
      (isRecord(item)
        ? (readTrimmedString(item.text) ??
          readTrimmedString(item.output) ??
          readTrimmedString(item.content))
        : undefined);
    return text ? [text] : [];
  });
}


function summarizeUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return readTrimmedString(value);
  }
  const json = JSON.stringify(value);
  return typeof json === "string" ? normalizeLine(json) : undefined;
}

function normalizeLine(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= MAX_LOG_LINE_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_LOG_LINE_CHARS)}...`;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
