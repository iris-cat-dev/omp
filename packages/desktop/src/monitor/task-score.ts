/*!
 * Agent Speed v1.5.0 task scoring, TypeScript OMP-only port.
 * Upstream: https://github.com/zoefix/agent-speed
 * Fixed revision: 29dffc4e6fbe1da435071e40781b1571dd45ac22.
 * Ported from spec/tools/task_score.py and windows/src/AgentSpeed.Core/Tasks/{Model,Prompts}.
 *
 * MIT License
 * Copyright (c) 2026 zoefix
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { MonitorTaskEvent, MonitorTaskModelNote } from "./task-events.js";
import type { MonitorTaskForm, MonitorTaskRecord, MonitorTaskStatus } from "./task-types.js";
import { TaskScoreEvaluation, TaskScoreSource } from "./task-score-evaluation.js";
export { evaluateTask, taskScoreRound } from "./task-score-evaluation.js";
export { aggregateTasks, predictTask } from "./task-models.js";

const taskContinuations = new Set([
  "continue",
  "continue please",
  "please continue",
  "go on",
  "keep going",
  "proceed",
  "please proceed",
  "carry on",
  "go ahead",
  "resume",
  "ok",
  "okay",
  "ok continue",
  "ok go ahead",
  "yes",
  "y",
  "yep",
  "yes please",
  "sure",
  "do it",
  "lgtm",
  "繼續",
  "繼續吧",
  "請繼續",
  "繼續做",
  "接著做",
  "好",
  "好的",
  "好啊",
  "可以",
  "嗯",
  "是",
  "對",
  "行",
  "沒問題",
  "继续",
  "继续吧",
  "请继续",
  "继续做",
  "接着做",
  "对",
  "没问题",
  "続けて",
  "続けてください",
  "続行",
  "進めて",
  "進めてください",
  "はい",
  "お願いします",
  "うん",
  "いいよ",
  "どうぞ",
]);

/** Python str.isspace(), including ASCII separators and deliberately excluding U+FEFF. */
function taskPythonWhitespace(code: number): boolean {
  if (code >= 0x09 && code <= 0x0d) return true;
  if (code >= 0x1c && code <= 0x20) return true;
  if (code >= 0x2000 && code <= 0x200a) return true;
  switch (code) {
    case 0x85:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return true;
    default:
      return false;
  }
}

function taskContinuationText(text: string): string {
  const value = text.normalize("NFKC");
  let start = 0;
  let end = value.length;
  while (start < end && taskPythonWhitespace(value.charCodeAt(start))) start++;
  while (end > start) {
    if (!taskPythonWhitespace(value.charCodeAt(end - 1)) && !".!~,。、".includes(value[end - 1]!))
      break;
    end--;
  }
  let normalized = "";
  let segment = start;
  let index = start;
  while (index < end) {
    const code = value.charCodeAt(index);
    if (taskPythonWhitespace(code)) {
      normalized += value.slice(segment, index) + " ";
      do {
        index++;
      } while (index < end && taskPythonWhitespace(value.charCodeAt(index)));
      segment = index;
    } else if (code >= 0x41 && code <= 0x5a) {
      normalized += value.slice(segment, index) + String.fromCharCode(code + 32);
      index++;
      segment = index;
    } else {
      index++;
    }
  }
  return normalized + value.slice(segment, end);
}

/** NFKC, Python whitespace, ASCII case-folding and precisely the reference's trailing punctuation. */
export function isTaskContinuation(text: string): boolean {
  if (typeof text !== "string") return false;
  return taskContinuations.has(taskContinuationText(text));
}

export function currentTask(
  events: readonly MonitorTaskEvent[],
  nowMs?: number,
): { startMs: number; events: MonitorTaskEvent[] } | null {
  let current: { startMs: number; events: MonitorTaskEvent[] } | null = null;
  for (const event of events) {
    if (nowMs !== undefined && event.t > nowMs) continue;
    if (event.type === "prompt" && !(event.continuation && current)) {
      current = { startMs: event.t, events: [event] };
    } else {
      if (!current) current = { startMs: event.t, events: [] };
      current.events.push(event);
    }
  }
  return current;
}

function taskRecordEndMs(
  events: readonly MonitorTaskEvent[],
  start: number,
  end: number,
): number | null {
  let hasAction = false;
  let endMs = events[start]!.t;
  for (let index = start; index < end; index++) {
    const event = events[index]!;
    endMs = Math.max(endMs, event.t);
    if (event.type === "action") {
      hasAction = true;
      if (event.outcome?.t !== null && event.outcome?.t !== undefined)
        endMs = Math.max(endMs, event.outcome.t);
    }
  }
  return hasAction ? endMs : null;
}

/** Whole-stream history, not the tail-first numeric parser. A prompt-only task still completes its predecessor. */
export function createTaskRecords(
  agentId: string,
  events: readonly MonitorTaskEvent[],
  notes: readonly MonitorTaskModelNote[],
  nowMs: number,
  lastLineMs: number,
): MonitorTaskRecord[] {
  const starts: number[] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (index === 0 || (event.type === "prompt" && !event.continuation)) starts.push(index);
  }
  const records: MonitorTaskRecord[] = [];
  const snapshotsAt = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
  for (let taskIndex = 0; taskIndex < starts.length; taskIndex++) {
    const start = starts[taskIndex]!;
    const end = starts[taskIndex + 1] ?? events.length;
    const endMs = taskRecordEndMs(events, start, end);
    if (endMs === null) continue;
    const source = new TaskScoreSource(events, undefined, start, end);
    const evaluation = new TaskScoreEvaluation(source);
    const result = evaluation.result;
    let model: string | null = null;
    let effort: string | null = null;
    // Notes keep file order even if a clock adjustment made their timestamps non-monotonic.
    for (const note of notes) {
      if (note.t <= endMs) ({ model, effort } = note);
    }
    const snapshots: number[][] = [];
    for (const n of snapshotsAt) {
      if (n > source.counted.length) break;
      const prefix = new TaskScoreEvaluation(source, source.counted[n - 1]!.index + 1);
      if (prefix.result.state === "none") continue;
      const f = prefix.features;
      snapshots.push([
        n,
        f.passing,
        f.failing,
        f.conv,
        f.ig,
        f.loop,
        f.osc,
        f.size,
        evaluation.stallEnds.some((stallEnd) => stallEnd > n) ? 1 : 0,
      ]);
    }
    const fixRows: number[][] = [];
    for (const run of evaluation.runs) {
      if (run.result !== "fail") continue;
      const f = evaluation.fixFeatures.get(run.index)!;
      fixRows.push([
        f.attempts,
        f.errors,
        f.trend,
        f.osc,
        f.ig,
        evaluation.fixLabels.get(run.index)!,
      ]);
    }
    const date = new Date(endMs);
    const day = `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    records.push({
      agentId,
      day,
      ordinal: records.length,
      startMs: events[start]!.t,
      endMs,
      complete: taskIndex < starts.length - 1 || nowMs - lastLineMs >= 30 * 60_000,
      model,
      effort,
      state: result.state,
      score: result.score,
      dims: result.dims,
      counts: result.counts,
      firstPassMs: result.firstPassMs,
      success: result.state === "passing",
      stalled: evaluation.stallEnds.length > 0,
      snapshots,
      fixRows,
    });
  }
  return records;
}

export interface TaskHighestValue {
  form: MonitorTaskForm;
  score: number | null;
  shown: number | null;
  agent: string | null;
}
/** Self-contained for sandbox serialization: live max, else resting max; latest activity and UTF-16 id break ties. */
export function highestTaskValue(
  agents: readonly { id: string; lastLineMs?: number }[],
  values: Readonly<Record<string, Pick<MonitorTaskStatus, "form" | "result">>>,
): TaskHighestValue {
  for (const form of ["live", "resting"] as const) {
    let bestAgent: { id: string; lastLineMs?: number } | null = null;
    let bestScore: number | null = null;
    let bestActivity = 0;
    for (const agent of agents) {
      const value = values[agent.id];
      const score = value?.result?.score;
      if (value?.form !== form || score === null || score === undefined) continue;
      const activity = agent.lastLineMs ?? 0;
      if (
        bestScore === null ||
        score > bestScore ||
        (score === bestScore &&
          (activity > bestActivity || (activity === bestActivity && agent.id < bestAgent!.id)))
      ) {
        bestAgent = agent;
        bestScore = score;
        bestActivity = activity;
      }
    }
    if (bestScore !== null)
      return {
        form,
        score: bestScore,
        shown: bestScore >= 0 ? Math.trunc(bestScore + 0.5) : -Math.trunc(-bestScore + 0.5) || 0,
        agent: bestAgent!.id,
      };
  }
  return { form: "none", score: null, shown: null, agent: null };
}
