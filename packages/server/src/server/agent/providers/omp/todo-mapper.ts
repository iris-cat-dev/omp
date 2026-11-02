import type { AgentTaskItem, AgentTimelineItem } from "../../agent-sdk-types.js";
import type { OmpSessionState } from "./rpc-types.js";
import type { OmpToolResult } from "./tool-call-detail.js";
import {
  OmpTodoPhaseSchema,
  OmpTodoReminderEventSchema,
  type OmpTodoItem,
  type OmpTodoPhase,
} from "./rpc-types.js";

export function mapOmpTodoToolResult(result: OmpToolResult): AgentTimelineItem | null {
  const details = resultDetails(result);
  const phases = OmpTodoPhaseSchema.array().safeParse(details?.phases);
  return phases.success ? mapOmpTodoPhases(phases.data) : null;
}

export function mapOmpTodoReminderEvent(
  event: unknown,
  previous: readonly AgentTaskItem[] = [],
): AgentTimelineItem | null {
  const parsed = OmpTodoReminderEventSchema.safeParse(event);
  if (!parsed.success) return null;

  // Native reminders contain only actionable tasks, in phase/task source order.
  // Keep the full snapshot so omitted closed/blocked tasks and phase identity survive.
  const items = [...previous];
  let nextIndex = 0;
  for (const todo of parsed.data.todos) {
    const index = previous.findIndex(
      (item, itemIndex) =>
        itemIndex >= nextIndex &&
        item.text === todo.content &&
        !item.completed &&
        item.status !== "completed" &&
        item.status !== "abandoned",
    );
    const task = mapOmpTodoTask(todo);
    if (index === -1) {
      items.push(task);
    } else {
      items[index] = { ...previous[index], ...task };
      nextIndex = index + 1;
    }
  }
  return { type: "todo", items };
}

export function mapOmpTodoState(state: OmpSessionState): AgentTimelineItem[] {
  const phases = OmpTodoPhaseSchema.array().safeParse(state.todoPhases);
  if (!phases.success) {
    return [];
  }
  return [mapOmpTodoPhases(phases.data)];
}

export function mapOmpTodoPhases(phases: readonly OmpTodoPhase[]): AgentTimelineItem {
  const items: AgentTaskItem[] = [];
  let index = 0;
  for (const phase of phases) {
    if (phase.tasks.length === 0) continue;
    const metadata = { name: phase.name, index };
    for (const task of phase.tasks) {
      items.push({ ...mapOmpTodoTask(task), phase: metadata });
    }
    index++;
  }
  return { type: "todo", items };
}

function mapOmpTodoTask(item: OmpTodoItem): AgentTaskItem {
  return {
    text: item.content,
    status: item.status,
    completed: item.status === "completed",
  };
}

function resultDetails(result: OmpToolResult): Record<string, unknown> | null {
  if (typeof result === "string" || result === null) {
    return null;
  }
  return isRecord(result.details) ? result.details : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
