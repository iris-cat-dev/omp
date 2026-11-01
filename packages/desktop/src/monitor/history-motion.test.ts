import { describe, expect, it } from "vitest";
import {
  createHistoryChartMotion,
  createHistoryMotionDriver,
  createHistoryRowsMotion,
  historyBackEase,
  historySpringStep,
  type HistoryChartMotion,
  type HistoryMotionBar,
  type HistoryMotionFrame,
} from "./history-motion";

function bar(date: string, value: number, source = "omp"): HistoryMotionBar {
  return { key: JSON.stringify([date, source]), date, source, value };
}
function frame(patch: Partial<HistoryMotionFrame> = {}): HistoryMotionFrame {
  return {
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    metric: "output",
    filter: "all",
    maximum: 100,
    left: 42,
    right: 38,
    bars: [bar("2026-10-30", 60)],
    ...patch,
  };
}
function advance(chart: HistoryChartMotion, seconds: number) {
  const steps = Math.ceil(seconds / 0.025);
  for (let index = 0; index < steps; index++) chart.step(seconds / steps);
}

describe("native HistoryChart motion", () => {
  it("integrates the native analytic spring independently of frame subdivision and caps a stalled frame", () => {
    const full = historySpringStep(0, 0, 0.05),
      first = historySpringStep(0, 0, 0.025),
      split = historySpringStep(first.value, first.velocity, 0.025);
    expect(split.value).toBeCloseTo(full.value, 12);
    expect(split.velocity).toBeCloseTo(full.velocity, 12);
    expect(full.value).toBeGreaterThan(0);
    expect(full.value).toBeLessThan(1);
    expect(historySpringStep(0, 0, 5)).toEqual(full);
    expect(historySpringStep(0.4, 3, 0)).toEqual({ value: 0.4, velocity: 3 });
  });

  it("grows the first frame from the baseline with a .32 response, fades the line, and finishes by .45 seconds", () => {
    const chart = createHistoryChartMotion(),
      target = frame();
    chart.setTarget(target, "entrance", false);
    expect(chart.sample().frame!.bars[0]!.value).toBe(0);
    expect(chart.sample().lineAlpha).toBe(0);
    chart.step(0.05);
    expect(chart.sample().frame!.bars[0]!.value).toBeCloseTo(
      60 * historySpringStep(0, 0, 0.05, 0.32).value,
    );
    expect(chart.sample().lineAlpha).toBeCloseTo(1 / 6);
    advance(chart, 0.4);
    expect(chart.active).toBe(false);
    expect(chart.sample()).toMatchObject({ frame: target, opacity: 1, lineAlpha: 1, layers: [] });
    expect(target.bars[0]!.value).toBe(60);
  });

  it("retargets metric units, maxima and margins from the currently displayed frame without a height jump", () => {
    const chart = createHistoryChartMotion();
    chart.setTarget(frame(), "snap", false);
    chart.setTarget(
      frame({ maximum: 200, left: 70, right: 60, bars: [bar("2026-10-30", 150)] }),
      "live",
      false,
    );
    advance(chart, 0.1);
    const before = chart.sample().frame!,
      ratio = before.bars[0]!.value / before.maximum,
      left = before.left,
      right = before.right;
    chart.setTarget(
      frame({
        metric: "recorded:USD",
        maximum: 10,
        left: 50,
        right: 12,
        bars: [bar("2026-10-30", 7)],
      }),
      "morph",
      false,
    );
    const after = chart.sample().frame!;
    expect(after.maximum).toBe(10);
    expect(after.bars[0]!.value / after.maximum).toBeCloseTo(ratio, 12);
    expect(after.left).toBe(left);
    expect(after.right).toBe(right);
    expect(chart.sample().lineAlpha).toBe(0);
    advance(chart, 0.45);
    expect(chart.sample().frame).toMatchObject({
      maximum: 10,
      left: 50,
      right: 12,
      bars: [bar("2026-10-30", 7)],
    });
  });

  it("matches bars by date and source across a sparse multi-year range rather than by array position", () => {
    const chart = createHistoryChartMotion();
    chart.setTarget(
      frame({
        startDate: "2001-01-01",
        bars: [
          bar("2001-02-03", 5),
          bar("2026-10-30", 60),
          bar("2026-10-30", 20, "retiring-source"),
        ],
      }),
      "snap",
      false,
    );
    chart.setTarget(
      frame({ startDate: "2002-01-01", bars: [bar("2003-05-06", 30), bar("2026-10-30", 90)] }),
      "morph",
      false,
    );
    const initial = chart.sample().frame!.bars;
    expect(initial).toHaveLength(3);
    expect(initial.find((value) => value.date === "2003-05-06")!.value).toBe(0);
    expect(initial.find((value) => value.key === bar("2026-10-30", 0).key)!.value).toBe(60);
    expect(initial.find((value) => value.source === "retiring-source")!.value).toBe(20);
    expect(initial.some((value) => value.date === "2001-02-03")).toBe(false);
    advance(chart, 0.45);
    expect(chart.sample().frame!.bars).toEqual([bar("2003-05-06", 30), bar("2026-10-30", 90)]);
  });

  it("does not restart an equal snapshot, including a newly allocated but equal bar list", () => {
    const chart = createHistoryChartMotion(),
      next = frame({ bars: [bar("2026-10-30", 95)] });
    chart.setTarget(frame(), "snap", false);
    chart.setTarget(next, "morph", false);
    advance(chart, 0.1);
    const elapsed = chart.sample().elapsed,
      shown = chart.sample().frame,
      target = chart.target,
      alpha = chart.sample().lineAlpha;
    expect(chart.setTarget(frame({ bars: [bar("2026-10-30", 95)] }), "morph", false)).toBe(false);
    expect(chart.target).toBe(target);
    expect(chart.sample().elapsed).toBe(elapsed);
    expect(chart.sample().frame).toBe(shown);
    expect(chart.sample().lineAlpha).toBe(alpha);
    advance(chart, 0.35);
    expect(chart.active).toBe(false);
  });

  it("retains an already visible speed line for live data, but fades it for a new filter", () => {
    const chart = createHistoryChartMotion();
    chart.setTarget(frame(), "snap", false);
    chart.setTarget(frame({ bars: [bar("2026-10-30", 90)] }), "live", false);
    expect(chart.sample().lineAlpha).toBe(1);
    advance(chart, 0.05);
    chart.setTarget(frame({ filter: "project-a", bars: [bar("2026-10-30", 80)] }), "morph", false);
    expect(chart.sample().lineAlpha).toBe(0);
    advance(chart, 0.15);
    expect(chart.sample().lineAlpha).toBeCloseTo(0.5);
  });

  it("uses a .2 second OutQuad crossfade in reduced motion, retaining an interrupted visible mixture", () => {
    const chart = createHistoryChartMotion(),
      first = frame(),
      second = frame({ bars: [bar("2026-10-30", 90)] });
    chart.setTarget(first, "snap", true);
    chart.setTarget(second, "morph", true);
    expect(chart.sample().frame).toEqual(second);
    expect(chart.sample().opacity).toBe(0);
    expect(chart.sample().layers).toHaveLength(1);
    advance(chart, 0.1);
    expect(chart.sample().opacity).toBeCloseTo(0.75);
    chart.setTarget(frame({ bars: [bar("2026-10-30", 30)] }), "live", true);
    const layers = chart.sample().layers;
    expect(chart.sample().opacity).toBe(0);
    expect(layers).toHaveLength(2);
    expect(layers[0]!.opacity).toBeCloseTo(0.25);
    expect(layers[0]!.frame).toEqual(first);
    expect(layers[1]!.opacity).toBeCloseTo(0.75);
    expect(layers[1]!.frame).toEqual(second);
    advance(chart, 0.2);
    expect(chart.active).toBe(false);
    expect(chart.sample()).toMatchObject({ opacity: 1, lineAlpha: 1, layers: [] });
  });

  it("does not draw an old reduced-motion frame on an unequal number of date slots", () => {
    const chart = createHistoryChartMotion();
    chart.setTarget(frame(), "snap", true);
    chart.setTarget(frame({ startDate: "2026-10-25" }), "morph", true);
    expect(chart.sample().layers).toEqual([]);
    expect(chart.sample().opacity).toBe(0);
    chart.finish();
    expect(chart.active).toBe(false);
    expect(chart.sample().frame!.startDate).toBe("2026-10-25");
    expect(chart.sample().opacity).toBe(1);
  });
});

describe("native SpringStackPanel and BreakdownBar motion", () => {
  it("evaluates WPF's sine BackEase and does not substitute a cubic-bezier", () => {
    expect(historyBackEase(0, 0.2)).toBeCloseTo(0);
    expect(historyBackEase(1, 0.2)).toBe(1);
    expect(historyBackEase(0.5, 0.2)).toBeCloseTo(0.975);
    expect(historyBackEase(0.75, 0.2)).toBeGreaterThan(1);
  });

  it("retains keyed row objects and retargets their displayed tops when layout changes during a move", () => {
    const motion = createHistoryRowsMotion("mode");
    motion.setRows(
      [
        { key: "high", top: 0, fraction: 0.8 },
        { key: "unknown", top: 30, fraction: 0.2 },
      ],
      true,
      false,
    );
    motion.finish();
    const high = motion.rows().get("high")!;
    motion.setRows(
      [
        { key: "ultra", top: 0, fraction: 0.3 },
        { key: "high", top: 30, fraction: 0.5 },
        { key: "unknown", top: 60, fraction: 0.2 },
      ],
      true,
      false,
    );
    expect(motion.rows().get("high")).toBe(high);
    expect(high.top + high.offset).toBe(0);
    motion.step(0.1);
    const displayed = high.top + high.offset,
      fraction = high.shownFraction;
    motion.setRows(
      [
        { key: "high", top: 0, fraction: 0.7 },
        { key: "unknown", top: 30, fraction: 0.3 },
      ],
      true,
      false,
    );
    expect(high.top + high.offset).toBeCloseTo(displayed);
    expect(high.shownFraction).toBe(fraction);
    expect(motion.rows().has("ultra")).toBe(false);
    motion.step(0.35);
    expect(high).toMatchObject({ top: 0, offset: 0, opacity: 1, shownFraction: 0.7 });
    expect(motion.active).toBe(false);
  });

  it("fades new mode rows linearly for .2 seconds and leaves equal updates in flight", () => {
    const motion = createHistoryRowsMotion("mode"),
      rows = [{ key: "high", top: 0, fraction: 0.8 }];
    motion.setRows(rows, true, false);
    const row = motion.rows().get("high")!;
    expect(row.opacity).toBe(0);
    expect(row.shownFraction).toBe(0);
    motion.step(0.1);
    expect(row.opacity).toBeCloseTo(0.5);
    const elapsed = row.fractionElapsed,
      shown = row.shownFraction;
    motion.setRows(
      rows.map(({ key, top, fraction }) => ({ key, top, fraction })),
      true,
      false,
    );
    expect(row.fractionElapsed).toBe(elapsed);
    expect(row.shownFraction).toBe(shown);
    expect(row.opacity).toBeCloseTo(0.5);
    motion.step(0.1);
    expect(row.opacity).toBe(1);
    motion.step(0.15);
    expect(row.shownFraction).toBe(0.8);
    expect(motion.active).toBe(false);
  });

  it.each(["model", "mode"] as const)(
    "does not rewrite equal %s row snapshots while their motion is in flight",
    (kind) => {
      const motion = createHistoryRowsMotion(kind);
      motion.setRows([{ key: "high", top: 0, fraction: 0.8 }], true, false);
      motion.step(0.1);
      const row = Object.freeze(motion.rows().get("high")!),
        elapsed = row.fractionElapsed,
        shown = row.shownFraction,
        opacity = row.opacity;
      expect(motion.setRows([{ key: "high", top: 0, fraction: 0.8 }], true, false)).toBe(true);
      expect(motion.rows().get("high")).toBe(row);
      expect(row.fractionElapsed).toBe(elapsed);
      expect(row.shownFraction).toBe(shown);
      expect(row.opacity).toBe(opacity);
      expect(motion.active).toBe(true);
    },
  );

  it("applies reduce-motion and visibility changes even when the row layout is equal", () => {
    const motion = createHistoryRowsMotion("mode"),
      rows = [{ key: "high", top: 0, fraction: 0.8 }];
    motion.setRows(rows, true, false);
    motion.step(0.1);
    const row = motion.rows().get("high")!;
    expect(row.shownFraction).not.toBe(0.8);
    motion.setRows([{ key: "high", top: 0, fraction: 0.8 }], true, true);
    expect(row.shownFraction).toBe(0.8);
    expect(row.opacity).toBeCloseTo(0.5);
    motion.step(0.1);
    expect(motion.active).toBe(false);
    motion.finish(true);
    motion.setRows([{ key: "high", top: 0, fraction: 0.8 }], false, true);
    expect(row.placed).toBe(false);
    motion.setRows([{ key: "high", top: 0, fraction: 0.8 }], true, true);
    expect(row).toMatchObject({ placed: true, offset: 0, opacity: 1, shownFraction: 0.8 });
    expect(motion.active).toBe(false);
  });

  it("crossfades moved reduced-motion rows from .4, snaps bar lengths, and still fades newly inserted rows", () => {
    const motion = createHistoryRowsMotion("mode");
    motion.setRows([{ key: "high", top: 0, fraction: 1 }], true, true);
    motion.finish();
    motion.setRows(
      [
        { key: "ultra", top: 0, fraction: 0.3 },
        { key: "high", top: 30, fraction: 0.7 },
      ],
      true,
      true,
    );
    const high = motion.rows().get("high")!,
      ultra = motion.rows().get("ultra")!;
    expect(high).toMatchObject({ offset: 0, opacity: 0.4, shownFraction: 0.7 });
    expect(ultra).toMatchObject({ offset: 0, opacity: 0, shownFraction: 0.3 });
    motion.step(0.1);
    expect(high.opacity).toBeCloseTo(0.7);
    expect(ultra.opacity).toBeCloseTo(0.5);
    motion.step(0.1);
    expect(motion.active).toBe(false);
  });

  it("uses .45 second CubicEase for models, snapshots an interrupted width, and restarts only an explicit filter rebuild", () => {
    const motion = createHistoryRowsMotion("model"),
      rows = [{ key: "2026-10-30/omp/model-a", top: 0, fraction: 0.8 }];
    motion.setRows(rows, true, false);
    const row = motion.rows().get(rows[0]!.key)!;
    motion.step(0.15);
    expect(row.shownFraction).toBeCloseTo(0.8 * (1 - (2 / 3) ** 3));
    const shown = row.shownFraction;
    motion.setRows([{ ...rows[0]!, fraction: 0.4 }], true, false);
    expect(row.shownFraction).toBe(shown);
    motion.step(0.45);
    expect(row.shownFraction).toBe(0.4);
    motion.setRows([{ ...rows[0]!, fraction: 0.4 }], true, false, true);
    expect(row.shownFraction).toBe(0);
    expect(row.offset).toBe(0);
    expect(row.opacity).toBe(1);
    motion.step(0.45);
    expect(row.shownFraction).toBe(0.4);
    motion.setRows(rows, true, true);
    expect(row.shownFraction).toBe(0.8);
    expect(motion.active).toBe(false);
  });

  it("finishes hidden lists and snaps the next visible layout and new rows without a hidden replay", () => {
    const motion = createHistoryRowsMotion("mode");
    motion.setRows([{ key: "high", top: 0, fraction: 0.8 }], true, false);
    motion.step(0.05);
    motion.finish(true);
    motion.setRows(
      [
        { key: "ultra", top: 0, fraction: 0.5 },
        { key: "high", top: 30, fraction: 0.5 },
      ],
      true,
      false,
    );
    expect(motion.active).toBe(false);
    expect(motion.rows().get("ultra")).toMatchObject({ offset: 0, opacity: 1, shownFraction: 0.5 });
    expect(motion.rows().get("high")).toMatchObject({
      top: 30,
      offset: 0,
      opacity: 1,
      shownFraction: 0.5,
    });
    motion.setRows([{ key: "unknown", top: 0, fraction: 1 }], false, false);
    expect(motion.rows().size).toBe(1);
    motion.setRows([{ key: "unknown", top: 30, fraction: 0.2 }], true, false);
    expect(motion.active).toBe(false);
    expect(motion.rows().get("unknown")).toMatchObject({
      top: 30,
      offset: 0,
      opacity: 1,
      shownFraction: 0.2,
    });
    motion.clear();
    expect(motion.rows().size).toBe(0);
  });
});

describe("owned history RAF lifecycle", () => {
  it("coalesces a single frame, finishes when hidden, ignores a cancelled callback, and never replays on reveal or teardown", () => {
    const queue = new Map<number, (time: number) => void>(),
      chart = createHistoryChartMotion();
    let serial = 0,
      visible = true,
      paints = 0,
      steps = 0,
      finishes = 0;
    const driver = createHistoryMotionDriver({
      requestFrame: (callback) => {
        queue.set(++serial, callback);
        return serial;
      },
      cancelFrame: (id) => {
        queue.delete(id);
      },
      visible: () => visible,
      pending: () => chart.active,
      step: (seconds) => {
        steps++;
        chart.step(seconds);
      },
      paint: () => {
        paints++;
      },
      finish: () => {
        finishes++;
        chart.finish();
      },
    });
    chart.setTarget(frame(), "entrance", false);
    driver.wake();
    driver.wake();
    expect(queue.size).toBe(1);
    const [firstId, first] = queue.entries().next().value!;
    queue.delete(firstId);
    first(100);
    expect(steps).toBe(1);
    expect(queue.size).toBe(1);
    const stale = queue.values().next().value!;
    visible = false;
    driver.finish();
    expect(queue.size).toBe(0);
    expect(chart.active).toBe(false);
    expect(chart.sample().opacity).toBe(1);
    const before = { paints, steps, finishes };
    stale(200);
    expect({ paints, steps, finishes }).toEqual(before);
    visible = true;
    driver.wake();
    expect(queue.size).toBe(0);
    chart.setTarget(frame({ bars: [bar("2026-10-30", 90)] }), "live", false);
    driver.wake();
    expect(queue.size).toBe(1);
    const afterDestroy = queue.values().next().value!;
    driver.destroy();
    expect(queue.size).toBe(0);
    const destroyed = { paints, steps, finishes };
    afterDestroy(300);
    driver.wake();
    driver.destroy();
    expect({ paints, steps, finishes }).toEqual(destroyed);
    expect(queue.size).toBe(0);
  });

  it("cancels the queued frame as soon as a retarget has snapped every animation", () => {
    const queue = new Map<number, (time: number) => void>();
    let pending = true,
      steps = 0,
      paints = 0;
    const driver = createHistoryMotionDriver({
      requestFrame: (callback) => {
        queue.set(1, callback);
        return 1;
      },
      cancelFrame: (id) => {
        queue.delete(id);
      },
      visible: () => true,
      pending: () => pending,
      step: () => {
        steps++;
      },
      paint: () => {
        paints++;
      },
      finish: () => {
        pending = false;
      },
    });
    driver.wake();
    const stale = queue.get(1)!;
    expect(queue.size).toBe(1);
    pending = false;
    driver.wake();
    expect(queue.size).toBe(0);
    stale(100);
    expect(steps).toBe(0);
    expect(paints).toBe(0);
    driver.destroy();
  });
});
