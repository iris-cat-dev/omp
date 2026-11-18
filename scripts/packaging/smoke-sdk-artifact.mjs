import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
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
    "syntaxHighlighting",
  ]) {
    assert.equal(capabilities[capability], false, `Desktop core capability ${capability}`);
  }
  assert.throws(() => native.highlightCode("const value = 1;", "javascript", {}), /syntaxHighlighting|unavailable/);
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
  await smokeSandbox(staged, temporary, sdk);
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
  const ffi = load("koffi");
  const system = ffi.load(
    staged.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" :
      staged.platform === "win32" ? "kernel32.dll" : "libc.so.6",
  );
  try {
    const getPid = staged.platform === "win32"
      ? system.func("uint32_t __stdcall GetCurrentProcessId(void)")
      : system.func("int getpid(void)");
    assert.equal(getPid(), process.pid);
  } finally {
    system.unload();
  }
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

async function smokeSandbox(staged, temporary, sdk) {
  const { openSandboxFs } = await import(
    pathToFileURL(path.join(staged.directory, "dist/node/sandbox.mjs")).href
  );
  const root = path.join(await realpath(temporary), "QQ 沙箱");
  await mkdir(root);
  const files = await openSandboxFs({ root, maxBytes: 1024 });
  let session;
  const auth = await sdk.AuthStorage.create(path.join(temporary, "sandbox-auth.db"));
  try {
    files.mkdir("nested/中文");
    files.write("nested/中文/note.txt", Buffer.from("你好"), { exclusive: true });
    assert.equal(files.read("nested/中文/note.txt").toString(), "你好");
    assert.deepEqual(files.list("nested/中文").map(entry => entry.name), ["note.txt"]);
    assert.equal(files.stat("nested/中文/note.txt").size, 6);
    assert.throws(() => files.write("nested/中文/note.txt", Buffer.from("replace"), { exclusive: true }), /denied/);
    files.write("nested/中文/note.txt", Buffer.from("updated"));
    assert.equal(files.read("nested/中文/note.txt").toString(), "updated");
    assert.throws(() => files.write("large", Buffer.alloc(1025)), /denied/);
    assert.throws(() => files.read("nested/中文/note.txt", 3), /denied/);
    files.remove("nested/中文/note.txt");
    assert.deepEqual(files.list("nested/中文"), []);
    const outside = path.join(temporary, "outside-sandbox");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret"), "outside-secret");
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await link(path.join(outside, "secret"), path.join(root, "hardlink"));
    for (const target of ["../outside-sandbox/secret", path.join(outside, "secret"), "C:\\secret", "note:stream", "linked/secret", "hardlink"]) {
      assert.throws(() => files.read(target), /denied/);
      assert.throws(() => files.write(target, Buffer.from("tamper")), /denied/);
      assert.throws(() => files.stat(target), /denied/);
      assert.throws(() => files.remove(target), /denied/);
    }
    assert.throws(() => files.mkdir("linked/created"), /denied/);
    assert.throws(() => files.list("."), /denied/);
    assert.equal(await readFile(path.join(outside, "secret"), "utf8"), "outside-secret");
    await rm(path.join(root, "linked"));
    await rm(path.join(root, "hardlink"));
    const registry = new sdk.ModelRegistry(auth, path.join(temporary, "sandbox-models.yml"));
    const model = registry.find("openai", "gpt-4o-mini");
    assert.ok(model, "Sandbox smoke requires the bundled model catalog");
    ({ session } = await sdk.createAgentSession({
      cwd: root, agentDir: path.join(temporary, "sandbox-agent"), sandbox: { root },
      authStorage: auth, modelRegistry: registry, model,
      settings: sdk.Settings.isolated({ "memory.backend": "off" }),
      sessionManager: sdk.SessionManager.inMemory(root),
    }));
    assert.deepEqual(session.agent.state.tools.map(tool => tool.name).sort(), ["sandbox_list", "sandbox_read", "sandbox_write"]);
    await session.getToolByName("sandbox_write").execute("qq-startup-write", { path: "ready.txt", content: "QQ sandbox ready" });
    assert.equal(await readFile(path.join(root, "ready.txt"), "utf8"), "QQ sandbox ready");
    const denied = await session.getToolByName("sandbox_read").execute("qq-startup-denied", { path: "../outside-sandbox/secret" });
    assert.equal(denied.isError, true);
    assert.throws(() => session.executeBash("whoami"), /Sandbox/);
    const original = path.join(temporary, "original-sandbox");
    await rename(root, original);
    await mkdir(root);
    await writeFile(path.join(root, "ready.txt"), "replacement-secret");
    assert.equal(files.read("ready.txt").toString(), "QQ sandbox ready");
    files.write("ready.txt", Buffer.from("still-pinned"));
    assert.equal(await readFile(path.join(root, "ready.txt"), "utf8"), "replacement-secret");
    files.close();
    assert.throws(() => files.read("ready.txt"), /denied/);
    await session.dispose();
    session = undefined;
    ({ session } = await sdk.createAgentSession({
      cwd: root, agentDir: path.join(temporary, "host-agent"),
      authStorage: auth, modelRegistry: registry, model, enableMCP: false, enableLsp: false,
      settings: sdk.Settings.isolated({ "memory.backend": "off" }),
      sessionManager: sdk.SessionManager.inMemory(root),
    }));
    const hostRead = await session.getToolByName("read").execute("qq-normal-read", { path: "../outside-sandbox/secret:raw" });
    assert.notEqual(hostRead.isError, true);
    assert.ok(hostRead.content.some(item => item.type === "text" && item.text.includes("outside-secret")));
    await session.getToolByName("write").execute("qq-normal-write", { path: "../outside-sandbox/normal-note", content: "host tools restored" });
    assert.equal(await readFile(path.join(outside, "normal-note"), "utf8"), "host tools restored");
    console.log("SDK artifact sandbox passed native isolation, bounded files and real QQ-style session startup");
  } finally {
    files.close();
    await session?.dispose();
    auth.close();
  }
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
