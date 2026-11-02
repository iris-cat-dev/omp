import { describe, expect, test } from "vitest";
import { OmpRuntimeEventSchema, OmpSubagentProgressPayloadSchema } from "./rpc-types.js";
import { OmpSubagentIndex } from "./subagent-index.js";

describe("OMP native child event schemas", () => {
  test.each([
    { type: "toolcall_start", contentIndex: 0 },
    { type: "toolcall_delta", contentIndex: 0, delta: '{"command":' },
    { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } } },
    { type: "image_end", contentIndex: 0, content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } },
    { type: "error", reason: "aborted" },
  ])("retains assistant streaming subtype $type", (assistantMessageEvent) => {
    const frame = { type: "subagent_event", payload: { id: "child", event: { type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent } } };
    expect(OmpRuntimeEventSchema.parse(frame)).toEqual(frame);
  });

  test.each([
    { type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] },
    { type: "tool_stream_update", toolCallId: "call", toolName: "edit", update: { streaming: true, path: "a.ts" } },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "busy" },
    { type: "auto_retry_end", attempt: 1, success: true, retryErrors: [] },
    { type: "auto_compaction_start", reason: "overflow", action: "remote" },
    { type: "auto_compaction_end", aborted: false, willRetry: true },
    { type: "manual_compaction_start", mode: "handoff" },
    { type: "manual_compaction_end", aborted: false },
    { type: "retry_fallback_applied", from: "one", to: "two", role: "default" },
    { type: "retry_fallback_succeeded", model: "two", role: "default" },
    { type: "cache_warming_start" },
    { type: "cache_warming_end" },
    { type: "model_changed" },
    { type: "thinking_level_changed", thinkingLevel: "high" },
    { type: "notice", level: "warning", message: "child notice" },
    { type: "queue_update", steering: [], followUp: [], liveSteered: 0 },
    { type: "irc_message", message: { role: "custom", customType: "irc", content: "hello" } },
  ])("preserves session event $type inside a child frame", (event) => {
    const frame = { type: "subagent_event", payload: { id: "child", event } };
    expect(OmpRuntimeEventSchema.parse(frame)).toEqual(frame);
  });

  test("does not discard a child frame when the SDK adds a new session or assistant subtype", () => {
    const unknown = { type: "subagent_event", payload: { id: "child", event: { type: "future_session_event", detail: { retained: true } } } };
    expect(OmpRuntimeEventSchema.parse(unknown)).toEqual(unknown);
    const update = { type: "subagent_event", payload: { id: "child", event: { type: "message_update", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-5", content: [] }, assistantMessageEvent: { type: "future_assistant_event", detail: "retained" } } } };
    const parsed = OmpRuntimeEventSchema.parse(update);
    expect(parsed).toEqual(update);
    if (parsed.type !== "subagent_event") throw new Error("Expected a native child event");
    expect(new OmpSubagentIndex().handleEvent({}, parsed.payload)).toMatchObject([{ event: { type: "upsert", id: "child", model: "anthropic/claude-sonnet-5" } }]);
  });

  test("accepts native string currentTool with independently supplied args", () => {
    const payload = { index: 0, agent: "task", task: "Wait", progress: { id: "child", status: "running", currentTool: "bash", currentToolArgs: "sleep 60", recentTools: [{ tool: "read", args: "README.md", endMs: 1 }] } };
    expect(OmpSubagentProgressPayloadSchema.parse(payload)).toEqual(payload);
  });
});
