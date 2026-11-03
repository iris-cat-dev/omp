const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { stripVTControlCharacters } = require("node:util");

const EXECUTABLE_NAME = "OMP Desktop";
const SMOKE_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 10_000;
const TERMINAL_CAPTURE_ATTEMPTS = 20;
const TERMINAL_CAPTURE_INTERVAL_MS = 500;
const REQUIRED_DESKTOP_BRIDGE_KEYS = [
  "platform",
  "loginShell",
  "invoke",
  "getPendingOpenProject",
  "events",
  "window",
  "dialog",
  "notification",
  "opener",
  "editor",
  "webUtils",
  "menu",
];

function createTempDir(prefix, root = os.tmpdir()) {
  return fs.mkdtempSync(path.join(root, prefix));
}

function assertExecutable(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
  if (process.platform !== "win32") {
    fs.accessSync(filePath, fs.constants.X_OK);
  }
}

function getExecutablePath(appPath, executableName = EXECUTABLE_NAME) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "MacOS", executableName);
  }

  if (process.platform === "win32") {
    return path.join(appPath, `${executableName}.exe`);
  }

  return path.join(appPath, executableName);
}

function getCliShimPath(appPath) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "Resources", "bin", "omp-desktop");
  }

  if (process.platform === "win32") {
    return path.join(appPath, "resources", "bin", "omp-desktop.cmd");
  }

  return path.join(appPath, "resources", "bin", "omp-desktop");
}

function getBundledOmpPath(appPath) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "Resources", "bin", "omp");
  }

  return path.join(appPath, "resources", "bin", process.platform === "win32" ? "omp.exe" : "omp");
}

function ensureLinuxSandboxPermissions(appPath) {
  if (process.platform !== "linux") {
    return;
  }

  const sandboxPath = path.join(appPath, "chrome-sandbox");
  if (!fs.existsSync(sandboxPath)) {
    throw new Error(`Chromium sandbox helper does not exist: ${sandboxPath}`);
  }

  const hasRequiredPermissions = () => {
    const stat = fs.statSync(sandboxPath);
    return stat.uid === 0 && (stat.mode & 0o7777) === 0o4755;
  };
  if (hasRequiredPermissions()) {
    return;
  }

  const chown = spawnSync("sudo", ["-n", "chown", "root:root", sandboxPath], {
    encoding: "utf8",
  });
  const chmod =
    chown.status === 0
      ? spawnSync("sudo", ["-n", "chmod", "4755", sandboxPath], { encoding: "utf8" })
      : null;
  if (chown.error || chown.status !== 0 || chmod?.error || chmod?.status !== 0) {
    throw new Error(
      `Failed to configure Chromium sandbox helper ${sandboxPath}. Run: sudo chown root:root ${sandboxPath} && sudo chmod 4755 ${sandboxPath}.\n${chown.stderr?.trim() || chmod?.stderr?.trim() || chown.error || chmod?.error || "Permissions remained incorrect."}`,
    );
  }
  if (!hasRequiredPermissions()) {
    throw new Error(`Chromium sandbox helper permissions remained incorrect: ${sandboxPath}`);
  }
}

function getLaunchCommand(executablePath) {
  if (process.platform !== "linux") {
    return {
      command: executablePath,
      args: [],
    };
  }

  return {
    command: "xvfb-run",
    args: ["-a", "--server-args=-screen 0 1280x800x24", executablePath],
  };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuoteCliArg(value) {
  if (process.platform === "win32") {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  return shellQuote(String(value));
}

function getTerminalHookSmokeCommand(marker) {
  return `echo ${marker}`;
}

function getShellCommand(script, env) {
  if (process.platform === "win32") {
    return {
      command: path.join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
      // Generated batch helpers are UTF-8 and embed the installation path.
      args: ["/d", "/c", `chcp 65001>nul && ${script}`],
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", script],
  };
}

function createDefaultDaemonEnv(extraEnv = process.env) {
  const env = { ...extraEnv };

  delete env.PASEO_HOME;
  delete env.PASEO_LISTEN;
  return env;
}

function createIsolatedDesktopEnv({ home, listen, userData, cdpPort }) {
  return {
    ...process.env,
    OMP_DESKTOP_HOME: home,
    PASEO_HOME: home,
    PASEO_LISTEN: listen,
    PASEO_ELECTRON_USER_DATA_DIR: userData,
    PASEO_DISABLE_APP_UPDATES: "1",
    PASEO_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
  };
}

function configureIsolatedDaemonHome(home, listen) {
  fs.writeFileSync(
    path.join(home, "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        daemon: {
          listen,
          relay: { enabled: false },
          mcp: { enabled: false, injectIntoAgents: false },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function reserveLocalTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a TCP port for smoke test")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function assertDarwinDockVisibility(rootPid, guiPid = null) {
  if (process.platform !== "darwin") return;
  const listing = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (listing.error || listing.status !== 0) {
    throw new Error(`Cannot inspect Dock process tree: ${listing.error || listing.stderr}`);
  }
  const processes = listing.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number));
  if (!processes.some(([pid]) => pid === rootPid)) {
    throw new Error(`Dock visibility check lost process ${rootPid}`);
  }
  const pids = new Set([rootPid]);
  let previousSize;
  do {
    previousSize = pids.size;
    for (const [pid, parentPid] of processes) {
      if (pids.has(parentPid)) pids.add(pid);
    }
  } while (pids.size !== previousSize);
  const script = `
    ObjC.import('AppKit');
    function run(argv) {
      return JSON.stringify(JSON.parse(argv[0]).map(pid => {
        const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
        return { pid, policy: app.isNil() ? null : Number(app.activationPolicy) };
      }));
    }
  `;
  const result = spawnSync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script, JSON.stringify([...pids])],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot inspect Dock visibility: ${result.error || result.stderr}`);
  }
  const policies = JSON.parse(result.stdout);
  const incorrect = policies.filter(({ pid, policy }) =>
    pid === guiPid ? policy !== 0 : policy === 0,
  );
  if (incorrect.length) {
    throw new Error(`Only the GUI process may appear in the Dock: ${JSON.stringify(policies)}`);
  }
  console.log(`Packaged desktop smoke: Dock visibility passed ${JSON.stringify(policies)}`);
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function formatLogs({ stdout, stderr, userData, daemonHome }) {
  const desktopLog = readIfExists(path.join(userData, "logs", "main.log"));
  const daemonLog = readIfExists(path.join(daemonHome, "daemon.log"));
  return [
    `App stdout:\n${stdout.join("").trim() || "<empty>"}`,
    `App stderr:\n${stderr.join("").trim() || "<empty>"}`,
    `Desktop log:\n${desktopLog?.trim() || "<missing>"}`,
    `Daemon log:\n${daemonLog?.trim() || "<missing>"}`,
  ].join("\n\n");
}

async function writeFailureArtifacts({ page, stdout, stderr, userData, daemonHome, error }) {
  const artifactDir = process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR?.trim();
  if (!artifactDir) {
    return;
  }

  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, "failure.txt"),
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n\n${formatLogs({
      stdout,
      stderr,
      userData,
      daemonHome,
    })}\n`,
  );

  const desktopLog = readIfExists(path.join(userData, "logs", "main.log"));
  if (desktopLog !== null) {
    fs.writeFileSync(path.join(artifactDir, "desktop-main.log"), desktopLog);
  }
  const daemonLog = readIfExists(path.join(daemonHome, "daemon.log"));
  if (daemonLog !== null) {
    fs.writeFileSync(path.join(artifactDir, "daemon.log"), daemonLog);
  }

  if (page) {
    const renderer = await page
      .evaluate(() => ({
        url: window.location.href,
        title: document.title,
        rootChildCount: document.querySelector("#root")?.childElementCount ?? 0,
        rootText: document.querySelector("#root")?.textContent?.trim().slice(0, 2_000) ?? "",
        bridgeKeys:
          typeof window.paseoDesktop === "object" && window.paseoDesktop !== null
            ? Object.keys(window.paseoDesktop)
            : [],
      }))
      .catch((evaluationError) => ({ evaluationError: String(evaluationError) }));
    fs.writeFileSync(
      path.join(artifactDir, "renderer.json"),
      `${JSON.stringify(renderer, null, 2)}\n`,
    );
    await page
      .screenshot({ path: path.join(artifactDir, "renderer.png"), fullPage: true })
      .catch(() => undefined);
  }
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function terminateChild(child, signal = "SIGTERM") {
  if (!isRunning(child)) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }

  child.kill(signal);
}

function waitForChildExit(child, timeoutMs = EXIT_TIMEOUT_MS) {
  if (!isRunning(child)) {
    return Promise.resolve(true);
  }

  let onExit;
  const exitPromise = new Promise((resolve) => {
    onExit = () => resolve(true);
    child.once("exit", onExit);
  });

  return Promise.race([exitPromise, delay(timeoutMs, false)]).finally(() => {
    child.off("exit", onExit);
  });
}

function releaseChildHandles(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function removeTempDir(tempDir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code) || attempt === 4) {
        throw new Error(`Packaged desktop smoke failed to remove temp dir ${tempDir}`, {
          cause: error,
        });
      }
      await delay(250);
    }
  }
}

function remainingTime(deadline) {
  return Math.max(1, deadline - Date.now());
}

async function connectToPackagedApp({
  child,
  cdpPort,
  stdout,
  stderr,
  userData,
  daemonHome,
  deadline,
}) {
  const { chromium } = require("playwright");
  let lastError = null;

  while (Date.now() < deadline) {
    if (!isRunning(child)) {
      throw new Error(
        `Packaged app exited before opening its debugging endpoint (code ${child.exitCode}, signal ${
          child.signalCode ?? "none"
        }).\n${formatLogs({ stdout, stderr, userData, daemonHome })}`,
      );
    }

    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw new Error(
    `Timed out connecting to the packaged app over CDP: ${lastError}.\n${formatLogs({
      stdout,
      stderr,
      userData,
      daemonHome,
    })}`,
  );
}

async function waitForPackagedAppPage(browser, deadline) {
  while (Date.now() < deadline) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("omp-desktop://app/"));
    if (page) {
      return page;
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the packaged omp-desktop://app/ renderer");
}

async function assertPackagedRendererLoaded(page, deadline) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector("#root");
      return root instanceof HTMLElement && root.childElementCount > 0;
    },
    undefined,
    { timeout: remainingTime(deadline) },
  );

  const bridgeState = await page.evaluate(() => ({
    keys:
      typeof window.paseoDesktop === "object" && window.paseoDesktop !== null
        ? Object.keys(window.paseoDesktop)
        : [],
    loginShell:
      typeof window.paseoDesktop?.loginShell === "string"
        ? window.paseoDesktop.loginShell.trim()
        : "",
  }));
  const bridgeKeys = bridgeState.keys;
  const missingBridgeKeys = REQUIRED_DESKTOP_BRIDGE_KEYS.filter((key) => !bridgeKeys.includes(key));
  if (missingBridgeKeys.length > 0) {
    throw new Error(
      `Packaged renderer is missing desktop preload bridge keys: ${missingBridgeKeys.join(", ")}. Present keys: ${bridgeKeys.join(", ") || "<none>"}`,
    );
  }
  if (process.platform !== "win32" && !bridgeState.loginShell) {
    throw new Error("Packaged renderer did not inherit the resolved desktop login shell.");
  }
}

async function waitForRendererStartedDaemon({
  page,
  daemonHome,
  listen,
  stdout,
  stderr,
  userData,
  deadline,
}) {
  let lastStatus = null;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      lastStatus = await page.evaluate(() => window.paseoDesktop.invoke("desktop_daemon_status"));
      if (
        lastStatus?.status === "running" &&
        lastStatus.desktopManaged === true &&
        typeof lastStatus.pid === "number" &&
        typeof lastStatus.serverId === "string" &&
        lastStatus.serverId.length > 0 &&
        lastStatus.listen === listen &&
        path.resolve(lastStatus.home) === path.resolve(daemonHome)
      ) {
        return lastStatus;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }

  throw new Error(
    `Packaged renderer did not start its desktop-managed daemon. Last status: ${JSON.stringify(lastStatus)}. Last error: ${lastError}.\n${formatLogs({ stdout, stderr, userData, daemonHome })}`,
  );
}

function runShellCommand({ script, env, label, timeoutMs = SMOKE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const shell = getShellCommand(script, env);
    const child = spawn(shell.command, shell.args, {
      detached: process.platform !== "win32",
      env,
      cwd: env.HOME || undefined,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: process.platform === "win32",
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      releaseChildHandles(child);
      callback(value);
    };

    const timer = setTimeout(() => {
      terminateChild(child);
      finish(
        reject,
        new Error(
          `${label} timed out.\nStdout:\n${stdout.join("").trim() || "<empty>"}\n\nStderr:\n${
            stderr.join("").trim() || "<empty>"
          }`,
        ),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish(resolve, {
          stdout: stdout.join(""),
          stderr: stderr.join(""),
        });
        return;
      }

      finish(
        reject,
        new Error(
          `${label} failed (code ${code}, signal ${signal ?? "none"}).\nStdout:\n${
            stdout.join("").trim() || "<empty>"
          }\n\nStderr:\n${stderr.join("").trim() || "<empty>"}`,
        ),
      );
    });
  });
}

function getCliShimScript(cliShimPath, args) {
  const commandArgs = args.map(shellQuoteCliArg).join(" ");
  if (process.platform === "win32") {
    return `call "${cliShimPath}" ${commandArgs}`;
  }

  return `${shellQuote(cliShimPath)} ${commandArgs}`;
}

async function runCliShimCommand({ appPath, env, args, label, timeoutMs }) {
  const cliShimPath = getCliShimPath(appPath);
  assertExecutable(cliShimPath, "Bundled CLI shim");

  return await runShellCommand({
    script: getCliShimScript(cliShimPath, args),
    env,
    label,
    timeoutMs,
  });
}

async function runCliShimJsonCommand({ appPath, env, args, label }) {
  const result = await runCliShimCommand({
    appPath,
    env,
    args: [...args, "--json"],
    label,
  });
  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`${label} produced empty JSON output`);
  }

  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} produced invalid JSON: ${output}`, { cause: error });
  }
}

async function smokePackagedSdkRuntime({ appPath, env, executableName }) {
  const binaryPath = getBundledOmpPath(appPath);
  if (fs.existsSync(binaryPath)) throw new Error(`SDK-only package contains OMP: ${binaryPath}`);
  const resources = path.dirname(path.dirname(binaryPath));
  const sdkRoot = path.join(resources, "omp-sdk", "node_modules", "@oh-my-pi", "pi-coding-agent");
  const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
  if (sdkPackage.bin || fs.existsSync(path.join(sdkRoot, "dist", "omp"))) {
    throw new Error("SDK payload contains a standalone OMP CLI or advertises its executable");
  }
  const runtimePath = path.join(
    resources,
    "app",
    "node_modules",
    "@omp-desktop",
    "server",
    "dist",
    "server",
    "server",
    "agent",
    "providers",
    "omp",
    "sdk-runtime.js",
  );
  // An in-checkout App can accidentally resolve missing packages from the
  // workspace node_modules. Exercise the installed layout outside that tree.
  const isolated = createTempDir("omp-desktop-sdk-install-");
  let probe;
  try {
    const isolatedApp = path.join(isolated, path.basename(appPath));
    await fs.promises.cp(appPath, isolatedApp, { recursive: true, verbatimSymlinks: true });
    const isolatedResources = path.dirname(path.dirname(getBundledOmpPath(isolatedApp)));
    const isolatedRuntime = path.join(isolatedResources, path.relative(resources, runtimePath));
    const isolatedSdk = path.join(isolatedResources, path.relative(resources, sdkRoot));
    const probeEnv = { ...env, ELECTRON_RUN_AS_NODE: "1", OMP_DESKTOP_SDK_ROOT: isolatedSdk };
    delete probeEnv.NODE_PATH;
    delete probeEnv.NODE_OPTIONS;
    probe = spawnSync(
      getExecutablePath(isolatedApp, executableName),
      [
        "-e",
        `
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { OmpSdkRuntime } = require(${JSON.stringify(isolatedRuntime)});
const { createRequire } = require("node:module");
const pino = createRequire(${JSON.stringify(isolatedRuntime)})("pino");
const runtime = new OmpSdkRuntime({
  logger: pino({ level: "silent" }),
  runtimeSettings: { ompBackend: "sdk" },
});
const sessions = [];
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sdk-packaged-"));
const extension = path.join(cwd, "sdk-install-probe.mjs");
fs.writeFileSync(extension, \`
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { nativeCapabilities } from "@oh-my-pi/pi-natives";
export default function(api) {
  api.on("session_start", async (_event, ctx) => {
    await fs.writeFile(
      path.join(ctx.cwd, "sdk-native-capabilities.json"),
      JSON.stringify(nativeCapabilities()),
    );
  });
}
\`);
(async () => {
  try {
    for (let index = 0; index < 3; index++) {
      const session = await runtime.startSession({
        cwd, noSession: true, protocolMode: "rpc-ui",
        extraArgs: ["--no-lsp", "--no-context-files", "--extension", extension],
        getImageGenerationConfig: () => null,
      });
      sessions.push(session);
      const state = await session.getState();
      assert.equal(state.isStreaming, false);
      assert.deepEqual(await session.listBackgroundJobs(), []);
      assert.ok(state.dumpTools.some(tool => tool.name === "write"));
    }
    const capabilities = JSON.parse(
      fs.readFileSync(path.join(cwd, "sdk-native-capabilities.json"), "utf8"),
    );
    const expectedCapabilities = ${JSON.stringify(
      sdkPackage.ompNodeSdk?.target === "desktop"
        ? {
            smollm: false,
            liveVoice: false,
            wasmGrammars: false,
            pdf: false,
            jujutsu: false,
            snapcompact: false,
            audio: false,
            localAssistance: false,
          }
        : { smollm: true, liveVoice: true, wasmGrammars: true },
    )};
    for (const [name, expected] of Object.entries(expectedCapabilities)) {
      assert.equal(capabilities[name], expected, "Unexpected native capability: " + name);
    }
    const states = await Promise.all(sessions.map(session => session.getState()));
    assert.equal(new Set(states.map(state => state.sessionId)).size, sessions.length);
    assert.equal(typeof globalThis.Bun, "undefined");
    console.log("native-sdk-runtime-ready");
  } finally {
    await Promise.all(sessions.map(session => session.close()));
    fs.rmSync(cwd, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`,
      ],
      {
        encoding: "utf8",
        env: probeEnv,
        cwd: isolated,
        timeout: SMOKE_TIMEOUT_MS,
      },
    );
  } finally {
    await fs.promises.rm(isolated, { recursive: true, force: true });
  }
  if (probe.error || probe.status !== 0 || !probe.stdout.includes("native-sdk-runtime-ready")) {
    throw new Error(`Packaged SDK runtime failed: ${probe.error || probe.stderr || probe.stdout}`);
  }
  const diagnostic = await runCliShimCommand({
    appPath,
    env,
    args: ["provider", "diagnostic", "omp"],
    label: "Packaged SDK provider diagnostic",
    timeoutMs: 180_000 + SMOKE_TIMEOUT_MS,
  });
  if (!diagnostic.stdout.includes("Backend: Node SDK") || !diagnostic.stdout.includes(sdkRoot)) {
    throw new Error(`Daemon did not select the packaged SDK: ${diagnostic.stdout}`);
  }
  await runCliShimJsonCommand({
    appPath,
    env,
    args: ["provider", "models", "omp"],
    label: "Packaged SDK provider models",
  });
  console.log("Packaged desktop smoke: SDK runtime and native tools loaded without OMP or Bun");
  return { sdkRoot, version: sdkPackage.version };
}

async function smokeCliShim({ appPath, env }) {
  console.log("Packaged desktop smoke: running bundled CLI shim daemon status");
  const result = await runCliShimCommand({
    appPath,
    env,
    args: ["daemon", "status", "--json"],
    label: "Bundled CLI shim daemon status",
  });
  assertCleanDaemonStatusOutput(`${result.stdout}\n${result.stderr}`);
  const status = JSON.parse(result.stdout.trim());
  if (
    status.localDaemon !== "running" ||
    status.connectedDaemon !== "reachable" ||
    (env.PASEO_HOME && path.resolve(status.home) !== path.resolve(env.PASEO_HOME)) ||
    (env.PASEO_LISTEN && status.listen !== env.PASEO_LISTEN)
  ) {
    throw new Error(
      `Bundled CLI shim did not reach the isolated running daemon: ${JSON.stringify(status)}`,
    );
  }
  return { ...result, status };
}

async function smokeColdCliDaemonStart({ appPath, env: isolatedEnv }) {
  const home = createTempDir("omp-desktop-smoke-cli-daemon-home-", isolatedEnv?.TEMP);
  const pidPath = path.join(home, "omp-desktop.pid");
  const port = await reserveLocalTcpPort();
  const listen = `127.0.0.1:${port}`;
  const env = createDefaultDaemonEnv(isolatedEnv);
  env.OMP_DESKTOP_HOME = home;
  // An explicit host forbids the connector's normal localhost fallback.
  env.PASEO_HOST = listen;
  configureIsolatedDaemonHome(home, listen);
  const report = { listen };
  let failure;
  try {
    console.log("Packaged desktop smoke: cold-starting daemon through bundled CLI shim");
    await runCliShimCommand({
      appPath,
      env,
      args: [
        "daemon",
        "start",
        "--home",
        home,
        "--listen",
        listen,
        "--no-relay",
        "--no-mcp",
        "--no-inject-mcp",
        "--no-web-ui",
      ],
      label: "Bundled CLI shim cold daemon start",
    });
    report.status = await smokeCliShim({
      appPath,
      env: { ...env, PASEO_HOME: home, PASEO_LISTEN: listen },
    });
    if (process.platform === "darwin") {
      const { pid } = JSON.parse(fs.readFileSync(pidPath, "utf8"));
      assertDarwinDockVisibility(pid);
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      report.stop = await runCliShimJsonCommand({
        appPath,
        env,
        args: ["daemon", "stop", "--home", home, "--force"],
        label: "Bundled CLI shim cold daemon stop",
      });
      report.stopped = await runCliShimJsonCommand({
        appPath,
        env: { ...env, PASEO_HOME: home, PASEO_LISTEN: listen },
        args: ["daemon", "status", "--home", home],
        label: "Bundled CLI shim cold stopped daemon status",
      });
      if (
        report.stopped.localDaemon !== "stopped" ||
        report.stopped.connectedDaemon === "reachable"
      ) {
        const stopError = new Error(
          `Cold CLI daemon did not actually stop: ${JSON.stringify(report.stopped)}`,
        );
        failure = failure
          ? new AggregateError([failure, stopError], "Cold CLI smoke and daemon cleanup failed")
          : stopError;
      }
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "Cold CLI smoke and daemon cleanup failed")
        : error;
    }
    try {
      await removeTempDir(home);
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "Cold CLI smoke and sandbox cleanup failed")
        : error;
    }
  }
  if (failure) throw failure;
  return report;
}

function assertCleanDaemonStatusOutput(output) {
  const failureNeedles = [
    "Get-CimInstance",
    "Get-Process :",
    "Cannot bind parameter",
    "wmic failed",
  ];
  const failure = failureNeedles.find((needle) => output.includes(needle));
  if (failure) {
    throw new Error(`Bundled CLI shim daemon status included process lookup failure: ${failure}`);
  }
}

async function smokeCliTerminal({ appPath, env, createTerminal }) {
  const cwd = createTempDir(
    "omp-desktop-smoke-terminal-cwd-",
    process.platform === "win32" ? env.TEMP : undefined,
  );
  const marker = `omp-desktop-packaged-terminal-smoke-${Date.now()}`;
  const name = `packaged-smoke-${process.pid}-${Date.now()}`;
  let terminalId = null;

  try {
    console.log("Packaged desktop smoke: creating real isolated terminal");
    const created = createTerminal
      ? await createTerminal({ cwd, name })
      : await runCliShimJsonCommand({
          appPath,
          env,
          args: ["terminal", "create", "--cwd", cwd, "--name", name],
          label: "Bundled CLI shim terminal create",
        });
    if (!created || typeof created.id !== "string" || created.id.length === 0) {
      throw new Error(`Terminal create returned unexpected payload: ${JSON.stringify(created)}`);
    }
    terminalId = created.id;

    const terminals = await runCliShimJsonCommand({
      appPath,
      env,
      args: ["terminal", "ls", "--all"],
      label: "Bundled CLI shim terminal ls",
    });
    if (!Array.isArray(terminals) || !terminals.some((terminal) => terminal.id === terminalId)) {
      throw new Error(`Terminal ${terminalId} was not listed after create`);
    }

    await runCliShimJsonCommand({
      appPath,
      env,
      args: ["terminal", "send-keys", terminalId, getTerminalHookSmokeCommand(marker), "Enter"],
      label: "Bundled CLI shim terminal hook command",
    });

    for (let attempt = 1; attempt <= TERMINAL_CAPTURE_ATTEMPTS; attempt += 1) {
      const capture = await runCliShimJsonCommand({
        appPath,
        env,
        args: ["terminal", "capture", terminalId, "--scrollback"],
        label: "Bundled CLI shim terminal capture",
      });
      const lines = Array.isArray(capture?.lines) ? capture.lines : [];
      const outputLines = lines.map((line) =>
        stripVTControlCharacters(String(line)).replace(/\r/g, "").trim(),
      );
      if (outputLines.includes(marker)) {
        console.log("Packaged desktop smoke: terminal hook command completed");
        return { terminalId, marker, lines: outputLines };
      }

      if (attempt < TERMINAL_CAPTURE_ATTEMPTS) {
        await delay(TERMINAL_CAPTURE_INTERVAL_MS);
      }
    }

    throw new Error(`Timed out waiting for terminal capture marker ${marker}`);
  } finally {
    try {
      if (terminalId) {
        await runCliShimJsonCommand({
          appPath,
          env,
          args: ["terminal", "kill", terminalId],
          label: "Bundled CLI shim terminal kill",
        });
      }
    } finally {
      await removeTempDir(cwd);
    }
  }
}

async function stopCliDaemon({ appPath, env }) {
  console.log("Packaged desktop smoke: stopping daemon through bundled CLI shim");
  await runCliShimCommand({
    appPath,
    env,
    args: ["daemon", "stop", "--force"],
    label: "Bundled CLI shim daemon stop",
  });
}

async function smokePetCreationHelper({ page, appPath, env }) {
  const before = await page.evaluate(() => window.paseoDesktop.invoke("desktop_daemon_status"));
  const settingsBefore = await page.evaluate(() =>
    window.paseoDesktop.invoke("get_desktop_settings"),
  );
  const workspace = await page.evaluate(() =>
    window.paseoDesktop.invoke("prepare_desktop_pet_creation", {
      description: "Packaged pet installer lifetime regression",
    }),
  );
  const workspaceRoot = fs.realpathSync(
    path.join(env.PASEO_ELECTRON_USER_DATA_DIR, "pet-workspaces"),
  );
  const workspaceRelative = path.relative(workspaceRoot, fs.realpathSync(workspace.cwd));
  if (
    !workspaceRelative ||
    workspaceRelative === ".." ||
    workspaceRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(workspaceRelative)
  ) {
    throw new Error("The generated pet workspace escaped the isolated desktop user-data directory");
  }
  const imagePath = path.join(workspace.cwd, "iris-reference.png");
  const image = fs.readFileSync(imagePath);
  const animation = { row: 0, frames: 1, fps: 1 };
  fs.writeFileSync(
    path.join(workspace.cwd, "pet.json"),
    JSON.stringify({
      version: 1,
      name: "Packaged helper smoke",
      spritesheet: "sprites.png",
      frameWidth: image.readUInt32BE(16),
      frameHeight: image.readUInt32BE(20),
      animations: {
        idle: animation,
        running: animation,
        needs_input: animation,
        ready: animation,
        blocked: animation,
      },
      bubble: {
        appearance: {
          background: "#172A42",
          foreground: "#E5F0FA",
          border: "#579ED9",
          shape: "rounded",
          fontSize: 13,
          fontWeight: "normal",
          padding: 8,
          borderRadius: 10,
          maxWidth: 200,
          animation: "fade",
        },
        states: Object.fromEntries(
          [
            "idle",
            "offline",
            "running",
            "needs_input",
            "ready",
            "blocked",
            "dragging",
            "petted",
          ].map((state) => [
            state,
            {
              messages: [`Owned helper smoke: ${state}`],
              delayMs: 0,
              durationMs: 1500,
              repeatDelayMs: 0,
            },
          ]),
        ),
      },
    }),
  );
  const helper = path.join(
    workspace.cwd,
    process.platform === "win32" ? "install-pet.cmd" : "install-pet.sh",
  );
  const script =
    process.platform === "win32"
      ? `call ${shellQuoteCliArg(helper)} ${shellQuoteCliArg(imagePath)}`
      : `${shellQuote(helper)} ${shellQuote(imagePath)}`;
  console.log("Packaged desktop smoke: installing a pet through the real generated helper");
  await runShellCommand({ script, env, label: "Packaged pet creation helper" });
  const after = await page.evaluate(() => window.paseoDesktop.invoke("desktop_daemon_status"));
  if (
    after.status !== "running" ||
    after.pid !== before.pid ||
    after.serverId !== before.serverId
  ) {
    throw new Error(
      `Pet image conversion stopped or replaced the running daemon: ${JSON.stringify(after)}`,
    );
  }
  const pets = await page.evaluate(() => window.paseoDesktop.invoke("list_desktop_pets"));
  if (
    !pets.some((pet) => pet.name === "Packaged helper smoke" && !pet.builtIn && pet.id !== "iris")
  ) {
    throw new Error("Pet helper exited without installing a usable custom pet");
  }
  const settingsAfter = await page.evaluate(() =>
    window.paseoDesktop.invoke("get_desktop_settings"),
  );
  if (settingsAfter.pet.selectedId !== settingsBefore.pet.selectedId) {
    throw new Error("Installing a custom pet changed the user's selected pet");
  }
  await smokeCliShim({ appPath, env });
  console.log(
    "Packaged desktop smoke: pet installed without stopping the daemon or changing selection",
  );
  return { installed: true, daemonPid: after.pid, selectedId: settingsAfter.pet.selectedId };
}

async function smokePackagedDesktopApp({ appPath, executableName }) {
  const smokeOmpRuntime = smokePackagedSdkRuntime;
  if (process.platform === "win32") {
    const { smokeWindowsPackagedApp } = require("./windows-native-packaged-smoke");
    return smokeWindowsPackagedApp({
      appPath,
      executableName: executableName ?? EXECUTABLE_NAME,
      reserveLocalTcpPort,
      configureIsolatedDaemonHome,
      runColdCli: smokeColdCliDaemonStart,
      runCliChecks: async ({ appPath: stagedAppPath, env, createTerminal }) => ({
        status: await smokeCliShim({ appPath: stagedAppPath, env }),
        omp: await smokeOmpRuntime({ appPath: stagedAppPath, env }),
        terminal: await smokeCliTerminal({ appPath: stagedAppPath, env, createTerminal }),
      }),
      runPetCreation: smokePetCreationHelper,
      stopDaemon: stopCliDaemon,
    });
  }
  const executablePath = getExecutablePath(appPath, executableName);
  assertExecutable(executablePath, "Packaged app executable");
  ensureLinuxSandboxPermissions(appPath);
  await smokeColdCliDaemonStart({ appPath });

  const userData = createTempDir("omp-desktop-smoke-user-data-");
  const daemonHome = createTempDir("omp-desktop-smoke-daemon-home-");
  const daemonPort = await reserveLocalTcpPort();
  let cdpPort = await reserveLocalTcpPort();
  for (let attempt = 0; cdpPort === daemonPort && attempt < 10; attempt += 1) {
    cdpPort = await reserveLocalTcpPort();
  }
  if (cdpPort === daemonPort) {
    throw new Error("Failed to reserve distinct TCP ports for the daemon and CDP");
  }
  const listen = `127.0.0.1:${daemonPort}`;
  configureIsolatedDaemonHome(daemonHome, listen);
  const env = createIsolatedDesktopEnv({
    home: daemonHome,
    listen,
    userData,
    cdpPort,
  });

  const stdout = [];
  const stderr = [];
  const launch = getLaunchCommand(executablePath);
  console.log(`Packaged desktop smoke: launching ${launch.command} ${launch.args.join(" ")}`);
  const child = spawn(launch.command, launch.args, {
    detached: process.platform !== "win32",
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  child.once("error", (error) =>
    stderr.push(`Packaged app launch error: ${error.stack ?? error}\n`),
  );
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;

  let browser = null;
  let page = null;
  let daemonStopped = false;

  const stopDaemonForCleanup = async () => {
    if (daemonStopped) {
      return;
    }

    await stopCliDaemon({ appPath, env });
    daemonStopped = true;
  };

  try {
    browser = await connectToPackagedApp({
      child,
      cdpPort,
      stdout,
      stderr,
      userData,
      daemonHome,
      deadline,
    });
    page = await waitForPackagedAppPage(browser, deadline);
    await assertPackagedRendererLoaded(page, deadline);
    console.log("Packaged desktop smoke: real app renderer and preload bridge loaded");
    const status = await waitForRendererStartedDaemon({
      page,
      daemonHome,
      listen,
      stdout,
      stderr,
      userData,
      deadline,
    });
    console.log("Packaged desktop smoke: renderer-started desktop daemon reported running");
    assertDarwinDockVisibility(child.pid, child.pid);
    await runShellCommand({
      script:
        process.platform === "win32"
          ? `start "" /wait ${shellQuoteCliArg(executablePath)}`
          : [launch.command, ...launch.args].map(shellQuoteCliArg).join(" "),
      env,
      label: "Second desktop instance",
    });
    const statusAfterRelaunch = await page.evaluate(() =>
      window.paseoDesktop.invoke("desktop_daemon_status"),
    );
    if (
      statusAfterRelaunch.status !== "running" ||
      statusAfterRelaunch.pid !== status.pid ||
      statusAfterRelaunch.serverId !== status.serverId
    ) {
      throw new Error("A second desktop instance stopped or replaced the primary daemon");
    }
    console.log("Packaged desktop smoke: second instance preserved the primary daemon");
    await smokeCliShim({ appPath, env });
    await smokeOmpRuntime({ appPath, env, executableName });
    await smokeCliTerminal({ appPath, env });
    await smokePetCreationHelper({ page, appPath, env });
    await stopDaemonForCleanup();
    console.log(
      `Packaged desktop smoke passed: real renderer and preload loaded; renderer-started desktop daemon pid ${status.pid}, listen ${status.listen}; CLI shim daemon status, terminal and pet installer lifetime smoke succeeded`,
    );
  } catch (error) {
    await writeFailureArtifacts({ page, stdout, stderr, userData, daemonHome, error }).catch(
      (artifactError) => {
        console.warn(`Packaged desktop smoke: failed to write failure artifacts: ${artifactError}`);
      },
    );
    if (!daemonStopped) {
      try {
        await stopDaemonForCleanup();
      } catch {}
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    if (isRunning(child)) {
      terminateChild(child);
      if (!(await waitForChildExit(child))) {
        terminateChild(child, "SIGKILL");
        await waitForChildExit(child);
      }
    }
    releaseChildHandles(child);
    await removeTempDir(userData);
    await removeTempDir(daemonHome);
  }
}

module.exports = {
  smokePackagedDesktopApp,
  smokePackagedSdkRuntime,
};

if (require.main === module) {
  const appIndex = process.argv.indexOf("--app");
  const appPath = appIndex >= 0 ? process.argv[appIndex + 1] : null;
  if (!appPath) {
    process.stderr.write(
      "Usage: node packages/desktop/e2e/packaged-app-smoke.js --app <packaged-app-directory>\n",
    );
    process.exit(2);
  }

  smokePackagedDesktopApp({ appPath }).catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
