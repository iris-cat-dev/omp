import { describe, expect, test } from "vitest";

import { parseToolResult } from "./tool-call-detail.js";
import { mapOmpTodoReminderEvent, mapOmpTodoState, mapOmpTodoToolResult } from "./todo-mapper.js";

const TODO_PHASES = [
  {
    name: "Tasks",
    tasks: [
      { content: "alpha task", status: "completed" },
      { content: "beta task", status: "in_progress" },
      { content: "gamma task", status: "pending" },
    ],
  },
] as const;

describe("OMP todo mapper", () => {
  test("maps todo tool results without losing progress status", () => {
    expect(
      mapOmpTodoToolResult(
        parseToolResult({
          content: [],
          details: {
            phases: [
              {
                name: "Tasks",
                tasks: [
                  { content: "alpha task", status: "in_progress" },
                  { content: "beta task", status: "pending" },
                  { content: "gamma task", status: "pending" },
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        {
          text: "alpha task",
          status: "in_progress",
          completed: false,
          phase: { name: "Tasks", index: 0 },
        },
        {
          text: "beta task",
          status: "pending",
          completed: false,
          phase: { name: "Tasks", index: 0 },
        },
        {
          text: "gamma task",
          status: "pending",
          completed: false,
          phase: { name: "Tasks", index: 0 },
        },
      ],
    });

    expect(
      mapOmpTodoToolResult(parseToolResult({ content: [], details: { phases: TODO_PHASES } })),
    ).toEqual({
      type: "todo",
      items: [
        {
          text: "alpha task",
          status: "completed",
          completed: true,
          phase: { name: "Tasks", index: 0 },
        },
        {
          text: "beta task",
          status: "in_progress",
          completed: false,
          phase: { name: "Tasks", index: 0 },
        },
        {
          text: "gamma task",
          status: "pending",
          completed: false,
          phase: { name: "Tasks", index: 0 },
        },
      ],
    });
  });

  test("maps todo reminder events", () => {
    expect(
      mapOmpTodoReminderEvent({
        type: "todo_reminder",
        todos: [
          { content: "beta task", status: "in_progress" },
          { content: "gamma task", status: "pending" },
        ],
      }),
    ).toEqual({
      type: "todo",
      items: [
        { text: "beta task", status: "in_progress", completed: false },
        { text: "gamma task", status: "pending", completed: false },
      ],
    });
  });

  test("hydrates current todos from session state", () => {
    expect(
      mapOmpTodoState({
        model: null,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        sessionId: "session",
        messageCount: 0,
        queuedMessageCount: 0,
        todoPhases: TODO_PHASES,
      }),
    ).toEqual([
      {
        type: "todo",
        items: [
          {
            text: "alpha task",
            status: "completed",
            completed: true,
            phase: { name: "Tasks", index: 0 },
          },
          {
            text: "beta task",
            status: "in_progress",
            completed: false,
            phase: { name: "Tasks", index: 0 },
          },
          {
            text: "gamma task",
            status: "pending",
            completed: false,
            phase: { name: "Tasks", index: 0 },
          },
        ],
      },
    ]);
  });

  test("keeps distinct same-named phases and the full snapshot across partial reminders", () => {
    const snapshot = mapOmpTodoToolResult({
      details: {
        phases: [
          { name: "Empty", tasks: [] },
          {
            name: "Tasks",
            tasks: [
              { content: "shared", status: "completed" },
              { content: "shared", status: "pending" },
            ],
          },
          {
            name: "Tasks",
            tasks: [
              { content: "blocked", status: "blocked" },
              { content: "shared", status: "pending" },
              { content: "skipped", status: "abandoned" },
            ],
          },
        ],
      },
    });
    expect(snapshot?.type).toBe("todo");
    if (snapshot?.type !== "todo") throw new Error("Missing todo snapshot");
    expect(
      mapOmpTodoReminderEvent(
        {
          type: "todo_reminder",
          todos: [
            { content: "shared", status: "in_progress" },
            { content: "shared", status: "pending" },
          ],
        },
        snapshot.items,
      ),
    ).toEqual({
      type: "todo",
      items: [
        {
          text: "shared",
          status: "completed",
          completed: true,
          phase: { name: "Tasks", index: 0 },
        },
        {
          text: "shared",
          status: "in_progress",
          completed: false,
          phase: { name: "Tasks", index: 0 },
        },
        {
          text: "blocked",
          status: "blocked",
          completed: false,
          phase: { name: "Tasks", index: 1 },
        },
        { text: "shared", status: "pending", completed: false, phase: { name: "Tasks", index: 1 } },
        {
          text: "skipped",
          status: "abandoned",
          completed: false,
          phase: { name: "Tasks", index: 1 },
        },
      ],
    });
  });

  test("preserves an explicit empty todo reset", () => {
    expect(mapOmpTodoToolResult({ details: { phases: [] } })).toEqual({ type: "todo", items: [] });
  });

  test("drops malformed todo inputs", () => {
    expect(mapOmpTodoReminderEvent({ type: "todo_reminder", todos: [{ content: 1 }] })).toBeNull();
    expect(
      mapOmpTodoToolResult({ details: { phases: [{ name: "Bad", tasks: [{}] }] } }),
    ).toBeNull();
  });
});
