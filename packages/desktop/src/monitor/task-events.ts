// Normalized Agent Speed v1.5.0 task stream; source content is reduced to these facts in memory.
export type MonitorTaskActionKind =
  | "other"
  | "read"
  | "search"
  | "edit"
  | "command"
  | "delegate"
  | "web";
export interface MonitorTaskPrompt {
  t: number;
  type: "prompt";
  continuation: boolean;
}
export interface MonitorTaskCommand {
  class: "other" | "check" | "build" | "test";
  suite: string | null;
  targeted: boolean;
  key: string;
}
export interface MonitorTaskOutcome {
  exitCode: number | null;
  failed: boolean | null;
  t: number | null;
}
export interface MonitorTaskFailures {
  fingerprints: string[];
  failedCount: number | null;
  passedCount: number | null;
  framework: string | null;
}
export interface MonitorTaskHunk {
  file: string;
  old: string | null;
  new: string;
}
export interface MonitorTaskAction {
  t: number;
  type: "action";
  kind: MonitorTaskActionKind;
  tool: string;
  digest: string;
  command?: MonitorTaskCommand;
  outcome?: MonitorTaskOutcome;
  failures?: MonitorTaskFailures;
  hunks?: MonitorTaskHunk[];
}
export type MonitorTaskEvent = MonitorTaskPrompt | MonitorTaskAction;
export interface MonitorTaskModelNote {
  t: number;
  model: string | null;
  effort: string | null;
}
