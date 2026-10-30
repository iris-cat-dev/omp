import { aggregateTasks, highestTaskValue } from "./task-score.js";
import type { MonitorTaskDimensions } from "./task-types.js";

// Agent Speed v1.5.0 (MIT), Copyright (c) 2026 zoefix; 29dffc4e6fbe1da435071e40781b1571dd45ac22.
// The complete upstream permission notice is retained in task-score.ts.
// DESIGN 10/12; task-score prototype and Windows Presentation/TaskScore + History/Tasks.
// This module receives only the monitor's safe numeric DTOs. No log text or reporting APIs.

/** Largest-remainder allocation: displayed dimensions add to the displayed integer score. */
export function taskShownDimensions(
  dims: MonitorTaskDimensions,
  shown: number | null,
): MonitorTaskDimensions {
  const keys = ["V", "C", "R", "E", "K"] as const;
  const values = keys.map((key) => dims[key]);
  const floors = values.map(Math.floor);
  const missing =
    shown === null ? 0 : Math.max(0, shown - floors.reduce((sum, value) => sum + value, 0));
  const order = keys
    .map((_, index) => index)
    .sort((a, b) => values[b]! - floors[b]! - (values[a]! - floors[a]!) || a - b);
  for (let index = 0; index < Math.min(missing, order.length); index++) {
    const chosen = order[index]!;
    floors[chosen] = floors[chosen]! + 1;
  }
  return { V: floors[0]!, C: floors[1]!, R: floors[2]!, E: floors[3]!, K: floors[4]! };
}

/** DESIGN 12 / TaskMetrics.Better: no winner for noise, small samples, unknown or identical shown text. */
export function taskCompareBetter(
  metric: string,
  a: number | null,
  b: number | null,
  scoredA: number,
  scoredB: number,
  shownA: string,
  shownB: string,
): 0 | 1 | 2 {
  if (a === null || b === null || scoredA < 10 || scoredB < 10 || shownA === shownB) return 0;
  const rate = metric === "successRate" || metric === "stallRate" || metric === "fixFailureRate";
  const gap = Math.abs(a - b),
    needed = rate ? 0.01 : 0.05 * Math.max(Math.abs(a), Math.abs(b));
  if (gap === 0 || gap < needed - 1e-12) return 0;
  return (metric === "successRate" ? a > b : a < b) ? 1 : 2;
}

export interface TaskThinkingVisibility {
  hidden: boolean;
  zeroSince: number | null;
  enabled: boolean;
}
/** Quiet never invents zero: keep the last visibility and hold timestamp until the next known sample. */
export function taskThinkingVisibility(
  previous: TaskThinkingVisibility,
  value: number | null,
  enabled: boolean,
  now: number,
): TaskThinkingVisibility {
  if (!enabled) return { hidden: true, zeroSince: null, enabled: false };
  const shownOnEnable = !previous.enabled;
  if (value === null)
    return {
      hidden: shownOnEnable ? false : previous.hidden,
      zeroSince: previous.zeroSince,
      enabled: true,
    };
  if (value >= 0.05) return { hidden: false, zeroSince: null, enabled: true };
  const since = previous.zeroSince === null ? now : previous.zeroSince;
  return { hidden: now - since >= 3000, zeroSince: since, enabled: true };
}

const taskStrings = {
  "phase.idle": ["空闲", "Idle"],
  "agents.context": ["生成中 %d · 工具 %d", "%d generating · %d in tools"],
  "dashboard.agents": ["Agent", "Agents"],
  "time.justNow": ["刚刚", "just now"],
  "time.secondsAgo": ["%d 秒前", "%ds ago"],
  "time.minutesAgo": ["%d 分钟前", "%dm ago"],
  "time.seconds": ["%d 秒", "%d sec"],
  "time.minutes": ["%d 分钟", "%d min"],
  "time.hours": ["%d 小时", "%d hr"],
  "time.hoursMinutes": ["%d 小时 %d 分钟", "%d hr %d min"],
  "intel.glyph": ["智力", "IQ"],
  "intel.thinking.glyph": ["思考", "TH"],
  "a11y.orb.intel.only": ["智力 %@", "intelligence %@"],
  "intel.disclaimer": [
    "任务进展的估算，不是模型能力测试",
    "An estimate of task progress, not a model benchmark",
  ],
  "a11y.orb.intel": [
    "智力 %@，思考每秒 %@ 个 token",
    "intelligence %@, thinking %@ tokens per second",
  ],
  "intel.none": ["智力：暂无评分", "intelligence: no score yet"],
  "agents.intel.hint": [
    "智力是当前任务的评分（0–100）：每个新请求从 0 开始，修改通过测试、错误减少才会上升；检查失败、通过后又修改，或开始打转时会下降。虚线底表示还没有验证；淡色是空闲 agent 的分数。",
    "Intelligence scores the current task from 0 to 100: each new request starts at 0 and climbs as changes pass tests and errors shrink; it drops when a check fails, when code changes after a pass, or when the agent starts going in circles. A dotted underline means not verified yet; dimmed is an idle agent's score.",
  ],
  "a11y.agent.intel": ["智力 %@", "intelligence %@"],
  "work.looping": [
    "原地打转：同一组动作已重复 %d 次，且有失败",
    "Going in circles: the same actions repeated %d times, some failing",
  ],
  "work.repeating": [
    "重复同一组动作 %d 次（没有失败，可能在等待）",
    "Repeating the same actions %d times (no failures, possibly waiting)",
  ],
  "work.summary": ["新动作 %@ · 失败 %d · 已修正 %d", "New actions %@ · failed %d · recovered %d"],
  "task.state.none": ["暂无评分", "No score yet"],
  "task.state.unverified": ["尚未验证", "Not verified"],
  "task.state.failing": ["未通过", "Failing"],
  "task.state.passing": ["已通过", "Passing"],
  "task.state.pending": ["待重新验证", "Re-check pending"],
  "task.unsupported": [
    "这个来源不会记录工具调用，所以无法为任务评分。",
    "This source doesn't record tool calls, so its tasks can't be scored.",
  ],
  "task.check.test": ["测试", "Tests"],
  "task.check.build": ["构建", "Build"],
  "task.check.check": ["检查", "Check"],
  "task.status.none": [
    "还没有修改，也还没有运行测试或构建",
    "No edits yet, and no tests or builds",
  ],
  "task.status.unverified": [
    "已修改，但还没有运行测试、构建或检查",
    "Edited, but nothing has been tested, built or checked yet",
  ],
  "task.status.failing": ["%@：还有 %d 个错误（最多时 %d 个）", "%@: %d errors left (peak %d)"],
  "task.status.failing.noCount": ["%@：没有通过", "%@: failing"],
  "task.status.failing.edited": [
    "%@：失败后已修改，等待重新运行",
    "%@: edited after failing; waiting to run again",
  ],
  "task.status.passing": ["%@：通过，修改已验证", "%@: passed — the changes are verified"],
  "task.status.passing.buildOnly": [
    "%@：通过，但还没有运行测试",
    "%@: passed, but no tests have run",
  ],
  "task.status.pending": [
    "%@：通过后又修改，等待重新运行",
    "%@: edited since it passed; waiting to run again",
  ],
  "task.card.top": ["%d 个 agent 中最高", "Highest of %d agents"],
  "task.card.footnote": [
    "权重是尚未校准的初始值；没有可靠的测试结果，分数不会变高。分数只在这台电脑上计算，不会上报。",
    "Weights are uncalibrated starting values; without reliable test results the score stays low. Scores are computed on this computer and never reported.",
  ],
  "task.dims.title": ["评分构成", "Score breakdown"],
  "task.dim.verify": ["验证成功", "Verification success"],
  "task.dim.verify.desc": [
    "修改通过可靠的检查：测试、构建或检查零失败",
    "The changes pass reliable checks with no failures",
  ],
  "task.dim.converge": ["错误收敛", "Error convergence"],
  "task.dim.converge.desc": [
    "同一个检查重跑时，不同的错误越来越少",
    "Each re-run of a check shows fewer distinct errors",
  ],
  "task.dim.recover": ["错误恢复", "Error recovery"],
  "task.dim.recover.desc": [
    "出错 → 修正 → 通过，尝试次数越少越高",
    "Error → fix → pass; fewer attempts score higher",
  ],
  "task.dim.efficiency": ["行为效率", "Behavior efficiency"],
  "task.dim.efficiency.desc": [
    "每次工具调用都有新收获；打转、重复、来回修改会扣分",
    "Each tool call learns something new; loops, repeats and undone edits lower it",
  ],
  "task.dim.complete": ["验证完整性", "Verification completeness"],
  "task.dim.complete.desc": [
    "最后一次修改后有构建、有测试，针对性修正后重跑全套",
    "After the last edit: built, tested, and the full suite re-run after a targeted fix",
  ],
  "task.predict.title": ["预测", "Predictions"],
  "task.predict.success": ["成功", "Success"],
  "task.predict.stall": ["卡住", "Stall"],
  "task.predict.fixFails": ["修复失败", "Fix fails"],
  "task.predict.cell.calibrated": ["依 %d 个任务", "%d tasks"],
  "task.predict.cell.prior": ["默认值 · %d/%d", "Prior · %d/%d"],
  "task.predict.cell.priorOnly": ["默认值", "Prior"],
  "task.predict.note": [
    "按你在 %@ 的任务记录校准；完成的任务不到 %d 个，或几乎都是同一种结果时，使用默认值。",
    "Calibrated on your own %@ tasks; prior values are used until %d tasks have finished with mixed outcomes.",
  ],
  "task.signals.title": ["行为", "Behavior"],
  "task.signal.oscillation": ["来回修改 %d 次", "Edits undone %d times"],
  "task.tooltip.top": ["智力 %@ · 最高：%@", "Intelligence %@ · top: %@"],
  "a11y.task.unverified": ["%@，尚未验证", "%@, not verified"],
  "a11y.task.pending": ["%@，待重新验证", "%@, re-check pending"],
  "a11y.task.idle": ["%@，空闲中", "%@, idle"],
  "a11y.task.top": ["%@，%d 个 agent 中最高", "%@, the highest of %d agents"],
  "a11y.task.card": ["任务评分详情", "Task score details"],
  "a11y.task.score": ["智力 %@，%@", "intelligence %@, %@"],
  "a11y.task.dim": ["%@ %d 分，满分 %d", "%@: %d of %d"],
  "a11y.task.predict.success": ["成功的概率 %@", "chance of success %@"],
  "a11y.task.predict.stall": ["卡住的概率 %@", "chance of stalling %@"],
  "a11y.task.predict.fixFails": ["修复失败的概率 %@", "chance a fix fails %@"],
  "a11y.task.predict.calibrated": ["%@，按 %d 个任务校准", "%@, calibrated on %d tasks"],
  "a11y.task.predict.prior": ["%@，默认值", "%@, prior value"],
  "a11y.task.below": ["不到 %d%%", "under %d%%"],
  "a11y.task.above": ["超过 %d%%", "over %d%%"],
  "effort.tooltip": ["推理强度：%@", "Reasoning effort: %@"],
  "speed.tooltip": ["加速：%@", "Speed: %@"],
  "speed.value.standard": ["标准", "Standard"],
  "speed.value.fast": ["Fast", "Fast"],
  "speed.value.ultrafast": ["Ultrafast", "Ultrafast"],
  "history.tasks.title": ["任务表现", "Task performance"],
  "history.tasks.info": [
    "智力是 Agent Speed 依工具记录估算的任务评分（0–100）：每个新请求从 0 开始，修改通过测试、错误减少才会上升，没有可靠验证的任务分数偏低。这里比较所选期间结束的任务；项目和任务难度相近时，比较才有意义。",
    "Intelligence is a task score (0–100) that Agent Speed estimates from tool records: each new request starts at 0 and climbs as changes pass tests and errors shrink, and tasks without reliable checks stay low. This compares the tasks that ended in the selected period; comparisons mean most for similar projects and tasks.",
  ],
  "history.tasks.vs": ["vs", "vs"],
  "history.tasks.pickA.a11y": ["比较的第一个模型", "First model to compare"],
  "history.tasks.pickB.a11y": ["比较的第二个模型", "Second model to compare"],
  "history.tasks.counts": ["%d 个已评分 · 共 %d 个任务", "%d scored · %d tasks"],
  "history.tasks.metric.tasks": ["任务", "Tasks"],
  "history.tasks.metric.scored": ["已评分任务", "Scored tasks"],
  "history.tasks.metric.scored.hint": [
    "有修改或有验证、因此有分数的任务。只读代码或聊天的任务没有分数。",
    "Tasks with an edit or a check, and so a score. Tasks that only read code or chat have none.",
  ],
  "history.tasks.metric.scored.short": ["已评分", "Scored"],
  "history.tasks.metric.median": ["中位数分数", "Median score"],
  "history.tasks.metric.median.hint": [
    "已评分任务的最终分数排在正中间的值：一半的任务比它高。",
    "The middle final score of the scored tasks: half of them scored higher.",
  ],
  "history.tasks.metric.median.short": ["中位数", "Median"],
  "history.tasks.metric.success": ["成功率", "Success rate"],
  "history.tasks.metric.success.hint": [
    "已评分的任务中，结束时为“已通过”的比例。",
    "Share of scored tasks that ended passing.",
  ],
  "history.tasks.metric.stall": ["卡住率", "Stall rate"],
  "history.tasks.metric.stall.hint": [
    "所有任务中卡住过的比例：连续 8 个动作几乎没有新发现。",
    "Share of all tasks that stalled: 8 actions in a row with almost nothing new.",
  ],
  "history.tasks.metric.fixFail": ["修复失败率", "Fix-failure rate"],
  "history.tasks.metric.fixFail.hint": [
    "每次检查失败后，下一次运行同一个检查仍然失败（或一直没有修好）的比例。",
    "Share of failing runs whose next run of the same check failed too, or that were never fixed.",
  ],
  "history.tasks.metric.attempts": ["平均恢复尝试", "Mean attempts to recover"],
  "history.tasks.metric.attempts.hint": [
    "修好的错误，平均失败几次才通过。",
    "For errors that got fixed, the average number of failing runs before the pass.",
  ],
  "history.tasks.metric.attempts.short": ["恢复尝试", "Attempts"],
  "history.tasks.metric.firstPass": ["首次通过时间（中位数）", "Median time to first pass"],
  "history.tasks.metric.firstPass.hint": [
    "从任务开始到第一次通过检查的时间，取中位数。",
    "Time from the start of a task to its first passing check, the median over tasks that passed.",
  ],
  "history.tasks.metric.firstPass.short": ["首次通过", "First pass"],
  "history.tasks.lowerBetter": ["越低越好", "Lower is better"],
  "history.tasks.byModel": ["按模型", "By model"],
  "history.tasks.column.model": ["模型", "Model"],
  "history.tasks.column.scoredOfTasks": ["已评分 / 任务", "Scored / tasks"],
  "history.tasks.sample.low": ["样本少", "Few tasks"],
  "history.tasks.sample.hint": [
    "只有 %d 个已评分的任务，数字容易波动；双方都有 %d 个以上才会标出较好的一方。",
    "Only %d scored tasks, so the numbers can swing. A side is marked better only when both have at least %d.",
  ],
  "history.tasks.empty": ["这段期间没有评分的任务", "No scored tasks in this period"],
  "history.tasks.empty.hint": [
    "任务评分需要 OMP 记录工具调用；只读或聊天的任务不产生分数。",
    "Task scores need OMP tool records. Read-only and chat tasks have no score.",
  ],
  "history.tasks.side.empty": ["这段期间没有任务", "No tasks in this period"],
  "history.tasks.onlyOne": ["这段期间只有 %@ 有任务", "Only %@ has tasks in this period"],
  "history.tasks.analyzing": ["正在重新分析过去的任务…", "Re-analyzing past tasks…"],
  "history.tasks.distribution": ["分数分布", "Score distribution"],
  "history.tasks.footnote": [
    "依工具记录估算，不是模型能力测试；权重尚未校准。",
    "Estimated from tool records, not a model benchmark. Weights are not calibrated yet.",
  ],
  "history.tasks.attempts": ["%@ 次", "%@"],
  "history.tasks.rate.scored": ["%d / %d 个已评分的任务", "%d of %d scored tasks"],
  "history.tasks.rate.tasks": ["%d / %d 个任务", "%d of %d tasks"],
  "history.tasks.rate.fixes": ["%d / %d 次失败后的下一次运行", "%d of %d runs after a failure"],
  "history.tasks.model.sources": ["来源：%@", "Sources: %@"],
  "history.tasks.noValue.attempts": [
    "这段期间没有出错后恢复的任务",
    "No task recovered from an error in this period",
  ],
  "history.tasks.noValue.firstPass": [
    "这段期间没有通过检查的任务",
    "No task passed a check in this period",
  ],
  "a11y.history.tasks.side": [
    "%@：%d 个任务，%d 个已评分，中位数 %@",
    "%@: %d tasks, %d scored, median %@",
  ],
  "a11y.history.tasks.distribution": [
    "分数分布：四分之一的任务低于 %@，一半低于 %@，四分之三低于 %@",
    "Score distribution: a quarter of tasks below %@, half below %@, three quarters below %@",
  ],
  "a11y.history.tasks.compare": ["%@：%@ %@，%@ %@", "%@: %@ %@, %@ %@"],
  "a11y.history.tasks.better": ["%@，%@ 较好", "%@, %@ is better"],
  "a11y.history.tasks.lowerBetter": ["%@，越低越好", "%@, lower is better"],
  "a11y.history.tasks.iqr": [
    "中间一半的任务在 %@ 到 %@ 分之间",
    "the middle half of tasks scored %@ to %@",
  ],
  "a11y.board": ["排行看板，%@：每秒 %@ 个 token，%@", "Leaderboard, %@: %@ tokens per second, %@"],
  unknown: ["未知", "Unknown"],
  showScore: ["显示智力（任务评分）", "Show intelligence (task score)"],
  showScoreHint: [
    "独立显示当前任务评分、详情卡和悬浮球读数；任务评分不是模型智商或人工验收结论。",
    "Show current task scores, detail cards and orb readouts independently. This is neither a model IQ test nor human acceptance.",
  ],
  showThinking: ["显示思考速度", "Show thinking speed"],
  showThinkingHint: [
    "按日志中的推理 token 计量；0 保留 3 秒后隐藏，未知不记作 0。",
    "Uses reasoning tokens recorded in logs. Zero holds for 3 seconds before hiding; unknown is not zero.",
  ],
  limited: [
    "任务覆盖有限；统计仅包含已完整分析的记录。",
    "Task coverage is limited; statistics include only completely analyzed records.",
  ],
  scanning: [
    "正在分析任务；当前统计尚未覆盖全部记录。",
    "Analyzing tasks; current statistics do not cover every record yet.",
  ],
  noModel: ["模型未知", "Unknown model"],
  selectedMode: [
    "当前选定的模式；不是服务端已执行的证明。",
    "Selected mode; not proof of server execution.",
  ],
  recordedMode: ["日志记录的执行模式。", "Execution mode recorded in the log."],
  held: ["待重新验证的保留分：%@ / %@", "Held credit awaiting a passing re-run: %@ / %@"],
  counts: [
    "动作 %@ · 有效修改 %@ · 检查 %@ · 失败 %@",
    "Actions %@ · effective edits %@ · checks %@ · failed %@",
  ],
  loops: ["循环中的动作 %@", "Actions in loops %@"],
  recovery: ["已恢复 %@ / %@ · 恢复尝试 %@", "Recovered %@ / %@ · recovery attempts %@"],
  fixes: ["修复失败 %@ / %@", "Fix failures %@ / %@"],
  copy: ["复制模型行", "Copy model row"],
  copied: ["已复制模型行", "Model row copied"],
  copyUnavailable: [
    "无法复制；可选择文本手动复制。",
    "Copy is unavailable; select the text to copy manually.",
  ],
  infoA11y: ["任务表现指标说明", "Task performance metric definitions"],
  singleLabel: [
    "当前只有一个模型有已完成任务。",
    "Only one model has completed tasks in this period.",
  ],
  humanDisclaimer: [
    "任务进展的估算，不是模型智商、模型能力测试或人工验收。",
    "An estimate of task progress, not model IQ, a model benchmark or human acceptance.",
  ],
  close: ["关闭", "Close"],
  score: ["智力", "IQ"],
  thinking: ["思考", "TH"],
} as const;

export const MONITOR_TASK_CSS = String.raw`
body[data-appearance="dark"] .task-theme {
  color-scheme: dark;
  --desk: #121318; --desk-2: #191b22;
  --ink: rgba(255,255,255,.92); --ink-2: rgba(235,235,245,.64); --ink-3: rgba(235,235,245,.36);
  --ink-desc: rgba(235,235,245,.54);
  --line: rgba(255,255,255,.09); --line-2: rgba(255,255,255,.14);
  --fill: rgba(255,255,255,.055); --fill-2: rgba(255,255,255,.1);
  --panel: #2b2b2e; --panel-line: rgba(255,255,255,.1);
  --card-bg: rgba(38,38,42,.9); --card-line: rgba(255,255,255,.12);
  --card-shadow: 0 22px 56px rgba(0,0,0,.55), 0 2px 10px rgba(0,0,0,.35);
  --score: #93A4D6; --track: rgba(255,255,255,.09);
  --pass-ink: #7EE2B8; --pass-bg: rgba(52,211,153,.15);
  --fail-ink: #F7C25C; --fail-bg: rgba(245,165,36,.15);
  --amber: #F5A524;
  --win: #1e1e20; --win-card: rgba(255,255,255,.045); --win-bar: #2a2a2d; --tp-bg: #28282a; --tp-row2: #343436;
  --orb-g1: #1b1e29; --orb-g2: #08090d; --orb-rim: rgba(255,255,255,.14); --led-off: rgba(150,170,210,.13);
  --orb-num: rgba(255,255,255,.78); --orb-unit: rgba(255,255,255,.5); --orb-value: #fff;
  --bar-bg: rgba(28,28,30,.72); --bar-ink: rgba(255,255,255,.92); --bar-ink-2: rgba(255,255,255,.55);
  --tb-bg: rgba(32,32,32,.86); --tb-ink: #fff; --tb-ink-2: rgba(255,255,255,.62);
  --pearl-a: #C7D2FE; --pearl-b: #F5D0FE; --pearl-c: #A5F3FC;
  --board-bg: rgba(16,18,28,.58); --board-line: rgba(255,255,255,.16);
  --b-ink: rgba(244,246,252,.96); --b-ink-2: rgba(232,236,245,.66); --b-ink-3: rgba(226,230,242,.38);
  --focus: #8fb2ff;
}
body[data-appearance="light"] .task-theme {
  color-scheme: light;
  --desk: #e6e8ee; --desk-2: #dde1ea;
  --ink: rgba(0,0,0,.86); --ink-2: rgba(60,60,67,.76); --ink-3: rgba(60,60,67,.4);
  --ink-desc: rgba(60,60,67,.7);
  --line: rgba(0,0,0,.08); --line-2: rgba(0,0,0,.12);
  --fill: rgba(0,0,0,.04); --fill-2: rgba(0,0,0,.075);
  --panel: #f0f0f2; --panel-line: rgba(0,0,0,.09);
  --card-bg: rgba(251,251,253,.92); --card-line: rgba(0,0,0,.09);
  --card-shadow: 0 22px 50px rgba(24,28,44,.2), 0 2px 8px rgba(24,28,44,.1);
  --score: #4B5FA6; --track: rgba(0,0,0,.075);
  --pass-ink: #07724F; --pass-bg: rgba(16,163,112,.12);
  --fail-ink: #9A5400; --fail-bg: rgba(245,158,11,.15);
  --amber: #B86E00;
  --win: #f5f5f7; --win-card: rgba(0,0,0,.035); --win-bar: #ececee; --tp-bg: #ececee; --tp-row2: #e3e3e5;
  --orb-g1: #ffffff; --orb-g2: #dfe3ec; --orb-rim: rgba(0,0,0,.1); --led-off: rgba(40,50,90,.12);
  --orb-num: rgba(11,13,18,.76); --orb-unit: rgba(0,0,0,.5); --orb-value: #0b0d12;
  --bar-bg: rgba(246,246,248,.78); --bar-ink: rgba(0,0,0,.86); --bar-ink-2: rgba(0,0,0,.5);
  --tb-bg: rgba(243,243,243,.9); --tb-ink: #000; --tb-ink-2: rgba(0,0,0,.6);
  --pearl-a: #6D7CF0; --pearl-b: #C05BD9; --pearl-c: #1AA3C4;
  --board-bg: rgba(255,255,255,.56); --board-line: rgba(0,0,0,.08);
  --b-ink: rgba(17,20,30,.94); --b-ink-2: rgba(30,36,52,.66); --b-ink-3: rgba(30,36,52,.42);
  --focus: #2f5bd8;
}
/* ── Proof mark: dotted = unproven ──────────────────────────────────────────────────────── */
/* A dotted underline under the digits: dot d = max(1px, 0.1 × size), pitch 2.4 d, centred 0.22 × size under the
   baseline (line-height 1 puts the baseline ≈ 0.855 em from the top), the number's colour at 70 %. */
.task-pm { position: relative; display: inline-block; line-height: 1; }
.task-pm::after { content: ""; position: absolute; left: 0; right: 0; --d: max(1px, .1em);
  top: calc(1.075em - var(--d) / 2); height: var(--d); pointer-events: none;
  background: color-mix(in srgb, currentColor 70%, transparent);
  -webkit-mask: radial-gradient(circle closest-side, #000 92%, transparent 100%) 0 0 / calc(var(--d) * 2.4) var(--d) space no-repeat;
          mask: radial-gradient(circle closest-side, #000 92%, transparent 100%) 0 0 / calc(var(--d) * 2.4) var(--d) space no-repeat; }
.task-pm.task-pm-new::after { animation: task-pm-in .25s ease-out both; }
@keyframes task-pm-in { from { opacity: 0; } to { opacity: 1; } }

/* ── Orb ───────────────────────────────────────────────────────────────────────────────── */
.task-orb { position: relative; width: var(--S); height: var(--S); flex: none; font-family: var(--ui); }
.task-orb svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.task-orb .task-ln { position: absolute; left: 0; right: 0; text-align: center; line-height: 1; white-space: nowrap; }
.task-orb .task-ln-intel { font-size: var(--p); }
.task-orb .task-ln-think { font-size: var(--t); transition: opacity .25s; }
.task-orb .task-glyph { font-size: .82em; font-weight: 600; color: var(--orb-unit); }
.task-orb .task-ln-intel .task-glyph { margin-right: .2em; }
.task-orb .task-ln-think .task-glyph { margin-right: .16em; }
.task-orb .task-n { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--orb-num); }
.task-orb .task-is-pale .task-n { color: var(--orb-unit); }
.task-orb .task-u { font-size: .82em; font-weight: 500; color: var(--orb-unit); margin-left: .16em; }
.task-orb .task-val { font-family: var(--disp); font-weight: 700; color: var(--orb-value); font-variant-numeric: tabular-nums;
  letter-spacing: -.02em; }
.task-orb .task-unit { font-weight: 500; color: var(--orb-unit); }
/* Effort capsule (shared by board rows and dashboard rows). */
.task-capsule { display: inline-flex; align-items: center; gap: 5px; height: 18px; padding: 0 6px; border-radius: 9px;
  background: var(--fill); box-shadow: inset 0 0 0 .5px var(--line-2); }
.task-capsule .task-meter { display: inline-flex; align-items: flex-end; gap: 1.5px; height: 10px; }
.task-capsule .task-meter i { width: 2.5px; border-radius: .75px; background: var(--ink-3); opacity: .55; }
.task-capsule .task-meter i.task-on { background: var(--ink-2); opacity: 1; }
.task-capsule .task-w { font-size: 11px; font-weight: 500; color: var(--ink-2); }
.task-capsule .task-bolt { color: #F5A524; font-size: 9px; line-height: 1; }
[data-theme="light"] .task-capsule .task-bolt { color: #B86E00; }
/* ── Score card ───────────────────────────────────────────────────────────────────────── */
.task-card { width: 300px; border-radius: 12px; padding: 14px; background: var(--card-bg); color: var(--ink);
  border: .5px solid var(--card-line); box-shadow: var(--card-shadow);
  backdrop-filter: blur(30px) saturate(180%); -webkit-backdrop-filter: blur(30px) saturate(180%); }
.task-card-float { position: absolute; z-index: 20; pointer-events: none; animation: task-card-in .15s ease-out both; }
@keyframes task-card-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }

@keyframes task-fade-in { from { opacity: 0; } to { opacity: 1; } }
.task-c-head { display: flex; align-items: center; gap: 7px; }
.task-c-head .task-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.task-c-head b { font-size: 13px; font-weight: 650; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-c-meta { margin: 3px 0 0 15px; font-size: 11.5px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.task-chip { display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 7px 0 6px; border-radius: 9px; flex: none;
  font-size: 11px; font-weight: 600; letter-spacing: .01em; white-space: nowrap; }
.task-chip svg { flex: none; }
.task-chip-passing { color: var(--pass-ink); background: var(--pass-bg); }
.task-chip-failing { color: var(--fail-ink); background: var(--fail-bg); }
.task-chip-neutral { color: var(--ink-2); box-shadow: none; position: relative; }
.task-chip-neutral::before { content: ""; position: absolute; inset: 0; border-radius: inherit; border: 1px dotted color-mix(in srgb, currentColor 65%, transparent); }
.task-c-score { margin-top: 12px; padding-top: 12px; border-top: .5px solid var(--line); }
.task-c-eyebrow { font-size: 10.5px; font-weight: 600; letter-spacing: .04em; color: var(--ink-2); margin-bottom: 2px; }
.task-c-big { display: flex; align-items: baseline; gap: 4px; }
.task-c-big .task-n { font-family: var(--disp); font-size: 34px; line-height: 1; font-weight: 650; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.task-c-big .task-n.task-is-pale { color: var(--ink-2); }
.task-c-big .task-n.task-is-none { color: var(--ink-3); font-weight: 500; }
.task-c-big .task-of { font-size: 13px; font-weight: 500; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.task-c-status { margin-top: 6px; font-size: 12px; line-height: 1.42; color: var(--ink-2); }
.task-comp { position: relative; display: flex; gap: 2px; height: 6px; margin-top: 10px; border-radius: 3px; overflow: hidden; background: var(--track); }
.task-comp i { display: block; height: 100%; background: var(--score); border-radius: 0; flex: none; }
.task-comp i.task-ghost { background: radial-gradient(circle closest-side, var(--score) 98%, transparent 100%) 0 50% / 4px 3px space no-repeat; opacity: .9; }
.task-c-sec { margin-top: 14px; }
.task-c-sec-t { font-size: 10.5px; font-weight: 650; letter-spacing: .06em; color: var(--ink-3); margin-bottom: 8px; text-transform: uppercase; }
.task-dim { margin-top: 9px; }
.task-dim:first-of-type { margin-top: 0; }
.task-dim-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.task-dim-top b { font-size: 12.5px; font-weight: 650; }
.task-dim-top .task-v { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.task-dim-top .task-v small { font-size: 12px; font-weight: 500; color: var(--ink-3); }
.task-dim-top .task-v.task-is-quiet { font-weight: 500; color: var(--ink-3); font-size: 11.5px; }
.task-dim-top .task-v.task-is-pending { font-weight: 500; color: var(--ink-2); font-size: 11.5px; }
.task-dim .task-bar { position: relative; height: 4px; margin-top: 5px; border-radius: 2px; background: var(--track); overflow: hidden; }
.task-dim .task-bar.task-dotted { background: radial-gradient(circle closest-side, var(--ink-3) 98%, transparent 100%) 0 50% / 5px 3px space no-repeat; }
.task-dim .task-bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: var(--score); }
.task-dim .task-bar i.task-ghost { background: radial-gradient(circle closest-side, var(--score) 98%, transparent 100%) 0 50% / 5px 4px space no-repeat; }
.task-dim p { margin: 3px 0 0; font-size: 10.5px; line-height: 1.36; color: var(--ink-desc); }
.task-pred { display: grid; grid-template-columns: repeat(var(--n, 3), minmax(0, 1fr)); gap: 8px; }
.task-pred > div { padding: 8px 7px 7px 9px; border-radius: 8px; background: var(--fill); min-width: 0; }
.task-pred .task-p { font-family: var(--disp); font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.1; }
.task-pred .task-l { margin-top: 2px; font-size: 11px; color: var(--ink-2); white-space: nowrap; }
.task-pred .task-f { margin-top: 3px; font-size: 10px; line-height: 1.3; color: var(--ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.task-c-note { margin-top: 7px; font-size: 10.5px; line-height: 1.4; color: var(--ink-desc); }
.task-sig { display: flex; gap: 7px; align-items: flex-start; font-size: 11.5px; line-height: 1.4; color: var(--ink-2); margin-top: 5px; }
.task-sig:first-of-type { margin-top: 0; }
.task-sig svg { flex: none; margin-top: 2px; }
.task-sig.task-warn { color: var(--ink); }
.task-sig.task-warn svg { color: var(--amber); }
.task-c-facts { margin-top: 12px; padding-top: 9px; border-top: .5px solid var(--line); font-size: 11px; line-height: 1.5; color: var(--ink-2); }
.task-c-foot { margin-top: 10px; font-size: 10.5px; line-height: 1.45; color: var(--ink-desc); }
.task-c-empty { margin-top: 12px; padding-top: 12px; border-top: .5px solid var(--line); font-size: 12.5px; line-height: 1.5; color: var(--ink-2); }
.task-tp { container: task-performance / inline-size; margin-top: 18px; border-radius: 14px; padding: 16px 18px 14px; background: var(--win-card); }
.task-tp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; row-gap: 8px; }
.task-tp-head h2 { margin: 0; font-size: 15px; font-weight: 650; }
.task-info { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--ink-3);
  color: var(--ink-2); font-size: 10px; font-weight: 700; font-family: var(--disp); background: none; cursor: help; padding: 0; }
.task-picks { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 12px; }
.task-pick { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 7px 0 9px; border-radius: 6px;
  background: var(--card-bg); box-shadow: inset 0 0 0 .5px var(--line-2), 0 1px 1px rgba(0,0,0,.06); color: var(--ink); border: 0; cursor: pointer; }
.task-pick .task-chev { color: var(--ink-3); }
.task-picks .task-vs { color: var(--ink-3); font-size: 11.5px; }
.task-sdot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex: none; }

.task-h2h { display: grid; grid-template-columns: 62px minmax(0, 1fr) 140px minmax(0, 1fr) 62px; column-gap: 10px; margin-top: 16px; align-items: center; }
.task-side { padding-bottom: 14px; display: flex; flex-direction: column; gap: 3px; }
.task-side-a { grid-column: 1 / 3; align-items: flex-end; text-align: right; }
.task-side-b { grid-column: 4 / 6; align-items: flex-start; }
.task-side .task-src { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 650; }
.task-side-a .task-src { flex-direction: row-reverse; }
.task-side .task-cnt { font-size: 11.5px; color: var(--ink-2); font-variant-numeric: tabular-nums; word-break: keep-all; }
.task-side .task-med { display: flex; align-items: flex-end; gap: 12px; margin-top: 6px; }
.task-side-a .task-med { flex-direction: row; }
.task-side .task-med .task-mv { display: flex; flex-direction: column; }
.task-side-a .task-med .task-mv { align-items: flex-end; }
.task-side .task-med .task-mv b { font-family: var(--disp); font-size: 34px; font-weight: 650; line-height: 1; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.task-side .task-med .task-mv span { font-size: 11px; color: var(--ink-2); margin-top: 3px; }
.task-side .task-chip { margin-top: 4px; }
.task-hist { display: block; overflow: visible; }
.task-hist .task-axis { font-size: 8.5px; fill: var(--ink-3); font-family: var(--ui); }
.task-hcenter { grid-column: 3; }
.task-bf-sep { grid-column: 1 / -1; height: .5px; background: var(--line); margin-bottom: 6px; }
.task-bf-v { font-size: 13px; font-variant-numeric: tabular-nums; color: var(--ink-2); font-weight: 450; white-space: nowrap; }
.task-bf-v.task-a { text-align: right; } .task-bf-v.task-b { text-align: left; }
.task-bf-v.task-better { color: var(--ink); font-weight: 650; }
.task-bf-t { position: relative; height: 6px; border-radius: 3px; background: var(--track); }
.task-bf-t i { position: absolute; top: 0; bottom: 0; border-radius: 3px; opacity: .88; }
.task-bf-t.task-a i { right: 0; } .task-bf-t.task-b i { left: 0; }
.task-bf-l { text-align: center; padding: 7px 0; line-height: 1.2; }
.task-bf-l b { display: block; font-size: 12px; line-height: 1.25; font-weight: 550; color: var(--ink); text-wrap: balance; }
.task-bf-l small { display: block; font-size: 10px; color: var(--ink-3); margin-top: 2px; }
.task-bf-l small.task-lb { color: var(--ink-desc); }

.task-tp-models { margin-top: 18px; }
.task-tp-models h3 { margin: 0 0 8px; font-size: 13px; font-weight: 650; }
.task-tbl { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.task-tbl th { font-size: 11px; font-weight: 600; line-height: 1.25; color: var(--ink-2); text-align: right; padding: 6px 8px; vertical-align: bottom;
  border-bottom: .5px solid var(--line-2); }
.task-tbl th:first-child, .task-tbl td:first-child { text-align: left; padding-left: 6px; }
.task-tbl th .task-sort { color: var(--ink-3); margin-left: 2px; }
.task-tbl td { text-align: right; padding: 7px 8px; white-space: nowrap; }
.task-tbl tbody tr:nth-child(even) td { background: var(--fill); }
.task-tbl tbody tr td:first-child { border-radius: 6px 0 0 6px; } .task-tbl tbody tr td:last-child { border-radius: 0 6px 6px 0; }
.task-tbl tr.task-low td { color: var(--ink-2); }
.task-mname { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 2px 7px; min-width: 0; }
.task-tbl .task-mname { max-width: 220px; }
.task-mn-main { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.task-mdots { position: relative; display: inline-block; height: 7px; flex: none; }
.task-mdots i { position: absolute; top: 0; width: 7px; height: 7px; border-radius: 50%; box-shadow: 0 0 0 1px var(--row-bg, transparent); }
.task-tbl tbody tr { --row-bg: var(--tp-bg); }
.task-tbl tbody tr:nth-child(even) { --row-bg: var(--tp-row2); }
.task-mitem { --row-bg: var(--tp-bg); }
.task-mn-extra { display: inline-flex; align-items: center; gap: 6px; }
.task-mname .task-src2 { font-size: 11px; color: var(--ink-3); white-space: nowrap; }
.task-mname span.task-t { white-space: nowrap; font-weight: 550; color: var(--ink); }
.task-mname .task-sdot + span.task-t { margin-left: 0; }
.task-tbl tr.task-low .task-mname span.task-t, .task-mitem.task-low .task-mname span.task-t { color: var(--ink-2); font-weight: 500; }
.task-chip-sm { height: 16px; padding: 0 6px; font-size: 10px; font-weight: 600; border-radius: 8px; color: var(--ink-2); position: relative; }
.task-chip-sm::before { content: ""; position: absolute; inset: 0; border-radius: inherit; border: 1px dotted color-mix(in srgb, currentColor 60%, transparent); }
.task-medcell { display: inline-flex; align-items: center; gap: 8px; justify-content: flex-end; }
.task-iqr { position: relative; width: 48px; height: 4px; border-radius: 2px; background: var(--track); flex: none; }
.task-iqr i { position: absolute; top: 0; bottom: 0; border-radius: 2px; opacity: .55; }
.task-iqr b { position: absolute; top: -2px; width: 2px; height: 8px; border-radius: 1px; background: var(--ink); }
.task-col-merged { display: none; }
.task-tp-foot { margin-top: 12px; font-size: 11px; color: var(--ink-desc); }
.task-tp-compact, .task-mlist { display: none; }

@container task-performance (max-width: 800px) {
  .task-col-sep { display: none; }
  .task-col-merged { display: table-cell; }
  .task-tbl td:first-child { max-width: 160px; }
  .task-tbl .task-mn-extra { flex-basis: 100%; padding-left: 14px; }
  .task-tbl { font-size: 11.5px; }
  .task-tbl th, .task-tbl td { padding-left: 5px; padding-right: 5px; }
  .task-tbl th { min-width: 60px; }
  .task-iqr { width: 36px; }
  .task-h2h { grid-template-columns: 54px minmax(0, 1fr) 132px minmax(0, 1fr) 54px; }
  .task-hist-wide { display: none; }
}
@container task-performance (min-width: 801px) { .task-hist-medium { display: none; } }
@container task-performance (max-width: 560px) {
  .task-h2h, .task-tbl, .task-tp-models h3 + .task-tbl { display: none; }
  .task-tp-compact, .task-mlist { display: block; }
  .task-picks { margin-left: 0; width: 100%; }
  .task-picks .task-pick { flex: 1; justify-content: space-between; min-width: 0; }
  .task-picks .task-pick span.task-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
.task-sumrow { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; }
.task-sum { padding: 10px 10px 8px; border-radius: 10px; background: var(--fill); min-width: 0; }
.task-sum .task-src { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 650; }
.task-sum .task-mv { display: flex; align-items: baseline; gap: 5px; margin-top: 6px; }
.task-sum .task-mv b { font-family: var(--disp); font-size: 26px; font-weight: 650; line-height: 1; font-variant-numeric: tabular-nums; }
.task-sum .task-mv span { font-size: 11px; color: var(--ink-2); }
.task-sum .task-cnt { margin-top: 2px; font-size: 10.5px; line-height: 1.4; color: var(--ink-2); font-variant-numeric: tabular-nums; word-break: keep-all; }
.task-sum svg { margin-top: 6px; width: 100%; height: 26px; }
.task-ctab { display: grid; grid-template-columns: minmax(0, 1fr) 76px 76px; margin-top: 10px; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.task-ctab > div { padding: 7px 0; border-bottom: .5px solid var(--line); }
.task-ctab .task-h { font-size: 10.5px; font-weight: 600; line-height: 1.25; color: var(--ink-2); text-align: right; align-self: end; }
.task-ctab .task-h .task-sdot { width: 6px; height: 6px; margin-right: 4px; vertical-align: 1px; }
.task-ctab .task-lab { line-height: 1.25; }
.task-ctab .task-lab small { display: block; font-size: 10px; color: var(--ink-desc); }
.task-ctab .task-v { text-align: right; color: var(--ink-2); }
.task-ctab .task-v.task-better { color: var(--ink); font-weight: 650; }
.task-mlist { margin-top: 4px; }
.task-mitem { padding: 9px 2px; border-bottom: .5px solid var(--line); }
.task-mitem .task-l1 { display: flex; align-items: center; gap: 7px; font-size: 12.5px; }
.task-mitem .task-l1 .task-t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.task-mitem .task-l1 .task-r { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; font-variant-numeric: tabular-nums; font-weight: 650; }
.task-mitem .task-l2 { margin-top: 3px; font-size: 11px; line-height: 1.45; color: var(--ink-2); font-variant-numeric: tabular-nums; word-break: keep-all; }
.task-mitem.task-low .task-l1 .task-t, .task-mitem.task-low .task-l1 .task-r { color: var(--ink-2); font-weight: 500; }
.task-nw { white-space: nowrap; }
.task-tp-state { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 6px; padding: 22px 12px 18px; }
.task-tp-state .task-gl { color: var(--ink-3); }
.task-tp-state b { font-size: 13px; font-weight: 600; color: var(--ink-2); }
.task-tp-state span { font-size: 11.5px; line-height: 1.45; color: var(--ink-desc); max-width: 340px; }
.task-skel { display: grid; gap: 9px; margin-top: 14px; }
.task-skel i { display: block; height: 8px; border-radius: 4px; background: linear-gradient(90deg, var(--fill-2), var(--fill), var(--fill-2));
  background-size: 200% 100%; animation: task-skel 1.6s ease-in-out infinite; }
@keyframes task-skel { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.task-suite { font-family: var(--mono); font-size: .9em; color: var(--ink); letter-spacing: -.01em; }

.task-theme{--ui:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;--disp:"Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;--mono:"Cascadia Mono",Consolas,monospace;--spring:cubic-bezier(.2,.8,.2,1);font-family:var(--ui);color:var(--ink);font-variant-numeric:tabular-nums}
.task-sr-only{position:absolute!important;clip-path:inset(50%);width:1px;height:1px;overflow:hidden;white-space:pre-wrap}
.task-theme :is(h2,h3,p,dl,dt,dd){margin:0}.task-theme [hidden]{display:none!important}
.task-card{width:300px;max-width:calc(100vw - 16px);border-radius:8px;border-width:1px;padding:14px;max-height:calc(100vh - 16px);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.task-card-float{position:fixed;z-index:120;pointer-events:auto;animation:none;transform:none}
.task-card[data-compact="1"] .task-dim p,.task-card[data-compact="2"] .task-dim p,.task-card[data-compact="2"] .task-c-foot{display:none}
.task-c-head .task-dot{width:7px;height:7px;background:var(--source,#84cc16)}
.task-c-meta{font-size:11px}.task-c-sec{margin-top:12px}.task-dim{margin-top:10px}.task-c-sec-t{font-size:11px}
.task-c-status{max-height:34px;overflow:hidden}.task-c-facts{white-space:pre-line;overflow-wrap:anywhere}.task-c-foot,.task-dim p,.task-c-note{color:var(--ink-desc)}
.task-pred .task-f,.task-pred .task-l{white-space:normal;overflow-wrap:anywhere}.task-pred>div{padding:8px 7px 7px 9px}
.task-score-cell{display:inline-flex;align-items:baseline;justify-content:flex-end;width:max(3ch,24px);min-width:max(3ch,24px);font-size:12px;font-weight:600;line-height:1;overflow:visible;color:var(--text);position:relative}
.task-score-cell[data-form="resting"],.task-score-cell[data-form="none"]{color:var(--tertiary)}.task-score-cell>span:first-child{display:inline-block}
.agent-row[data-task-score="true"]{grid-template-columns:minmax(0,1fr) 24px auto max(3ch,24px) 56px;column-gap:6px}
.agent-row[data-task-score="false"][data-task-mode="true"]{grid-template-columns:minmax(0,1fr) 24px auto 56px;column-gap:6px}
.agent-row .task-score-cell{justify-self:end}.agent-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:6px}.agent-row[data-task-open="true"]{background:var(--subtle);border-radius:6px}
.task-mode-cell{display:inline-flex;justify-content:flex-start;max-width:84px}.task-capsule{vertical-align:middle}.task-capsule .task-bolt{display:inline-flex;position:relative;width:9px;height:10px;color:#F5A524}.task-capsule .task-bolt svg{position:relative;width:9px;height:10px}.task-capsule .task-bolt[data-bolts="2"]{width:15px}.task-capsule .task-bolt[data-bolts="2"] svg:first-child{opacity:.6}.task-capsule .task-bolt[data-bolts="2"] svg+svg{position:absolute;left:6px;top:0}
body[data-appearance="light"] .task-capsule .task-bolt{color:#B86E00}.task-mode-cell .task-capsule{min-height:0}
.task-orb-lines{position:absolute;left:50%;top:50%;width:var(--task-diameter);height:var(--task-diameter);transform:translate(-50%,-50%) scale(var(--as-hover,1));z-index:5;pointer-events:none;transition:transform .2s var(--spring);color:var(--orb-num)}
.task-orb-lines .task-ln{position:absolute;left:0;right:0;line-height:1;white-space:nowrap;text-align:center}
.task-orb-lines .task-ln-intel{font-size:var(--task-p)}.task-orb-lines .task-ln-think{font-size:var(--task-t)}
.task-orb-lines .task-glyph{font-size:.82em;font-weight:600;color:var(--orb-unit)}.task-orb-lines .task-n{font-weight:600;color:var(--orb-num);font-variant-numeric:tabular-nums}.task-orb-lines .task-u{font-size:.82em;font-weight:500;color:var(--orb-unit)}
.task-orb-lines .task-ln-intel .task-glyph{margin-right:.2em}.task-orb-lines .task-ln-think .task-glyph{margin-right:.16em}.task-orb-lines .task-ln-think .task-u{margin-left:.16em}.task-orb-lines .task-is-pale .task-n,.task-orb-lines .task-is-quiet .task-n{color:var(--orb-unit)}
.as-orb-art[data-style="liquid"]>.task-orb-lines{visibility:hidden}
.task-tp{container:task-performance / inline-size;margin-top:20px;background:var(--win-card);border:1px solid var(--line);border-radius:8px;padding:14px 16px 12px;min-width:0}
.task-tp-head h2{font-size:15px}.task-info{min-height:0;height:18px;width:18px}.task-picks{min-width:0;max-width:100%}.task-pick{min-width:0;max-width:200px;padding:0 6px 0 8px;flex:1}.task-pick select{width:100%;max-width:170px;min-width:0;min-height:22px;height:22px;padding:0 18px 0 0;font-size:12px;border:0;background:transparent;box-shadow:none}.task-pick .task-sdot{background:var(--source,#84cc16)}.task-model-b-dot{background:var(--score)!important}.task-only-one{margin-left:auto;color:var(--ink-2);font-size:11.5px}
.task-side .task-src{max-width:100%;overflow-wrap:anywhere}.task-side .task-src .task-t,.task-sum .task-src .task-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.task-side .task-cnt{word-break:normal}.task-side-b .task-src{color:var(--ink)}
.task-h2h{grid-template-columns:64px minmax(0,1fr) 140px minmax(0,1fr) 64px}.task-bf-v{color:var(--ink);min-width:0}.task-bf-v.task-other{color:var(--ink-2)}.task-bf-t i{transition:width .35s var(--spring)}
.task-metric-line{display:contents}.task-single{margin-top:14px}.task-single .task-side{align-items:flex-start;grid-column:auto;text-align:left}.task-single .task-side .task-src{flex-direction:row}.task-single .task-side .task-med{flex-direction:row-reverse}.task-single-row{display:grid;grid-template-columns:180px minmax(0,1fr) 64px;gap:10px;align-items:center;min-height:36px}.task-single-row .task-bf-l{text-align:left}.task-single-row .task-bf-v{text-align:right}
.task-tbl{table-layout:fixed}.task-tbl th,.task-tbl td{min-width:0;padding:6px 5px;overflow-wrap:anywhere}.task-tbl th:first-child{width:23%}.task-tbl th button{padding:0;min-height:0;border:0;background:transparent;font:inherit;line-height:1.25;text-align:right;max-width:100%}.task-tbl th:first-child button{text-align:left}.task-tbl td{white-space:normal}.task-tbl tbody tr{height:30px}.task-tbl tbody tr:hover td,.task-tbl tbody tr:focus-visible td{background:var(--fill-2)}.task-tbl .task-mname{max-width:100%}.task-mn-main{max-width:100%;min-width:0}.task-mn-main>.task-t{overflow:hidden;text-overflow:ellipsis;min-width:0}.task-mitem .task-mname{flex:1}.task-mitem .task-mn-main{max-width:100%}.task-mitem .task-l1{align-items:flex-start}.task-mitem .task-r{flex:none}.task-mitem .task-l2{word-break:normal}.task-mitem .task-nw{white-space:normal}.task-tp-models .task-model-heading{display:flex;align-items:center;gap:8px}.task-model-heading .task-model-sort{margin-left:auto;min-height:24px;height:24px;padding:1px 4px;font-size:11px}.task-model-copy{min-height:24px;height:24px;padding:1px 7px;font-size:11px}
.task-history-info,.task-copy-menu{position:fixed;z-index:130;padding:14px 16px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;background:var(--card-bg);border:1px solid var(--card-line);border-radius:8px;box-shadow:var(--card-shadow);backdrop-filter:blur(30px) saturate(180%);font-size:12px;line-height:1.45}
.task-history-info{width:340px}.task-history-info h2{font-size:13px;font-weight:600;margin:0 24px 8px 0}.task-history-info p,.task-history-info dd{color:var(--ink-desc)}.task-history-info dt{font-weight:600;margin-top:10px}.task-history-info dd{margin-top:2px}.task-history-info p:last-child{margin-top:12px}.task-info-close{float:right;min-height:22px;width:22px;height:22px;border:0;background:transparent;padding:0;font-size:16px}.task-copy-menu{padding:4px}.task-copy-menu button{min-height:28px;border:0;background:transparent;text-align:left;font-size:12px}
.task-skel i{animation:none;background:var(--track)}
@container task-performance (max-width:859px){.task-col-sep{display:none}.task-col-merged{display:table-cell}.task-h2h{grid-template-columns:64px minmax(0,1fr) 120px minmax(0,1fr) 64px}.task-hist-wide{display:none}.task-hist-medium{display:block}.task-tbl .task-mn-extra{flex-basis:100%;padding-left:14px}.task-tbl{font-size:11.5px}.task-tbl th,.task-tbl td{padding-left:4px;padding-right:4px}.task-iqr{width:36px}}
@container task-performance (min-width:860px){.task-hist-medium{display:none}.task-hist-wide{display:block}}
@container task-performance (max-width:599px){.task-h2h,.task-tbl,.task-tp-models h3+.task-tbl{display:none}.task-tp-compact,.task-mlist{display:block}.task-picks{width:100%;margin-left:0}.task-picks .task-pick{max-width:none;flex:1}.task-pick select{max-width:none}.task-ctab{grid-template-columns:minmax(0,1fr) 72px 72px}.task-sum .task-mv b{font-size:24px}.task-single-row{grid-template-columns:minmax(0,1fr) 72px}.task-single-row .task-bf-t{display:none}.task-only-one{margin-left:0;width:100%}.task-single .task-side .task-med{flex-wrap:wrap}}
@container task-performance (width < 330px){.task-ctab{grid-template-columns:minmax(0,1fr) 58px 58px}.task-sumrow{gap:6px}.task-sum{padding:8px 6px}.task-sum .task-src{font-size:11px}}
@media(prefers-reduced-motion:reduce){.task-theme *,.task-theme *::after{animation:none!important;transition:none!important}.task-orb-lines{transition:none}}
body[data-hidden="true"] .task-theme *{animation:none!important;transition:none!important}
@media(prefers-reduced-transparency:reduce){.task-card,.task-history-info,.task-copy-menu{backdrop-filter:none;background:#fff}body[data-appearance="dark"] :is(.task-card,.task-history-info,.task-copy-menu){background:#26272b}}
@media(prefers-contrast:more){.task-theme{--ink-2:var(--secondary);--ink-3:var(--secondary);--ink-desc:var(--secondary);--score:var(--text);--track:color-mix(in srgb,var(--text) 25%,transparent)}.task-pm::after{background:currentColor}.task-card{backdrop-filter:none}.task-chip-passing,.task-chip-failing{background:none;box-shadow:inset 0 0 0 1px currentColor}.task-score-cell[data-form="resting"]{color:var(--secondary)}}
@media(forced-colors:active){.task-theme{--ink:CanvasText;--ink-2:CanvasText;--ink-3:GrayText;--ink-desc:GrayText;--score:Highlight;--track:GrayText;--card-bg:Canvas;--card-line:CanvasText;--fill:Canvas;--fill-2:ButtonFace;--orb-num:CanvasText;--orb-unit:GrayText}.task-card,.task-history-info,.task-copy-menu{background:Canvas;box-shadow:none;backdrop-filter:none}.task-pm::after{background:CanvasText}.task-chip{color:CanvasText;background:none;box-shadow:inset 0 0 0 1px CanvasText}.task-hist rect,.task-iqr i,.task-bf-t i{fill:Highlight!important;background:Highlight!important}.task-sdot,.task-dot{background:CanvasText!important}.task-score-cell{color:CanvasText}.task-score-cell[data-form="resting"],.task-score-cell[data-form="none"]{color:GrayText}}

.agent-row[data-task-score="true"] .task-mode-cell{grid-column:3}.agent-row[data-task-score="true"] .task-score-cell{grid-column:4}.agent-row[data-task-score="true"] .agent-speed{grid-column:5}.agent-row[data-task-score="false"][data-task-mode="true"] .task-mode-cell{grid-column:3}.agent-row[data-task-score="false"][data-task-mode="true"] .agent-speed{grid-column:4}
.task-model-b-dot{background:var(--source,#84cc16)!important}.task-score-value{position:relative;display:inline-block}

`;

export const MONITOR_TASK_MARKUP = String.raw`
<template id="task-ui-markup">
  <div id="task-score-card" class="task-theme task-card task-card-float" role="tooltip" hidden></div>
  <section id="task-performance" class="task-theme task-tp" aria-labelledby="task-performance-title">
    <div class="task-tp-head"><h2 id="task-performance-title"></h2><button id="task-performance-info" class="task-info" type="button" aria-expanded="false" aria-controls="task-history-info">i</button><div id="task-model-picks" class="task-picks"><label class="task-pick"><span class="task-sdot" aria-hidden="true"></span><select id="task-model-a"></select></label><span id="task-model-vs" class="task-vs"></span><label class="task-pick"><span class="task-sdot task-model-b-dot" aria-hidden="true"></span><select id="task-model-b"></select></label></div><span id="task-only-one" class="task-only-one" hidden></span></div>
    <p id="task-coverage-note" class="task-c-note" role="status" hidden></p>
    <div id="task-performance-content"></div><p id="task-performance-footnote" class="task-tp-foot"></p><span id="task-copy-status" class="task-sr-only" role="status" aria-live="polite"></span>
  </section>
  <div id="task-readout-settings">
    <div class="settings-card"><span class="symbol" aria-hidden="true">&#xE9D9;</span><div><h2 id="task-score-setting-label"></h2><p id="task-score-setting-hint"></p></div><label class="toggle"><input id="show-task-score" type="checkbox" aria-labelledby="task-score-setting-label" aria-describedby="task-score-setting-hint"><span class="toggle-track" aria-hidden="true"></span></label></div>
    <div class="settings-card"><span class="symbol" aria-hidden="true">&#xEA80;</span><div><h2 id="task-thinking-setting-label"></h2><p id="task-thinking-setting-hint"></p></div><label class="toggle"><input id="show-thinking" type="checkbox" checked aria-labelledby="task-thinking-setting-label" aria-describedby="task-thinking-setting-hint"><span class="toggle-track" aria-hidden="true"></span></label></div>
  </div>
  <div id="task-history-info" class="task-theme task-history-info" role="dialog" aria-modal="false" aria-labelledby="task-info-title" hidden><button id="task-info-close" class="task-info-close" type="button">×</button><h2 id="task-info-title"></h2><p id="task-info-intro"></p><dl id="task-info-definitions"></dl><p id="task-info-disclaimer"></p></div>
  <div id="task-copy-menu" class="task-theme task-copy-menu" role="menu" hidden><button id="task-copy-row" role="menuitem" type="button"></button></div>
</template>
`;

export const MONITOR_TASK_SCRIPT =
  `const taskStrings = ${JSON.stringify(taskStrings).replace(/</g, "\\u003c")};\n` +
  `const taskAggregateTasks = ${aggregateTasks.toString()};\n` +
  `const taskHighestTaskValue = ${highestTaskValue.toString()};\n` +
  `const taskShownDimensions = ${taskShownDimensions.toString()};\n` +
  `const taskCompareBetter = ${taskCompareBetter.toString()};\n` +
  `const taskThinkingVisibility = ${taskThinkingVisibility.toString()};\n` +
  String.raw`
const taskSvgNamespace = 'http://www.w3.org/2000/svg';
const taskMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const taskContrastQuery = window.matchMedia('(prefers-contrast: more)');
const taskForcedColorsQuery = window.matchMedia('(forced-colors: active)');
const taskUnknownModel = '\u0000unknown-model';
const taskDimensions = [
  {id:'V',max:40,key:'task.dim.verify'}, {id:'C',max:25,key:'task.dim.converge'},
  {id:'R',max:15,key:'task.dim.recover'}, {id:'E',max:10,key:'task.dim.efficiency'},
  {id:'K',max:10,key:'task.dim.complete'}
];
const taskMetrics = [
  {id:'successRate',key:'history.tasks.metric.success',lower:false},
  {id:'stallRate',key:'history.tasks.metric.stall',lower:true},
  {id:'fixFailureRate',key:'history.tasks.metric.fixFail',lower:true},
  {id:'recoverAttempts',key:'history.tasks.metric.attempts',short:'history.tasks.metric.attempts.short',lower:true},
  {id:'timeToFirstPassMs',key:'history.tasks.metric.firstPass',short:'history.tasks.metric.firstPass.short',lower:true}
];
const taskListeners = [], taskEffects = new Set(), taskNumberAnimations = new Map(), taskRowValues = new Map(), taskReadouts = new Map();
let taskBound = false, taskDestroyed = false, taskSnapshot = null, taskCardView = null, taskCardState = null;
let taskHoverTimer = null, taskHideTimer = null, taskWakeTimer = null, taskRaf = 0, taskLastRaf = 0, taskScopeKey = '', taskLastPeak = null;
let taskPointerX = null, taskPointerY = null, taskHoverDismissed = false;
let taskHistoryKey = '', taskHistoryModels = [], taskPickedA = null, taskPickedB = null, taskModelSort = 'tasks', taskModelDescending = true, taskCopyModel = null;
let taskDescriptionSerial = 0, taskMeasurement = null;
function taskT(key, ...args) {
  const entry = taskStrings[key]; let index = 0;
  const source = entry ? entry[language === 'zh' ? 0 : 1] : key;
  return source.replace(/%(%|@|d)/g, (all, token) => token === '%' ? '%' : String(args[index++]));
}
function taskText(element, value) { const next = String(value); if (element.textContent !== next) element.textContent = next; }
function taskElement(tag, className, value) { const element = document.createElement(tag); if (className) element.className = className; if (value !== undefined) taskText(element, value); return element; }
function taskSvg(tag, attrs) { const element = document.createElementNS(taskSvgNamespace, tag); for (const [name, value] of Object.entries(attrs || {})) element.setAttribute(name, String(value)); return element; }
function taskNumber(value, digits = 0) { return value === null || value === undefined ? '–' : number(value, digits); }
function taskRound(value) { return value === null || value === undefined ? null : Math.floor(value + .5); }
function taskProbability(value) { if (value === null || value === undefined) return '–'; const rounded = Math.floor(value * 100 + .5); return rounded < 1 ? '<1%' : rounded > 99 ? '>99%' : rounded + '%'; }
function taskDuration(ms) {
  if (ms === null || ms === undefined) return '–';
  const seconds = Math.floor(ms / 1000 + .5); if (seconds < 60) return taskT('time.seconds', seconds);
  const minutes = Math.floor(ms / 60000 + .5); if (minutes < 60) return taskT('time.minutes', minutes);
  return minutes % 60 ? taskT('time.hoursMinutes', Math.floor(minutes / 60), minutes % 60) : taskT('time.hours', minutes / 60);
}
function taskSpeed(value) {
  if (value === null || value === undefined) return '–';
  if (value < .05) return '0'; if (value < 10) return value.toFixed(1);
  if (value < 1000) return String(Math.floor(value + .5)); if (value < 10000) return (value / 1000).toFixed(2) + 'k';
  if (value < 100000) return (value / 1000).toFixed(1) + 'k'; return Math.floor(value / 1000 + .5) + 'k';
}
function taskScoresEnabled() { return !!view && (view.surface === 'board' ? !!view.board && view.board.showTaskScore !== false : view.preferences.showTaskScore === true); }
function taskFacts() { return snapshotFacts(); }
function taskStatus(id) { const snapshot = taskFacts(); return snapshot && snapshot.tasks ? snapshot.tasks.current[id] || null : null; }
function taskAgent(id) { const snapshot = taskFacts(); return snapshot ? snapshot.agents.find(agent => agent.id === id) || null : null; }
function taskScoreWords(status, count = 0) {
  const result = status && status.result; if (!result || result.shown === null) return taskT('intel.none');
  let words = String(result.shown);
  if (result.state === 'unverified') words = taskT('a11y.task.unverified', words);
  else if (result.state === 'pending') words = taskT('a11y.task.pending', words);
  if (status.form === 'resting') words = taskT('a11y.task.idle', words);
  if (count >= 2) words = taskT('a11y.task.top', words, count);
  return words;
}
function taskCheckName(check) { return check ? check.suite || taskT('task.check.' + check.runClass) : taskT('task.check.check'); }
function taskStatusText(result) {
  if (!result) return taskT('task.status.none');
  const check = result.openFailure || result.lastPass;
  if (result.state === 'none' || result.state === 'unverified') return taskT('task.status.' + result.state);
  if (result.state === 'pending') return taskT('task.status.pending', taskCheckName(result.lastPass));
  if (result.state === 'passing') return taskT('task.status.passing' + (result.lastPass && result.lastPass.buildOnly ? '.buildOnly' : ''), taskCheckName(check));
  if (result.openFailure && result.openFailure.edited) return taskT('task.status.failing.edited', taskCheckName(check));
  return result.openFailure && result.openFailure.counted ? taskT('task.status.failing', taskCheckName(check), result.openFailure.errors, result.openFailure.peak) : taskT('task.status.failing.noCount', taskCheckName(check));
}
function taskModeText(mode) {
  if (!mode) return '';
  const token = taskStrings['speed.value.' + mode.value] ? taskT('speed.value.' + mode.value) : mode.value;
  return taskT('speed.tooltip', token) + (mode.provider ? ' · ' + mode.provider : '') + '\n' + taskT(mode.evidence === 'recorded' ? 'recordedMode' : 'selectedMode');
}
function taskCardFacts(agent, status, extra) {
  const lines = [], result = status && status.result;
  if (agent.speedMode) lines.push(taskModeText(agent.speedMode));
  if (extra && extra.length) lines.push(...extra.filter(line => typeof line === 'string'));
  else {
    lines.push((language === 'zh' ? '配置：' : 'Profile: ') + agent.profile);
    const rate = finite(agent.liveMeasuredTps) !== null || finite(agent.liveEstimatedTps) !== null ? (finite(agent.liveMeasuredTps) || 0) + (finite(agent.liveEstimatedTps) || 0) : null;
    lines.push((language === 'zh' ? '输出：' : 'Output: ') + taskSpeed(rate) + ' tok/s · TTFT: ' + (finite(agent.ttftMs) === null ? taskT('unknown') : number(agent.ttftMs / 1000, 2) + ' s'));
    lines.push(timestamp(agent.lastActivityAt));
  }
  if (result) {
    const c = result.counts;
    lines.push(taskT('counts', taskNumber(c.actions), taskNumber(c.edits), taskNumber(c.runs), taskNumber(c.failingRuns)));
    if (c.episodes || c.recovered || c.recoverAttempts) lines.push(taskT('recovery', taskNumber(c.recovered), taskNumber(c.episodes), taskNumber(c.recoverAttempts)));
    if (c.fixAttempts) lines.push(taskT('fixes', taskNumber(c.fixFailures), taskNumber(c.fixAttempts)));
    if (result.firstPassMs !== null) {
      const elapsed = status.taskStartMs !== null && result.firstPassMs >= status.taskStartMs ? result.firstPassMs - status.taskStartMs : null;
      lines.push(taskT('history.tasks.metric.firstPass.short') + ': ' + taskDuration(elapsed));
    }
    if (result.state === 'pending' && result.heldV !== null) lines.push(taskT('held', taskNumber(result.heldV), 40));
  }
  return lines;
}
function taskPredictionFlag(model) {
  if (model.calibrated) return taskT('task.predict.cell.calibrated', taskNumber(model.tasks));
  return model.tasks < 40 ? taskT('task.predict.cell.prior', taskNumber(model.tasks), 40) : taskT('task.predict.cell.priorOnly');
}
function taskPredictionEntries(status) {
  const p = status && status.predictions, result = status && status.result;
  if (!p || !result || result.shown === null || status.form !== 'live') return [];
  const entries = [{key:'success',value:p.success,model:p.models.success}, {key:'stall',value:p.stall,model:p.models.stall}];
  if (result.state === 'failing' && p.fixFailure !== null) entries.push({key:'fixFails',value:p.fixFailure,model:p.models.fix});
  return entries;
}
function taskCardDescription(agent, status, options = {}) {
  const result = status && status.result, dims = result ? taskShownDimensions(result.dims, result.shown) : null;
  const parts = [taskScoreWords(status, options.topCount || 0), taskStatusText(result)];
  for (const dim of taskDimensions) {
    const unknown = !result || result.state === 'none' || result.state === 'unverified' && dim.id !== 'E';
    let value = unknown ? dim.id === 'E' && (!result || result.state === 'none') ? '–' : taskT('task.state.unverified') : taskNumber(dims[dim.id]) + ' / ' + dim.max;
    if (result && result.state === 'pending' && dim.id === 'V') value = taskT('task.state.pending') + ' · ' + taskT('held', taskNumber(result.heldV), dim.max);
    parts.push(taskT(dim.key) + ': ' + value + '. ' + taskT(dim.key + '.desc'));
  }
  for (const entry of taskPredictionEntries(status)) {
    const base = taskT('a11y.task.predict.' + entry.key, taskProbability(entry.value));
    parts.push(entry.model.calibrated ? taskT('a11y.task.predict.calibrated', base, entry.model.tasks) : taskT('a11y.task.predict.prior', base) + ' · N=' + entry.model.tasks);
  }
  if (result && result.counts.loopActions) parts.push(taskT('loops', result.counts.loopActions));
  if (result && result.counts.oscillations) parts.push(taskT('task.signal.oscillation', result.counts.oscillations));
  parts.push(...taskCardFacts(agent, status, options.facts), taskT('task.card.footnote'), taskT('humanDisclaimer'));
  return parts.join('\n');
}
function taskListen(target, event, handler, options) { target.addEventListener(event, handler, options); taskListeners.push(() => target.removeEventListener(event, handler, options)); }
function taskReduced() { return taskMotionQuery.matches || !!view && view.preferences.effects === 'off'; }
function taskAnimate(element, keyframes, options, finished) {
  if (typeof element.animate !== 'function' || document.hidden || element.closest('[hidden]')) { if(finished)finished(); return; }
  const effect = element.animate(keyframes, options); taskEffects.add(effect);
  effect.onfinish = () => { taskEffects.delete(effect); if(finished)finished(); effect.cancel(); };
  effect.oncancel = () => { taskEffects.delete(effect); if(finished)finished(); };
  return effect;
}
function taskScheduleAnimation() { if (!taskDestroyed && !document.hidden && !taskRaf) taskRaf = requestAnimationFrame(taskAnimationTick); }
function taskRollDigits(element,previous,value){
  const before=String(previous),after=String(value);
  if(before.length!==after.length){taskText(element,after);taskAnimate(element,[{opacity:0},{opacity:1}],{duration:120});return;}
  const fragment=document.createDocumentFragment();
  for(let index=0;index<after.length;index++){
    if(before[index]===after[index]){fragment.append(document.createTextNode(after[index]));continue;}
    const clip=taskElement('span'),fresh=taskElement('span','',after[index]),old=taskElement('span','',before[index]);
    clip.style.cssText='display:inline-block;position:relative;overflow:hidden;height:1em;line-height:1;vertical-align:top';
    fresh.style.display='inline-block';old.style.cssText='position:absolute;inset:0';old.setAttribute('aria-hidden','true');clip.append(fresh,old);fragment.append(clip);
    taskAnimate(old,[{transform:'translateY(0)',opacity:1},{transform:'translateY(-.92em)',opacity:0}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'},()=>old.remove());
    taskAnimate(fresh,[{transform:'translateY(.92em)',opacity:0,filter:'blur(1.4px)'},{transform:'translateY(0)',opacity:1,filter:'blur(0)'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
  }
  element.replaceChildren(fragment);
}
function taskAnimateScore(element, value, surface, same = true) {
  const previous = element.taskScoreValue;
  if (previous === value) { if(!element.textContent)taskText(element,value===null?'–':value); return; }
  const running = taskNumberAnimations.get(element);
  if (running) taskNumberAnimations.delete(element);
  element.taskScoreValue = value;
  if (value === null) { taskText(element, '–'); return; }
  if (!same || previous === undefined || previous === null || document.hidden) { taskText(element, value); return; }
  if (!taskReduced() && value - previous >= 3 && surface !== 'row') {
    taskNumberAnimations.set(element, {from:previous,to:value,start:performance.now(),duration:Math.min(800,300+12*(value-previous)),surface});
    taskText(element, previous); taskScheduleAnimation(); return;
  }
  if (surface === 'row' && !taskReduced() && value - previous >= 3) taskRollDigits(element,previous,value);
  else { taskText(element, value); if (value < previous || taskReduced()) taskAnimate(element, [{opacity:0},{opacity:1}], {duration:taskReduced()?150:200}); }
}
function taskSetProof(element, result, form) { element.classList.toggle('task-pm', !!result && (result.state === 'unverified' || result.state === 'pending') && result.shown !== null); element.classList.toggle('task-is-pale', form === 'resting'); element.classList.toggle('task-is-none', !result || result.shown === null); }
function createTaskScoreCell(agent) {
  const cell = taskElement('span','task-score-cell task-theme'), digits = taskElement('span','task-score-value'), description = taskElement('span','task-sr-only task-score-description');
  cell.dataset.taskAgentId = agent.id; cell.dataset.taskCardHost = 'dashboard'; description.id = 'task-score-description-' + (++taskDescriptionSerial);
  cell.append(digits, description); taskUpdateScoreCell(cell, agent); return cell;
}
function taskUpdateScoreCell(cell, agent) {
  const status = taskStatus(agent.id), result = status && status.result, value = result ? result.shown : null;
  const enabled = taskScoresEnabled(); cell.hidden = !enabled; cell.dataset.form = result && result.shown !== null ? status.form : 'none';
  const digits = cell.firstElementChild, previous = taskRowValues.get(agent.id);
  if (digits.taskScoreValue === undefined && previous !== undefined) digits.taskScoreValue = previous;
  taskSetProof(digits, result, status ? status.form : 'none'); taskAnimateScore(digits, value, 'row'); taskRowValues.set(agent.id, value);
  const row = cell.closest('.agent-row');
  if (row) {
    row.dataset.taskScore = String(enabled); row.dataset.taskMode = String(!!row.querySelector('.task-mode-cell:not([hidden])'));
    const modeCell = row.querySelector('.task-mode-cell'); if (modeCell) modeCell.hidden = !modeCell.firstElementChild;
    if (enabled) {
      row.dataset.taskAgentId = agent.id; row.dataset.taskCardHost = 'dashboard'; row.tabIndex = 0;
      if (row.title) { row.taskOriginalTitle = row.title; row.title = ''; }
      const summary = taskCardDescription(agent, status); taskText(cell.lastElementChild, summary); row.setAttribute('aria-describedby', cell.lastElementChild.id);
      row.setAttribute('aria-label', (agent.project || agent.name || agent.id) + ' · ' + (agent.model || taskT('unknown')) + ' · ' + taskT('intel.glyph') + ' ' + taskScoreWords(status));
    } else {
      delete row.dataset.taskAgentId; delete row.dataset.taskCardHost; row.removeAttribute('aria-describedby'); row.removeAttribute('aria-label'); row.removeAttribute('tabindex');
      if (row.taskOriginalTitle) row.title = row.taskOriginalTitle;
    }
  }
}
function createModeCell(agent) {
  const cell = taskElement('span','task-mode-cell task-theme'), mode = agent.speedMode;
  cell.title = taskModeText(mode); if (mode) { cell.dataset.mode = mode.value; cell.dataset.evidence = mode.evidence; }
  const bolts = mode && mode.value === 'ultrafast' ? 2 : mode && mode.value === 'fast' ? 1 : 0;
  if (!bolts) { cell.hidden = true; return cell; }
  const capsule = taskElement('span','task-capsule'), bolt = taskElement('span','task-bolt'); bolt.dataset.bolts = String(bolts); bolt.setAttribute('aria-hidden','true');
  for (let index=0;index<bolts;index++) { const svg = taskSvg('svg',{width:9,height:10,viewBox:'0 0 8 10'}); svg.append(taskSvg('path',{d:'M4.8 0L.6 5.6h2.8L2.6 10l4.8-6H4.5z',fill:'currentColor'})); bolt.append(svg); }
  capsule.append(bolt); capsule.setAttribute('aria-label', cell.title.replace(/\n/g, ' ')); cell.append(capsule); return cell;
}
function taskBuildCardView() {
  const card = node('task-score-card'); if (!card) return null;
  const head = taskElement('div','task-c-head'), dot = taskElement('span','task-dot'), project = taskElement('b'), chip = taskElement('span','task-chip'); head.append(dot,project,chip);
  const meta = taskElement('div','task-c-meta'), score = taskElement('div','task-c-score'), eyebrow = taskElement('div','task-c-eyebrow'), big = taskElement('div','task-c-big'), digits = taskElement('span','task-n task-score-value'), of = taskElement('span','task-of','/100'), status = taskElement('div','task-c-status'), composition = taskElement('div','task-comp'); composition.setAttribute('aria-hidden','true'); big.append(digits,of); score.append(eyebrow,big,status,composition);
  const dimensions = taskElement('div','task-c-sec'), dimTitle = taskElement('div','task-c-sec-t'); dimensions.append(dimTitle); const rows=[];
  for (const dimension of taskDimensions) {
    const row=taskElement('div','task-dim'), top=taskElement('div','task-dim-top'), label=taskElement('b'), value=taskElement('span','task-v'), bar=taskElement('div','task-bar'), fill=taskElement('i'), meaning=taskElement('p'), segment=taskElement('i');
    top.append(label,value);bar.append(fill);row.append(top,bar,meaning);dimensions.append(row);composition.append(segment);rows.push({dimension,row,label,value,bar,fill,meaning,segment});
  }
  const predictions=taskElement('div','task-c-sec'), predictTitle=taskElement('div','task-c-sec-t'), cells=taskElement('div','task-pred'), predictionNote=taskElement('div','task-c-note'); predictions.append(predictTitle,cells,predictionNote);
  const signals=taskElement('div','task-c-sec'), signalTitle=taskElement('div','task-c-sec-t'), signalLines=taskElement('div'), facts=taskElement('div','task-c-facts'), footnote=taskElement('div','task-c-foot'); signals.append(signalTitle,signalLines);
  card.replaceChildren(head,meta,score,dimensions,predictions,signals,facts,footnote);
  return {card,project,chip,meta,eyebrow,digits,status,rows,dimTitle,predictions,predictTitle,cells,predictionNote,signals,signalTitle,signalLines,facts,footnote,lastChip:null,lastPredictions:'',lastSignals:'',lastSignature:''};
}
function taskChipIcon(state) {
  const svg=taskSvg('svg',{width:10,height:10,viewBox:'0 0 10 10','aria-hidden':'true'});
  if (state==='passing') {svg.append(taskSvg('circle',{cx:5,cy:5,r:5,fill:'currentColor',opacity:.22}),taskSvg('path',{d:'M2.8 5.2l1.5 1.5 3-3.3',fill:'none',stroke:'currentColor','stroke-width':1.4,'stroke-linecap':'round','stroke-linejoin':'round'}));}
  else {svg.append(taskSvg('circle',{cx:5,cy:5,r:4,fill:'none',stroke:'currentColor','stroke-width':1.2,...(state==='failing'?{}:{'stroke-dasharray':'0 2.5','stroke-linecap':'round'})})); if(state==='pending')svg.append(taskSvg('path',{d:'M5 3v2.2l1.4.9',fill:'none',stroke:'currentColor','stroke-width':1.1,'stroke-linecap':'round'}));if(state==='failing')svg.append(taskSvg('path',{d:'M5 2.5v3M5 7.5v.1',fill:'none',stroke:'currentColor','stroke-width':1.4,'stroke-linecap':'round'}));}
  return svg;
}
function taskUpdateCard(same = true) {
  if (!taskCardState) return;
  const agent=taskAgent(taskCardState.id);if(!agent){taskHideCard();return;}
  const status=taskStatus(agent.id),result=status&&status.result,state=result?result.state:'none',form=status?status.form:'none',refs=taskCardView||(taskCardView=taskBuildCardView());if(!refs)return;
  const options=taskCardState.options, signature=JSON.stringify([language,agent,status,options.topCount,options.facts]);
  if(signature===refs.lastSignature&&same){taskPositionCard();return;}refs.lastSignature=signature;
  taskText(refs.project,agent.project||agent.name||agent.id);refs.project.title=refs.project.textContent;taskText(refs.meta,(agent.model||taskT('unknown'))+' · OMP');
  const chipKey=language+':'+state;if(refs.lastChip!==chipKey){refs.chip.className='task-chip '+(state==='passing'?'task-chip-passing':state==='failing'?'task-chip-failing':'task-chip-neutral');refs.chip.replaceChildren(taskChipIcon(state),taskElement('span','',taskT('task.state.'+state)));refs.lastChip=chipKey;}
  taskText(refs.eyebrow,[form==='resting'?taskT('phase.idle'):'',options.topCount>=2?taskT('task.card.top',options.topCount):''].filter(Boolean).join(' · '));refs.eyebrow.hidden=!refs.eyebrow.textContent;
  taskSetProof(refs.digits,result,form);taskAnimateScore(refs.digits,result?result.shown:null,'card',same);taskText(refs.dimTitle,taskT('task.dims.title'));
  const statusText=taskStatusText(result),check=result&&(result.openFailure||result.lastPass),suite=check&&check.suite;
  if(refs.status.taskStatusText!==statusText){refs.status.taskStatusText=statusText;const index=suite?statusText.indexOf(suite):-1;if(index<0)taskText(refs.status,statusText);else refs.status.replaceChildren(document.createTextNode(statusText.slice(0,index)),taskElement('span','task-suite',suite),document.createTextNode(statusText.slice(index+suite.length)));}
  const shown=result?taskShownDimensions(result.dims,result.shown):null;let left=0;
  for(const row of refs.rows){const d=row.dimension,unknown=!result||state==='none'||state==='unverified'&&d.id!=='E',pending=state==='pending'&&d.id==='V';
    taskText(row.label,taskT(d.key));taskText(row.meaning,taskT(d.key+'.desc'));row.value.className='task-v'+(unknown?' task-is-quiet':pending?' task-is-pending':'');
    if(unknown)taskText(row.value,d.id==='E'&&state==='none'?'–':taskT('task.state.unverified'));else if(pending)taskText(row.value,taskT('task.state.pending'));else{const next=taskNumber(shown[d.id])+' / '+d.max;taskText(row.value,next);}
    row.bar.classList.toggle('task-dotted',unknown);row.fill.hidden=unknown;row.fill.classList.toggle('task-ghost',pending);
    const raw=result?result.dims[d.id]:0,held=pending&&result.heldV!==null?result.heldV:raw;row.fill.style.width=Math.min(100,held/d.max*100)+'%';
    const segment=pending?held:raw;row.segment.hidden=!segment;row.segment.classList.toggle('task-ghost',pending);row.segment.style.position='absolute';row.segment.style.left=left+'%';row.segment.style.width='max(0px, calc('+segment+'% - 2px))';left+=segment;
    row.row.setAttribute('role','group');row.row.setAttribute('aria-label',taskT(d.key)+': '+row.value.textContent+'. '+taskT(d.key+'.desc'));
  }
  const entries=taskPredictionEntries(status);refs.predictions.hidden=!entries.length;taskText(refs.predictTitle,taskT('task.predict.title'));taskText(refs.predictionNote,taskT('task.predict.note','OMP',40));
  const predictionsKey=JSON.stringify([language,entries]);if(predictionsKey!==refs.lastPredictions){refs.lastPredictions=predictionsKey;refs.cells.style.setProperty('--n',entries.length);const fragment=document.createDocumentFragment();for(const entry of entries){const item=taskElement('div'),probability=taskElement('div','task-p',taskProbability(entry.value)),label=taskElement('div','task-l',taskT('task.predict.'+entry.key)),flag=taskElement('div','task-f'+(entry.model.calibrated?'':' task-is-prior'),taskPredictionFlag(entry.model));item.append(probability,label,flag);item.title=taskPredictionFlag(entry.model)+' · N='+entry.model.tasks;const base=taskT('a11y.task.predict.'+entry.key,taskProbability(entry.value));item.setAttribute('role','group');item.setAttribute('aria-label',entry.model.calibrated?taskT('a11y.task.predict.calibrated',base,entry.model.tasks):taskT('a11y.task.predict.prior',base)+' · N='+entry.model.tasks);fragment.append(item);}refs.cells.replaceChildren(fragment);}
  taskText(refs.signalTitle,taskT('task.signals.title'));const signals=[];if(result&&result.counts.loopActions)signals.push({text:taskT('loops',result.counts.loopActions),warn:true});if(result&&result.counts.oscillations)signals.push({text:taskT('task.signal.oscillation',result.counts.oscillations),warn:false});
  const signalsKey=JSON.stringify([language,signals]);if(signalsKey!==refs.lastSignals){refs.lastSignals=signalsKey;refs.signalLines.replaceChildren(...signals.map(line=>{const row=taskElement('div','task-sig'+(line.warn?' task-warn':'')),icon=taskSvg('svg',{width:12,height:12,viewBox:'0 0 12 12','aria-hidden':'true'});icon.append(taskSvg('path',{d:line.warn?'M2.2 5.2A3.9 3.9 0 0 1 9.3 3.4M9.8 6.8a3.9 3.9 0 0 1-7.1 1.8M9.8 1.4v2.4H7.4M2.2 10.6V8.2h2.4':'M1.5 4h9M8 1.5L10.5 4 8 6.5M10.5 8h-9M4 5.5L1.5 8 4 10.5',fill:'none',stroke:'currentColor','stroke-width':1.2,'stroke-linecap':'round','stroke-linejoin':'round'}));row.append(icon,taskElement('span','',line.text));return row;}));}refs.signals.hidden=!signals.length;
  taskText(refs.facts,taskCardFacts(agent,status,options.facts).join('\n'));taskText(refs.footnote,taskT('task.card.footnote')+' '+taskT('humanDisclaimer'));
  refs.card.setAttribute('aria-label',taskCardDescription(agent,status,options));taskPositionCard();
}
function taskPositionCard() {
  if(!taskCardState||!taskCardView)return;const card=taskCardView.card,anchor=taskCardState.anchor;if(!anchor||!anchor.isConnected||anchor.closest('[hidden]')){taskHideCard();return;}
  const rect=anchor.getBoundingClientRect(),width=Math.min(300,Math.max(0,window.innerWidth-16));card.style.width=width+'px';card.dataset.compact='0';
  const maxHeight=Math.max(0,window.innerHeight-16);if(card.scrollHeight>maxHeight)card.dataset.compact='1';if(card.scrollHeight>maxHeight)card.dataset.compact='2';
  const rightRoom=window.innerWidth-rect.right,leftRoom=rect.left;let left=leftRoom>=rightRoom?rect.left-width-8:rect.right+8;
  card.style.left=Math.max(8,Math.min(window.innerWidth-width-8,left))+'px';card.style.top=Math.max(8,Math.min(window.innerHeight-Math.min(card.scrollHeight,maxHeight)-8,rect.top))+'px';
}
function taskShowCard(agentId,anchor,options = {}) {
  if(taskDestroyed||document.hidden||!anchor||!taskAgent(agentId))return;
  clearTimeout(taskHoverTimer);clearTimeout(taskHideTimer);taskHoverTimer=taskHideTimer=null;
  const same=!!taskCardState&&taskCardState.id===agentId,previous=taskCardState;
  if(previous&&previous.anchor!==anchor){delete previous.anchor.dataset.taskOpen;previous.anchor.setAttribute('aria-expanded','false');}
  taskCardState={id:agentId,anchor,options:{topCount:options.topCount||0,facts:options.facts||[]},keyboard:!!options.keyboard};
  taskCardView=taskCardView||taskBuildCardView();if(!taskCardView)return;taskCardView.card.hidden=false;taskCardView.card.dataset.taskCardOpen='true';taskCardView.card.scrollTop=same?taskCardView.card.scrollTop:0;
  anchor.dataset.taskOpen='true';anchor.setAttribute('aria-expanded','true');taskUpdateCard(same);
  if(!same)taskAnimate(taskCardView.card,[{opacity:0,transform:taskReduced()?'none':'translateY(2px)'},{opacity:1,transform:'none'}],{duration:previous?120:150,easing:'ease-out'});
}
function taskHideCard() {
  clearTimeout(taskHoverTimer);clearTimeout(taskHideTimer);taskHoverTimer=taskHideTimer=null;
  if(taskCardState&&taskCardState.anchor){delete taskCardState.anchor.dataset.taskOpen;taskCardState.anchor.setAttribute('aria-expanded','false');}
  taskCardState=null;if(taskCardView){taskCardView.card.hidden=true;delete taskCardView.card.dataset.taskCardOpen;taskNumberAnimations.delete(taskCardView.digits);for(const effect of taskEffects){if(effect.effect&&effect.effect.target&&taskCardView.card.contains(effect.effect.target)){effect.cancel();taskEffects.delete(effect);}}}
}
function taskAnchor(element) {if(!(element instanceof Element))return null;return element.closest('.agent-row[data-task-agent-id]')||element.closest('[data-task-agent-id]');}
function taskOptions(anchor,keyboard=false){return{topCount:Number(anchor.dataset.taskTopN)||0,facts:Array.isArray(anchor.boardTaskFacts)?anchor.boardTaskFacts:[],keyboard};}
function taskNotePointer(event){const moved=taskPointerX!==event.clientX||taskPointerY!==event.clientY;taskPointerX=event.clientX;taskPointerY=event.clientY;if(moved)taskHoverDismissed=false;return moved;}
function taskQueueCard(anchor,keyboard=false){clearTimeout(taskHoverTimer);clearTimeout(taskHideTimer);taskHideTimer=null;if(taskCardState){taskShowCard(anchor.dataset.taskAgentId,anchor,taskOptions(anchor,keyboard));return;}taskHoverTimer=setTimeout(()=>{taskHoverTimer=null;if(anchor.isConnected)taskShowCard(anchor.dataset.taskAgentId,anchor,taskOptions(anchor,keyboard));},keyboard?0:anchor.dataset.taskCardHost==='board'?350:450);}

function taskModelKey(model) {return model===null?taskUnknownModel:'model:'+model;}
function taskModelName(model) {return model===null?taskT('noModel'):model;}
function taskMetricRaw(metric,stats) {return stats&&stats.tasks?stats[metric.id]:null;}
function taskMetricText(metric,value) {if(value===null||value===undefined)return '–';if(metric.id==='recoverAttempts')return taskT('history.tasks.attempts',number(value,1));if(metric.id==='timeToFirstPassMs')return taskDuration(value);return Math.floor(value*100+.5)+'%';}
function taskMetricTip(metric,stats) {
  if(!stats||!stats.tasks)return taskT('history.tasks.side.empty');const value=taskMetricRaw(metric,stats);
  if(metric.id==='successRate')return stats.scoredTasks?taskT('history.tasks.rate.scored',stats.successes,stats.scoredTasks):taskT('history.tasks.metric.scored.hint');
  if(metric.id==='stallRate')return taskT('history.tasks.rate.tasks',stats.stalls,stats.tasks);
  if(metric.id==='fixFailureRate')return stats.fixAttempts?taskT('history.tasks.rate.fixes',stats.fixFailures,stats.fixAttempts):taskT('history.tasks.metric.fixFail.hint');
  if(metric.id==='recoverAttempts'&&value===null)return taskT('history.tasks.noValue.attempts');
  if(metric.id==='timeToFirstPassMs'&&value===null)return taskT('history.tasks.noValue.firstPass');return taskT(metric.key+'.hint');
}
function taskLowChip(stats) {const chip=taskElement('span','task-chip task-chip-sm',taskT('history.tasks.sample.low'));chip.title=taskT('history.tasks.sample.hint',stats.scoredTasks,10);return chip;}
function taskModelDot() {const dot=taskElement('span','task-sdot');dot.style.background='var(--source,#84cc16)';dot.setAttribute('aria-hidden','true');return dot;}
function taskSourceName(item) {const label=taskElement('span','task-src');label.append(taskModelDot(),taskElement('span','task-t',item.name));return label;}
function taskHistogram(stats,width=120,height=38,className='') {
  const svg=taskSvg('svg',{class:'task-hist '+className,width,height,viewBox:'0 0 '+width+' '+height,role:'img'}),plot=height-10,gap=2,barWidth=(width-9*gap)/10,maximum=Math.max(1,...stats.histogram),medianBin=stats.medianScore===null?-1:Math.min(9,Math.floor(stats.medianScore/10));
  svg.setAttribute('aria-label',stats.medianScore===null?taskT('history.tasks.side.empty'):taskT('a11y.history.tasks.distribution',taskNumber(taskRound(stats.lowerQuartile)),taskNumber(taskRound(stats.medianScore)),taskNumber(taskRound(stats.upperQuartile))));
  svg.append(taskSvg('line',{x1:0,x2:width,y1:plot+.5,y2:plot+.5,stroke:'var(--line-2)'}));
  for(let index=0;index<10;index++){const count=stats.histogram[index],barHeight=count?Math.max(1.5,count/maximum*plot):0;svg.append(taskSvg('rect',{x:index*(barWidth+gap),y:plot-barHeight,width:barWidth,height:barHeight,rx:1.5,fill:'var(--source,#84cc16)',opacity:index===medianBin?1:.7}));}
  if(stats.medianScore!==null){const x=stats.medianScore/100*width;svg.append(taskSvg('line',{x1:x,x2:x,y1:-2,y2:plot+1,stroke:'var(--ink)','stroke-width':1}));}
  const low=taskSvg('text',{class:'task-axis',x:0,y:height}),high=taskSvg('text',{class:'task-axis',x:width,y:height,'text-anchor':'end'});low.textContent='0';high.textContent='100';svg.append(low,high);return svg;
}
function taskSide(item,which,compact=false) {
  const stats=item.stats,root=taskElement('div',compact?'task-sum':'task-side task-side-'+which);root.setAttribute('role','group');root.append(taskSourceName(item));
  root.setAttribute('aria-label',stats.tasks?taskT('a11y.history.tasks.side',item.name,stats.tasks,stats.scoredTasks,taskNumber(taskRound(stats.medianScore))):item.name+' · '+taskT('history.tasks.side.empty'));
  if(!stats.tasks){root.append(taskElement('span','task-cnt',taskT('history.tasks.side.empty')));return root;}
  const counts=taskElement('span','task-cnt',taskT('history.tasks.counts',stats.scoredTasks,stats.tasks)),value=taskElement('span','task-mv');value.append(taskElement('b','',taskNumber(taskRound(stats.medianScore))),taskElement('span','',taskT('history.tasks.metric.median.short')));
  if(compact){root.append(value,counts);if(stats.scoredTasks<10)counts.append(document.createTextNode(' '),taskLowChip(stats));root.append(taskHistogram(stats,150,36));}
  else{root.append(counts);if(stats.scoredTasks<10)root.append(taskLowChip(stats));const median=taskElement('div','task-med'),hist=taskElement('span');hist.append(taskHistogram(stats,120,38,'task-hist-wide'),taskHistogram(stats,96,38,'task-hist-medium'));if(which==='a')median.append(hist,value);else median.append(value,hist);root.append(median);}
  return root;
}
function taskMetricScale(metric,a,b){if(['successRate','stallRate','fixFailureRate'].includes(metric.id))return 1;return Math.max(metric.id==='recoverAttempts'?3:300000,Math.max(a||0,b||0)*1.25);}
function taskCompareRow(metric,a,b,compact=false){
  const va=taskMetricRaw(metric,a.stats),vb=taskMetricRaw(metric,b.stats),ta=taskMetricText(metric,va),tb=taskMetricText(metric,vb),win=taskCompareBetter(metric.id,va,vb,a.stats.scoredTasks,b.stats.scoredTasks,ta,tb),scale=taskMetricScale(metric,va,vb);
  const title=taskT(metric.key),words=taskT('a11y.history.tasks.compare',metric.lower?taskT('a11y.history.tasks.lowerBetter',title):title,a.name,ta,b.name,tb),spoken=win?taskT('a11y.history.tasks.better',words,win===1?a.name:b.name):words;
  const label=taskElement('div',compact?'task-lab':'task-bf-l');label.title=taskT(metric.key+'.hint');label.setAttribute('role','group');label.setAttribute('aria-label',spoken);label.append(taskElement(compact?'span':'b','',title));if(metric.lower)label.append(taskElement('small',compact?'':'task-lb',taskT('history.tasks.lowerBetter')));
  const value=(text,stats,side,index)=>{const cell=taskElement('div',(compact?'task-v':'task-bf-v '+side)+(win===index?' task-better':win?' task-other':''),text);cell.title=taskMetricTip(metric,stats);cell.setAttribute('aria-hidden','true');return cell;};
  if(compact)return[label,value(ta,a.stats,'a',1),value(tb,b.stats,'b',2)];
  const track=(raw,side)=>{const node=taskElement('div','task-bf-t '+side);node.setAttribute('aria-hidden','true');const fill=taskElement('i');fill.style.width=(raw===null?0:Math.min(1,raw/scale))*100+'%';fill.style.background='var(--source,#84cc16)';node.append(fill);return node;};
  return[value(ta,a.stats,'a',1),track(va,'a'),label,track(vb,'b'),value(tb,b.stats,'b',2)];
}
function taskPairView(a,b){const fragment=document.createDocumentFragment(),wide=taskElement('div','task-h2h');wide.append(taskSide(a,'a'),taskElement('div','task-hcenter'),taskSide(b,'b'),taskElement('div','task-bf-sep'));for(const metric of taskMetrics)wide.append(...taskCompareRow(metric,a,b));
  const compact=taskElement('div','task-tp-compact'),sums=taskElement('div','task-sumrow'),table=taskElement('div','task-ctab');sums.append(taskSide(a,'a',true),taskSide(b,'b',true));table.append(taskElement('div','task-h'),taskElement('div','task-h',a.name),taskElement('div','task-h',b.name));for(const metric of taskMetrics)table.append(...taskCompareRow(metric,a,b,true));compact.append(sums,table);fragment.append(wide,compact);return fragment;}
function taskSingleView(item){const root=taskElement('div','task-single');root.append(taskSide(item,'b'));for(const metric of taskMetrics){const row=taskElement('div','task-single-row'),label=taskElement('div','task-bf-l'),track=taskElement('div','task-bf-t'),fill=taskElement('i'),raw=taskMetricRaw(metric,item.stats),shown=taskMetricText(metric,raw),value=taskElement('div','task-bf-v',shown);label.append(taskElement('b','',taskT(metric.key)));if(metric.lower)label.append(taskElement('small','task-lb',taskT('history.tasks.lowerBetter')));label.title=taskT(metric.key+'.hint');value.title=taskMetricTip(metric,item.stats);row.setAttribute('role','group');row.setAttribute('aria-label',taskT(metric.key)+': '+item.name+' '+(raw===null?value.title:shown)+(metric.lower?' · '+taskT('history.tasks.lowerBetter'):''));fill.style.width=(raw===null?0:Math.min(1,raw/taskMetricScale(metric,raw,null)))*100+'%';fill.style.background='var(--source,#84cc16)';track.append(fill);track.setAttribute('aria-hidden','true');row.append(label,track,value);root.append(row);}return root;}
function taskIqr(stats){const strip=taskElement('span','task-iqr');if(stats.medianScore===null){strip.setAttribute('aria-hidden','true');return strip;}strip.setAttribute('role','img');strip.setAttribute('aria-label',taskT('a11y.history.tasks.iqr',taskNumber(taskRound(stats.lowerQuartile)),taskNumber(taskRound(stats.upperQuartile))));const range=taskElement('i'),median=taskElement('b');range.style.left=stats.lowerQuartile+'%';range.style.width=(stats.upperQuartile-stats.lowerQuartile)+'%';range.style.background='var(--source,#84cc16)';median.style.left='calc('+stats.medianScore+'% - 1px)';strip.append(range,median);return strip;}
function taskMedianCell(stats){const cell=taskElement('span','task-medcell');cell.append(taskElement('span','',taskNumber(taskRound(stats.medianScore))),taskIqr(stats));return cell;}
function taskModelLabel(item){const name=taskElement('span','task-mname'),main=taskElement('span','task-mn-main'),title=taskElement('span','task-t',item.name);title.title=item.name;main.append(taskModelDot(),title);name.append(main);if(item.stats.scoredTasks<10){const extra=taskElement('span','task-mn-extra');extra.append(taskLowChip(item.stats));name.append(extra);}return name;}
function taskSortedModels(){const sign=taskModelDescending?-1:1;return taskHistoryModels.slice().sort((a,b)=>{const av=taskModelSort==='model'?a.name:a.stats[taskModelSort],bv=taskModelSort==='model'?b.name:b.stats[taskModelSort];let comparison=0;if(av===null)comparison=bv===null?0:1;else if(bv===null)comparison=-1;else comparison=typeof av==='string'?(av<bv?-1:av>bv?1:0)*sign:(av-bv)*sign;return comparison||(a.key<b.key?-1:a.key>b.key?1:0);});}
function taskCopyText(item){const s=item.stats;return[item.name,taskT('history.tasks.metric.tasks')+': '+s.tasks,taskT('history.tasks.metric.scored')+': '+s.scoredTasks,taskT('history.tasks.metric.median')+': '+taskNumber(taskRound(s.medianScore)),...taskMetrics.map(metric=>taskT(metric.key)+': '+taskMetricText(metric,taskMetricRaw(metric,s))+' ('+taskMetricTip(metric,s)+')')].join('\t');}
function taskModelTable(){
  const root=taskElement('div','task-tp-models'),heading=taskElement('div','task-model-heading'),title=taskElement('h3','',taskT('history.tasks.byModel')),sort=taskElement('select','task-model-sort'),direction=taskElement('button','task-model-copy',taskModelDescending?'↓':'↑'),table=taskElement('table','task-tbl'),head=taskElement('thead'),header=taskElement('tr'),body=taskElement('tbody'),list=taskElement('div','task-mlist');
  const columns=[{id:'model',key:'history.tasks.column.model'},{id:'tasks',key:'history.tasks.metric.tasks',className:'task-col-sep'},{id:'scoredTasks',key:'history.tasks.metric.scored',short:'history.tasks.metric.scored.short',className:'task-col-sep'},{id:'tasks',key:'history.tasks.column.scoredOfTasks',className:'task-col-merged'},{id:'medianScore',key:'history.tasks.metric.median',short:'history.tasks.metric.median.short'},...taskMetrics];
  sort.setAttribute('aria-label',taskT('history.tasks.byModel')+' · '+(language==='zh'?'排序':'Sort'));sort.id='task-model-sort';direction.type='button';direction.dataset.taskSortDirection='true';direction.setAttribute('aria-label',language==='zh'?'切换排序方向':'Reverse sort direction');
  for(const column of columns){const th=taskElement('th',column.className||''),button=taskElement('button','',taskT(column.short||column.key));button.type='button';button.dataset.taskSort=column.id;button.title=taskT(column.key);button.setAttribute('aria-label',taskT(column.key));th.scope='col';if(column.id===taskModelSort)th.setAttribute('aria-sort',taskModelDescending?'descending':'ascending');th.append(button);header.append(th);if(!column.className||column.className==='task-col-sep'){const option=taskElement('option','',taskT(column.key));option.value=column.id;sort.append(option);}}
  sort.value=taskModelSort;heading.append(title,sort,direction);head.append(header);table.append(head,body);
  for(const item of taskSortedModels()){const stats=item.stats,row=taskElement('tr',stats.scoredTasks<10?'task-low':''),name=taskElement('td'),tasks=taskElement('td','task-col-sep',taskNumber(stats.tasks)),scored=taskElement('td','task-col-sep',taskNumber(stats.scoredTasks)),merged=taskElement('td','task-col-merged',taskNumber(stats.scoredTasks)+' / '+taskNumber(stats.tasks)),median=taskElement('td');name.append(taskModelLabel(item));median.append(taskMedianCell(stats));row.append(name,tasks,scored,merged,median);row.tabIndex=0;row.taskModelItem=item;row.setAttribute('aria-label',taskCopyText(item));for(const metric of taskMetrics){const cell=taskElement('td','',taskMetricText(metric,taskMetricRaw(metric,stats)));cell.title=taskMetricTip(metric,stats);row.append(cell);}body.append(row);
    const narrow=taskElement('div','task-mitem'+(stats.scoredTasks<10?' task-low':'')),line=taskElement('div','task-l1'),right=taskElement('span','task-r'),description=taskElement('div','task-l2');right.append(taskMedianCell(stats));line.append(taskModelLabel(item),right);const first=taskMetrics.slice(0,3).map(metric=>taskT(metric.key)+' '+taskMetricText(metric,taskMetricRaw(metric,stats))).join(' · '),second=[taskT('history.tasks.counts',stats.scoredTasks,stats.tasks),...taskMetrics.slice(3).map(metric=>taskT(metric.short||metric.key)+' '+taskMetricText(metric,taskMetricRaw(metric,stats)))].join(' · ');description.append(document.createTextNode(first),document.createElement('br'),document.createTextNode(second));narrow.append(line,description);narrow.tabIndex=0;narrow.taskModelItem=item;narrow.setAttribute('aria-label',taskCopyText(item));list.append(narrow);
  }
  root.append(heading,table,list);return root;
}
function taskFillModelPicker(id,selected,other){const select=node(id),wanted=taskHistoryModels.filter(item=>item.key!==other),remembered=selected&&!wanted.some(item=>item.key===selected)?taskHistoryModels.find(item=>item.key===selected)||{key:selected,name:selected===taskUnknownModel?taskT('noModel'):selected.slice(6)}:null;if(remembered&&remembered.key!==other)wanted.push(remembered);const key=JSON.stringify(wanted.map(item=>[item.key,item.name]));if(select.taskOptionsKey!==key){const fragment=document.createDocumentFragment();for(const item of wanted){const option=taskElement('option','',item.name);option.value=item.key;fragment.append(option);}select.replaceChildren(fragment);select.taskOptionsKey=key;}select.value=selected||'';select.setAttribute('aria-label',taskT(id==='task-model-a'?'history.tasks.pickA.a11y':'history.tasks.pickB.a11y'));}
function taskHistoryPlaceholder(scanning){const root=taskElement('div');if(scanning){const skeleton=taskElement('div','task-skel');skeleton.setAttribute('aria-hidden','true');for(const width of [62,88,74,81,55]){const track=taskElement('i');track.style.width=width+'%';skeleton.append(track);}root.append(skeleton);}const state=taskElement('div','task-tp-state');if(!scanning){const icon=taskSvg('svg',{width:34,height:34,viewBox:'0 0 34 34','aria-hidden':'true',class:'task-gl'});icon.append(taskSvg('path',{d:'M7.2 26.8A13 13 0 1 1 26.8 26.8M17 17l5-6',fill:'none',stroke:'currentColor','stroke-width':2.4,'stroke-linecap':'round'}));state.append(icon,taskElement('b','',taskT('history.tasks.empty')),taskElement('span','',taskT('history.tasks.empty.hint')));}else state.append(taskElement('span','',taskT('history.tasks.analyzing')));root.append(state);return root;}
function taskPlaceHistory(){const section=node('task-performance');if(!section)return;const slot=node('task-history-slot'),body=node('history-body'),daily=node('history-rows');if(body&&body.hidden){const scroll=body.closest('.history-scroll');if(scroll&&section.parentElement!==scroll)scroll.insertBefore(section,node('history-empty')||null);}else if(slot){if(section.parentElement!==slot)slot.append(section);}else if(daily){const tableSection=daily.closest('section');if(tableSection&&section.nextElementSibling!==tableSection)tableSection.parentElement.insertBefore(section,tableSection);}}
function taskRenderHistory(snapshot){
  const section=node('task-performance');if(!section)return;taskPlaceHistory();const dates=selectedDates(),data=snapshot&&snapshot.tasks,records=data?data.records.filter(record=>record.complete&&record.day>=dates.startDate&&record.day<=dates.endDate):[];
  const key=JSON.stringify([language,dates.startDate,dates.endDate,!!(data&&data.scanning),!!(data&&data.limited),taskPickedA,taskPickedB,taskModelSort,taskModelDescending,records.map(record=>[record.agentId,record.ordinal,record.day,record.model,record.score,record.success,record.stalled,record.startMs,record.firstPassMs,record.counts.fixFailures,record.counts.fixAttempts,record.counts.recovered,record.counts.recoverAttempts])]);if(key===taskHistoryKey)return;taskHistoryKey=key;
  taskText(node('task-performance-title'),taskT('history.tasks.title'));taskText(node('task-model-vs'),taskT('history.tasks.vs'));taskText(node('task-performance-footnote'),taskT('history.tasks.footnote')+' '+taskT('humanDisclaimer'));const info=node('task-performance-info');info.title=taskT('history.tasks.info');info.setAttribute('aria-label',taskT('infoA11y'));section.setAttribute('aria-busy',String(!!(data&&data.scanning)));
  const coverage=node('task-coverage-note'),notes=[];if(data&&data.scanning)notes.push(taskT('scanning'));if(data&&data.limited)notes.push(taskT('limited'));taskText(coverage,notes.join(' '));coverage.hidden=!notes.length;
  const groups=new Map();for(const record of records){const model=record.model===null?null:record.model;let group=groups.get(model);if(!group){group=[];groups.set(model,group);}group.push(record);}
  taskHistoryModels=Array.from(groups,([model,items])=>({model,key:taskModelKey(model),name:taskModelName(model),stats:taskAggregateTasks(items,dates.startDate,dates.endDate)})).sort((a,b)=>b.stats.tasks-a.stats.tasks||(a.key<b.key?-1:a.key>b.key?1:0));
  const content=node('task-performance-content'),picks=node('task-model-picks'),one=node('task-only-one');
  if(!taskHistoryModels.length){picks.hidden=true;one.hidden=true;content.replaceChildren(taskHistoryPlaceholder(!!(data&&data.scanning)));monitorSelectPicker.install(section);return;}
  if(taskPickedA===null)taskPickedA=taskHistoryModels[0].key;
  if(taskPickedB===null&&taskHistoryModels.length>1)taskPickedB=(taskHistoryModels.find(item=>item.key!==taskPickedA)||taskHistoryModels[1]).key;
  const single=taskHistoryModels.length===1&&(taskPickedB===null||taskPickedA===taskPickedB),empty=taskAggregateTasks([],dates.startDate,dates.endDate),find=key=>taskHistoryModels.find(item=>item.key===key)||{key,model:key===taskUnknownModel?null:key.slice(6),name:key===taskUnknownModel?taskT('noModel'):key.slice(6),stats:empty};
  picks.hidden=single;one.hidden=!single;if(single){const item=taskHistoryModels[0];taskText(one,taskT('history.tasks.onlyOne',item.name));content.replaceChildren(taskSingleView(item),taskModelTable());}
  else{taskFillModelPicker('task-model-a',taskPickedA,taskPickedB);taskFillModelPicker('task-model-b',taskPickedB,taskPickedA);content.replaceChildren(taskPairView(find(taskPickedA),find(taskPickedB)),taskModelTable());}
  monitorSelectPicker.install(section);
  if(!document.hidden)taskAnimate(content,[{opacity:0},{opacity:1}],{duration:200});
}
function taskShowInfo(){const popup=node('task-history-info'),button=node('task-performance-info');if(!popup||!button)return;taskText(node('task-info-title'),taskT('history.tasks.title'));taskText(node('task-info-intro'),taskT('history.tasks.info'));taskText(node('task-info-disclaimer'),taskT('history.tasks.footnote')+' '+taskT('humanDisclaimer'));node('task-info-close').setAttribute('aria-label',taskT('close'));const definitions=node('task-info-definitions'),fragment=document.createDocumentFragment();for(const key of ['history.tasks.metric.scored','history.tasks.metric.median',...taskMetrics.map(metric=>metric.key)]){fragment.append(taskElement('dt','',taskT(key)),taskElement('dd','',taskT(key+'.hint')));}definitions.replaceChildren(fragment);popup.hidden=false;button.setAttribute('aria-expanded','true');const rect=button.getBoundingClientRect(),width=Math.min(340,window.innerWidth-16);popup.style.left=Math.max(8,Math.min(rect.left-12,window.innerWidth-width-8))+'px';popup.style.top=Math.max(8,Math.min(rect.bottom+8,window.innerHeight-popup.offsetHeight-8))+'px';}
function taskHideInfo(){const info=node('task-history-info');if(info)info.hidden=true;const button=node('task-performance-info');if(button)button.setAttribute('aria-expanded','false');}
async function taskCopyRow(){const item=taskCopyModel;if(!item)return;const text=taskCopyText(item);try{if(!navigator.clipboard||typeof navigator.clipboard.writeText!=='function')throw new Error('clipboard unavailable');await navigator.clipboard.writeText(text);taskText(node('task-copy-status'),taskT('copied'));}catch{taskText(node('task-copy-status'),taskT('copyUnavailable'));}const menu=node('task-copy-menu');if(menu)menu.hidden=true;}

const taskNoReadout = Object.freeze({visible:false,stackOffset:0,needleLegend:false,glyphs:[],key:'off'});
const taskPlacements = {
  led:{near:-.245,t:.050,fit:.44,value:.24,valueBase:.012,titleBase:.206,titleSize:.062,dots:.3785,recenter:true},
  liquid:{near:-.245,t:.050,fit:.44,value:.24,valueBase:.012,titleBase:.206,titleSize:.062,dots:.3785,recenter:true},
  reactor:{near:-.155,t:.046,fit:.32,value:.205,valueBase:.03,titleBase:.184,titleSize:.058,dots:.252,recenter:false},
  needle:{near:.108,t:.046,fit:.285,value:.205,valueBase:.035,titleBase:.338,titleSize:.062,dots:.405,recenter:false,below:true},
  minimal:{near:-.228,t:.054,fit:.50,value:.30,valueBase:.07,titleBase:.168,titleSize:.068,dots:null,recenter:true}
};
function taskMeasure(text,size,weight=600){if(!taskMeasurement){const canvas=document.createElement('canvas');taskMeasurement=canvas.getContext('2d');}if(!taskMeasurement)return null;taskMeasurement.font=weight+' '+size+'px "Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif';return taskMeasurement.measureText(text).width;}
function taskReadoutFits(style,size,showScore,showThinking){const placement=taskPlacements[style],t=Math.max(7,placement.t*size),p=1.25*t,glyphSize=.82;const scoreGlyph=taskMeasure(taskT('intel.glyph'),glyphSize*p),scoreNumber=taskMeasure('888',p),thinkGlyph=taskMeasure(taskT('intel.thinking.glyph'),glyphSize*t),thinkNumber=taskMeasure('8.88',t),unit=style==='needle'?0:taskMeasure('tok/s',glyphSize*t,500);if([scoreGlyph,scoreNumber,thinkGlyph,thinkNumber,unit].some(value=>value===null))return false;const scoreWidth=scoreGlyph+.2*p+scoreNumber,thinkWidth=thinkGlyph+.16*t+thinkNumber+(unit ? .16*t+unit : 0),limit=placement.fit*size;if(showScore&&scoreWidth>limit||showThinking&&thinkWidth>limit)return false;if(style==='needle'){const top=placement.near*size+.7*(p-t),bottom=showScore?top+1.32*t:placement.near*size;return(!showScore||Math.hypot(scoreWidth/2,top)<=.223*size)&&(!showThinking||Math.hypot(thinkWidth/2,bottom)<=.223*size);}return true;}
function taskTop(snapshot){if(!snapshot||!snapshot.tasks)return null;const top=taskHighestTaskValue(snapshot.agents.map(agent=>({id:agent.id,lastLineMs:agent.lastActivityAt})),snapshot.tasks.current);if(top.agent===null)return null;const agent=snapshot.agents.find(agent=>agent.id===top.agent),status=snapshot.tasks.current[top.agent];if(!agent||!status)return null;let count=0;for(const member of snapshot.agents){const current=snapshot.tasks.current[member.id];if(current&&current.form===top.form&&current.result&&current.result.score!==null)count++;}return{agent,status,count};}
function taskTweenValue(tween,now){if(!tween)return 0;const ratio=Math.min(1,Math.max(0,(now-tween.start)/tween.duration)),eased=ratio*ratio*(3-2*ratio);return tween.from+(tween.to-tween.from)*eased;}
function taskSetTween(entry,name,target,now,duration){const previous=entry[name];if(taskReduced()){if(!previous||previous.from!==target||previous.to!==target)entry[name]={from:target,to:target,start:now,duration:1};return;}if(previous&&previous.to===target)return;const from=previous?taskTweenValue(previous,now):target;entry[name]={from,to:target,start:now,duration};if(from!==target&&entry.surfaceVisible)taskScheduleAnimation();}
function taskReadoutEntry(id){let entry=taskReadouts.get(id);if(entry)return entry;const host=node(id);if(!host)return null;const root=taskElement('div','task-theme task-orb-lines'),intel=taskElement('div','task-ln task-ln-intel'),scoreLabel=taskElement('span','task-glyph'),score=taskElement('span','task-n'),thinking=taskElement('div','task-ln task-ln-think'),thinkingLabel=taskElement('span','task-glyph'),thinkingNumber=taskElement('span','task-n'),thinkingUnit=taskElement('span','task-u','tok/s');root.setAttribute('aria-hidden','true');intel.append(scoreLabel,score);thinking.append(thinkingLabel,thinkingNumber,thinkingUnit);root.append(intel,thinking);host.append(root);entry={id,host,root,intel,scoreLabel,score,thinking,thinkingLabel,thinkingNumber,thinkingUnit,visibility:{hidden:true,zeroSince:null,enabled:true},quietSince:null,lastTop:null,frame:taskNoReadout,frameKey:'',alpha:{from:0,to:0,start:0,duration:1},fold:{from:1,to:1,start:0,duration:1},thinkingAlpha:{from:0,to:0,start:0,duration:1},peakStart:-Infinity,surfaceVisible:false,layoutKey:'',fit:false};taskReadouts.set(id,entry);return entry;}
function taskPrepareReadouts(snapshot,now){
  const live=liveFacts(),top=taskTop(live),rate=live&&live.rate,thinking=rate&&!(rate.measuredThinkingTps==null&&rate.estimatedThinkingTps==null)?(rate.measuredThinkingTps??0)+(rate.estimatedThinkingTps??0):null,preferences=view&&view.preferences;
  if(!preferences)return;const showScore=preferences.showTaskScore===true,showThinking=preferences.showThinking!==false,generating=!!live&&live.agents.some(agent=>agent.phase==='generating');
  for(const id of ['orb-art','hero-art']){const entry=taskReadoutEntry(id);if(!entry)continue;entry.surfaceVisible=!document.hidden&&(id==='orb-art'?view.surface==='orb'&&view.orbVisible:view.surface==='dashboard');entry.style=id==='hero-art'?'led':preferences.style;entry.size=id==='hero-art'?112:preferences.size;entry.showScore=showScore;entry.showThinking=showThinking;entry.thinkingValue=thinking;
    const layoutKey=[entry.style,entry.size,language,showScore,showThinking].join('|');if(layoutKey!==entry.layoutKey){entry.layoutKey=layoutKey;entry.fit=taskReadoutFits(entry.style,entry.size,showScore,showThinking);}
    entry.visibility=taskThinkingVisibility(entry.visibility,thinking,showThinking,now);const thinkingShown=showThinking&&!entry.visibility.hidden;
    const active=showScore&&!!top||generating&&(showScore||showThinking)||showThinking&&thinking!==null&&thinking>=.05;
    if(active)entry.wasActive=true;
    if(top&&showScore)entry.lastTop=top;
    if(active)entry.quietSince=null;else if(entry.quietSince===null)entry.quietSince=now;
    const quiet=entry.quietSince!==null&&now-entry.quietSince>=10000;
    const hasRetained=entry.lastTop&&entry.quietSince!==null&&now-entry.quietSince<10600;
    entry.top=top&&showScore?top:showScore&&hasRetained?entry.lastTop:null;
    if(quiet&&entry.quietSince!==null&&now-entry.quietSince>=10600){entry.lastTop=null;entry.wasActive=false;}
    const showAny=(showScore||thinkingShown)&&entry.fit&&(active||entry.top||entry.wasActive)&&!quiet;
    taskSetTween(entry,'alpha',showAny?1:0,now,showAny?250:600);taskSetTween(entry,'fold',thinkingShown&&showScore?0:1,now,300);taskSetTween(entry,'thinkingAlpha',thinkingShown?1:0,now,250);
    const status=entry.top&&entry.top.status,result=status&&status.result;taskSetProof(entry.score,result,status?status.form:'none');taskAnimateScore(entry.score,result?result.shown:null,'orb',entry.surfaceVisible&&entry.fit);taskText(entry.scoreLabel,taskT('intel.glyph'));taskText(entry.thinkingLabel,taskT('intel.thinking.glyph'));taskText(entry.thinkingNumber,taskSpeed(thinking));
    entry.intel.hidden=!showScore;entry.thinkingUnit.hidden=entry.style==='needle';entry.root.style.setProperty('--task-diameter',entry.size+'px');entry.root.style.setProperty('--task-t',Math.max(7,taskPlacements[entry.style].t*entry.size)+'px');entry.root.style.setProperty('--task-p',1.25*Math.max(7,taskPlacements[entry.style].t*entry.size)+'px');entry.root.dataset.style=entry.style;
    entry.root.style.visibility=entry.style==='liquid'&&taskForcedColorsQuery.matches?'visible':'';
    entry.intel.classList.toggle('task-is-pale',!!status&&status.form==='resting');entry.intel.classList.toggle('task-is-quiet',!result||result.shown===null);entry.thinking.classList.toggle('task-is-quiet',thinking===null);
    const words=showScore?taskScoreWords(status,entry.top?entry.top.count:0):'';entry.root.setAttribute('aria-label',showScore?(thinkingShown?taskT('a11y.orb.intel',words,taskSpeed(thinking)):taskT('a11y.orb.intel.only',words)):taskT('intel.thinking.glyph')+' '+taskSpeed(thinking)+' tok/s');
    entry.host.taskReadoutDescription=showAny?entry.root.getAttribute('aria-label'):'';
    const hit=id==='orb-art'?node('orb-hit'):null;if(hit)hit.title=entry.top?taskT('task.tooltip.top',result.shown,entry.top.agent.project||entry.top.agent.name||entry.top.agent.id)+'\n'+taskT('intel.disclaimer'):showThinking&&thinking!==null?taskT('intel.thinking.glyph')+' '+taskSpeed(thinking)+' tok/s':'';
  }
}
function taskGlyphs(entry,baseline,size,label,value,unit,role,proof,alpha){const small=.82*size,gap=(label===taskT('intel.glyph')?.20:.16)*size,labelWidth=taskMeasure(label,small),numberWidth=taskMeasure(value,size),unitWidth=unit?taskMeasure(unit,small,500):0;if(labelWidth===null||numberWidth===null||unitWidth===null)return[];const width=labelWidth+gap+numberWidth+(unit?gap+unitWidth:0),dpr=window.devicePixelRatio||1,snap=value=>Math.round(value*dpr)/dpr;let x=snap(-width/2);const glyphs=[{text:label,x,y:baseline,size:small,weight:600,role:1,proof:false,alpha}];x=snap(x+labelWidth+gap);glyphs.push({text:value,x,y:baseline,size,weight:600,role,proof,alpha});if(unit)glyphs.push({text:unit,x:snap(x+numberWidth+gap),y:baseline,size:small,weight:500,role:1,proof:false,alpha});return glyphs;}
function taskRenderReadouts(now){for(const entry of taskReadouts.values()){
    const placement=taskPlacements[entry.style];if(!placement)continue;const size=entry.size,t=Math.max(7,placement.t*size),p=1.25*t,alpha=taskTweenValue(entry.alpha,now),fold=taskTweenValue(entry.fold,now),thinkingAlpha=taskTweenValue(entry.thinkingAlpha,now),peakAge=now-entry.peakStart;
    let peakAlpha=1;if(entry.style!=='needle'&&peakAge>=0&&peakAge<1950){if(taskReduced())peakAlpha=peakAge<1800?0:1;else peakAlpha=peakAge<150?1-peakAge/150:peakAge<1800?0:(peakAge-1800)/150;}
    const top=placement.below?placement.near*size+.7*(p-t):placement.near*size-1.32*t,single=placement.below?top:placement.near*size,scoreBaseline=top+(single-top)*fold;
    let shift=0;if(placement.recenter&&entry.id!=='hero-art'){
      const blockTop=(entry.showScore?scoreBaseline-.70*p:placement.near*size-.70*t),valueTop=(placement.valueBase-.70*placement.value)*size;shift=Math.max(0,(valueTop-blockTop)/2);
      if(placement.dots!==null){const titleBottom=placement.titleBase*size+.22*Math.max(7,placement.titleSize*size),dotsTop=placement.dots*size-2*size/148;shift=Math.min(shift,Math.max(0,dotsTop-.05*size-titleBottom));}shift*=alpha;
    }
    const visible=entry.surfaceVisible&&entry.fit&&alpha>.001&&(entry.showScore||entry.showThinking),intelligenceY=scoreBaseline+shift,thinkingY=(entry.showScore?(placement.below?top+1.32*t:placement.near*size):placement.near*size)+shift;
    entry.intel.style.top=(size/2+intelligenceY-.855*p)+'px';entry.thinking.style.top=(size/2+thinkingY-.855*t)+'px';entry.thinking.style.opacity=String(thinkingAlpha);entry.thinking.hidden=!entry.showThinking||thinkingAlpha<.001;entry.root.style.opacity=String(alpha*peakAlpha);entry.root.hidden=!visible;
    const result=entry.top&&entry.top.status.result,status=entry.top&&entry.top.status,scoreQuiet=!result||result.shown===null||status.form==='resting',proof=!!result&&(result.state==='unverified'||result.state==='pending')&&result.shown!==null;
    const glyphs=[];if(visible&&entry.showScore&&!taskForcedColorsQuery.matches)glyphs.push(...taskGlyphs(entry,intelligenceY,p,taskT('intel.glyph'),entry.score.textContent,'',scoreQuiet?1:0,proof,alpha*peakAlpha));if(visible&&entry.showThinking&&thinkingAlpha>.001&&!taskForcedColorsQuery.matches)glyphs.push(...taskGlyphs(entry,thinkingY,t,taskT('intel.thinking.glyph'),taskSpeed(entry.thinkingValue),entry.style==='needle'?'':'tok/s',entry.thinkingValue===null?1:0,false,alpha*peakAlpha*thinkingAlpha));
    const needleLegend=entry.style==='needle'&&entry.fit&&(entry.showScore||entry.showThinking),contrast=taskContrastQuery.matches,description=visible?entry.root.getAttribute('aria-label'):'',key=JSON.stringify([visible,shift,needleLegend,contrast,description,glyphs]);
    if(key!==entry.frameKey){entry.frameKey=key;entry.frame={visible,stackOffset:visible?shift:0,needleLegend,glyphs,key,contrast,description};entry.host.dispatchEvent(new CustomEvent('task-readout-change',{detail:entry.frame}));}
  }}
function taskOrbReadoutFrame(id){const entry=taskReadouts.get(id);return entry&&entry.surfaceVisible?entry.frame:taskNoReadout;}
function taskHasReadoutMotion(now){for(const entry of taskReadouts.values()){if(!entry.surfaceVisible||!entry.fit)continue;for(const name of ['alpha','fold','thinkingAlpha']){const tween=entry[name];if(tween.from!==tween.to&&now<tween.start+tween.duration)return true;}const peakAge=now-entry.peakStart;if(peakAge>=0&&(peakAge<150||peakAge>=1800&&peakAge<1950)&&!taskReduced())return true;}return false;}
function taskAnimationTick(now){taskRaf=0;if(taskDestroyed||document.hidden)return;const orbDue=!taskLastRaf||now-taskLastRaf>=1000/30;let pending=false;for(const [element,animation]of taskNumberAnimations){if(!element.isConnected){taskNumberAnimations.delete(element);continue;}if(animation.surface==='orb'&&!orbDue){pending=true;continue;}const ratio=Math.min(1,(now-animation.start)/animation.duration),eased=1-Math.pow(1-ratio,3);taskText(element,ratio>=1?animation.to:Math.floor(animation.from+(animation.to-animation.from)*eased));if(ratio>=1)taskNumberAnimations.delete(element);else pending=true;}if(orbDue){taskLastRaf=now;taskRenderReadouts(now);}if(pending||taskHasReadoutMotion(now))taskScheduleAnimation();}
function taskScheduleWake(now){clearTimeout(taskWakeTimer);taskWakeTimer=null;if(document.hidden||taskDestroyed)return;let next=Infinity;for(const entry of taskReadouts.values()){if(!entry.surfaceVisible)continue;if(entry.visibility.zeroSince!==null&&!entry.visibility.hidden)next=Math.min(next,entry.visibility.zeroSince+3000);if(entry.quietSince!==null&&entry.quietSince+10000>now)next=Math.min(next,entry.quietSince+10000);if(entry.peakStart+1800>now&&entry.peakStart+1800<Infinity)next=Math.min(next,entry.peakStart+1800);}if(Number.isFinite(next)&&next>now)taskWakeTimer=setTimeout(()=>{taskWakeTimer=null;renderTaskUI(taskFacts());},Math.max(1,next-now));}

function taskCancelAnimations(){if(taskRaf)cancelAnimationFrame(taskRaf);taskRaf=0;taskLastRaf=0;for(const [element,animation]of taskNumberAnimations)taskText(element,animation.to);taskNumberAnimations.clear();for(const effect of taskEffects)effect.cancel();taskEffects.clear();}
function bindTaskUI(){
  if(taskBound||taskDestroyed)return;taskBound=true;const template=node('task-ui-markup');
  if(template){for(const id of ['task-score-card','task-performance','task-readout-settings','task-history-info','task-copy-menu']){if(node(id))continue;const source=template.content.querySelector('#'+id);if(!source)continue;const copy=source.cloneNode(true),target=id==='task-performance'?node('task-history-slot'):id==='task-readout-settings'?node('task-settings-slot')||node('page-orb'):document.body;if(target)target.append(copy);}}
  taskPlaceHistory();
  monitorSelectPicker.install(node('task-performance'));
  for(const [id,key]of [['show-task-score','showTaskScore'],['show-thinking','showThinking']]){const input=node(id);if(input)taskListen(input,'change',()=>action(()=>bridge.configure({[key]:input.checked})));}
  for(const [id,which]of [['task-model-a','a'],['task-model-b','b']]){const select=node(id);if(select)taskListen(select,'change',()=>{if(which==='a')taskPickedA=select.value;else taskPickedB=select.value;taskHistoryKey='';taskRenderHistory(taskFacts());});}
  const infoButton=node('task-performance-info');if(infoButton)taskListen(infoButton,'click',()=>{if(node('task-history-info').hidden)taskShowInfo();else taskHideInfo();});const infoClose=node('task-info-close');if(infoClose)taskListen(infoClose,'click',taskHideInfo);const copy=node('task-copy-row');if(copy)taskListen(copy,'click',taskCopyRow);
  taskListen(document,'pointerover',event=>{taskNotePointer(event);if(taskHoverDismissed)return;const anchor=taskAnchor(event.target);if(!anchor||anchor.contains(event.relatedTarget))return;taskQueueCard(anchor);});
  taskListen(document,'pointermove',event=>{const dismissed=taskHoverDismissed,moved=taskNotePointer(event);if(dismissed&&moved){const anchor=taskAnchor(event.target);if(anchor)taskQueueCard(anchor);}});
  taskListen(document.documentElement,'pointerleave',()=>{taskHoverDismissed=false;taskPointerX=taskPointerY=null;});
  taskListen(document,'pointerout',event=>{const anchor=taskAnchor(event.target);if(!anchor||anchor.contains(event.relatedTarget))return;const card=node('task-score-card');if(card&&event.relatedTarget instanceof Node&&card.contains(event.relatedTarget))return;clearTimeout(taskHoverTimer);taskHoverTimer=null;clearTimeout(taskHideTimer);taskHideTimer=setTimeout(()=>{taskHideTimer=null;if(!taskCardState||!taskCardState.keyboard)taskHideCard();},150);});
  const card=node('task-score-card');if(card){taskListen(card,'pointerenter',()=>{clearTimeout(taskHideTimer);taskHideTimer=null;});taskListen(card,'pointerleave',event=>{if(taskCardState&&event.relatedTarget instanceof Node&&taskCardState.anchor.contains(event.relatedTarget))return;clearTimeout(taskHideTimer);taskHideTimer=setTimeout(()=>{taskHideTimer=null;if(!taskCardState||!taskCardState.keyboard)taskHideCard();},150);});}
  taskListen(document,'focusin',event=>{const anchor=taskAnchor(event.target);if(anchor&&taskCardState)taskShowCard(anchor.dataset.taskAgentId,anchor,taskOptions(anchor,true));});
  taskListen(document,'focusout',event=>{if(!taskCardState||!taskCardState.keyboard)return;const next=taskAnchor(event.relatedTarget);if(next)return;const popup=node('task-history-info');if(popup&&event.relatedTarget instanceof Node&&popup.contains(event.relatedTarget))return;if(taskCardState.anchor.contains(event.target))taskHideCard();});
  taskListen(document,'keydown',event=>{
    if(event.key==='Escape'){
      const menu=node('task-copy-menu'),info=node('task-history-info');if(menu&&!menu.hidden){event.preventDefault();event.stopPropagation();menu.hidden=true;return;}if(info&&!info.hidden){event.preventDefault();event.stopPropagation();taskHideInfo();return;}if(taskCardState||taskHoverTimer){event.preventDefault();event.stopPropagation();taskHoverDismissed=true;taskHideCard();return;}
    }
    const anchor=taskAnchor(event.target);
    if(event.key===' '&&anchor&&!event.altKey&&!event.ctrlKey&&!event.metaKey){event.preventDefault();event.stopPropagation();taskShowCard(anchor.dataset.taskAgentId,anchor,taskOptions(anchor,true));return;}
    if(taskCardState&&['ArrowDown','ArrowUp','PageDown','PageUp','Home','End'].includes(event.key)&&!event.altKey&&!event.ctrlKey&&!event.metaKey){const card=node('task-score-card');if(card&&card.scrollHeight>card.clientHeight&&(anchor||card.contains(event.target))){event.preventDefault();event.stopPropagation();const delta=event.key==='ArrowDown'?32:event.key==='ArrowUp'?-32:event.key==='PageDown'?card.clientHeight*.8:event.key==='PageUp'?-card.clientHeight*.8:0;card.scrollTop=event.key==='Home'?0:event.key==='End'?card.scrollHeight:card.scrollTop+delta;return;}}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='c'){const row=event.target instanceof Element?event.target.closest('.task-tbl tr,.task-mitem'):null;if(row&&row.taskModelItem){event.preventDefault();taskCopyModel=row.taskModelItem;taskCopyRow();}}
  },true);
  taskListen(document,'click',event=>{
    const target=event.target instanceof Element?event.target:null;if(!target)return;const sort=target.closest('[data-task-sort]');if(sort){const key=sort.dataset.taskSort;if(taskModelSort===key)taskModelDescending=!taskModelDescending;else{taskModelSort=key;taskModelDescending=key!=='model';}taskHistoryKey='';taskRenderHistory(taskFacts());return;}
    if(target.closest('[data-task-sort-direction]')){taskModelDescending=!taskModelDescending;taskHistoryKey='';taskRenderHistory(taskFacts());return;}
  });
  taskListen(document,'change',event=>{if(event.target.id==='task-model-sort'){taskModelSort=event.target.value;taskHistoryKey='';taskRenderHistory(taskFacts());}});
  taskListen(document,'contextmenu',event=>{const row=event.target instanceof Element?event.target.closest('.task-tbl tr,.task-mitem'):null;if(!row||!row.taskModelItem)return;event.preventDefault();taskCopyModel=row.taskModelItem;const menu=node('task-copy-menu'),button=node('task-copy-row');taskText(button,taskT('copy'));menu.hidden=false;menu.style.left=Math.max(8,Math.min(event.clientX,window.innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(event.clientY,window.innerHeight-menu.offsetHeight-8))+'px';});
  taskListen(document,'pointerdown',event=>{const info=node('task-history-info'),button=node('task-performance-info'),menu=node('task-copy-menu');if(info&&!info.hidden&&!info.contains(event.target)&&!button.contains(event.target))taskHideInfo();if(menu&&!menu.hidden&&!menu.contains(event.target))menu.hidden=true;});
  taskListen(document,'scroll',()=>{if(taskCardState)taskPositionCard();},true);
  taskListen(document,'visibilitychange',()=>{if(document.hidden){clearTimeout(taskWakeTimer);taskWakeTimer=null;taskCancelAnimations();taskHideCard();taskHideInfo();const menu=node('task-copy-menu');if(menu)menu.hidden=true;for(const entry of taskReadouts.values()){entry.surfaceVisible=false;entry.root.hidden=true;entry.frame=taskNoReadout;}}else renderTaskUI(taskFacts());});
  taskListen(window,'resize',()=>{taskRenderReadouts(performance.now());taskPositionCard();taskHideInfo();});
  taskListen(window,'blur',taskHideCard);
  const mediaChange=()=>renderTaskUI(taskFacts());for(const query of [taskMotionQuery,taskContrastQuery,taskForcedColorsQuery])taskListen(query,'change',mediaChange);
}
function renderTaskUI(snapshot){
  if(taskDestroyed)return;if(!taskBound)bindTaskUI();taskSnapshot=snapshot||null;if(!view)return;const now=performance.now(),scope=JSON.stringify([view.instanceId,view.scope.profile,view.scope.project]);
  if(taskReduced())taskCancelAnimations();
  if(scope!==taskScopeKey){taskScopeKey=scope;taskHideCard();taskRowValues.clear();for(const entry of taskReadouts.values()){entry.lastTop=null;entry.top=null;entry.wasActive=false;entry.visibility={hidden:true,zeroSince:null,enabled:true};entry.quietSince=null;entry.alpha={from:0,to:0,start:now,duration:1};entry.fold={from:1,to:1,start:now,duration:1};entry.thinkingAlpha={from:0,to:0,start:now,duration:1};entry.score.taskScoreValue=undefined;entry.peakStart=-Infinity;}taskLastPeak=null;}
  const showScore=node('show-task-score'),showThinking=node('show-thinking');if(showScore)showScore.checked=view.preferences.showTaskScore===true;if(showThinking)showThinking.checked=view.preferences.showThinking!==false;
  for(const [id,key]of [['task-score-setting-label','showScore'],['task-score-setting-hint','showScoreHint'],['task-thinking-setting-label','showThinking'],['task-thinking-setting-hint','showThinkingHint']]){const element=node(id);if(element)taskText(element,taskT(key));}
  const actual=taskFacts(),ids=new Set(actual?actual.agents.map(agent=>agent.id):[]);for(const id of taskRowValues.keys())if(!ids.has(id))taskRowValues.delete(id);
  for(const cell of document.querySelectorAll('.task-score-cell')){const agent=actual?actual.agents.find(candidate=>candidate.id===cell.dataset.taskAgentId):null;if(agent)taskUpdateScoreCell(cell,agent);else{cell.hidden=!taskScoresEnabled();taskText(cell.firstElementChild,'–');taskSetProof(cell.firstElementChild,null,'none');cell.dataset.form='none';}}
  for(const effect of taskEffects){if(effect.effect&&effect.effect.target&&!effect.effect.target.isConnected){effect.cancel();taskEffects.delete(effect);}}
  if(taskCardState){if(!taskScoresEnabled()){taskHideCard();}else{if(!taskCardState.anchor.isConnected){const replacement=Array.from(document.querySelectorAll('[data-task-agent-id]')).find(anchor=>anchor.dataset.taskAgentId===taskCardState.id&&anchor.dataset.taskCardHost===(taskCardState.anchor.dataset.taskCardHost||'dashboard'));if(replacement){taskCardState.anchor=replacement;replacement.dataset.taskOpen='true';replacement.setAttribute('aria-expanded','true');}else taskHideCard();}if(taskCardState)taskUpdateCard();}}
  taskRenderHistory(taskSnapshot);taskPrepareReadouts(taskSnapshot,now);
  const peak=view.activity?view.activity.peakSequence:null;if(taskLastPeak!==null&&peak!==taskLastPeak&&peak!==null){for(const entry of taskReadouts.values())if(entry.surfaceVisible&&entry.style!=='needle')entry.peakStart=now;}taskLastPeak=peak;
  taskRenderReadouts(now);taskScheduleWake(now);
  if(taskHasReadoutMotion(now)||taskNumberAnimations.size)taskScheduleAnimation();
}
function destroyTaskUI(){
  if(taskDestroyed)return;taskDestroyed=true;taskHideCard();taskHideInfo();monitorSelectPicker.close();clearTimeout(taskWakeTimer);taskWakeTimer=null;taskCancelAnimations();for(const remove of taskListeners.splice(0))remove();
  for(const entry of taskReadouts.values()){entry.host.dispatchEvent(new CustomEvent('task-readout-change',{detail:taskNoReadout}));entry.root.remove();delete entry.host.taskReadoutDescription;}taskReadouts.clear();taskRowValues.clear();taskHistoryModels=[];taskCopyModel=null;taskSnapshot=null;taskMeasurement=null;
  for(const id of ['task-score-card','task-performance','task-readout-settings','task-history-info','task-copy-menu']){const element=node(id);if(element)element.remove();}taskCardView=null;
}

`;
