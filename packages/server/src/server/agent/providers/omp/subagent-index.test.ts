import { describe, expect, test } from "vitest";

import type { AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";
import type { OmpAgentMessage, OmpSubagentEventPayload } from "./rpc-types.js";
import { OmpSubagentIndex } from "./subagent-index.js";

describe("OMP provider subagent mapper", () => {
  test("maps lifecycle and progress frames to stable provider_subagent descriptors", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleLifecycle(parent, {
        id: "child-1",
        agent: "explore",
        description: "Inspect files",
        status: "started",
        parentToolCallId: "task-1",
        index: 0,
      }),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "omp",
        event: {
          type: "upsert",
          id: "child-1",
          title: "explore",
          description: "Inspect files",
          model: null,
          status: "running",
          toolCallId: "task-1",
        },
      },
    ]);

    expect(
      index.handleProgress(parent, {
        index: 0,
        agent: "explore",
        task: "Inspect files",
        parentToolCallId: "task-1",
        progress: {
          id: "child-1",
          status: "running",
          resolvedModel: "openai-codex/gpt-5.5",
        },
      })[0],
    ).toMatchObject({
      event: {
        id: "child-1",
        model: "openai-codex/gpt-5.5",
        status: "running",
        title: "explore",
      },
    });

    expect(
      index.handleProgress(parent, {
        index: 0,
        agent: "explore",
        task: "Inspect files",
        parentToolCallId: "task-1",
        progress: {
          id: "child-1",
          status: "completed",
          resolvedModel: "anthropic/claude-sonnet-5",
        },
      })[0],
    ).toMatchObject({
      event: {
        model: "anthropic/claude-sonnet-5",
        status: "completed",
        title: "explore",
      },
    });
  });

  test("updates from child message metadata and preserves it through metadata-less events", () => {
    const index = new OmpSubagentIndex();
    const parent = { model: "parent-model" };
    const lifecycle = {
      id: "child-1",
      agent: "task",
      index: 0,
      parentToolCallId: "task-1",
    };
    expect(
      index.handleLifecycle(parent, { ...lifecycle, status: "started", model: "default" }),
    ).toMatchObject([{ event: { model: null } }]);

    expect(
      index.handleEvent(parent, {
        id: "child-1",
        event: {
          type: "message_start",
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.5",
            content: [],
          },
        },
      }),
    ).toMatchObject([{ event: { type: "upsert", model: "openai-codex/gpt-5.5" } }]);
    expect(
      index.handleEvent(parent, {
        id: "child-1",
        event: {
          type: "message_update",
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.5",
            responseModel: "gpt-5.5-2026-07-01",
            content: [{ type: "text", text: "Answer" }],
          },
          assistantMessageEvent: { type: "text_delta", delta: "Answer" },
        },
      })[0],
    ).toMatchObject({ event: { type: "upsert", model: "openai-codex/gpt-5.5-2026-07-01" } });
    expect(
      index
        .handleEvent(parent, {
          id: "child-1",
          event: {
            type: "message_end",
            message: {
              role: "assistant",
              provider: "openai-codex",
              model: "gpt-5.5",
              responseModel: "gpt-5.5-2026-07-01",
              content: [{ type: "text", text: "Answer" }],
            },
          },
        })
        .map((event) => event.type === "provider_subagent" && event.event.type),
    ).toEqual([]);
    expect(
      index.handleEvent(parent, {
        id: "child-1",
        event: {
          type: "message_start",
          message: { role: "assistant", content: [], model: "default" },
        },
      }),
    ).toEqual([]);
    expect(
      index.handleProgress(parent, {
        ...lifecycle,
        task: "Inspect files",
        progress: { id: "child-1", status: "running", resolvedModel: " " },
      }),
    ).toMatchObject([{ event: { model: "openai-codex/gpt-5.5-2026-07-01" } }]);
    expect(index.handleLifecycle(parent, { ...lifecycle, status: "completed" })).toMatchObject([
      { event: { model: "openai-codex/gpt-5.5-2026-07-01", status: "completed" } },
    ]);
  });

  test("attributes the latest assistant in final events without replaying the timeline", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleEvent(parent, {
        id: "child-1",
        event: {
          type: "agent_end",
          messages: [
            { role: "assistant", content: [], provider: "openai-codex", model: "gpt-5.5" },
            {
              role: "assistant",
              content: [],
              provider: "anthropic",
              model: "claude-sonnet-5",
              responseModel: " ",
            },
            { role: "assistant", content: [] },
            { role: "user", content: "Next", provider: "parent", model: "not-child" },
          ],
        },
      }),
    ).toMatchObject([
      { event: { type: "upsert", id: "child-1", model: "anthropic/claude-sonnet-5" } },
    ]);
    expect(index.markCanceled(parent, "child-1")).toMatchObject([
      { event: { model: "anthropic/claude-sonnet-5", status: "canceled" } },
    ]);
    expect(
      index.handleLifecycle({}, { id: "child-1", agent: "task", index: 0, status: "started" }),
    ).toMatchObject([{ event: { model: null } }]);
    index.clear(parent);
    expect(
      index.handleLifecycle(parent, {
        id: "child-1",
        agent: "task",
        index: 0,
        status: "started",
      }),
    ).toMatchObject([{ event: { model: null } }]);
  });

  test("announces a child descriptor before its first live timeline item", () => {
    const index = new OmpSubagentIndex();
    const frames = index.handleEvent({}, {
      id: "child-1",
      event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Child answer" }] } },
    });
    expect(frames).toMatchObject([
      { event: { type: "upsert", id: "child-1", status: "running" } },
      { event: { type: "timeline", id: "child-1", item: { type: "assistant_message", text: "Child answer" } } },
    ]);
  });

  test("maps aborted lifecycle status to canceled", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleLifecycle(parent, {
        id: "child-1",
        agent: "task",
        status: "aborted",
        index: 0,
      })[0],
    ).toMatchObject({ event: { id: "child-1", status: "canceled" } });
  });

  test("streams text and thinking independently without replaying final snapshots", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    const message: OmpAgentMessage = { role: "assistant", responseId: "reply-1", content: [{ type: "thinking", thinking: "Think carefully" }, { type: "text", text: "Answer fully" }] };
    const emit = (event: OmpSubagentEventPayload["event"]) => childItems(index.handleEvent(parent, { id: "child", event }));
    emit({ type: "message_start", message: { ...message, content: [] } });
    expect(emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Think" } })).toEqual([{ type: "reasoning", text: "Think" }]);
    expect(emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Answer" } })).toMatchObject([{ type: "assistant_message", text: "Answer" }]);
    expect(emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Think carefully" } })).toEqual([{ type: "reasoning", text: " carefully" }]);
    expect(emit({ type: "message_end", message })).toMatchObject([{ type: "assistant_message", text: " fully" }]);
    expect(emit({ type: "message_end", message })).toEqual([]);
    expect(emit({ type: "agent_end", messages: [message], isTerminal: false })).toEqual([]);
  });

  test("keeps parallel tools visible through argument streaming, updates, and independent finishes", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    const emit = (event: OmpSubagentEventPayload["event"]) => childItems(index.handleEvent(parent, { id: "child", event }));
    const message: OmpAgentMessage = { role: "assistant", responseId: "tools-1", content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "sleep 30" } }] };
    expect(emit({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } })).toMatchObject([{ type: "tool_call", callId: "bash-1", status: "running" }]);
    expect(emit({ type: "message_update", message, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"sleep 30"}' } })).toMatchObject([{ type: "tool_call", metadata: { streamingArgs: '{"command":"sleep 30"}' }, detail: { type: "shell", command: "sleep 30" } }]);
    expect(emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } })).toMatchObject([{ type: "tool_call", callId: "read-1", status: "running" }]);
    expect(emit({ type: "tool_execution_update", toolCallId: "bash-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "still running" }] } })).toMatchObject([{ type: "tool_call", callId: "bash-1", status: "running", detail: { output: "still running" } }]);
    expect(emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "file contents" }] } })).toMatchObject([{ type: "tool_call", callId: "read-1", status: "completed" }]);
    expect(emit({ type: "tool_execution_update", toolCallId: "read-1", toolName: "read", partialResult: "stale" })).toEqual([]);
    expect(emit({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", isError: true, result: "execution failed" })).toMatchObject([{ type: "tool_call", callId: "bash-1", status: "failed", error: "execution failed" }]);
    expect(emit({ type: "message_end", message })).toEqual([]);
  });

  test.each(["completed", "aborted"] as const)("allows a fresh started after %s but blocks stale running progress", (terminal) => {
    const index = new OmpSubagentIndex();
    const parent = {};
    const lifecycle = { id: "child", agent: "explore", index: 0 };
    index.handleLifecycle(parent, { ...lifecycle, status: "started" });
    index.handleLifecycle(parent, { ...lifecycle, status: terminal });
    const expected = terminal === "aborted" ? "canceled" : "completed";
    expect(index.handleProgress(parent, { index: 0, agent: "explore", task: "Explore", progress: { id: "child", status: "running" } })).toMatchObject([{ event: { status: expected } }]);
    expect(index.handleLifecycle(parent, { ...lifecycle, status: "started" })).toMatchObject([{ event: { status: "running" } }]);
    expect(index.handleProgress(parent, { index: 0, agent: "explore", task: "Explore again", progress: { id: "child", status: "completed" } })).toMatchObject([{ event: { status: "completed" } }]);
  });

  test("metadata-only events cannot reverse a local cancel", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    index.handleLifecycle(parent, { id: "child", agent: "task", index: 0, status: "started" });
    index.markCanceled(parent, "child");
    const frames = index.handleEvent(parent, { id: "child", event: { type: "message_start", message: { role: "assistant", content: [], provider: "anthropic", model: "claude-sonnet-5" } } });
    expect(frames).toMatchObject([{ event: { type: "upsert", model: "anthropic/claude-sonnet-5" } }]);
    expect(frames[0]).not.toHaveProperty("event.status");
    expect(index.handleLifecycle(parent, { id: "child", agent: "task", index: 0, status: "completed" })).toMatchObject([{ event: { status: "canceled" } }]);
  });

  test("recovers exact native block prefixes and finished tools before buffered frames replay", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    const message: OmpAgentMessage = { role: "assistant", responseId: "restored", content: [{ type: "thinking", thinking: "Plan" }, { type: "text", text: "Done" }, { type: "toolCall", id: "restored-tool", name: "bash", arguments: { command: "pwd" } }] };
    const result: OmpAgentMessage = { role: "toolResult", toolCallId: "restored-tool", toolName: "bash", content: [{ type: "text", text: "/project" }] };
    index.seedHistory(parent, [], [{ id: "child", messages: [message, result] }]);
    index.hydrateSnapshot(parent, { id: "child", agent: "task", agentSource: "bundled", index: 0, lastUpdate: 1, status: "completed" });
    const emit = (event: OmpSubagentEventPayload["event"]) => childItems(index.handleEvent(parent, { id: "child", event }));
    expect(emit({ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Plan" } })).toEqual([]);
    expect(emit({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Done" } })).toEqual([]);
    expect(emit({ type: "message_end", message })).toEqual([]);
    expect(emit({ type: "tool_execution_start", toolCallId: "restored-tool", toolName: "bash", args: { command: "pwd" } })).toEqual([]);
    expect(emit({ type: "message_end", message: result })).toEqual([]);
  });

  test("preserves a tool that arrives before the first lifecycle frame", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    index.handleEvent(parent, { id: "child", event: { type: "tool_execution_start", toolCallId: "early", toolName: "bash", args: { command: "sleep 100" } } });
    index.handleLifecycle(parent, { id: "child", agent: "task", index: 0, status: "started" });
    expect(childItems(index.handleEvent(parent, { id: "child", event: { type: "tool_execution_update", toolCallId: "early", toolName: "bash", partialResult: "alive" } }))).toMatchObject([{ type: "tool_call", detail: { type: "shell", command: "sleep 100", output: "alive" } }]);
  });

  test("shows retry and compaction without pretending an agent_end ends the child", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    const emit = (event: OmpSubagentEventPayload["event"]) => childItems(index.handleEvent(parent, { id: "child", event }));
    expect(emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "busy" })).toMatchObject([{ type: "extension_notification", level: "warning" }]);
    expect(emit({ type: "auto_compaction_start", reason: "overflow", action: "remote" })).toMatchObject([{ type: "compaction", status: "loading" }, { type: "extension_notification" }]);
    expect(emit({ type: "auto_compaction_end", aborted: false, willRetry: true })).toMatchObject([{ type: "compaction", status: "completed" }, { type: "extension_notification" }]);
    emit({ type: "agent_end", isTerminal: true, messages: [] });
    expect(index.markCanceled(parent, "child")).toMatchObject([{ event: { status: "canceled" } }]);
  });

  test("cancel acknowledgement immediately ends all parallel child tools without waiting for SDK abort", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    for (const id of ["one", "two"]) index.handleEvent(parent, { id: "child", event: { type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "sleep 999" } } });
    const canceled = index.markCanceled(parent, "child");
    expect(canceled).toMatchObject([
      { event: { type: "upsert", status: "canceled" } },
      { event: { type: "timeline", item: { type: "tool_call", callId: "one", status: "canceled" } } },
      { event: { type: "timeline", item: { type: "tool_call", callId: "two", status: "canceled" } } },
    ]);
    expect(childItems(index.handleEvent(parent, { id: "child", event: { type: "tool_execution_end", toolCallId: "one", toolName: "bash", result: "late" } }))).toEqual([]);
    expect(index.markCanceled(parent, "child")).toEqual([]);
  });

  test("handles projected child tool args and interleaved wire message identities", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    const emit = (event: OmpSubagentEventPayload["event"]) => childItems(index.handleEvent(parent, { id: "child", event }));
    expect(emit({ type: "message_update", messageId: "wire-one", message: { role: "assistant" }, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, block: { type: "toolCall", id: "stream-tool", name: "bash", arguments: {} } } })).toMatchObject([{ type: "tool_call", callId: "stream-tool", status: "running" }]);
    expect(emit({ type: "message_update", messageId: "wire-one", message: { role: "assistant" }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"sleep' } })).toMatchObject([{ type: "tool_call", detail: { type: "unknown", input: '{"command":"sleep' } }]);
    expect(emit({ type: "message_update", messageId: "wire-two", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Second" } })).toMatchObject([{ type: "assistant_message", messageId: "wire-two", text: "Second" }]);
    expect(emit({ type: "message_update", messageId: "wire-one", message: { role: "assistant" }, assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "stream-tool", name: "bash", arguments: { command: "sleep 10" } } } })).toMatchObject([{ type: "tool_call", callId: "stream-tool", detail: { type: "shell", command: "sleep 10" } }]);
    expect(emit({ type: "message_end", messageId: "wire-two", message: { role: "assistant", responseId: "final-two", content: [{ type: "text", text: "Second" }] } })).toEqual([]);
  });

  test("seeded final messages survive buffered started without swallowing a new continuation", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    const old: OmpAgentMessage = { role: "assistant", responseId: "old", content: [{ type: "text", text: "Done" }] };
    index.seedHistory(parent, [], [{ id: "child", messages: [old] }]);
    index.hydrateSnapshot(parent, { id: "child", index: 0, agent: "task", agentSource: "bundled", lastUpdate: 1, status: "completed" });
    index.handleLifecycle(parent, { id: "child", index: 0, agent: "task", status: "started" });
    const emit = (event: OmpSubagentEventPayload["event"]) => childItems(index.handleEvent(parent, { id: "child", event }));
    emit({ type: "message_start", message: { ...old, content: [] } });
    expect(emit({ type: "message_update", message: old, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Done" } })).toEqual([]);
    expect(emit({ type: "message_end", message: old })).toEqual([]);
    const next: OmpAgentMessage = { role: "assistant", responseId: "next", content: [{ type: "text", text: "Done" }] };
    emit({ type: "message_start", message: { ...next, content: [] } });
    expect(emit({ type: "message_update", message: next, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Done" } })).toMatchObject([{ type: "assistant_message", messageId: "next", text: "Done" }]);
    expect(emit({ type: "message_end", message: next })).toEqual([]);
  });
});

function childItems(events: AgentStreamEvent[]): AgentTimelineItem[] {
  return events.flatMap((event) => event.type === "provider_subagent" && event.event.type === "timeline" ? [event.event.item] : []);
}
