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
    event:
      | "session_start"
      | "session_before_switch"
      | "session_switch"
      | "session_before_branch"
      | "session_branch",
    handler: (event: unknown, context: ExtensionContext) => Promise<void>,
  ): void;
  on(event: "session_shutdown", handler: () => void): void;
  registerCommand(
    name: string,
    options: { handler(args: string, context: ExtensionContext): Promise<void> },
  ): void;
}
interface OutputRecord {
  text: string;
  cursor: number;
  truncated: boolean;
}
const MAX_OUTPUT_CHARS = 128 * 1024;
const MAX_RETAINED_JOBS = 100;
const generationKey = Symbol.for("omp-desktop.background-jobs-generation");
// Extension reloads share this process-wide clock, so late cleanup from an old
// extension instance cannot revoke the replacement instance's ready endpoint.
const generationHost = globalThis as typeof globalThis & { [generationKey]?: number };

function nextBridgeGeneration(): number {
  const generation = (generationHost[generationKey] ?? 0) + 1;
  generationHost[generationKey] = generation;
  return generation;
}

interface JobBridgeState {
  context: ExtensionContext;
  sessionId: string;
  manager: AsyncJobManager;
  ownership: object;
  processPrefix: string;
  outputs: Map<string, OutputRecord>;
  retained: Map<string, BackgroundProcess>;
  instances: Map<string, AsyncJob>;
  jobKeys: WeakMap<AsyncJob, string>;
  rememberOutput(id: string, text: string): void;
}

function jobStatus(job: AsyncJob): BackgroundProcess["status"] {
  return job.status === "completed" ? "exited" : job.status;
}

function jobExitCode(job: AsyncJob): number | null {
  if (job.latestDetails?.exitCode !== undefined) return job.latestDetails.exitCode;
  return job.status === "completed" ? 0 : null;
}

function retainJob(state: JobBridgeState, job: AsyncJob): void {
  let key = state.jobKeys.get(job);
  if (!key) {
    key = `${state.processPrefix}${randomUUID()}:${job.id}`;
    state.jobKeys.set(job, key);
  }
  const previous = state.retained.get(key);
  state.instances.set(key, job);
  state.retained.set(key, {
    id: key,
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
  if (text !== undefined) state.rememberOutput(key, text);
}

function retainVisibleJobs(
  state: JobBridgeState,
  owners: WeakMap<AsyncJob, object>,
  requireSnapshot = true,
): void {
  const snapshot = state.context.getAsyncJobSnapshot();
  if (!snapshot) {
    if (requireSnapshot) throw new Error("OMP session job ownership is unavailable");
    return;
  }
  for (let section = 0; section < 2; section++) {
    const rows = section === 0 ? snapshot.running : snapshot.recent;
    for (const row of rows) {
      const job = state.manager.getJob(row.id);
      if (!job) {
        if (requireSnapshot) throw new Error("OMP visible job instance is unavailable");
        continue;
      }
      const owner = owners.get(job);
      if (owner && owner !== state.ownership) continue;
      owners.set(job, state.ownership);
      retainJob(state, job);
    }
  }
}

function refreshRetainedJobs(state: JobBridgeState): void {
  // Keep jobs after they fall outside OMP's five-row recent snapshot. Their
  // ownership was established while they were in this session's snapshot.
  for (const [key, row] of state.retained) {
    const job = state.instances.get(key)!;
    if (job.status === "running") {
      row.status = state.manager.getJob(job.id) === job ? "running" : "unknown";
      continue;
    }
    row.status = jobStatus(job);
    row.endedAt ??= Date.now();
    row.exitCode = jobExitCode(job);
    const text = job.errorText ?? job.resultText ?? job.progressText;
    if (text !== undefined) state.rememberOutput(key, text);
  }
}

function pruneRetainedJobs(state: JobBridgeState): void {
  for (const [id, row] of state.retained) {
    if (state.retained.size <= MAX_RETAINED_JOBS) return;
    if (row.status === "running" || row.status === "unknown") continue;
    state.retained.delete(id);
    state.outputs.delete(id);
    state.instances.delete(id);
  }
}

export default function desktopBackgroundJobs(pi: ExtensionApi): void {
  // This command lives for the extension's lifetime, independently of its TCP
  // listener. Native RPC executes extension commands locally, without a model.
  const recoveryCommand = `desktop-background-jobs-${randomUUID()}`;
  let generation = nextBridgeGeneration();
  let state: JobBridgeState | undefined;
  const inactive = new Set<JobBridgeState>();
  const jobOwners = new WeakMap<AsyncJob, object>();
  let rollbackState: JobBridgeState | undefined;
  let inheritedTransition: JobBridgeState | undefined;
  let closeTransport: (() => void) | undefined;
  let restoreRegister: (() => void) | undefined;
  let transition = Promise.resolve();
  let stopped = false;
  let lifecycleEpoch = 0;

  const invalidate = () => {
    process.stdout.write(
      `${JSON.stringify({ type: "desktop_background_jobs_invalidated", generation })}\n`,
    );
    closeTransport?.();
    closeTransport = undefined;
  };
  const refreshInactive = (): boolean => {
    let hasUnresolved = false;
    // Keep one complete rollback candidate. Older scopes survive only while
    // unresolved work still needs to fence retirement.
    for (const previous of inactive) {
      refreshRetainedJobs(previous);
      let unresolved = false;
      for (const row of previous.retained.values()) {
        if (row.status === "running" || row.status === "unknown") unresolved = true;
      }
      if (unresolved) hasUnresolved = true;
      else if (previous !== rollbackState) inactive.delete(previous);
    }
    return hasUnresolved;
  };
  const list = (): BackgroundProcess[] => {
    if (!state || stopped) throw new Error("OMP background job session is unavailable");
    alignState(state.context);
    if (refreshInactive())
      throw new Error("Outgoing OMP session still has unresolved background jobs");
    retainVisibleJobs(state, jobOwners);
    refreshRetainedJobs(state);
    pruneRetainedJobs(state);
    return [...state.retained.values()];
  };
  const makeState = (context: ExtensionContext): JobBridgeState => {
    const manager = AsyncJobManager.instance();
    if (!manager) throw new Error("OMP async job manager is unavailable");
    let revision = 0;
    const outputs = new Map<string, OutputRecord>();
    return {
      context,
      sessionId: context.sessionManager.getSessionId(),
      manager,
      ownership: {},
      processPrefix: `omp-job:${randomUUID()}:`,
      outputs,
      retained: new Map(),
      instances: new Map(),
      jobKeys: new WeakMap(),
      rememberOutput(id, text) {
        const previous = outputs.get(id);
        const truncated = text.length > MAX_OUTPUT_CHARS || previous?.truncated === true;
        const bounded = text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text;
        if (previous?.text === bounded) return;
        outputs.set(id, { text: bounded, cursor: ++revision, truncated });
      },
    };
  };
  const alignState = (context: ExtensionContext, inherit = false): JobBridgeState => {
    const sessionId = context.sessionManager.getSessionId();
    if (!state) {
      state = makeState(context);
    } else if (state.sessionId !== sessionId) {
      invalidate();
      generation = nextBridgeGeneration();
      if (inherit || inheritedTransition === state) {
        state.sessionId = sessionId;
      } else {
        const outgoing = state;
        let restored: JobBridgeState | undefined;
        for (const candidate of inactive) {
          if (candidate.sessionId === sessionId) restored = candidate;
        }
        inactive.add(outgoing);
        rollbackState = outgoing;
        state = restored ?? makeState(context);
        inactive.delete(state);
      }
      inheritedTransition = undefined;
      refreshInactive();
    }
    state.context = context;
    return state;
  };
  const observeJobs = () => {
    restoreRegister?.();
    const manager = state!.manager;
    const originalRegister = manager.register;
    const observeRegister: AsyncJobManager["register"] = function (
      this: AsyncJobManager,
      type,
      label,
      run,
      options,
    ) {
      // Earlier native lifecycle hooks may register work after the identity has
      // changed but before this extension receives its own switch/branch hook.
      const owner = alignState(state!.context);
      const id = originalRegister.call(this, type, label, run, options);
      retainVisibleJobs(owner, jobOwners, false);
      const job = manager.getJob(id);
      if (job && jobOwners.get(job) === owner.ownership) {
        const refresh = () => {
          refreshRetainedJobs(owner);
          retainJob(owner, job);
        };
        void job.promise.then(refresh, refresh);
      }
      return id;
    };
    manager.register = observeRegister;
    restoreRegister = () => {
      if (manager.register === observeRegister) manager.register = originalRegister;
    };
  };
  const bind = async (context?: ExtensionContext) => {
    if (!state || stopped) throw new Error("OMP background job session is unavailable");
    const current = alignState(context ?? state.context);
    invalidate();
    generation = nextBridgeGeneration();
    const currentGeneration = generation;
    const token = randomUUID();
    const { manager, retained, outputs } = current;
    const stopJobs = async (ids: string[]): Promise<number> => {
      const owned = ids.filter((id) => {
        const job = current.instances.get(id);
        return job !== undefined && manager.getJob(job.id) === job;
      });
      if (owned.length === 0) return 0;
      const jobs = owned.map((id) => current.instances.get(id)!);
      const nativeIds = jobs.map((job) => job.id);
      manager.acknowledgeDeliveries(nativeIds);
      const stoppedCount = nativeIds.reduce((count, id) => count + (manager.cancel(id) ? 1 : 0), 0);
      await Promise.allSettled(jobs.map((job) => job.promise));
      manager.consumeJobResults(
        jobs.filter((job) => manager.getJob(job.id) === job).map((job) => job.id),
      );
      refreshRetainedJobs(current);
      return stoppedCount;
    };
    const handleRequest = async (request: Request): Promise<Response> => {
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return new Response(null, { status: 401 });
      if (currentGeneration !== generation || current !== state || stopped)
        return new Response("OMP background job bridge was superseded", { status: 409 });
      const url = new URL(request.url);
      const processes = list();
      if (currentGeneration !== generation || current !== state || stopped)
        return new Response("OMP background job bridge was superseded", { status: 409 });
      if (request.method === "GET") {
        if (url.pathname === "/list") return Response.json({ processes });
        if (url.pathname === "/output") {
          const id = url.searchParams.get("id");
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
      }
      if (request.method === "POST") {
        if (url.pathname === "/stop") {
          const id = url.searchParams.get("id");
          if (!id || !retained.has(id))
            return new Response("Background process not found", { status: 404 });
          return Response.json({ stopped: (await stopJobs([id])) > 0 });
        }
        if (url.pathname === "/stop-all") {
          const ids = [...retained.entries()]
            .filter(([, process]) => process.status === "running")
            .map(([id]) => id);
          return Response.json({ stopped: await stopJobs(ids) });
        }
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
          return undefined;
        })
        .catch(() => {
          if (!response.headersSent) response.writeHead(503);
          response.end();
        });
    });
    const ready = Promise.withResolvers<void>();
    closeTransport = () => {
      ready.reject(new Error("OMP background job bridge startup was invalidated"));
      server.close();
      server.closeAllConnections();
    };
    server.once("error", ready.reject);
    server.listen(0, "127.0.0.1", ready.resolve);
    try {
      await ready.promise;
      if (stopped || currentGeneration !== generation || current !== state)
        throw new Error("OMP background job bridge startup was superseded");
      server.removeListener("error", ready.reject);
      server.unref();
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Background job bridge did not bind a TCP port");
      process.stdout.write(
        `${JSON.stringify({
          type: "desktop_background_jobs_ready",
          generation: currentGeneration,
          port: address.port,
          token,
          recoveryCommand,
        })}\n`,
      );
    } catch (error) {
      server.close();
      throw error;
    }
  };
  const enqueue = (work: () => Promise<void>) => {
    const result = transition.then(work);
    transition = result.catch(() => undefined);
    return result;
  };
  pi.on("session_start", (_event, context) => {
    const epoch = ++lifecycleEpoch;
    invalidate();
    generation = nextBridgeGeneration();
    return enqueue(async () => {
      if (epoch !== lifecycleEpoch) throw new Error("OMP background job startup was superseded");
      stopped = false;
      alignState(context);
      observeJobs();
      await bind();
    });
  });
  pi.on("session_before_switch", async (event, context) => {
    if (!state || stopped) return;
    const current = alignState(context);
    retainVisibleJobs(current, jobOwners);
    const fork =
      event !== null && typeof event === "object" && "reason" in event && event.reason === "fork";
    inheritedTransition = fork ? current : undefined;
  });
  pi.on("session_before_branch", async (_event, context) => {
    if (!state || stopped) return;
    const current = alignState(context);
    retainVisibleJobs(current, jobOwners);
    inheritedTransition = current;
  });
  const rebindAfterTransition = (context: ExtensionContext, inherit: boolean) => {
    const epoch = lifecycleEpoch;
    // Native identity is already visible, but session_switch can still roll
    // back later. Keep the prior state available for identity-based recovery.
    invalidate();
    generation = nextBridgeGeneration();
    return enqueue(async () => {
      if (stopped || epoch !== lifecycleEpoch)
        throw new Error("Cannot change a stopped OMP background job session");
      alignState(context, inherit);
      await bind(context);
    });
  };
  pi.on("session_switch", (event, context) => {
    const fork =
      event !== null && typeof event === "object" && "reason" in event && event.reason === "fork";
    return rebindAfterTransition(context, fork);
  });
  pi.on("session_branch", (_event, context) => rebindAfterTransition(context, true));
  pi.registerCommand(recoveryCommand, {
    handler: (_args, context) => enqueue(() => bind(context)),
  });
  pi.on("session_shutdown", () => {
    ++lifecycleEpoch;
    stopped = true;
    invalidate();
    generation = nextBridgeGeneration();
    restoreRegister?.();
    restoreRegister = undefined;
  });
}
