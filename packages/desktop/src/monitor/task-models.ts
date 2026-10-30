// Agent Speed v1.5.0 (MIT), Copyright (c) 2026 zoefix.
// Exact METRICS 6.11 model/comparison port, 29dffc4e6fbe1da435071e40781b1571dd45ac22.
// The complete upstream permission notice is retained in task-score.ts.
import type {
  MonitorTaskAggregate,
  MonitorTaskEvaluation,
  MonitorTaskPrediction,
  MonitorTaskRecord,
} from "./task-types.js";
import { taskEvaluationEvidence, type TaskEvaluationEvidence } from "./task-score-evaluation.js";

export type TaskModelName = "success" | "stall" | "fix";
export interface TaskFittedModel {
  coefficients: readonly number[];
  calibrated: boolean;
  tasks: number;
}
export type TaskFittedModels = Record<TaskModelName, TaskFittedModel>;
type TaskTrainingRecord = Pick<
  MonitorTaskRecord,
  "agentId" | "ordinal" | "startMs" | "endMs" | "complete" | "success" | "snapshots" | "fixRows"
>;
interface TaskTrainingRow {
  x: number[];
  label: number;
  weight: number;
}
const taskPriors: Readonly<Record<TaskModelName, readonly number[]>> = {
  success: [-1.5, 3, -0.5, 1, 1, -2, -1.5, -0.5],
  stall: [-1, -2, 3, 2, 0.8, 0.5],
  fix: [-0.5, 1.5, 1, 1, 1.5, -1],
};
const taskModelNames: readonly TaskModelName[] = ["success", "stall", "fix"];
// Records are immutable derived history snapshots. Reusing one snapshot does not refit 3 models per agent/tick.
const taskModelCache = new WeakMap<readonly TaskTrainingRecord[], TaskFittedModels>();

function taskSigmoid(eta: number): number {
  return 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, eta))));
}

/** The reference's linear predictor: feature products sum first, then the intercept is added. */
export function taskModelProbability(
  coefficients: readonly number[],
  features: readonly number[],
): number {
  let sum = 0;
  for (let index = 0; index < features.length; index++)
    sum += coefficients[index + 1]! * features[index]!;
  return taskSigmoid(coefficients[0]! + sum);
}

function taskFit(rows: readonly TaskTrainingRow[], prior: readonly number[]): number[] {
  const dimension = prior.length;
  const beta = [...prior];
  const gradient = new Float64Array(dimension);
  const hessian = Array.from({ length: dimension }, () => new Float64Array(dimension));
  const lower = Array.from({ length: dimension }, () => new Float64Array(dimension));
  const forward = new Float64Array(dimension);
  const step = new Float64Array(dimension);
  // METRICS requires exactly 25 IRLS steps, without an early stop or an unregularized intercept.
  for (let iteration = 0; iteration < 25; iteration++) {
    for (let index = 0; index < dimension; index++) {
      gradient[index] = 4 * (beta[index]! - prior[index]!);
      hessian[index]!.fill(0);
      hessian[index]![index] = 4;
    }
    for (const row of rows) {
      let eta = 0;
      for (let index = 0; index < dimension; index++) eta += beta[index]! * row.x[index]!;
      const probability = taskSigmoid(eta);
      for (let i = 0; i < dimension; i++) {
        gradient[i] = gradient[i]! + row.weight * (probability - row.label) * row.x[i]!;
        for (let j = 0; j < dimension; j++) {
          hessian[i]![j] =
            hessian[i]![j]! + row.weight * probability * (1 - probability) * row.x[i]! * row.x[j]!;
        }
      }
    }
    // Cholesky, column by column. All reductions use plain left-to-right IEEE 754 additions.
    for (let j = 0; j < dimension; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += lower[j]![k]! * lower[j]![k]!;
      lower[j]![j] = Math.sqrt(hessian[j]![j]! - sum);
      for (let i = j + 1; i < dimension; i++) {
        sum = 0;
        for (let k = 0; k < j; k++) sum += lower[i]![k]! * lower[j]![k]!;
        lower[i]![j] = (hessian[i]![j]! - sum) / lower[j]![j]!;
      }
    }
    for (let i = 0; i < dimension; i++) {
      let sum = 0;
      for (let k = 0; k < i; k++) sum += lower[i]![k]! * forward[k]!;
      forward[i] = (gradient[i]! - sum) / lower[i]![i]!;
    }
    for (let i = dimension - 1; i >= 0; i--) {
      let sum = 0;
      for (let k = i + 1; k < dimension; k++) sum += lower[k]![i]! * step[k]!;
      step[i] = (forward[i]! - sum) / lower[i]![i]!;
    }
    for (let index = 0; index < dimension; index++) beta[index] = beta[index]! - step[index]!;
  }
  return beta;
}

function taskCompareRecords(first: TaskTrainingRecord, last: TaskTrainingRecord): number {
  const time = first.endMs - last.endMs || first.startMs - last.startMs;
  if (time) return time;
  if (first.agentId < last.agentId) return -1;
  if (first.agentId > last.agentId) return 1;
  return first.ordinal - last.ordinal;
}

/** Source-local calibration. This OMP-only projection never mixes another app's history into its models. */
export function calibrateTaskModels(records: readonly TaskTrainingRecord[]): TaskFittedModels {
  const cached = taskModelCache.get(records);
  if (cached) return cached;
  const chosen = records
    .filter((record) => record.complete)
    .sort(taskCompareRecords)
    .slice(-2000);
  const models = {} as TaskFittedModels;
  for (const name of taskModelNames) {
    const rows: TaskTrainingRow[] = [];
    let tasks = 0;
    let positive = 0;
    let negative = 0;
    for (const record of chosen) {
      const taskRows = name === "fix" ? record.fixRows : record.snapshots;
      if (taskRows.length === 0) continue;
      tasks++;
      const weight = 1 / taskRows.length;
      for (const values of taskRows) {
        let label = values[values.length - 1]!;
        let x: number[];
        if (name === "success") {
          label = record.success ? 1 : 0;
          x = [
            1,
            values[1]!,
            values[2]!,
            values[3]!,
            values[4]!,
            values[5]!,
            values[6]!,
            values[7]!,
          ];
        } else if (name === "stall") {
          x = [1, values[4]!, values[5]!, values[6]!, values[2]!, values[7]!];
        } else {
          x = [1, values[0]!, values[1]!, values[2]!, values[3]!, values[4]!];
        }
        rows.push({ x, label, weight });
        if (label === 1) positive += weight;
        else if (label === 0) negative += weight;
      }
    }
    const calibrated = tasks >= 40 && positive >= 5 && negative >= 5;
    models[name] = {
      coefficients: calibrated ? taskFit(rows, taskPriors[name]) : [...taskPriors[name]],
      calibrated,
      tasks,
    };
  }
  taskModelCache.set(records, models);
  return models;
}

/** Kept separate so fixture-specified coefficients and already-calibrated histories use the identical predictor. */
export function predictTaskWithModels(
  evaluation: MonitorTaskEvaluation,
  evidence: TaskEvaluationEvidence,
  models: TaskFittedModels,
): MonitorTaskPrediction | null {
  if (evaluation.score === null) return null;
  const f = evidence.features;
  const fix = evidence.fixFeatures;
  return {
    success: taskModelProbability(models.success.coefficients, [
      f.passing,
      f.failing,
      f.conv,
      f.ig,
      f.loop,
      f.osc,
      f.size,
    ]),
    stall: taskModelProbability(models.stall.coefficients, [
      f.ig,
      f.loop,
      f.osc,
      f.failing,
      f.size,
    ]),
    fixFailure:
      evaluation.state === "failing" && fix
        ? taskModelProbability(models.fix.coefficients, [
            fix.attempts,
            fix.errors,
            fix.trend,
            fix.osc,
            fix.ig,
          ])
        : null,
    models: {
      success: { calibrated: models.success.calibrated, tasks: models.success.tasks },
      stall: { calibrated: models.stall.calibrated, tasks: models.stall.tasks },
      fix: { calibrated: models.fix.calibrated, tasks: models.fix.tasks },
    },
  };
}

export function predictTask(
  evaluation: MonitorTaskEvaluation,
  records: readonly MonitorTaskRecord[],
): MonitorTaskPrediction | null {
  if (evaluation.score === null) return null;
  const evidence = taskEvaluationEvidence(evaluation);
  // A wire DTO does not carry IG or the historical failing-run features; unknown is never manufactured.
  return evidence
    ? predictTaskWithModels(evaluation, evidence, calibrateTaskModels(records))
    : null;
}

/** Self-contained for the sandbox's history module; undefined model selects all, null selects unknown. */
export function aggregateTasks(
  records: readonly MonitorTaskRecord[],
  first = "",
  last = "9999-99-99",
  model?: string | null,
): MonitorTaskAggregate {
  const scores: number[] = [];
  const firstPasses: number[] = [];
  const histogram = Array<number>(10).fill(0);
  const edges = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  let tasks = 0;
  let successes = 0;
  let stalls = 0;
  let fixFailures = 0;
  let fixAttempts = 0;
  let recovered = 0;
  let recoveryAttempts = 0;
  for (const record of records) {
    if (
      !record.complete ||
      record.day < first ||
      record.day > last ||
      (model !== undefined && (record.model || null) !== model)
    )
      continue;
    tasks++;
    if (record.score !== null) {
      scores.push(record.score);
      if (record.success) successes++;
      let bin = 0;
      for (const edge of edges) if (record.score >= edge) bin++;
      histogram[bin] = histogram[bin]! + 1;
    }
    if (record.stalled) stalls++;
    fixFailures += record.counts.fixFailures;
    fixAttempts += record.counts.fixAttempts;
    recovered += record.counts.recovered;
    recoveryAttempts += record.counts.recoverAttempts;
    if (record.firstPassMs !== null) firstPasses.push(record.firstPassMs - record.startMs);
  }
  scores.sort((a, b) => a - b);
  firstPasses.sort((a, b) => a - b);
  const quantile = (values: readonly number[], p: number): number | null => {
    if (!values.length) return null;
    const h = (values.length - 1) * p;
    const index = Math.floor(h);
    const fraction = h - index;
    return fraction === 0
      ? values[index]!
      : values[index]! + fraction * (values[index + 1]! - values[index]!);
  };
  return {
    tasks,
    scoredTasks: scores.length,
    medianScore: quantile(scores, 0.5),
    lowerQuartile: quantile(scores, 0.25),
    upperQuartile: quantile(scores, 0.75),
    histogram,
    successes,
    stalls,
    fixFailures,
    fixAttempts,
    recovered,
    successRate: scores.length ? successes / scores.length : null,
    stallRate: tasks ? stalls / tasks : null,
    fixFailureRate: fixAttempts ? fixFailures / fixAttempts : null,
    recoverAttempts: recovered ? recoveryAttempts / recovered : null,
    timeToFirstPassMs: quantile(firstPasses, 0.5),
  };
}
