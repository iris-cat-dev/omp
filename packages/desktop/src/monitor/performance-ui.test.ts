/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MONITOR_PERF_MARKUP,
  MONITOR_PERF_SCRIPT,
  performanceMotionDuration,
  performanceNumber,
  performanceScale,
  performanceThinkingVisibility,
} from "./performance-ui";
import { createPerformanceRecorder } from "./performance";
import { MONITOR_SELECT_PICKER_SCRIPT } from "./select-picker";
import { MONITOR_POPUP_MOTION_SCRIPT } from "./popup-motion";
import { MONITOR_PERF_CARD_HTML } from "./perf-card-html";
import type {
  OmpMonitorPerfCardRequest,
  OmpMonitorPerfCardSize,
  OmpMonitorPerfCardState,
} from "./perf-card-types";
import { DEFAULT_MONITOR_PREFERENCES } from "./window-preferences";
import { DEFAULT_BOARD_PREFERENCES } from "./board-types";
import type { OmpMonitorAgent, OmpMonitorSnapshot } from "./types";
import type {
  MonitorPerformanceComponent,
  MonitorPerformanceEvaluation,
  MonitorPerformanceRecord,
} from "./performance-types";

const now = new Date("2026-10-30T12:00:00").getTime();
function agent(id = "agent-a", patch: Partial<OmpMonitorAgent> = {}): OmpMonitorAgent {
  return {
    id,
    parentId: null,
    name: id,
    project: "project",
    profile: "default",
    kind: "main",
    model: "model-a",
    phase: "generating",
    lastActivityAt: now,
    outputTps: 50,
    totalTps: 50,
    liveMeasuredTps: 50,
    liveEstimatedTps: 0,
    liveMeasuredTotalTps: 50,
    liveEstimatedTotalTps: 0,
    thinkingTps: 20,
    liveCostUsdPerSecond: null,
    speedMode: null,
    effortMode: null,
    ttftMs: 120,
    ...patch,
  };
}
function evaluation(
  patch: Partial<MonitorPerformanceEvaluation> = {},
): MonitorPerformanceEvaluation {
  const component = (
    id: MonitorPerformanceComponent["id"],
    measure: number,
    subScore: number,
  ): MonitorPerformanceComponent => ({
    id,
    present: true,
    reason: null,
    samples: 20,
    measure,
    ratio: subScore / 1000,
    subScore,
  });
  return {
    form: "live",
    score: 1286.4,
    shown: 1286,
    provisional: false,
    n: 20,
    tools: 12,
    activeMs: 240000,
    spanStartMs: now - 240000,
    model: "model-a",
    components: [
      component("T", 80, 1600),
      {
        id: "L",
        present: false,
        reason: "notRecorded",
        samples: 0,
        measure: null,
        ratio: null,
        subScore: null,
      },
      component("N", 3, 1000),
      component("R", 20, 1000),
      component("H", 0.995, 1047.368),
      component("U", 400, 1000),
      component("S", 1, 1052.631),
    ],
    baseline: 1000,
    vsUsual: 0.2864,
    vsUsualPercent: 29,
    ...patch,
  };
}
function record(day: string, model = "model-a", n = 20, output = 50): MonitorPerformanceRecord {
  const recorder = createPerformanceRecorder(() => day);
  const start = new Date(day + "T10:00:00").getTime();
  for (let index = 0; index < n; index++) {
    const time = start + index * 2000;
    recorder.response("agent-a", "omp", {
      key: model + ":" + index,
      model,
      startMs: time,
      endMs: time + 1000,
      durationMs: 1000,
      firstMs: null,
      final: true,
      input: 1000,
      cachedInput: 950,
      output,
      reasoning: Math.min(20, output),
    });
    recorder.action("agent-a", "omp", {
      callMs: time + 1000,
      resultMs: time + 1400,
      failed: false,
      model,
    });
  }
  return recorder.rows()[0]!;
}
function snapshot(
  records: MonitorPerformanceRecord[] = [],
  agents: OmpMonitorAgent[] = [],
  current: Record<string, MonitorPerformanceEvaluation> = {},
): OmpMonitorSnapshot {
  return {
    updatedAt: now,
    scope: { profile: null, project: null },
    scopes: { profiles: ["default"], projects: ["project"] },
    status: "ready",
    resources: {
      status: "unavailable",
      sampledAt: now,
      processCount: 0,
      cpuPercent: null,
      workingSetBytes: null,
      privateBytes: null,
      reason: "no_processes",
    },
    pricing: {
      networkEnabled: false,
      autoSyncPrices: false,
      currency: "USD",
      currencies: ["USD"],
      exchangeRate: 1,
      attribution: null,
      prices: {
        status: "bundled",
        version: "fixture",
        updatedAt: null,
        fetchedAt: null,
        lastAttemptAt: null,
        source: "bundled",
      },
      rates: {
        status: "bundled",
        version: "fixture",
        updatedAt: null,
        fetchedAt: null,
        lastAttemptAt: null,
        source: "bundled",
      },
    },
    activity: {
      lastResponseAt: null,
      peakAt: null,
      peakObservedAt: null,
      totalPeakAt: null,
      totalPeakObservedAt: null,
    },
    today: {
      requests: 0,
      failedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      reasoningKnownRequests: 0,
      reasoningKnownOutputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unpricedRequests: 0,
      estimatedCostUsd: 0,
      unestimatedRequests: 0,
      measuredOutputTokens: 0,
      measuredDurationMs: 0,
      peakOutputTps: 0,
      peakTotalTps: 0,
    },
    days: [],
    series: [],
    breakdowns: { models: [], modes: [] },
    historyRange: {
      startDate: "2026-10-29",
      endDate: "2026-10-29",
      limited: false,
      scanning: false,
    },
    coverage: {
      roots: [{ label: "fixture", available: true }],
      discoveredFiles: 0,
      readFiles: 0,
      skippedFiles: 0,
      malformedLines: 0,
      limited: false,
      issues: [],
    },
    agents,
    rate: {
      measuredTps: 50,
      estimatedTps: 0,
      measuredTotalTps: 50,
      estimatedTotalTps: 0,
      estimatedShare: 0,
      measuredThinkingTps: 20,
      estimatedThinkingTps: null,
    },
    performance: { current, records, baselines: [], scanning: false, limited: false },
  };
}
interface ReadoutFrame {
  visible: boolean;
  stackOffset: number;
  needleLegend: boolean;
  contrast?: boolean;
  glyphs: Array<{
    text: string;
    x: number;
    y: number;
    size: number;
    role: number;
    provisional: boolean;
    alpha: number;
  }>;
  description?: string;
}
interface Runtime {
  render(next?: OmpMonitorSnapshot): void;
  createPerfScoreCell(value: OmpMonitorAgent, host?: string): HTMLElement;
  createModeCell(value: OmpMonitorAgent): HTMLElement;
  modeFacts(value: unknown): {
    word: string;
    level: number;
    topRung: boolean;
    bolts: number;
    effortConfigured: boolean;
    speedConfigured: boolean;
    description: string;
    present: boolean;
  };
  destroy(): void;
  frame(id: string): ReadoutFrame;
  setRange(first: string, last: string): void;
  setLanguage(language: string): void;
  view: {
    snapshot: OmpMonitorSnapshot;
    surface: string;
    scope: { profile: string | null; project: string | null };
    board: { showPerformance: boolean };
    preferences: {
      showPerformance: boolean;
      showThinking: boolean;
      effects: string;
      size: number;
      style: string;
    };
  };
  calls: Array<Record<string, unknown>>;
}
function measuredRect(x = 0, y = 0, width = 0, height = 0): DOMRect {
  const value = { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
  return { ...value, toJSON: () => value };
}

const cleanups: Array<() => void> = [];
function harness(seed: OmpMonitorSnapshot, orb = false) {
  vi.useFakeTimers();
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const realm = iframe.contentWindow as Window & typeof globalThis;
  realm.document.body.dataset.appearance = "light";
  realm.document.body.innerHTML = `<div id="page-orb"><div id="perf-settings-slot"></div></div><main class="history-scroll"><div id="history-body"><div id="perf-history-slot"></div></div><div id="history-empty" hidden></div></main><section id="dashboard-surface"><div id="agent-rows"></div></section>${orb ? '<div id="orb-art"></div><div id="hero-art"></div><div id="orb-hit"></div>' : ""}${MONITOR_PERF_MARKUP}`;
  const dashboard = realm.document.getElementById("dashboard-surface")!;
  dashboard.getBoundingClientRect = () => measuredRect(0, 0, 368, 730);
  Object.defineProperty(realm.document, "hidden", { configurable: true, value: false });
  Object.defineProperty(realm.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value() {},
  });
  // Stable metrics exercise readout state, not native font or GPU acceptance.
  Object.defineProperty(realm.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ font: "", measureText: (text: string) => ({ width: text.length * 4 }) }),
  });
  const queries = new Map<string, { query: MediaQueryList; callbacks: Set<EventListener> }>();
  realm.matchMedia = (name: string) => {
    let entry = queries.get(name);
    if (!entry) {
      const callbacks = new Set<EventListener>();
      const query = {
        matches: false,
        media: name,
        addEventListener(_name: string, listener: EventListener) {
          callbacks.add(listener);
        },
        removeEventListener(_name: string, listener: EventListener) {
          callbacks.delete(listener);
        },
      } as unknown as MediaQueryList;
      entry = { query, callbacks };
      queries.set(name, entry);
    }
    return entry.query;
  };
  const clock = { value: 0 },
    pending = new Map<number, FrameRequestCallback>();
  let serial = 0;
  const perfRequests: Array<OmpMonitorPerfCardRequest | null> = [];
  const clipboard = vi.fn(async (_text: string) => {});
  const runtime = new Function(
    "document",
    "window",
    "Element",
    "Node",
    "CustomEvent",
    "Event",
    "getComputedStyle",
    "navigator",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "performance",
    "seed",
    "perfRequests",
    `let view={snapshot:seed,instanceId:'orb-1',surface:'${orb ? "orb" : "history"}',orbVisible:true,scope:{profile:null,project:null},activity:{peakSequence:0},board:{showPerformance:true},preferences:{showPerformance:true,showThinking:true,effects:'off',size:148,style:'led'}};
     let language='en',appearance='light',range={startDate:'2026-10-29',endDate:'2026-10-29'};const calls=[];
     const node=id=>document.getElementById(id),finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
     const number=(value,digits=0)=>new Intl.NumberFormat('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value);
     const timestamp=value=>String(value),snapshotFacts=()=>view.snapshot,liveFacts=()=>view.snapshot;
     const parseDate=value=>new Date(value+'T12:00:00'),localDate=date=>date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
     const shiftDate=(value,days)=>{const date=parseDate(value);date.setDate(date.getDate()+days);return localDate(date);};
     const dateLabel=value=>value,todayDate=()=>localDate(new Date(view.snapshot.updatedAt)),selectedDates=()=>range;
     const bridge={configure:async patch=>{calls.push(patch);Object.assign(view.preferences,patch);},showPerfCard:request=>perfRequests.push(request)},action=work=>Promise.resolve(work());
     ${MONITOR_POPUP_MOTION_SCRIPT}
     ${MONITOR_SELECT_PICKER_SCRIPT}
     monitorSelectPicker.install();
     ${MONITOR_PERF_SCRIPT}
     bindPerfUI();
     return {view,calls,createPerfScoreCell,createModeCell,modeFacts:perfModeCapsuleFacts,destroy(){destroyPerfUI();monitorPopupMotion.destroy();},frame:perfOrbReadoutFrame,
       render(next){if(next)view.snapshot=next;renderPerfUI(view.snapshot);},
       setRange(first,last){range={startDate:first,endDate:last};renderPerfUI(view.snapshot);},
       setLanguage(value){language=value;renderPerfUI(view.snapshot);}};`,
  )(
    realm.document,
    realm,
    realm.Element,
    realm.Node,
    realm.CustomEvent,
    realm.Event,
    realm.getComputedStyle.bind(realm),
    { clipboard: { writeText: clipboard } },
    (callback: FrameRequestCallback) => {
      pending.set(++serial, callback);
      return serial;
    },
    (id: number) => pending.delete(id),
    { now: () => clock.value },
    seed,
    perfRequests,
  ) as Runtime;
  runtime.render();
  const advance = (ms: number) => {
    const target = clock.value + ms;
    while (clock.value < target) {
      const elapsed = Math.min(16, target - clock.value);
      clock.value += elapsed;
      vi.advanceTimersByTime(elapsed);
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(clock.value);
    }
  };
  const addRow = (value: OmpMonitorAgent) => {
    runtime.view.surface = "dashboard";
    const row = realm.document.createElement("div");
    row.className = "agent-row";
    row.append(
      realm.document.createElement("div"),
      realm.document.createElement("span"),
      runtime.createModeCell(value),
      runtime.createPerfScoreCell(value),
      realm.document.createElement("span"),
    );
    const top = 160 + realm.document.querySelectorAll(".agent-row").length * 30;
    row.getBoundingClientRect = () => measuredRect(20, top, 328, 30);
    realm.document.getElementById("agent-rows")!.append(row);
    runtime.render();
    return row;
  };
  const media = (name: string, matches: boolean) => {
    const entry = queries.get(name)!;
    Object.defineProperty(entry.query, "matches", { configurable: true, value: matches });
    for (const callback of entry.callbacks) callback(new realm.Event("change"));
  };
  cleanups.push(() => {
    runtime.destroy();
    iframe.remove();
  });
  return { runtime, realm, advance, addRow, pending, clipboard, media, perfRequests, dashboard };
}
function cardState(
  data: OmpMonitorSnapshot,
  patch: Partial<OmpMonitorPerfCardState> = {},
): OmpMonitorPerfCardState {
  const board = { ...DEFAULT_BOARD_PREFERENCES, id: "board-1", orbId: "orb-1", visible: true };
  return {
    sequence: 1,
    request: {
      agentId: data.agents[0]?.id ?? "agent-a",
      anchor: { x: 0, y: 0, width: 340, height: 340 },
      rowTop: 160,
      topCount: 0,
      subAgents: 0,
      facts: [],
    },
    view: {
      language: "en",
      surface: "board",
      nativeFrame: false,
      instanceId: board.id,
      orbVisible: true,
      nameplatePlacement: "below",
      nameplateMaxWidth: 200,
      maxFps: 60,
      activity: { responseSequence: 0, peakSequence: 0, lastResponseAt: null, lastPeakAt: null },
      preferences: {
        ...DEFAULT_MONITOR_PREFERENCES,
        appearance: "light",
        effects: "off",
        showPerformance: true,
      },
      effectiveRedline: DEFAULT_MONITOR_PREFERENCES.redline,
      effectiveTitleTheme: DEFAULT_MONITOR_PREFERENCES.titleTheme,
      orbName: "OMP",
      titleThemes: { version: 1, revision: 0, custom: [], draft: null, undo: null, error: false },
      launchAtLogin: { enabled: false, supported: false, error: false },
      effectsPreview: { active: false, sequence: 0, startedAt: null, endsAt: null },
      ompSource: {
        enabled: true,
        folder: "",
        usingDefaultFolder: true,
        status: "ready",
        sessions: 0,
        changing: false,
        canChangeFolder: false,
      },
      orbUndo: null,
      orbManagement: { canSplit: false, canMerge: false, reason: "single-omp-source" },
      scope: data.scope,
      scopes: data.scopes,
      snapshot: data,
      workerError: false,
      preferenceError: false,
      refreshing: false,
      windowCount: 1,
      maxWindows: 8,
      orbs: [],
      board,
      boards: [board],
    },
    maxCardHeight: 900,
    slideFrom: -2,
    ...patch,
  };
}
interface CardAnimation {
  target: HTMLElement;
  frames: Keyframe[];
  duration: number;
  cancelled: boolean;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
  cancel(): void;
}
function cardHarness(
  initial: OmpMonitorPerfCardState,
  options: {
    heights?: [number, number, number];
    fontsReady?: Promise<void>;
    resize?: (size: OmpMonitorPerfCardSize) => Promise<void>;
    reducedMotion?: boolean;
  } = {},
) {
  vi.useFakeTimers();
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const realm = iframe.contentWindow as Window & typeof globalThis;
  const parsed = new realm.DOMParser().parseFromString(MONITOR_PERF_CARD_HTML, "text/html");
  realm.document.head.innerHTML = parsed.head.innerHTML;
  realm.document.body.innerHTML = parsed.body.innerHTML;
  realm.document.body.dataset.appearance = "light";
  Object.defineProperty(realm.document, "hidden", { configurable: true, value: false });
  Object.defineProperty(realm, "innerHeight", { configurable: true, value: 100 });
  const fonts = Object.assign(new realm.EventTarget(), {
    ready: options.fontsReady ?? Promise.resolve(),
  });
  Object.defineProperty(realm.document, "fonts", { configurable: true, value: fonts });
  const canvasContext = vi.fn(() => {
    throw new Error("The native card must not create a canvas context");
  });
  Object.defineProperty(realm.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: canvasContext,
  });
  const queries = new Map<string, { query: MediaQueryList; callbacks: Set<EventListener> }>();
  realm.matchMedia = (name: string) => {
    let entry = queries.get(name);
    if (!entry) {
      const callbacks = new Set<EventListener>();
      const query = {
        matches: name === "(prefers-reduced-motion: reduce)" && !!options.reducedMotion,
        media: name,
        addEventListener(_event: string, callback: EventListener) {
          callbacks.add(callback);
        },
        removeEventListener(_event: string, callback: EventListener) {
          callbacks.delete(callback);
        },
      } as unknown as MediaQueryList;
      entry = { query, callbacks };
      queries.set(name, entry);
    }
    return entry.query;
  };
  const animations: CardAnimation[] = [];
  Object.defineProperty(realm.HTMLElement.prototype, "animate", {
    configurable: true,
    value(this: HTMLElement, frames: Keyframe[], settings: KeyframeAnimationOptions) {
      let timer = 0;
      const animation: CardAnimation = {
        target: this,
        frames,
        duration: Number(settings.duration),
        cancelled: false,
        onfinish: null,
        oncancel: null,
        cancel() {
          if (animation.cancelled) return;
          animation.cancelled = true;
          window.clearTimeout(timer);
          animation.oncancel?.();
        },
      };
      timer = window.setTimeout(() => animation.onfinish?.(), animation.duration);
      animations.push(animation);
      return animation;
    },
  });
  const frame = realm.document.getElementById("perf-card-frame")!;
  const measuredLevels: number[] = [],
    sizes: OmpMonitorPerfCardSize[] = [];
  frame.getBoundingClientRect = () => {
    const compact = Number(frame.dataset.compact || 0);
    measuredLevels.push(compact);
    return measuredRect(24, 20, 320, (options.heights ?? [740, 540, 490])[compact]);
  };
  let receive: ((state: OmpMonitorPerfCardState) => void) | undefined;
  const unsubscribe = vi.fn();
  Object.assign(realm, {
    ompMonitor: {
      readyPerfCard: async () => initial,
      onPerfCardState(callback: (state: OmpMonitorPerfCardState) => void) {
        receive = callback;
        return unsubscribe;
      },
      resizePerfCard(size: OmpMonitorPerfCardSize) {
        sizes.push(size);
        return options.resize ? options.resize(size) : Promise.resolve();
      },
    },
  });
  const clock = { value: 0 },
    pending = new Map<number, FrameRequestCallback>();
  let serial = 0;
  new Function(
    "document",
    "window",
    "getComputedStyle",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "performance",
    realm.document.querySelector("script")!.textContent!,
  )(
    realm.document,
    realm,
    realm.getComputedStyle.bind(realm),
    (callback: FrameRequestCallback) => {
      pending.set(++serial, callback);
      return serial;
    },
    (id: number) => pending.delete(id),
    { now: () => clock.value },
  );
  async function settled() {
    // Ready, font readiness, then the native measurement acknowledgement are separate boundaries.
    for (let index = 0; index < 6; index++) await Promise.resolve();
  }
  const advance = (ms: number) => {
    const target = clock.value + ms;
    while (clock.value < target) {
      const elapsed = Math.min(16, target - clock.value);
      clock.value += elapsed;
      vi.advanceTimersByTime(elapsed);
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback(clock.value);
    }
  };
  cleanups.push(() => {
    realm.dispatchEvent(new realm.Event("beforeunload"));
    iframe.remove();
  });
  return {
    realm,
    frame,
    sizes,
    measuredLevels,
    animations,
    advance,
    pending,
    settled,
    canvasContext,
    unsubscribe,
    content: () => frame.querySelector<HTMLElement>('[data-outgoing="false"]')!,
    async send(state: OmpMonitorPerfCardState) {
      receive!(state);
      await settled();
    },
    async media(name: string, matches: boolean) {
      const entry = queries.get(name)!;
      Object.defineProperty(entry.query, "matches", { configurable: true, value: matches });
      for (const callback of entry.callbacks) callback(new realm.Event("change"));
      await settled();
    },
  };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function pointer(
  realm: Window & typeof globalThis,
  type: string,
  target: Element,
  relatedTarget: EventTarget | null = null,
) {
  target.dispatchEvent(
    new realm.MouseEvent(type, { bubbles: true, clientX: 40, clientY: 50, relatedTarget }),
  );
}

describe("original performance presentation rules", () => {
  it.each([
    [null, false, "–"],
    [0, false, "0"],
    [1286, false, "1,286"],
    [12840, false, "12,840"],
    [12840, true, "12.8k"],
    [12850, true, "12.9k"],
    [9999, true, "9,999"],
    [99949, true, "99.9k"],
    [99950, true, "100k"],
    [99960, true, "100k"],
    [999499, true, "999k"],
    [999500, true, "1.00M"],
    [1284000, false, "1.28M"],
  ] as const)("formats %s (compact %s) as %s", (value, compact, shown) => {
    expect(performanceNumber(value, compact)).toBe(shown);
  });
  it("uses the shared logarithmic visual scale without capping the number", () => {
    expect([250, 500, 1000, 2000, 4000, 12840].map(performanceScale)).toEqual([
      0, 0.25, 0.5, 0.75, 1, 1,
    ]);
    expect(performanceNumber(12840)).toBe("12,840");
    expect(performanceMotionDuration(1000, 2000)).toBe(650);
    expect(performanceMotionDuration(2000, 1000)).toBe(650);
    expect(performanceMotionDuration(1000, 1009)).toBeNull();
  });
  it("holds a known zero three seconds and never changes unknown thinking to zero", () => {
    const initial = { hidden: true, zeroSince: null, enabled: true };
    expect(performanceThinkingVisibility(initial, null, true, 0)).toEqual(initial);
    const zero = performanceThinkingVisibility(initial, 0, true, 100);
    expect(zero.hidden).toBe(false);
    expect(performanceThinkingVisibility(zero, 0, true, 3099).hidden).toBe(false);
    const hidden = performanceThinkingVisibility(zero, 0, true, 3100);
    expect(hidden.hidden).toBe(true);
    expect(performanceThinkingVisibility(hidden, null, true, 8000)).toEqual(hidden);
    expect(performanceThinkingVisibility(hidden, 0.05, true, 8001).hidden).toBe(false);
  });
});

describe("native performance card document", () => {
  it("shows seven original components, measured values, sub-scores and omission reasons", async () => {
    const value = agent(),
      second = agent("agent-b"),
      third = agent("agent-c");
    const data = snapshot([], [value, second, third], {
      [value.id]: evaluation({ provisional: true, n: 6, vsUsualPercent: -12 }),
      [second.id]: evaluation(),
      [third.id]: evaluation(),
    });
    const state = cardState(data);
    state.request!.topCount = 3;
    const client = cardHarness(state);
    await client.settled();
    const card = client.content();
    expect(client.frame.hidden).toBe(false);
    expect(card.querySelectorAll("[data-perf-component]")).toHaveLength(7);
    expect(card.querySelector(".perf-c-big")?.textContent).toBe("1,286");
    expect(card.querySelector(".perf-c-big")?.classList.contains("perf-pm")).toBe(true);
    expect(card.querySelector(".perf-c-eyebrow")?.textContent).toBe("Highest of 3 agents");
    expect(card.querySelector(".perf-c-top .perf-chip")?.textContent).toBe("−12% vs usual");
    expect(card.querySelector(".perf-c-top .perf-chip")?.classList.contains("perf-chip-flat")).toBe(
      true,
    );
    expect(card.textContent).toContain("Not recorded");
    expect(card.textContent).toContain("OMP doesn't record this");
    expect(card.textContent).toContain("80 tok/s");
    expect(card.textContent).toContain("1,600");
    expect(card.textContent).toContain("99%");
    expect(card.textContent).toContain("Only 6 timed requests");
    expect(card.querySelector(".perf-scale")?.getAttribute("style")).toContain("--f");
    expect(card.getAttribute("aria-label")).toContain("Latency P50: Not recorded");
    expect(client.canvasContext).not.toHaveBeenCalled();
  });
  it("shows an absent mark and sample explanation instead of zero or fake components", async () => {
    const value = agent(),
      status = evaluation({
        form: "none",
        score: null,
        shown: null,
        provisional: false,
        n: 2,
        baseline: null,
        vsUsual: null,
        vsUsualPercent: null,
      });
    const client = cardHarness(cardState(snapshot([], [value], { [value.id]: status })));
    await client.settled();
    const card = client.content();
    expect(card.querySelector(".perf-c-big")?.textContent).toBe("–");
    expect((card.querySelector(".perf-comps") as HTMLElement).hidden).toBe(true);
    expect(card.textContent).toContain(
      "Only 2 timed requests in the last 30 minutes; a score needs at least 3.",
    );
    expect((card.querySelector(".perf-c-top .perf-chip") as HTMLElement).hidden).toBe(true);
  });
  it("omits missing samples, keeps three to nine provisional and settles at ten", async () => {
    const value = agent(),
      status = evaluation({
        n: 3,
        provisional: true,
        baseline: null,
        vsUsual: null,
        vsUsualPercent: null,
      });
    Object.assign(status.components.find((component) => component.id === "R")!, {
      present: false,
      reason: "fewSamples",
      samples: 2,
      measure: null,
      ratio: null,
      subScore: null,
    });
    const state = cardState(snapshot([], [value], { [value.id]: status })),
      client = cardHarness(state);
    await client.settled();
    expect(client.content().querySelector(".perf-c-top .perf-chip")?.textContent).toBe(
      "No usual yet",
    );
    expect(client.content().textContent).toContain(
      "Fewer than 3 values, so it is left out for now.",
    );
    expect(client.content().querySelector(".perf-c-big")?.classList.contains("perf-pm")).toBe(true);
    status.n = 10;
    status.provisional = false;
    await client.send({ ...state, sequence: 2 });
    expect(client.content().querySelector(".perf-c-big")?.classList.contains("perf-pm")).toBe(
      false,
    );
    expect((client.content().querySelector(".perf-c-hint") as HTMLElement).hidden).toBe(true);
  });
  it.each([
    [900, 0, 740, [0]],
    [600, 1, 540, [0, 1]],
    [500, 2, 490, [0, 1, 2]],
    [100, 2, 490, [0, 1, 2]],
  ] as const)(
    "compacts against screen limit %s only, without clipping or scrolling",
    async (limit, compact, height, levels) => {
      const value = agent(),
        client = cardHarness(
          cardState(snapshot([], [value], { [value.id]: evaluation() }), { maxCardHeight: limit }),
        );
      await client.settled();
      expect(client.frame.dataset.compact).toBe(String(compact));
      expect(client.measuredLevels).toEqual(levels);
      expect(client.sizes).toEqual([{ sequence: 1, height, compact }]);
      expect(client.realm.getComputedStyle(client.frame).width).toBe("320px");
      expect(client.frame.style.height).toBe("");
      expect(client.realm.getComputedStyle(client.frame).overflowY).not.toBe("auto");
      expect(client.content().getAttribute("aria-label")).toContain(
        "Tokens written per second while responding",
      );
      expect(client.content().getAttribute("aria-label")).toContain("1000 is the reference level");
      const meaning = client.content().querySelector<HTMLElement>(".perf-meaning")!;
      expect(client.realm.getComputedStyle(meaning).display === "none").toBe(compact >= 1);
      const footnote = client.content().querySelector<HTMLElement>(".perf-c-foot")!;
      expect(client.realm.getComputedStyle(footnote).display === "none").toBe(compact >= 2);
    },
  );
  it("renders hostile log-derived labels and facts only as text", async () => {
    const value = agent("safe", {
      project: '<img src=x onerror="window.bad=1">',
      model: "<script>bad()</script>",
    });
    const state = cardState(snapshot([], [value], { safe: evaluation({ model: value.model }) }));
    state.request!.facts = ['<img src=x onerror="window.bad=2">'];
    const client = cardHarness(state);
    await client.settled();
    expect(client.content().querySelector("img,script")).toBeNull();
    expect(client.content().textContent).toContain(value.project);
    expect(client.content().textContent).toContain(value.model);
    expect(client.content().textContent).toContain(state.request!.facts[0]);
    expect("bad" in client.realm).toBe(false);
  });
  it("crossfades distinct agents inside one card while same-agent updates preserve the window animation", async () => {
    const first = agent("first", { project: "First project" }),
      second = agent("second", { project: "Second project" });
    const data = snapshot([], [first, second], {
      first: evaluation(),
      second: evaluation({ shown: 1540, score: 1540 }),
    });
    const state = cardState(data),
      client = cardHarness(state);
    await client.settled();
    expect(client.animations.filter((animation) => animation.target === client.frame)).toHaveLength(
      1,
    );
    expect(client.animations[0]!.frames[0]).toMatchObject({
      opacity: 0,
      transform: "translateX(-2px)",
    });
    data.performance.current.first = evaluation({ shown: 1400, score: 1400 });
    await client.send({ ...state, sequence: 2 });
    expect(client.animations.filter((animation) => animation.target === client.frame)).toHaveLength(
      1,
    );
    expect(client.animations[0]!.cancelled).toBe(false);
    await client.send({
      ...state,
      sequence: 3,
      request: { ...state.request!, agentId: second.id },
    });
    expect(client.realm.document.querySelectorAll(".perf-card")).toHaveLength(1);
    expect(client.content().querySelector(".perf-c-head b")?.textContent).toBe("Second project");
    const outgoing = client.frame.querySelector<HTMLElement>('[data-outgoing="true"]')!;
    expect(outgoing.hidden).toBe(false);
    expect(outgoing.querySelector(".perf-c-head b")?.textContent).toBe("First project");
    expect(outgoing.getAttribute("aria-hidden")).toBe("true");
    expect(client.animations.filter((animation) => animation.duration === 120)).toHaveLength(2);
    client.advance(120);
    expect(outgoing.hidden).toBe(true);
    expect(client.animations.filter((animation) => animation.target === client.frame)).toHaveLength(
      1,
    );
  });
  it("keeps the outgoing agent when a switch refreshes before native sizing completes", async () => {
    const first = agent("first", { project: "First project" }),
      second = agent("second", { project: "Second project" });
    const state = cardState(
      snapshot([], [first, second], { first: evaluation(), second: evaluation() }),
    );
    let releaseSize!: () => void;
    const sizeReady = new Promise<void>((resolve) => {
      releaseSize = resolve;
    });
    const client = cardHarness(state, {
      resize: (size) => (size.sequence === 1 ? Promise.resolve() : sizeReady),
    });
    await client.settled();
    client.advance(150);
    const next = { ...state, sequence: 2, request: { ...state.request!, agentId: second.id } };
    await client.send(next);
    second.project = "Updated second project";
    await client.send({ ...next, sequence: 3 });
    expect(client.content().querySelector(".perf-c-head b")?.textContent).toBe(
      "Updated second project",
    );
    const outgoing = client.frame.querySelector<HTMLElement>('[data-outgoing="true"]')!;
    expect(outgoing.querySelector(".perf-c-head b")?.textContent).toBe("First project");
    releaseSize();
    await client.settled();
    expect(client.animations.filter((animation) => animation.target === client.frame)).toHaveLength(
      1,
    );
    expect(outgoing.hidden).toBe(false);
    client.advance(120);
    expect(outgoing.hidden).toBe(true);
  });
  it("discards stale ready, font and native-size continuations after switching or dismissing", async () => {
    const first = agent("first"),
      second = agent("second", { project: "Current project" });
    const state = cardState(
      snapshot([], [first, second], { first: evaluation(), second: evaluation() }),
    );
    let resolveFonts!: () => void, resolveSize!: () => void;
    const fontsReady = new Promise<void>((resolve) => {
      resolveFonts = resolve;
    });
    const sizeReady = new Promise<void>((resolve) => {
      resolveSize = resolve;
    });
    const client = cardHarness(state, { fontsReady, resize: () => sizeReady });
    await client.send({
      ...state,
      sequence: 2,
      request: { ...state.request!, agentId: second.id },
    });
    resolveFonts();
    await client.settled();
    expect(client.sizes.map((size) => size.sequence)).toEqual([2]);
    expect(client.content().querySelector(".perf-c-head b")?.textContent).toBe("Current project");
    await client.send({ ...state, sequence: 3, request: null });
    resolveSize();
    await client.settled();
    client.advance(100);
    expect(client.frame.hidden).toBe(true);
    expect(client.animations.some((animation) => animation.duration === 150)).toBe(false);
    await client.send(state);
    expect(client.frame.hidden).toBe(true);
  });
  it.each([false, true])(
    "dismisses with the original timing under reduced motion=%s",
    async (reducedMotion) => {
      const value = agent(),
        state = cardState(snapshot([], [value], { [value.id]: evaluation() }));
      const client = cardHarness(state, { reducedMotion });
      await client.settled();
      expect(client.animations[0]!.duration).toBe(150);
      expect(client.animations[0]!.frames[0]!.transform).toBe(
        reducedMotion ? "none" : "translateX(-2px)",
      );
      await client.send({ ...state, sequence: 2, request: null });
      if (!reducedMotion) {
        client.advance(99);
        expect(client.frame.hidden).toBe(false);
        client.advance(1);
      }
      expect(client.frame.hidden).toBe(true);
    },
  );
  it.each(["off", "standard"] as const)(
    "counts rises and falls independently of Orb effects=%s",
    async (effects) => {
      const value = agent(),
        data = snapshot([], [value], { [value.id]: evaluation({ shown: 1000, score: 1000 }) });
      const state = cardState(data);
      state.view.preferences.effects = effects;
      const client = cardHarness(state);
      await client.settled();
      data.performance.current[value.id] = evaluation({ shown: 2000, score: 2000 });
      await client.send({ ...state, sequence: 2 });
      client.advance(300);
      const rising = Number(
        client.content().querySelector(".perf-c-big")!.textContent!.replace(/,/g, ""),
      );
      expect(rising).toBeGreaterThan(1000);
      expect(rising).toBeLessThan(2000);
      client.advance(400);
      expect(client.content().querySelector(".perf-c-big")?.textContent).toBe("2,000");
      data.performance.current[value.id] = evaluation({ shown: 1000, score: 1000 });
      await client.send({ ...state, sequence: 3 });
      client.advance(300);
      const falling = Number(
        client.content().querySelector(".perf-c-big")!.textContent!.replace(/,/g, ""),
      );
      expect(falling).toBeGreaterThan(1000);
      expect(falling).toBeLessThan(2000);
      await client.media("(prefers-reduced-motion: reduce)", true);
      expect(client.content().querySelector(".perf-c-big")?.textContent).toBe("1,000");
      expect(client.pending.size).toBe(0);
    },
  );
});

describe("performance row hover and native speed capsules", () => {
  it("targets the whole board row, preserves Enter expansion and opens with Space", () => {
    const value = agent(),
      data = snapshot([], [value], { [value.id]: evaluation() });
    const { runtime, realm, advance, perfRequests } = harness(data);
    runtime.view.surface = "board";
    const panel = realm.document.createElement("section"),
      row = realm.document.createElement("div");
    panel.className = "board-panel";
    panel.getBoundingClientRect = () => measuredRect(0, 0, 340, 340);
    row.className = "row";
    row.tabIndex = 0;
    row.dataset.perfAgentId = value.id;
    row.dataset.perfCardHost = "board";
    row.getBoundingClientRect = () => measuredRect(18, 170, 304, 46);
    row.setAttribute("aria-expanded", "false");
    const cell = runtime.createPerfScoreCell(value, "board");
    row.append(cell);
    panel.append(row);
    realm.document.body.append(panel);
    pointer(realm, "pointerover", cell);
    advance(349);
    expect(row.dataset.perfOpen).toBeUndefined();
    advance(1);
    expect(row.dataset.perfOpen).toBe("true");
    expect(cell.dataset.perfOpen).toBeUndefined();
    expect(perfRequests.at(-1)).toMatchObject({
      anchor: { x: 0, y: 0, width: 340, height: 340 },
      rowTop: 170,
    });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    row.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    let expanded = 0;
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") expanded++;
    });
    row.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(expanded).toBe(1);
    expect(row.dataset.perfOpen).toBeUndefined();
    row.focus();
    row.dispatchEvent(new realm.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(row.dataset.perfOpen).toBe("true");
  });
  it("keeps selected and recorded Fast/Ultrafast modes independent of performance visibility", () => {
    const selected = agent("selected", {
      speedMode: { value: "fast", evidence: "selected", provider: "openai" },
    });
    const recorded = agent("recorded", {
      speedMode: { value: "ultrafast", evidence: "recorded", provider: "openai" },
    });
    const { runtime, addRow } = harness(snapshot([], [selected, recorded]));
    runtime.view.preferences.showPerformance = false;
    const fast = addRow(selected),
      ultra = addRow(recorded);
    expect((fast.querySelector(".perf-mode-cell") as HTMLElement).hidden).toBe(false);
    expect(fast.querySelectorAll(".perf-bolt svg")).toHaveLength(1);
    expect(ultra.querySelectorAll(".perf-bolt svg")).toHaveLength(2);
    expect(fast.querySelector(".perf-mode-cell")?.getAttribute("title")).toContain(
      "Selected mode; not proof of server execution.",
    );
    expect(ultra.querySelector(".perf-mode-cell")?.getAttribute("title")).toContain(
      "Execution mode recorded in the log.",
    );
    expect((fast.querySelector(".perf-score-cell") as HTMLElement).hidden).toBe(true);
  });
  it.each([
    ["off", 0, false],
    ["minimal", 1, false],
    ["low", 1, false],
    ["medium", 2, false],
    ["high", 3, false],
    ["xhigh", 4, false],
    ["max", 5, false],
    ["ultra", 5, true],
    ["ultracode", 5, true],
    ["provider-specific", -1, false],
  ])("draws native effort %s at level %s without guessing", (word, level, topRung) => {
    const value = agent("effort", {
      effortMode: { value: word as string, evidence: "recorded", provider: null },
    });
    const { runtime } = harness(snapshot([], [value]));
    expect(runtime.modeFacts(value)).toMatchObject({ word, level, topRung, present: true });
    const cell = runtime.createModeCell(value);
    expect(cell.hidden).toBe(false);
    expect(cell.querySelectorAll('.perf-effort-meter i[data-lit="true"]')).toHaveLength(
      Math.max(0, level as number),
    );
    expect(cell.querySelector(".perf-effort-word")?.textContent).toBe(word);
    expect(cell.title).toContain("Execution mode recorded in the log.");
    if (topRung)
      expect(cell.title).toContain(
        word === "ultra" ? "automatic task delegation" : "multi-agent workflows",
      );
  });
  it("keeps unknown and Standard absent, but retains unsupported known effort words and Highspeed bolts", () => {
    const { runtime } = harness(snapshot());
    expect(runtime.modeFacts({ effortMode: null, speedMode: null })).toMatchObject({
      word: "",
      level: -1,
      bolts: 0,
      present: false,
    });
    expect(
      runtime.modeFacts({ effortMode: { value: "unknown" }, speedMode: { value: "standard" } }),
    ).toMatchObject({ word: "", level: -1, bolts: 0, present: false });
    const fact = runtime.modeFacts({
      effortMode: { value: "auto", evidence: "selected", provider: null },
      speedMode: { value: "highspeed", evidence: "recorded", provider: "provider" },
    });
    expect(fact).toMatchObject({
      word: "auto",
      level: -1,
      bolts: 1,
      present: true,
      effortConfigured: false,
    });
    expect(fact.description).toContain("Reasoning effort: auto");
    expect(fact.description).toContain("Speed: Highspeed · provider");
    expect(fact.description).toContain("Selected mode; not proof of server execution.");
  });
  it("renders the configured form only for explicit configuration evidence and quiets mixed parts separately", () => {
    const { runtime } = harness(snapshot());
    const configured = {
      id: "config",
      effortMode: { value: "ultra", evidence: "configured", provider: null },
      speedMode: { value: "fast", evidence: "configured", provider: null },
    } as unknown as OmpMonitorAgent;
    const facts = runtime.modeFacts(configured),
      cell = runtime.createModeCell(configured);
    expect(facts).toMatchObject({
      level: 5,
      topRung: false,
      effortConfigured: true,
      speedConfigured: true,
    });
    expect(facts.description).toContain("From a config file; the agent may not be using it.");
    expect(cell.querySelector(".perf-capsule")?.getAttribute("data-configured")).toBe("true");
    expect(cell.querySelector(".perf-mode-mark")?.textContent).toBe("config");
    const mixed = runtime.createModeCell({
      ...configured,
      speedMode: { value: "fast", evidence: "recorded", provider: null },
    });
    expect(mixed.querySelector(".perf-capsule")?.getAttribute("data-configured")).toBe("false");
    expect(mixed.querySelector(".perf-effort-word")?.getAttribute("data-configured")).toBe("true");
    expect((mixed.querySelector(".perf-mode-mark") as HTMLElement).hidden).toBe(true);
    const selected = runtime.createModeCell(
      agent("selected", { effortMode: { value: "ultra", evidence: "selected", provider: null } }),
    );
    expect(selected.querySelector(".perf-capsule")?.getAttribute("data-configured")).toBe("false");
    expect(selected.querySelector(".perf-capsule")?.getAttribute("data-top-rung")).toBe("true");
  });
  it("keeps the full accessible row description without rendering an in-parent tooltip or scrolling keys", () => {
    const value = agent(),
      { realm, addRow } = harness(snapshot([], [value], { [value.id]: evaluation() }));
    const row = addRow(value),
      description = realm.document.getElementById(row.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain("Tokens written per second while responding");
    expect(description.textContent).toContain("Latency P50: Not recorded");
    expect(description.textContent).toContain("1000 is the reference level");
    expect(realm.document.getElementById("perf-score-card")).toBeNull();
    row.focus();
    row.dispatchEvent(new realm.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    const pageDown = new realm.KeyboardEvent("keydown", {
      key: "PageDown",
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(pageDown);
    expect(pageDown.defaultPrevented).toBe(false);
    expect(realm.document.activeElement).toBe(row);
  });
  it("waits on first hover, switches immediately, suppresses Escape until re-entry and follows keyboard focus", () => {
    const firstAgent = agent(),
      secondAgent = agent("agent-b");
    const { runtime, realm, addRow, advance, perfRequests } = harness(
      snapshot([], [firstAgent, secondAgent], {
        [firstAgent.id]: evaluation(),
        [secondAgent.id]: evaluation({ shown: 1540, score: 1540, form: "resting" }),
      }),
    );
    const first = addRow(firstAgent),
      second = addRow(secondAgent);
    pointer(realm, "pointerover", first.firstElementChild!);
    advance(449);
    expect(first.dataset.perfOpen).toBeUndefined();
    expect(perfRequests).toHaveLength(0);
    advance(1);
    expect(first.dataset.perfOpen).toBe("true");
    first.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(first.dataset.perfOpen).toBeUndefined();
    expect(perfRequests.at(-1)).toBeNull();
    pointer(realm, "pointerover", first.lastElementChild!, first.firstElementChild);
    advance(1000);
    runtime.render();
    expect(first.dataset.perfOpen).toBeUndefined();
    pointer(realm, "pointerout", first, realm.document.body);
    pointer(realm, "pointerover", first, realm.document.body);
    advance(450);
    expect(first.dataset.perfOpen).toBe("true");
    pointer(realm, "pointerout", first, second);
    pointer(realm, "pointerover", second, first);
    expect(first.dataset.perfOpen).toBeUndefined();
    expect(second.dataset.perfOpen).toBe("true");
    expect(perfRequests.at(-1)?.agentId).toBe(secondAgent.id);
    second.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    first.focus();
    first.dispatchEvent(new realm.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(first.dataset.perfOpen).toBe("true");
    second.focus();
    expect(second.dataset.perfOpen).toBe("true");
    expect(realm.document.activeElement).toBe(second);
    pointer(realm, "pointerout", second, realm.document.body);
    advance(150);
    expect(second.dataset.perfOpen).toBe("true");
    realm.document.body.tabIndex = -1;
    realm.document.body.focus();
    expect(second.dataset.perfOpen).toBeUndefined();
  });
  it("sends the dashboard frame separately from the scrolled row top and dismisses on leave", () => {
    const value = agent(),
      { realm, addRow, advance, perfRequests, dashboard } = harness(
        snapshot([], [value], { [value.id]: evaluation() }),
      );
    const row = addRow(value);
    let top = 200;
    row.getBoundingClientRect = () => measuredRect(20, top, 328, 30);
    pointer(realm, "pointerover", row);
    advance(450);
    expect(perfRequests.at(-1)).toMatchObject({
      agentId: value.id,
      anchor: { x: 0, y: 0, width: 368, height: 730 },
      rowTop: 200,
      topCount: 0,
      subAgents: 0,
      facts: [],
    });
    top = 120;
    dashboard.dispatchEvent(new realm.Event("scroll", { bubbles: true }));
    expect(perfRequests.at(-1)?.rowTop).toBe(120);
    expect(perfRequests.at(-1)?.anchor.width).toBe(368);
    top = -10;
    dashboard.dispatchEvent(new realm.Event("scroll", { bubbles: true }));
    expect(perfRequests.at(-1)?.rowTop).toBe(-10);
    pointer(realm, "pointerout", row, realm.document.body);
    advance(149);
    expect(row.dataset.perfOpen).toBe("true");
    advance(1);
    expect(row.dataset.perfOpen).toBeUndefined();
    expect(perfRequests.at(-1)).toBeNull();
  });
  it("cancels delayed hover on blur and dismisses open cards when scores are disabled", () => {
    const value = agent(),
      { runtime, realm, addRow, advance, perfRequests } = harness(
        snapshot([], [value], { [value.id]: evaluation() }),
      );
    const row = addRow(value);
    pointer(realm, "pointerover", row);
    advance(200);
    realm.dispatchEvent(new realm.Event("blur"));
    advance(1000);
    expect(row.dataset.perfOpen).toBeUndefined();
    expect(perfRequests).toHaveLength(0);
    pointer(realm, "pointerout", row, realm.document.body);
    pointer(realm, "pointerover", row, realm.document.body);
    advance(450);
    expect(row.dataset.perfOpen).toBe("true");
    runtime.view.preferences.showPerformance = false;
    runtime.render();
    expect(row.dataset.perfOpen).toBeUndefined();
    expect(perfRequests.at(-1)).toBeNull();
  });
});

describe("pooled performance history", () => {
  it("shows real pooled model rows, all seven values and the globally supplied usual baseline", () => {
    const data = snapshot([record("2026-10-29"), record("2026-10-29", "model-b", 3)]);
    data.performance.baselines = [{ source: "omp", model: "model-a", score: 1180 }];
    const { realm } = harness(data),
      rows = realm.document.querySelectorAll(".perf-table tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelectorAll(".perf-col-comp")).toHaveLength(7);
    expect(rows[0]!.children[2]!.textContent).toBe("1,180");
    expect(rows[0]!.children[3]!.textContent).toBe("20");
    expect(rows[0]!.querySelectorAll(".perf-parts i")).toHaveLength(7);
    expect(rows[1]!.querySelector(".perf-chip-sm")?.textContent).toBe("Few samples");
    expect(rows[1]!.children[1]!.textContent).toBe("–");
    expect(
      realm.document.getElementById("perf-history-chart")?.getAttribute("aria-label"),
    ).toContain("Daily performance of model-a · OMP");
    expect(realm.document.querySelector(".perf-legend")?.textContent).toContain("Usual 1,180");
  });
  it("draws gaps below twenty samples and exposes dates and counts through chart keyboard controls", () => {
    const data = snapshot([
      record("2026-10-28"),
      record("2026-10-29", "model-a", 3),
      record("2026-10-30"),
    ]);
    const { runtime, realm } = harness(data);
    runtime.setRange("2026-10-28", "2026-10-30");
    const chart = realm.document.getElementById("perf-history-chart")!;
    expect(chart.querySelectorAll("circle")).toHaveLength(2);
    chart.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(realm.document.getElementById("perf-point-tip")?.textContent).toContain("2026-10-28");
    chart.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(realm.document.getElementById("perf-point-tip")?.textContent).toContain(
      "Only 3 timed requests; a score needs at least 20.",
    );
    chart.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(realm.document.getElementById("perf-point-tip")?.textContent).toContain("2026-10-30");
  });
  it("uses fourteen days for a single selected date and does not create rows from baseline-only models", () => {
    const data = snapshot([record("2026-10-29")]);
    data.performance.baselines = [{ source: "omp", model: "gone", score: 9999 }];
    const { realm } = harness(data),
      chart = realm.document.getElementById("perf-history-chart")!;
    expect(realm.document.querySelector(".perf-tt")?.textContent).toContain(
      "14 days to 2026-10-29",
    );
    expect(realm.document.querySelectorAll(".perf-table tbody tr")).toHaveLength(1);
    chart.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(realm.document.getElementById("perf-point-tip")?.textContent).toContain("2026-10-16");
  });
  it("keeps native header sorting and model selection across updates, with tab-separated copy-row values", async () => {
    const data = snapshot([record("2026-10-29"), record("2026-10-29", "model-b", 30, 100)]),
      { runtime, realm, clipboard } = harness(data);
    const second = Array.from(
      realm.document.querySelectorAll<HTMLElement>(".perf-table tbody tr"),
    ).find((row) => row.textContent!.includes("model-b"))!;
    second.click();
    runtime.render();
    expect(realm.document.querySelector(".perf-table tr.perf-selected")?.textContent).toContain(
      "model-b",
    );
    const modelSort = realm.document.querySelector<HTMLButtonElement>('[data-perf-sort="model"]')!;
    modelSort.click();
    expect(
      realm.document.querySelector('[aria-sort="ascending"] [data-perf-sort="model"]'),
    ).not.toBeNull();
    const selected = realm.document.querySelector<HTMLElement>(".perf-table tr.perf-selected")!;
    selected.dispatchEvent(
      new realm.KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }),
    );
    await Promise.resolve();
    expect(clipboard).toHaveBeenCalledOnce();
    expect(clipboard.mock.calls[0]![0]).toMatch(/^model-b\tOMP\t[\d,]+\t–\t30\t/);
    expect(clipboard.mock.calls[0]![0]).not.toContain("Throughput:");
    runtime.setLanguage("zh");
    expect(realm.document.getElementById("perf-model-sort")).toBeNull();
    expect(realm.document.getElementById("perf-performance-title")?.textContent).toBe("性能表现");
  });
  it("centers the keyboard copy menu on the native owning table, cycles focus, and restores the invoker", () => {
    const { realm } = harness(snapshot([record("2026-10-29")]));
    const table = realm.document.querySelector<HTMLElement>(".perf-table")!;
    const row = table.querySelector<HTMLElement>("tbody .perf-selected")!;
    const menu = realm.document.getElementById("perf-copy-menu")!;
    const copy = realm.document.getElementById("perf-copy-row")!;
    Object.defineProperty(table, "getBoundingClientRect", {
      value: () => ({ left: 60, right: 760, top: 400, bottom: 500, width: 700, height: 100 }),
    });
    Object.defineProperties(menu, { offsetWidth: { value: 160 }, offsetHeight: { value: 42 } });
    row.focus();
    const open = new realm.KeyboardEvent("keydown", {
      key: "F10",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(open);
    expect(open.defaultPrevented).toBe(true);
    expect(menu.hidden).toBe(false);
    expect(menu.style.left).toBe("330px");
    expect(menu.style.top).toBe("429px");
    expect(realm.document.activeElement).toBe(menu);
    menu.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(realm.document.activeElement).toBe(copy);
    copy.dispatchEvent(
      new realm.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(realm.document.activeElement).toBe(copy);
    copy.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(realm.document.activeElement).toBe(row);

    const header = table.querySelector<HTMLButtonElement>("[data-perf-sort=model]")!;
    header.focus();
    header.dispatchEvent(
      new realm.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
    );
    expect(menu.hidden).toBe(false);
    menu.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(realm.document.activeElement).toBe(header);
  });

  it("opens the narrow-list Apps menu on key-up and anchors zero-coordinate accessibility invocation to its owner", () => {
    const { realm } = harness(snapshot([record("2026-10-29")]));
    const list = realm.document.querySelector<HTMLElement>(".perf-list")!;
    const row = list.querySelector<HTMLElement>(".perf-selected")!;
    const menu = realm.document.getElementById("perf-copy-menu")!;
    Object.defineProperty(list, "getBoundingClientRect", {
      value: () => ({ left: 120, right: 440, top: 350, bottom: 500, width: 320, height: 150 }),
    });
    Object.defineProperties(menu, { offsetWidth: { value: 160 }, offsetHeight: { value: 42 } });
    row.focus();
    const down = new realm.KeyboardEvent("keydown", {
      key: "ContextMenu",
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(menu.hidden).toBe(true);
    row.dispatchEvent(
      new realm.KeyboardEvent("keyup", { key: "ContextMenu", bubbles: true, cancelable: true }),
    );
    expect(menu.hidden).toBe(false);
    expect(menu.style.left).toBe("200px");
    expect(menu.style.top).toBe("404px");
    expect(realm.document.activeElement).toBe(menu);
    menu.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(realm.document.activeElement).toBe(row);
    row.dispatchEvent(
      new realm.MouseEvent("contextmenu", {
        button: 0,
        clientX: 0,
        clientY: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(menu.style.left).toBe("200px");
    expect(menu.style.top).toBe("404px");
  });

  it("selects a right-clicked row, clamps the pointer menu, and copies the current selected real row rather than a stale snapshot", async () => {
    const { runtime, realm, clipboard } = harness(
      snapshot([record("2026-10-29"), record("2026-10-29", "model-b", 30, 100)]),
    );
    const target = Array.from(
      realm.document.querySelectorAll<HTMLElement>(".perf-table tbody tr"),
    ).find((row) => row.textContent!.includes("model-a"))!;
    const menu = realm.document.getElementById("perf-copy-menu")!;
    const copy = realm.document.getElementById("perf-copy-row")!;
    Object.defineProperties(menu, { offsetWidth: { value: 160 }, offsetHeight: { value: 42 } });
    const open = new realm.MouseEvent("contextmenu", {
      button: 2,
      clientX: realm.innerWidth - 1,
      clientY: realm.innerHeight - 1,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(open);
    expect(open.defaultPrevented).toBe(true);
    expect(realm.document.querySelector(".perf-table .perf-selected")?.textContent).toContain(
      "model-a",
    );
    expect(menu.style.left).toBe(realm.innerWidth - 168 + "px");
    expect(menu.style.top).toBe(realm.innerHeight - 50 + "px");
    expect(menu.querySelector("kbd")?.textContent).toBe("Ctrl+C");
    runtime.render(snapshot([record("2026-10-29", "model-b", 31, 100)]));
    menu.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    copy.dispatchEvent(
      new realm.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(menu.hidden).toBe(true);
    expect(realm.document.activeElement).toBe(
      realm.document.querySelector(".perf-table .perf-selected"),
    );
    await Promise.resolve();
    expect(clipboard).toHaveBeenCalledOnce();
    expect(clipboard.mock.calls[0]![0]).toMatch(/^model-b\tOMP\t[\d,]+\t–\t31\t/);
  });

  it("dismisses the menu on focus leaving it without stealing the new focus", () => {
    const { realm } = harness(snapshot([record("2026-10-29")]));
    const row = realm.document.querySelector<HTMLElement>(".perf-table tbody .perf-selected")!;
    const menu = realm.document.getElementById("perf-copy-menu")!;
    const other = realm.document.createElement("button");
    realm.document.body.append(other);
    row.focus();
    row.dispatchEvent(
      new realm.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
    );
    expect(menu.hidden).toBe(false);
    other.focus();
    expect(menu.hidden).toBe(true);
    expect(realm.document.activeElement).toBe(other);
  });
  it("retains discoverable empty and static analyzing states and live metric definitions", () => {
    const data = snapshot(),
      { runtime, realm } = harness(data);
    expect(realm.document.querySelector(".perf-history-state b")?.textContent).toBe(
      "No timed requests in this period",
    );
    data.performance.scanning = true;
    runtime.render();
    expect(realm.document.querySelector(".perf-skeleton")).not.toBeNull();
    expect(realm.document.getElementById("perf-performance")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    realm.document.getElementById("perf-performance-info")!.click();
    expect(realm.document.querySelectorAll("#perf-info-definitions dt")).toHaveLength(7);
    expect(realm.document.activeElement?.id).toBe("perf-info-close");
    realm.document.activeElement!.dispatchEvent(
      new realm.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(realm.document.getElementById("perf-history-info")?.hidden).toBe(true);
  });
});

describe("performance orb readout lifecycle", () => {
  it.each(["led", "needle", "reactor", "minimal"])(
    "keeps %s supplementary text visible on the same centered SVG baseline as its frame",
    (style) => {
      const value = agent(),
        data = snapshot([], [value], { [value.id]: evaluation({ provisional: true, n: 5 }) });
      const { runtime, realm, advance } = harness(data, true);
      runtime.view.preferences.style = style;
      runtime.render();
      expect(runtime.frame("orb-art").visible).toBe(false);
      advance(350);
      const root = realm.document.querySelector<SVGSVGElement>("#orb-art .perf-orb-lines")!;
      expect(root.namespaceURI).toBe("http://www.w3.org/2000/svg");
      expect(root.getAttribute("viewBox")).toBe("0 0 148 148");
      expect(root.getAttribute("width")).toBe("148");
      expect(root.style.visibility).toBe("visible");
      const frame = runtime.frame("orb-art"),
        number = frame.glyphs.find((glyph) => glyph.text === "1,286")!;
      expect(frame.visible).toBe(true);
      const rendered = root.querySelector(".perf-ln-score .perf-n")!;
      expect(Number(rendered.getAttribute("x"))).toBeCloseTo(74 + number.x);
      expect(Number(rendered.getAttribute("y"))).toBeCloseTo(74 + number.y);
      expect(Number(root.querySelector(".perf-score-dots circle")!.getAttribute("cy"))).toBeCloseTo(
        0.22 * number.size,
      );
      if (style === "needle" || style === "reactor") expect(frame.stackOffset).toBe(0);
      else expect(frame.stackOffset).toBeGreaterThan(0);
      if (style === "needle") expect(number.size).toBeCloseTo(1.1 * 7);
    },
  );
  it("renders only enabled supplementary lines through independent switches and surface changes", () => {
    const value = agent(),
      { runtime, realm, advance } = harness(
        snapshot([], [value], { [value.id]: evaluation() }),
        true,
      );
    const root = realm.document.querySelector<SVGSVGElement>("#orb-art .perf-orb-lines")!;
    const score = root.querySelector<SVGGElement>(".perf-ln-score")!;
    const thinking = root.querySelector<SVGGElement>(".perf-ln-thinking")!;
    const displayed = (element: Element) => realm.getComputedStyle(element).display !== "none";
    advance(350);
    expect(displayed(score)).toBe(true);
    expect(displayed(thinking)).toBe(true);

    runtime.view.preferences.showPerformance = false;
    runtime.render();
    advance(350);
    expect(displayed(score)).toBe(false);
    expect(displayed(thinking)).toBe(true);

    runtime.view.preferences.showPerformance = true;
    runtime.view.preferences.showThinking = false;
    runtime.render();
    advance(350);
    expect(displayed(score)).toBe(true);
    expect(displayed(thinking)).toBe(false);

    runtime.view.preferences.showPerformance = false;
    runtime.render();
    advance(650);
    expect(displayed(root)).toBe(false);
    runtime.view.preferences.showPerformance = true;
    runtime.view.preferences.showThinking = true;
    runtime.render();
    advance(350);
    expect(displayed(root)).toBe(true);
    expect(displayed(score)).toBe(true);
    expect(displayed(thinking)).toBe(true);
    runtime.view.surface = "settings";
    runtime.render();
    expect(displayed(root)).toBe(false);
  });
  it("removes the thinking unit from the needle hub and restores it on another style", () => {
    const value = agent(),
      { runtime, realm, advance } = harness(
        snapshot([], [value], { [value.id]: evaluation() }),
        true,
      );
    const unit = realm.document.querySelector<SVGTextElement>(
      "#orb-art .perf-ln-thinking .perf-unit",
    )!;
    runtime.view.preferences.style = "needle";
    runtime.render();
    advance(350);
    expect(realm.getComputedStyle(unit).display).toBe("none");
    runtime.view.preferences.style = "led";
    runtime.render();
    advance(350);
    expect(realm.getComputedStyle(unit).display).not.toBe("none");
  });
  it("keeps unfitted readouts out of the glyph frame and restores them through the real entrance", () => {
    const value = agent(),
      { runtime, advance, pending } = harness(
        snapshot([], [value], { [value.id]: evaluation() }),
        true,
      );
    runtime.view.preferences.size = 48;
    runtime.render();
    advance(350);
    const unfitted = runtime.frame("orb-art");
    expect(unfitted.visible).toBe(false);
    expect(unfitted.glyphs).toHaveLength(0);
    expect(unfitted.stackOffset).toBe(0);
    expect(pending.size).toBe(0);
    runtime.view.preferences.size = 148;
    runtime.render();
    expect(runtime.frame("orb-art").visible).toBe(false);
    advance(350);
    expect(runtime.frame("orb-art").visible).toBe(true);
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "1,286")).toBe(true);
  });
  it("leaves liquid text shader-clipped normally and uses visible SVG text for contrast, without a phantom shift", () => {
    const value = agent(),
      data = snapshot([], [value], { [value.id]: evaluation() });
    const { runtime, realm, media, advance } = harness(data, true);
    runtime.view.preferences.style = "liquid";
    runtime.render();
    advance(350);
    const root = realm.document.querySelector<SVGSVGElement>("#orb-art .perf-orb-lines")!;
    expect(root.style.visibility).toBe("hidden");
    expect(runtime.frame("orb-art").glyphs.length).toBeGreaterThan(0);
    media("(prefers-contrast: more)", true);
    expect(root.style.visibility).toBe("visible");
    runtime.view.preferences.showPerformance = false;
    runtime.view.preferences.showThinking = false;
    runtime.render();
    expect(runtime.frame("orb-art").visible).toBe(false);
    expect(runtime.frame("orb-art").stackOffset).toBe(0);
  });
  it("keeps an unknown score absent in text and accessibility without repeating its label", () => {
    const value = agent(),
      state = evaluation({ form: "none", shown: null, score: null, n: 2, provisional: false });
    const { runtime, advance } = harness(snapshot([], [value], { [value.id]: state }), true);
    advance(350);
    const frame = runtime.frame("orb-art");
    expect(frame.visible).toBe(true);
    expect(frame.glyphs.some((glyph) => glyph.text === "–")).toBe(true);
    expect(frame.description).toBe("performance: no score yet, thinking 20 tokens per second");
  });
  it("crossfades live to resting ink over two hundred milliseconds without an idle animation", () => {
    const value = agent(),
      data = snapshot([], [value], { [value.id]: evaluation() }),
      { runtime, advance, pending } = harness(data, true);
    advance(350);
    data.performance.current[value.id] = evaluation({ form: "resting" });
    runtime.render();
    advance(100);
    const midway = runtime.frame("orb-art").glyphs.filter((glyph) => glyph.text === "1,286");
    expect(midway).toHaveLength(2);
    expect(midway.every((glyph) => glyph.alpha > 0 && glyph.alpha < 1)).toBe(true);
    advance(150);
    const settled = runtime.frame("orb-art").glyphs.filter((glyph) => glyph.text === "1,286");
    expect(settled).toHaveLength(1);
    expect(settled[0]!.role).toBe(1);
    expect(pending.size).toBe(0);
  });
  it("uses the highest live supplying agent, uncapped compact text and its provisional mark", () => {
    const a = agent(),
      b = agent("idle", { phase: "idle" });
    const { runtime, advance } = harness(
      snapshot([], [a, b], {
        [a.id]: evaluation({ shown: 12840, score: 12840, provisional: true, n: 4 }),
        idle: evaluation({ shown: 99999, score: 99999, form: "resting" }),
      }),
      true,
    );
    advance(350);
    const frame = runtime.frame("orb-art");
    expect(frame.visible).toBe(true);
    expect(frame.glyphs.find((glyph) => glyph.provisional)?.text).toBe("12.8k");
    expect(frame.description).toContain("12,840, provisional");
    expect(frame.description).not.toContain("99,999");
  });
  it("hides known zero thinking after three seconds, holds unknown and cancels frames when hidden or destroyed", () => {
    const value = agent(),
      data = snapshot([], [value], { [value.id]: evaluation() }),
      { runtime, realm, advance, pending } = harness(data, true);
    advance(350);
    data.rate.measuredThinkingTps = null;
    runtime.render();
    advance(3500);
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "TH")).toBe(true);
    expect(runtime.frame("orb-art").description).toContain("thinking – tokens per second");
    data.rate.measuredThinkingTps = 0;
    runtime.render();
    const expandedScore = runtime.frame("orb-art").glyphs.find((glyph) => glyph.text === "1,286")!;
    advance(2999);
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "TH")).toBe(true);
    advance(1);
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "TH")).toBe(true);
    advance(125);
    const fading = runtime.frame("orb-art").glyphs.find((glyph) => glyph.text === "TH")!;
    expect(fading.alpha).toBeGreaterThan(0);
    expect(fading.alpha).toBeLessThan(1);
    advance(225);
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "TH")).toBe(false);
    const foldedScore = runtime.frame("orb-art").glyphs.find((glyph) => glyph.text === "1,286")!;
    expect(foldedScore.y).toBeGreaterThan(expandedScore.y);
    expect(runtime.frame("orb-art").description).not.toContain("thinking");
    expect(pending.size).toBe(0);
    data.rate.measuredThinkingTps = null;
    runtime.render();
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "TH")).toBe(false);
    runtime.view.preferences.effects = "standard";
    data.performance.current[value.id] = evaluation({ shown: 2000, score: 2000 });
    runtime.render();
    Object.defineProperty(realm.document, "hidden", { configurable: true, value: true });
    realm.document.dispatchEvent(new realm.Event("visibilitychange"));
    expect(runtime.frame("orb-art").visible).toBe(false);
    expect(pending.size).toBe(0);
    runtime.destroy();
    advance(20000);
    expect(pending.size).toBe(0);
    expect(realm.document.querySelector(".perf-orb-lines")).toBeNull();
  });
  it("uses high-contrast frames and falls back to real DOM readouts under forced colors", () => {
    const value = agent(),
      { runtime, realm, media, advance } = harness(
        snapshot([], [value], { [value.id]: evaluation({ provisional: true, n: 5 }) }),
        true,
      );
    advance(350);
    media("(prefers-contrast: more)", true);
    expect(runtime.frame("orb-art").contrast).toBe(true);
    media("(forced-colors: active)", true);
    const frame = runtime.frame("orb-art");
    expect(frame.visible).toBe(true);
    expect(frame.glyphs).toHaveLength(0);
    const root = realm.document.querySelector<HTMLElement>("#orb-art .perf-orb-lines")!;
    expect(root.style.visibility).toBe("visible");
    expect(root.textContent).toContain("1,286");
  });
  it("snaps the supplementary entrance and fold under Reduce Motion, not Orb effects Off", () => {
    const value = agent(),
      data = snapshot([], [value], { [value.id]: evaluation() }),
      { runtime, advance, media, pending } = harness(data, true);
    expect(runtime.view.preferences.effects).toBe("off");
    expect(runtime.frame("orb-art").visible).toBe(false);
    advance(125);
    const entering = runtime.frame("orb-art");
    expect(entering.visible).toBe(true);
    expect(entering.glyphs.find((glyph) => glyph.text === "1,286")!.alpha).toBeGreaterThan(0);
    expect(entering.glyphs.find((glyph) => glyph.text === "1,286")!.alpha).toBeLessThan(1);
    media("(prefers-reduced-motion: reduce)", true);
    const expanded = runtime.frame("orb-art");
    expect(expanded.glyphs.find((glyph) => glyph.text === "1,286")!.alpha).toBe(1);
    expect(pending.size).toBe(0);
    data.rate.measuredThinkingTps = 0;
    runtime.render();
    advance(2999);
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "TH")).toBe(true);
    advance(1);
    const folded = runtime.frame("orb-art");
    expect(folded.glyphs.some((glyph) => glyph.text === "TH")).toBe(false);
    expect(folded.glyphs.find((glyph) => glyph.text === "1,286")!.y).toBeGreaterThan(
      expanded.glyphs.find((glyph) => glyph.text === "1,286")!.y,
    );
    expect(pending.size).toBe(0);
  });
  it("keeps configuration local and sends only the accepted preference names", async () => {
    const { runtime, realm } = harness(snapshot());
    const input = realm.document.getElementById("show-performance") as HTMLInputElement;
    input.checked = false;
    input.dispatchEvent(new realm.Event("change", { bubbles: true }));
    await Promise.resolve();
    expect(runtime.calls).toEqual([{ showPerformance: false }]);
  });
});
