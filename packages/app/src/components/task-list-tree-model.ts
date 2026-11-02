import type { TodoEntry } from "@/types/stream";

export type TaskStatus = NonNullable<TodoEntry["status"]>;

export function getTaskStatus(task: TodoEntry) {
  return task.status ?? (task.completed ? "completed" : "pending");
}

export function isClosedTask(task: TodoEntry) {
  const status = getTaskStatus(task);
  return status === "completed" || status === "abandoned";
}

export interface TaskTreeTask {
  kind: "task";
  id: string;
  task: TodoEntry;
}

export interface TaskTreePhase {
  kind: "phase";
  id: string;
  index: number;
  name: string;
  tasks: TaskTreeTask[];
  closed: number;
  active: boolean;
}

export type TaskTreeNode = TaskTreeTask | TaskTreePhase;

export function buildTaskTree(items: TodoEntry[]) {
  const nodes: TaskTreeNode[] = [];
  const phases = new Map<number, TaskTreePhase>();
  let closed = 0;
  for (const [index, task] of items.entries()) {
    const node: TaskTreeTask = { kind: "task", id: `task:${task.id ?? index}`, task };
    const isClosed = isClosedTask(task);
    closed += Number(isClosed);
    if (!task.phase) {
      nodes.push(node);
      continue;
    }
    let phase = phases.get(task.phase.index);
    if (!phase) {
      phase = {
        kind: "phase",
        id: `phase:${task.phase.index}:${task.phase.name}`,
        index: task.phase.index,
        name: task.phase.name,
        tasks: [],
        closed: 0,
        active: false,
      };
      phases.set(task.phase.index, phase);
      nodes.push(phase);
    }
    phase.tasks.push(node);
    phase.closed += Number(isClosed);
  }
  const phaseNodes = Array.from(phases.values());
  const current =
    phaseNodes.find((phase) =>
      phase.tasks.some(({ task }) => {
        const status = getTaskStatus(task);
        return status === "pending" || status === "in_progress";
      }),
    ) ?? phaseNodes.at(-1);
  if (current) current.active = true;
  return { nodes, phases: phaseNodes, closed };
}
