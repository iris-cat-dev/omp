import { PERFORMANCE_MODEL_SCRIPT } from "./performance.js";

// Agent Speed v1.6.0 (MIT), ca460d7f899e7adc73391ea706b729f1fc481fde.
// DESIGN 12, the perf-score prototype and Windows Presentation/Perf + History/Perf.
// The complete upstream permission notice is retained in performance.ts.
// Only the monitor's numeric DTOs and safe labels enter this network/Node-free surface.

/** Original PerfNumber: comma grouping, three significant digits, suffix after rounding. */
export function performanceNumber(value: number | null, compact = false): string {
  if (value === null || !Number.isFinite(value)) return "–";
  const rounded = Math.round(Math.abs(value));
  const sign = value < 0 ? "−" : "";
  if (rounded < (compact ? 10000 : 100000))
    return sign + String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const significant = (divisor: number): string => {
    let decimals = 0;
    if (rounded < divisor * 100) decimals = 1;
    if (rounded < divisor * 10) decimals = 2;
    let scale = 10 ** decimals;
    let digits = Math.round(rounded / (divisor / scale));
    if (decimals > 0 && digits >= 1000) {
      decimals--;
      scale = 10 ** decimals;
      digits = Math.round(rounded / (divisor / scale));
    }
    return (digits / scale).toFixed(decimals);
  };
  const thousands = significant(1000);
  return sign + (Number(thousands) < 1000 ? thousands + "k" : significant(1000000) + "M");
}

export interface PerformanceThinkingVisibility {
  hidden: boolean;
  zeroSince: number | null;
  enabled: boolean;
}

/** Unknown holds visibility; only a known displayed zero starts the three-second hold. */
export function performanceThinkingVisibility(
  previous: PerformanceThinkingVisibility,
  value: number | null,
  enabled: boolean,
  now: number,
): PerformanceThinkingVisibility {
  let hidden = !enabled;
  let zeroSince: number | null = null;
  if (enabled && value === null) {
    hidden = previous.enabled && previous.hidden;
    zeroSince = previous.zeroSince;
  } else if (enabled && value !== null && value < 0.05) {
    zeroSince = previous.enabled ? (previous.zeroSince ?? now) : now;
    hidden = now - zeroSince >= 3000;
  }
  if (
    previous.hidden === hidden &&
    previous.zeroSince === zeroSince &&
    previous.enabled === enabled
  )
    return previous;
  return { hidden, zeroSince, enabled };
}

/** DESIGN 12's visual log scale, not an alternative score calculation. */
export function performanceScale(value: number | null): number {
  return value === null || value <= 250 ? 0 : Math.min(1, Math.log2(value / 250) / 4);
}

export function performanceMotionDuration(previous: number, value: number): number | null {
  const change = Math.abs(value - previous);
  if (change < 3 || change < Math.abs(previous) * 0.01) return null;
  if (previous <= 0 || value <= 0) return 700;
  return Math.min(700, Math.max(300, 300 + 350 * Math.abs(Math.log2(value / previous))));
}

const performanceStrings = {
  "phase.idle": ["空闲", "Idle"],
  "intel.glyph": ["性能", "Perf"],
  "intel.thinking.glyph": ["思考", "TH"],
  "intel.none": ["性能：暂无分数", "performance: no score yet"],
  "a11y.orb.intel.only": ["性能 %@", "performance %@"],
  "a11y.orb.intel": [
    "性能 %@，思考每秒 %@ 个 token",
    "performance %@, thinking %@ tokens per second",
  ],
  "a11y.agent.intel": ["性能 %@", "performance %@"],
  "agents.intel.hint": [
    "性能是 agent 近 30 分钟的跑分，综合输出速度、首段延迟、思考速度、工具节奏与耗时、工具成功率和缓存命中。1000 是参考水平，没有上限，越高越快。虚线底表示样本还少；淡色是空闲 agent 的分数。",
    "Perf is a benchmark-style score of each agent's last 30 minutes: output speed, time to first content, thinking speed, tool pace and time, tool success and cache hits. 1000 is the reference level and there is no upper limit; higher is faster. A dotted underline means few samples so far; dimmed is an idle agent's score.",
  ],
  "perf.tier.slow": ["偏慢", "Slower"],
  "perf.tier.standard": ["标准", "Standard"],
  "perf.tier.fast": ["快", "Fast"],
  "perf.tier.veryFast": ["极快", "Very fast"],
  "perf.reference": ["参考水平", "Reference"],
  "perf.summary": ["%@ · 参考水平的 %@ 倍", "%@ · %@× the reference"],
  "perf.summary.slowest": [
    "%@ · 参考水平的 %@ 倍 · 最慢的一环：%@",
    "%@ · %@× the reference · slowest part: %@",
  ],
  "perf.summary.allAbove": [
    "%@ · 参考水平的 %@ 倍 · 每一项都高于参考",
    "%@ · %@× the reference · every part above it",
  ],
  "perf.usual": ["比平常 %@", "%@ vs usual"],
  "perf.usual.none": ["暂无平常值", "No usual yet"],
  "perf.usual.none.hint": [
    "同一个来源与模型在这台电脑上，今天之前 14 天累计 %d 个有效计时请求后，才会有平常值。",
    "A usual value appears once this source and model have %d timed requests on this computer in the 14 days before today.",
  ],
  "perf.provisional": ["初步", "Provisional"],
  "perf.provisional.hint": [
    "只有 %d 个有效计时请求，分数还不稳定；满 %d 个后虚线就会消失。",
    "Only %d timed requests so far, so the score can still swing; the dotted line goes away at %d.",
  ],
  "perf.status.none": [
    "近 30 分钟只有 %d 个有效计时请求；至少要 %d 个才会评分。",
    "Only %d timed requests in the last 30 minutes; a score needs at least %d.",
  ],
  "perf.card.top": ["%d 个 agent 中最高", "Highest of %d agents"],
  "perf.group.speed": ["速度", "Speed"],
  "perf.group.efficiency": ["效率", "Efficiency"],
  "perf.comp.throughput": ["输出吞吐", "Throughput"],
  "perf.comp.throughput.desc": [
    "响应期间平均每秒写出的 token",
    "Tokens written per second while responding",
  ],
  "perf.comp.latency": ["首段延迟 P50", "Latency P50"],
  "perf.comp.latency.desc": [
    "发出请求后多久开始出现内容（中位数）",
    "How soon content starts after a request (median)",
  ],
  "perf.comp.reasoning": ["思考速度", "Thinking speed"],
  "perf.comp.reasoning.desc": [
    "响应期间平均每秒产生的推理 token",
    "Reasoning tokens per second while responding",
  ],
  "perf.comp.pace": ["行动节奏", "Tool pace"],
  "perf.comp.pace.desc": ["每个活跃分钟调用工具的次数", "Tool calls per active minute"],
  "perf.comp.pace.count": ["共 %d 次工具调用", "%d tool calls in all"],
  "perf.comp.toolTime": ["工具耗时", "Tool time"],
  "perf.comp.toolTime.desc": [
    "工具从调用到返回结果的典型时间",
    "Typical time from a tool call to its result",
  ],
  "perf.comp.toolSuccess": ["工具成功率", "Tool success"],
  "perf.comp.toolSuccess.desc": [
    "没有返回错误的工具调用比例",
    "Share of tool calls that returned without an error",
  ],
  "perf.comp.cache": ["缓存命中", "Cache hits"],
  "perf.comp.cache.desc": [
    "输入 token 中从缓存读取的比例",
    "Share of input tokens read from the cache",
  ],
  "perf.reason.notRecorded": ["不记录", "Not recorded"],
  "perf.reason.notRecorded.hint": [
    "%@ 不记录这项数据，所以不计入分数，也不会扣分。",
    "%@ doesn't record this, so it is left out of the score rather than counted against it.",
  ],
  "perf.reason.fewSamples": ["样本不足", "Too few"],
  "perf.reason.fewSamples.hint": [
    "数据不到 %d 条，暂不计入分数。",
    "Fewer than %d values, so it is left out for now.",
  ],
  "perf.unit.ms": ["%@ 毫秒", "%@ ms"],
  "perf.unit.s": ["%@ 秒", "%@ s"],
  "perf.unit.min": ["%@ 分钟", "%@ min"],
  "perf.unit.perMin": ["%@ 次/分", "%@/min"],
  "perf.card.sample": ["有效计时请求 %d 个 · 近 30 分钟", "%d timed requests · last 30 minutes"],
  "perf.card.footnote": [
    "1000 是参考水平，没有上限；参考值依开发者的实际记录校准，不是业界标准。OMP Desktop 仅在本机计算与保存数值性能统计，不会上报。",
    "1000 is the reference level, with no upper limit; the reference values were calibrated on the developer's own logs, not an industry standard. OMP Desktop computes and saves numeric performance statistics on this computer only; they are never reported.",
  ],
  "perf.signals.title": ["行为", "Behavior"],
  "perf.tooltip.top": ["性能 %@ · 最高：%@", "Perf %@ · top: %@"],
  "perf.tooltip.note": ["1000 为参考水平，没有上限", "1000 is the reference level; no upper limit"],
  "a11y.perf.provisional": ["%@，初步（样本少）", "%@, provisional (few samples)"],
  "a11y.perf.idle": ["%@，空闲中", "%@, idle"],
  "a11y.perf.top": ["%@，%d 个 agent 中最高", "%@, the highest of %d agents"],
  "a11y.perf.card": ["性能分析详情", "Performance details"],
  "a11y.perf.score": ["性能 %@，%@", "performance %@, %@"],
  "a11y.perf.usual.up": ["比平常高 %@", "%@ above usual"],
  "a11y.perf.usual.down": ["比平常低 %@", "%@ below usual"],
  "a11y.perf.usual.same": ["和平常一样", "same as usual"],
  "a11y.perf.comp": ["%@：%@，分数 %@", "%@: %@, score %@"],
  "a11y.perf.comp.absent": ["%@：%@", "%@: %@"],
  "history.perf.title": ["性能表现", "Performance"],
  "history.perf.info": [
    "性能是 Agent Speed 依响应与工具记录算出的跑分：1000 是参考水平，没有上限，越高越快。这里把所选期间每个来源与模型的记录合并后计算，至少要有 20 个有效计时请求才有分数；每日趋势只画有 20 个以上的日子。参考值依开发者的实际记录校准，不是业界标准。",
    "Performance is a benchmark-style score Agent Speed computes from response and tool records: 1000 is the reference level, there is no upper limit, and higher is faster. Here the records of each source and model are pooled over the selected range, and a score needs at least 20 timed requests; the daily trend shows only days with 20 or more. The reference values were calibrated on the developer's own logs, not an industry standard.",
  ],
  "history.perf.info.a11y": ["这些数字怎么算", "How these numbers are computed"],
  "history.perf.trend": ["每日趋势 · %@", "Daily trend · %@"],
  "history.perf.trend.days": ["截至 %@ 的 14 天", "14 days to %@"],
  "history.perf.usual.line": ["平常 %@", "Usual %@"],
  "history.perf.usual.hint": [
    "同一个来源与模型在这台电脑上，今天之前 14 天合并计算的分数；面板与看板上的“比平常”就是和它相比。",
    "The pooled score of this source and model on this computer over the 14 days before today, which “vs usual” on the dashboard and boards compares with.",
  ],
  "history.perf.column.model": ["模型", "Model"],
  "history.perf.column.score": ["性能", "Perf"],
  "history.perf.column.usual": ["平常", "Usual"],
  "history.perf.column.timed": ["计时请求", "Timed"],
  "history.perf.column.timed.full": ["有效计时请求", "Timed requests"],
  "history.perf.column.parts": ["构成", "Breakdown"],
  "history.perf.column.throughput": ["吞吐", "Output"],
  "history.perf.column.latency": ["首段延迟", "Latency"],
  "history.perf.column.reasoning": ["思考", "Thinking"],
  "history.perf.column.pace": ["节奏", "Pace"],
  "history.perf.column.toolTime": ["工具耗时", "Tool time"],
  "history.perf.column.toolSuccess": ["工具成功", "Tool OK"],
  "history.perf.column.cache": ["缓存", "Cache"],
  "history.perf.sample.low": ["样本少", "Few samples"],
  "history.perf.sample.hint": [
    "只有 %d 个有效计时请求；至少要 %d 个才会算出分数。",
    "Only %d timed requests; a score needs at least %d.",
  ],
  "history.perf.requests": ["%d 个计时请求", "%d timed"],
  "history.perf.empty": ["这段期间没有有效计时的请求", "No timed requests in this period"],
  "history.perf.empty.hint": [
    "性能需要有计时数据的请求。这个版本分析之前记录就已删除的日子，只有用量总计，没有性能数据。",
    "Performance needs timed requests. Days whose logs were deleted before this version could analyze them keep their totals but have no performance data.",
  ],
  "history.perf.analyzing": ["正在重新分析过去的记录…", "Re-analyzing past logs…"],
  "history.perf.footnote": [
    "每个来源与模型分开合并计算；每天至少要有 20 个有效计时请求才画进趋势。参考值依开发者的实际记录校准，不是业界标准。",
    "Each source and model is pooled on its own; a day needs 20 timed requests to appear in the trend. The reference values were calibrated on the developer's own logs, not an industry standard.",
  ],
  "a11y.history.perf.chart": [
    "%@ 的每日性能：最低 %@，最高 %@，最近一天 %@",
    "Daily performance of %@: lowest %@, highest %@, latest %@",
  ],
  "a11y.history.perf.chart.empty": [
    "%@ 的每日性能：这段期间没有数据足够的日子",
    "Daily performance of %@: no day in this period has enough data",
  ],
  "a11y.history.perf.parts": ["构成：%@", "Breakdown: %@"],
  "speed.tooltip": ["加速：%@", "Speed: %@"],
  "speed.value.standard": ["标准", "Standard"],
  "speed.value.fast": ["Fast", "Fast"],
  "speed.value.ultrafast": ["Ultrafast", "Ultrafast"],
  selectedMode: [
    "当前选定的模式；不是服务端已执行的证明。",
    "Selected mode; not proof of server execution.",
  ],
  recordedMode: ["日志记录的执行模式。", "Execution mode recorded in the log."],
  showScore: ["显示性能", "Show performance"],
  showScoreHint: [
    "显示性能跑分、分析卡和悬浮球读数。1000 是参考水平，没有上限；仅在本机计算，不会上报。",
    "Show the performance score, analysis card and orb readout. 1000 is the reference level with no upper limit. Computed locally; never reported.",
  ],
  showThinking: ["显示思考速度", "Show thinking speed"],
  showThinkingHint: [
    "显示当前生成的推理 token 速度；已知为零 3 秒后隐藏，未知数据不会变成零。",
    "Show the reasoning tokens generating now. A known zero hides after 3 seconds; unknown data is never turned into zero.",
  ],
  limited: [
    "性能记录覆盖有限；仅包含已分析的数值记录。",
    "Performance coverage is limited; only analyzed numeric records are included.",
  ],
  scanning: [
    "正在分析记录；当前统计尚未覆盖全部记录。",
    "Analyzing logs; current statistics do not cover every record yet.",
  ],
  noModel: ["无模型元数据", "No model metadata"],
  source: ["OMP", "OMP"],
  close: ["关闭", "Close"],
  copy: ["复制此行", "Copy row"],
  copied: ["已复制", "Copied"],
  copyUnavailable: ["无法使用剪贴板", "Clipboard unavailable"],
  sort: ["排序", "Sort"],
  reverseSort: ["切换排序方向", "Reverse sort direction"],
} as const;

export const MONITOR_PERF_CSS = String.raw`
.perf-theme { --ui: "Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;
  --disp: "Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;
  font-family: var(--ui); color: var(--ink); }
body[data-appearance="dark"] .perf-theme {
  color-scheme: dark; --ink: rgba(255,255,255,.92); --ink-2: rgba(235,235,245,.64); --ink-3: rgba(235,235,245,.36);
  --cap: rgba(235,235,245,.56); --line: rgba(255,255,255,.09); --line-2: rgba(255,255,255,.14);
  --fill: rgba(255,255,255,.055); --fill-2: rgba(255,255,255,.1); --card-bg: rgba(38,38,42,.9); --card-line: rgba(255,255,255,.12);
  --card-shadow: 0 22px 56px rgba(0,0,0,.55),0 2px 10px rgba(0,0,0,.35); --score: #93A4D6; --track: rgba(255,255,255,.09);
  --pearl-a: #C7D2FE; --pearl-b: #F5D0FE; --pearl-c: #A5F3FC; --mint-ink: #6EE7B7; --mint-bg: rgba(52,211,153,.14);
  --amber: #F5A524; --win: #1e1e20; --win-card: rgba(255,255,255,.045); --row-2: rgba(255,255,255,.03); --sel: rgba(120,140,200,.2);
  --orb-num: rgba(255,255,255,.8); --orb-unit: rgba(255,255,255,.5); --focus: #8fb2ff;
}
body[data-appearance="light"] .perf-theme {
  color-scheme: light; --ink: rgba(0,0,0,.86); --ink-2: rgba(60,60,67,.76); --ink-3: rgba(60,60,67,.42);
  --cap: rgba(60,60,67,.72); --line: rgba(0,0,0,.08); --line-2: rgba(0,0,0,.12);
  --fill: rgba(0,0,0,.04); --fill-2: rgba(0,0,0,.075); --card-bg: rgba(251,251,253,.93); --card-line: rgba(0,0,0,.09);
  --card-shadow: 0 22px 50px rgba(24,28,44,.2),0 2px 8px rgba(24,28,44,.1); --score: #4B5FA6; --track: rgba(0,0,0,.07);
  --pearl-a: #6D7CF0; --pearl-b: #C05BD9; --pearl-c: #1AA3C4; --mint-ink: #047857; --mint-bg: rgba(16,185,129,.12);
  --amber: #B86E00; --win: #f5f5f7; --win-card: rgba(0,0,0,.035); --row-2: rgba(0,0,0,.025); --sel: rgba(60,90,180,.12);
  --orb-num: rgba(11,13,18,.8); --orb-unit: rgba(0,0,0,.5); --focus: #2f5bd8;
}
.perf-theme [hidden],.perf-theme[hidden] { display:none!important; }
.perf-sr-only { position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0; }
.perf-pm,.perf-score-value,.perf-c-big,.perf-n { position:relative;display:inline-block;line-height:1; }
.perf-score-value::after,.perf-c-big::after,.perf-n::after { content:"";position:absolute;left:0;right:0;opacity:0;transition:opacity .25s;--d:max(1px,.1em);top:calc(1.075em - var(--d)/2);height:var(--d);pointer-events:none;
  background:color-mix(in srgb,currentColor 70%,transparent);-webkit-mask:radial-gradient(circle closest-side,#000 92%,transparent 100%) 0 0 / calc(var(--d)*2.4) var(--d) space no-repeat;
  mask:radial-gradient(circle closest-side,#000 92%,transparent 100%) 0 0 / calc(var(--d)*2.4) var(--d) space no-repeat; }
.perf-pm::after { opacity:1; }
.perf-score-cell { display:inline-flex;justify-content:flex-end;align-items:center;min-width:35px;font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap; }
.perf-score-value,.perf-c-big,.perf-n { transition:color .2s; }
.perf-crossfade::before { content:attr(data-perf-outgoing);position:absolute;inset:0;opacity:var(--perf-outgoing-alpha,0);white-space:nowrap;pointer-events:none; }
.perf-crossfade>.perf-number-incoming { opacity:var(--perf-incoming-alpha,1); }
.perf-score-cell .perf-crossfade::before { text-align:right; }
.perf-score-cell[data-form="resting"],.perf-score-cell[data-form="none"] { color:var(--ink-3); }
.agent-row[data-perf-score="true"] { grid-template-columns:minmax(0,1fr) 24px auto minmax(35px,max-content) 56px;column-gap:6px; }
.agent-row[data-perf-score="false"][data-perf-mode="true"] { grid-template-columns:minmax(0,1fr) 24px auto 56px;column-gap:6px; }
.agent-row[data-perf-score="true"] .perf-mode-cell { grid-column:3; }.agent-row[data-perf-score="true"] .perf-score-cell { grid-column:4; }.agent-row[data-perf-score="true"] .agent-speed { grid-column:5; }
.agent-row[data-perf-score="false"][data-perf-mode="true"] .perf-mode-cell { grid-column:3; }.agent-row[data-perf-score="false"][data-perf-mode="true"] .agent-speed { grid-column:4; }
.agent-row[data-perf-open="true"] { background:var(--fill); }
.agent-row[data-perf-agent-id]:focus-visible,[data-perf-agent-id]:focus-visible { outline:2px solid var(--focus,#6798ef);outline-offset:2px; }
.perf-mode-cell { display:inline-flex;align-items:center; }
.perf-capsule { display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 6px;border-radius:9px;background:var(--fill);box-shadow:inset 0 0 0 .5px var(--line-2); }
.perf-bolt { color:var(--amber);display:inline-flex;position:relative;width:9px;height:10px;font-size:9px;line-height:1; }
.perf-bolt svg { position:relative;width:9px;height:10px; }.perf-bolt[data-bolts="2"] { width:15px; }.perf-bolt[data-bolts="2"] svg:first-child { opacity:.6; }.perf-bolt[data-bolts="2"] svg+svg { position:absolute;left:6px;top:0; }
.perf-card { width:320px;border-radius:8px;padding:14px;background:var(--card-bg);color:var(--ink);border:1px solid var(--card-line);box-shadow:var(--card-shadow);text-align:left;
  backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%); }
.perf-card-float { position:fixed;z-index:60;pointer-events:none;max-height:calc(100vh - 16px);overflow:auto;scrollbar-width:thin; }
.perf-c-head { display:flex;align-items:center;gap:7px;min-width:0; }
.perf-c-head .perf-dot { width:7px;height:7px;border-radius:50%;flex:none; }
.perf-c-head b { font-size:13px;font-weight:650;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.perf-c-meta { margin:3px 0 0 14px;font-size:11px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.perf-chip { display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:9px;flex:none;font-size:11px;font-weight:600;letter-spacing:.01em;white-space:nowrap;font-variant-numeric:tabular-nums; }
.perf-chip svg { flex:none; }
.perf-chip-up { color:var(--mint-ink);background:var(--mint-bg); }
.perf-chip-flat { color:var(--ink-2);background:color-mix(in srgb,var(--ink) 6%,transparent); }
.perf-chip-dot { color:var(--ink-2);position:relative;padding-left:6px; }
.perf-chip-dot::before { content:"";position:absolute;inset:0;border-radius:inherit;border:1px dotted color-mix(in srgb,var(--ink) 35%,transparent); }
.perf-c-score { margin-top:12px;padding-top:12px;border-top:.5px solid var(--line); }
.perf-c-eyebrow { font-size:11px;color:var(--ink-2);margin-bottom:3px; }
.perf-c-top { display:flex;align-items:center;justify-content:space-between;gap:10px; }
.perf-c-big { font-family:var(--disp);font-size:34px;line-height:1;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums; }
.perf-c-big.perf-is-pale { color:var(--ink-2); }
.perf-c-big.perf-is-none { color:var(--ink-3);font-weight:500; }
.perf-c-big.perf-pm::after { top:calc(1.04em - var(--d)/2); }
.perf-scale { position:relative;margin-top:10px;height:6px; }
.perf-scale .perf-track { position:absolute;inset:0;border-radius:3px;background:var(--track); }
.perf-scale .perf-fill { position:absolute;inset:0;border-radius:3px;background:linear-gradient(90deg,var(--pearl-c),var(--pearl-a) 50%,var(--pearl-b));clip-path:inset(0 calc(100% - var(--f,0)*100%) 0 0 round 3px); }
.perf-scale.perf-is-pale .perf-fill { opacity:.45; }
.perf-scale.perf-is-prov .perf-fill { -webkit-mask:radial-gradient(circle closest-side,#000 94%,transparent 100%) 0 50% / 13.2px 6px repeat-x;mask:radial-gradient(circle closest-side,#000 94%,transparent 100%) 0 50% / 13.2px 6px repeat-x; }
.perf-scale .perf-tick { position:absolute;top:-2px;width:1px;height:10px;margin-left:-.5px;background:color-mix(in srgb,var(--ink) 18%,transparent); }
.perf-scale .perf-tick.perf-ref { top:-4px;height:14px;background:color-mix(in srgb,var(--ink) 45%,transparent); }
.perf-scale-labels { position:relative;height:11px;margin-top:4px;font-size:9.5px;line-height:11px;color:var(--ink-3);font-variant-numeric:tabular-nums; }
.perf-scale-labels span { position:absolute;transform:translateX(-50%);white-space:nowrap; }
.perf-scale-labels .perf-ref { color:var(--ink-2);font-weight:600; }
.perf-scale-labels .perf-end { transform:translateX(-100%); }
.perf-c-summary { margin-top:8px;font-size:12px;line-height:1.42;color:var(--ink-2); }
.perf-c-hint { margin-top:4px;font-size:11px;line-height:1.4;color:var(--ink-3); }
.perf-comps { display:grid;grid-template-columns:minmax(0,1fr) minmax(64px,max-content) 10px 44px 8px minmax(34px,max-content);align-items:center;margin-top:14px; }
.perf-comps .perf-group-title { grid-column:1/-1;font-size:11px;font-weight:650;letter-spacing:.06em;color:var(--ink-3);margin:0 0 7px; }
html[lang="en"] .perf-group-title { text-transform:uppercase;font-size:10.5px; }
.perf-comps .perf-group-title:not(:first-child) { margin-top:14px; }
.perf-comps .perf-label { grid-column:1;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:8px; }
.perf-comps .perf-value { grid-column:2;text-align:right;font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap; }
.perf-comps .perf-value.perf-absent { font-size:11.5px;color:var(--ink-3); }
.perf-comps .perf-mm { grid-column:4; }
.perf-comps .perf-subscore { grid-column:6;text-align:right;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums; }
.perf-comps .perf-subscore.perf-absent { color:var(--ink-3);font-weight:500; }
.perf-comps .perf-meaning { grid-column:1/-1;margin:3px 0 9px;font-size:10.5px;line-height:1.38;color:var(--cap); }
.perf-comps .perf-meaning:last-child { margin-bottom:0; }
.perf-mm { display:inline-block;position:relative;height:4px;border-radius:2px;background:var(--track); }
.perf-mm i { position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:var(--score);transition:width .35s cubic-bezier(.2,.8,.2,1); }
.perf-mm b { position:absolute;left:50%;top:-2px;width:1px;height:8px;margin-left:-.5px;background:color-mix(in srgb,var(--ink) 35%,transparent); }
.perf-mm.perf-dotted { background:radial-gradient(circle closest-side,color-mix(in srgb,var(--ink) 18%,transparent) 94%,transparent 100%) 0 50% / 8.8px 4px repeat-x; }
.perf-mm.perf-dotted b { display:none; }
.perf-c-facts { margin-top:12px;padding-top:9px;border-top:.5px solid var(--line);font-size:11px;line-height:1.5;color:var(--ink-2);white-space:pre-line;overflow-wrap:anywhere; }
.perf-c-foot { margin-top:8px;font-size:10.5px;line-height:1.45;color:var(--cap); }
.perf-card[data-compact="1"] .perf-meaning,.perf-card[data-compact="2"] .perf-meaning { display:none; }
.perf-card[data-compact="1"] .perf-comps,.perf-card[data-compact="2"] .perf-comps { row-gap:9px; }
.perf-card[data-compact="2"] .perf-c-foot { display:none; }
.perf-history { container:perf-history / inline-size;position:relative;margin-top:18px;border-radius:14px;padding:16px 18px 14px;background:var(--win-card);min-width:0; }
.perf-history-head { display:flex;align-items:center;gap:8px; }
.perf-history-head h2 { margin:0;font-size:15px;font-weight:650; }
.perf-info-button { display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--ink-3);color:var(--ink-2);font-size:10px;font-weight:700;font-family:var(--disp);background:none;cursor:help;padding:0; }
.perf-history-sort { margin-left:auto;display:flex;gap:5px;align-items:center; }
.perf-history-sort select { max-width:135px;font-size:11px; }
.perf-sort-direction,.perf-copy-button { border:0;border-radius:5px;background:var(--fill);color:var(--ink-2);font-size:11px;padding:3px 7px; }
.perf-trend-title { display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 14px;margin-top:12px; }
.perf-trend-title .perf-tt { font-size:12px;color:var(--ink-2);min-width:0;overflow-wrap:anywhere; }
.perf-trend-title .perf-tt b { color:var(--ink);font-weight:550; }
.perf-legend { margin-left:auto;display:flex;gap:14px;font-size:11px;color:var(--ink-3);white-space:nowrap;font-variant-numeric:tabular-nums; }
.perf-legend span { display:inline-flex;align-items:center;gap:5px; }
.perf-chart-wrap { position:relative; }
.perf-chart { display:block;width:100%;height:150px;margin-top:8px;overflow:visible;outline-offset:2px; }
.perf-chart .perf-axis { font-size:9.5px;fill:var(--ink-3);font-family:var(--ui);font-variant-numeric:tabular-nums; }
.perf-chart .perf-axis.perf-ref { fill:var(--ink-2);font-weight:600; }
.perf-chart .perf-grid { stroke:var(--line);stroke-width:1; }
.perf-chart .perf-ref { stroke:color-mix(in srgb,var(--ink) 35%,transparent);stroke-width:1; }
.perf-chart-empty { font-size:12px;fill:var(--ink-3); }
.perf-point-tip { position:absolute;z-index:2;pointer-events:none;padding:7px 10px;border-radius:8px;font-size:11.5px;line-height:1.45;background:var(--card-bg);border:.5px solid var(--card-line);box-shadow:var(--card-shadow);white-space:pre-line;font-variant-numeric:tabular-nums; }
.perf-point-tip b { font-size:13px; }
.perf-table { width:100%;border-collapse:separate;border-spacing:0;margin-top:12px;font-size:12px;font-variant-numeric:tabular-nums;table-layout:auto; }
.perf-table th { font-size:11px;font-weight:600;line-height:1.25;color:var(--ink-2);text-align:right;padding:6px 7px;vertical-align:bottom;border-bottom:.5px solid var(--line-2);white-space:nowrap; }
.perf-table th button { border:0;padding:0;background:none;color:inherit;font:inherit; }
.perf-table th:first-child,.perf-table td:first-child { text-align:left;padding-left:8px; }
.perf-table td { text-align:right;padding:0 7px;height:30px;white-space:nowrap; }
.perf-table tbody tr:nth-child(even) td { background:var(--row-2); }
.perf-table tbody tr:hover td { background:var(--fill); }
.perf-table tbody tr.perf-selected td { background:var(--sel); }
.perf-table tbody tr td:first-child { border-radius:6px 0 0 6px; }
.perf-table tbody tr td:last-child { border-radius:0 6px 6px 0; }
.perf-table tr.perf-low td { color:var(--ink-2); }
.perf-table .perf-usual { color:var(--ink-2); }.perf-table .perf-low .perf-na { color:var(--ink-3); }.perf-col-parts { width:64px; }
.perf-table .perf-na { color:var(--ink-3); }
.perf-model-cell { display:flex;align-items:center;gap:7px;min-width:0;max-width:260px; }
.perf-source-dot { display:inline-block;width:7px;height:7px;border-radius:50%;flex:none;background:#93A4D6; }
.perf-model-id { font-size:12.5px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0; }
.perf-source-name { font-size:11px;color:var(--ink-2);flex:none; }
.perf-score-history { display:inline-flex;align-items:center;gap:8px;justify-content:flex-end; }
.perf-score-history b { font-size:13px;font-weight:600; }
.perf-score-history .perf-mm { width:36px; }
.perf-chip-sm { display:inline-flex;align-items:center;height:16px;padding:0 6px;font-size:10px;font-weight:600;border-radius:8px;color:var(--ink-2);position:relative;flex:none; }
.perf-chip-sm::before { content:"";position:absolute;inset:0;border-radius:inherit;border:1px dotted color-mix(in srgb,var(--ink) 40%,transparent); }
.perf-parts { display:inline-flex;align-items:flex-end;gap:2px;height:20px;position:relative;vertical-align:middle; }
.perf-parts i { width:5px;height:20px;border-radius:1.5px;background:var(--track);position:relative;overflow:hidden; }
.perf-parts i::after { content:"";position:absolute;left:0;right:0;bottom:0;height:calc(var(--f)*100%);background:var(--score);border-radius:1.5px; }
.perf-parts i.perf-na { background:none; }
.perf-parts i.perf-na::after { height:1px;background:none;border-top:1px dotted var(--ink-3); }
.perf-parts::before { content:"";position:absolute;left:-2px;right:-2px;top:50%;border-top:1px dashed color-mix(in srgb,var(--ink) 30%,transparent);z-index:1; }
.perf-col-parts,.perf-list { display:none; }
.perf-history-foot { margin-top:12px;font-size:11px;color:var(--cap); }
.perf-list-item { padding:9px 8px;border-bottom:.5px solid var(--line);border-radius:6px; }
.perf-list-item.perf-selected { background:var(--sel); }
.perf-list-line { display:flex;align-items:center;gap:7px;font-size:12.5px; }
.perf-list-line .perf-list-score { margin-left:auto;flex:none; }
.perf-list-secondary { margin-top:3px;font-size:11px;line-height:1.45;color:var(--ink-2);font-variant-numeric:tabular-nums;overflow-wrap:anywhere; }
.perf-history-state { display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px;padding:26px 12px 20px; }
.perf-history-state svg { color:var(--ink-3); }
.perf-history-state b { font-size:13px;font-weight:600;color:var(--ink-2); }
.perf-history-state span { font-size:11.5px;line-height:1.45;color:var(--cap);max-width:360px; }
.perf-skeleton { display:grid;gap:10px;margin-top:14px; }
.perf-skeleton i { display:block;height:9px;border-radius:4px;background:var(--fill-2); }
.perf-info { position:fixed;z-index:65;width:340px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;padding:14px;border-radius:8px;background:var(--card-bg);border:1px solid var(--card-line);box-shadow:var(--card-shadow);font-size:12px;line-height:1.5; }
.perf-info h2 { margin:0 28px 9px 0;font-size:15px; }
.perf-info-close { position:absolute;top:8px;right:8px;width:24px;height:24px;border:0;border-radius:5px;background:var(--fill);color:var(--ink); }
.perf-info dt { font-weight:600;margin-top:9px; }
.perf-info dd { margin:3px 0 0;color:var(--ink-2); }
.perf-copy-menu { position:fixed;z-index:70;padding:4px;background:var(--card-bg);border:1px solid var(--card-line);border-radius:8px;box-shadow:var(--card-shadow); }
.perf-copy-menu button { border:0;background:none;padding:6px 12px;border-radius:5px;color:var(--ink); }
.perf-orb-lines { position:absolute;inset:0;z-index:5;pointer-events:none;visibility:hidden;transform:scale(var(--as-hover,1));transform-origin:center; }
.perf-orb-lines .perf-ln { position:absolute;left:0;right:0;text-align:center;line-height:1;white-space:nowrap; }
.perf-orb-lines .perf-ln-score { font-size:var(--perf-p); }
.perf-orb-lines .perf-ln-thinking { font-size:var(--perf-t); }
.perf-orb-lines .perf-glyph { font-size:.82em;font-weight:600;color:var(--orb-unit);margin-right:.2em; }
.perf-orb-lines .perf-ln-thinking .perf-glyph { margin-right:.16em; }
.perf-orb-lines .perf-n { font-weight:600;font-variant-numeric:tabular-nums;color:var(--orb-num); }
.perf-orb-lines .perf-is-pale .perf-n,.perf-orb-lines .perf-is-quiet .perf-n { color:var(--orb-unit); }
.perf-orb-lines .perf-unit { font-size:.82em;font-weight:500;color:var(--orb-unit);margin-left:.16em; }
@container perf-history (max-width:859px) { .perf-col-comp{display:none}.perf-col-parts{display:table-cell}.perf-model-cell{max-width:220px}.perf-chart{height:132px} }
@container perf-history (max-width:599px) { .perf-table{display:none}.perf-list{display:block;margin-top:10px}.perf-chart{height:120px}.perf-legend{margin-left:0}.perf-history-sort select{max-width:100px} }
@media (prefers-reduced-transparency:reduce) { body[data-appearance="dark"] .perf-card,body[data-appearance="dark"] .perf-info{background:#26272B;backdrop-filter:none}body[data-appearance="light"] .perf-card,body[data-appearance="light"] .perf-info{background:#fff;backdrop-filter:none} }
@media (prefers-reduced-motion:reduce) { .perf-mm i,.perf-score-value::after,.perf-c-big::after,.perf-n::after{transition:none} }
body[data-effects="off"] .perf-mm i,body[data-effects="off"] .perf-score-value::after,body[data-effects="off"] .perf-c-big::after,body[data-effects="off"] .perf-n::after { transition:none; }
@media (prefers-contrast:more) { .perf-theme{--ink-3:var(--ink-2)!important;--cap:var(--ink-2)!important;--score:var(--ink)!important;--track:color-mix(in srgb,var(--ink) 25%,transparent)!important}.perf-scale .perf-fill{background:var(--ink)}.perf-chip,.perf-chip-sm{box-shadow:inset 0 0 0 1px currentColor}.perf-pm::after{--d:max(1.5px,calc(.1em + .5px));background:currentColor} }
@media (forced-colors:active) { .perf-theme{--ink:CanvasText!important;--ink-2:CanvasText!important;--ink-3:GrayText!important;--cap:CanvasText!important;--score:Highlight!important;--track:GrayText!important;--card-bg:Canvas!important;--card-line:CanvasText!important;--line:GrayText!important;--line-2:GrayText!important;--focus:Highlight!important;--orb-num:CanvasText!important;--orb-unit:GrayText!important}.perf-scale .perf-fill{background:Highlight}.perf-chip,.perf-chip-sm{color:CanvasText!important;background:none!important;box-shadow:inset 0 0 0 1px CanvasText}.perf-pm::after{background:CanvasText}.perf-orb-lines{visibility:visible}.perf-card,.perf-info{backdrop-filter:none}.perf-table tbody tr.perf-selected td,.perf-list-item.perf-selected{outline:1px solid Highlight} }
`;

export const MONITOR_PERF_MARKUP = String.raw`
<template id="perf-ui-markup">
  <div id="perf-score-card" class="perf-theme perf-card perf-card-float" role="tooltip" hidden></div>
  <section id="perf-performance" class="perf-theme perf-history" role="group" aria-labelledby="perf-performance-title">
    <div class="perf-history-head"><h2 id="perf-performance-title"></h2><button id="perf-performance-info" type="button" class="perf-info-button" aria-expanded="false" aria-controls="perf-history-info">i</button><div class="perf-history-sort"><select id="perf-model-sort"></select><button id="perf-sort-direction" class="perf-sort-direction" type="button">↓</button></div></div>
    <div id="perf-history-content"></div><div id="perf-history-note" class="perf-history-foot" role="status"></div><div id="perf-performance-footnote" class="perf-history-foot"></div>
  </section>
  <div id="perf-readout-settings"><div class="settings-card"><span class="symbol" aria-hidden="true">&#xE9D9;</span><div><h2 id="perf-score-setting-label"></h2><p id="perf-score-setting-hint"></p></div><label class="toggle"><input id="show-performance" type="checkbox" aria-labelledby="perf-score-setting-label" aria-describedby="perf-score-setting-hint"><span class="toggle-track" aria-hidden="true"></span></label></div><div class="settings-card"><span class="symbol" aria-hidden="true">&#xEA80;</span><div><h2 id="perf-thinking-setting-label"></h2><p id="perf-thinking-setting-hint"></p></div><label class="toggle"><input id="show-thinking" type="checkbox" aria-labelledby="perf-thinking-setting-label" aria-describedby="perf-thinking-setting-hint"><span class="toggle-track" aria-hidden="true"></span></label></div></div>
  <div id="perf-history-info" class="perf-theme perf-info" role="dialog" aria-modal="false" aria-labelledby="perf-info-title" hidden><button id="perf-info-close" class="perf-info-close" type="button">×</button><h2 id="perf-info-title"></h2><p id="perf-info-intro"></p><dl id="perf-info-definitions"></dl><p id="perf-info-disclaimer"></p></div>
  <div id="perf-copy-menu" class="perf-theme perf-copy-menu" role="menu" hidden><button id="perf-copy-row" type="button" role="menuitem"></button></div><span id="perf-copy-status" class="perf-sr-only" role="status"></span>
</template>
`;

export const MONITOR_PERF_SCRIPT =
  `const perfStrings = ${JSON.stringify(performanceStrings).replace(/</g, "\\u003c")};\n` +
  `const perfModel = ${PERFORMANCE_MODEL_SCRIPT};\n` +
  `const perfNumber = ${performanceNumber.toString()};\n` +
  `const perfThinkingVisibility = ${performanceThinkingVisibility.toString()};\n` +
  `const perfScale = ${performanceScale.toString()};\n` +
  `const perfMotionDuration = ${performanceMotionDuration.toString()};\n` +
  String.raw`
const perfSvgNamespace = 'http://www.w3.org/2000/svg';
const perfMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const perfContrastQuery = window.matchMedia('(prefers-contrast: more)');
const perfForcedColorsQuery = window.matchMedia('(forced-colors: active)');
const perfComponents = [
  {id:'T',key:'throughput'}, {id:'L',key:'latency'}, {id:'R',key:'reasoning'},
  {id:'N',key:'pace'}, {id:'U',key:'toolTime'}, {id:'S',key:'toolSuccess'}, {id:'H',key:'cache'}
];
const perfListeners = [], perfEffects = new Set(), perfNumberAnimations = new Map(), perfRowValues = new Map(), perfReadouts = new Map();
const perfCellWidths = new Map(), perfFontWidths = new Map();
const perfNumberFades = new Map();
let perfBound = false, perfDestroyed = false, perfSnapshot = null, perfCardView = null, perfCardState = null;
let perfHoverTimer = null, perfHideTimer = null, perfWakeTimer = null, perfRaf = 0, perfLastRaf = 0, perfScopeKey = '', perfLastPeak = null;
let perfHoveredAnchor = null, perfDismissedAnchor = null, perfDescriptionSerial = 0, perfMeasurement = null;
let perfHistoryKey = '', perfHistoryRows = [], perfHistoryRecords = [], perfHistorySelected = null, perfHistorySort = 'score', perfHistoryDescending = true;
let perfCopyModel = null, perfChartState = null, perfChartIndex = -1, perfChartObserver = null;
function perfT(key, ...args) {
  const entry = perfStrings[key]; let index = 0;
  const source = entry ? entry[language === 'zh' ? 0 : 1] : key;
  return source.replace(/%(%|@|d)/g, (all, token) => token === '%' ? '%' : String(args[index++]));
}
function perfText(element, value) { const next = String(value); if (element && element.textContent !== next) element.textContent = next; }
function perfElement(tag, className, value) { const element = document.createElement(tag); if (className) element.className = className; if (value !== undefined) perfText(element, value); return element; }
function perfSvg(tag, attrs) { const element = document.createElementNS(perfSvgNamespace, tag); for (const [name, value] of Object.entries(attrs || {})) element.setAttribute(name, String(value)); return element; }
function perfRound(value) { return value === null || value === undefined ? null : Math.floor(value + .5); }
function perfGrouped(value) { return value === null ? '–' : String(perfRound(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function perfSpeed(value) {
  if (value === null || value === undefined) return '–';
  if (value < .05) return '0';
  if (Math.round(value * 10) < 100) return value.toFixed(1);
  if (Math.round(value) < 1000) return String(Math.round(value));
  for (const unit of [[1000,'k'],[1000000,'M'],[1000000000,'B']]) {
    const scaled = value / unit[0];
    if (Math.round(scaled * 100) < 1000) return scaled.toFixed(2) + unit[1];
    if (Math.round(scaled * 10) < 1000) return scaled.toFixed(1) + unit[1];
    if (Math.round(scaled) < 1000 || unit[1] === 'B') return scaled.toFixed(0) + unit[1];
  }
  return String(Math.round(value));
}
function perfOneDecimal(value) { return Math.round(value * 10) < 100 ? value.toFixed(1) : String(Math.round(value)); }
function perfDuration(ms) {
  if (ms === null || ms === undefined) return '–';
  if (Math.round(ms) < 1000) return perfT('perf.unit.ms', Math.round(ms));
  const seconds = ms / 1000;
  if (Math.round(seconds * 10) < 100) return perfT('perf.unit.s', seconds.toFixed(1));
  if (Math.round(seconds) < 60) return perfT('perf.unit.s', Math.round(seconds));
  return perfT('perf.unit.min', perfOneDecimal(ms / 60000));
}
function perfMeasure(id, value) {
  if (value === null || value === undefined) return '–';
  if (id === 'T' || id === 'R') return perfSpeed(value) + ' tok/s';
  if (id === 'L' || id === 'U') return perfDuration(value);
  if (id === 'N') return perfT('perf.unit.perMin', perfOneDecimal(value));
  const rounded = Math.round(value * 100);
  return (value < 1 ? Math.min(99, rounded) : rounded) + '%';
}
function perfSigned(percent) { if (percent > 0) return '+' + percent + '%'; return percent < 0 ? '−' + Math.abs(percent) + '%' : '±0%'; }
function perfSourceName(source) { return source === 'omp' ? perfT('source') : String(source || perfT('source')); }
function perfSourceColor() { return '#84CC16'; }
function perfFacts() { return snapshotFacts(); }
function perfStatus(id) { const snapshot = perfFacts(); return snapshot && snapshot.performance ? snapshot.performance.current[id] || null : null; }
function perfAgent(id) { const snapshot = perfFacts(); return snapshot ? snapshot.agents.find(agent => agent.id === id) || null : null; }
function perfScoresEnabled() { return !!view && (view.surface === 'board' ? !!view.board && view.board.showPerformance !== false : view.preferences.showPerformance === true); }
function perfScoreWords(status, count = 0) {
  if (!status || status.shown === null) return perfT('intel.none');
  let words = perfGrouped(status.shown);
  if (status.provisional) words = perfT('a11y.perf.provisional', words);
  if (status.form === 'resting') words = perfT('a11y.perf.idle', words);
  return count >= 2 ? perfT('a11y.perf.top', words, count) : words;
}
function perfReadoutSentence(status,count,thinking) {
  if (status && status.shown !== null) {
    const words = perfScoreWords(status,count); return thinking === null ? perfT('a11y.orb.intel.only',words) : perfT('a11y.orb.intel',words,thinking);
  }
  if (thinking === null) return perfT('intel.none');
  return perfT('a11y.orb.intel','',thinking).replace(perfT('a11y.orb.intel.only',''),perfT('intel.none'));
}
function perfTier(value) {
  if (value < 700) return perfT('perf.tier.slow');
  if (value < 1300) return perfT('perf.tier.standard');
  return perfT(value < 2000 ? 'perf.tier.fast' : 'perf.tier.veryFast');
}
function perfPart(status, id) { return status && status.components.find(component => component.id === id) || {id,present:false,reason:'fewSamples',samples:0,measure:null,ratio:null,subScore:null}; }
function perfReason(component, source) { return component.reason === 'notRecorded' ? perfT('perf.reason.notRecorded.hint', perfSourceName(source)) : perfT('perf.reason.fewSamples.hint', 3); }
function perfSummary(status) {
  if (!status || status.shown === null) return perfT('perf.status.none', status ? status.n : 0, 3);
  const tier = perfTier(status.shown), ratio = (status.shown / 1000).toFixed(2);
  const present = perfComponents.map(component => ({id:component.id,key:component.key,part:perfPart(status,component.id)})).filter(component => component.part.present);
  if (present.length < 2) return perfT('perf.summary', tier, ratio);
  const slowest = present.reduce((low, component) => component.part.subScore < low.part.subScore ? component : low);
  return slowest.part.subScore < 1000 ? perfT('perf.summary.slowest', tier, ratio, perfT('perf.comp.' + slowest.key)) : perfT('perf.summary.allAbove', tier, ratio);
}
function perfUsualWords(status) {
  const value = status && status.vsUsualPercent;
  if (value === null || value === undefined) return perfT('perf.usual.none');
  if (!value) return perfT('a11y.perf.usual.same');
  return perfT(value > 0 ? 'a11y.perf.usual.up' : 'a11y.perf.usual.down', Math.abs(value) + '%');
}
function perfModeText(mode) {
  if (!mode) return '';
  const key = 'speed.value.' + mode.value, token = perfStrings[key] ? perfT(key) : mode.value;
  return perfT('speed.tooltip', token) + (mode.provider ? ' · ' + mode.provider : '') + '\n' + perfT(mode.evidence === 'recorded' ? 'recordedMode' : 'selectedMode');
}
function perfCardFacts(agent, status, extra) {
  const lines = [perfT('perf.card.sample', status ? status.n : 0)];
  if (agent.speedMode) lines.push(perfModeText(agent.speedMode));
  if (extra && extra.length) lines.push(...extra.filter(line => typeof line === 'string' && line.trim()));
  else {
    lines.push((language === 'zh' ? '配置：' : 'Profile: ') + agent.profile);
    const measured = finite(agent.liveMeasuredTps), estimated = finite(agent.liveEstimatedTps);
    const rate = measured === null && estimated === null ? null : (measured || 0) + (estimated || 0);
    lines.push((language === 'zh' ? '输出：' : 'Output: ') + perfSpeed(rate) + ' tok/s · TTFT: ' + (finite(agent.ttftMs) === null ? '–' : perfDuration(agent.ttftMs)));
    lines.push(timestamp(agent.lastActivityAt));
  }
  return lines;
}
function perfComponentMeaning(component, part, status, source) {
  if (!part.present) return perfReason(part, source);
  const meaning = perfT('perf.comp.' + component.key + '.desc');
  return component.id === 'N' ? meaning + ' · ' + perfT('perf.comp.pace.count', status.tools) : meaning;
}
function perfCardDescription(agent, status, options = {}) {
  const parts = [];
  if (status && status.shown !== null) {
    parts.push(perfT('a11y.perf.score', perfScoreWords(status, options.topCount || 0), perfTier(status.shown)), perfUsualWords(status), perfSummary(status));
    if (status.provisional) parts.push(perfT('perf.provisional.hint', status.n, 10));
    for (const component of perfComponents) {
      const part = perfPart(status, component.id), label = perfT('perf.comp.' + component.key);
      parts.push(part.present ? perfT('a11y.perf.comp', label, perfMeasure(component.id, part.measure), perfNumber(perfRound(part.subScore))) : perfT('a11y.perf.comp.absent', label, perfT('perf.reason.' + part.reason)));
      parts.push(perfComponentMeaning(component, part, status, agent.source || 'omp'));
    }
  } else parts.push(perfT('intel.none'), perfSummary(status));
  parts.push(...perfCardFacts(agent, status, options.facts), perfT('perf.card.footnote'));
  return parts.join(language === 'zh' ? '。' : '. ');
}
function perfListen(target, event, handler, options) { target.addEventListener(event, handler, options); perfListeners.push(() => target.removeEventListener(event, handler, options)); }
function perfReduced() { return perfMotionQuery.matches || !!view && view.preferences.effects === 'off'; }
function perfAnimate(element, frames, options) {
  if (typeof element.animate !== 'function' || document.hidden || element.closest('[hidden]')) return;
  const effect = element.animate(frames, options); perfEffects.add(effect);
  effect.onfinish = () => { perfEffects.delete(effect); effect.cancel(); };
  effect.oncancel = () => perfEffects.delete(effect);
}
function perfScheduleAnimation() { if (!perfDestroyed && !document.hidden && !perfRaf) perfRaf = requestAnimationFrame(perfAnimationTick); }
function perfDisplayNumber(element, value, compact, meter) {
  element.perfDisplayedValue = value; perfText(element, perfNumber(value, compact));
  if (element.perfAgentId) perfRowValues.set(element.perfAgentId,value);
  if (meter) meter.style.setProperty('--f', String(perfScale(value)));
}
function perfFinishNumberFade(element) {
  const fade = perfNumberFades.get(element); if (!fade) return;
  perfNumberFades.delete(element); element.classList.remove('perf-crossfade'); delete element.dataset.perfOutgoing;
  element.style.removeProperty('--perf-outgoing-alpha'); element.style.removeProperty('--perf-incoming-alpha'); perfText(element,perfNumber(fade.to,fade.compact));
}
function perfStartNumberFade(element,previous,value,compact,surface) {
  const fade = {from:previous,to:value,compact,surface,start:performance.now(),duration:150,fromProvisional:element.perfPreviousProvisional};
  perfNumberFades.set(element,fade); element.dataset.perfOutgoing = perfNumber(previous,compact); element.classList.add('perf-crossfade');
  element.replaceChildren(perfElement('span','perf-number-incoming',perfNumber(value,compact)));
  element.style.setProperty('--perf-outgoing-alpha','1'); element.style.setProperty('--perf-incoming-alpha','0'); perfScheduleAnimation();
}
function perfAnimateScore(element, value, surface, same = true, meter = null) {
  const previous = element.perfDisplayedValue, target = element.perfScoreValue;
  const compact = surface !== 'card';
  if (target === value) { if (!element.textContent) perfDisplayNumber(element,value,compact,meter); return; }
  perfNumberAnimations.delete(element); perfFinishNumberFade(element); element.perfScoreValue = value;
  if (!same || previous === undefined || document.hidden) { perfDisplayNumber(element,value,compact,meter); return; }
  const duration = value !== null && previous !== null ? perfMotionDuration(previous,value) : null;
  if (!perfReduced() && surface !== 'board-row' && duration !== null) {
    perfDisplayNumber(element,previous,compact,meter);
    perfNumberAnimations.set(element,{from:previous,to:value,start:performance.now(),duration,surface,compact,meter});
    perfScheduleAnimation(); return;
  }
  perfDisplayNumber(element,value,compact,meter);
  if (value !== previous && (value === null || previous === null || perfReduced())) perfStartNumberFade(element,previous,value,compact,surface);
}
function perfSetNumberState(element, status) {
  element.perfPreviousProvisional = element.classList.contains('perf-pm');
  element.classList.toggle('perf-pm', !!status && status.shown !== null && status.provisional);
  element.classList.toggle('perf-is-pale', !!status && status.form === 'resting');
  element.classList.toggle('perf-is-none', !status || status.shown === null);
}
function createPerfScoreCell(agent,host = 'dashboard') {
  const cell = perfElement('span','perf-theme perf-score-cell'), digits = perfElement('span','perf-score-value'), description = perfElement('span','perf-sr-only perf-score-description');
  cell.dataset.perfAgentId = agent.id; cell.dataset.perfCardHost = host; description.id = 'perf-score-description-' + (++perfDescriptionSerial);
  cell.append(digits,description); perfUpdateScoreCell(cell,agent); return cell;
}
function perfUpdateDashboardRow(cell,agent,status,enabled) {
  const row = cell.closest('.agent-row'); if (!row) return;
  row.dataset.perfScore = String(enabled);
  const modeCell = row.querySelector('.perf-mode-cell'); row.dataset.perfMode = String(!!modeCell && !modeCell.hidden && !!modeCell.firstElementChild);
  if (enabled) {
    row.dataset.perfAgentId = agent.id; row.dataset.perfCardHost = 'dashboard'; row.tabIndex = 0;
    if (row.title) { row.perfOriginalTitle = row.title; row.title = ''; }
    const summary = perfCardDescription(agent,status); perfText(cell.lastElementChild,summary);
    row.setAttribute('aria-describedby',cell.lastElementChild.id); row.setAttribute('aria-keyshortcuts','Space');
    row.setAttribute('aria-label',(agent.project || agent.name || agent.id) + ' · ' + (agent.model || perfT('noModel')) + ' · ' + perfScoreWords(status));
  } else {
    delete row.dataset.perfAgentId; delete row.dataset.perfCardHost;
    for (const attribute of ['aria-describedby','aria-label','aria-keyshortcuts','tabindex']) row.removeAttribute(attribute);
    if (row.perfOriginalTitle) row.title = row.perfOriginalTitle;
  }
}
function perfFitScoreCell(cell) {
  if (!cell.isConnected || cell.hidden || cell.dataset.perfCardHost === 'board') return;
  const digits = cell.firstElementChild, style = getComputedStyle(digits), font = [style.fontWeight,style.fontSize,style.fontFamily].join(' '), key = cell.dataset.perfAgentId, now = performance.now();
  if (!perfMeasurement) perfMeasureText('8,888',12,500); if (!perfMeasurement) return;
  perfMeasurement.font = font; let base = perfFontWidths.get(font);
  if (base === undefined) { base = Math.max(35,Math.ceil(perfMeasurement.measureText('8,888').width)); perfFontWidths.set(font,base); }
  let entry = perfCellWidths.get(key);
  if (!entry || entry.font !== font) { entry = {font,text:null,measured:base,width:base,until:0}; perfCellWidths.set(key,entry); }
  if (entry.text !== digits.textContent) { entry.text = digits.textContent; entry.measured = Math.ceil(perfMeasurement.measureText(entry.text).width); }
  const wanted = Math.max(base,entry.measured);
  if (wanted >= entry.width) { entry.width = wanted; entry.until = now+6000; }
  else if (now >= entry.until) entry.width = wanted;
  cell.style.minWidth = entry.width + 'px';
}
function perfUpdateScoreCell(cell,agent) {
  const status = perfStatus(agent.id), value = status ? status.shown : null, enabled = perfScoresEnabled(), digits = cell.firstElementChild;
  cell.hidden = !enabled; cell.dataset.form = status && value !== null ? status.form : 'none';
  const previous = perfRowValues.get(agent.id);
  digits.perfAgentId = agent.id;
  if (digits.perfScoreValue === undefined && previous !== undefined) { digits.perfScoreValue = previous; digits.perfDisplayedValue = previous; }
  perfSetNumberState(digits,status); perfAnimateScore(digits,value,cell.dataset.perfCardHost === 'board' ? 'board-row' : 'row');
  perfUpdateDashboardRow(cell,agent,status,enabled); perfFitScoreCell(cell);
}
function createModeCell(agent) {
  const cell = perfElement('span','perf-theme perf-mode-cell'), mode = agent.speedMode;
  cell.title = perfModeText(mode);
  if (mode) { cell.dataset.mode = mode.value; cell.dataset.evidence = mode.evidence; }
  let bolts = 0; if (mode && mode.value === 'fast') bolts = 1; if (mode && mode.value === 'ultrafast') bolts = 2;
  if (!bolts) { cell.hidden = true; return cell; }
  const capsule = perfElement('span','perf-capsule'), bolt = perfElement('span','perf-bolt'); bolt.dataset.bolts = String(bolts); bolt.setAttribute('aria-hidden','true');
  for (let index = 0; index < bolts; index++) { const svg = perfSvg('svg',{width:9,height:10,viewBox:'0 0 8 10'}); svg.append(perfSvg('path',{d:'M4.8 0L.6 5.6h2.8L2.6 10l4.8-6H4.5z',fill:'currentColor'})); bolt.append(svg); }
  capsule.append(bolt); capsule.setAttribute('aria-label',cell.title.replace(/\n/g,' ')); cell.append(capsule); return cell;
}
function perfMeter(value, width) {
  const meter = perfElement('span','perf-mm'), fill = perfElement('i'), tick = perfElement('b');
  meter.setAttribute('aria-hidden','true'); if (width) meter.style.width = width + 'px';
  if (value === null) meter.classList.add('perf-dotted'); else fill.style.width = perfScale(value) * 100 + '%';
  meter.append(fill,tick); return meter;
}
function perfBuildScale() {
  const scale = perfElement('div','perf-scale'), track = perfElement('div','perf-track'), fill = perfElement('div','perf-fill'), labels = perfElement('div','perf-scale-labels');
  scale.setAttribute('aria-hidden','true'); labels.setAttribute('aria-hidden','true'); scale.append(track,fill);
  for (const [position,label] of [[25,'500'],[50,'1000'],[75,'2000'],[100,'4000']]) {
    if (position < 100) { const tick = perfElement('i','perf-tick' + (position === 50 ? ' perf-ref' : '')); tick.style.left = position + '%'; scale.append(tick); }
    const word = perfElement('span',position === 50 ? 'perf-ref' : position === 100 ? 'perf-end' : '',label); word.style.left = position + '%'; labels.append(word);
  }
  return {scale,fill,labels};
}
function perfBuildCardView() {
  const card = node('perf-score-card'); if (!card) return null;
  const head = perfElement('div','perf-c-head'), dot = perfElement('span','perf-dot'), project = perfElement('b'), provisional = perfElement('span','perf-chip perf-chip-dot');
  const ring = perfSvg('svg',{width:10,height:10,viewBox:'0 0 10 10','aria-hidden':'true'});
  for (let index = 0; index < 8; index++) { const angle = index * Math.PI / 4; ring.append(perfSvg('circle',{cx:5+3.5*Math.cos(angle),cy:5+3.5*Math.sin(angle),r:.65,fill:'currentColor'})); }
  const provisionalText = perfElement('span'); provisional.append(ring,provisionalText); head.append(dot,project,provisional);
  const meta = perfElement('div','perf-c-meta'), score = perfElement('div','perf-c-score'), eyebrow = perfElement('div','perf-c-eyebrow'), top = perfElement('div','perf-c-top'), digits = perfElement('span','perf-c-big'), usual = perfElement('span','perf-chip');
  top.append(digits,usual); const {scale,fill,labels} = perfBuildScale(), summary = perfElement('div','perf-c-summary'), hint = perfElement('div','perf-c-hint');
  score.append(eyebrow,top,scale,labels,summary,hint);
  const components = perfElement('div','perf-comps'), rows = new Map();
  for (const [group,ids] of [['speed',['T','L','R']],['efficiency',['N','U','S','H']]]) {
    const heading = perfElement('div','perf-group-title'); heading.dataset.perfGroup = group; components.append(heading);
    for (const id of ids) {
      const label = perfElement('span','perf-label'), value = perfElement('span','perf-value'), meter = perfMeter(null), subscore = perfElement('span','perf-subscore'), meaning = perfElement('div','perf-meaning');
      label.dataset.perfComponent = id; components.append(label,value,meter,subscore,meaning); rows.set(id,{label,value,meter,subscore,meaning});
    }
  }
  const facts = perfElement('div','perf-c-facts'), footnote = perfElement('div','perf-c-foot'); card.replaceChildren(head,meta,score,components,facts,footnote);
  return {card,dot,project,provisional,provisionalText,meta,eyebrow,digits,usual,scale,fill,summary,hint,components,rows,facts,footnote};
}
function perfUpdateCardComponents(refs,status,agent) {
  refs.components.hidden = !status || status.shown === null; if (refs.components.hidden) return;
  for (const heading of refs.components.querySelectorAll('[data-perf-group]')) perfText(heading,perfT('perf.group.' + heading.dataset.perfGroup));
  for (const component of perfComponents) {
    const row = refs.rows.get(component.id), part = perfPart(status,component.id);
    perfText(row.label,perfT('perf.comp.' + component.key));
    perfText(row.value,part.present ? perfMeasure(component.id,part.measure) : perfT('perf.reason.' + part.reason));
    perfText(row.subscore,part.present ? perfNumber(perfRound(part.subScore)) : '–');
    perfText(row.meaning,perfComponentMeaning(component,part,status,agent.source || 'omp'));
    row.value.classList.toggle('perf-absent',!part.present); row.subscore.classList.toggle('perf-absent',!part.present); row.meter.classList.toggle('perf-dotted',!part.present);
    row.meter.firstElementChild.style.width = perfScale(part.subScore) * 100 + '%';
  }
}
function perfUpdateCard(same = true) {
  if (!perfCardState) return;
  const agent = perfAgent(perfCardState.id); if (!agent) { perfHideCard(); return; }
  const status = perfStatus(agent.id), refs = perfCardView || (perfCardView = perfBuildCardView()); if (!refs) return;
  const options = perfCardState.options, hasScore = status && status.shown !== null;
  perfText(refs.project,agent.project || agent.name || agent.id); refs.dot.style.background = perfSourceColor(agent.source || 'omp');
  const meta = [status && status.model || agent.model,perfSourceName(agent.source || 'omp')].filter(Boolean);
  if (options.subAgents) meta.push((language === 'zh' ? options.subAgents + ' 个子 agent' : options.subAgents + ' sub-agents'));
  perfText(refs.meta,meta.join(' · ')); refs.provisional.hidden = !hasScore || !status.provisional; perfText(refs.provisionalText,perfT('perf.provisional'));
  const eyebrows = []; if (hasScore && status.form === 'resting') eyebrows.push(perfT('phase.idle')); if (hasScore && options.topCount >= 2) eyebrows.push(perfT('perf.card.top',options.topCount));
  refs.eyebrow.hidden = !eyebrows.length; perfText(refs.eyebrow,eyebrows.join(' · '));
  perfSetNumberState(refs.digits,status); perfAnimateScore(refs.digits,hasScore ? status.shown : null,'card',same,refs.scale);
  refs.fill.hidden = !hasScore; refs.scale.classList.toggle('perf-is-pale',hasScore && status.form === 'resting'); refs.scale.classList.toggle('perf-is-prov',hasScore && status.provisional);
  refs.usual.hidden = !hasScore;
  if (hasScore) { const delta = status.vsUsualPercent; refs.usual.className = 'perf-chip ' + (delta === null ? 'perf-chip-dot' : delta > 0 ? 'perf-chip-up' : 'perf-chip-flat'); perfText(refs.usual,delta === null ? perfT('perf.usual.none') : perfT('perf.usual',perfSigned(delta))); }
  perfText(refs.summary,perfSummary(status)); refs.hint.hidden = !hasScore || !status.provisional; perfText(refs.hint,hasScore && status.provisional ? perfT('perf.provisional.hint',status.n,10) : '');
  perfUpdateCardComponents(refs,status,agent); perfText(refs.facts,perfCardFacts(agent,status,options.facts).join('\n')); perfText(refs.footnote,perfT('perf.card.footnote'));
  refs.card.setAttribute('aria-label',perfT('a11y.perf.card')); perfPositionCard();
}
function perfPositionCard() {
  if (!perfCardState || !perfCardView) return;
  const card = perfCardView.card, anchor = perfCardState.anchor;
  if (!anchor || !anchor.isConnected || anchor.closest('[hidden]')) { perfHideCard(); return; }
  const rect = anchor.getBoundingClientRect(), width = Math.min(320,Math.max(0,window.innerWidth-16)); card.style.width = width + 'px'; card.dataset.compact = '0';
  const maxHeight = Math.max(0,window.innerHeight-16);
  if (card.scrollHeight > maxHeight) card.dataset.compact = '1'; if (card.scrollHeight > maxHeight) card.dataset.compact = '2';
  const rightRoom = window.innerWidth-rect.right, leftRoom = rect.left, left = leftRoom >= rightRoom ? rect.left-width-8 : rect.right+8;
  card.style.left = Math.max(8,Math.min(window.innerWidth-width-8,left)) + 'px';
  card.style.top = Math.max(8,Math.min(window.innerHeight-Math.min(card.scrollHeight,maxHeight)-8,rect.top)) + 'px';
}
function perfShowCard(agentId,anchor,options = {}) {
  if (perfDestroyed || document.hidden || !anchor || !perfAgent(agentId) || !perfScoresEnabled()) return;
  clearTimeout(perfHoverTimer); clearTimeout(perfHideTimer); perfHoverTimer = perfHideTimer = null;
  const previous = perfCardState, same = !!previous && previous.id === agentId;
  if (previous && previous.anchor !== anchor) delete previous.anchor.dataset.perfOpen;
  perfCardState = {id:agentId,anchor,options:{topCount:options.topCount || 0,facts:options.facts || [],subAgents:options.subAgents || 0},keyboard:!!options.keyboard};
  perfCardView = perfCardView || perfBuildCardView(); if (!perfCardView) return;
  perfCardView.card.hidden = false; perfCardView.card.dataset.perfCardOpen = 'true'; if (!same) perfCardView.card.scrollTop = 0;
  anchor.dataset.perfOpen = 'true'; perfUpdateCard(same);
  if (!same) perfAnimate(perfCardView.card,[{opacity:0,transform:perfReduced() ? 'none' : 'translateX(2px)'},{opacity:1,transform:'none'}],{duration:previous ? 120 : 150,easing:'ease-out'});
}
function perfHideCard() {
  clearTimeout(perfHoverTimer); clearTimeout(perfHideTimer); perfHoverTimer = perfHideTimer = null;
  if (perfCardState && perfCardState.anchor) delete perfCardState.anchor.dataset.perfOpen;
  perfCardState = null;
  if (!perfCardView) return;
  perfCardView.card.hidden = true; delete perfCardView.card.dataset.perfCardOpen; perfNumberAnimations.delete(perfCardView.digits); perfFinishNumberFade(perfCardView.digits);
  for (const effect of perfEffects) { const target = effect.effect && effect.effect.target; if (target && perfCardView.card.contains(target)) { effect.cancel(); perfEffects.delete(effect); } }
}
function perfAnchor(element) { if (!(element instanceof Element)) return null; return element.closest('.agent-row[data-perf-agent-id]') || element.closest('.row[data-perf-agent-id][data-perf-card-host="board"]') || element.closest('[data-perf-agent-id]'); }
function perfOptions(anchor,keyboard = false) { return {topCount:Number(anchor.dataset.perfSetCount) || 0,facts:Array.isArray(anchor.boardPerfFacts) ? anchor.boardPerfFacts : [],subAgents:Number(anchor.dataset.perfSubAgents) || 0,keyboard}; }
function perfQueueCard(anchor) {
  clearTimeout(perfHoverTimer); clearTimeout(perfHideTimer); perfHideTimer = null;
  if (perfCardState) { perfShowCard(anchor.dataset.perfAgentId,anchor,perfOptions(anchor)); return; }
  perfHoverTimer = setTimeout(() => { perfHoverTimer = null; if (anchor.isConnected && perfDismissedAnchor !== anchor) perfShowCard(anchor.dataset.perfAgentId,anchor,perfOptions(anchor)); },anchor.dataset.perfCardHost === 'board' ? 350 : 450);
}

function perfHistoryRowKey(row) { return JSON.stringify([row.source,row.model]); }
function perfModelName(model) { return model ? model : perfT('noModel'); }
function perfSortValue(row,key) {
  if (key === 'model') return perfModelName(row.model);
  if (key === 'score') return row.score;
  if (key === 'usual') return row.baseline;
  if (key === 'timed') return row.n;
  return perfPart(row,key).subScore;
}
function perfSortedRows() {
  const direction = perfHistoryDescending ? -1 : 1;
  return perfHistoryRows.slice().sort((left,right) => {
    const a = perfSortValue(left,perfHistorySort), b = perfSortValue(right,perfHistorySort);
    if (a === null && b !== null) return 1; if (a !== null && b === null) return -1;
    let order = 0;
    if (typeof a === 'string' && typeof b === 'string') order = a < b ? -1 : a > b ? 1 : 0;
    else if (a !== null && b !== null) order = a-b;
    if (order) return direction * order;
    if (left.n !== right.n) return right.n-left.n;
    return left.model < right.model ? -1 : left.model > right.model ? 1 : left.source.localeCompare(right.source);
  });
}
function perfFillSortPicker() {
  const select = node('perf-model-sort'); if (!select) return;
  const columns = [{id:'model',key:'model'},{id:'score',key:'score'},{id:'usual',key:'usual'},{id:'timed',key:'timed'},...perfComponents.map(component => ({id:component.id,key:component.key}))];
  const key = language;
  if (select.perfOptionsKey !== key) {
    const fragment = document.createDocumentFragment();
    for (const column of columns) { const option = document.createElement('option'); option.value = column.id; perfText(option,perfT('history.perf.column.' + column.key)); fragment.append(option); }
    select.replaceChildren(fragment); select.perfOptionsKey = key;
  }
  if (select.value !== perfHistorySort) select.value = perfHistorySort;
  select.setAttribute('aria-label',perfT('history.perf.title') + ' · ' + perfT('sort'));
  const direction = node('perf-sort-direction'); direction.setAttribute('aria-label',perfT('reverseSort')); perfText(direction,perfHistoryDescending ? '↓' : '↑');
}
function perfScoreHistoryCell(row) {
  const score = perfElement('span','perf-score-history');
  if (row.shown === null) { const empty = perfElement('span','perf-na','–'); empty.title = perfT('history.perf.sample.hint',row.n,20); empty.setAttribute('aria-label',empty.title); score.append(empty); }
  else score.append(perfElement('b','',perfNumber(row.shown)),perfMeter(row.shown,36));
  return score;
}
function perfModelLabel(row) {
  const label = perfElement('span','perf-model-cell'), dot = perfElement('span','perf-source-dot'), id = perfElement('span','perf-model-id',perfModelName(row.model));
  dot.style.background = perfSourceColor(row.source); dot.setAttribute('aria-hidden','true'); id.title = perfModelName(row.model);
  label.append(dot,id,perfElement('span','perf-source-name',perfSourceName(row.source)));
  if (row.shown === null) { const chip = perfElement('span','perf-chip-sm',perfT('history.perf.sample.low')); chip.title = perfT('history.perf.sample.hint',row.n,20); label.append(chip); }
  return label;
}
function perfPartsCell(row) {
  const root = perfElement('span','perf-parts'), words = [];
  for (const component of perfComponents) {
    const part = perfPart(row,component.id), bar = perfElement('i',part.present ? '' : 'perf-na'), label = perfT('perf.comp.' + component.key);
    bar.style.setProperty('--f',String(perfScale(part.subScore)));
    bar.title = part.present ? label + ' · ' + perfMeasure(component.id,part.measure) + ' · ' + perfNumber(perfRound(part.subScore)) : label + ' · ' + perfReason(part,row.source);
    root.append(bar); words.push(label + ' ' + perfNumber(perfRound(part.subScore)));
  }
  root.setAttribute('role','img'); root.setAttribute('aria-label',perfT('a11y.history.perf.parts',words.join(language === 'zh' ? '、' : ', '))); return root;
}
function perfHistoryHeader() {
  const head = perfElement('thead'), row = perfElement('tr');
  const columns = [{id:'model',key:'model'},{id:'score',key:'score'},{id:'usual',key:'usual'},{id:'timed',key:'timed'},...perfComponents.map(component => ({id:component.id,key:component.key,component}))];
  for (const column of columns) {
    const cell = perfElement('th',column.component ? 'perf-col-comp' : ''), button = perfElement('button','',perfT('history.perf.column.' + column.key)); button.type = 'button'; button.dataset.perfSort = column.id;
    let label = perfT('history.perf.column.' + column.key);
    if (column.component) label = perfT('perf.comp.' + column.key) + ' — ' + perfT('perf.comp.' + column.key + '.desc');
    if (column.id === 'usual') label = perfT('history.perf.column.usual') + ' — ' + perfT('history.perf.usual.hint'); if (column.id === 'timed') label = perfT('history.perf.column.timed.full');
    button.title = label; button.setAttribute('aria-label',label); cell.scope = 'col';
    if (perfHistorySort === column.id) { cell.setAttribute('aria-sort',perfHistoryDescending ? 'descending' : 'ascending'); button.append(perfElement('span','',perfHistoryDescending ? ' ▾' : ' ▴')); }
    cell.append(button); row.append(cell);
  }
  const parts = perfElement('th','perf-col-parts',perfT('history.perf.column.parts')); parts.scope = 'col'; row.append(parts); head.append(row); return head;
}
function perfHistoryTable(rows) {
  const table = perfElement('table','perf-table'), body = perfElement('tbody'); table.append(perfHistoryHeader());
  for (const item of rows) {
    const key = perfHistoryRowKey(item), selected = key === perfHistorySelected, row = perfElement('tr',(item.shown === null ? 'perf-low ' : '') + (selected ? 'perf-selected' : ''));
    row.dataset.perfRowKey = key; row.perfModelItem = item; row.tabIndex = selected ? 0 : -1; row.setAttribute('aria-selected',String(selected)); row.setAttribute('aria-keyshortcuts','ArrowUp ArrowDown Control+C');
    const model = perfElement('td'), score = perfElement('td'), usual = perfElement('td',item.baseline === null ? 'perf-na' : 'perf-usual',perfNumber(perfRound(item.baseline))), timed = perfElement('td','',perfGrouped(item.n));
    model.append(perfModelLabel(item)); score.append(perfScoreHistoryCell(item)); usual.title = item.baseline === null ? perfT('perf.usual.none.hint',20) : perfT('history.perf.usual.hint'); usual.setAttribute('aria-label',usual.textContent + ', ' + usual.title);
    row.append(model,score,usual,timed);
    for (const component of perfComponents) {
      const part = perfPart(item,component.id), cell = perfElement('td','perf-col-comp' + (part.present ? '' : ' perf-na'),perfMeasure(component.id,part.measure));
      cell.title = part.present ? perfT('perf.comp.' + component.key + '.desc') : perfReason(part,item.source); cell.setAttribute('aria-label',cell.textContent + ', ' + cell.title); row.append(cell);
    }
    const parts = perfElement('td','perf-col-parts'); parts.append(perfPartsCell(item)); row.append(parts); body.append(row);
  }
  table.append(body); return table;
}
function perfHistoryList(rows) {
  const list = perfElement('div','perf-list'); list.setAttribute('role','listbox'); list.setAttribute('aria-label',perfT('history.perf.title'));
  for (const item of rows) {
    const key = perfHistoryRowKey(item), selected = key === perfHistorySelected, row = perfElement('div','perf-list-item' + (item.shown === null ? ' perf-low' : '') + (selected ? ' perf-selected' : ''));
    row.dataset.perfRowKey = key; row.perfModelItem = item; row.tabIndex = selected ? 0 : -1; row.setAttribute('role','option'); row.setAttribute('aria-selected',String(selected));
    const line = perfElement('div','perf-list-line'), dot = perfElement('span','perf-source-dot'), name = perfElement('span','perf-model-id',perfModelName(item.model)), score = perfElement('span','perf-list-score');
    dot.style.background = perfSourceColor(item.source); dot.setAttribute('aria-hidden','true'); name.title = perfModelName(item.model); line.append(dot,name);
    if (item.shown === null) line.append(perfElement('span','perf-chip-sm',perfT('history.perf.sample.low')));
    score.append(perfScoreHistoryCell(item)); line.append(score);
    const facts = [perfSourceName(item.source),perfT('history.perf.requests',perfGrouped(item.n)),perfT('history.perf.column.usual') + ' ' + perfNumber(perfRound(item.baseline))];
    const components = perfComponents.filter(component => perfPart(item,component.id).present).map(component => perfT('history.perf.column.' + component.key) + ' ' + perfMeasure(component.id,perfPart(item,component.id).measure));
    row.append(line,perfElement('div','perf-list-secondary',facts.join(' · ')),perfElement('div','perf-list-secondary',components.join(' · '))); list.append(row);
  }
  return list;
}
function perfChartDays(row,dates) {
  const first = dates.startDate === dates.endDate ? shiftDate(dates.startDate,-13) : dates.startDate;
  const trendRows = perfModel.range(perfHistoryRecords,first,dates.endDate,row.source), trend = trendRows.find(candidate => candidate.model === row.model);
  const values = new Map(trend ? trend.trend.map(point => [point.day,point.score]) : []), records = new Map();
  for (const record of perfHistoryRecords) {
    if (record.source !== row.source || record.model !== row.model || record.day < first || record.day > dates.endDate) continue;
    const bucket = records.get(record.day) || []; bucket.push(record); records.set(record.day,bucket);
  }
  const days = [];
  for (let day = first; day <= dates.endDate; day = shiftDate(day,1)) {
    const pooled = perfModel.pool(records.get(day) || [],row.source), score = values.get(day);
    days.push({day,score:score === undefined ? null : perfRound(score),n:pooled.n});
  }
  return days;
}
function perfChartAxis(svg,days,geometry) {
  const {width,height,left,right,top,bottom,y,x,topValue} = geometry;
  for (let value = 500; value <= topValue; value *= 2) {
    svg.append(perfSvg('line',{class:value === 1000 ? 'perf-ref' : 'perf-grid',x1:left,x2:width-right,y1:y(value),y2:y(value)}));
    const label = perfSvg('text',{class:'perf-axis' + (value === 1000 ? ' perf-ref' : ''),x:left-6,y:y(value)+3,'text-anchor':'end'}); perfText(label,perfNumber(value)); svg.append(label);
  }
  const nearMonth = days.slice(0,5).some(point => parseDate(point.day).getDate() === 1);
  for (let index = 0; index < days.length; index++) {
    const date = parseDate(days[index].day), month = date.getDate() === 1;
    if (month) svg.append(perfSvg('line',{class:'perf-grid',x1:x(index)-(width-left-right)/days.length/2,x2:x(index)-(width-left-right)/days.length/2,y1:top,y2:height-bottom}));
    if (!month && index !== days.length-1 && (index !== 0 || nearMonth)) continue;
    const label = perfSvg('text',{class:'perf-axis',x:x(index),y:height-4,'text-anchor':index === days.length-1 ? 'end' : 'start'}); perfText(label,(date.getMonth()+1) + '/' + date.getDate()); svg.append(label);
  }
}
function perfChartPaths(svg,days,geometry,row) {
  const {x,y,height,bottom,width,left,right} = geometry, segments = []; let segment = [];
  for (let index = 0; index < days.length; index++) {
    if (days[index].score === null) { if (segment.length) segments.push(segment); segment = []; }
    else segment.push([x(index),y(days[index].score)]);
  }
  if (segment.length) segments.push(segment);
  const color = perfSourceColor(row.source), gradientId = 'perf-history-area', defs = perfSvg('defs'), gradient = perfSvg('linearGradient',{id:gradientId,x1:0,y1:0,x2:0,y2:1});
  gradient.append(perfSvg('stop',{offset:0,'stop-color':color,'stop-opacity':.12}),perfSvg('stop',{offset:1,'stop-color':color,'stop-opacity':0})); defs.append(gradient); svg.append(defs);
  for (const points of segments) {
    if (points.length < 2) continue;
    const line = 'M' + points.map(point => point[0].toFixed(2) + ' ' + point[1].toFixed(2)).join('L'), area = 'M' + points[0][0] + ' ' + (height-bottom) + 'L' + line.slice(1) + 'L' + points[points.length-1][0] + ' ' + (height-bottom) + 'Z';
    svg.append(perfSvg('path',{d:area,fill:'url(#' + gradientId + ')'}),perfSvg('path',{d:line,fill:'none',stroke:color,'stroke-width':2,'stroke-linejoin':'round','stroke-linecap':'round'}));
  }
  if (row.baseline !== null) svg.append(perfSvg('line',{x1:left,x2:width-right,y1:y(row.baseline),y2:y(row.baseline),stroke:color,'stroke-opacity':.6,'stroke-dasharray':'4 3'}));
  let latest = -1; for (let index = 0; index < days.length; index++) if (days[index].score !== null) latest = index;
  for (let index = 0; index < days.length; index++) {
    if (days[index].score === null) continue;
    svg.append(perfSvg('circle',{cx:x(index),cy:y(days[index].score),r:index === latest ? 3 : 2.25,fill:color,stroke:'var(--win)','stroke-width':1.5}));
  }
}
function perfChartTooltip(index) {
  const state = perfChartState; if (!state || !state.days.length) return;
  const wanted = Math.max(0,Math.min(state.days.length-1,index)); perfChartIndex = wanted;
  const point = state.days[wanted], {geometry,svg,tooltip,crosshair} = state, date = parseDate(point.day), weekday = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US',{weekday:'short'}).format(date);
  const title = perfElement('div','',dateLabel(point.day) + ' · ' + weekday), score = perfElement('b','',perfNumber(point.score)), detail = perfElement('div','',point.score === null ? perfT('history.perf.sample.hint',point.n,20) : perfT('history.perf.requests',perfGrouped(point.n)) + ' · ' + perfTier(point.score));
  tooltip.replaceChildren(title,score,detail); tooltip.hidden = false; crosshair.removeAttribute('hidden'); crosshair.setAttribute('x1',geometry.x(wanted)); crosshair.setAttribute('x2',geometry.x(wanted));
  const rect = svg.getBoundingClientRect(), scale = rect.width ? rect.width/geometry.width : 1, anchorX = geometry.x(wanted)*scale;
  tooltip.style.left = Math.max(0,Math.min((rect.width || geometry.width)-tooltip.offsetWidth,anchorX+10)) + 'px'; tooltip.style.top = '10px';
  svg.setAttribute('aria-describedby',tooltip.id);
}
function perfHideChartTooltip() {
  if (!perfChartState) return;
  perfChartState.tooltip.hidden = true; perfChartState.crosshair.setAttribute('hidden',''); perfChartState.svg.removeAttribute('aria-describedby');
}
function perfRenderTrend(row,dates,target) {
  const days = perfChartDays(row,dates), values = days.filter(point => point.score !== null).map(point => point.score), subject = perfModelName(row.model) + ' · ' + perfSourceName(row.source);
  const title = perfElement('div','perf-trend-title'), text = perfElement('span','perf-tt'), model = perfElement('b','',perfModelName(row.model));
  text.append(document.createTextNode(perfT('history.perf.trend','')),model,document.createTextNode(' · ' + perfSourceName(row.source)));
  if (dates.startDate === dates.endDate) text.append(document.createTextNode(' · ' + perfT('history.perf.trend.days',dateLabel(dates.endDate))));
  const legend = perfElement('span','perf-legend'), reference = perfElement('span'), referenceLine = perfSvg('svg',{width:12,height:2,'aria-hidden':'true'});
  referenceLine.append(perfSvg('line',{x1:0,x2:12,y1:1,y2:1,stroke:'currentColor','stroke-opacity':.7})); reference.append(referenceLine,document.createTextNode('1000 ' + perfT('perf.reference'))); legend.append(reference);
  if (row.baseline !== null) { const usual = perfElement('span'), line = perfSvg('svg',{width:12,height:2,'aria-hidden':'true'}); line.append(perfSvg('line',{x1:0,x2:12,y1:1,y2:1,stroke:perfSourceColor(row.source),'stroke-dasharray':'4 3'})); usual.append(line,document.createTextNode(perfT('history.perf.usual.line',perfNumber(perfRound(row.baseline))))); legend.append(usual); }
  title.append(text,legend);
  const section = node('perf-performance'), width = Math.max(260,section.clientWidth ? section.clientWidth-36 : window.innerWidth-84), height = width >= 860 ? 150 : width >= 600 ? 132 : 120, left = 38, right = 8, top = 8, bottom = 18;
  const maximum = Math.max(4000,row.baseline || 0,...values), topValue = 250*Math.pow(2,Math.ceil(Math.log2(maximum/250)));
  const y = value => top+(1-Math.max(0,Math.min(1,Math.log2(Math.max(250,value)/250)/Math.log2(topValue/250))))*(height-top-bottom), x = index => left+(index+.5)/days.length*(width-left-right);
  const geometry = {width,height,left,right,top,bottom,topValue,x,y}, svg = perfSvg('svg',{id:'perf-history-chart',class:'perf-chart',viewBox:'0 0 ' + width + ' ' + height,preserveAspectRatio:'none',role:'img',tabindex:0}), wrap = perfElement('div','perf-chart-wrap');
  const spoken = values.length ? perfT('a11y.history.perf.chart',subject,perfGrouped(Math.min(...values)),perfGrouped(Math.max(...values)),perfGrouped(values[values.length-1])) : perfT('a11y.history.perf.chart.empty',subject);
  svg.setAttribute('aria-label',spoken); svg.setAttribute('aria-keyshortcuts','ArrowLeft ArrowRight Home End');
  if (dates.startDate === dates.endDate) svg.append(perfSvg('rect',{x:x(days.length-1)-(width-left-right)/days.length/2,y:top,width:(width-left-right)/days.length,height:height-top-bottom,fill:'var(--ink)','fill-opacity':.05}));
  perfChartAxis(svg,days,geometry); perfChartPaths(svg,days,geometry,row);
  if (!values.length) { const empty = perfSvg('text',{class:'perf-chart-empty',x:(width+left)/2,y:height/2,'text-anchor':'middle'}); perfText(empty,spoken); svg.append(empty); }
  const crosshair = perfSvg('line',{y1:top,y2:height-bottom,stroke:'var(--ink-3)','stroke-width':1,'stroke-dasharray':'2 2',hidden:''}), tooltip = perfElement('div','perf-point-tip');
  tooltip.id = 'perf-point-tip'; tooltip.hidden = true; tooltip.setAttribute('role','status'); svg.append(crosshair); wrap.append(svg,tooltip); target.replaceChildren(title,wrap);
  perfChartState = {row,days,geometry,svg,tooltip,crosshair,width}; perfChartIndex = Math.min(days.length-1,Math.max(0,perfChartIndex));
  svg.addEventListener('pointermove',event => { const rect = svg.getBoundingClientRect(); if (!rect.width) return; const position = (event.clientX-rect.left)*width/rect.width; perfChartTooltip(Math.floor((position-left)/(width-left-right)*days.length)); });
  svg.addEventListener('pointerleave',perfHideChartTooltip); svg.addEventListener('blur',perfHideChartTooltip);
  svg.addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End','Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); if (event.key === 'Escape') { perfHideChartTooltip(); return; }
    let index = perfChartIndex; if (event.key === 'Home') index = 0; else if (event.key === 'End') index = days.length-1; else index += event.key === 'ArrowLeft' ? -1 : 1;
    perfChartTooltip(index);
  });
}
function perfHistoryPlaceholder(scanning) {
  const root = perfElement('div');
  if (scanning) {
    const skeleton = perfElement('div','perf-skeleton'); skeleton.setAttribute('aria-hidden','true');
    for (const [index,width] of [100,100,100,84,92,70].entries()) { const item = perfElement('i'); item.style.width = width + '%'; if (index === 1) { item.style.height = '90px'; item.style.borderRadius = '8px'; } skeleton.append(item); } root.append(skeleton);
  }
  const state = perfElement('div','perf-history-state');
  if (!scanning) { const gauge = perfSvg('svg',{width:34,height:34,viewBox:'0 0 34 34','aria-hidden':'true'}); gauge.append(perfSvg('path',{d:'M7 26a13 13 0 1 1 20 0M17 7v3M6 17h3M25 17h3M17 21l7-9',fill:'none',stroke:'currentColor','stroke-width':1.6,'stroke-linecap':'round'})); state.append(gauge,perfElement('b','',perfT('history.perf.empty'))); }
  state.append(perfElement('span','',perfT(scanning ? 'history.perf.analyzing' : 'history.perf.empty.hint'))); root.append(state); return root;
}
function perfFitModelNames(section) {
  for (const element of section.querySelectorAll('.perf-model-id')) {
    const full = element.title, width = element.clientWidth; if (!full || !width) continue;
    const style = getComputedStyle(element), font = [style.fontWeight,style.fontSize,style.fontFamily].join(' '), key = [full,width,font].join('|');
    element.setAttribute('aria-label',full); if (element.perfModelFitKey === key) continue; element.perfModelFitKey = key;
    if (!perfMeasurement) perfMeasureText(full,12.5,550); if (!perfMeasurement) continue; perfMeasurement.font = font;
    if (perfMeasurement.measureText(full).width <= width) { perfText(element,full); continue; }
    const characters = Array.from(full); let low = 0, high = characters.length, shown = '…';
    while (low <= high) {
      const kept = Math.floor((low+high)/2), left = Math.ceil(kept/2), right = Math.floor(kept/2), candidate = characters.slice(0,left).join('') + '…' + (right ? characters.slice(-right).join('') : '');
      if (perfMeasurement.measureText(candidate).width <= width) { shown = candidate; low = kept+1; } else high = kept-1;
    }
    perfText(element,shown);
  }
}
function perfRestoreHistoryFocus(focused) {
  if (!(focused instanceof Element)) return;
  if (focused.id === 'perf-history-chart' && perfChartState) { perfChartState.svg.focus({preventScroll:true}); perfChartTooltip(perfChartIndex); return; }
  const oldRow = focused.closest('[data-perf-row-key]');
  if (oldRow) {
    const selector = oldRow.classList.contains('perf-list-item') ? '.perf-list-item[data-perf-row-key]' : '.perf-table tbody [data-perf-row-key]';
    const rows = Array.from(document.querySelectorAll(selector)), row = rows.find(candidate => candidate.dataset.perfRowKey === oldRow.dataset.perfRowKey) || rows.find(candidate => candidate.dataset.perfRowKey === perfHistorySelected);
    if (row) row.focus({preventScroll:true}); return;
  }
  const sort = focused.closest('[data-perf-sort]'); if (!sort) return;
  const replacement = Array.from(document.querySelectorAll('[data-perf-sort]')).find(candidate => candidate.dataset.perfSort === sort.dataset.perfSort); if (replacement) replacement.focus({preventScroll:true});
}
function perfPlaceHistory() {
  const section = node('perf-performance'); if (!section) return;
  const slot = node('perf-history-slot'), body = node('history-body');
  if (body && body.hidden) { const scroll = body.closest('.history-scroll'); if (scroll && section.parentElement !== scroll) scroll.insertBefore(section,node('history-empty') || null); }
  else if (slot && section.parentElement !== slot) slot.append(section);
}
function perfRenderHistory(snapshot) {
  const section = node('perf-performance'); if (!section || !view || view.surface !== 'history') return;
  perfPlaceHistory(); const dates = selectedDates(), data = snapshot && snapshot.performance, records = data ? data.records : [];
  const key = JSON.stringify([language,dates.startDate,dates.endDate,view.scope,!!(data && data.scanning),!!(data && data.limited),perfHistorySelected,perfHistorySort,perfHistoryDescending,records,data ? data.baselines : []]);
  if (key === perfHistoryKey) return; perfHistoryKey = key; perfHistoryRecords = records;
  const focused = document.activeElement;
  perfText(node('perf-performance-title'),perfT('history.perf.title')); perfText(node('perf-performance-footnote'),perfT('history.perf.footnote'));
  const info = node('perf-performance-info'); info.title = perfT('history.perf.info.a11y'); info.setAttribute('aria-label',info.title); section.setAttribute('aria-busy',String(!!(data && data.scanning)));
  perfFillSortPicker(); const notes = []; if (data && data.scanning) notes.push(perfT('scanning')); if (data && data.limited) notes.push(perfT('limited')); perfText(node('perf-history-note'),notes.join(' '));
  const baselines = new Map(data ? data.baselines.map(baseline => [JSON.stringify([baseline.source,baseline.model]),baseline.score]) : []);
  perfHistoryRows = [];
  for (const row of perfModel.range(records,dates.startDate,dates.endDate)) {
    if (row.n > 0) perfHistoryRows.push(Object.assign({},row,{baseline:baselines.get(perfHistoryRowKey(row)) ?? null}));
  }
  const content = node('perf-history-content'); perfChartState = null;
  if (!perfHistoryRows.length) { content.replaceChildren(perfHistoryPlaceholder(!!(data && data.scanning))); return; }
  const rows = perfSortedRows();
  if (!rows.some(row => perfHistoryRowKey(row) === perfHistorySelected)) {
    let selected = rows[0]; for (const row of rows) if (row.n > selected.n) selected = row; perfHistorySelected = perfHistoryRowKey(selected);
  }
  const selected = rows.find(row => perfHistoryRowKey(row) === perfHistorySelected), trend = perfElement('div'); trend.id = 'perf-history-trend';
  perfRenderTrend(selected,dates,trend); content.replaceChildren(trend,perfHistoryTable(rows),perfHistoryList(rows));
  perfFitModelNames(section); perfRestoreHistoryFocus(focused); perfAnimate(content,[{opacity:0},{opacity:1}],{duration:200});
}
function perfSelectRow(key,focus = false,narrow = false) {
  if (!perfHistoryRows.some(row => perfHistoryRowKey(row) === key)) return;
  perfHistorySelected = key; perfHistoryKey = ''; perfRenderHistory(perfFacts());
  if (!focus) return;
  const selector = narrow ? '.perf-list-item[data-perf-row-key]' : '.perf-table tbody [data-perf-row-key]';
  const row = Array.from(document.querySelectorAll(selector)).find(candidate => candidate.dataset.perfRowKey === key);
  if (row) row.focus({preventScroll:true});
}
function perfShowInfo() {
  const popup = node('perf-history-info'), button = node('perf-performance-info'); if (!popup || !button) return;
  perfText(node('perf-info-title'),perfT('history.perf.title')); perfText(node('perf-info-intro'),perfT('history.perf.info')); perfText(node('perf-info-disclaimer'),perfT('perf.card.footnote')); node('perf-info-close').setAttribute('aria-label',perfT('close'));
  const fragment = document.createDocumentFragment();
  for (const component of perfComponents) fragment.append(perfElement('dt','',perfT('perf.comp.' + component.key)),perfElement('dd','',perfT('perf.comp.' + component.key + '.desc')));
  node('perf-info-definitions').replaceChildren(fragment); popup.hidden = false; button.setAttribute('aria-expanded','true');
  const rect = button.getBoundingClientRect(), width = popup.offsetWidth || 340, height = popup.offsetHeight || 400;
  popup.style.left = Math.max(8,Math.min(window.innerWidth-width-8,rect.left)) + 'px'; popup.style.top = Math.max(8,Math.min(window.innerHeight-height-8,rect.bottom+6)) + 'px';
  node('perf-info-close').focus({preventScroll:true});
}
function perfHideInfo(restoreFocus = false) {
  const info = node('perf-history-info'); if (info) info.hidden = true;
  const button = node('perf-performance-info'); if (button) { button.setAttribute('aria-expanded','false'); if (restoreFocus) button.focus({preventScroll:true}); }
}
function perfCopyText(row) {
  const columns = [perfModelName(row.model),perfSourceName(row.source),perfT('history.perf.column.score') + ': ' + perfNumber(row.shown),perfT('history.perf.column.usual') + ': ' + perfNumber(perfRound(row.baseline)),perfT('history.perf.column.timed.full') + ': ' + perfGrouped(row.n)];
  for (const component of perfComponents) { const part = perfPart(row,component.id); columns.push(perfT('perf.comp.' + component.key) + ': ' + (part.present ? perfMeasure(component.id,part.measure) : '– (' + perfReason(part,row.source) + ')')); }
  return columns.join('\t');
}
async function perfCopyRow() {
  const item = perfCopyModel; if (!item) return;
  try { if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable'); await navigator.clipboard.writeText(perfCopyText(item)); if (!perfDestroyed) perfText(node('perf-copy-status'),perfT('copied')); }
  catch { if (!perfDestroyed) perfText(node('perf-copy-status'),perfT('copyUnavailable')); }
  const menu = node('perf-copy-menu'); if (menu) menu.hidden = true;
}

const perfNoReadout = Object.freeze({visible:false,stackOffset:0,needleLegend:false,glyphs:[],key:'off',description:''});
const perfPlacements = {
  led:{near:-.245,t:.050,fit:.44,value:.24,valueBase:.012,titleBase:.206,titleSize:.062,dots:.3785,recenter:true},
  liquid:{near:-.245,t:.050,fit:.44,value:.24,valueBase:.012,titleBase:.206,titleSize:.062,dots:.3785,recenter:true},
  reactor:{near:-.155,t:.046,fit:.32,value:.205,valueBase:.03,titleBase:.184,titleSize:.058,dots:.252,recenter:false},
  needle:{near:.108,t:.046,fit:.285,value:.205,valueBase:.035,titleBase:.338,titleSize:.062,dots:.405,recenter:false,below:true},
  minimal:{near:-.228,t:.054,fit:.50,value:.30,valueBase:.07,titleBase:.168,titleSize:.068,dots:null,recenter:true}
};
function perfMeasureText(text,size,weight = 600) {
  if (!perfMeasurement) { const canvas = document.createElement('canvas'); perfMeasurement = canvas.getContext('2d'); }
  if (!perfMeasurement) return null;
  perfMeasurement.font = weight + ' ' + size + 'px "Segoe UI Variable Display","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif';
  return perfMeasurement.measureText(text).width;
}
function perfReadoutFits(style,size,showScore,showThinking,scoreText = '8,888') {
  const placement = perfPlacements[style]; if (!placement) return false;
  const t = Math.max(7,placement.t*size), p = 1.25*t, glyphSize = .82;
  const scoreGlyph = perfMeasureText(perfT('intel.glyph'),glyphSize*p), scoreNumber = perfMeasureText(scoreText,p), thinkGlyph = perfMeasureText(perfT('intel.thinking.glyph'),glyphSize*t), thinkNumber = perfMeasureText('8.88',t), unit = style === 'needle' ? 0 : perfMeasureText('tok/s',glyphSize*t,500);
  if ([scoreGlyph,scoreNumber,thinkGlyph,thinkNumber,unit].some(value => value === null)) return false;
  const scoreWidth = scoreGlyph+.2*p+scoreNumber, thinkWidth = thinkGlyph+.16*t+thinkNumber+(unit ? .16*t+unit : 0), limit = placement.fit*size;
  if (showScore && scoreWidth > limit || showThinking && thinkWidth > limit) return false;
  if (style !== 'needle') return true;
  const top = placement.near*size+.7*(p-t), bottom = showScore ? top+1.32*t : placement.near*size;
  return (!showScore || Math.hypot(scoreWidth/2,top) <= .223*size) && (!showThinking || Math.hypot(thinkWidth/2,bottom) <= .223*size);
}
function perfTop(snapshot) {
  if (!snapshot || !snapshot.performance) return null;
  const top = perfModel.highest(snapshot.agents,snapshot.performance.current); if (top.agent === null) return null;
  const agent = snapshot.agents.find(candidate => candidate.id === top.agent), status = snapshot.performance.current[top.agent]; if (!agent || !status) return null;
  let count = 0; for (const member of snapshot.agents) { const current = snapshot.performance.current[member.id]; if (current && current.form === top.form && current.score !== null) count++; }
  return {agent,status,count};
}
function perfTweenValue(tween,now) {
  if (!tween) return 0;
  const ratio = Math.min(1,Math.max(0,(now-tween.start)/tween.duration)), eased = ratio*ratio*(3-2*ratio); return tween.from+(tween.to-tween.from)*eased;
}
function perfSetTween(entry,name,target,now,duration,keepWithReduced = false) {
  const previous = entry[name];
  if (perfReduced() && !keepWithReduced) { if (!previous || previous.from !== target || previous.to !== target) entry[name] = {from:target,to:target,start:now,duration:1}; return; }
  if (previous && previous.to === target) return;
  const from = previous ? perfTweenValue(previous,now) : target; entry[name] = {from,to:target,start:now,duration};
  if (from !== target && entry.surfaceVisible) perfScheduleAnimation();
}
function perfReadoutEntry(id) {
  let entry = perfReadouts.get(id); if (entry) return entry;
  const host = node(id); if (!host) return null;
  const root = perfElement('div','perf-theme perf-orb-lines'), scoreLine = perfElement('div','perf-ln perf-ln-score'), scoreLabel = perfElement('span','perf-glyph'), score = perfElement('span','perf-n'), thinking = perfElement('div','perf-ln perf-ln-thinking'), thinkingLabel = perfElement('span','perf-glyph'), thinkingNumber = perfElement('span','perf-n'), thinkingUnit = perfElement('span','perf-unit','tok/s');
  root.setAttribute('aria-hidden','true'); scoreLine.append(scoreLabel,score); thinking.append(thinkingLabel,thinkingNumber,thinkingUnit); root.append(scoreLine,thinking); host.append(root);
  entry = {id,host,root,scoreLine,scoreLabel,score,thinking,thinkingLabel,thinkingNumber,thinkingUnit,visibility:{hidden:true,zeroSince:null,enabled:true},quietSince:null,lastTop:null,top:null,wasActive:false,frame:perfNoReadout,frameKey:'',alpha:{from:0,to:0,start:0,duration:1},fold:{from:1,to:1,start:0,duration:1},thinkingAlpha:{from:0,to:0,start:0,duration:1},peakStart:-Infinity,surfaceVisible:false,layoutKey:'',fit:false,wideText:'8,888',wideUntil:0};
  perfReadouts.set(id,entry); return entry;
}
function perfReadoutLayout(entry,now) {
  const placement = perfPlacements[entry.style], t = Math.max(7,placement.t*entry.size), value = entry.top ? entry.top.status.shown : null, shown = perfNumber(value,true);
  const measured = perfMeasureText(shown,1.25*t), baseWidth = perfMeasureText('8,888',1.25*t), lastWidth = perfMeasureText(entry.wideText,1.25*t);
  if (measured !== null && baseWidth !== null && lastWidth !== null) {
    if (measured > baseWidth && measured >= lastWidth) { entry.wideText = shown; entry.wideUntil = now+6000; }
    else if (now >= entry.wideUntil) { entry.wideText = measured > baseWidth ? shown : '8,888'; entry.wideUntil = measured > baseWidth ? now+6000 : 0; }
  }
  const layoutKey = [entry.style,entry.size,language,entry.showScore,entry.showThinking,entry.wideText,perfContrastQuery.matches,perfForcedColorsQuery.matches].join('|');
  if (layoutKey !== entry.layoutKey) { entry.layoutKey = layoutKey; entry.fit = perfReadoutFits(entry.style,entry.size,entry.showScore,entry.showThinking,entry.wideText); }
  entry.root.style.setProperty('--perf-t',t + 'px'); entry.root.style.setProperty('--perf-p',1.25*t + 'px');
}
function perfPrepareReadouts(now) {
  const live = liveFacts(), top = perfTop(live), rate = live && live.rate, preferences = view && view.preferences; if (!preferences) return;
  const thinking = rate && !(rate.measuredThinkingTps == null && rate.estimatedThinkingTps == null) ? (rate.measuredThinkingTps ?? 0)+(rate.estimatedThinkingTps ?? 0) : null;
  const showScore = preferences.showPerformance === true, showThinking = preferences.showThinking !== false, generating = !!live && live.agents.some(agent => agent.phase === 'generating');
  for (const id of ['orb-art','hero-art']) {
    const entry = perfReadoutEntry(id); if (!entry) continue;
    entry.surfaceVisible = !document.hidden && (id === 'orb-art' ? view.surface === 'orb' && view.orbVisible : view.surface === 'dashboard'); entry.style = id === 'hero-art' ? 'led' : preferences.style; entry.size = id === 'hero-art' ? 112 : preferences.size;
    entry.showScore = showScore; entry.showThinking = showThinking; entry.thinkingValue = thinking;
    entry.visibility = perfThinkingVisibility(entry.visibility,thinking,showThinking,now); const thinkingShown = showThinking && !entry.visibility.hidden;
    const active = showScore && !!top || generating && (showScore || showThinking) || showThinking && thinking !== null && thinking >= .05;
    if (active) entry.wasActive = true; if (top && showScore) entry.lastTop = top;
    if (active) entry.quietSince = null; else if (entry.quietSince === null) entry.quietSince = now;
    const quiet = entry.quietSince !== null && now-entry.quietSince >= 10000, hasRetained = entry.lastTop && entry.quietSince !== null && now-entry.quietSince < 10600;
    entry.top = top && showScore ? top : showScore && hasRetained ? entry.lastTop : null;
    if (quiet && now-entry.quietSince >= 10600) { entry.lastTop = null; entry.wasActive = false; }
    perfReadoutLayout(entry,now);
    const showAny = (showScore || thinkingShown) && entry.fit && (active || entry.top || entry.wasActive) && !quiet;
    perfSetTween(entry,'alpha',showAny ? 1 : 0,now,showAny ? 250 : 600); perfSetTween(entry,'fold',thinkingShown && showScore ? 0 : 1,now,300); perfSetTween(entry,'thinkingAlpha',thinkingShown ? 1 : 0,now,250);
    const status = entry.top && entry.top.status;
    perfSetTween(entry,'numberTone',!status || status.shown === null || status.form === 'resting' ? 1 : 0,now,200,true);
    perfSetNumberState(entry.score,status); perfAnimateScore(entry.score,status ? status.shown : null,'orb',entry.surfaceVisible && entry.fit);
    perfText(entry.scoreLabel,perfT('intel.glyph')); perfText(entry.thinkingLabel,perfT('intel.thinking.glyph')); perfText(entry.thinkingNumber,perfSpeed(thinking));
    entry.scoreLine.hidden = !showScore; entry.thinkingUnit.hidden = entry.style === 'needle'; entry.root.dataset.style = entry.style;
    entry.root.style.visibility = perfForcedColorsQuery.matches ? 'visible' : '';
    entry.scoreLine.classList.toggle('perf-is-pale',!!status && status.form === 'resting'); entry.scoreLine.classList.toggle('perf-is-quiet',!status || status.shown === null); entry.thinking.classList.toggle('perf-is-quiet',thinking === null);
    const sentence = showScore ? perfReadoutSentence(status,entry.top ? entry.top.count : 0,thinkingShown ? perfSpeed(thinking) : null) : perfT('intel.thinking.glyph') + ' ' + perfSpeed(thinking) + ' tok/s';
    entry.root.setAttribute('aria-label',sentence);
    entry.host.perfReadoutDescription = showAny ? entry.root.getAttribute('aria-label') : '';
    const hit = id === 'orb-art' ? node('orb-hit') : null;
    if (hit) hit.title = entry.top ? perfT('perf.tooltip.top',perfNumber(status.shown),entry.top.agent.project || entry.top.agent.name || entry.top.agent.id) + '\n' + perfT('perf.tooltip.note') : showThinking && thinking !== null ? perfT('intel.thinking.glyph') + ' ' + perfSpeed(thinking) + ' tok/s' : '';
  }
}
function perfGlyphs(baseline,size,label,value,unit,role,provisional,alpha) {
  const small = .82*size, gap = (label === perfT('intel.glyph') ? .20 : .16)*size, labelWidth = perfMeasureText(label,small), numberWidth = perfMeasureText(value,size), unitWidth = unit ? perfMeasureText(unit,small,500) : 0;
  if (labelWidth === null || numberWidth === null || unitWidth === null) return [];
  const width = labelWidth+gap+numberWidth+(unit ? gap+unitWidth : 0), dpr = window.devicePixelRatio || 1, snap = value => Math.round(value*dpr)/dpr;
  let x = snap(-width/2); const glyphs = [{text:label,x,y:baseline,size:small,weight:600,role:1,provisional:false,alpha}]; x = snap(x+labelWidth+gap);
  glyphs.push({text:value,x,y:baseline,size,weight:600,role,provisional,alpha});
  if (unit) glyphs.push({text:unit,x:snap(x+numberWidth+gap),y:baseline,size:small,weight:500,role:1,provisional:false,alpha}); return glyphs;
}
function perfToneGlyphs(entry,baseline,size,value,provisional,alpha,now) {
  const tone = perfTweenValue(entry.numberTone,now), glyphs = [];
  if (tone < .999) glyphs.push(...perfGlyphs(baseline,size,perfT('intel.glyph'),value,'',0,provisional,alpha*(1-tone)));
  if (tone > .001) glyphs.push(...perfGlyphs(baseline,size,perfT('intel.glyph'),value,'',1,provisional,alpha*tone));
  return glyphs;
}
function perfRenderReadouts(now) {
  for (const entry of perfReadouts.values()) {
    const placement = perfPlacements[entry.style]; if (!placement) continue;
    const size = entry.size, t = Math.max(7,placement.t*size), p = 1.25*t, alpha = perfTweenValue(entry.alpha,now), fold = perfTweenValue(entry.fold,now), thinkingAlpha = perfTweenValue(entry.thinkingAlpha,now), peakAge = now-entry.peakStart;
    let peakAlpha = 1;
    if (entry.style !== 'needle' && peakAge >= 0 && peakAge < 1950) {
      if (perfReduced()) peakAlpha = peakAge < 1800 ? 0 : 1;
      else peakAlpha = peakAge < 150 ? 1-peakAge/150 : peakAge < 1800 ? 0 : (peakAge-1800)/150;
    }
    const top = placement.below ? placement.near*size+.7*(p-t) : placement.near*size-1.32*t, single = placement.below ? top : placement.near*size, scoreBaseline = top+(single-top)*fold;
    let shift = 0;
    if (placement.recenter && entry.id !== 'hero-art') {
      const blockTop = entry.showScore ? scoreBaseline-.70*p : placement.near*size-.70*t, valueTop = (placement.valueBase-.70*placement.value)*size; shift = Math.max(0,(valueTop-blockTop)/2);
      if (placement.dots !== null) { const titleBottom = placement.titleBase*size+.22*Math.max(7,placement.titleSize*size), dotsTop = placement.dots*size-2*size/148; shift = Math.min(shift,Math.max(0,dotsTop-.05*size-titleBottom)); }
      shift *= alpha;
    }
    const visible = !!entry.surfaceVisible && entry.fit && alpha > .001 && (entry.showScore || entry.showThinking), scoreY = scoreBaseline+shift, thinkingY = (entry.showScore ? (placement.below ? top+1.32*t : placement.near*size) : placement.near*size)+shift;
    entry.scoreLine.style.top = (size/2+scoreY-.855*p) + 'px'; entry.thinking.style.top = (size/2+thinkingY-.855*t) + 'px'; entry.thinking.style.opacity = String(thinkingAlpha); entry.thinking.hidden = !entry.showThinking || thinkingAlpha < .001; entry.root.style.opacity = String(alpha*peakAlpha); entry.root.hidden = !visible;
    const status = entry.top && entry.top.status, provisional = !!status && status.shown !== null && status.provisional, glyphs = [];
    if (visible && entry.showScore && !perfForcedColorsQuery.matches) {
      const fade = perfNumberFades.get(entry.score);
      if (fade) {
        const progress = Math.min(1,Math.max(0,(now-fade.start)/fade.duration)), incoming = 1-Math.pow(1-progress,2);
        glyphs.push(...perfToneGlyphs(entry,scoreY,p,perfNumber(fade.from,true),fade.fromProvisional,alpha*peakAlpha*(1-incoming),now));
        glyphs.push(...perfToneGlyphs(entry,scoreY,p,perfNumber(fade.to,true),provisional,alpha*peakAlpha*incoming,now));
      } else glyphs.push(...perfToneGlyphs(entry,scoreY,p,entry.score.textContent,provisional,alpha*peakAlpha,now));
    }
    if (visible && entry.showThinking && thinkingAlpha > .001 && !perfForcedColorsQuery.matches) glyphs.push(...perfGlyphs(thinkingY,t,perfT('intel.thinking.glyph'),perfSpeed(entry.thinkingValue),entry.style === 'needle' ? '' : 'tok/s',entry.thinkingValue === null ? 1 : 0,false,alpha*peakAlpha*thinkingAlpha));
    const needleLegend = entry.style === 'needle' && entry.fit && (entry.showScore || entry.showThinking), contrast = perfContrastQuery.matches, description = visible ? entry.root.getAttribute('aria-label') : '', key = JSON.stringify([visible,shift,needleLegend,contrast,description,glyphs]);
    if (key !== entry.frameKey) { entry.frameKey = key; entry.frame = {visible,stackOffset:visible ? shift : 0,needleLegend,glyphs,key,contrast,description}; entry.host.dispatchEvent(new CustomEvent('perf-readout-change',{detail:entry.frame})); }
  }
}
function perfOrbReadoutFrame(id) { const entry = perfReadouts.get(id); return entry && entry.surfaceVisible ? entry.frame : perfNoReadout; }
function perfHasReadoutMotion(now) {
  for (const entry of perfReadouts.values()) {
    if (!entry.surfaceVisible || !entry.fit) continue;
    for (const name of ['alpha','fold','thinkingAlpha','numberTone']) { const tween = entry[name]; if (tween && tween.from !== tween.to && now < tween.start+tween.duration) return true; }
    const age = now-entry.peakStart; if (age >= 0 && (age < 150 || age >= 1800 && age < 1950) && !perfReduced()) return true;
  }
  return false;
}
function perfAnimationTick(now) {
  perfRaf = 0; if (perfDestroyed || document.hidden) return;
  const orbDue = !perfLastRaf || now-perfLastRaf >= 1000/30; let pending = false;
  for (const [element,animation] of perfNumberAnimations) {
    if (!element.isConnected) { perfNumberAnimations.delete(element); continue; }
    if (animation.surface === 'orb' && !orbDue) { pending = true; continue; }
    const ratio = Math.min(1,(now-animation.start)/animation.duration), eased = 1-Math.pow(1-ratio,3);
    perfDisplayNumber(element,ratio >= 1 ? animation.to : perfRound(animation.from+(animation.to-animation.from)*eased),animation.compact,animation.meter);
    if (ratio >= 1) perfNumberAnimations.delete(element); else pending = true;
  }
  for (const [element,fade] of perfNumberFades) {
    if (!element.isConnected) { perfFinishNumberFade(element); continue; }
    if (fade.surface === 'orb' && !orbDue) { pending = true; continue; }
    const progress = Math.min(1,Math.max(0,(now-fade.start)/fade.duration)), incoming = 1-Math.pow(1-progress,2);
    element.style.setProperty('--perf-outgoing-alpha',String(1-incoming)); element.style.setProperty('--perf-incoming-alpha',String(incoming));
    if (progress >= 1) perfFinishNumberFade(element); else pending = true;
  }
  if (orbDue) { perfLastRaf = now; perfRenderReadouts(now); }
  if (pending || perfHasReadoutMotion(now)) perfScheduleAnimation();
}
function perfScheduleWake(now) {
  clearTimeout(perfWakeTimer); perfWakeTimer = null; if (document.hidden || perfDestroyed) return;
  let next = Infinity;
  for (const entry of perfReadouts.values()) {
    if (!entry.surfaceVisible) continue;
    if (entry.visibility.zeroSince !== null && !entry.visibility.hidden) next = Math.min(next,entry.visibility.zeroSince+3000);
    if (entry.quietSince !== null) for (const delay of [10000,10600]) if (entry.quietSince+delay > now) next = Math.min(next,entry.quietSince+delay);
    if (entry.peakStart+1800 > now && entry.peakStart+1800 < Infinity) next = Math.min(next,entry.peakStart+1800);
    if (entry.wideUntil > now) next = Math.min(next,entry.wideUntil);
  }
  if (Number.isFinite(next) && next > now) perfWakeTimer = setTimeout(() => { perfWakeTimer = null; renderPerfUI(perfFacts()); },Math.max(1,next-now));
}
function perfCancelAnimations() {
  if (perfRaf) cancelAnimationFrame(perfRaf); perfRaf = 0; perfLastRaf = 0;
  for (const [element,animation] of perfNumberAnimations) perfDisplayNumber(element,animation.to,animation.compact,animation.meter);
  for (const element of perfNumberFades.keys()) perfFinishNumberFade(element);
  perfNumberAnimations.clear(); for (const effect of perfEffects) effect.cancel(); perfEffects.clear();
}
function perfPointerOver(event) {
  const anchor = perfAnchor(event.target); if (anchor === perfHoveredAnchor) return;
  perfHoveredAnchor = anchor;
  const dismissed = anchor && perfDismissedAnchor && anchor.dataset.perfAgentId === perfDismissedAnchor.dataset.perfAgentId && anchor.dataset.perfCardHost === perfDismissedAnchor.dataset.perfCardHost;
  if (dismissed) perfDismissedAnchor = anchor; else perfDismissedAnchor = null;
  if (anchor && !dismissed && !(event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) perfQueueCard(anchor);
}
function perfPointerOut(event) {
  const anchor = perfAnchor(event.target); if (!anchor || event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget)) return;
  perfHoveredAnchor = null; if (perfDismissedAnchor === anchor) perfDismissedAnchor = null;
  clearTimeout(perfHoverTimer); perfHoverTimer = null; clearTimeout(perfHideTimer);
  perfHideTimer = setTimeout(() => { perfHideTimer = null; if (!perfCardState || !perfCardState.keyboard) perfHideCard(); },150);
}
function perfHistoryKeydown(event) {
  const row = event.target instanceof Element ? event.target.closest('[data-perf-row-key]') : null; if (!row || !row.perfModelItem) return false;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); event.stopPropagation(); perfCopyModel = row.perfModelItem; void perfCopyRow(); return true; }
  if (!['ArrowUp','ArrowDown','Home','End','Enter',' '].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return false;
  event.preventDefault(); event.stopPropagation(); const rows = perfSortedRows(); let index = rows.findIndex(item => perfHistoryRowKey(item) === row.dataset.perfRowKey);
  if (event.key === 'Home') index = 0; else if (event.key === 'End') index = rows.length-1; else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') index = Math.max(0,Math.min(rows.length-1,index+(event.key === 'ArrowUp' ? -1 : 1)));
  perfSelectRow(perfHistoryRowKey(rows[index]),true,row.classList.contains('perf-list-item')); return true;
}
function perfKeydown(event) {
  if (event.key === 'Escape') {
    const menu = node('perf-copy-menu'), info = node('perf-history-info');
    if (menu && !menu.hidden) { event.preventDefault(); event.stopPropagation(); menu.hidden = true; return; }
    if (info && !info.hidden) { event.preventDefault(); event.stopPropagation(); perfHideInfo(true); return; }
    if (perfCardState || perfHoverTimer) { event.preventDefault(); event.stopPropagation(); perfDismissedAnchor = perfHoveredAnchor || perfCardState && perfCardState.anchor; perfHideCard(); return; }
  }
  if (perfHistoryKeydown(event)) return;
  const anchor = perfAnchor(event.target);
  const opensCard = event.key === ' ' || event.key === 'Enter' && anchor && anchor.dataset.perfCardHost !== 'board';
  if (opensCard && anchor && !event.altKey && !event.ctrlKey && !event.metaKey && !event.target.closest('button,input,select')) { event.preventDefault(); event.stopPropagation(); perfShowCard(anchor.dataset.perfAgentId,anchor,perfOptions(anchor,true)); return; }
  if (!perfCardState || !['ArrowDown','ArrowUp','PageDown','PageUp','Home','End'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
  const card = node('perf-score-card'); if (!card || card.scrollHeight <= card.clientHeight || !anchor) return;
  event.preventDefault(); event.stopPropagation(); let delta = 0;
  if (event.key === 'ArrowDown') delta = 32; if (event.key === 'ArrowUp') delta = -32; if (event.key === 'PageDown') delta = card.clientHeight*.8; if (event.key === 'PageUp') delta = -card.clientHeight*.8;
  card.scrollTop = event.key === 'Home' ? 0 : event.key === 'End' ? card.scrollHeight : card.scrollTop+delta;
}
function perfClick(event) {
  const target = event.target instanceof Element ? event.target : null; if (!target) return;
  const sort = target.closest('[data-perf-sort]');
  if (sort) { const key = sort.dataset.perfSort; if (perfHistorySort === key) perfHistoryDescending = !perfHistoryDescending; else { perfHistorySort = key; perfHistoryDescending = key !== 'model'; } perfHistoryKey = ''; perfRenderHistory(perfFacts()); return; }
  const row = target.closest('[data-perf-row-key]'); if (row && row.perfModelItem) perfSelectRow(row.dataset.perfRowKey);
}
function perfBindPopupControls() {
  const button = node('perf-performance-info'); if (button) perfListen(button,'click',() => { if (node('perf-history-info').hidden) perfShowInfo(); else perfHideInfo(); });
  const close = node('perf-info-close'); if (close) perfListen(close,'click',() => perfHideInfo(true));
  const copy = node('perf-copy-row'); if (copy) perfListen(copy,'click',perfCopyRow);
  perfListen(document,'contextmenu',event => {
    const row = event.target instanceof Element ? event.target.closest('[data-perf-row-key]') : null; if (!row || !row.perfModelItem) return;
    event.preventDefault(); perfCopyModel = row.perfModelItem; const menu = node('perf-copy-menu'); perfText(node('perf-copy-row'),perfT('copy')); menu.hidden = false;
    menu.style.left = Math.max(8,Math.min(event.clientX,window.innerWidth-menu.offsetWidth-8)) + 'px'; menu.style.top = Math.max(8,Math.min(event.clientY,window.innerHeight-menu.offsetHeight-8)) + 'px';
  });
  perfListen(document,'pointerdown',event => {
    const info = node('perf-history-info'), infoButton = node('perf-performance-info'), menu = node('perf-copy-menu');
    if (info && !info.hidden && !info.contains(event.target) && !infoButton.contains(event.target)) perfHideInfo();
    if (menu && !menu.hidden && !menu.contains(event.target)) menu.hidden = true;
  });
}
function perfBindCardControls() {
  perfListen(document,'pointerover',perfPointerOver); perfListen(document,'pointerout',perfPointerOut);
  perfListen(document.documentElement,'pointerleave',() => { perfHoveredAnchor = perfDismissedAnchor = null; });
  perfListen(document,'focusin',event => { const anchor = perfAnchor(event.target); if (anchor && perfCardState) perfShowCard(anchor.dataset.perfAgentId,anchor,perfOptions(anchor,true)); });
  perfListen(document,'focusout',event => { if (!perfCardState || !perfCardState.keyboard || perfAnchor(event.relatedTarget)) return; if (perfCardState.anchor.contains(event.target)) perfHideCard(); });
  perfListen(document,'keydown',perfKeydown,true); perfListen(document,'click',perfClick);
  perfListen(document,'scroll',() => { if (perfCardState) perfPositionCard(); },true);
}
function perfSuspend() {
  clearTimeout(perfWakeTimer); perfWakeTimer = null; perfCancelAnimations(); perfHideCard(); perfHideInfo(); perfHideChartTooltip();
  const menu = node('perf-copy-menu'); if (menu) menu.hidden = true;
  for (const entry of perfReadouts.values()) { entry.surfaceVisible = false; entry.root.hidden = true; entry.frame = perfNoReadout; entry.frameKey = ''; entry.host.dispatchEvent(new CustomEvent('perf-readout-change',{detail:perfNoReadout})); }
}
function bindPerfUI() {
  if (perfBound || perfDestroyed) return; perfBound = true; const template = node('perf-ui-markup');
  if (template) {
    for (const id of ['perf-score-card','perf-performance','perf-readout-settings','perf-history-info','perf-copy-menu','perf-copy-status']) {
      if (node(id)) continue; const source = template.content.querySelector('#' + id); if (!source) continue; const copy = source.cloneNode(true);
      const target = id === 'perf-performance' ? node('perf-history-slot') : id === 'perf-readout-settings' ? node('perf-settings-slot') || node('page-orb') : document.body; if (target) target.append(copy);
    }
  }
  perfPlaceHistory(); monitorSelectPicker.install(node('perf-performance'));
  for (const [id,key] of [['show-performance','showPerformance'],['show-thinking','showThinking']]) { const input = node(id); if (input) perfListen(input,'change',() => action(() => bridge.configure({[key]:input.checked}))); }
  const sort = node('perf-model-sort'); if (sort) perfListen(sort,'change',() => { perfHistorySort = sort.value; perfHistoryKey = ''; perfRenderHistory(perfFacts()); });
  const direction = node('perf-sort-direction'); if (direction) perfListen(direction,'click',() => { perfHistoryDescending = !perfHistoryDescending; perfHistoryKey = ''; perfRenderHistory(perfFacts()); });
  perfBindPopupControls(); perfBindCardControls();
  perfListen(document,'visibilitychange',() => { if (document.hidden) perfSuspend(); else renderPerfUI(perfFacts()); });
  perfListen(window,'resize',() => { perfHistoryKey = ''; perfRenderHistory(perfFacts()); perfRenderReadouts(performance.now()); perfPositionCard(); perfHideInfo(); });
  perfListen(window,'blur',perfHideCard);
  for (const query of [perfMotionQuery,perfContrastQuery,perfForcedColorsQuery]) perfListen(query,'change',() => renderPerfUI(perfFacts()));
  if (typeof ResizeObserver === 'function') {
    perfChartObserver = new ResizeObserver(() => {
      const section = node('perf-performance'); if (!perfChartState || !section || !view || view.surface !== 'history') return;
      perfFitModelNames(section);
      const width = Math.max(260,section.clientWidth-36); if (width === perfChartState.width) return;
      const trend = node('perf-history-trend'); if (trend) perfRenderTrend(perfChartState.row,selectedDates(),trend);
    });
    const section = node('perf-performance'); if (section) perfChartObserver.observe(section);
  }
  if (document.fonts && typeof document.fonts.addEventListener === 'function') perfListen(document.fonts,'loadingdone',() => { perfMeasurement = null; perfFontWidths.clear(); perfCellWidths.clear(); for (const entry of perfReadouts.values()) entry.layoutKey = ''; renderPerfUI(perfFacts()); const section = node('perf-performance'); if (section) perfFitModelNames(section); });
}
function perfResetScope(now) {
  perfCancelAnimations(); perfHideCard(); perfRowValues.clear(); perfCellWidths.clear(); perfDismissedAnchor = perfHoveredAnchor = null; perfHistoryKey = ''; perfLastPeak = null;
  for (const entry of perfReadouts.values()) {
    entry.lastTop = null; entry.top = null; entry.wasActive = false; entry.visibility = {hidden:true,zeroSince:null,enabled:true}; entry.quietSince = null;
    entry.alpha = {from:0,to:0,start:now,duration:1}; entry.fold = {from:1,to:1,start:now,duration:1}; entry.thinkingAlpha = {from:0,to:0,start:now,duration:1};
    entry.numberTone = null;
    entry.score.perfScoreValue = undefined; entry.score.perfDisplayedValue = undefined; perfNumberAnimations.delete(entry.score); entry.peakStart = -Infinity; entry.wideText = '8,888'; entry.wideUntil = 0;
  }
}
function perfReconcileCard() {
  if (!perfCardState) return; if (!perfScoresEnabled()) { perfHideCard(); return; }
  if (!perfCardState.anchor.isConnected) {
    const previous = perfCardState.anchor, host = previous.dataset.perfCardHost || 'dashboard', boardItem = previous.closest('[data-board-key]'), boardKey = boardItem ? boardItem.dataset.boardKey : null;
    let rowClass = ''; if (previous.classList.contains('row')) rowClass = 'row'; if (previous.classList.contains('agent-row')) rowClass = 'agent-row';
    const replacement = Array.from(document.querySelectorAll('[data-perf-agent-id]')).find(anchor => {
      if (anchor.dataset.perfAgentId !== perfCardState.id || anchor.dataset.perfCardHost !== host || previous.id && anchor.id !== previous.id || rowClass && !anchor.classList.contains(rowClass)) return false;
      const item = anchor.closest('[data-board-key]'); return boardKey === null || !!item && item.dataset.boardKey === boardKey;
    });
    if (!replacement) { perfHideCard(); return; }
    const wasDismissed = perfDismissedAnchor === perfCardState.anchor; perfCardState.anchor = replacement;
    if (wasDismissed) perfDismissedAnchor = replacement; replacement.dataset.perfOpen = 'true';
    if (perfCardState.keyboard) replacement.focus({preventScroll:true});
  }
  perfCardState.options = {...perfCardState.options,...perfOptions(perfCardState.anchor,perfCardState.keyboard)}; perfUpdateCard();
}
function renderPerfUI(snapshot) {
  if (perfDestroyed) return; if (!perfBound) bindPerfUI(); perfSnapshot = snapshot || null; if (!view) return;
  const now = performance.now(), scope = JSON.stringify([view.instanceId,view.scope.profile,view.scope.project]);
  if (perfReduced()) perfCancelAnimations(); if (scope !== perfScopeKey) { perfScopeKey = scope; perfResetScope(now); }
  const score = node('show-performance'), thinking = node('show-thinking'); if (score) score.checked = view.preferences.showPerformance === true; if (thinking) thinking.checked = view.preferences.showThinking !== false;
  if (score) score.setAttribute('aria-labelledby','perf-score-setting-label'); if (thinking) thinking.setAttribute('aria-labelledby','perf-thinking-setting-label');
  for (const [id,key] of [['perf-score-setting-label','showScore'],['perf-score-setting-hint','showScoreHint'],['perf-thinking-setting-label','showThinking'],['perf-thinking-setting-hint','showThinkingHint']]) perfText(node(id),perfT(key));
  const actual = perfFacts(), agents = new Map(actual ? actual.agents.map(agent => [agent.id,agent]) : []);
  for (const id of perfRowValues.keys()) if (!agents.has(id)) { perfRowValues.delete(id); perfCellWidths.delete(id); }
  for (const cell of document.querySelectorAll('.perf-score-cell')) {
    const agent = agents.get(cell.dataset.perfAgentId);
    if (agent) perfUpdateScoreCell(cell,agent);
    else { cell.hidden = !perfScoresEnabled(); perfText(cell.firstElementChild,'–'); perfSetNumberState(cell.firstElementChild,null); cell.dataset.form = 'none'; }
  }
  for (const effect of perfEffects) { const target = effect.effect && effect.effect.target; if (target && !target.isConnected) { effect.cancel(); perfEffects.delete(effect); } }
  perfReconcileCard(); perfRenderHistory(perfSnapshot);
  if (document.hidden) { perfSuspend(); return; }
  perfPrepareReadouts(now);
  const peak = view.activity ? view.activity.peakSequence : null;
  if (perfLastPeak !== null && peak !== perfLastPeak && peak !== null) for (const entry of perfReadouts.values()) if (entry.surfaceVisible && entry.style !== 'needle') entry.peakStart = now;
  perfLastPeak = peak; perfRenderReadouts(now); perfScheduleWake(now);
  if (perfHasReadoutMotion(now) || perfNumberAnimations.size) perfScheduleAnimation();
}
function destroyPerfUI() {
  if (perfDestroyed) return; perfDestroyed = true; perfSuspend(); monitorSelectPicker.close();
  if (perfChartObserver) perfChartObserver.disconnect(); perfChartObserver = null;
  for (const remove of perfListeners.splice(0)) remove();
  for (const entry of perfReadouts.values()) { entry.root.remove(); delete entry.host.perfReadoutDescription; }
  perfReadouts.clear(); perfRowValues.clear(); perfCellWidths.clear(); perfFontWidths.clear(); perfHistoryRows = []; perfHistoryRecords = []; perfCopyModel = null; perfSnapshot = null; perfMeasurement = null; perfChartState = null;
  for (const id of ['perf-score-card','perf-performance','perf-readout-settings','perf-history-info','perf-copy-menu','perf-copy-status']) { const element = node(id); if (element) element.remove(); }
  perfCardView = null; perfHoveredAnchor = perfDismissedAnchor = null;
}
`;
