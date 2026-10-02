import { describe, expect, test } from "vitest";

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
      }),
    ).toMatchObject([{ event: { type: "upsert", model: "openai-codex/gpt-5.5-2026-07-01" } }]);
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
    ).toEqual(["timeline"]);
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
    expect(index.markCanceled(parent, "child-1")).toMatchObject({
      event: { model: "anthropic/claude-sonnet-5", status: "canceled" },
    });
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

  test("maps child message events onto the descriptor timeline", () => {
    const index = new OmpSubagentIndex();
    const parent = {};
    expect(
      index.handleEvent(parent, {
        id: "child-1",
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Child answer" }],
          },
        },
      }),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "omp",
        event: {
          type: "timeline",
          id: "child-1",
          item: {
            type: "assistant_message",
            text: "Child answer",
            messageId: "omp-history-assistant-1",
          },
        },
      },
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
});
