import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importSdkArtifact } from "./sdk-artifact.mjs";

async function smoke(staged, temporary) {
  const load = createRequire(path.join(staged.directory, "package.json"));
  const sdk = await import(pathToFileURL(path.join(staged.directory, "dist/node/sdk.mjs")).href);
  assert.equal(typeof sdk.createAgentSession, "function");
  const native = load("@oh-my-pi/pi-natives");
  assert.equal(native.__piNativesBuildVersion(), staged.version);
  const capabilities = sdk.readNativeCapabilities();
  for (const capability of [
    "smollm",
    "liveVoice",
    "wasmGrammars",
    "pdf",
    "jujutsu",
    "snapcompact",
    "audio",
    "localAssistance",
  ]) {
    assert.equal(capabilities[capability], false, `Desktop core capability ${capability}`);
  }
  const work = path.join(temporary, "work");
  await mkdir(work);
  const session = {
    cwd: work,
    hasUI: false,
    enableLsp: false,
    enableMCP: false,
    hasEditTool: true,
    settings: sdk.Settings.isolated({
      "lsp.enabled": false,
      "lsp.formatOnWrite": false,
      "lsp.diagnosticsOnWrite": false,
    }),
    getSessionSpawns: () => null,
    getSessionFile: () => null,
  };
  await new sdk.WriteTool(session).execute("artifact-write", {
    path: "hello.txt",
    content: "native SDK artifact\n",
  });
  assert.equal(await readFile(path.join(work, "hello.txt"), "utf8"), "native SDK artifact\n");
  const result = await new sdk.ReadTool(session).execute("artifact-read", {
    path: "hello.txt:raw",
  });
  assert.notEqual(result.isError, true);
  assert.match(
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
    /native SDK artifact/,
  );
  const utils = path.dirname(load.resolve("@oh-my-pi/pi-utils/package.json"));
  const { Database } = await import(
    pathToFileURL(path.join(utils, "dist/node/sqlite-driver.mjs")).href
  );
  const db = new Database(path.join(work, "smoke.db"));
  try {
    db.run("CREATE TABLE smoke (value TEXT NOT NULL)");
    db.run("INSERT INTO smoke VALUES (?)", "native-sqlite");
    assert.equal(db.query("SELECT value FROM smoke").get().value, "native-sqlite");
  } finally {
    db.close();
  }
  const { Image } = await import(
    pathToFileURL(path.join(utils, "dist/node/runtime-image.mjs")).href
  );
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>',
  );
  const png = await new Image(svg).resize(2, 3).png().bytes();
  assert.deepEqual(await new Image(png).metadata(), { width: 2, height: 3, format: "png" });
  assert.ok(load("koffi").version);
  const worker = fork(
    path.join(staged.directory, "dist/node/host.mjs"),
    ["__omp_worker_stats_activity"],
    {
      cwd: work,
      execPath: process.execPath,
      execArgv: [],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        HOME: temporary,
        USERPROFILE: temporary,
        PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
        NODE_PATH: "",
        NODE_OPTIONS: "",
      },
    },
  );
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("SDK artifact worker timed out"));
      }, 30_000);
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeListener("message", onMessage);
        worker.removeListener("exit", onExit);
        worker.removeListener("error", onError);
      };
      const onMessage = (message) => {
        if (message.type === "pong" && message.id === 1) {
          cleanup();
          resolve();
        } else if (message.type === "error") {
          cleanup();
          reject(new Error(message.error));
        }
      };
      const onExit = (code, signal) => {
        cleanup();
        reject(new Error(`SDK artifact worker exited: ${code}/${signal}`));
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      worker.on("message", onMessage);
      worker.once("exit", onExit);
      worker.once("error", onError);
      worker.send({ type: "ping", id: 1 }, (error) => {
        if (error) onError(error);
      });
    });
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGKILL");
      await exited;
    }
  }
  await smokeEval(staged, temporary, work);
}

async function smokeEval(staged, temporary, work) {
  const worker = fork(
    path.join(staged.directory, "dist/node/host.mjs"),
    ["__omp_worker_js_eval_process"],
    {
      cwd: work,
      execPath: process.execPath,
      execArgv: ["--experimental-vm-modules"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        HOME: temporary,
        USERPROFILE: temporary,
        PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
        NODE_PATH: "",
        NODE_OPTIONS: "",
      },
    },
  );
  function request(message, expectedType) {
    const pending = Promise.withResolvers();
    let output = "";
    const timer = setTimeout(() => fail(new Error("SDK artifact Eval timed out")), 30_000);
    function cleanup() {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", fail);
      worker.off("exit", onExit);
    }
    function fail(error) {
      cleanup();
      pending.reject(error);
    }
    function onExit(code, signal) {
      fail(new Error(`SDK artifact Eval exited: ${code}/${signal}`));
    }
    function onMessage(reply) {
      if (reply.type === "init-failed") return fail(new Error(reply.error.message));
      if (reply.type === "text") output += reply.chunk;
      if (reply.type !== expectedType) return;
      cleanup();
      pending.resolve({ ...reply, output });
    }
    worker.on("message", onMessage);
    worker.once("error", fail);
    worker.once("exit", onExit);
    worker.send(message, (error) => {
      if (error) fail(error);
    });
    return pending.promise;
  }
  const snapshot = { cwd: work, sessionId: "artifact-async-context", localRoots: {} };
  try {
    await request({ type: "init", snapshot }, "ready");
    const printed = await request(
      {
        type: "run",
        runId: "artifact-output",
        code: "print('before-await'); await Promise.resolve(); console.log('after-await'); ({ fromAwait: true })",
        filename: "artifact-cell.js",
        snapshot,
      },
      "result",
    );
    assert.equal(printed.ok, true, printed.error?.message);
    assert.match(printed.output, /before-await\nafter-await\n/);
    assert.match(printed.output, /fromAwait: true/);
    const failed = await request(
      {
        type: "run",
        runId: "artifact-error",
        code: "throw new Error('artifact-eval-error')",
        filename: "artifact-cell.js",
        snapshot,
      },
      "result",
    );
    assert.equal(failed.ok, false);
    assert.match(failed.error.message, /artifact-eval-error/);
    await request({ type: "close" }, "closed");
    console.log(
      "SDK artifact Eval passed sync/await output, object final expression and explicit errors",
    );
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGKILL");
      await exited;
    }
  }
}

if (process.argv[2] === "--probe") {
  await smoke(JSON.parse(process.argv[3]), process.argv[4]);
} else {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "omp-sdk-artifact-smoke-"));
  try {
    const staged = await importSdkArtifact(
      path.resolve(process.argv[2] ?? "sdk-artifacts"),
      path.join(temporary, "sdk"),
    );
    // Windows retains loaded DLLs until process exit; the importer must never load them.
    const probe = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--probe", JSON.stringify(staged), temporary],
      {
        cwd: temporary,
        stdio: "inherit",
        timeout: 120_000,
        env: {
          ...process.env,
          HOME: temporary,
          USERPROFILE: temporary,
          NODE_PATH: "",
          NODE_OPTIONS: "",
          ...(staged.buildTarget === "desktop" && staged.arch === "x64"
            ? { PI_NATIVE_VARIANT: "baseline" }
            : {}),
        },
      },
    );
    if (probe.error) throw probe.error;
    if (probe.status !== 0)
      throw new Error(`SDK artifact probe failed (${probe.status}/${probe.signal}).`);
    console.log(
      `SDK artifact ${staged.version} passed read/write, native addon, SQLite, image, Koffi and worker smoke on ${staged.platform}-${staged.arch}`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
