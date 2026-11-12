const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { seedLegacyPluginProfile } = require("./folder-plugin-smoke.js");

function writeJson(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}
function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
async function waitForExit(child, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
  return child.exitCode !== null || child.signalCode !== null;
}

async function smokeMacOSPackagedApp({
  appPath, executableName, reserveLocalTcpPort, configureIsolatedDaemonHome,
  checkRenderer, runColdCli, runCliChecks, runPluginChecks, stopDaemon, assertDockVisibility,
  legacyProfile = false,
}) {
  assert.equal(process.platform, "darwin");
  appPath = path.resolve(appPath);
  const executable = path.join(appPath, "Contents/MacOS", executableName);
  fs.accessSync(executable, fs.constants.X_OK);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-mac-native-smoke-")));
  const evidenceBase = path.resolve(process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR?.trim() || os.tmpdir());
  const evidenceRelative = path.relative(appPath, evidenceBase);
  assert.ok(evidenceRelative === ".." || evidenceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(evidenceRelative),
    "Native evidence must stay outside the signed application");
  fs.mkdirSync(evidenceBase, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(evidenceBase, "omp-mac-native-evidence-"));
  const directories = Object.fromEntries(["profile", "userData", "daemonHome", "temporary", "control"].map(name => [name, path.join(root, name)]));
  Object.values(directories).forEach(directory => fs.mkdirSync(directory));
  const { profile, userData, daemonHome, temporary, control } = directories;
  const agent = path.join(profile, ".omp/agent");
  fs.mkdirSync(agent, { recursive: true });
  const emptyConfig = path.join(root, "config.yml");
  fs.writeFileSync(emptyConfig, "{}\n");
  const listen = `127.0.0.1:${await reserveLocalTcpPort()}`;
  configureIsolatedDaemonHome(daemonHome, listen);
  const legacyRecords = legacyProfile ? seedLegacyPluginProfile(userData, daemonHome) : [];
  const configFile = path.join(root, "native-smoke.json");
  const deadline = Date.now() + 480_000;
  writeJson(configFile, { root, control, evidence, deadline, driverPid: process.pid });
  const env = {
    PATH: `${path.join(appPath, "Contents/Resources/bin")}${path.delimiter}/usr/bin:/bin:/usr/sbin:/sbin`,
    SHELL: "/bin/zsh", LANG: "en_US.UTF-8", HOME: profile, CFFIXED_USER_HOME: profile,
    TMPDIR: `${temporary}${path.sep}`, TEMP: temporary, TMP: temporary,
    XDG_CONFIG_HOME: path.join(profile, ".config"), XDG_CACHE_HOME: path.join(profile, ".cache"),
    OMP_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, OMP_CONFIG_FILES: emptyConfig, PI_CONFIG_FILES: emptyConfig,
    OMP_DESKTOP_HOME: daemonHome, PASEO_HOME: daemonHome, PASEO_LISTEN: listen, PASEO_HOST: listen,
    OMP_ELECTRON_USER_DATA_DIR: userData, PASEO_DISABLE_APP_UPDATES: "1", PASEO_WEB_UI_ENABLED: "false",
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(__dirname, "macos-native-smoke-preload.cjs"))}`,
    OMP_DESKTOP_NATIVE_SMOKE_CONFIG: configFile, NO_COLOR: "1",
  };
  const logs = { stdout: [], stderr: [] };
  const report = { appPath, evidence, profile: legacyProfile ? "legacy" : "fresh", status: "running", checks: [] };
  console.log(`Packaged macOS native smoke evidence: ${evidence}`);
  let child;
  let command;
  let failure;
  try {
    await runColdCli({ appPath, env });
    child = spawn(executable, [], { env, cwd: profile, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => logs.stdout.push(chunk.toString()));
    child.stderr.on("data", chunk => logs.stderr.push(chunk.toString()));
    child.once("error", error => logs.stderr.push(error.stack || String(error)));
    let sequence = 0;
    command = async (request) => {
      const id = ++sequence;
      writeJson(path.join(control, `${id}.request.json`), request);
      const commandDeadline = Math.min(deadline, Date.now() + 30_000);
      while (Date.now() < commandDeadline) {
        const fatal = readJson(path.join(control, "failure.json"));
        if (fatal) throw new Error(fatal.error);
        const response = readJson(path.join(control, `${id}.response.json`));
        if (response) {
          if (!response.ok) throw new Error(response.error);
          return response.value;
        }
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Real packaged app exited: ${child.exitCode}/${child.signalCode}`);
        await delay(30);
      }
      throw new Error(`Native app command timed out: ${request.action}`);
    };
    const page = {
      evaluate: (fn, arg) => command({ action: "evaluate", source: `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})` }),
      waitForFunction: async (fn, arg, options) => {
        const end = Date.now() + options.timeout;
        while (Date.now() < end) {
          if (await page.evaluate(fn, arg)) return;
          await delay(100);
        }
        throw new Error("Actual packaged renderer did not satisfy its load condition");
      },
    };
    report.app = await command({ action: "inspect" });
    assert.equal(report.app.packaged, true);
    assert.equal(path.resolve(report.app.executable), executable);
    assert.equal(path.resolve(report.app.resources), path.join(appPath, "Contents/Resources"));
    assert.equal(fs.realpathSync(report.app.home), profile);
    assert.equal(fs.realpathSync(report.app.userData), userData);
    assert.equal(report.app.version, JSON.parse(fs.readFileSync(path.join(appPath, "Contents/Resources/app/package.json"), "utf8")).version);
    assert.ok(report.app.miniElectron, "The actual mini-electron runtime is required");
    const daemon = await checkRenderer({ page, daemonHome, listen, ...logs, userData, deadline });
    report.daemon = daemon;
    report.checks.push("real renderer, preload, isolated profile and renderer-started daemon");
    assertDockVisibility(child.pid, child.pid);
    const presentationDeadline = Date.now() + 60_000;
    do {
      report.presentation = await command({ action: "window-state" });
      report.renderer = await page.evaluate(() => ({
        title: document.title, text: document.body.innerText.slice(0, 3000),
        visibility: document.visibilityState, html: document.querySelector("#root")?.innerHTML.slice(0, 2000),
      }));
      if (report.presentation.visible && report.renderer.text.trim()) break;
      await delay(100);
    } while (Date.now() < presentationDeadline);
    assert.ok(report.presentation.visible && report.renderer.text.trim(), "Actual packaged window did not present visible React content");
    report.capture = await command({ action: "capture" });
    const secondary = spawn(executable, [], {
      env: { ...env, OMP_DESKTOP_NATIVE_SMOKE_SECONDARY: "1" }, cwd: profile, stdio: "ignore",
    });
    if (!(await waitForExit(secondary))) {
      secondary.kill("SIGKILL");
      await waitForExit(secondary);
      throw new Error("Second packaged instance did not hand off and exit");
    }
    assert.equal(secondary.exitCode, 0);
    const after = await page.evaluate(() => window.paseoDesktop.invoke("desktop_daemon_status"));
    assert.equal(after.status, "running");
    assert.equal(after.pid, daemon.pid);
    assert.equal(after.serverId, daemon.serverId);
    report.checks.push("second instance preserved primary daemon");
    report.cli = await runCliChecks({
      appPath, env, createTerminal: ({ cwd, name }) => command({ action: "terminal-create", cwd, name }),
    });
    report.checks.push("bundled SDK, CLI and native terminal");
    report.plugins = await runPluginChecks({ page, appPath, env, legacyRecords });
    report.pluginCapture = await command({ action: "capture" });
    report.checks.push("real settings folder installation, explicit enable, worker activation and client contribution RPC");
  } catch (error) {
    failure = error;
    if (command && child?.exitCode === null && child?.signalCode === null) {
      try {
        report.failureRenderer = await command({ action: "evaluate", source: `(async () => ({ url: location.href, title: document.title, text: document.body.innerText, html: document.querySelector('[data-testid="plugins-manager"]')?.outerHTML, plugins: await window.paseoDesktop.plugins.getSnapshot() }))()` });
      } catch (diagnosticError) {
        report.failureRendererError = diagnosticError.stack || String(diagnosticError);
      }
      try {
        if (report.capture?.path && fs.existsSync(report.capture.path)) {
          const initialPath = path.join(evidence, "initial-app.png");
          fs.copyFileSync(report.capture.path, initialPath);
          report.capture.path = initialPath;
        }
        report.failureCapture = await command({ action: "capture" });
      } catch (diagnosticError) {
        report.failureCaptureError = diagnosticError.stack || String(diagnosticError);
      }
    }
  } finally {
    const cleanupErrors = [];
    if (child) {
      if (command && child.exitCode === null && child.signalCode === null) {
        try { await command({ action: "quit" }); } catch (error) { cleanupErrors.push(error); }
        if (!(await waitForExit(child))) {
          cleanupErrors.push(new Error("Owned app failed its normal quit lifecycle"));
          child.kill("SIGKILL");
          await waitForExit(child);
        }
      }
      try { await stopDaemon({ appPath, env }); } catch (error) { cleanupErrors.push(error); }
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    if (cleanupErrors.length) failure = new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, "Native smoke or cleanup failed");
    report.status = failure ? "failed" : "passed";
    if (failure) report.error = failure.stack || String(failure);
    fs.writeFileSync(path.join(evidence, "stdout.log"), logs.stdout.join(""));
    fs.writeFileSync(path.join(evidence, "stderr.log"), logs.stderr.join(""));
    writeJson(path.join(evidence, "report.json"), report);
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (failure) throw failure;
  console.log(`Packaged macOS native smoke passed (${report.profile}): signed renderer, daemon, SDK, CLI, terminal and external folder plugin UI/service/RPC`);
  return report;
}

module.exports = { smokeMacOSPackagedApp };
