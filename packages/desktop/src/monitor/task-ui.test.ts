/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MONITOR_TASK_MARKUP,
  MONITOR_TASK_SCRIPT,
  taskCompareBetter,
  taskShownDimensions,
  taskThinkingVisibility,
} from "./task-ui";
import { MONITOR_SELECT_PICKER_SCRIPT } from "./select-picker";
import type { OmpMonitorAgent, OmpMonitorSnapshot, OmpMonitorUsage } from "./types";
import type { MonitorTaskCounts, MonitorTaskRecord, MonitorTaskStatus } from "./task-types";

const counts = (patch: Partial<MonitorTaskCounts> = {}): MonitorTaskCounts => ({
  actions: 8,
  counted: 8,
  edits: 1,
  oscillations: 0,
  loopActions: 0,
  runs: 1,
  failingRuns: 0,
  episodes: 0,
  recovered: 0,
  recoverAttempts: 0,
  fixAttempts: 0,
  fixFailures: 0,
  ...patch,
});
const usage: OmpMonitorUsage = {
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
};
function record(
  ordinal: number,
  model: string | null,
  score: number | null,
  patch: Partial<MonitorTaskRecord> = {},
): MonitorTaskRecord {
  return {
    agentId: "agent-" + ordinal,
    day: "2026-10-29",
    ordinal,
    startMs: ordinal * 10000,
    endMs: ordinal * 10000 + 1000,
    complete: true,
    model,
    effort: null,
    state: score === null ? "none" : "passing",
    score,
    dims: { V: 40, C: 20, R: 0, E: 10, K: 10 },
    counts: counts(),
    firstPassMs: score === null ? null : ordinal * 10000 + 1000,
    success: score !== null,
    stalled: false,
    snapshots: [],
    fixRows: [],
    ...patch,
  };
}
function agent(id: string, patch: Partial<OmpMonitorAgent> = {}): OmpMonitorAgent {
  return {
    id,
    parentId: null,
    name: id,
    project: "project",
    profile: "default",
    kind: "main",
    model: "model-a",
    phase: "generating",
    lastActivityAt: 1793232000000,
    outputTps: 20,
    liveMeasuredTps: 20,
    liveEstimatedTps: 0,
    thinkingTps: 5,
    liveCostUsdPerSecond: null,
    speedMode: null,
    ttftMs: 120,
    ...patch,
  };
}
function status(patch: Partial<MonitorTaskStatus> = {}): MonitorTaskStatus {
  return {
    taskStartMs: 1793232000000,
    form: "live",
    result: {
      state: "failing",
      score: 20,
      shown: 20,
      dims: { V: 0, C: 10, R: 0, E: 10, K: 0 },
      counts: counts({ failingRuns: 1, episodes: 1, fixAttempts: 1 }),
      firstPassMs: null,
      heldV: null,
      openFailure: {
        suite: "pytest",
        runClass: "test",
        errors: 3,
        peak: 6,
        counted: true,
        edited: false,
      },
      lastPass: null,
    },
    predictions: {
      success: 0.4,
      stall: 0.8,
      fixFailure: 0.3,
      models: {
        success: { calibrated: false, tasks: 10 },
        stall: { calibrated: true, tasks: 50 },
        fix: { calibrated: false, tasks: 42 },
      },
    },
    ...patch,
  };
}
function snapshot(
  records: MonitorTaskRecord[] = [],
  agents: OmpMonitorAgent[] = [],
  current: Record<string, MonitorTaskStatus> = {},
): OmpMonitorSnapshot {
  const feed = {
    status: "bundled" as const,
    version: "3",
    updatedAt: null,
    fetchedAt: null,
    lastAttemptAt: null,
    source: "bundled",
  };
  return {
    updatedAt: 1793232000000,
    scope: { profile: null, project: null },
    scopes: { profiles: [], projects: [] },
    resources: {
      status: "unavailable",
      sampledAt: 0,
      processCount: 0,
      cpuPercent: null,
      workingSetBytes: null,
      privateBytes: null,
      reason: "no_processes",
    },
    pricing: {
      networkEnabled: false,
      currency: "USD",
      currencies: ["USD"],
      prices: feed,
      rates: feed,
      exchangeRate: 1,
      attribution: null,
    },
    status: "ready",
    activity: { lastResponseAt: null, peakAt: null, peakObservedAt: null },
    rate: { measuredTps: 20, estimatedTps: 0, measuredThinkingTps: 5, estimatedThinkingTps: null },
    today: { ...usage },
    days: [],
    tasks: { current, records, scanning: false, limited: false },
    agents,
    series: [],
    coverage: {
      roots: [],
      discoveredFiles: 1,
      readFiles: 1,
      skippedFiles: 0,
      malformedLines: 0,
      limited: false,
      issues: [],
    },
  };
}

interface Runtime {
  render(next?: OmpMonitorSnapshot): void;
  createTaskScoreCell(agent: OmpMonitorAgent): HTMLElement;
  createModeCell(agent: OmpMonitorAgent): HTMLElement;
  show(id: string, anchor: HTMLElement): void;
  hide(): void;
  destroy(): void;
  frame(id: string): {
    visible: boolean;
    glyphs: Array<{ text: string; role: number; proof: boolean }>;
    description?: string;
  };
  view: {
    snapshot: OmpMonitorSnapshot;
    surface: string;
    preferences: {
      showTaskScore: boolean;
      showThinking: boolean;
      effects: string;
      size: number;
      style: string;
    };
  };
  calls: Array<Record<string, unknown>>;
}
const cleanups: Array<() => void> = [];
function harness(seed: OmpMonitorSnapshot, orb = false) {
  vi.useFakeTimers();
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const realm = frame.contentWindow as Window & typeof globalThis;
  realm.document.body.dataset.appearance = "light";
  realm.document.body.innerHTML = `<div id="page-orb"><div id="task-settings-slot"></div></div><main class="history-scroll"><div id="task-history-slot"></div></main><div id="agent-rows"></div>${orb ? '<div id="orb-art"></div><div id="hero-art"></div><div id="orb-hit"></div>' : ""}${MONITOR_TASK_MARKUP}`;
  Object.defineProperty(realm.document, "hidden", { configurable: true, value: false });
  Object.defineProperty(realm.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value() {},
  });
  const media = new Map<string, MediaQueryList>();
  realm.matchMedia = (query: string) => {
    let result = media.get(query);
    if (!result) {
      result = {
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      } as unknown as MediaQueryList;
      media.set(query, result);
    }
    return result;
  };
  if (orb) {
    Object.defineProperty(realm.HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => ({ font: "", measureText: (value: string) => ({ width: value.length * 4 }) }),
    });
    // Deterministic font metrics for readout state transitions, not a visual/GPU acceptance substitute.
  }
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
    `let view = { snapshot:seed, instanceId:'orb-1', surface:'${orb ? "orb" : "history"}', orbVisible:true, scope:{profile:null,project:null}, activity:{peakSequence:0}, preferences:{showTaskScore:true,showThinking:true,effects:'off',size:148,style:'led'} };
     let language='en',appearance='light'; const calls=[];
     const node=id=>document.getElementById(id),finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
     const number=(value,digits=0)=>value===null?'—':new Intl.NumberFormat('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value);
     const timestamp=value=>String(value),snapshotFacts=()=>view.snapshot,liveFacts=()=>view.snapshot;
     const selectedDates=()=>({startDate:'2026-10-29',endDate:'2026-10-29'});
     const bridge={configure:async patch=>{calls.push(patch);Object.assign(view.preferences,patch);}},action=work=>Promise.resolve(work());
     ${MONITOR_SELECT_PICKER_SCRIPT}
     monitorSelectPicker.install();
     ${MONITOR_TASK_SCRIPT}
     bindTaskUI();
     return {view,calls,render(next){if(next)view.snapshot=next;renderTaskUI(view.snapshot);},createTaskScoreCell,createModeCell,show:taskShowCard,hide:taskHideCard,destroy:destroyTaskUI,frame:taskOrbReadoutFrame};`,
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
      runtime.createTaskScoreCell(value),
      realm.document.createElement("span"),
    );
    realm.document.getElementById("agent-rows")!.append(row);
    runtime.render();
    return row;
  };
  cleanups.push(() => {
    runtime.destroy();
    frame.remove();
  });
  return { runtime, realm, advance, addRow, pending, clipboard };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("task score display statistics", () => {
  it("allocates fractional remainders in V C R E K order and preserves the shown sum", () => {
    const shown = taskShownDimensions({ V: 0, C: 3.5, R: 3.5, E: 3.5, K: 3.5 }, 14);
    expect(shown).toEqual({ V: 0, C: 4, R: 4, E: 3, K: 3 });
    expect(Object.values(shown).reduce((sum, value) => sum + value, 0)).toBe(14);
  });
  it("never ranks small samples, unknowns or values that format identically", () => {
    expect(taskCompareBetter("successRate", 0.8, 0.5, 9, 100, "80%", "50%")).toBe(0);
    expect(taskCompareBetter("successRate", null, 0.5, 100, 100, "–", "50%")).toBe(0);
    expect(taskCompareBetter("timeToFirstPassMs", 299000, 301000, 20, 20, "5 min", "5 min")).toBe(
      0,
    );
    expect(taskCompareBetter("recoverAttempts", 1.96, 2, 20, 20, "1.9", "2.0")).toBe(0);
    expect(taskCompareBetter("recoverAttempts", 1.9, 2, 20, 20, "1.9", "2.0")).toBe(1);
    expect(taskCompareBetter("successRate", 0.81, 0.8, 10, 10, "81%", "80%")).toBe(1);
  });
  it("holds an actual displayed zero for three seconds and preserves unknown instead of coercing it", () => {
    const initial = { hidden: true, zeroSince: null, enabled: true };
    expect(taskThinkingVisibility(initial, null, true, 0)).toEqual(initial);
    const zero = taskThinkingVisibility(initial, 0, true, 100);
    expect(zero.hidden).toBe(false);
    expect(taskThinkingVisibility(zero, 0, true, 3099).hidden).toBe(false);
    expect(taskThinkingVisibility(zero, 0, true, 3100).hidden).toBe(true);
    expect(taskThinkingVisibility(zero, null, true, 5000)).toEqual(zero);
    const hidden = taskThinkingVisibility(zero, 0, true, 5000);
    expect(taskThinkingVisibility(hidden, null, true, 9000).hidden).toBe(true);
    expect(taskThinkingVisibility(hidden, 12, true, 9000)).toEqual({
      hidden: false,
      zeroSince: null,
      enabled: true,
    });
    const disabled = taskThinkingVisibility(hidden, null, false, 9000);
    expect(taskThinkingVisibility(disabled, null, true, 9001).hidden).toBe(false);
  });
});

describe("safe task performance DOM", () => {
  it("refreshes elapsed first-pass statistics when a completed record's start time is corrected", () => {
    const task = record(1, "model-a", 80, {
      startMs: 1793232000000,
      firstPassMs: 1793232060000,
      endMs: 1793232100000,
    });
    const data = snapshot([task]),
      { runtime, realm } = harness(data);
    const firstPass = () =>
      realm.document.querySelector<HTMLTableRowElement>(".task-tbl tbody tr")!.cells[9]!
        .textContent;
    runtime.render(); // Settle the remembered model selection before exercising an otherwise unchanged cache key.
    expect(firstPass()).toBe("1 min");
    task.startMs += 30000;
    runtime.render();
    expect(firstPass()).toBe("30 sec");
  });
  it("uses complete in-range records and keeps each rate's real denominator", () => {
    const { realm } = harness(
      snapshot([
        record(1, "model-a", 80),
        record(2, "model-a", 10, { success: false, state: "unverified", firstPassMs: null }),
        record(3, "model-b", null, { stalled: true }),
        record(4, "model-b", 60, {
          counts: counts({ fixAttempts: 4, fixFailures: 1, recovered: 1, recoverAttempts: 3 }),
        }),
        record(5, "model-b", 100, { complete: false }),
        record(6, "model-a", 100, { day: "2026-10-28" }),
      ]),
    );
    const rows = [...realm.document.querySelectorAll<HTMLTableRowElement>(".task-tbl tbody tr")];
    expect(rows).toHaveLength(2);
    const a = rows.find((row) => row.cells[0]!.textContent!.includes("model-a"))!;
    const b = rows.find((row) => row.cells[0]!.textContent!.includes("model-b"))!;
    expect(a.cells[1]!.textContent).toBe("2");
    expect(a.cells[2]!.textContent).toBe("2");
    expect(a.cells[5]!.textContent).toBe("50%");
    expect(a.cells[5]!.title).toBe("1 of 2 scored tasks");
    expect(b.cells[1]!.textContent).toBe("2");
    expect(b.cells[2]!.textContent).toBe("1");
    expect(b.cells[5]!.textContent).toBe("100%");
    expect(b.cells[5]!.title).toBe("1 of 1 scored tasks");
    expect(b.cells[6]!.textContent).toBe("50%");
    expect(b.cells[6]!.title).toBe("1 of 2 tasks");
    expect(b.cells[7]!.textContent).toBe("25%");
    expect(b.cells[7]!.title).toBe("1 of 4 runs after a failure");
    expect(b.querySelector(".task-iqr")!.getAttribute("aria-label")).toContain("60 to 60");
    expect(realm.document.querySelectorAll(".task-better")).toHaveLength(0);
  });
  it("keeps readonly tasks, unknown model and null statistics visible in single-model mode", () => {
    const { realm } = harness(snapshot([record(1, null, null, { stalled: true })]));
    expect(realm.document.getElementById("task-model-picks")!.hidden).toBe(true);
    const row = realm.document.querySelector<HTMLTableRowElement>(".task-tbl tbody tr")!;
    expect(row.cells[0]!.textContent).toContain("Unknown model");
    expect(row.cells[1]!.textContent).toBe("1");
    expect(row.cells[2]!.textContent).toBe("0");
    expect(row.cells[4]!.textContent).toBe("–");
    expect(row.cells[5]!.textContent).toBe("–");
    expect(row.cells[6]!.textContent).toBe("100%");
    expect(row.cells[8]!.title).toBe("No task recovered from an error in this period");
  });
  it("has honest scanning and limited states without synthesizing completed tasks", () => {
    const data = snapshot();
    data.tasks.scanning = true;
    data.tasks.limited = true;
    const { realm } = harness(data);
    const section = realm.document.getElementById("task-performance")!;
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(section.textContent).toContain("Re-analyzing past tasks");
    expect(section.textContent).toContain("coverage is limited");
    expect(section.querySelector(".task-tbl")).toBeNull();
  });
  it("copies only the selected derived model row on a real copy gesture and updates local statistics on pair changes", async () => {
    const { runtime, realm, clipboard } = harness(
      snapshot([record(1, "model-a", 80), record(2, "model-b", 60), record(3, "model-c", 40)]),
    );
    const a = realm.document.getElementById("task-model-a") as HTMLSelectElement;
    const b = realm.document.getElementById("task-model-b") as HTMLSelectElement;
    expect([...a.options].some((option) => option.value === b.value)).toBe(false);
    b.value = "model:model-c";
    b.dispatchEvent(new realm.Event("change", { bubbles: true }));
    expect(realm.document.querySelector(".task-side-b")!.textContent).toContain("model-c");
    const row = realm.document.querySelector<HTMLTableRowElement>(".task-tbl tbody tr")!;
    row.dispatchEvent(
      new realm.KeyboardEvent("keydown", {
        key: "c",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect(clipboard.mock.calls[0]![0]).toContain("Tasks: 1");
    expect(runtime.calls).toHaveLength(0);
  });
  it("uses the existing in-window picker for cloned pair selectors and every rebuilt sort selector", () => {
    const { runtime, realm } = harness(
      snapshot([record(1, "model-a", 80), record(2, "model-b", 60), record(3, "model-c", 40)]),
    );
    const changed: string[] = [];
    realm.document.addEventListener("change", (event) =>
      changed.push((event.target as HTMLSelectElement).id),
    );
    const open = (select: HTMLSelectElement) => {
      const event = new realm.MouseEvent("mousedown", {
        button: 0,
        detail: 1,
        bubbles: true,
        cancelable: true,
      });
      select.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      const popup = realm.document.querySelector<HTMLElement>('[role="listbox"]')!;
      expect(popup.hidden).toBe(false);
      return popup;
    };
    const choose = (popup: HTMLElement, value: string) => {
      const option = [...popup.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
        (button) => button.dataset.value === value,
      )!;
      option.dispatchEvent(
        new realm.MouseEvent("click", { button: 0, detail: 1, bubbles: true, cancelable: true }),
      );
      expect(popup.hidden).toBe(true);
    };
    const pair = realm.document.getElementById("task-model-a") as HTMLSelectElement;
    choose(open(pair), "model:model-c");
    expect(realm.document.querySelector(".task-side-a")!.textContent).toContain("model-c");
    const firstSort = realm.document.getElementById("task-model-sort") as HTMLSelectElement;
    choose(open(firstSort), "model");
    expect(firstSort.isConnected).toBe(false);
    const nextSort = realm.document.getElementById("task-model-sort") as HTMLSelectElement;
    expect(nextSort).not.toBe(firstSort);
    choose(open(nextSort), "medianScore");
    expect(changed).toEqual(["task-model-a", "task-model-sort", "task-model-sort"]);
    expect(runtime.calls).toHaveLength(0);
    const disconnectedPopup = open(
      realm.document.getElementById("task-model-sort") as HTMLSelectElement,
    );
    runtime.render(snapshot());
    expect(disconnectedPopup.hidden).toBe(true);
  });
});

describe("live task card and readout interactions", () => {
  it("configures the score and thinking switches independently without changing either other preference", async () => {
    const { runtime, realm } = harness(snapshot());
    runtime.view.preferences.showTaskScore = false;
    runtime.view.preferences.showThinking = true;
    runtime.render();
    const score = realm.document.getElementById("show-task-score") as HTMLInputElement;
    const thinking = realm.document.getElementById("show-thinking") as HTMLInputElement;
    expect(score.checked).toBe(false);
    expect(thinking.checked).toBe(true);
    score.checked = true;
    score.dispatchEvent(new realm.Event("change", { bubbles: true }));
    thinking.checked = false;
    thinking.dispatchEvent(new realm.Event("change", { bubbles: true }));
    await Promise.resolve();
    expect(runtime.calls).toEqual([{ showTaskScore: true }, { showThinking: false }]);
  });
  it("preserves the existing score when an agent row is rebuilt with unchanged numeric facts", () => {
    const value = agent("agent-a"),
      data = snapshot([], [value], { "agent-a": status() });
    const { runtime, addRow } = harness(data);
    const first = addRow(value);
    expect(first.querySelector(".task-score-value")!.textContent).toBe("20");
    first.remove();
    const second = addRow(value);
    expect(second.querySelector(".task-score-value")!.textContent).toBe("20");
    runtime.view.preferences.showTaskScore = false;
    runtime.render();
    expect(second.querySelector<HTMLElement>(".task-score-cell")!.hidden).toBe(true);
  });
  it("opens after the original hover delay, switches immediately and closes on Escape before the parent window", () => {
    const a = agent("agent-a"),
      b = agent("agent-b", { project: "other" });
    const { realm, advance, addRow } = harness(
      snapshot([], [a, b], { "agent-a": status(), "agent-b": status() }),
    );
    const ra = addRow(a),
      rb = addRow(b),
      card = realm.document.getElementById("task-score-card")!;
    ra.dispatchEvent(new realm.MouseEvent("pointerover", { bubbles: true }));
    advance(449);
    expect(card.hidden).toBe(true);
    advance(1);
    expect(card.hidden).toBe(false);
    rb.dispatchEvent(new realm.MouseEvent("pointerover", { bubbles: true, relatedTarget: ra }));
    expect(card.querySelector(".task-c-head b")!.textContent).toBe("other");
    const escape = new realm.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    rb.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(card.hidden).toBe(true);
  });
  it("keeps Escape-dismissed cards closed through stationary hover and row replacement without blocking intentional reopening", () => {
    const value = agent("agent-a");
    const { realm, advance, addRow } = harness(snapshot([], [value], { "agent-a": status() }));
    const first = addRow(value);
    const card = realm.document.getElementById("task-score-card")!;
    const pointer = (type: string, x = 40) =>
      new realm.MouseEvent(type, { bubbles: true, clientX: x, clientY: 32 });
    const escape = () =>
      realm.document.dispatchEvent(
        new realm.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    first.dispatchEvent(pointer("pointerover"));
    advance(450);
    expect(card.hidden).toBe(false);
    card.dispatchEvent(pointer("pointerover"));
    escape();
    first.dispatchEvent(pointer("pointerover"));
    advance(450);
    expect(card.hidden).toBe(true);
    first.remove();
    const replacement = addRow(value);
    replacement.dispatchEvent(pointer("pointerover"));
    advance(1_000);
    expect(card.hidden).toBe(true);
    replacement.dispatchEvent(
      new realm.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
    );
    expect(card.hidden).toBe(false);
    escape();
    replacement.dispatchEvent(pointer("pointermove", 41));
    advance(449);
    expect(card.hidden).toBe(true);
    advance(1);
    expect(card.hidden).toBe(false);
    escape();
    realm.document.documentElement.dispatchEvent(
      new realm.MouseEvent("pointerleave", { clientX: 41, clientY: 32 }),
    );
    replacement.dispatchEvent(pointer("pointerover", 41));
    advance(450);
    expect(card.hidden).toBe(false);
  });
  it("binds all five real dimensions, three prediction flags and held V without exposing markup", () => {
    const value = agent("agent-a", { project: '<img src=x onerror="bad()">' }),
      live = status();
    const data = snapshot([], [value], { "agent-a": live });
    const { runtime, realm, addRow } = harness(data),
      row = addRow(value);
    runtime.show(value.id, row);
    const card = realm.document.getElementById("task-score-card")!;
    expect(card.querySelector("img")).toBeNull();
    expect(card.textContent).toContain(value.project);
    expect(card.querySelectorAll(".task-dim")).toHaveLength(5);
    expect(card.querySelectorAll(".task-pred > div")).toHaveLength(3);
    expect(card.textContent).toContain("Prior · 10/40");
    expect(card.textContent).toContain("50 tasks");
    expect(card.querySelectorAll(".task-pred > div")[2]!.getAttribute("title")).toContain("N=42");
    const passing = status({
      result: {
        ...live.result!,
        state: "passing",
        score: 100,
        shown: 100,
        dims: { V: 40, C: 25, R: 15, E: 10, K: 10 },
        firstPassMs: live.taskStartMs! + 60000,
        openFailure: null,
        lastPass: { suite: "pytest", runClass: "test", buildOnly: false },
      },
    });
    data.tasks.current[value.id] = passing;
    runtime.render();
    expect([...card.querySelectorAll(".task-dim .task-v")].map((cell) => cell.textContent)).toEqual(
      ["40 / 40", "25 / 25", "15 / 15", "10 / 10", "10 / 10"],
    );
    expect(card.querySelectorAll(".task-dim")[1]!.getAttribute("aria-label")).toContain("25 / 25");
    expect((card.querySelectorAll(".task-dim .task-bar i")[1] as HTMLElement).style.width).toBe(
      "100%",
    );
    expect(card.querySelector(".task-c-facts")!.textContent).toContain("First pass: 1 min");
    data.tasks.current[value.id] = { ...passing, taskStartMs: null };
    runtime.render();
    expect(card.querySelector(".task-c-facts")!.textContent).toContain("First pass: –");
    const pending = status({
      result: {
        ...live.result!,
        state: "pending",
        score: 20,
        shown: 20,
        heldV: 40,
        openFailure: null,
        lastPass: { suite: "pytest", runClass: "test", buildOnly: false },
      },
    });
    data.tasks.current[value.id] = pending;
    runtime.render();
    expect(card.querySelector(".task-n")!.classList.contains("task-pm")).toBe(true);
    expect(card.querySelector(".task-dim .task-bar i")!.classList.contains("task-ghost")).toBe(
      true,
    );
    expect(card.textContent).toContain("Held credit awaiting a passing re-run: 40 / 40");
    data.tasks.current[value.id] = { ...pending, form: "resting" };
    runtime.render();
    expect(card.querySelector<HTMLElement>(".task-pred")!.parentElement!.hidden).toBe(true);
  });
  it("keeps keyboard focus on the agent, permits small-window card scrolling, and removes all handlers on destroy", () => {
    const value = agent("agent-a");
    const { runtime, realm, addRow } = harness(snapshot([], [value], { "agent-a": status() }));
    const row = addRow(value);
    row.focus();
    row.dispatchEvent(
      new realm.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
    );
    const card = realm.document.getElementById("task-score-card")!;
    Object.defineProperty(card, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(card, "clientHeight", { configurable: true, value: 200 });
    const page = new realm.KeyboardEvent("keydown", {
      key: "PageDown",
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(page);
    expect(page.defaultPrevented).toBe(true);
    expect(card.scrollTop).toBe(160);
    expect(realm.document.activeElement).toBe(row);
    runtime.destroy();
    row.dispatchEvent(
      new realm.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
    );
    expect(realm.document.getElementById("task-score-card")).toBeNull();
  });
  it("shows original Fast/Ultrafast bolts with selected/recorded evidence and never fabricates Standard or an effort rung", () => {
    const { runtime } = harness(snapshot());
    expect(runtime.createModeCell(agent("a")).hidden).toBe(true);
    const fast = runtime.createModeCell(
      agent("a", { speedMode: { value: "fast", evidence: "selected", provider: "openai" } }),
    );
    expect(fast.querySelectorAll("svg")).toHaveLength(1);
    expect(fast.title).toContain("Selected mode; not proof of server execution");
    const ultra = runtime.createModeCell(
      agent("a", { speedMode: { value: "ultrafast", evidence: "recorded", provider: "openai" } }),
    );
    expect(ultra.querySelectorAll("svg")).toHaveLength(2);
    expect(ultra.title).toContain("Execution mode recorded in the log");
    const unknown = runtime.createModeCell(
      agent("a", { speedMode: { value: "priority", evidence: "selected", provider: null } }),
    );
    expect(unknown.hidden).toBe(true);
    expect(unknown.title).not.toContain("Standard");
    expect(unknown.textContent).not.toMatch(/xhigh|max/);
  });
  it("uses the highest live supplier and nullable thinking, hides the actual zero after its hold, and never enables previews", () => {
    const a = agent("agent-a"),
      b = agent("agent-b", { phase: "idle" });
    const resting = status({
      form: "resting",
      result: { ...status().result!, score: 95, shown: 95 },
    });
    const data = snapshot([], [a, b], { "agent-a": status(), "agent-b": resting });
    const { runtime, advance } = harness(data, true);
    advance(2);
    runtime.render();
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "20")).toBe(true);
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "95")).toBe(false);
    expect(runtime.frame("preview-led").visible).toBe(false);
    data.rate.measuredThinkingTps = 0;
    runtime.render();
    advance(2999);
    runtime.render();
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "TH")).toBe(true);
    advance(1);
    runtime.render();
    advance(2);
    runtime.render();
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "TH")).toBe(false);
    data.rate.measuredThinkingTps = null;
    runtime.render();
    expect(runtime.frame("orb-art").glyphs.some((glyph) => glyph.text === "TH")).toBe(false);
  });
});
