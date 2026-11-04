const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SELECTOR = "__omp_worker_stats_activity";
const OUTPUT_LIMIT = 64 * 1024;
const CLEANUP_TIMEOUT_MS = 20_000;

function bounded(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function appendOutput(previous, chunk) {
  return (previous + chunk.toString()).slice(-OUTPUT_LIMIT);
}

/**
 * Build/refresh a synthetic JSONL fixture's index through the packaged SDK's
 * real activity worker. The caller supplies its already-isolated environment;
 * no CLI, model request, SQL writes, or production Stats RPC changes are used.
 */
async function syncSdkStatsFixture({ executable, sdkRoot, env, cwd, timeoutMs = 65_000 }) {
  const started = Date.now();
  const host = path.join(sdkRoot, "dist", "node", "host.mjs");
  if (!fs.existsSync(host)) throw new Error(`Packaged SDK worker host is missing: ${host}`);
  const childEnv = {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
    OMP_PROFILE: "default",
    PI_PROFILE: "default",
  };
  for (const name of Object.keys(childEnv)) {
    if (/^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|NODE_EXTRA_CA_CERTS)$/i.test(name))
      delete childEnv[name];
  }
  const diagnostics = {
    selector: SELECTOR,
    host,
    completed: false,
    stopped: false,
    activities: [],
    workerLogs: [],
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
  };
  const proc = spawn(executable, ["--experimental-vm-modules", host, SELECTOR], {
    cwd,
    env: childEnv,
    windowsHide: true,
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  diagnostics.pid = proc.pid ?? null;
  proc.stdout.on("data", (chunk) => {
    diagnostics.stdout = appendOutput(diagnostics.stdout, chunk);
  });
  proc.stderr.on("data", (chunk) => {
    diagnostics.stderr = appendOutput(diagnostics.stderr, chunk);
  });
  let closedAlready = false;
  const closed = new Promise((resolve) => {
    proc.once("close", (code, signal) => {
      closedAlready = true;
      diagnostics.exitCode = code;
      diagnostics.signal = signal;
      resolve();
    });
  });
  const id = "sdk-stats-fixture-load";
  let onMessage;
  let onError;
  let onExit;
  const loaded = new Promise((resolve, reject) => {
    onError = reject;
    onExit = (code, signal) =>
      reject(new Error(`Stats activity worker exited before done (${code ?? signal})`));
    onMessage = (message) => {
      if (message?.type === "log") {
        if (diagnostics.workerLogs.length < 100) diagnostics.workerLogs.push(message);
        return;
      }
      if (message?.id !== id) return;
      switch (message.type) {
        case "activity":
          diagnostics.activities.push(message.points);
          return;
        case "done":
          diagnostics.completed = true;
          resolve();
          return;
        case "error":
          reject(new Error(`Stats activity worker failed: ${message.error}`));
      }
    };
    proc.on("message", onMessage);
    proc.on("error", onError);
    proc.once("exit", onExit);
    proc.once("spawn", () => {
      proc.send({ type: "load", id }, (error) => {
        if (error) reject(error);
      });
    });
  });
  let failure;
  try {
    await bounded(loaded, timeoutMs, "Stats activity load");
  } catch (error) {
    failure = error;
  } finally {
    proc.off("message", onMessage);
    proc.off("exit", onExit);
    // Keep the error listener installed through termination; a late IPC error
    // must not become an uncaught exception while the process is being reaped.
    try {
      // This SDK's sync pool uses worker_threads, not child processes. Killing
      // the retained ChildProcess handle avoids PID reuse; confirmed host exit
      // also confirms those worker threads stopped.
      if (!closedAlready) proc.kill("SIGKILL");
      await bounded(closed, CLEANUP_TIMEOUT_MS, "Stats activity worker exit");
      diagnostics.stopped = true;
    } catch (error) {
      diagnostics.cleanupError = error.message;
      failure ||= error;
      if (!closedAlready) {
        proc.kill("SIGKILL");
        try {
          await bounded(closed, CLEANUP_TIMEOUT_MS, "Stats activity fallback exit");
        } catch (exitError) {
          diagnostics.exitError = exitError.message;
        }
      }
    }
    proc.off("error", onError);
    diagnostics.elapsedMs = Date.now() - started;
  }
  if (failure) {
    failure.diagnostics = diagnostics;
    throw failure;
  }
  return diagnostics;
}

module.exports = { syncSdkStatsFixture };
