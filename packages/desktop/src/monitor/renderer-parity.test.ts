import { describe, expect, it } from "vitest";
import {
  createTitleDraftCloseLock,
  dashboardSpringStep,
  effectsPreviewValue,
  historyModeBuckets,
  historyModelBuckets,
  nativeSpeedText,
} from "./renderer";
import type { OmpMonitorModeBreakdown, OmpMonitorModelBreakdown } from "./types";

function mode(patch: Partial<OmpMonitorModeBreakdown> = {}): OmpMonitorModeBreakdown {
  return {
    date: "2026-10-30",
    source: "omp",
    model: "model-a",
    kind: "effort",
    value: "high",
    evidence: "recorded",
    provider: null,
    requests: 1,
    outputTokens: 100,
    measuredOutputTokens: 100,
    measuredDurationMs: 1000,
    ...patch,
  };
}
function model(patch: Partial<OmpMonitorModelBreakdown> = {}): OmpMonitorModelBreakdown {
  return {
    date: "2026-10-30",
    source: "omp",
    model: "model-a",
    requests: 1,
    outputTokens: 100,
    measuredOutputTokens: 100,
    measuredDurationMs: 1000,
    costUsd: 1,
    unpricedRequests: 0,
    estimatedCostUsd: 2,
    unestimatedRequests: 0,
    ...patch,
  };
}

describe("Windows v1.6.1 display facts", () => {
  it("pools real historical attribution dimensions and measured timing without consulting live agents", () => {
    const rows = historyModeBuckets(
      [
        mode(),
        mode({
          date: "2026-10-31",
          model: "model-b",
          provider: "native-provider",
          evidence: "selected",
          requests: 2,
          outputTokens: 900,
          measuredOutputTokens: 900,
          measuredDurationMs: 3000,
        }),
        mode({
          value: null,
          evidence: null,
          model: null,
          outputTokens: 200,
          measuredOutputTokens: 0,
          measuredDurationMs: 0,
        }),
        mode({ date: "2026-10-29", outputTokens: 99999 }),
        mode({ kind: "speed", value: "fast", outputTokens: 99999 }),
      ],
      "effort",
      "2026-10-30",
      "2026-10-31",
    );
    expect(rows.map((row) => row.value)).toEqual(["high", "unknown"]);
    expect(rows[0]).toMatchObject({
      requests: 3,
      outputTokens: 1000,
      measuredOutputTokens: 1000,
      measuredDurationMs: 4000,
      share: 1000 / 1200,
    });
    expect((rows[0]!.measuredOutputTokens * 1000) / rows[0]!.measuredDurationMs).toBe(250);
    expect(rows[0]!.topModels).toEqual([
      { model: "model-b", share: 0.9 },
      { model: "model-a", share: 0.1 },
    ]);
    expect(rows[1]!.share).toBe(200 / 1200);
  });

  it("keeps original ranked modes, ordinal unsupported words, unknown last, and only three top models", () => {
    const inputs = ["off", "custom", "max", "ultra", "ultracode", null].map((value) =>
      mode({ value }),
    );
    inputs.push(
      ...["b", "c", "d", "e"].map((name, index) =>
        mode({ value: "max", model: name, outputTokens: 200 + index }),
      ),
    );
    const rows = historyModeBuckets(inputs, "effort", "2026-10-30", "2026-10-31");
    expect(rows.map((row) => row.value)).toEqual([
      "ultracode",
      "ultra",
      "max",
      "off",
      "custom",
      "unknown",
    ]);
    expect(rows.find((row) => row.value === "max")!.topModels.map((value) => value.model)).toEqual([
      "e",
      "d",
      "c",
    ]);
    expect(historyModeBuckets([], "speed", "2026-10-30", "2026-10-31")).toEqual([
      {
        value: "unknown",
        requests: 0,
        outputTokens: 0,
        measuredOutputTokens: 0,
        measuredDurationMs: 0,
        share: 0,
        topModels: [],
      },
    ]);
  });

  it("builds a genuine model day comparison, keeping unknown attribution last and independent cost channels", () => {
    const inputs = [
      model(),
      model({ costUsd: 4, estimatedCostUsd: 8, measuredDurationMs: 3000 }),
      model({ model: "model-b", outputTokens: 1000, costUsd: 1, estimatedCostUsd: 40 }),
      model({ model: null, outputTokens: 5000, costUsd: 100 }),
      model({ date: "2026-10-29", outputTokens: 99999 }),
    ];
    const output = historyModelBuckets(inputs, "2026-10-30", "output");
    expect(output.map((row) => row.model)).toEqual(["model-b", "model-a", null]);
    expect(output[1]).toMatchObject({
      requests: 2,
      measuredOutputTokens: 200,
      measuredDurationMs: 4000,
      costUsd: 5,
      estimatedCostUsd: 10,
    });
    expect(historyModelBuckets(inputs, "2026-10-30", "recorded").map((row) => row.model)).toEqual([
      "model-a",
      "model-b",
      null,
    ]);
    expect(historyModelBuckets(inputs, "2026-10-30", "catalog").map((row) => row.model)).toEqual([
      "model-b",
      "model-a",
      null,
    ]);
    expect(output.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1);
    expect(inputs[0]!.requests).toBe(1);
  });

  it.each([
    [null, "—"],
    [0, "0"],
    [7, "7.0"],
    [9.95, "10"],
    [40, "40"],
    [999.7, "1.00k"],
    [1400, "1.40k"],
    [96000, "96.0k"],
    [999700, "1.00M"],
    [2360000, "2.36M"],
  ] as const)("preserves the native three-significant-digit carry at %s", (value, expected) => {
    expect(nativeSpeedText(value)).toBe(expected);
  });

  it("uses the original separate 20-second effects curve without mutating telemetry", () => {
    expect(effectsPreviewValue(0, 2000)).toBe(0);
    expect(effectsPreviewValue(1, 2000)).toBe(0);
    expect(effectsPreviewValue(13.6, 2000)).toBeGreaterThan(2000);
    expect(effectsPreviewValue(13.6, 2000000)).toBeCloseTo(effectsPreviewValue(13.6, 2000) * 1000);
    expect(effectsPreviewValue(20, 2000)).toBe(0);
    expect(effectsPreviewValue(30, 2000)).toBe(0);
  });

  it("retains native disclosure velocity on retarget and caps a long frame step", () => {
    const first = dashboardSpringStep(0, 0, 264, 1 / 60);
    const retargeted = dashboardSpringStep(first.value, first.velocity, 80, 1 / 60);
    expect(first.value).toBeGreaterThan(0);
    expect(retargeted.velocity).toBeGreaterThan(0);
    expect(retargeted.value).toBeGreaterThan(first.value);
    expect(dashboardSpringStep(0, 0, 264, 10)).toEqual(dashboardSpringStep(0, 0, 264, 1 / 30));
    let state = first;
    for (let frame = 0; frame < 120; frame++)
      state = dashboardSpringStep(state.value, state.velocity, 264, 1 / 60);
    expect(state).toEqual({ value: 264, velocity: 0 });
  });
});

describe("native close title draft input lock", () => {
  it("locks synchronously, coalesces the real flush, and stays locked after successful acknowledgement", async () => {
    const surface = { inert: false };
    let calls = 0;
    let resolveFlush!: () => void;
    const lock = createTitleDraftCloseLock(surface, () => {
      expect(surface.inert).toBe(true);
      calls++;
      return new Promise<void>((resolve) => {
        resolveFlush = resolve;
      });
    });
    const pending = lock.flush();
    expect(surface.inert).toBe(true);
    expect(lock.flush()).toBe(pending);
    await Promise.resolve();
    expect(calls).toBe(1);
    resolveFlush();
    await pending;
    expect(surface.inert).toBe(true);
    expect(lock.flush()).toBe(pending);
    expect(calls).toBe(1);
    lock.release();
    expect(surface.inert).toBe(false);
    lock.release();
    expect(surface.inert).toBe(false);
  });

  it.each([false, true])(
    "restores the exact prior inert state %s on explicit close-failure recovery",
    async (prior) => {
      const surface = { inert: prior };
      const lock = createTitleDraftCloseLock(surface, () => Promise.resolve());
      await lock.flush();
      expect(surface.inert).toBe(true);
      lock.release();
      expect(surface.inert).toBe(prior);
    },
  );

  it.each([false, true])(
    "restores the exact prior inert state %s on a rejected real flush and permits retry",
    async (prior) => {
      const surface = { inert: prior };
      const failure = new Error("real title save failed");
      let calls = 0;
      const lock = createTitleDraftCloseLock(surface, () =>
        ++calls === 1 ? Promise.reject(failure) : Promise.resolve(),
      );
      const failed = lock.flush();
      expect(surface.inert).toBe(true);
      await expect(failed).rejects.toBe(failure);
      expect(surface.inert).toBe(prior);
      await lock.flush();
      expect(calls).toBe(2);
      expect(surface.inert).toBe(true);
      lock.release();
      expect(surface.inert).toBe(prior);
    },
  );

  it("unlocks on a synchronous real flush error without swallowing the error", async () => {
    const surface = { inert: false };
    const failure = new Error("title flush threw");
    const lock = createTitleDraftCloseLock(surface, () => {
      throw failure;
    });
    const pending = lock.flush();
    expect(surface.inert).toBe(true);
    await expect(pending).rejects.toBe(failure);
    expect(surface.inert).toBe(false);
  });

  it("does not let a released stale flush failure unlock a newer native-close request", async () => {
    const surface = { inert: false };
    const failure = new Error("earlier flush failed");
    let calls = 0;
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: () => void;
    const lock = createTitleDraftCloseLock(surface, () =>
      ++calls === 1
        ? new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          })
        : new Promise<void>((resolve) => {
            resolveSecond = resolve;
          }),
    );
    const first = lock.flush();
    await Promise.resolve();
    lock.release();
    expect(surface.inert).toBe(false);
    const second = lock.flush();
    expect(second).not.toBe(first);
    await Promise.resolve();
    const rejected = expect(first).rejects.toBe(failure);
    rejectFirst(failure);
    await rejected;
    expect(surface.inert).toBe(true);
    expect(lock.flush()).toBe(second);
    resolveSecond();
    await second;
    expect(surface.inert).toBe(true);
    lock.release();
    expect(surface.inert).toBe(false);
  });
});
