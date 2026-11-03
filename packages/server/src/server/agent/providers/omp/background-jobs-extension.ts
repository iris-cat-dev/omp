import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import type {
  BackgroundProcess,
  BackgroundProcessOutput,
} from "@omp-desktop/protocol/background-processes";

interface ExtensionContext {
  cwd: string;
  getAsyncJobSnapshot(): { running: AsyncJob[]; recent: AsyncJob[] } | null;
  sessionManager: { getSessionId(): string };
}
interface ExtensionApi {
  on(
    event: "session_start",
    handler: (event: unknown, context: ExtensionContext) => Promise<void>,
  ): void;
  on(event: "session_shutdown", handler: () => void): void;
}
interface OutputRecord {
  text: string;
  cursor: number;
  truncated: boolean;
}
const MAX_OUTPUT_CHARS = 128 * 1024;
const MAX_RETAINED_JOBS = 100;

interface JobBridgeState {
  context: ExtensionContext;
  manager: AsyncJobManager;
  processPrefix: string;
  outputs: Map<string, OutputRecord>;
  retained: Map<string, BackgroundProcess>;
  rememberOutput(id: string, text: string): void;
}

function jobStatus(job: AsyncJob): BackgroundProcess["status"] {
  return job.status === "completed" ? "exited" : job.status;
}

function jobExitCode(job: AsyncJob): number | null {
  if (job.latestDetails?.exitCode !== undefined) return job.latestDetails.exitCode;
  return job.status === "completed" ? 0 : null;
}

function retainJob(state: JobBridgeState, row: AsyncJob): void {
  const job = state.manager.getJob(row.id) ?? row;
  const previous = state.retained.get(job.id);
  state.retained.set(job.id, {
    id: `${state.processPrefix}${job.id}`,
    name: job.label,
    command: job.label,
    cwd: state.context.cwd,
    ownerAgentId: null,
    scope: "agent",
    source: "omp-job",
    status: jobStatus(job),
    startedAt: job.startTime,
    endedAt: job.status === "running" ? null : (previous?.endedAt ?? Date.now()),
    exitCode: jobExitCode(job),
    terminalId: null,
  });
  const text = job.errorText ?? job.resultText ?? job.progressText;
  if (text !== undefined) state.rememberOutput(job.id, text);
}

function retainVisibleJobs(state: JobBridgeState): void {
  const snapshot = state.context.getAsyncJobSnapshot();
  if (!snapshot) return;
  for (const row of snapshot.running) retainJob(state, row);
  for (const row of snapshot.recent) retainJob(state, row);
}

function refreshRetainedJobs(state: JobBridgeState): void {
  // Keep jobs after they fall outside OMP's five-row recent snapshot. Their
  // ownership was established while they were in this session's snapshot.
  for (const [id, row] of state.retained) {
    const job = state.manager.getJob(id);
    if (!job) {
      if (row.status === "running") row.status = "unknown";
      continue;
    }
    if (job.status === "running") continue;
    row.status = jobStatus(job);
    row.endedAt ??= Date.now();
    row.exitCode = jobExitCode(job);
    const text = job.errorText ?? job.resultText ?? job.progressText;
    if (text !== undefined) state.rememberOutput(id, text);
  }
}

function pruneRetainedJobs(state: JobBridgeState): void {
  for (const [id, row] of state.retained) {
    if (state.retained.size <= MAX_RETAINED_JOBS) return;
    if (row.status === "running") continue;
    state.retained.delete(id);
    state.outputs.delete(id);
  }
}

export default function desktopBackgroundJobs(pi: ExtensionApi): void {
  let cleanup: (() => void) | undefined;
  pi.on("session_start", async (_event, context) => {
    cleanup?.();
    // OMP's compiled extension loader resolves this public package subpath to
    // its own module instance. Never create a second job manager.
    const manager = AsyncJobManager.instance();
    if (!manager) throw new Error("OMP async job manager is unavailable");
    const token = randomUUID();
    const processPrefix = `omp-job:${randomUUID()}:`;
    const outputs = new Map<string, OutputRecord>();
    const retained = new Map<string, BackgroundProcess>();
    let revision = 0;
    let disposed = false;
    const rememberOutput = (id: string, text: string) => {
      if (disposed) return;
      const previous = outputs.get(id);
      const truncated = text.length > MAX_OUTPUT_CHARS || previous?.truncated === true;
      const bounded = text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text;
      if (previous?.text === bounded) return;
      outputs.set(id, { text: bounded, cursor: ++revision, truncated });
    };
    const bridgeState: JobBridgeState = {
      context,
      manager,
      processPrefix,
      outputs,
      retained,
      rememberOutput,
    };
    const list = (): BackgroundProcess[] => {
      retainVisibleJobs(bridgeState);
      refreshRetainedJobs(bridgeState);
      pruneRetainedJobs(bridgeState);
      return [...retained.values()];
    };
    const originalRegister = manager.register;
    // Retain final results promptly without replacing native progress callbacks.
    // Live output comes from the manager, including jobs backgrounded after registration.
    const observeRegister: AsyncJobManager["register"] = function (
      this: AsyncJobManager,
      type,
      label,
      run,
      options,
    ) {
      const id = originalRegister.call(this, type, label, run, options);
      // Establish ownership from OMP's session-scoped snapshot, not the
      // process-global manager (which also contains child agents' jobs).
      list();
      if (retained.has(id)) {
        const refresh = () => {
          if (!disposed) list();
        };
        void manager.getJob(id)?.promise.then(refresh, refresh);
      }
      return id;
    };
    manager.register = observeRegister;
    const stopJobs = async (ids: string[]): Promise<number> => {
      if (ids.length === 0) return 0;
      manager.acknowledgeDeliveries(ids);
      const jobs = ids.map((id) => manager.getJob(id)).filter((job) => job !== undefined);
      const stopped = ids.reduce((count, id) => count + (manager.cancel(id) ? 1 : 0), 0);
      await Promise.allSettled(jobs.map((job) => job.promise));
      manager.consumeJobResults(ids);
      list();
      return stopped;
    };
    const handleRequest = async (request: Request): Promise<Response> => {
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response(null, { status: 401 });
      const url = new URL(request.url);
      const processes = list();
      if (request.method === "GET" && url.pathname === "/list") return Response.json({ processes });
      if (request.method === "GET" && url.pathname === "/output") {
        const publicId = url.searchParams.get("id");
        const id = publicId?.startsWith(processPrefix)
          ? publicId.slice(processPrefix.length)
          : null;
        if (!id || !retained.has(id))
          return new Response("Background process not found", { status: 404 });
        const output = outputs.get(id) ?? { text: "", cursor: 0, truncated: false };
        const unchanged = url.searchParams.get("cursor") === String(output.cursor);
        const response: BackgroundProcessOutput = {
          text: unchanged ? "" : output.text,
          cursor: output.cursor,
          reset: !unchanged,
          format: "text",
          truncated: output.truncated,
        };
        return Response.json(response);
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        const publicId = url.searchParams.get("id");
        const id = publicId?.startsWith(processPrefix)
          ? publicId.slice(processPrefix.length)
          : null;
        if (!id || !retained.has(id))
          return new Response("Background process not found", { status: 404 });
        return Response.json({ stopped: (await stopJobs([id])) > 0 });
      }
      if (request.method === "POST" && url.pathname === "/stop-all") {
        const ids = [...retained.entries()]
          .filter(([, process]) => process.status === "running")
          .map(([id]) => id);
        return Response.json({ stopped: await stopJobs(ids) });
      }
      return new Response(null, { status: 405 });
    };
    const server = createServer((request, response) => {
      const headers = new Headers();
      if (request.headers.authorization)
        headers.set("authorization", request.headers.authorization);
      void handleRequest(
        new Request(new URL(request.url ?? "/", "http://127.0.0.1"), {
          method: request.method,
          headers,
        }),
      )
        .then(async (result) => {
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(Buffer.from(await result.arrayBuffer()));
        })
        .catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
    });
    const ready = Promise.withResolvers<void>();
    server.once("error", ready.reject);
    server.listen(0, "127.0.0.1", ready.resolve);
    try {
      await ready.promise;
    } catch (error) {
      server.close();
      if (manager.register === observeRegister) manager.register = originalRegister;
      throw error;
    }
    server.removeListener("error", ready.reject);
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Background job bridge did not bind a TCP port");
    cleanup = () => {
      disposed = true;
      server.close();
      if (manager.register === observeRegister) manager.register = originalRegister;
      retained.clear();
      outputs.clear();
    };
    process.stdout.write(
      `${JSON.stringify({
        type: "desktop_background_jobs_ready",
        port: address.port,
        token,
      })}\n`,
    );
  });
  pi.on("session_shutdown", () => cleanup?.());
}
