// Agent Speed v1.5.0 task-score projection (MIT), 29dffc4e6fbe1da435071e40781b1571dd45ac22.
// Only derived numeric facts and bounded identifiers cross the sandbox boundary.
export type MonitorTaskState = "none" | "unverified" | "passing" | "failing" | "pending";
export type MonitorTaskForm = "none" | "live" | "resting";
export type MonitorCheckClass = "test" | "build" | "check";
export interface MonitorTaskDimensions {
  V: number;
  C: number;
  R: number;
  E: number;
  K: number;
}
export interface MonitorTaskCounts {
  actions: number;
  counted: number;
  edits: number;
  oscillations: number;
  loopActions: number;
  runs: number;
  failingRuns: number;
  episodes: number;
  recovered: number;
  recoverAttempts: number;
  fixAttempts: number;
  fixFailures: number;
}
export interface MonitorTaskEvaluation {
  state: MonitorTaskState;
  score: number | null;
  shown: number | null;
  dims: MonitorTaskDimensions;
  counts: MonitorTaskCounts;
  firstPassMs: number | null;
  heldV: number | null;
  openFailure: {
    suite: string | null;
    runClass: MonitorCheckClass;
    errors: number;
    peak: number;
    counted: boolean;
    edited: boolean;
  } | null;
  lastPass: { suite: string | null; runClass: MonitorCheckClass; buildOnly: boolean } | null;
}
export interface MonitorPredictionModel {
  calibrated: boolean;
  tasks: number;
}
export interface MonitorTaskPrediction {
  success: number;
  stall: number;
  fixFailure: number | null;
  models: {
    success: MonitorPredictionModel;
    stall: MonitorPredictionModel;
    fix: MonitorPredictionModel;
  };
}
export interface MonitorTaskStatus {
  taskStartMs: number | null;
  result: MonitorTaskEvaluation | null;
  predictions: MonitorTaskPrediction | null;
  form: MonitorTaskForm;
}
export interface MonitorTaskRecord {
  agentId: string;
  day: string;
  ordinal: number;
  startMs: number;
  endMs: number;
  complete: boolean;
  model: string | null;
  effort: string | null;
  state: MonitorTaskState;
  score: number | null;
  dims: MonitorTaskDimensions;
  counts: MonitorTaskCounts;
  firstPassMs: number | null;
  success: boolean;
  stalled: boolean;
  snapshots: number[][];
  fixRows: number[][];
}
export interface OmpMonitorTasks {
  current: Record<string, MonitorTaskStatus>;
  records: MonitorTaskRecord[];
  scanning: boolean;
  limited: boolean;
}
export interface MonitorTaskAggregate {
  tasks: number;
  scoredTasks: number;
  medianScore: number | null;
  lowerQuartile: number | null;
  upperQuartile: number | null;
  histogram: number[];
  successes: number;
  stalls: number;
  fixFailures: number;
  fixAttempts: number;
  recovered: number;
  successRate: number | null;
  stallRate: number | null;
  fixFailureRate: number | null;
  recoverAttempts: number | null;
  timeToFirstPassMs: number | null;
}
