import { describe, expect, test } from "vitest";

import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";

describe("agent timeline content", () => {
  test("limits terminal input to the tool-call content budget", () => {
    const oversizedInput = "x".repeat(64 * 1024 + 1);

    const item = limitAgentTimelineItemContent({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: oversizedInput,
        icon: "square_terminal",
      },
    });

    expect(item).toEqual({
      type: "tool_call",
      callId: "terminal-session-4242",
      name: "terminal",
      status: "completed",
      error: null,
      detail: {
        type: "plain_text",
        text: "x".repeat(64 * 1024),
        icon: "square_terminal",
      },
    });
  });
});

test.each(["shell", "plain_text", "failed-shell"] as const)(
  "preserves exact UTF-16 units when detaching oversized %s content",
  (kind) => {
    const content = "a".repeat(64 * 1024 - 1) + "😀tail";
    const common = { type: "tool_call" as const, callId: "unicode", name: "shell" };
    const item = limitAgentTimelineItemContent(
      kind === "failed-shell"
        ? {
            ...common,
            status: "failed",
            error: { content },
            detail: { type: "shell", command: "print" },
          }
        : {
            ...common,
            status: "completed",
            error: null,
            detail:
              kind === "shell"
                ? { type: "shell", command: "print", output: content }
                : { type: "plain_text", text: content },
          },
    );
    const expected = content.slice(0, 64 * 1024);
    if (kind === "failed-shell") {
      expect(item).toMatchObject({ error: { content: expected } });
    } else {
      expect(item).toMatchObject({
        detail: kind === "shell" ? { output: expected } : { text: expected },
      });
    }
  },
);
