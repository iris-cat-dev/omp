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

async function createHarness(harnessOptions: { start?: boolean } = {}) {
  const jobs = new Map<string, TestJob>();
  const hidden = new Set<string>();
  const acknowledged = new Set<string>();
  const consumed = new Set<string>();
  let sequence = 0;
  let sessionId = "session";
  let currentOwnerId = "parent";
  let snapshotAvailable = true;
  const manager: AsyncJobManager = {
    register(type, label, _run, options: AsyncJobRegisterOptions & { foreground?: boolean } = {}) {
      const startTime = ++sequence;
      const id = options.id ?? `bg_${startTime}`;
      const completion = Promise.withResolvers<void>();
      const finish = completion.resolve;
      const promise = completion.promise;
      jobs.set(id, {
        id,
        type,
        label,
        status: "running",
        startTime,
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
      (job) => job.ownerId === currentOwnerId && !job.foreground && !hidden.has(job.id),
    );
  const context = {
    cwd: "/repo",
    sessionManager: { getSessionId: () => sessionId },
    getAsyncJobSnapshot: () =>
      snapshotAvailable
        ? {
            running: visibleJobs().filter((job) => job.status === "running"),
            recent: visibleJobs()
              .filter((job) => job.status !== "running")
              .slice(-5),
          }
        : null,
  };
  let start!: (event: unknown, ctx: typeof context) => Promise<void>;
  let beforeSwitch!: typeof start;
  let switchSession!: typeof start;
  let beforeBranch!: typeof start;
  let branch!: typeof start;
  let recover!: (args: string, ctx: typeof context) => Promise<void>;
  desktopBackgroundJobs({
    on(event, handler) {
      if (event === "session_start") start = handler as typeof start;
      else if (event === "session_before_switch") beforeSwitch = handler as typeof start;
      else if (event === "session_switch") switchSession = handler as typeof start;
      else if (event === "session_before_branch") beforeBranch = handler as typeof start;
      else if (event === "session_branch") branch = handler as typeof start;
      else shutdown = handler as () => void;
    },
    registerCommand(_name, options) {
      recover = options.handler;
    },
  });
  let port = 0;
  let token = "";
  let generation = 0;
  const frames: Array<{ type: string; generation: number }> = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    const frame = JSON.parse(String(chunk)) as {
      type: string;
      generation: number;
      token: string;
      port: number;
    };
    frames.push(frame);
    if (frame.type === "desktop_background_jobs_ready") {
      token = frame.token;
      port = frame.port;
      generation = frame.generation;
    }
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
  const add = (
    type: string,
    label: string,
    ownerId = "parent",
    foreground = false,
    preferredId?: string,
  ) => {
    const options = { ownerId, foreground, id: preferredId };
    const id = manager.register(type, label, undefined, options);
    return jobs.get(id)!;
  };
  const complete = async (job: TestJob, result: string) => {
    job.status = "completed";
    job.resultText = result;
    job.finish();
    await job.promise;
  };
  if (harnessOptions.start !== false) await start(undefined, context);
  return {
    jobs,
    hidden,
    acknowledged,
    consumed,
    add,
    complete,
    request,
    list,
    output,
    frames,
    endpoint: () => ({ port, token, generation }),
    recover: () => recover("", context),
    beforeSwitch: (reason = "resume") => beforeSwitch({ reason }, context),
    beforeBranch: (reason = "branch") => beforeBranch({ reason }, context),
    setIdentity: (nextId: string, nextOwner = currentOwnerId) => {
      sessionId = nextId;
      currentOwnerId = nextOwner;
    },
    emitSwitch: (reason = "resume") => switchSession({ reason }, context),
    emitBranch: (reason = "branch") => branch({ reason }, context),
    switchSession: async (nextId: string, nextOwner = currentOwnerId, reason = "resume") => {
      sessionId = nextId;
      currentOwnerId = nextOwner;
      await switchSession({ reason }, context);
    },
    setSnapshotAvailable: (available: boolean) => {
      snapshotAvailable = available;
    },
    start: () => start(undefined, context),
  };
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

  test("rebinds a live bridge without losing owned active jobs, IDs or retained output", async () => {
    const h = await createHarness();
    const active = h.add("eval", "keep calculation alive");
    const completed = h.add("bash", "finished output");
    await h.complete(completed, "saved result");
    const before = await h.list();
    const completedRow = before.find((row) => row.name === "finished output")!;
    const output = await h.output(completedRow.id);
    const old = h.endpoint();
    await h.recover();
    expect(h.endpoint().generation).toBeGreaterThan(old.generation);
    expect(h.endpoint().token).not.toBe(old.token);
    expect(await h.list()).toEqual(before);
    expect(await h.output(completedRow.id)).toEqual(output);
    expect(active.abortController.signal.aborted).toBe(false);
    await expect(
      fetch(`http://127.0.0.1:${old.port}/list`, {
        headers: { authorization: `Bearer ${old.token}` },
      }),
    ).rejects.toThrow();
  });

  test("invalidates on shutdown, refuses recovery of a stopped session, and starts a new generation", async () => {
    const h = await createHarness();
    const old = h.endpoint();
    shutdown!();
    expect(h.frames.at(-1)).toEqual({
      type: "desktop_background_jobs_invalidated",
      generation: old.generation,
    });
    await expect(h.recover()).rejects.toThrow("session is unavailable");
    await expect(h.request("/list")).rejects.toThrow();
    await h.start();
    expect(h.endpoint().generation).toBeGreaterThan(old.generation);
    expect(await h.list()).toEqual([]);
  });

  test("does not publish a queued startup after session shutdown supersedes it", async () => {
    const h = await createHarness({ start: false });
    const starting = h.start();
    shutdown!();
    await expect(starting).rejects.toThrow("superseded");
    expect(h.frames.filter((frame) => frame.type === "desktop_background_jobs_ready")).toEqual([]);
    await expect(h.recover()).rejects.toThrow("session is unavailable");
    await h.start();
    expect(await h.list()).toEqual([]);
  });

  test("does not report an unavailable native ownership snapshot as a known-empty session", async () => {
    const h = await createHarness();
    h.setSnapshotAvailable(false);
    const active = h.add("eval", "registered while inventory unavailable");
    expect((await h.request("/list")).status).toBe(503);
    await h.recover();
    expect((await h.request("/list")).status).toBe(503);
    h.setSnapshotAvailable(true);
    expect((await h.list()).map((row) => row.name)).toEqual([active.label]);
    expect(active.abortController.signal.aborted).toBe(false);
  });

  test("keeps credentials and owned work on a failed switch, and isolates a committed switch", async () => {
    const h = await createHarness();
    const oldJob = h.add("eval", "departing work");
    const [oldRow] = await h.list();
    const oldEndpoint = h.endpoint();
    await h.beforeSwitch();
    // A failed/cancelled SDK switch emits no session_switch.
    expect(h.endpoint()).toEqual(oldEndpoint);
    expect((await h.list())[0]!.id).toBe(oldRow!.id);
    expect(oldJob.abortController.signal.aborted).toBe(false);
    await h.complete(oldJob, "outgoing result");
    await h.switchSession("resumed-session");
    const incoming = h.add("eval", "incoming work");
    expect((await h.list()).map((row) => row.name)).toEqual(["incoming work"]);
    expect((await h.request(`/output?id=${encodeURIComponent(oldRow!.id)}`)).status).toBe(404);
    await h.request("/stop-all", "POST");
    expect(incoming.abortController.signal.aborted).toBe(true);
    expect(oldJob.abortController.signal.aborted).toBe(false);
  });

  test("preserves inherited fork jobs and refuses to hide unresolved outgoing jobs", async () => {
    const h = await createHarness();
    const active = h.add("eval", "inherited work");
    const [row] = await h.list();
    await h.beforeSwitch();
    await h.switchSession("forked-session", "parent", "fork");
    expect((await h.list())[0]!.id).toBe(row!.id);
    await h.beforeSwitch();
    await h.switchSession("other-session", "other-owner");
    expect((await h.request("/list")).status).toBe(503);
    expect(active.abortController.signal.aborted).toBe(false);
    await h.complete(active, "settled outgoing work");
    expect(await h.list()).toEqual([]);
  });

  test("never prunes an unknown owned job when completed-job retention fills up", async () => {
    const h = await createHarness();
    const missing = h.add("eval", "unknown calculation");
    const [row] = await h.list();
    h.jobs.delete(missing.id);
    for (let index = 0; index < 105; index++) {
      await h.complete(h.add("eval", `finished ${index}`), `result ${index}`);
    }
    expect(await h.list()).toContainEqual(
      expect.objectContaining({
        id: row!.id,
        status: "unknown",
      }),
    );
  });

  test("attributes jobs from an earlier switch hook to the incoming native identity", async () => {
    const h = await createHarness();
    const outgoing = h.add("eval", "outgoing calculation");
    const child = h.add("eval", "child calculation", "child");
    await h.beforeSwitch();
    await h.complete(outgoing, "outgoing result");
    h.setIdentity("incoming-session");
    // The SDK invokes an earlier extension's hook before this helper's hook.
    const incoming = h.add("eval", "incoming calculation");
    await h.emitSwitch();
    const rows = await h.list();
    expect(rows.map((row) => row.name)).toEqual(["incoming calculation"]);
    expect((await h.request(`/stop?id=${encodeURIComponent(rows[0]!.id)}`, "POST")).status).toBe(
      200,
    );
    expect(incoming.abortController.signal.aborted).toBe(true);
    expect(child.abortController.signal.aborted).toBe(false);
    expect(h.acknowledged).toEqual(new Set([incoming.id]));
  });

  test("lists a fresh registration that reuses an evicted outgoing job's preferred ID", async () => {
    const h = await createHarness();
    const outgoing = h.add("eval", "original registration");
    await h.complete(outgoing, "original output");
    const [oldRow] = await h.list();
    const oldOutput = await h.output(oldRow!.id);
    h.jobs.delete(outgoing.id);
    await h.beforeSwitch();
    h.setIdentity("incoming-session");
    const incoming = h.add("eval", "reused ID registration", "parent", false, outgoing.id);
    await h.emitSwitch();
    const [newRow] = await h.list();
    expect(newRow).toMatchObject({ name: "reused ID registration", status: "running" });
    expect(newRow!.id).not.toBe(oldRow!.id);
    expect((await h.request(`/stop?id=${encodeURIComponent(oldRow!.id)}`, "POST")).status).toBe(
      404,
    );
    expect(incoming.abortController.signal.aborted).toBe(false);
    await h.request(`/stop?id=${encodeURIComponent(newRow!.id)}`, "POST");
    expect(incoming.abortController.signal.aborted).toBe(true);
    // A late rollback must recover the original instance, not the reused ID's
    // cancellation/output, even after inventory ran against the target scope.
    h.setIdentity("session");
    await h.recover();
    expect((await h.list())[0]).toMatchObject({ id: oldRow!.id, status: "exited" });
    expect(await h.output(oldRow!.id)).toEqual(oldOutput);
  });

  test("keeps an evicted unknown instance distinct from a reused live ID in the same session", async () => {
    const h = await createHarness();
    const missing = h.add("eval", "unknown original instance");
    const [oldRow] = await h.list();
    h.jobs.delete(missing.id);
    const replacement = h.add("eval", "live replacement instance", "parent", false, missing.id);
    const rows = await h.list();
    expect(rows).toContainEqual(expect.objectContaining({ id: oldRow!.id, status: "unknown" }));
    const live = rows.find((row) => row.name === "live replacement instance")!;
    expect(live.id).not.toBe(oldRow!.id);
    expect(
      await (await h.request(`/stop?id=${encodeURIComponent(oldRow!.id)}`, "POST")).json(),
    ).toEqual({ stopped: false });
    expect(replacement.abortController.signal.aborted).toBe(false);
    await h.complete(missing, "late original completion");
    expect(await h.output(oldRow!.id)).toMatchObject({ text: "late original completion" });
    expect((await h.list()).find((row) => row.id === live.id)).toMatchObject({ status: "running" });
    await h.request(`/stop?id=${encodeURIComponent(live.id)}`, "POST");
    expect(replacement.abortController.signal.aborted).toBe(true);
    expect(missing.abortController.signal.aborted).toBe(false);
  });

  test("restores IDs, retained output and cursors after a switch event is followed by native rollback", async () => {
    const h = await createHarness();
    const outgoing = h.add("eval", "original work");
    await h.complete(outgoing, "retained before failed switch");
    const [row] = await h.list();
    const output = await h.output(row!.id);
    await h.beforeSwitch();
    await h.switchSession("tentative-target");
    expect(await h.list()).toEqual([]);
    // resetContextForNewTranscript may fail after session_switch; the SDK
    // restores its actual identity without emitting another lifecycle event.
    h.setIdentity("session");
    await expect(h.request("/list")).rejects.toThrow();
    await h.recover();
    expect((await h.list())[0]!.id).toBe(row!.id);
    expect(await h.output(row!.id)).toEqual(output);
    expect(await h.output(row!.id, output.cursor)).toMatchObject({ text: "", reset: false });
  });

  test.each(["branch", "fork"])(
    "keeps %s identity inheritance across an earlier hook and same-session reload",
    async (reason) => {
      const h = await createHarness();
      const original = h.add("eval", "ancestry output");
      await h.complete(original, "retained ancestry result");
      const [oldRow] = await h.list();
      const output = await h.output(oldRow!.id);
      await h.beforeBranch(reason);
      h.setIdentity("branched-session");
      const active = h.add("eval", "work started by earlier branch hook");
      await h.emitBranch(reason);
      const beforeReload = await h.list();
      expect(beforeReload.map((row) => row.name)).toEqual([
        "ancestry output",
        "work started by earlier branch hook",
      ]);
      await h.beforeSwitch();
      await h.switchSession("branched-session");
      expect(await h.list()).toEqual(beforeReload);
      expect(await h.output(oldRow!.id)).toEqual(output);
      expect(active.abortController.signal.aborted).toBe(false);
      expect(await (await h.request("/stop-all", "POST")).json()).toEqual({ stopped: 1 });
      expect(active.abortController.signal.aborted).toBe(true);
    },
  );

  test("inherits a native no-entry fork before this helper's switch hook receives the event", async () => {
    const h = await createHarness();
    const original = h.add("eval", "inherited active calculation");
    const [originalRow] = await h.list();
    await h.beforeSwitch("fork");
    h.setIdentity("fork-target");
    const added = h.add("eval", "started by earlier fork hook");
    await h.emitSwitch("fork");
    const rows = await h.list();
    expect(rows.map((row) => row.name)).toEqual([
      "inherited active calculation",
      "started by earlier fork hook",
    ]);
    expect(rows[0]!.id).toBe(originalRow!.id);
    expect(original.abortController.signal.aborted).toBe(false);
    expect(added.abortController.signal.aborted).toBe(false);
    expect(await (await h.request("/stop-all", "POST")).json()).toEqual({ stopped: 2 });
  });
});
