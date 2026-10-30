// Agent Speed v1.5.0 OMP-only task interpretation (MIT), TASK-PARSERS §§2–6.
import type { MonitorTaskActionKind, MonitorTaskOutcome } from "./task-events.js";
import {
  taskBlocks,
  taskInteger,
  taskLf,
  taskLower,
  taskNumber,
  taskObject,
  taskTrim,
} from "./task-parser-common.js";
import type { TaskObject } from "./task-parser-common.js";
import {
  taskCommandInfo,
  taskCommandText,
  taskMaskedStatus,
  taskParseShell,
  taskShellKind,
} from "./task-parser-shell.js";
import type { TaskCommandInfo, TaskShell } from "./task-parser-shell.js";
export { taskEditHunks } from "./task-parser-edits.js";
export { taskFailures } from "./task-parser-failures.js";
export { taskCommandInfo, taskCommandText, taskMaskedStatus } from "./task-parser-shell.js";

const TOOL_KINDS: Readonly<Record<string, MonitorTaskActionKind>> = {
  read: "read",
  grep: "search",
  search: "search",
  find: "search",
  glob: "search",
  ast_grep: "search",
  lsp: "search",
  edit: "edit",
  write: "edit",
  ast_edit: "edit",
  bash: "command",
  task: "delegate",
  web_search: "web",
  fetch: "web",
  browser: "web",
};
export function taskAnalyze(
  tool: string,
  input: unknown,
  cwd: string | null = null,
): {
  kind: MonitorTaskActionKind;
  info: TaskCommandInfo | null;
  text: string | null;
  shell: TaskShell | null;
} {
  const name = taskLower(tool),
    kind = Object.hasOwn(TOOL_KINDS, name) ? TOOL_KINDS[name] : "other";
  if (kind !== "command") return { kind, info: null, text: null, shell: null };
  const text = taskCommandText(tool, input);
  if (text === null) return { kind, info: null, text, shell: null };
  const shell = taskParseShell(text, cwd),
    refined = taskShellKind(shell, cwd);
  return {
    kind: refined,
    info: refined === "command" ? taskCommandInfo(text, cwd, shell) : null,
    text,
    shell,
  };
}
const PI_EXIT = /^\(?Command exited with code (-?[0-9]+)\)?$/;
export function taskResultText(result: unknown): string {
  const lines = taskLf(taskBlocks(taskObject(result)?.content)).split("\n");
  while (lines.length && !taskTrim(lines.at(-1)!)) lines.pop();
  if (lines.length && PI_EXIT.test(taskTrim(lines.at(-1)!))) lines.pop();
  return lines.join("\n");
}
export interface TaskResultReading {
  outcome: MonitorTaskOutcome;
  state: "done" | "running" | "timeout" | "aborted";
}
function resultExitCode(details: TaskObject | null, lines: string[]): number | null {
  const exitCode = taskInteger(details?.exitCode) ?? taskInteger(details?.exit_code);
  if (exitCode !== null) return exitCode;
  const match = PI_EXIT.exec(lines.at(-1) ?? "");
  return match ? taskNumber(match[1]) : null;
}
function resultState(
  details: TaskObject | null,
  job: TaskObject | null,
  nativeAsync: boolean,
  lines: string[],
): TaskResultReading["state"] {
  const first = lines[0] ?? "",
    last = lines.at(-1) ?? "";
  // Confirmed OMP BashToolDetails (oh-my-pi 3a2758b): a successful background/service start is not a check result.
  if (
    details?.status === "running" ||
    (job && (!nativeAsync || !["completed", "failed", "cancelled"].includes(String(job.state)))) ||
    taskObject(details?.service) ||
    first.startsWith("Command still running (session ") ||
    lines.some((line) => /^Backgrounded as job [A-Za-z0-9_-]+(?:;| \()/.test(line))
  )
    return "running";
  if (
    details?.timedOut === true ||
    lines.slice(-2).some((line) => /^\[?Command timed out.*$/.test(line))
  )
    return "timeout";
  if (
    (nativeAsync && job?.state === "cancelled") ||
    [first, last].some((line) =>
      /^(?:Command aborted.*|Command was terminated.*|Operation aborted.*|Command cancelled.*)$/.test(
        line,
      ),
    )
  )
    return "aborted";
  return "done";
}
function resultFailed(
  value: TaskObject,
  job: TaskObject | null,
  nativeAsync: boolean,
  exitCode: number | null,
): boolean {
  if (exitCode !== null) return exitCode !== 0;
  if (nativeAsync && job?.state === "failed") return true;
  return value.isError === true;
}
function resultReading(
  state: TaskResultReading["state"],
  exitCode: number | null,
  failed: boolean | null,
  t: number,
): TaskResultReading {
  if (state === "done") return { outcome: { exitCode, failed, t }, state };
  return { outcome: { exitCode: state === "timeout" ? exitCode : null, failed: null, t }, state };
}
export function taskReadResult(
  result: unknown,
  t: number,
  text: string | null = null,
  info: TaskCommandInfo | null = null,
  cwd: string | null = null,
): TaskResultReading {
  const value = taskObject(result);
  if (!value) return { outcome: { exitCode: null, failed: null, t }, state: "done" };
  const lines = taskLf(taskBlocks(value.content)).split("\n").map(taskTrim).filter(Boolean),
    details = taskObject(value.details),
    job = taskObject(details?.async);
  let exitCode = resultExitCode(details, lines);
  const nativeAsync = job?.type === "bash" && typeof job.jobId === "string" && !!job.jobId;
  let state = resultState(details, job, nativeAsync, lines),
    failed: boolean | null = resultFailed(value, job, nativeAsync, exitCode);
  if (state === "done" && info) {
    if (info.background) state = "running";
    else if (info.masked) {
      const shown = text === null ? null : taskMaskedStatus(text, taskResultText(value), cwd);
      failed = shown?.failed ?? null;
      if (shown && (shown.exitCode !== null || shown.failed)) exitCode = shown.exitCode;
    }
  }
  return resultReading(state, exitCode, failed, t);
}
