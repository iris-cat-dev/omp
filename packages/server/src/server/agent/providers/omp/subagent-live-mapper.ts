import type { AgentStreamEvent, AgentTimelineItem, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { OmpHistoryMapper } from "./message-history.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { OmpAgentMessageSchema, type OmpAgentMessage, type OmpSubagentEventPayload } from "./rpc-types.js";
import {
  extractTextFromToolResult,
  parseToolArgs,
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
        id: item.messageId, blocks: new Map<number, TextBlockState>(), tools: new Map<number, string>(), ended: true,
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
        name: item.name, args: item.detail.type === "unknown" ? item.detail.input : null,
        argsJson: "", result: null, status: item.status, metadata: item.metadata ?? {},
        lastEmission: JSON.stringify(item),
      };
      this.tools.set(item.callId, state);
    }
  }

  seedMessages(messages: readonly OmpAgentMessage[]): void {
    this.active = null;
    for (const message of messages) {
      if (message.role === "assistant") {
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
            this.toolFor(content.id, content.name).args = content.arguments;
          }
        }
        state.ended = true;
        if (!message.responseId && typeof message.id !== "string" && typeof message.timestamp !== "number") {
          this.finalizedMessages.set(JSON.stringify(message), state);
        }
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
    if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end" || event.type === "turn_end" || event.type === "irc_message") {
      const messageRecord = record(event.message);
      const projected = event.type === "message_update" && messageRecord?.role === "assistant" && messageRecord.content === undefined;
      const parsed = OmpAgentMessageSchema.safeParse(projected ? { ...messageRecord, content: [] } : event.message);
      if (!parsed.success) return output;
      const message = parsed.data;
      if (message.role !== "assistant") {
        if (event.type === "message_end" || event.type === "irc_message") this.mapOther(message, output);
        return output;
      }
      const state = this.messageFor(message, event.type === "message_start", typeof event.messageId === "string" ? event.messageId : undefined);
      if (event.type === "message_update") {
        const update = record(event.assistantMessageEvent);
        if (update) this.mapUpdate(message, state, update, output, terminal);
      }
      if (event.type === "message_end" || event.type === "turn_end") {
        this.flushMessage(message, state, output, terminal);
        state.ended = true;
        if (!message.responseId && typeof message.id !== "string" && typeof message.timestamp !== "number") {
          this.finalizedMessages.set(JSON.stringify(message), state);
        }
      }
      return output;
    }
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end" || event.type === "tool_stream_update") {
      if (terminal && event.type !== "tool_execution_end") return output;
      if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return output;
      const tool = this.toolFor(event.toolCallId, event.toolName);
      if (tool.status === "canceled") return output;
      if (event.type === "tool_execution_end") {
        tool.result = parseToolResult(event.result);
        tool.status = event.isError ? "failed" : "completed";
      } else if (tool.status === "running") {
        if (event.args !== undefined) tool.args = event.args;
        if (event.type === "tool_execution_update") tool.result = parseToolResult(event.partialResult);
        if (event.type === "tool_stream_update") tool.metadata.streamUpdate = event.update;
        if (typeof event.intent === "string") tool.metadata.intent = event.intent;
      } else {
        return output;
      }
      this.emitTool(event.toolCallId, tool, output);
      return output;
    }
    if (event.type === "compaction_start" || event.type === "auto_compaction_start" || event.type === "manual_compaction_start") {
      output.push(timeline({ type: "compaction", status: "loading", trigger: event.type === "manual_compaction_start" ? "manual" : "auto" }));
      if (typeof event.reason === "string") output.push(notification(`Compacting context: ${event.reason}`));
    } else if (event.type === "compaction_end" || event.type === "auto_compaction_end" || event.type === "manual_compaction_end") {
      const result = record(event.result);
      output.push(timeline({ type: "compaction", status: "completed", trigger: event.type === "manual_compaction_end" ? "manual" : "auto", ...(typeof result?.tokensBefore === "number" ? { preTokens: result.tokensBefore } : {}) }));
      if (typeof event.errorMessage === "string") output.push(notification(event.errorMessage, "warning"));
      else if (event.aborted) output.push(notification("Context compaction canceled", "warning"));
      else if (event.skipped) output.push(notification("Context compaction skipped"));
      else if (event.willRetry) output.push(notification("Context compacted; continuing the child task"));
    } else if (event.type === "auto_retry_start") {
      output.push(notification(`Retrying child request (${event.attempt}/${event.maxAttempts}) in ${event.delayMs} ms: ${event.errorMessage}`, "warning"));
    } else if (event.type === "auto_retry_end") {
      output.push(notification(event.success ? "Child request recovered after retry" : `Child retries exhausted: ${event.finalError ?? "request failed"}`, event.success ? "info" : "error"));
    } else if (event.type === "retry_fallback_applied") {
      output.push(notification(`Retry fallback: ${event.from} → ${event.to}`, "warning"));
    } else if (event.type === "retry_fallback_succeeded") {
      output.push(notification(`Retry fallback succeeded: ${event.model}`));
    } else if (event.type === "notice" && typeof event.message === "string") {
      output.push(notification(event.message, event.level === "error" || event.level === "warning" ? event.level : "info"));
    } else if (event.type === "thinking_level_changed" && typeof event.thinkingLevel === "string") {
      output.push(timeline({ type: "system_notice", notice: "thinking_changed", thinkingOptionId: event.thinkingLevel }));
    }
    // agent_end can be a temporary settle before an async continuation, not a child lifecycle end.
    return output;
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
    const timestampId = typeof message.timestamp === "number" ? `omp-message-${message.timestamp}` : undefined;
    const identity = wireId ?? messageId ?? message.responseId ?? timestampId;
    const known = (wireId ? this.messages.get(wireId) : undefined)
      ?? (messageId ? this.messages.get(messageId) : undefined)
      ?? (message.responseId ? this.messages.get(message.responseId) : undefined)
      ?? (timestampId ? this.messages.get(timestampId) : undefined)
      ?? (!start && !identity && (!this.active || this.active.ended) ? this.finalizedMessages.get(JSON.stringify(message)) : undefined);
    if (known) {
      this.rememberMessage(known, message, wireId);
      this.active = known;
      return known;
    }
    if (!start && this.active && !this.active.ended && (!identity || this.active.id.startsWith("omp-history-assistant-"))) {
      this.rememberMessage(this.active, message, wireId);
      return this.active;
    }
    this.messageIndex += 1;
    const state: MessageState = { id: identity ?? `omp-history-assistant-${this.messageIndex}`, blocks: new Map(), tools: new Map(), ended: false };
    this.rememberMessage(state, message, wireId);
    this.active = state;
    return state;
  }

  private rememberMessage(state: MessageState, message: AssistantMessage, wireId?: string): void {
    this.messages.set(state.id, state);
    if (wireId) this.messages.set(wireId, state);
    if (typeof message.id === "string") this.messages.set(message.id, state);
    if (message.responseId) this.messages.set(message.responseId, state);
    if (typeof message.timestamp === "number") this.messages.set(`omp-message-${message.timestamp}`, state);
  }

  private mapUpdate(message: AssistantMessage, state: MessageState, update: Record<string, unknown>, output: AgentStreamEvent[], terminal: boolean): void {
    const kind = typeof update.type === "string" ? update.type : "";
    const index = typeof update.contentIndex === "number" ? update.contentIndex : Math.max(0, message.content.findIndex((block) => kind.startsWith("thinking_") ? block.type === "thinking" : kind.startsWith("toolcall_") ? block.type === "toolCall" : block.type === "text"));
    if (kind === "text_delta" || kind === "thinking_delta") {
      const block = state.blocks.get(index) ?? { streamed: "", sent: "" };
      block.streamed += typeof update.delta === "string" ? update.delta : "";
      state.blocks.set(index, block);
      this.emitText(state, index, kind === "thinking_delta", block.streamed, output);
    } else if (kind === "text_end" || kind === "thinking_end") {
      const snapshot = message.content[index];
      const text = typeof update.content === "string" ? update.content : snapshot?.type === "text" ? snapshot.text : snapshot?.type === "thinking" ? snapshot.thinking : "";
      this.emitText(state, index, kind === "thinking_end", text, output);
    } else if (kind.startsWith("toolcall_")) {
      if (terminal) return;
      const parsed = record(update.toolCall) ?? record(message.content[index]) ?? record(update.block);
      const existingId = state.tools.get(index);
      const id = typeof parsed?.id === "string" ? parsed.id : existingId;
      const name = typeof parsed?.name === "string" ? parsed.name : existingId ? this.tools.get(existingId)?.name : undefined;
      if (!id || !name) return;
      state.tools.set(index, id);
      const tool = this.toolFor(id, name);
      if (tool.status !== "running") return;
      if (kind === "toolcall_delta" && typeof update.delta === "string") {
        tool.argsJson += update.delta;
        tool.metadata.streamingArgs = tool.argsJson;
      }
      if (parsed?.arguments !== undefined) tool.args = parsed.arguments;
      this.emitTool(id, tool, output);
    } else if (kind === "done" || kind === "error") {
      const final = OmpAgentMessageSchema.safeParse(kind === "done" ? update.message : update.error);
      this.flushMessage(final.success && final.data.role === "assistant" ? final.data : message, state, output, terminal);
    }
  }

  private flushMessage(message: AssistantMessage, state: MessageState, output: AgentStreamEvent[], terminal: boolean): void {
    for (const [index, content] of message.content.entries()) {
      if (content.type === "text") this.emitText(state, index, false, content.text, output);
      if (content.type === "thinking") this.emitText(state, index, true, content.thinking, output);
      if (content.type === "toolCall" && !terminal) {
        const tool = this.toolFor(content.id, content.name);
        if (tool.status !== "running") continue;
        tool.args = content.arguments;
        this.emitTool(content.id, tool, output);
      }
    }
  }

  private emitText(state: MessageState, index: number, thinking: boolean, text: string, output: AgentStreamEvent[]): void {
    const block = state.blocks.get(index) ?? { streamed: "", sent: "" };
    state.blocks.set(index, block);
    if (text.length <= block.sent.length || !text.startsWith(block.sent)) return;
    const delta = text.slice(block.sent.length);
    block.sent = text;
    output.push(timeline(thinking ? { type: "reasoning", text: delta } : { type: "assistant_message", text: delta, messageId: state.id }));
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
    const state: ToolState = { name, args: null, argsJson: "", result: null, status: "running", metadata: {} };
    this.tools.set(id, state);
    return state;
  }

  private emitTool(id: string, tool: ToolState, output: AgentStreamEvent[]): void {
    const tracked = parseToolArgs(tool.name, tool.args);
    const emittedId = OMP_HISTORY_MAPPER_HOOKS.resolveToolCallId?.(id, tracked) ?? id;
    const specialized = OMP_HISTORY_MAPPER_HOOKS.mapToolResult?.(tracked, tool.result, { toolCallId: id });
    const detail = OMP_HISTORY_MAPPER_HOOKS.mapToolDetail?.(tracked, tool.result, { toolCallId: id, toolCallStatus: tool.status === "canceled" ? "failed" : tool.status });
    const item: AgentTimelineItem | null = specialized ?? (detail ? {
      type: "tool_call", callId: emittedId, name: resolveToolCallName(tracked, tool.result),
      detail: detail.type === "unknown" && tool.status === "running" && tool.argsJson ? { ...detail, input: tool.argsJson } : detail,
      metadata: { ...tool.metadata, args: tool.args },
      ...(tool.status === "failed" ? { status: "failed", error: extractTextFromToolResult(tool.result) ?? "Tool call failed" } : { status: tool.status, error: null }),
    } : null);
    if (!item) return;
    const signature = JSON.stringify(item);
    if (signature === tool.lastEmission) return;
    tool.lastEmission = signature;
    output.push(timeline(item));
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function timeline(item: AgentTimelineItem): AgentStreamEvent {
  return { type: "timeline", provider: "omp", item };
}
function notification(message: string, level: "info" | "warning" | "error" = "info"): AgentStreamEvent {
  return timeline({ type: "extension_notification", message, level });
}
