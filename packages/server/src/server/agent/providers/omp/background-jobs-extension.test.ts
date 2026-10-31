import type {
  AsyncJob,
  AsyncJobManager,
  AsyncJobRegisterOptions,
} from "@oh-my-pi/pi-coding-agent/async";
import type {
  BackgroundProcess,
  BackgroundProcessOutput,
} from "@omp-desktop/protocol/background-processes";
import { afterEach, describe, expect, test, vi } from "vitest";
import desktopBackgroundJobs from "./background-jobs-extension.js";

const native = vi.hoisted(() => ({ instance: vi.fn() }));
vi.mock("@oh-my-pi/pi-coding-agent/async", () => ({
  AsyncJobManager: { instance: native.instance },
}));

type TestJob = AsyncJob & { foreground: boolean; finish(): void };
let shutdown: (() => void) | undefined;

afterEach(() => {
  shutdown?.();
  shutdown = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function createHarness() {
  const jobs = new Map<string, TestJob>();
  const hidden = new Set<string>();
  const acknowledged = new Set<string>();
  const consumed = new Set<string>();
  let sequence = 0;
  const manager: AsyncJobManager = {
    register(type, label, _run, options: AsyncJobRegisterOptions & { foreground?: boolean } = {}) {
      const id = `bg_${++sequence}`;
      const completion = Promise.withResolvers<void>();
      const finish = completion.resolve;
      const promise = completion.promise;
      jobs.set(id, {
        id,
        type,
        label,
        status: "running",
        startTime: sequence,
        ownerId: options.ownerId,
        foreground: options.foreground === true,
        promise,
        finish,
        abortController: new AbortController(),
      });
      return id;
    },
    getJob: (id) => jobs.get(id),
    cancel(id) {
      const job = jobs.get(id);
      if (!job || job.status !== "running") return false;
      job.status = "cancelled";
      job.abortController.abort();
      job.finish();
      return true;
    },
    acknowledgeDeliveries(ids) {
      for (const id of ids) acknowledged.add(id);
      return ids.length;
    },
    consumeJobResults(ids) {
      for (const id of ids) consumed.add(id);
      return ids.length;
    },
  };
  native.instance.mockReturnValue(manager);
  const visibleJobs = () =>
    [...jobs.values()].filter(
      (job) => job.ownerId === "parent" && !job.foreground && !hidden.has(job.id),
    );
  const context = {
    cwd: "/repo",
    sessionManager: { getSessionId: () => "session" },
    getAsyncJobSnapshot: () => ({
      running: visibleJobs().filter((job) => job.status === "running"),
      recent: visibleJobs()
        .filter((job) => job.status !== "running")
        .slice(-5),
    }),
  };
  let start!: (event: unknown, ctx: typeof context) => Promise<void>;
  desktopBackgroundJobs({
    on(event, handler) {
      if (event === "session_start") start = handler as typeof start;
      else shutdown = handler as () => void;
    },
  });
  let port = 0;
  let token = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    const ready = JSON.parse(String(chunk)) as { token: string; port: number };
    token = ready.token;
    port = ready.port;
    return true;
  });
  const request = (path: string, method = "GET", authorization = `Bearer ${token}`) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: authorization ? { authorization } : {},
    });
  const list = async (): Promise<BackgroundProcess[]> =>
    (await (await request("/list")).json()).processes;
  const output = async (id: string, cursor?: number): Promise<BackgroundProcessOutput> => {
    const query = new URLSearchParams({ id });
    if (cursor !== undefined) query.set("cursor", String(cursor));
    return (await request(`/output?${query}`)).json();
  };
  const add = (type: string, label: string, ownerId = "parent", foreground = false) => {
    const options = { ownerId, foreground };
    const id = manager.register(type, label, undefined, options);
    return jobs.get(id)!;
  };
  const complete = async (job: TestJob, result: string) => {
    job.status = "completed";
    job.resultText = result;
    job.finish();
    await job.promise;
  };
  await start(undefined, context);
  return { jobs, hidden, acknowledged, consumed, add, complete, request, list, output };
}

describe("OMP background job bridge", () => {
  test("rejects missing or incorrect credentials over the real Node HTTP bridge", async () => {
    const h = await createHarness();
    expect((await h.request("/list", "GET", "")).status).toBe(401);
    expect((await h.request("/list", "GET", "Bearer wrong")).status).toBe(401);
  });
  test("lists all session-owned job types without exposing or stopping a child agent's jobs", async () => {
    const h = await createHarness();
    h.add("bash", "shell build");
    h.add("eval", "data analysis");
    h.add("plugin-worker", "plugin indexing");
    const child = h.add("eval", "child analysis", "child");
    const rows = await h.list();
    expect(rows.map((row) => row.name)).toEqual([
      "shell build",
      "data analysis",
      "plugin indexing",
    ]);
    expect(rows.every((row) => row.status === "running" && row.source === "omp-job")).toBe(true);
    const childId = rows[0]!.id.replace(/bg_\d+$/, child.id);
    expect((await h.request(`/output?id=${encodeURIComponent(childId)}`)).status).toBe(404);
    expect((await h.request(`/stop?id=${encodeURIComponent(childId)}`, "POST")).status).toBe(404);
    expect(child.abortController.signal.aborted).toBe(false);
    expect(h.acknowledged).toEqual(new Set());
    expect(h.consumed).toEqual(new Set());
  });

  test("captures native progress when a foreground job becomes a background job", async () => {
    const h = await createHarness();
    const job = h.add("eval", "long calculation", "parent", true);
    job.progressText = "foreground progress";
    expect(await h.list()).toEqual([]);
    job.foreground = false;
    job.progressText = "background phase one";
    const [row] = await h.list();
    const first = await h.output(row!.id);
    expect(first).toMatchObject({ text: "background phase one", reset: true });
    job.progressText = "background phase two";
    const second = await h.output(row!.id, first.cursor);
    expect(second).toMatchObject({ text: "background phase two", reset: true });
    expect(second.cursor).toBeGreaterThan(first.cursor);
    expect(await h.output(row!.id, second.cursor)).toMatchObject({ text: "", reset: false });
    await h.complete(job, "final calculation result");
    expect(await h.output(row!.id, second.cursor)).toMatchObject({
      text: "final calculation result",
      reset: true,
    });
    expect((await h.list())[0]).toMatchObject({ status: "exited", exitCode: 0 });
  });

  test("retains non-bash completion output after the native snapshot and job are evicted", async () => {
    const h = await createHarness();
    const job = h.add("eval", "quick calculation");
    const [row] = await h.list();
    h.hidden.add(job.id);
    await h.complete(job, "retained calculation result");
    h.jobs.delete(job.id);
    expect((await h.list())[0]).toMatchObject({ id: row!.id, status: "exited", exitCode: 0 });
    expect(await h.output(row!.id)).toMatchObject({
      text: "retained calculation result",
      reset: true,
    });
    expect(h.acknowledged).toEqual(new Set());
    expect(h.consumed).toEqual(new Set());
  });

  test("stops all owned job types without cancelling other agents' running work", async () => {
    const h = await createHarness();
    const bash = h.add("bash", "shell build");
    const evaluation = h.add("eval", "data analysis");
    const child = h.add("eval", "child analysis", "child");
    const response = await h.request("/stop-all", "POST");
    expect(await response.json()).toEqual({ stopped: 2 });
    expect((await h.list()).map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
    expect(bash.abortController.signal.aborted).toBe(true);
    expect(evaluation.abortController.signal.aborted).toBe(true);
    expect(child.status).toBe("running");
    expect(child.abortController.signal.aborted).toBe(false);
    expect(h.acknowledged).toEqual(new Set([bash.id, evaluation.id]));
    expect(h.consumed).toEqual(new Set([bash.id, evaluation.id]));
  });
});
