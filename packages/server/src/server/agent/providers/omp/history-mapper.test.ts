import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { streamOmpCoreHistory, type OmpCapturedUserMessageEntry } from "./message-history.js";
import type { OmpAgentMessage } from "./rpc-types.js";
import { FakeOmp } from "./test-utils/fake-omp.js";
import { OMP_HISTORY_MAPPER_HOOKS } from "./history-hooks.js";
import { streamOmpHistory } from "./history.js";

async function collectHistory(
  messages: OmpAgentMessage[],
  userEntries: OmpCapturedUserMessageEntry[] = [],
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamOmpCoreHistory(
    "omp",
    messages,
    userEntries,
    OMP_HISTORY_MAPPER_HOOKS,
  )) {
    events.push(event);
  }
  return events;
}

describe("OMP history mapper", () => {
  test("hides injected workflow directives in replayed user messages", async () => {
    const planPrompt = [
      "<system-directive>",
      "Plan mode active for this turn. The working tree and system are read-only: NEVER create, edit, delete, or rename files, and NEVER run state-changing commands. You may inspect with read-only tools. Produce or refine the requested plan only.",
      "</system-directive>",
      "",
      "draft the migration",
    ].join("\n");
    const standardPrompt = [
      "<system-directive>",
      "Plan mode is inactive for this turn. All earlier per-turn Plan mode directives have expired. Follow the current user request normally; working-tree changes are permitted subject to the active tool-approval policy.",
      "</system-directive>",
      "",
      "implement the migration",
    ].join("\n");

    const events = await collectHistory(
      [
        { role: "user", content: planPrompt },
        { role: "user", content: standardPrompt },
      ],
      [
        { id: "entry-plan", text: planPrompt },
        { id: "entry-standard", text: standardPrompt },
      ],
    );

    expect(events.map((event) => event.item)).toEqual([
      { type: "user_message", text: "draft the migration", messageId: "entry-plan" },
      { type: "user_message", text: "implement the migration", messageId: "entry-standard" },
    ]);
  });

  test("coalesces replayed subagent poll calls by target set", async () => {
    const events = await collectHistory([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "poll-1",
            name: "subagent",
            arguments: { poll: ["job-a"] },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "poll-1",
        toolName: "subagent",
        content: [{ type: "text", text: "first poll" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "poll-2",
            name: "subagent",
            arguments: { poll: ["job-a"] },
          },
          {
            type: "toolCall",
            id: "poll-3",
            name: "subagent",
            arguments: { poll: ["job-b"] },
          },
          {
            type: "toolCall",
            id: "spawn-1",
            name: "subagent",
            arguments: { spawn: [{ task: "go" }] },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "poll-2",
        toolName: "subagent",
        content: [{ type: "text", text: "second poll" }],
      },
      {
        role: "toolResult",
        toolCallId: "poll-3",
        toolName: "subagent",
        content: [{ type: "text", text: "other poll" }],
      },
      {
        role: "toolResult",
        toolCallId: "spawn-1",
        toolName: "subagent",
        content: [{ type: "text", text: "spawned" }],
      },
    ]);

    expect(
      events.map((event) => (event.item.type === "tool_call" ? event.item.callId : null)),
    ).toEqual([
      "omp-poll:job-a",
      "omp-poll:job-a",
      "omp-poll:job-a",
      "omp-poll:job-b",
      "spawn-1",
      "omp-poll:job-a",
      "omp-poll:job-b",
      "spawn-1",
    ]);
  });

  test("absorbs replayed omp system-notice custom messages as synthetic tool calls", async () => {
    const notice = [
      "<system-notice>",
      "Background job DocsSmokeTwo has completed. Resume your work using the result below.",
      '<task-result id="DocsSmokeTwo" agent="explore" status="completed" duration="21.6s">',
      "<output>done</output>",
      "</task-result>",
      "</system-notice>",
    ].join("\n");

    await expect(
      collectHistory(
        [
          { role: "user", content: "first prompt" },
          { role: "custom", content: notice },
          { role: "user", content: "second prompt" },
        ],
        [
          { id: "entry-user-1", text: "first prompt" },
          { id: "entry-user-2", text: "second prompt" },
        ],
      ),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-notice:DocsSmokeTwo",
          name: "task_notification",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "Background job DocsSmokeTwo completed",
            text: notice,
            icon: "wrench",
          },
          metadata: {
            synthetic: true,
            source: "omp_system_notice",
            taskId: "DocsSmokeTwo",
            subagentType: "explore",
            status: "completed",
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "user_message",
          text: "second prompt",
          messageId: "entry-user-2",
        },
      },
    ]);
  });

  test("renders replayed IRC messages as synthetic tool-call blocks", async () => {
    const message = [
      "<irc>",
      "Incoming IRC message from agent NativeDefaultApply (reply to 15732a2de67fceec):",
      '<task-result id="NativeDefaultApply" agent="task" status="completed" duration="4.6s">',
      "<output>All assigned changes are submitted.</output>",
      "</task-result>",
      "</irc>",
    ].join("\n");

    const events = await collectHistory([{ role: "custom", content: message }]);

    expect(events).toMatchObject([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: expect.stringMatching(/^omp-irc:[0-9a-f]{12}$/),
          name: "irc_notification",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "NativeDefaultApply completed",
            text: message,
            icon: "bot",
          },
          metadata: {
            synthetic: true,
            source: "omp_irc",
            sender: "NativeDefaultApply",
            taskId: "NativeDefaultApply",
            subagentType: "task",
            status: "completed",
          },
          error: null,
        },
      },
    ]);
  });

  test("renders replayed OMP advisor messages as synthetic tool-call blocks", async () => {
    await expect(
      collectHistory([
        {
          role: "custom",
          content: [
            {
              type: "text",
              text: '<advisory severity="blocker">Add an authorization check.</advisory>',
            },
          ],
          customType: "advisor",
          id: "advisor-message-1",
          display: true,
          details: {
            notes: [
              {
                note: "Add an authorization check.",
                severity: "blocker",
                advisor: "security",
              },
              { note: "Exercise the failure path.", severity: "concern" },
            ],
          },
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "omp-advisor:advisor-message-1",
          name: "advisor",
          status: "completed",
          detail: {
            type: "plain_text",
            label: "Advisor · 2 notes · 1 blocker",
            text: "[blocker] [security] Add an authorization check.\n\n[concern] Exercise the failure path.",
            icon: "brain",
          },
          metadata: {
            synthetic: true,
            source: "omp_advisor",
            noteCount: 2,
            blockerCount: 1,
          },
          error: null,
        },
      },
    ]);
  });

  test("omits replayed hidden and skill prompt custom messages", async () => {
    await expect(
      collectHistory(
        [
          { role: "user", content: "first prompt" },
          { role: "custom", content: "hidden reminder", display: false },
          { role: "custom", content: "expanded skill instructions", customType: "skill-prompt" },
          { role: "custom", content: "visible explicit custom", display: true },
          { role: "custom", content: "visible legacy custom" },
          {
            role: "assistant",
            content: [{ type: "text", text: "assistant reply" }],
            responseId: "assistant-history",
          },
        ],
        [{ id: "entry-user-1", text: "first prompt" }],
      ),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "visible explicit custom" },
      },
      {
        type: "timeline",
        provider: "omp",
        item: { type: "assistant_message", text: "visible legacy custom" },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "assistant_message",
          text: "assistant reply",
          messageId: "assistant-history",
        },
      },
    ]);
  });

  test("replays todo snapshots while suppressing raw todo tool calls", async () => {
    await expect(
      collectHistory([
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "todo-1",
              name: "todo",
              arguments: { op: "view" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "todo-1",
          toolName: "todo",
          content: [{ type: "text", text: "todos" }],
          details: {
            phases: [
              {
                name: "Implementation",
                tasks: [
                  { content: "Locate submit path", status: "completed" },
                  { content: "Add directory check", status: "in_progress" },
                ],
              },
            ],
          },
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "todo",
          items: [
            {
              text: "Locate submit path",
              status: "completed",
              completed: true,
            },
            {
              text: "Add directory check",
              status: "in_progress",
              completed: false,
            },
          ],
        },
      },
    ]);
  });

  test("replays task tool results as static sub-agent details", async () => {
    await expect(
      collectHistory([
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "task-1",
              name: "task",
              arguments: { agent: "explore", description: "Inspect files" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "task-1",
          toolName: "task",
          content: [
            {
              type: "text",
              text: "done\ntranscript: /tmp/omp-task/Explore.jsonl",
            },
          ],
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "task-1",
          name: "task",
          status: "running",
          detail: {
            type: "sub_agent",
            subAgentType: "explore",
            description: "Inspect files",
            log: "",
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "omp",
        item: {
          type: "tool_call",
          callId: "task-1",
          name: "task",
          status: "completed",
          detail: {
            type: "sub_agent",
            subAgentType: "explore",
            description: "Inspect files",
            childSessionId: "/tmp/omp-task/Explore.jsonl",
            log: "done\ntranscript: /tmp/omp-task/Explore.jsonl",
          },
          error: null,
        },
      },
    ]);
  });
  test("replays OMP 17 xd writes as the executed inner tool", async () => {
    const events = await collectHistory([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "xd-write-call",
            name: "write",
            arguments: {
              path: "xd://browser",
              content: '{"action":"open","name":"docs","url":"https://example.com"}',
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "xd-write-call",
        toolName: "write",
        content: [{ type: "text", text: "Opened Example Domain" }],
        details: {
          xdev: {
            tool: "browser",
            mode: "execute",
            args: { action: "open", name: "docs", url: "https://example.com" },
            inner: { action: "open", name: "docs", url: "https://example.com" },
          },
        },
      } as OmpAgentMessage,
    ]);

    expect(events.at(-1)).toMatchObject({
      item: {
        type: "tool_call",
        callId: "xd-write-call",
        name: "browser",
        status: "completed",
        detail: {
          type: "unknown",
          input: { action: "open", name: "docs", url: "https://example.com" },
          output: {
            content: [{ type: "text", text: "Opened Example Domain" }],
            details: {
              action: "open",
              name: "docs",
              url: "https://example.com",
            },
          },
        },
      },
    });
  });

  test("replays screenshot bytes and stable user IDs from disk without a runtime session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-image-history-"));
    const sessionFile = join(dir, "session.jsonl");
    const screenshot = {
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aShoAAAAASUVORK5CYII=",
      mimeType: "image/png",
    };
    const secondImage = {
      data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      mimeType: "image/gif",
    };
    const blobDir = join(dir, "blobs");
    mkdirSync(blobDir);
    const screenshotBytes = Buffer.from(screenshot.data, "base64");
    const hash = createHash("sha256").update(screenshotBytes).digest("hex");
    writeFileSync(join(blobDir, hash), screenshotBytes);
    try {
      writeFileSync(
        sessionFile,
        [
          { type: "session", id: "root", parentId: null },
          {
            type: "message",
            id: "user-text-image",
            parentId: "root",
            message: {
              role: "user",
              content: [
                { type: "text", text: "Compare these screenshots" },
                { type: "image", ...screenshot, data: `blob:sha256:${hash}` },
                { type: "text", text: "Keep the original bytes" },
                { type: "image", ...secondImage },
              ],
            },
          },
          {
            type: "message",
            id: "user-image-only",
            parentId: "user-text-image",
            message: {
              role: "user",
              content: [{ type: "image", ...screenshot, data: `blob:sha256:${hash}` }],
            },
          },
          {
            type: "message",
            id: "user-text-only",
            parentId: "user-image-only",
            message: { role: "user", content: "Continue" },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );

      const events: AgentStreamEvent[] = [];
      for await (const event of streamOmpHistory({ sessionFile, provider: "omp", blobDir })) {
        events.push(event);
      }
      expect(events.flatMap((event) => (event.type === "timeline" ? [event.item] : []))).toEqual([
        {
          type: "user_message",
          text: "Compare these screenshots\n\nKeep the original bytes",
          images: [screenshot, secondImage],
          messageId: "user-text-image",
        },
        {
          type: "user_message",
          text: "",
          images: [screenshot],
          messageId: "user-image-only",
        },
        { type: "user_message", text: "Continue", messageId: "user-text-only" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("maps only the active JSONL chain while hiding internal control records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-history-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      [
        { type: "session", id: "root", parentId: null },
        {
          type: "message",
          id: "user-old",
          parentId: "root",
          message: { role: "user", content: "old branch" },
        },
        {
          type: "message",
          id: "assistant-old",
          parentId: "user-old",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "old answer" }],
          },
        },
        {
          type: "session_init",
          id: "init-active",
          parentId: "root",
          systemPrompt: "must stay hidden",
        },
        {
          type: "message",
          id: "system-active",
          parentId: "init-active",
          message: { role: "system", content: "secret system prompt" },
        },
        {
          type: "message",
          id: "user-active",
          parentId: "system-active",
          message: { role: "user", content: "active branch" },
        },
        {
          type: "compaction",
          id: "compact-active",
          parentId: "user-active",
          timestamp: "2026-08-01T12:00:00.000Z",
          tokensBefore: 1234,
        },
        {
          type: "title",
          id: "title-control",
          parentId: "compact-active",
          title: "Updated title",
        },
        {
          type: "custom",
          customType: "tool_execution_start",
          id: "custom-control",
          parentId: "title-control",
          data: { toolName: "task" },
        },
        {
          type: "tool_execution_start",
          id: "tool-control",
          parentId: "custom-control",
          command: "secret internal command",
        },
        {
          type: "credential_pin",
          id: "credential-control",
          parentId: "tool-control",
          credentialId: "must stay hidden",
        },
        {
          type: "ttsr_injection",
          id: "ttsr-control",
          parentId: "credential-control",
          text: "must stay hidden",
        },
        {
          type: "custom_message",
          id: "custom-message-control",
          parentId: "ttsr-control",
          content: "<system-reminder>must stay hidden</system-reminder>",
        },
        {
          type: "service_tier_change",
          id: "service-tier-control",
          parentId: "custom-message-control",
          serviceTier: "priority",
        },
        {
          type: "future_control",
          id: "unknown-active",
          parentId: "service-tier-control",
          secret: "must not stringify",
        },
        {
          type: "message",
          id: "developer-active",
          parentId: "unknown-active",
          message: { role: "developer", content: "developer note" },
        },
        {
          type: "message",
          id: "assistant-active",
          parentId: "developer-active",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "active answer" }],
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );

    const events: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({
      sessionFile,
      provider: "omp",
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.item)).toEqual([
      { type: "user_message", text: "active branch", messageId: "user-active" },
      { type: "compaction", status: "completed", preTokens: 1234 },
      {
        type: "assistant_message",
        text: "[future_control] Unsupported history record",
      },
      {
        type: "assistant_message",
        text: "active answer",
        messageId: "omp-history-assistant-1",
      },
    ]);
    expect(events[1]).toMatchObject({ timestamp: "2026-08-01T12:00:00.000Z" });

    const omp = new FakeOmp();
    const runtimeSession = await omp.startSession({ cwd: dir });
    runtimeSession.activeBranchEntryId = "assistant-old";
    const selectedEvents: AgentStreamEvent[] = [];
    for await (const event of streamOmpHistory({
      sessionFile,
      runtimeSession,
      provider: "omp",
    })) {
      selectedEvents.push(event);
    }
    expect(
      selectedEvents.flatMap((event) => (event.type === "timeline" ? [event.item] : [])),
    ).toEqual([
      { type: "user_message", text: "old branch", messageId: "user-old" },
      {
        type: "assistant_message",
        text: "old answer",
        messageId: "omp-history-assistant-1",
      },
    ]);
  });

  test.each([{ provider: "openai-codex", modelId: "gpt-5.5" }, { model: "openai-codex/gpt-5.5" }])(
    "rehydrates batch and nested transcripts with child models from %j",
    async (modelEntry) => {
      const dir = mkdtempSync(join(tmpdir(), "omp-subagent-history-"));
      const parentFile = join(dir, "parent.jsonl");
      const parentStem = parentFile.slice(0, -".jsonl".length);
      const echoId = "EchoChild";
      const echoFile = join(parentStem, `${echoId}.jsonl`);
      const failedFile = join(parentStem, "FailedChild.jsonl");
      const abortedFile = join(parentStem, "AbortedChild.jsonl");
      const nestedFile = join(parentStem, echoId, "NestedChild.jsonl");
      mkdirSync(join(parentStem, echoId), { recursive: true });

      const writeEntries = (file: string, entries: object[]): void => {
        writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
      };
      writeEntries(nestedFile, [
        {
          type: "session",
          id: "nested-root",
          parentId: null,
          timestamp: "2026-07-07T03:00:00Z",
        },
        {
          type: "model_change",
          id: "nested-model",
          parentId: "nested-root",
          model: "openai-codex/gpt-5.5",
        },
        {
          type: "message",
          id: "nested-answer",
          parentId: "nested-model",
          timestamp: "2026-07-07T03:00:01Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-5",
            responseModel: "claude-sonnet-5-20260701",
            content: [{ type: "text", text: "Nested answer" }],
          },
        },
        {
          type: "message",
          id: "nested-followup",
          parentId: "nested-answer",
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
        },
      ]);
      writeEntries(echoFile, [
        {
          type: "session",
          id: "echo-root",
          parentId: null,
          timestamp: "2026-07-07T02:00:00Z",
        },
        {
          type: "model_change",
          id: "echo-model",
          parentId: "echo-root",
          timestamp: "2026-07-07T02:00:00.500Z",
          ...modelEntry,
        },
        {
          type: "message",
          id: "echo-answer",
          parentId: "echo-model",
          timestamp: "2026-07-07T02:00:01Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Found it" }],
          },
        },
        {
          type: "message",
          id: "nested-call",
          parentId: "echo-answer",
          timestamp: "2026-07-07T02:00:02Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "nested-task",
                name: "task",
                arguments: { agent: "task" },
              },
            ],
          },
        },
        {
          type: "message",
          id: "nested-result",
          parentId: "nested-call",
          timestamp: "2026-07-07T02:00:03Z",
          message: {
            role: "toolResult",
            toolCallId: "nested-task",
            toolName: "task",
            content: [{ type: "text", text: "nested done" }],
            details: { results: [{ id: "NestedChild", exitCode: 0 }] },
          },
        },
      ]);
      writeEntries(failedFile, [
        {
          type: "session",
          id: "failed-root",
          parentId: null,
          timestamp: "2026-07-07T04:00:00Z",
        },
      ]);
      writeEntries(abortedFile, [
        {
          type: "session",
          id: "aborted-root",
          parentId: null,
          timestamp: 1_752_000_000,
        },
        {
          type: "message",
          id: "aborted-answer",
          parentId: "aborted-root",
          message: {
            role: "assistant",
            content: [],
            provider: "anthropic",
            model: "claude-sonnet-5",
            responseModel: " ",
          },
        },
      ]);
      writeEntries(parentFile, [
        {
          type: "session",
          id: "parent-root",
          parentId: null,
          timestamp: "2026-07-07T01:00:00Z",
        },
        {
          type: "message",
          id: "task-call",
          parentId: "parent-root",
          timestamp: "2026-07-07T01:00:01Z",
          message: {
            role: "assistant",
            provider: "parent-provider",
            model: "parent-model",
            content: [
              {
                type: "toolCall",
                id: "task-1",
                name: "task",
                arguments: { agent: "task", model: "default" },
              },
            ],
          },
        },
        {
          type: "message",
          id: "task-result",
          parentId: "task-call",
          timestamp: "2026-07-07T01:00:02Z",
          message: {
            role: "toolResult",
            toolCallId: "task-1",
            toolName: "task",
            content: [{ type: "text", text: "batch done" }],
            details: {
              results: [
                { id: echoId, agent: "task", exitCode: 0 },
                { id: "FailedChild", exitCode: 2, error: "boom" },
                { id: "AbortedChild", aborted: true },
                { id: "MissingChild", exitCode: 1 },
              ],
            },
          },
        },
      ]);

      const events: AgentStreamEvent[] = [];
      for await (const event of streamOmpHistory({
        sessionFile: parentFile,
        provider: "omp",
      })) {
        events.push(event);
      }
      const subagentEvents = events.flatMap((event) =>
        event.type === "provider_subagent" ? [event.event] : [],
      );
      expect(subagentEvents).toContainEqual({
        type: "timeline",
        id: echoId,
        timestamp: "2026-07-07T02:00:01Z",
        item: {
          type: "assistant_message",
          text: "Found it",
          messageId: "omp-history-assistant-1",
        },
      });
      expect(subagentEvents).toContainEqual(
        expect.objectContaining({
          type: "timeline",
          id: "NestedChild",
          timestamp: "2026-07-07T03:00:01Z",
        }),
      );
      expect(subagentEvents.filter((event) => event.type === "upsert")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: echoId,
            title: "task",
            model: "openai-codex/gpt-5.5",
            status: "running",
            timestamp: "2026-07-07T02:00:00Z",
          }),
          expect.objectContaining({
            id: echoId,
            title: "task",
            model: "openai-codex/gpt-5.5",
            status: "completed",
            timestamp: "2026-07-07T02:00:03Z",
          }),
          expect.objectContaining({ id: "FailedChild", status: "failed", model: null }),
          expect.objectContaining({
            id: "AbortedChild",
            status: "canceled",
            model: "anthropic/claude-sonnet-5",
          }),
          expect.objectContaining({ id: "MissingChild", status: "failed", model: null }),
          expect.objectContaining({
            id: "NestedChild",
            status: "completed",
            model: "anthropic/claude-sonnet-5-20260701",
          }),
        ]),
      );
    },
  );
});
