import { describe, expect, it } from "vitest";
import { OmpProcessSampler } from "./resources.js";

describe("OMP process resources", () => {
  it("measures logical-capacity CPU deltas and sums process memory, without inventing a first-sample CPU value", async () => {
    let now = 1_000;
    let cpu = 0;
    const sampler = new OmpProcessSampler({
      now: () => now,
      logicalCpus: 4,
      probe: async () => ({
        processes: [
          {
            pid: 7,
            identity: "start-a",
            cpuMs: cpu,
            workingSetBytes: 1_048_576,
            privateBytes: 524_288,
          },
          {
            pid: 8,
            identity: "start-b",
            cpuMs: cpu / 2,
            workingSetBytes: 2_097_152,
            privateBytes: 1_048_576,
          },
        ],
        unreadable: 0,
        limited: false,
      }),
    });
    expect(await sampler.sample()).toMatchObject({
      status: "available",
      processCount: 2,
      cpuPercent: null,
      workingSetBytes: 3_145_728,
      privateBytes: 1_572_864,
    });
    now = 2_000;
    cpu = 1_000;
    expect(await sampler.sample()).toMatchObject({ cpuPercent: 37.5, sampledAt: 2_000 });
    now = 3_000;
    expect(await sampler.sample()).toMatchObject({ cpuPercent: 0 });
    sampler.dispose();
  });

  it("does not attribute a reused PID's cumulative CPU to the previous process", async () => {
    let now = 1_000;
    let identity = "original";
    const sampler = new OmpProcessSampler({
      now: () => now,
      logicalCpus: 2,
      probe: async () => ({
        processes: [
          {
            pid: 7,
            identity,
            cpuMs: identity === "original" ? 100 : 8_000,
            workingSetBytes: 100,
            privateBytes: null,
          },
        ],
        unreadable: 0,
        limited: false,
      }),
    });
    await sampler.sample();
    now = 2_000;
    identity = "replacement";
    expect(await sampler.sample()).toMatchObject({
      cpuPercent: null,
      privateBytes: null,
      workingSetBytes: 100,
    });
    sampler.dispose();
  });

  it("keeps no processes, unreadable processes and partial samples distinct", async () => {
    let step = 0;
    const sampler = new OmpProcessSampler({
      probe: async () => {
        step++;
        if (step === 1) return { processes: [], unreadable: 0, limited: false };
        if (step === 2) return { processes: [], unreadable: 1, limited: false };
        return {
          processes: [
            { pid: 9, identity: "child", cpuMs: 0, workingSetBytes: 100, privateBytes: 80 },
          ],
          unreadable: 1,
          limited: false,
        };
      },
    });
    expect(await sampler.sample()).toMatchObject({
      status: "unavailable",
      reason: "no_processes",
      cpuPercent: null,
      workingSetBytes: null,
    });
    expect(await sampler.sample()).toMatchObject({
      status: "unavailable",
      reason: "unreadable",
      workingSetBytes: null,
    });
    expect(await sampler.sample()).toMatchObject({
      status: "partial",
      reason: "unreadable",
      processCount: 1,
      workingSetBytes: 100,
    });
    sampler.dispose();
  });
});
