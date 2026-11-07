import { describe, expect, it } from "vitest";
import type { StreamItem, ThoughtItem, ToolCallItem } from "@/types/stream";
import { prepareAgentActivityHistory, projectAgentActivity } from "./activity-grouping";

const timestamp = new Date(0);

function thought(
  id: string,
  turnId = "turn-1",
  status: ThoughtItem["status"] = "ready",
): ThoughtItem {
  return { kind: "thought", id, turnId, text: id, timestamp, status };
}

function tool(
  id: string,
  turnId = "turn-1",
  status: "executing" | "completed" = "completed",
): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    turnId,
    timestamp,
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName: "read",
        arguments: {},
        status,
      },
    },
  };
}

function assistant(id: string, turnId = "turn-1"): StreamItem {
  return {
    kind: "assistant_message",
    id,
    turnId,
    text: id,
    timestamp,
  };
}

describe("agent activity grouping", () => {
  it("collapses consecutive thoughts and tool calls behind the first item", () => {
    const items = [thought("thought-1"), tool("tool-1"), thought("thought-2")];
    const history = prepareAgentActivityHistory(items);

    expect(history.tail.map((item) => item.id)).toEqual(["thought-1"]);
    expect(history.groupsByHostId.get("thought-1")?.items).toEqual(items);
  });

  it.each(["generate_image", "present_image"] as const)(
    "keeps completed %s image previews visible outside collapsed activity",
    (name) => {
      const image: ToolCallItem = {
        kind: "tool_call",
        id: "image-1",
        turnId: "turn-1",
        timestamp,
        payload: {
          source: "agent",
          data: {
            provider: "omp",
            callId: "image-1",
            name,
            status: "completed",
            error: null,
            detail: {
              type: "plain_text",
              icon: "sparkles",
              preview: { type: "image", source: "/tmp/qr.png" },
            },
          },
        },
      };
      const history = prepareAgentActivityHistory([thought("thought-1"), image, tool("tool-1")]);

      expect(history.tail.map((item) => item.id)).toEqual(["thought-1", "image-1", "tool-1"]);
      expect(history.groupsByHostId.size).toBe(0);
    },
  );

  it("keeps activity from different canonical turns in separate groups", () => {
    const history = prepareAgentActivityHistory([
      thought("thought-1", "turn-1"),
      tool("tool-1", "turn-1"),
      thought("thought-2", "turn-2"),
      tool("tool-2", "turn-2"),
    ]);

    expect(history.tail.map((item) => item.id)).toEqual(["thought-1", "thought-2"]);
    expect([...history.groupsByHostId.keys()]).toEqual(["thought-1", "thought-2"]);
  });

  it("extends a trailing history group with live-head activity", () => {
    const history = prepareAgentActivityHistory([thought("thought-1")]);
    const projection = projectAgentActivity({
      history,
      head: [tool("tool-1", "turn-1", "executing"), assistant("assistant-1")],
    });

    expect(projection.tail.map((item) => item.id)).toEqual(["thought-1"]);
    expect(projection.head.map((item) => item.id)).toEqual(["assistant-1"]);
    expect(projection.groupsByHostId.get("thought-1")?.items.map((item) => item.id)).toEqual([
      "thought-1",
      "tool-1",
    ]);
    expect(projection.groupsByHostId.get("thought-1")?.isLoading).toBe(true);
    expect(projection.historyGroupUpdatesByHostId.has("thought-1")).toBe(true);
  });

  it("groups process completions with tools but keeps ordinary custom replies visible", () => {
    const completion: StreamItem = {
      kind: "assistant_message",
      id: "completion",
      turnId: "turn-1",
      text: "Supervised process smoke failed with exit code 1.",
      customMessage: { customType: "launch-completion" },
      timestamp,
    };
    const reply: StreamItem = {
      ...completion,
      id: "plugin-reply",
      customMessage: { customType: "plugin-reply" },
    };
    const history = prepareAgentActivityHistory([tool("read"), completion, reply, tool("next")]);

    expect(history.tail.map((item) => item.id)).toEqual(["read", "plugin-reply", "next"]);
    expect(history.groupsByHostId.get("read")?.items).toEqual([tool("read"), completion]);
    expect(history.groupsByHostId.get("read")?.isLoading).toBe(false);

    const projection = projectAgentActivity({
      history: prepareAgentActivityHistory([completion]),
      head: [tool("live", "turn-1", "executing")],
    });
    expect(projection.head).toEqual([]);
    expect(
      projection.historyGroupUpdatesByHostId.get("completion")?.items.map((item) => item.id),
    ).toEqual(["completion", "live"]);
    expect(projection.groupsByHostId.get("completion")?.isLoading).toBe(true);
  });
});
