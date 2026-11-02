import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("provider subagent protocol", () => {
  test.each([false, true, "ultrafast", null])(
    "preserves subagent speed %s on the wire",
    (fastMode) => {
      const request = {
        type: "omp.subagents.management.update.request",
        agentName: "scout",
        model: "openai-codex/gpt-6.1-sol:high",
        fastMode,
        requestId: "speed-update",
      };
      expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
      if (fastMode !== null) {
        const response = {
          type: "omp.subagents.management.update.response",
          payload: {
            requestId: "speed-update",
            configPath: "/isolated/config.yml",
            enabled: true,
            agents: [{ name: "scout", description: "Research", model: request.model, fastMode }],
          },
        };
        expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
      }
    },
  );

  test.each(["ultra", "priority", "false", 1])("rejects invalid speed %s", (fastMode) => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "omp.subagents.management.update.request",
        agentName: "scout",
        model: "openai-codex/gpt-6.1-sol",
        fastMode,
        requestId: "invalid-speed",
      }).success,
    ).toBe(false);
  });

  test("accepts a scoped timeline request and structured live update", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.provider_subagents.timeline.get.request",
        parentAgentId: "parent-1",
        subagentId: "child-1",
        requestId: "request-1",
      }),
    ).toMatchObject({ parentAgentId: "parent-1", subagentId: "child-1" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.update",
        payload: {
          kind: "timeline",
          parentAgentId: "parent-1",
          subagentId: "child-1",
          provider: "claude",
          epoch: "epoch-1",
          seq: 4,
          timestamp: "2026-07-12T10:00:00.000Z",
          item: { type: "assistant_message", text: "Found it." },
        },
      }),
    ).toMatchObject({
      payload: {
        kind: "timeline",
        parentAgentId: "parent-1",
        subagentId: "child-1",
        seq: 4,
      },
    });
  });

  test("accepts a provider child working directory while remaining compatible when absent", () => {
    const descriptor = {
      id: "child-1",
      parentAgentId: "parent-1",
      provider: "opencode",
      title: "Explore",
      description: null,
      status: "running",
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:00:00.000Z",
      toolCallId: null,
    };

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: "request-1",
          parentAgentId: "parent-1",
          subagents: [{ ...descriptor, cwd: "/workspace/child" }],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { subagents: [{ cwd: "/workspace/child" }] } });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: "request-2",
          parentAgentId: "parent-1",
          subagents: [descriptor],
          error: null,
        },
      }),
    ).toMatchObject({ payload: { subagents: [{ id: "child-1" }] } });
  });
});
