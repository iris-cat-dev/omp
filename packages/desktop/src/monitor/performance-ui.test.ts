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
import type { OmpMonitorAgent } from "./types";
import type {
  MonitorPerformanceComponent,
  MonitorPerformanceEvaluation,
  MonitorPerformanceRecord,
  OmpMonitorPerformance,
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
    liveMeasuredTps: 50,
    liveEstimatedTps: 0,
    thinkingTps: 20,
    liveCostUsdPerSecond: null,
    speedMode: null,
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
interface SurfaceSnapshot {
  updatedAt: number;
  agents: OmpMonitorAgent[];
  rate: {
    measuredTps: number;
    estimatedTps: number;
    measuredThinkingTps: number | null;
    estimatedThinkingTps: number | null;
  };
  performance: OmpMonitorPerformance;
}
function snapshot(
  records: MonitorPerformanceRecord[] = [],
  agents: OmpMonitorAgent[] = [],
  current: Record<string, MonitorPerformanceEvaluation> = {},
): SurfaceSnapshot {
  return {
    updatedAt: now,
    agents,
    rate: { measuredTps: 50, estimatedTps: 0, measuredThinkingTps: 20, estimatedThinkingTps: null },
    performance: { current, records, baselines: [], scanning: false, limited: false },
  };
}
interface ReadoutFrame {
  visible: boolean;
  stackOffset: number;
  needleLegend: boolean;
  contrast?: boolean;
  glyphs: Array<{ text: string; role: number; provisional: boolean; alpha: number }>;
  description?: string;
}
interface Runtime {
  render(next?: SurfaceSnapshot): void;
  createPerfScoreCell(value: OmpMonitorAgent, host?: string): HTMLElement;
  createModeCell(value: OmpMonitorAgent): HTMLElement;
  show(id: string, anchor: HTMLElement, options?: { topCount?: number; keyboard?: boolean }): void;
  hide(): void;
  destroy(): void;
  frame(id: string): ReadoutFrame;
  setRange(first: string, last: string): void;
  setLanguage(language: string): void;
  view: {
    snapshot: SurfaceSnapshot;
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
const cleanups: Array<() => void> = [];
function harness(seed: SurfaceSnapshot, orb = false) {
  vi.useFakeTimers();
  const iframe = document.createElement("iframe");
  document.body.append(iframe);
  const realm = iframe.contentWindow as Window & typeof globalThis;
  realm.document.body.dataset.appearance = "light";
  realm.document.body.innerHTML = `<div id="page-orb"><div id="perf-settings-slot"></div></div><main class="history-scroll"><div id="history-body"><div id="perf-history-slot"></div></div><div id="history-empty" hidden></div></main><div id="agent-rows"></div>${orb ? '<div id="orb-art"></div><div id="hero-art"></div><div id="orb-hit"></div>' : ""}${MONITOR_PERF_MARKUP}`;
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
    `let view={snapshot:seed,instanceId:'orb-1',surface:'${orb ? "orb" : "history"}',orbVisible:true,scope:{profile:null,project:null},activity:{peakSequence:0},board:{showPerformance:true},preferences:{showPerformance:true,showThinking:true,effects:'off',size:148,style:'led'}};
     let language='en',appearance='light',range={startDate:'2026-10-29',endDate:'2026-10-29'};const calls=[];
     const node=id=>document.getElementById(id),finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
     const number=(value,digits=0)=>new Intl.NumberFormat('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value);
     const timestamp=value=>String(value),snapshotFacts=()=>view.snapshot,liveFacts=()=>view.snapshot;
     const parseDate=value=>new Date(value+'T12:00:00'),localDate=date=>date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
     const shiftDate=(value,days)=>{const date=parseDate(value);date.setDate(date.getDate()+days);return localDate(date);};
     const dateLabel=value=>value,todayDate=()=>localDate(new Date(view.snapshot.updatedAt)),selectedDates=()=>range;
     const bridge={configure:async patch=>{calls.push(patch);Object.assign(view.preferences,patch);}},action=work=>Promise.resolve(work());
     ${MONITOR_SELECT_PICKER_SCRIPT}
     monitorSelectPicker.install();
     ${MONITOR_PERF_SCRIPT}
     bindPerfUI();
     return {view,calls,createPerfScoreCell,createModeCell,show:perfShowCard,hide:perfHideCard,destroy:destroyPerfUI,frame:perfOrbReadoutFrame,
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
  ) as Runtime;
  runtime.render();
  const advance = (ms: number) => {
    clock.value += ms;
    vi.advanceTimersByTime(ms);
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(clock.value);
  };
  const addRow = (value: OmpMonitorAgent) => {
    const row = realm.document.createElement("div");
    row.className = "agent-row";
    row.append(
      realm.document.createElement("div"),
      realm.document.createElement("span"),
      runtime.createModeCell(value),
      runtime.createPerfScoreCell(value),
      realm.document.createElement("span"),
    );
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
  return { runtime, realm, advance, addRow, pending, clipboard, media };
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

describe("performance analysis card and native speed capsules", () => {
  it("shows seven original components, measured values, sub-scores and omission reasons", () => {
    const value = agent(),
      data = snapshot([], [value], {
        [value.id]: evaluation({ provisional: true, n: 6, vsUsualPercent: -12 }),
      });
    const { runtime, realm, addRow } = harness(data),
      row = addRow(value);
    runtime.show(value.id, row, { topCount: 3 });
    const card = realm.document.getElementById("perf-score-card")!;
    expect(card.hidden).toBe(false);
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
    expect(row.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      realm.document.getElementById(row.getAttribute("aria-describedby")!)?.textContent,
    ).toContain("Latency P50: Not recorded");
  });
  it("shows an absent mark and the minimum sample explanation rather than zero or fake components", () => {
    const value = agent(),
      state = evaluation({
        form: "none",
        score: null,
        shown: null,
        provisional: false,
        n: 2,
        baseline: null,
        vsUsual: null,
        vsUsualPercent: null,
      });
    const { runtime, realm, addRow } = harness(snapshot([], [value], { [value.id]: state }));
    const row = addRow(value);
    runtime.show(value.id, row);
    const card = realm.document.getElementById("perf-score-card")!;
    expect(card.querySelector(".perf-c-big")?.textContent).toBe("–");
    expect((card.querySelector(".perf-comps") as HTMLElement).hidden).toBe(true);
    expect(card.textContent).toContain(
      "Only 2 timed requests in the last 30 minutes; a score needs at least 3.",
    );
    expect((card.querySelector(".perf-c-top .perf-chip") as HTMLElement).hidden).toBe(true);
  });
  it("leaves missing samples out, keeps three to nine provisional and settles at ten", () => {
    const value = agent(),
      state = evaluation({
        n: 3,
        provisional: true,
        baseline: null,
        vsUsual: null,
        vsUsualPercent: null,
      });
    Object.assign(state.components.find((component) => component.id === "R")!, {
      present: false,
      reason: "fewSamples",
      samples: 2,
      measure: null,
      ratio: null,
      subScore: null,
    });
    const data = snapshot([], [value], { [value.id]: state }),
      { runtime, realm, addRow } = harness(data),
      row = addRow(value);
    runtime.show(value.id, row);
    expect(realm.document.querySelector(".perf-c-top .perf-chip")?.textContent).toBe(
      "No usual yet",
    );
    expect(realm.document.getElementById("perf-score-card")?.textContent).toContain(
      "Fewer than 3 values, so it is left out for now.",
    );
    expect(realm.document.querySelector(".perf-c-big")?.classList.contains("perf-pm")).toBe(true);
    state.n = 10;
    state.provisional = false;
    runtime.render();
    expect(realm.document.querySelector(".perf-c-big")?.classList.contains("perf-pm")).toBe(false);
    expect((realm.document.querySelector(".perf-c-hint") as HTMLElement).hidden).toBe(true);
  });
  it("constructs board cells without counting and keeps Enter available for native group expansion", () => {
    const value = agent(),
      data = snapshot([], [value], { [value.id]: evaluation() }),
      { runtime, realm, advance } = harness(data);
    runtime.view.surface = "board";
    const row = realm.document.createElement("div");
    row.className = "row";
    row.tabIndex = 0;
    row.dataset.perfAgentId = value.id;
    row.dataset.perfCardHost = "board";
    row.setAttribute("aria-expanded", "false");
    const cell = runtime.createPerfScoreCell(value, "board");
    row.append(cell);
    realm.document.body.append(row);
    expect(cell.dataset.perfCardHost).toBe("board");
    pointer(realm, "pointerover", cell);
    advance(350);
    expect(row.dataset.perfOpen).toBe("true");
    expect(cell.dataset.perfOpen).toBeUndefined();
    expect(row.getAttribute("aria-expanded")).toBe("false");
    runtime.hide();
    let expanded = 0;
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") expanded++;
    });
    row.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(expanded).toBe(1);
    expect(realm.document.getElementById("perf-score-card")?.hidden).toBe(true);
    row.dispatchEvent(new realm.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(realm.document.getElementById("perf-score-card")?.hidden).toBe(false);
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
  it("escapes log-derived labels and retains the full accessible content when the card must compact", () => {
    const value = agent("safe", { project: '<img src=x onerror="window.bad=1">' });
    const { runtime, realm, addRow } = harness(snapshot([], [value], { safe: evaluation() })),
      row = addRow(value);
    const card = realm.document.getElementById("perf-score-card")!;
    Object.defineProperty(card, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(card, "clientHeight", { configurable: true, value: 100 });
    runtime.show(value.id, row, { keyboard: true });
    expect(card.querySelector("img")).toBeNull();
    expect(card.textContent).toContain(value.project);
    expect(card.dataset.compact).toBe("2");
    const description = realm.document.getElementById(row.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain("Tokens written per second while responding");
    row.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    expect(card.scrollTop).toBe(80);
  });
  it("dismisses hover until pointer re-entry, follows keyboard focus and repositions on scrolling", () => {
    const a = agent(),
      b = agent("agent-b"),
      { runtime, realm, addRow, advance } = harness(
        snapshot([], [a, b], {
          [a.id]: evaluation(),
          [b.id]: evaluation({ shown: 1540, score: 1540, form: "resting" }),
        }),
      );
    const first = addRow(a),
      second = addRow(b),
      card = realm.document.getElementById("perf-score-card")!;
    pointer(realm, "pointerover", first);
    advance(449);
    expect(card.hidden).toBe(true);
    advance(1);
    expect(card.hidden).toBe(false);
    first.dispatchEvent(new realm.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(card.hidden).toBe(true);
    pointer(realm, "pointermove", first);
    advance(1000);
    runtime.render();
    expect(card.hidden).toBe(true);
    pointer(realm, "pointerout", first, realm.document.body);
    pointer(realm, "pointerover", first, realm.document.body);
    advance(450);
    expect(card.hidden).toBe(false);
    pointer(realm, "pointerout", first, second);
    pointer(realm, "pointerover", second, first);
    expect(card.querySelector(".perf-c-big")?.textContent).toBe("1,540");
    runtime.hide();
    first.focus();
    first.dispatchEvent(new realm.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(card.hidden).toBe(false);
    second.focus();
    expect(card.querySelector(".perf-c-big")?.textContent).toBe("1,540");
    let top = 200;
    Object.defineProperty(second, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 600, right: 800, top, bottom: top + 30, width: 200, height: 30 }),
    });
    runtime.show(b.id, second);
    const before = card.style.top;
    top = 20;
    realm.document.dispatchEvent(new realm.Event("scroll", { bubbles: true }));
    expect(card.style.top).not.toBe(before);
  });
  it("counts both rises and falls, updating the card scale, but replaces under reduced motion", () => {
    const value = agent(),
      data = snapshot([], [value], { [value.id]: evaluation({ shown: 1000, score: 1000 }) });
    const { runtime, realm, addRow, advance, media, pending } = harness(data),
      row = addRow(value);
    runtime.view.preferences.effects = "standard";
    runtime.show(value.id, row);
    data.performance.current[value.id] = evaluation({ shown: 2000, score: 2000 });
    runtime.render();
    advance(300);
    const shown = Number(
      realm.document.querySelector(".perf-c-big")!.textContent!.replace(/,/g, ""),
    );
    expect(shown).toBeGreaterThan(1000);
    expect(shown).toBeLessThan(2000);
    advance(400);
    expect(realm.document.querySelector(".perf-c-big")?.textContent).toBe("2,000");
    data.performance.current[value.id] = evaluation({ shown: 1000, score: 1000 });
    runtime.render();
    advance(300);
    const falling = Number(
      realm.document.querySelector(".perf-c-big")!.textContent!.replace(/,/g, ""),
    );
    expect(falling).toBeLessThan(2000);
    expect(falling).toBeGreaterThan(1000);
    media("(prefers-reduced-motion: reduce)", true);
    expect(realm.document.querySelector(".perf-c-big")?.textContent).toBe("1,000");
    expect(pending.size).toBe(0);
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
  it("keeps sort picker options cached and model selection across updates, with native copy-row text", async () => {
    const data = snapshot([record("2026-10-29"), record("2026-10-29", "model-b", 30, 100)]),
      { runtime, realm, clipboard } = harness(data);
    const select = realm.document.getElementById("perf-model-sort") as HTMLSelectElement,
      option = select.options[0];
    const second = Array.from(
      realm.document.querySelectorAll<HTMLElement>(".perf-table tbody tr"),
    ).find((row) => row.textContent!.includes("model-b"))!;
    second.click();
    runtime.render();
    expect(realm.document.querySelector(".perf-table tr.perf-selected")?.textContent).toContain(
      "model-b",
    );
    expect(select.options[0]).toBe(option);
    const selected = realm.document.querySelector<HTMLElement>(".perf-table tr.perf-selected")!;
    selected.dispatchEvent(
      new realm.KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }),
    );
    await Promise.resolve();
    expect(clipboard).toHaveBeenCalledOnce();
    expect(clipboard.mock.calls[0]![0]).toContain("model-b\tOMP\tPerf:");
    expect(clipboard.mock.calls[0]![0]).toContain("Throughput:");
    runtime.setLanguage("zh");
    expect(select.options[0]).not.toBe(option);
    expect(realm.document.getElementById("perf-performance-title")?.textContent).toBe("性能表现");
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
  it("keeps an unknown score absent in text and accessibility without repeating its label", () => {
    const value = agent(),
      state = evaluation({ form: "none", shown: null, score: null, n: 2, provisional: false });
    const { runtime } = harness(snapshot([], [value], { [value.id]: state }), true),
      frame = runtime.frame("orb-art");
    expect(frame.visible).toBe(true);
    expect(frame.glyphs.some((glyph) => glyph.text === "–")).toBe(true);
    expect(frame.description).toBe("performance: no score yet, thinking 20 tokens per second");
  });
  it("crossfades live to resting ink over two hundred milliseconds without an idle animation", () => {
    const value = agent(),
      data = snapshot([], [value], { [value.id]: evaluation() }),
      { runtime, advance, pending } = harness(data, true);
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
    const { runtime } = harness(
      snapshot([], [a, b], {
        [a.id]: evaluation({ shown: 12840, score: 12840, provisional: true, n: 4 }),
        idle: evaluation({ shown: 99999, score: 99999, form: "resting" }),
      }),
      true,
    );
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
    data.rate.measuredThinkingTps = 0;
    runtime.render();
    advance(3000);
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "TH")).toBe(false);
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
      { runtime, realm, media } = harness(
        snapshot([], [value], { [value.id]: evaluation({ provisional: true, n: 5 }) }),
        true,
      );
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
  it("keeps configuration local and sends only the accepted preference names", async () => {
    const { runtime, realm } = harness(snapshot());
    const input = realm.document.getElementById("show-performance") as HTMLInputElement;
    input.checked = false;
    input.dispatchEvent(new realm.Event("change", { bubbles: true }));
    await Promise.resolve();
    expect(runtime.calls).toEqual([{ showPerformance: false }]);
  });
});
