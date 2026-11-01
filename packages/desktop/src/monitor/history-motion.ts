// Agent Speed Windows v1.6.1 (MIT), frozen 384ce020cc655133e95aaad5cc085f3985f0ed99.
// HistoryChart.cs, Presentation/History/HistoryBars.cs, SpringStackPanel.cs and BreakdownBar.cs.
// UI motion follows the system's Reduce Motion preference, not the orb's effect intensity.
export interface HistoryMotionBar {
  key: string;
  date: string;
  source: string;
  value: number;
}

export interface HistoryMotionFrame {
  startDate: string;
  endDate: string;
  metric: string;
  filter: string;
  maximum: number;
  // Plot insets in DIP; right is an inset, not an x coordinate.
  left: number;
  right: number;
  bars: readonly HistoryMotionBar[];
}

export type HistoryChartTransition = "snap" | "morph" | "live" | "entrance";
export interface HistoryMotionLayer {
  id: number;
  frame: HistoryMotionFrame;
  opacity: number;
}

export interface HistoryChartMotionSample {
  frame: HistoryMotionFrame | null;
  opacity: number;
  lineAlpha: number;
  layers: readonly HistoryMotionLayer[];
  fading: boolean;
  elapsed: number;
}

export interface HistoryChartMotion {
  setTarget: (
    next: HistoryMotionFrame,
    transition: HistoryChartTransition,
    reduceMotion: boolean,
  ) => boolean;
  step: (seconds: number) => void;
  finish: () => void;
  readonly active: boolean;
  readonly target: HistoryMotionFrame | null;
  sample: () => HistoryChartMotionSample;
}

/** Analytic DampedSpring(.3, .86), with the chart's native frame-step cap. */
export function historySpringStep(
  value: number,
  velocity: number,
  seconds: number,
  response = 0.3,
): { value: number; velocity: number } {
  const dt = Math.max(0, Math.min(1 / 20, seconds));
  if (!dt) return { value, velocity };
  const w = (2 * Math.PI) / response,
    z = 0.86,
    wd = w * Math.sqrt(1 - z * z),
    x = value - 1;
  const e = Math.exp(-z * w * dt),
    cos = Math.cos(wd * dt),
    sin = Math.sin(wd * dt);
  return {
    value: 1 + e * (x * cos + ((velocity + z * w * x) / wd) * sin),
    velocity: e * (velocity * cos - ((z * w * velocity + w * w * x) / wd) * sin),
  };
}

/** WPF BackEase.EaseOut, not a cubic-bezier approximation of the native easing. */
export function historyBackEase(progress: number, amplitude: number): number {
  const t = 1 - Math.max(0, Math.min(1, progress));
  return 1 - t * t * t + t * amplitude * Math.sin(Math.PI * t);
}

/** Sparse date/source frames: no materialized empty days, even for multi-year ranges. */
export function createHistoryChartMotion(): HistoryChartMotion {
  let target: HistoryMotionFrame | null = null,
    shown: HistoryMotionFrame | null = null;
  let fromMax = 1,
    fromLeft = 0,
    fromRight = 0,
    fromValues = new Map<string, number>();
  let elapsed = 0,
    spring = { value: 0, velocity: 0 },
    response = 0.3,
    active = false,
    crossfading = false;
  let opacity = 1,
    lineAlpha = 1,
    serial = 0,
    layers: HistoryMotionLayer[] = [];
  let working: HistoryMotionBar[] = [],
    targets = new Map<string, number>();
  const count = (frame: HistoryMotionFrame) =>
    Math.round((Date.parse(frame.endDate) - Date.parse(frame.startDate)) / 86400000) + 1;
  const copy = (frame: HistoryMotionFrame): HistoryMotionFrame => ({
    ...frame,
    bars: frame.bars.map((bar) => ({ ...bar })),
  });
  const equal = (left: HistoryMotionFrame, right: HistoryMotionFrame) => {
    if (
      left.startDate !== right.startDate ||
      left.endDate !== right.endDate ||
      left.metric !== right.metric ||
      left.filter !== right.filter ||
      left.maximum !== right.maximum ||
      left.left !== right.left ||
      left.right !== right.right ||
      left.bars.length !== right.bars.length
    )
      return false;
    for (let index = 0; index < left.bars.length; index++) {
      const bar = left.bars[index]!,
        other = right.bars[index]!;
      if (
        bar.key !== other.key ||
        bar.date !== other.date ||
        bar.source !== other.source ||
        bar.value !== other.value
      )
        return false;
    }
    return true;
  };
  const finish = () => {
    active = false;
    crossfading = false;
    elapsed = 0;
    opacity = lineAlpha = 1;
    layers = [];
    shown = target;
    working = [];
    fromValues.clear();
    targets.clear();
  };
  const startCrossfade = (
    previous: HistoryMotionFrame | null,
    next: HistoryMotionFrame,
    transition: HistoryChartTransition,
  ) => {
    // Snapshot the currently visible mixture when retargeted during a crossfade; do not flash an unseen target.
    const current: HistoryMotionLayer[] = [];
    if (previous) {
      const slots = count(next);
      if (count(previous) === slots) {
        for (const layer of layers)
          if (count(layer.frame) === slots && layer.opacity * (1 - opacity) > 0.001)
            current.push({ ...layer, opacity: layer.opacity * (1 - opacity) });
        if (opacity > 0.001) current.push({ id: ++serial, frame: copy(previous), opacity });
      }
    }
    layers = transition === "entrance" ? [] : current;
    shown = next;
    crossfading = true;
    opacity = 0;
    lineAlpha = 1;
  };
  const startSpring = (
    previous: HistoryMotionFrame | null,
    previousTarget: HistoryMotionFrame | null,
    next: HistoryMotionFrame,
    transition: HistoryChartTransition,
  ) => {
    layers = [];
    crossfading = false;
    opacity = 1;
    const metricChanged = !!previousTarget && previousTarget.metric !== next.metric;
    const factor = metricChanged && previous ? next.maximum / previous.maximum : 1;
    fromMax = previous ? previous.maximum * factor : next.maximum;
    fromLeft = previous ? previous.left : next.left;
    fromRight = previous ? previous.right : next.right;
    fromValues = new Map();
    targets = new Map(next.bars.map((bar) => [bar.key, bar.value]));
    working = next.bars.map((bar) => ({ ...bar, value: 0 }));
    if (previous && transition !== "entrance") {
      for (const bar of previous.bars) {
        if (bar.date < next.startDate || bar.date > next.endDate) continue;
        fromValues.set(bar.key, bar.value * factor);
        if (!targets.has(bar.key)) working.push({ ...bar, value: 0 });
      }
    }
    for (const bar of working) bar.value = fromValues.get(bar.key) || 0;
    shown = { ...next, maximum: fromMax, left: fromLeft, right: fromRight, bars: working };
    spring = { value: 0, velocity: 0 };
    if (transition === "morph" || transition === "entrance") lineAlpha = 0;
  };
  const setTarget = (
    next: HistoryMotionFrame,
    transition: HistoryChartTransition,
    reduceMotion: boolean,
  ) => {
    if (target && equal(target, next)) return false;
    const previous = shown,
      previousTarget = target;
    target = copy(next);
    if (transition === "snap" || (!previous && transition !== "entrance")) {
      finish();
      return true;
    }
    elapsed = 0;
    response = transition === "entrance" ? 0.32 : 0.3;
    active = true;
    if (reduceMotion) startCrossfade(previous, target, transition);
    else startSpring(previous, previousTarget, target, transition);
    return true;
  };
  const step = (seconds: number) => {
    if (!active || !target || !shown) return;
    const dt = Math.max(0, Math.min(1 / 20, seconds));
    elapsed += dt;
    if (crossfading) {
      const t = Math.min(1, elapsed / 0.2);
      opacity = 1 - (1 - t) * (1 - t);
      if (elapsed >= 0.2 - 1e-9) finish();
      return;
    }
    spring = historySpringStep(spring.value, spring.velocity, dt, response);
    lineAlpha = Math.max(lineAlpha, Math.min(1, elapsed / 0.3));
    if (
      elapsed >= 0.45 ||
      (Math.abs(spring.value - 1) < 0.002 && Math.abs(spring.velocity) < 0.02)
    ) {
      finish();
      return;
    }
    const t = spring.value,
      scaleT = Math.max(0, Math.min(1.1, t)),
      marginT = Math.max(0, Math.min(1, t));
    for (const bar of working) {
      const from = fromValues.get(bar.key) || 0;
      bar.value = Math.max(0, from + ((targets.get(bar.key) || 0) - from) * t);
    }
    shown.maximum = fromMax + (target.maximum - fromMax) * scaleT;
    shown.left = fromLeft + (target.left - fromLeft) * marginT;
    shown.right = fromRight + (target.right - fromRight) * marginT;
  };
  return {
    setTarget,
    step,
    finish,
    get active() {
      return active;
    },
    get target() {
      return target;
    },
    sample: () => ({
      frame: shown,
      opacity,
      lineAlpha: crossfading ? opacity : lineAlpha,
      layers: crossfading ? layers : [],
      fading: crossfading,
      elapsed,
    }),
  };
}

export interface HistoryRowLayout {
  key: string;
  top: number;
  fraction: number;
}
export interface HistoryRowMotion extends HistoryRowLayout {
  offset: number;
  opacity: number;
  shownFraction: number;
  placed: boolean;
  moveFrom: number;
  moveElapsed: number;
  fadeFrom: number;
  fadeElapsed: number;
  fractionFrom: number;
  fractionElapsed: number;
}

/** SpringStackPanel's .35 s BackEase(.2), .2 s fades, and BreakdownBar's two native length policies. */
export function createHistoryRowsMotion(kind: "model" | "mode") {
  const rows = new Map<string, HistoryRowMotion>();
  let active = false,
    suspended = false,
    lastReduceMotion = false;
  const settleRow = (row: HistoryRowMotion) => {
    row.offset = 0;
    row.opacity = 1;
    row.shownFraction = row.fraction;
    row.moveElapsed = 0.35;
    row.fadeElapsed = 0.2;
    row.fractionElapsed = 0.45;
  };
  const finish = (suspend = false) => {
    active = false;
    suspended ||= suspend;
    for (const row of rows.values()) settleRow(row);
  };
  const equalRows = (next: readonly HistoryRowLayout[], visible: boolean) => {
    if (next.length !== rows.size) return false;
    for (let index = 0; index < next.length; index++) {
      const layout = next[index]!,
        row = rows.get(layout.key);
      if (
        !row ||
        row.top !== layout.top ||
        row.fraction !== layout.fraction ||
        row.placed !== visible
      )
        return false;
    }
    return true;
  };
  const createRow = (layout: HistoryRowLayout, visible: boolean): HistoryRowMotion => ({
    ...layout,
    offset: 0,
    opacity: 1,
    shownFraction: layout.fraction,
    placed: visible,
    moveFrom: 0,
    moveElapsed: 0.35,
    fadeFrom: 1,
    fadeElapsed: 0.2,
    fractionFrom: layout.fraction,
    fractionElapsed: 0.45,
  });
  const retargetRow = (
    row: HistoryRowMotion,
    layout: HistoryRowLayout,
    fresh: boolean,
    reduceMotion: boolean,
    rebuild: boolean,
  ) => {
    if (fresh) {
      if (kind === "mode") {
        row.opacity = 0;
        row.fadeFrom = 0;
        row.fadeElapsed = 0;
      }
      if (!reduceMotion) {
        row.shownFraction = 0;
        row.fractionFrom = 0;
        row.fractionElapsed = 0;
      }
    } else if (kind === "mode" && Math.abs(row.top - layout.top) > 0.5) {
      if (reduceMotion) {
        row.offset = 0;
        row.moveElapsed = 0.35;
        row.fadeFrom = Math.min(row.opacity, 0.4);
        row.opacity = row.fadeFrom;
        row.fadeElapsed = 0;
      } else {
        row.moveFrom = row.top - layout.top + row.offset;
        row.offset = row.moveFrom;
        row.moveElapsed = 0;
      }
    }
    if (!fresh && row.fraction !== layout.fraction) {
      row.fractionFrom = row.shownFraction;
      row.fractionElapsed = 0;
    }
    if (rebuild && !reduceMotion) {
      row.shownFraction = 0;
      row.fractionFrom = 0;
      row.fractionElapsed = 0;
    }
    row.top = layout.top;
    row.fraction = layout.fraction;
    row.placed = true;
    if (reduceMotion) {
      row.shownFraction = row.fraction;
      row.fractionElapsed = 0.45;
      row.offset = 0;
      row.moveElapsed = 0.35;
    }
  };
  const hasActiveRows = () => {
    const duration = kind === "mode" ? 0.35 : 0.45;
    for (const row of rows.values())
      if (row.moveElapsed < 0.35 || row.fadeElapsed < 0.2 || row.fractionElapsed < duration)
        return true;
    return false;
  };
  const setRows = (
    next: readonly HistoryRowLayout[],
    visible: boolean,
    reduceMotion: boolean,
    rebuild = false,
  ) => {
    if (
      !rebuild &&
      visible === !suspended &&
      reduceMotion === lastReduceMotion &&
      equalRows(next, visible)
    )
      return active;
    const keys = new Set(next.map((row) => row.key));
    for (const key of rows.keys()) if (!keys.has(key)) rows.delete(key);
    for (const layout of next) {
      let row = rows.get(layout.key);
      const fresh = !row;
      if (!row) {
        row = createRow(layout, visible);
        rows.set(layout.key, row);
      }
      if (!visible || suspended || (!fresh && !row.placed)) {
        Object.assign(row, layout);
        settleRow(row);
        row.placed = visible;
        continue;
      }
      retargetRow(row, layout, fresh, reduceMotion, rebuild);
    }
    suspended = !visible;
    lastReduceMotion = reduceMotion;
    active = hasActiveRows();
    return active;
  };
  const step = (seconds: number) => {
    if (!active) return;
    const dt = Math.max(0, seconds),
      duration = kind === "mode" ? 0.35 : 0.45;
    active = false;
    for (const row of rows.values()) {
      if (row.moveElapsed < 0.35) {
        row.moveElapsed = Math.min(0.35, row.moveElapsed + dt);
        row.offset =
          row.moveElapsed === 0.35
            ? 0
            : row.moveFrom * (1 - historyBackEase(row.moveElapsed / 0.35, 0.2));
      }
      if (row.fadeElapsed < 0.2) {
        row.fadeElapsed = Math.min(0.2, row.fadeElapsed + dt);
        row.opacity = row.fadeFrom + ((1 - row.fadeFrom) * row.fadeElapsed) / 0.2;
      }
      if (row.fractionElapsed < duration) {
        row.fractionElapsed = Math.min(duration, row.fractionElapsed + dt);
        const t = row.fractionElapsed / duration,
          eased = kind === "mode" ? historyBackEase(t, 0.25) : 1 - (1 - t) ** 3;
        row.shownFraction =
          row.fractionElapsed === duration
            ? row.fraction
            : row.fractionFrom + (row.fraction - row.fractionFrom) * eased;
      }
      active ||= row.moveElapsed < 0.35 || row.fadeElapsed < 0.2 || row.fractionElapsed < duration;
    }
  };
  return {
    setRows,
    step,
    finish,
    get active() {
      return active;
    },
    rows: () => rows,
    clear: () => {
      rows.clear();
      active = false;
      suspended = false;
      lastReduceMotion = false;
    },
  };
}

export interface HistoryMotionDriverOptions {
  requestFrame: (callback: (time: number) => void) => number;
  cancelFrame: (frame: number) => void;
  visible: () => boolean;
  pending: () => boolean;
  step: (seconds: number) => void;
  paint: () => void;
  finish: () => void;
}

/** One owned RAF for the chart and both lists; a hidden/destroyed surface always finishes, never queues a replay. */
export function createHistoryMotionDriver(options: HistoryMotionDriverOptions) {
  let frame = 0,
    last: number | null = null,
    destroyed = false,
    generation = 0;
  const stop = () => {
    generation++;
    if (frame) options.cancelFrame(frame);
    frame = 0;
    last = null;
  };
  const finish = () => {
    stop();
    options.finish();
    options.paint();
  };
  const wake = () => {
    if (destroyed) return;
    if (!options.visible()) {
      finish();
      return;
    }
    if (!options.pending()) {
      if (frame) stop();
      return;
    }
    if (frame) return;
    const expected = generation;
    frame = options.requestFrame((time) => {
      if (destroyed || generation !== expected) return;
      frame = 0;
      if (!options.visible()) {
        finish();
        return;
      }
      const dt = last === null ? 1 / 60 : Math.max(0, (time - last) / 1000);
      last = time;
      options.step(dt);
      options.paint();
      if (options.pending()) wake();
      else last = null;
    });
  };
  return {
    wake,
    finish,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      stop();
      options.finish();
    },
  };
}

export const MONITOR_HISTORY_MOTION_SCRIPT =
  `
const historySpringStep = ${historySpringStep.toString()};
const historyBackEase = ${historyBackEase.toString()};
const createHistoryChartMotion = ${createHistoryChartMotion.toString()};
const createHistoryRowsMotion = ${createHistoryRowsMotion.toString()};
const createHistoryMotionDriver = ${createHistoryMotionDriver.toString()};
` +
  String.raw`
const historyChartMotion = createHistoryChartMotion(), historyModelMotion = createHistoryRowsMotion('model'), historyModeMotion = createHistoryRowsMotion('mode');
const historyModelRows = new Map(), historyModeRows = new Map();
let historyChartScene = null, historyChartEntered = false, historyChartResumeSnap = false, historyChartTooltipDate = null, historyModeTooltipRow = null;
let historyMotionObserver = null, historyMotionBound = false, historyMotionVisible = false, historyMotionReduced = reducedMotion.matches;
const historySurfaceVisible = () => !rendererDestroyed && !document.hidden && !!view && view.surface === 'history' && !node('history-body').hidden;
function paintHistoryRowsMotion(motion, elements) {
  for (const [key, sample] of motion.rows()) {
    const entry = elements.get(key); if (!entry) continue;
    entry.row.style.transition = 'none';
    entry.row.style.transform = sample.offset ? 'translateY('+sample.offset+'px)' : '';
    entry.row.style.opacity = sample.opacity === 1 ? '' : String(sample.opacity);
    entry.fill.style.transition = 'none'; entry.fill.style.width = Math.max(0,Math.min(1,sample.shownFraction))*100+'%';
  }
}
function paintHistoryMotion() {
  if (historyChartScene) paintHistoryChartMotion();
  paintHistoryRowsMotion(historyModelMotion,historyModelRows); paintHistoryRowsMotion(historyModeMotion,historyModeRows);
  if (historyModeTooltipRow && historyModeTooltip && !historyModeTooltip.hidden) positionHistoryModeTooltip(historyModeTooltipRow);
}
const historyMotionDriver = createHistoryMotionDriver({
  requestFrame:callback => requestAnimationFrame(callback),cancelFrame:frame => cancelAnimationFrame(frame),visible:historySurfaceVisible,
  pending:() => historyChartMotion.active || historyModelMotion.active || historyModeMotion.active,
  step:seconds => { historyChartMotion.step(seconds); historyModelMotion.step(seconds); historyModeMotion.step(seconds); },
  paint:paintHistoryMotion,finish:() => {
    const hidden = !historySurfaceVisible(); historyChartMotion.finish(); historyModelMotion.finish(hidden); historyModeMotion.finish(hidden);
    if (hidden && historyChartEntered) historyChartResumeSnap = true;
  }
});
function historyReconcileChildren(host, children) {
  const keep = new Set(children), focused = document.activeElement;
  for (const child of Array.from(host.children)) if (!keep.has(child)) child.remove();
  let cursor = host.firstElementChild;
  for (const child of children) {
    if (child === cursor) { cursor = cursor.nextElementSibling; continue; }
    if (typeof host.moveBefore === 'function' && child.parentNode === host) host.moveBefore(child,cursor); else host.insertBefore(child,cursor);
  }
  if (focused && focused !== document.activeElement && focused.isConnected && host.contains(focused)) focused.focus({preventScroll:true});
}
function historyRowLayout(rows,motion,host) {
  const top = host.getBoundingClientRect().top;
  return rows.map(entry => ({key:entry.key,top:entry.row.getBoundingClientRect().top-top-(motion.rows().get(entry.key)?.offset||0),fraction:entry.fraction}));
}
function syncHistoryMotionVisibility() {
  const visible = historySurfaceVisible(), reduced = reducedMotion.matches;
  if (!visible || reduced !== historyMotionReduced) historyMotionDriver.finish();
  if (!visible) { if (historyMotionVisible) historyChartResumeSnap = true; hideHistoryModeTooltip(); node('history-chart-tooltip').hidden = true; }
  historyMotionVisible = visible; historyMotionReduced = reduced;
}
function bindHistoryMotion() {
  if (historyMotionBound || rendererDestroyed) return; historyMotionBound = true;
  if (typeof ResizeObserver === 'function') {
    historyMotionObserver = new ResizeObserver(() => {
      if (!historySurfaceVisible()) return;
      renderHistoryChart(rangeDays(snapshotFacts()),selectedDates());
      const entries = Array.from(historyModeRows.values()); historyModeMotion.setRows(historyRowLayout(entries,historyModeMotion,node('history-mode-rows')),true,reducedMotion.matches);
      paintHistoryMotion(); historyMotionDriver.wake();
    });
    historyMotionObserver.observe(node('history-chart')); historyMotionObserver.observe(node('history-mode-rows'));
  }
}
function destroyHistoryMotion() {
  if (historyMotionObserver) historyMotionObserver.disconnect(); historyMotionObserver = null;
  historyMotionDriver.destroy(); historyChartScene = null; historyModelRows.clear(); historyModeRows.clear(); historyModelMotion.clear(); historyModeMotion.clear();
  historyModeTooltipRow = null; historyChartTooltipDate = null;
}
`;
