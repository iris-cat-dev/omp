import { createHash } from "node:crypto";
import type {
  AgentStreamEvent,
  AgentTimelineItem,
  ToolCallTimelineItem,
} from "../../agent-sdk-types.js";
import { OmpHistoryMapper } from "./message-history.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import {
  OmpAgentMessageSchema,
  type OmpAgentMessage,
  type OmpSubagentEventPayload,
} from "./rpc-types.js";
import {
  extractTextFromToolResult,
  parseToolArgs,
  normalizeOmpToolIntent,
  parseToolResult,
  resolveToolCallName,
  type OmpToolResult,
} from "./tool-call-detail.js";

type AssistantMessage = Extract<OmpAgentMessage, { role: "assistant" }>;
interface TextBlockState {
  streamed: string;
  sent: string;
}
interface MessageState {
  id: string;
  blocks: Map<number, TextBlockState>;
  tools: Map<number, string>;
  ended: boolean;
}
interface ToolState {
  name: string;
  args: unknown;
  argsJson: string;
  result: OmpToolResult;
  status: ToolCallTimelineItem["status"];
  metadata: Record<string, unknown>;
  lastEmission?: string;
  executionStarted?: boolean;
}

/** Live snapshots may be ahead of their deltas. Only block ends/final messages are authoritative. */
export class OmpSubagentLiveMapper {
  private readonly history = new OmpHistoryMapper("omp", [], OMP_HISTORY_MAPPER_HOOKS);
  private readonly messages = new Map<string, MessageState>();
  private readonly finalizedMessages = new Map<string, MessageState>();
  private readonly otherMessages = new Set<string>();
  private readonly tools = new Map<string, ToolState>();
  private active: MessageState | null = null;
  private messageIndex = 0;

  beginRun(): void {
    this.active = null;
    for (const [id, tool] of this.tools) {
      if (tool.status === "running") this.tools.delete(id);
    }
  }

  seed(item: AgentTimelineItem): void {
    if (item.type === "assistant_message" && item.messageId) {
      const state = this.messages.get(item.messageId) ?? {
        id: item.messageId,
        blocks: new Map<number, TextBlockState>(),
        tools: new Map<number, string>(),
        ended: true,
      };
      const block = state.blocks.get(0) ?? { streamed: "", sent: "" };
      block.sent += item.text;
      block.streamed = "";
      state.blocks.set(0, block);
      this.messages.set(item.messageId, state);
      const ordinal = /^omp-history-assistant-(\d+)$/.exec(item.messageId);
      if (ordinal) this.messageIndex = Math.max(this.messageIndex, Number(ordinal[1]));
    }
    if (item.type === "tool_call") {
      const state: ToolState = {
        name: item.name,
        args: item.detail.type === "unknown" ? item.detail.input : null,
        argsJson: "",
        result: null,
        status: item.status,
        metadata: item.metadata ?? {},
        lastEmission: createHash("sha256").update(JSON.stringify(item)).digest("hex"),
      };
      this.tools.set(item.callId, state);
    }
  }

  seedMessages(messages: readonly OmpAgentMessage[]): void {
    this.active = null;
    for (const message of messages) {
      if (message.role === "assistant") {
        this.seedAssistantMessage(message);
      } else if (message.role === "toolResult") {
        const tool = this.toolFor(message.toolCallId, message.toolName);
        tool.result = parseToolResult(message);
        tool.status = message.isError ? "failed" : "completed";
        this.emitTool(message.toolCallId, tool, []);
      } else {
        this.otherMessages.add(JSON.stringify(message));
      }
    }
    this.active = null;
  }

  map(event: OmpSubagentEventPayload["event"], terminal = false): AgentStreamEvent[] {
    const output: AgentStreamEvent[] = [];
    switch (event.type) {
      case "message_start":
      case "message_update":
      case "message_end":
      case "turn_end":
      case "irc_message":
        this.mapMessage(event, output, terminal);
        break;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
      case "tool_stream_update":
        this.mapToolExecution(event, output, terminal);
        break;
      default:
        this.mapLifecycle(event, output);
        break;
    }
    return output;
  }

  private seedAssistantMessage(message: AssistantMessage): void {
    const state = this.messageFor(message, true);
    state.blocks.clear();
    state.tools.clear();
    for (const [index, content] of message.content.entries()) {
      if (content.type === "text" || content.type === "thinking") {
        const text = content.type === "text" ? content.text : content.thinking;
        state.blocks.set(index, { streamed: "", sent: text });
      }
      if (content.type === "toolCall") {
        state.tools.set(index, content.id);
        const tool = this.toolFor(content.id, content.name);
        tool.args = content.arguments;
        const intent = parseToolArgs(content.name, content.arguments, content.intent).intent;
        if (intent) tool.metadata.intent = intent;
      }
    }
    this.finishMessage(message, state);
  }

  private finishMessage(message: AssistantMessage, state: MessageState): void {
    state.ended = true;
    if (
      !message.responseId &&
      typeof message.id !== "string" &&
      typeof message.timestamp !== "number"
    ) {
      this.finalizedMessages.set(JSON.stringify(message), state);
    }
  }

  private mapMessage(
    event: OmpSubagentEventPayload["event"],
    output: AgentStreamEvent[],
    terminal: boolean,
  ): void {
    const messageRecord = record(event.message);
    const projected =
      event.type === "message_update" &&
      messageRecord?.role === "assistant" &&
      messageRecord.content === undefined;
    const parsed = OmpAgentMessageSchema.safeParse(
      projected ? { ...messageRecord, content: [] } : event.message,
    );
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.role !== "assistant") {
      if (event.type === "message_end" || event.type === "irc_message")
        this.mapOther(message, output);
      return;
    }
    const state = this.messageFor(
      message,
      event.type === "message_start",
      typeof event.messageId === "string" ? event.messageId : undefined,
    );
    if (event.type === "message_update") {
      const update = record(event.assistantMessageEvent);
      if (update) this.mapUpdate(message, state, update, output, terminal);
    }
    if (event.type === "message_end" || event.type === "turn_end") {
      this.flushMessage(message, state, output, terminal);
      this.finishMessage(message, state);
    }
  }

  private mapToolExecution(
    event: OmpSubagentEventPayload["event"],
    output: AgentStreamEvent[],
    terminal: boolean,
  ): void {
    if (terminal && event.type !== "tool_execution_end") return;
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return;
    const tool = this.toolFor(event.toolCallId, event.toolName);
    if (tool.status === "canceled") return;
    if (event.type === "tool_execution_end") {
      tool.result = parseToolResult(event.result);
      tool.status = event.isError ? "failed" : "completed";
    } else if (tool.status === "running") {
      if (event.type === "tool_execution_start") tool.executionStarted = true;
      if (event.args !== undefined) tool.args = event.args;
      if (event.type === "tool_execution_start" && event.args !== undefined) {
        tool.argsJson = "";
        delete tool.metadata.streamingArgs;
      }
      if (event.type === "tool_execution_update")
        tool.result = parseToolResult(event.partialResult);
      if (event.type === "tool_stream_update") tool.metadata.streamUpdate = event.update;
      const intent =
        normalizeOmpToolIntent(event.intent) ??
        normalizeOmpToolIntent(tool.metadata.intent) ??
        parseToolArgs(event.toolName, tool.args).intent;
      if (intent) tool.metadata.intent = intent;
    } else {
      return;
    }
    this.emitTool(event.toolCallId, tool, output);
  }

  private mapLifecycle(event: OmpSubagentEventPayload["event"], output: AgentStreamEvent[]): void {
    switch (event.type) {
      case "compaction_start":
      case "auto_compaction_start":
      case "manual_compaction_start":
        output.push(
          timeline({
            type: "compaction",
            status: "loading",
            trigger: event.type === "manual_compaction_start" ? "manual" : "auto",
          }),
        );
        if (typeof event.reason === "string")
          output.push(notification(`Compacting context: ${event.reason}`));
        break;
      case "compaction_end":
      case "auto_compaction_end":
      case "manual_compaction_end":
        this.mapCompactionEnd(event, output);
        break;
      default:
        this.mapNotice(event, output);
        break;
    }
    // agent_end can be a temporary settle before an async continuation, not a child lifecycle end.
  }

  private mapCompactionEnd(
    event: OmpSubagentEventPayload["event"],
    output: AgentStreamEvent[],
  ): void {
    const result = record(event.result);
    output.push(
      timeline({
        type: "compaction",
        status: "completed",
        trigger: event.type === "manual_compaction_end" ? "manual" : "auto",
        ...(typeof result?.tokensBefore === "number" ? { preTokens: result.tokensBefore } : {}),
      }),
    );
    if (typeof event.errorMessage === "string")
      output.push(notification(event.errorMessage, "warning"));
    else if (event.aborted) output.push(notification("Context compaction canceled", "warning"));
    else if (event.skipped) output.push(notification("Context compaction skipped"));
    else if (event.willRetry)
      output.push(notification("Context compacted; continuing the child task"));
  }

  private mapNotice(event: OmpSubagentEventPayload["event"], output: AgentStreamEvent[]): void {
    switch (event.type) {
      case "auto_retry_start":
        output.push(
          notification(
            `Retrying child request (${event.attempt}/${event.maxAttempts}) in ${event.delayMs} ms: ${event.errorMessage}`,
            "warning",
          ),
        );
        break;
      case "auto_retry_end":
        output.push(
          notification(
            event.success
              ? "Child request recovered after retry"
              : `Child retries exhausted: ${event.finalError ?? "request failed"}`,
            event.success ? "info" : "error",
          ),
        );
        break;
      case "retry_fallback_applied":
        output.push(notification(`Retry fallback: ${event.from} → ${event.to}`, "warning"));
        break;
      case "retry_fallback_succeeded":
        output.push(notification(`Retry fallback succeeded: ${event.model}`));
        break;
      case "notice":
        if (typeof event.message === "string") {
          output.push(
            notification(
              event.message,
              event.level === "error" || event.level === "warning" ? event.level : "info",
            ),
          );
        }
        break;
      case "thinking_level_changed":
        if (typeof event.thinkingLevel === "string") {
          output.push(
            timeline({
              type: "system_notice",
              notice: "thinking_changed",
              thinkingOptionId: event.thinkingLevel,
            }),
          );
        }
        break;
    }
  }

  cancelRunning(): AgentStreamEvent[] {
    const output: AgentStreamEvent[] = [];
    for (const [id, tool] of this.tools) {
      if (tool.status !== "running") continue;
      tool.status = "canceled";
      this.emitTool(id, tool, output);
    }
    return output;
  }

  private messageFor(message: AssistantMessage, start: boolean, wireId?: string): MessageState {
    const messageId = typeof message.id === "string" ? message.id : undefined;
    const timestampId =
      typeof message.timestamp === "number" ? `omp-message-${message.timestamp}` : undefined;
    const identity = wireId ?? messageId ?? message.responseId ?? timestampId;
    const known =
      this.findMessageByIdentity(wireId, messageId, message.responseId, timestampId) ??
      (!start && !identity && (!this.active || this.active.ended)
        ? this.finalizedMessages.get(JSON.stringify(message))
        : undefined);
    if (known) {
      this.rememberMessage(known, message, wireId);
      this.active = known;
      return known;
    }
    if (
      !start &&
      this.active &&
      !this.active.ended &&
      (!identity || this.active.id.startsWith("omp-history-assistant-"))
    ) {
      this.rememberMessage(this.active, message, wireId);
      return this.active;
    }
    this.messageIndex += 1;
    const state: MessageState = {
      id: identity ?? `omp-history-assistant-${this.messageIndex}`,
      blocks: new Map(),
      tools: new Map(),
      ended: false,
    };
    this.rememberMessage(state, message, wireId);
    this.active = state;
    return state;
  }

  private findMessageByIdentity(
    wireId: string | undefined,
    messageId: string | undefined,
    responseId: string | undefined,
    timestampId: string | undefined,
  ): MessageState | undefined {
    return (
      (wireId ? this.messages.get(wireId) : undefined) ??
      (messageId ? this.messages.get(messageId) : undefined) ??
      (responseId ? this.messages.get(responseId) : undefined) ??
      (timestampId ? this.messages.get(timestampId) : undefined)
    );
  }

  private rememberMessage(state: MessageState, message: AssistantMessage, wireId?: string): void {
    this.messages.set(state.id, state);
    if (wireId) this.messages.set(wireId, state);
    if (typeof message.id === "string") this.messages.set(message.id, state);
    if (message.responseId) this.messages.set(message.responseId, state);
    if (typeof message.timestamp === "number")
      this.messages.set(`omp-message-${message.timestamp}`, state);
  }

  private mapUpdate(
    message: AssistantMessage,
    state: MessageState,
    update: Record<string, unknown>,
    output: AgentStreamEvent[],
    terminal: boolean,
  ): void {
    const kind = typeof update.type === "string" ? update.type : "";
    const index = this.updateContentIndex(message, update, kind);
    if (kind === "text_delta" || kind === "thinking_delta") {
      const block = state.blocks.get(index) ?? { streamed: "", sent: "" };
      block.streamed += typeof update.delta === "string" ? update.delta : "";
      state.blocks.set(index, block);
      this.emitText(state, index, kind === "thinking_delta", block.streamed, output);
    } else if (kind === "text_end" || kind === "thinking_end") {
      this.mapTextEnd(message, state, index, kind, update, output);
    } else if (kind.startsWith("toolcall_")) {
      if (terminal) return;
      this.mapToolCallUpdate(message, state, index, kind, update, output);
    } else if (kind === "done" || kind === "error") {
      const final = OmpAgentMessageSchema.safeParse(
        kind === "done" ? update.message : update.error,
      );
      this.flushMessage(
        final.success && final.data.role === "assistant" ? final.data : message,
        state,
        output,
        terminal,
      );
    }
  }

  private updateContentIndex(
    message: AssistantMessage,
    update: Record<string, unknown>,
    kind: string,
  ): number {
    if (typeof update.contentIndex === "number") return update.contentIndex;
    let blockType = "text";
    if (kind.startsWith("thinking_")) blockType = "thinking";
    else if (kind.startsWith("toolcall_")) blockType = "toolCall";
    return Math.max(
      0,
      message.content.findIndex((block) => block.type === blockType),
    );
  }

  private mapTextEnd(
    message: AssistantMessage,
    state: MessageState,
    index: number,
    kind: string,
    update: Record<string, unknown>,
    output: AgentStreamEvent[],
  ): void {
    const snapshot = message.content[index];
    let text = "";
    if (typeof update.content === "string") text = update.content;
    else if (snapshot?.type === "text") text = snapshot.text;
    else if (snapshot?.type === "thinking") text = snapshot.thinking;
    this.emitText(state, index, kind === "thinking_end", text, output);
  }

  private mapToolCallUpdate(
    message: AssistantMessage,
    state: MessageState,
    index: number,
    kind: string,
    update: Record<string, unknown>,
    output: AgentStreamEvent[],
  ): void {
    const parsed =
      record(update.toolCall) ?? record(message.content[index]) ?? record(update.block);
    const existingId = state.tools.get(index);
    const id = typeof parsed?.id === "string" ? parsed.id : existingId;
    let name: string | undefined;
    if (typeof parsed?.name === "string") name = parsed.name;
    else if (existingId) name = this.tools.get(existingId)?.name;
    if (!id || !name) return;
    state.tools.set(index, id);
    const tool = this.toolFor(id, name);
    if (tool.status !== "running" || tool.executionStarted) return;
    this.updateToolCallArguments(tool, name, parsed, kind, update);
    this.emitTool(id, tool, output);
  }

  private updateToolCallArguments(
    tool: ToolState,
    name: string,
    parsed: Record<string, unknown> | null,
    kind: string,
    update: Record<string, unknown>,
  ): void {
    if (kind === "toolcall_delta" && typeof update.delta === "string") {
      tool.argsJson += update.delta;
      tool.metadata.streamingArgs = tool.argsJson;
    }
    if (parsed?.arguments !== undefined) tool.args = parsed.arguments;
    if (kind === "toolcall_end" && parsed?.arguments !== undefined) {
      tool.argsJson = "";
      delete tool.metadata.streamingArgs;
    }
    const intent = parseToolArgs(name, tool.args, parsed?.intent).intent;
    if (intent) tool.metadata.intent = intent;
  }

  private flushMessage(
    message: AssistantMessage,
    state: MessageState,
    output: AgentStreamEvent[],
    terminal: boolean,
  ): void {
    for (const [index, content] of message.content.entries()) {
      if (content.type === "text") this.emitText(state, index, false, content.text, output);
      if (content.type === "thinking") this.emitText(state, index, true, content.thinking, output);
      if (content.type === "toolCall") {
        const tool = this.toolFor(content.id, content.name);
        const intent = parseToolArgs(content.name, content.arguments, content.intent).intent;
        if (intent && !normalizeOmpToolIntent(tool.metadata.intent)) tool.metadata.intent = intent;
        if (terminal || tool.status !== "running" || tool.executionStarted) continue;
        tool.args = content.arguments;
        if (intent) tool.metadata.intent = intent;
        this.emitTool(content.id, tool, output);
      }
    }
  }

  private emitText(
    state: MessageState,
    index: number,
    thinking: boolean,
    text: string,
    output: AgentStreamEvent[],
  ): void {
    const block = state.blocks.get(index) ?? { streamed: "", sent: "" };
    state.blocks.set(index, block);
    if (text.length <= block.sent.length || !text.startsWith(block.sent)) return;
    const delta = text.slice(block.sent.length);
    block.sent = text;
    output.push(
      timeline(
        thinking
          ? { type: "reasoning", text: delta }
          : { type: "assistant_message", text: delta, messageId: state.id },
      ),
    );
  }

  private mapOther(message: OmpAgentMessage, output: AgentStreamEvent[]): void {
    if (message.role === "toolResult") {
      const tool = this.toolFor(message.toolCallId, message.toolName);
      if (tool.status === "canceled") return;
      tool.result = parseToolResult(message);
      tool.status = message.isError ? "failed" : "completed";
      this.emitTool(message.toolCallId, tool, output);
      return;
    }
    const key = JSON.stringify(message);
    if (this.otherMessages.has(key)) return;
    this.otherMessages.add(key);
    output.push(...this.history.mapMessages([message]));
  }

  private toolFor(id: string, name: string): ToolState {
    const existing = this.tools.get(id);
    if (existing) return existing;
    const state: ToolState = {
      name,
      args: null,
      argsJson: "",
      result: null,
      status: "running",
      metadata: {},
    };
    this.tools.set(id, state);
    return state;
  }

  private emitTool(id: string, tool: ToolState, output: AgentStreamEvent[]): void {
    if (tool.status !== "running") {
      tool.argsJson = "";
      delete tool.metadata.streamingArgs;
    }
    const tracked = parseToolArgs(tool.name, tool.args);
    const emittedId = OMP_HISTORY_MAPPER_HOOKS.resolveToolCallId?.(id, tracked) ?? id;
    const specialized = OMP_HISTORY_MAPPER_HOOKS.mapToolResult?.(tracked, tool.result, {
      toolCallId: id,
    });
    const detail = OMP_HISTORY_MAPPER_HOOKS.mapToolDetail?.(tracked, tool.result, {
      toolCallId: id,
      toolCallStatus: tool.status === "canceled" ? "failed" : tool.status,
    });
    const item: AgentTimelineItem | null =
      specialized ??
      (detail
        ? {
            type: "tool_call",
            callId: emittedId,
            name: resolveToolCallName(tracked, tool.result),
            detail:
              detail.type === "unknown" && tool.status === "running" && tool.argsJson
                ? { ...detail, input: tool.argsJson }
                : detail,
            metadata: { ...tool.metadata, args: tool.args },
            ...(tool.status === "failed"
              ? {
                  status: "failed",
                  error: extractTextFromToolResult(tool.result) ?? "Tool call failed",
                }
              : { status: tool.status, error: null }),
          }
        : null);
    if (!item) return;
    const signature = createHash("sha256").update(JSON.stringify(item)).digest("hex");
    if (signature === tool.lastEmission) return;
    tool.lastEmission = signature;
    output.push(timeline(item));
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function timeline(item: AgentTimelineItem): AgentStreamEvent {
  return { type: "timeline", provider: "omp", item };
}
function notification(
  message: string,
  level: "info" | "warning" | "error" = "info",
): AgentStreamEvent {
  return timeline({ type: "extension_notification", message, level });
}
