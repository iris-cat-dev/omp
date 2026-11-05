import type { BackgroundProcess } from "@omp-desktop/protocol/background-processes";
import type { RuntimeResource } from "@omp-desktop/protocol/runtime-resources";
import pino from "pino";
import { describe, expect, test } from "vitest";
import { OmpAgentSession } from "./agent.js";
import { FakeOmp } from "./test-utils/fake-omp.js";

const kernel: RuntimeResource = {
  id: "eval:javascript",
  kind: "javascript_kernel",
  ownerSessionId: "session",
  state: "retained",
  retentionReasons: ["variables"],
  liveHandles: 0,
  releasable: true,
};

async function resourceSession(status: "running" | "unknown") {
  const runtime = await new FakeOmp().startSession({ cwd: "/repo" });
  const jobs: BackgroundProcess[] = [
    {
      id: "omp-job:owner:bg_1",
      name: "evaluation",
      command: "evaluation",
      cwd: "/repo",
      ownerAgentId: null,
      scope: "agent",
      source: "omp-job",
      status,
      startedAt: 1,
      endedAt: null,
      exitCode: null,
      terminalId: null,
    },
  ];
  const released: string[] = [];
  let inventoryError: Error | undefined;
  Object.assign(runtime, {
    getRuntimeResources: async () => [structuredClone(kernel)],
    listBackgroundJobs: async () => {
      if (inventoryError) throw inventoryError;
      return jobs;
    },
    releaseRuntimeResource: async (id: string) => {
      released.push(id);
    },
  });
  const session = new OmpAgentSession({
    runtimeSession: runtime,
    initialState: runtime.state,
    config: { provider: "omp", cwd: "/repo" },
    logger: pino({ level: "silent" }),
  });
  return {
    session,
    jobs,
    released,
    failInventory: () => {
      inventoryError = new Error("bridge ownership unavailable");
    },
  };
}

describe("OMP kernel background dependencies", () => {
  test.each(["running", "unknown"] as const)(
    "protects a native kernel while an owned background job is %s",
    async (status) => {
      const h = await resourceSession(status);
      try {
        expect(await h.session.getRuntimeResources()).toEqual([
          {
            ...kernel,
            releasable: false,
            retentionReasons: ["variables", "background_dependency"],
          },
        ]);
        await expect(h.session.releaseRuntimeResource(kernel.id)).rejects.toThrow(
          "live background dependencies",
        );
        expect(h.released).toEqual([]);
        h.jobs.length = 0;
        expect(await h.session.getRuntimeResources()).toEqual([kernel]);
        await h.session.releaseRuntimeResource(kernel.id);
        expect(h.released).toEqual([kernel.id]);
      } finally {
        await h.session.close();
      }
    },
  );

  test("does not release native resources when bridge ownership cannot be read", async () => {
    const h = await resourceSession("running");
    h.failInventory();
    try {
      await expect(h.session.getRuntimeResources()).rejects.toThrow("ownership unavailable");
      await expect(h.session.releaseRuntimeResource(kernel.id)).rejects.toThrow(
        "ownership unavailable",
      );
      expect(h.released).toEqual([]);
    } finally {
      await h.session.close();
    }
  });
});
