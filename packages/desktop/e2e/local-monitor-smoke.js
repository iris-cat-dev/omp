const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

// Real product controller, preloads, HTML, collector and worker in an owned official runtime.
// Synthetic numeric OMP logs only; no daemon, provider credentials or paid model request.
if (!process.versions.electron) {
  assert.equal(
    process.platform,
    "win32",
    "This native surface smoke targets Windows mini-electron",
  );
  const {
    isolatedEnvironment,
    nativeProfilePaths,
    reserveNativeEarlyProfile,
    cleanupNativeEarlyProfile,
    cleanupOwnedProcesses,
  } = require("./windows-native-packaged-smoke.js");
  const desktopRoot = path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "omp-local-monitor-"));
  let env, early;
  try {
    fs.copyFileSync(__filename, path.join(temporary, path.basename(__filename)));
    fs.copyFileSync(
      path.join(__dirname, "windows-native-monitor-save.ps1"),
      path.join(temporary, "windows-native-monitor-save.ps1"),
    );
    const runtime = fs.realpathSync(
      process.env.MINI_ELECTRON_DIST_PATH
        ? path.join(process.env.MINI_ELECTRON_DIST_PATH, "electron.exe")
        : require("@iriscat/mini-electron"),
    );
    const stagedRuntime = path.join(temporary, "runtime");
    fs.cpSync(path.dirname(runtime), stagedRuntime, { recursive: true, dereference: true });
    env = isolatedEnvironment({
      root: temporary,
      stagedApp: stagedRuntime,
      daemonHome: path.join(temporary, "daemon"),
      listen: "127.0.0.1:0",
      userData: path.join(temporary, "user-data"),
    });
    early = reserveNativeEarlyProfile(env);
    const metadata = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
    fs.writeFileSync(
      path.join(temporary, "package.json"),
      JSON.stringify({
        name: early.name,
        productName: early.name,
        version: metadata.version,
        main: path.basename(__filename),
      }),
    );
    env.OMP_MONITOR_SMOKE_ROOT = desktopRoot;
    env.OMP_MONITOR_SMOKE_PATHS = JSON.stringify(nativeProfilePaths(env));
    env.OMP_MONITOR_SMOKE_EARLY = JSON.stringify(early);
    env.OMP_MONITOR_SMOKE_EVIDENCE = path.resolve(
      process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR ||
        path.join(desktopRoot, "..", "..", ".dev", "local-monitor-native"),
    );
    const result = spawnSync(
      path.join(stagedRuntime, path.basename(runtime)),
      [`--app=${temporary}`],
      { cwd: temporary, env, encoding: "utf8", timeout: 360_000, windowsHide: false },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    process.exitCode = result.status === 0 ? 0 : 1;
  } finally {
    if (env) cleanupOwnedProcesses(temporary, env);
    if (early) cleanupNativeEarlyProfile(early);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
} else {
  runNative().catch((error) => {
    console.error(error);
    require("electron").app.exit(1);
  });
}

async function until(predicate, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${message}`);
}

async function evaluate(window, source, timeout = 20_000) {
  let timer;
  const { promise: deadline, reject } = Promise.withResolvers();
  timer = setTimeout(() => reject(new Error("Owned renderer evaluation timed out")), timeout);
  try {
    return await Promise.race([window.webContents.executeJavaScript(`(${source})`), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function runNative() {
  const { app, BrowserWindow, protocol, screen } = require("electron");
  assert.ok(
    process.versions.miniElectron,
    "Use the real mini-electron runtime, not stock Electron",
  );
  const root = path.resolve(__dirname);
  const early = JSON.parse(process.env.OMP_MONITOR_SMOKE_EARLY);
  const marker = JSON.parse(fs.readFileSync(early.marker, "utf8"));
  const earlyData = app.getPath("userData");
  const owned = (candidate) => {
    const relative = path.relative(root, path.resolve(candidate));
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  assert.ok(owned(earlyData) || path.relative(early.directory, earlyData) === "");
  assert.equal(path.basename(earlyData), early.name);
  assert.equal(app.getName(), early.name);
  assert.equal(marker.token, early.token);
  for (const [name, directory] of Object.entries(JSON.parse(process.env.OMP_MONITOR_SMOKE_PATHS))) {
    assert.ok(owned(directory), `Native ${name} must stay inside the disposable profile`);
    fs.mkdirSync(directory, { recursive: true });
    app.setPath(name, directory);
  }
  app.setName("OMP Local Monitor Native Smoke");
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "omp-desktop",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
  const desktopRoot = process.env.OMP_MONITOR_SMOKE_ROOT;
  const product = (relative) => require(path.join(desktopRoot, "dist", relative));
  const { MONITOR_HTML } = product("monitor/html.js");
  const { OmpMonitorController } = product("monitor/controller.js");
  const { registerMainWindow } = product("window/main-windows.js");
  const evidence = process.env.OMP_MONITOR_SMOKE_EVIDENCE;
  fs.mkdirSync(evidence, { recursive: true });
  const sessions = path.join(root, "sessions");
  const unavailableSessions = path.join(root, "sessions-unavailable");
  const bucket = path.join(sessions, "workspace-a");
  fs.mkdirSync(path.join(bucket, "main"), { recursive: true });
  fs.mkdirSync(path.join(sessions, "workspace-b"), { recursive: true });
  const fixtureNow = Date.now();
  const dateKey = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const yesterday = new Date(fixtureNow);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  const yesterdayKey = dateKey(yesterday);
  const header = (name) => ({
    type: "session",
    id: name,
    timestamp: new Date(yesterday.getTime() - 60_000).toISOString(),
    cwd: path.join(root, name),
  });
  const response = (
    id,
    output,
    { endAt = fixtureNow - 15_000, duration = 2_000, stopReason = "stop", content = [] } = {},
  ) => ({
    type: "message",
    id,
    timestamp: new Date(endAt).toISOString(),
    message: {
      role: "assistant",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-4.1",
      timestamp: endAt - duration,
      duration,
      ttft: 150,
      stopReason,
      content,
      usage: {
        input: 10,
        output,
        cacheRead: 2,
        cacheWrite: 3,
        totalTokens: output + 25,
        cost: { total: 0.012 },
      },
    },
  });
  const writeLines = (file, records) =>
    fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const mainFile = path.join(bucket, "main.jsonl");
  const childFile = path.join(bucket, "main", "child.jsonl");
  const otherFile = path.join(sessions, "workspace-b", "other.jsonl");
  writeLines(mainFile, [
    header("workspace-a"),
    response("yesterday-response", 700, { endAt: yesterday.getTime() }),
    response("main-response", 200),
  ]);
  writeLines(childFile, [
    header("workspace-a"),
    response("child-response", 100, {
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "tool-a", name: "read", arguments: {} }],
    }),
    {
      type: "message",
      id: "tool-result",
      timestamp: new Date(fixtureNow - 14_000).toISOString(),
      message: { role: "toolResult", toolCallId: "tool-a", toolName: "read", content: [] },
    },
  ]);
  writeLines(otherFile, [header("workspace-b"), response("other-response", 50)]);
  const originalFixtures = new Map(
    [mainFile, childFile, otherFile].map((file) => [file, fs.readFileSync(file)]),
  );
  let expectedRequests = 3;
  let expectedOutput = 350;
  let lastLiveEnd = 0;
  const append = (file, record) => fs.appendFileSync(file, JSON.stringify(record) + "\n");
  const appendCompletion = async (id, output, offset = 0) => {
    // Three-second numeric intervals end in the recent past. An unaligned case
    // distinguishes completion/event time from the measured bucket endpoint.
    // Discovery still comes from the real worker poll, never snapshot injection.
    await until(
      () => Math.floor(Date.now() / 1_000) * 1_000 + offset > lastLiveEnd,
      "a distinct real completion timestamp",
    );
    const endAt = Math.floor(Date.now() / 1_000) * 1_000 + offset;
    lastLiveEnd = endAt;
    append(mainFile, response(id, output, { endAt, duration: 3_000 }));
    expectedRequests++;
    expectedOutput += output;
    return endAt;
  };
  const cache = path.join(app.getPath("userData"), "local-monitor");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(
    path.join(cache, "pricing-settings.json"),
    JSON.stringify({ schema: 1, networkEnabled: false, currency: "USD" }),
  );
  await app.whenReady();
  protocol.handle("omp-desktop", (request) => {
    const url = new URL(request.url);
    if (url.hostname === "monitor" && url.pathname === "/local-monitor")
      return new Response(MONITOR_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    if (url.hostname === "app")
      return new Response("<!doctype html><title>Owned monitor smoke launcher</title>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    return new Response("Not found", { status: 404 });
  });
  const isolatedWebPreferences = (preload) => ({
    preload: path.join(desktopRoot, "dist", preload),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  });
  const main = new BrowserWindow({
    show: false,
    webPreferences: isolatedWebPreferences("preload.js"),
  });
  registerMainWindow(main);
  const createController = () => {
    const next = new OmpMonitorController({ roots: [{ path: sessions, label: "owned-fixture" }] });
    next.initialize();
    return next;
  };
  let controller = createController();
  const untrustedWindows = new Set();
  const motionWindows = new Set();
  const nativeObservers = new Map();
  const ownedDrivers = new Set();
  const report = {
    runtime: process.versions.miniElectron,
    nativeProfileIsolated: true,
    fixtures: "Synthetic numeric JSONL read by the production collector and worker",
    surfaceIdentification: "ompMonitor.ready().surface + instanceId; never BrowserWindow order",
    motionPreferencePath:
      "Owned renderer MediaQueryList fixture; no CDP or operating-system preference changes",
    inputEvidence: {
      globalMouseKeyboardClipboardUsed: false,
      physicalDraggingExercised: false,
      positionPath:
        "Owned BrowserWindow.setBounds plus real beginDrag/endDrag and persisted cold reopen",
      pointerPath: "Owned native pointer IPC coordinates; not physical cursor input",
      passthroughPath:
        "Win32 WindowFromPoint against a second owned runtime process; no injected clicks",
    },
    groups: [],
    captures: [],
    status: "running",
  };
  const group = async (name, work) => {
    const entry = { name, status: "running" };
    report.groups.push(entry);
    await work(entry);
    entry.status = "passed";
  };
  const state = (window) => evaluate(window, "window.ompMonitor.ready()");
  const invoke = (window, method, ...args) =>
    evaluate(window, `window.ompMonitor[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const views = async () => {
    const found = [];
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        window.isDestroyed() ||
        untrustedWindows.has(window) ||
        window.webContents.getURL() !== "omp-desktop://monitor/local-monitor"
      )
        continue;
      const view = await evaluate(
        window,
        "window.ompMonitor ? window.ompMonitor.ready() : null",
      ).catch((error) => {
        if (window.isDestroyed()) return null;
        throw error;
      });
      if (!view) continue;
      assert.ok(["orb", "dashboard", "history", "settings"].includes(view.surface));
      assert.equal(typeof view.instanceId, "string");
      assert.ok(view.instanceId.length > 0);
      found.push({ window, view });
    }
    const identities = found.map(({ view }) => `${view.surface}:${view.instanceId}`);
    assert.equal(new Set(identities).size, identities.length, "Surface identities must be unique");
    return found;
  };
  const waitView = async (surface, instanceId) => {
    let match;
    await until(
      async () => {
        match = (await views()).find(
          ({ view }) => view.surface === surface && (!instanceId || view.instanceId === instanceId),
        );
        return !!match;
      },
      `authorized ${surface} surface${instanceId ? ` for ${instanceId}` : ""}`,
    );
    await until(
      () =>
        evaluate(
          match.window,
          `document.body.dataset.surface === ${JSON.stringify(surface)} && document.getElementById(${JSON.stringify(`${surface}-surface`)})?.hidden === false`,
        ),
      `rendered ${surface} surface`,
    );
    return match.window;
  };
  const openPanel = async (orb, surface) => {
    const { instanceId } = await state(orb);
    await invoke(orb, "openSurface", surface);
    return waitView(surface, instanceId);
  };
  const click = (window, selector) =>
    evaluate(
      window,
      `(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node || node.disabled) throw new Error('Missing or disabled control: '+${JSON.stringify(selector)}); node.click(); })()`,
    );
  const select = async (window, id, value) => {
    window.show();
    window.focus();
    // Currency/project/theme options are populated after the numeric bridge state.
    // Keep this readiness check: setting value before the option exists is a no-op.
    await until(
      () =>
        evaluate(
          window,
          `(() => { const node=document.getElementById(${JSON.stringify(id)}); return !!node?.options && !node.disabled && Array.from(node.options).some(option=>option.value===${JSON.stringify(value)}); })()`,
        ),
      `rendered ${id} option ${value}`,
    );
    const selected = await evaluate(
      window,
      `(() => { const node=document.getElementById(${JSON.stringify(id)}); node.value=${JSON.stringify(value)}; node.dispatchEvent(new Event('change',{bubbles:true})); return node.value; })()`,
    );
    assert.equal(selected, value, `${id} must accept the selected option`);
  };
  const checkbox = async (window, id, checked) => {
    const result = await evaluate(
      window,
      `(() => { const node=document.getElementById(${JSON.stringify(id)}); if(!node || node.disabled || node.type!=='checkbox') throw new Error('Missing checkbox'); node.checked=${checked}; node.dispatchEvent(new Event('change',{bubbles:true})); return node.checked; })()`,
    );
    assert.equal(result, checked);
  };
  const configure = async (window, patch) => {
    await invoke(window, "configure", patch);
    await until(async () => {
      const current = await state(window);
      return Object.entries(patch).every(([key, value]) => current.preferences[key] === value);
    }, "accepted native preferences");
  };
  const page = async (settings, name) => {
    await click(settings, `#nav-${name}`);
    await until(
      () =>
        evaluate(
          settings,
          `document.getElementById(${JSON.stringify(`page-${name}`)}).hidden === false`,
        ),
      `settings ${name} page`,
    );
  };
  const expectUsage = async (window, requests, output) => {
    await until(async () => {
      const view = await state(window);
      return (
        view.snapshot?.status === "ready" &&
        !view.refreshing &&
        !view.workerError &&
        view.snapshot.today.requests === requests &&
        view.snapshot.today.outputTokens === output
      );
    }, `real collector totals ${requests} requests / ${output} output`);
    return (await state(window)).snapshot;
  };
  const expectSource = async (dashboard, output, requests) => {
    await until(
      () =>
        evaluate(
          dashboard,
          `(() => { const output=document.getElementById('today-output'), requests=document.getElementById('today-requests'), source=document.getElementById('source-today'); const fmt=new Intl.NumberFormat(document.documentElement.lang,{maximumFractionDigits:0}); return output.title===fmt.format(${output}) && requests.title===fmt.format(${requests}) && !document.getElementById('source-omp').hidden && source.textContent.startsWith(output.textContent+' · ') && !source.textContent.includes('—'); })()`,
        ),
      "scoped numeric dashboard and OMP source-row consumer results",
    );
  };
  const expectRejected = async (window, source, pattern) => {
    const result = await evaluate(
      window,
      `(async()=>{try{await (${source});return {rejected:false};}catch(error){return {rejected:true,error:String(error)};}})()`,
    );
    assert.equal(result.rejected, true, `Native operation must reject: ${source}`);
    if (pattern) assert.match(result.error, pattern);
    return result.error;
  };
  const closeView = async (window, selector) => {
    const closing = (selector ? click(window, selector) : invoke(window, "close")).then(
      () => null,
      (error) => error,
    );
    await until(() => window.isDestroyed(), "owned surface actually closes");
    const error = await closing;
    if (error && !/renderer closed|destroyed|disposed/i.test(String(error))) throw error;
  };
  const closeAll = async (origin) => {
    const current = await views();
    const closing = invoke(origin, "closeAll").catch((error) => {
      if (!/renderer closed|destroyed|disposed/i.test(String(error))) throw error;
    });
    await until(
      () => current.every(({ window }) => window.isDestroyed()),
      "all owned monitor surfaces close",
    );
    await closing;
    assert.deepEqual(await views(), []);
  };
  const fixtureMotion = async (window, reduced) => {
    motionWindows.add(window);
    // mini-electron has no stock-Electron CDP media override. Control only this
    // owned page's cached platform query, then exercise its real change listener.
    await evaluate(
      window,
      `(() => {
      const query=reducedMotion;
      if(!window.__ownedMotionFixture){
        const descriptor=Object.getOwnPropertyDescriptor(query,'matches');
        window.__ownedMotionFixture={restore(){
          if(descriptor)Object.defineProperty(query,'matches',descriptor);else delete query.matches;
          query.dispatchEvent(new MediaQueryListEvent('change',{media:query.media,matches:query.matches}));
          delete window.__ownedMotionFixture;
        }};
      }
      Object.defineProperty(query,'matches',{configurable:true,get:()=>${reduced}});
      query.dispatchEvent(new MediaQueryListEvent('change',{media:query.media,matches:query.matches}));
    })()`,
    );
    await until(
      () => evaluate(window, `reducedMotion.matches === ${reduced}`),
      "owned reduced-motion preference fixture",
    );
  };
  const nativeHandle = (window) => {
    const handle = window.getNativeWindowHandle();
    return (
      handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())
    ).toString();
  };
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const runOwnedPowerShell = (args, env, timeout, label) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        powershell,
        args,
        { encoding: "utf8", windowsHide: true, timeout, env: { ...process.env, ...env } },
        (error, stdout, stderr) => {
          ownedDrivers.delete(child);
          if (error) {
            reject(new Error(`${label}: ${stderr || error.message}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (parseError) {
            reject(new Error(`${label} returned invalid JSON: ${String(parseError)}`));
          }
        },
      );
      ownedDrivers.add(child);
    });
  const nativeToken = randomUUID();
  fs.writeFileSync(
    path.join(root, ".omp-monitor-native-owner.json"),
    JSON.stringify({ root, token: nativeToken }),
  );
  const startInputBackdrop = async (window) => {
    const bounds = window.getBounds();
    const directory = path.join(root, "input-backdrop");
    const ready = path.join(directory, "ready.json");
    fs.mkdirSync(path.join(directory, "user-data"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: `omp-monitor-input-${nativeToken}`, main: "index.cjs" }),
    );
    fs.writeFileSync(
      path.join(directory, "fixture.json"),
      JSON.stringify({
        // Padding keeps both probe pixels inside the backdrop's opaque client
        // interior, not Win11's compositor-rounded outer window corners.
        bounds: {
          x: bounds.x - 32,
          y: bounds.y - 32,
          width: bounds.width + 64,
          height: bounds.height + 64,
        },
        ready,
        token: nativeToken,
        userData: path.join(directory, "user-data"),
      }),
    );
    fs.writeFileSync(
      path.join(directory, "index.cjs"),
      String.raw`
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");
const fixture = require("./fixture.json");
app.setPath("userData", fixture.userData);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    ...fixture.bounds, minWidth:1, minHeight:1, show:false, frame:false,
    focusable:false, skipTaskbar:true, alwaysOnTop:true, backgroundColor:"#14365a",
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}
  });
  window.once("closed", () => app.exit(0));
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
    "<!doctype html><title>Owned input backdrop</title><style>body{margin:0;background:#14365a}</style>"
  ));
  window.showInactive();
  const handle = window.getNativeWindowHandle();
  if(handle.length !== 8) throw new Error("Expected owned Windows x64 handle");
  fs.writeFileSync(fixture.ready + ".pending", JSON.stringify({
    token:fixture.token, pid:process.pid, handle:handle.readBigUInt64LE().toString()
  }));
  fs.renameSync(fixture.ready + ".pending", fixture.ready);
}).catch(error => { console.error(error); app.exit(1); });
`,
    );
    const child = spawn(process.execPath, [`--app=${directory}`], {
      cwd: directory,
      env: process.env,
      stdio: "ignore",
      windowsHide: false,
    });
    ownedDrivers.add(child);
    child.once("close", () => ownedDrivers.delete(child));
    let launchError;
    child.once("error", (error) => {
      launchError = error;
    });
    await until(
      () => {
        if (launchError) throw launchError;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error("Owned input backdrop exited before becoming ready");
        return fs.existsSync(ready);
      },
      "second owned runtime input backdrop",
      20_000,
    );
    const info = JSON.parse(fs.readFileSync(ready, "utf8"));
    assert.equal(info.token, nativeToken);
    assert.equal(info.pid, child.pid);
    assert.notEqual(
      info.pid,
      process.pid,
      "Input backdrop must use a different native GUI thread/process",
    );
    const backdrop = { ...info, child };
    window.hide();
    try {
      backdrop.baseline = await inspectNative(window, false, backdrop);
      assert.equal(backdrop.baseline.pointTarget, "backdrop");
      assert.ok(
        pixelDelta(backdrop.baseline.centerPixel, backdrop.baseline.cornerPixel) <= 1,
        "Owned backdrop must paint a uniform opaque baseline under both probe points",
      );
      await evaluate(
        window,
        `(() => {
        const fixture=window.__ownedInputWarmup={point:null};
        fixture.off=window.ompMonitor.onPointer(point=>{fixture.point=point;fixture.off();});
      })()`,
      );
    } finally {
      window.showInactive();
    }
    window.setAlwaysOnTop(false);
    window.setAlwaysOnTop(true);
    await until(
      () => evaluate(window, "window.__ownedInputWarmup.point !== null"),
      "fresh native pointer poll after restoring the owned orb",
      3_000,
    );
    await evaluate(window, "delete window.__ownedInputWarmup");
    return backdrop;
  };
  const stopInputBackdrop = async ({ child }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await until(
      () => child.exitCode !== null || child.signalCode !== null,
      "owned input backdrop process exits",
      5_000,
    );
  };
  const pixelDelta = (left, right) =>
    Math.max(
      Math.abs((left & 255) - (right & 255)),
      Math.abs(((left >>> 8) & 255) - ((right >>> 8) & 255)),
      Math.abs(((left >>> 16) & 255) - ((right >>> 16) & 255)),
    );
  const inspectNative = (window, cancelMenu = false, backdrop = null) => {
    // Only owned HWNDs are read, hit-tested, or sent WM_CANCELMODE. Point routing
    // is compared with a separate owned process without inspecting foreign HWNDs.
    // No global input, clipboard, cursor changes, or unrelated-window enumeration.
    const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$root=[IO.Path]::GetFullPath($env:OMP_MONITOR_NATIVE_ROOT)
$marker=Get-Content -LiteralPath (Join-Path $root '.omp-monitor-native-owner.json') -Raw | ConvertFrom-Json
if($marker.root -ne $root -or $marker.token -ne $env:OMP_MONITOR_NATIVE_TOKEN){throw 'Owned native observer token mismatch'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedMonitorWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] public struct GuiInfo { public uint size,flags; public IntPtr active,focus,capture,menuOwner,moveSize,caret; public Rect caretRect; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll",SetLastError=true)] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static void PhysicalCoordinates(){if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero)throw new InvalidOperationException("Owned observer cannot establish physical screen coordinates");}
  [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hwnd,IntPtr dc);
  [DllImport("gdi32.dll")] private static extern uint GetPixel(IntPtr dc,int x,int y);
  public static uint ScreenPixel(int x,int y){var dc=GetDC(IntPtr.Zero);if(dc==IntPtr.Zero)throw new InvalidOperationException("Owned pixel DC unavailable");try{var pixel=GetPixel(dc,x,y);if(pixel==uint.MaxValue)throw new InvalidOperationException("Owned screen pixel unavailable");return pixel;}finally{ReleaseDC(IntPtr.Zero,dc);}}
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] private static extern IntPtr Long64(IntPtr hwnd,int index);
  [DllImport("user32.dll",EntryPoint="GetWindowLongW")] private static extern int Long32(IntPtr hwnd,int index);
  public static long ExtendedStyle(IntPtr hwnd){return IntPtr.Size==8?Long64(hwnd,-20).ToInt64():Long32(hwnd,-20);}
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread,ref GuiInfo info);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  public static IntPtr RootAt(int x,int y){var point=new Point{x=x,y=y};return GetAncestor(WindowFromPoint(point),2);}
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
  [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW",SetLastError=true)] private static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam,uint flags,uint timeout,out IntPtr result);
  public static long HitTest(IntPtr hwnd,int x,int y){
    var point=new IntPtr(unchecked((int)((uint)(ushort)x|((uint)(ushort)y<<16))));
    IntPtr result;
    if(SendMessageTimeout(hwnd,0x84,IntPtr.Zero,point,2,2000,out result)==IntPtr.Zero)throw new InvalidOperationException("Owned WM_NCHITTEST query failed");
    return result.ToInt64();
  }
}
'@
[OwnedMonitorWindow]::PhysicalCoordinates()
$owner=[IntPtr]::new([long]$env:OMP_MONITOR_NATIVE_HWND)
if(-not [OwnedMonitorWindow]::IsWindow($owner)){throw 'Owned native observer HWND is closed'}
[uint32]$ownerPid=0
$thread=[OwnedMonitorWindow]::GetWindowThreadProcessId($owner,[ref]$ownerPid)
$runtime=[IO.Path]::GetFullPath((Join-Path $root 'runtime'))+[IO.Path]::DirectorySeparatorChar
if(-not ([IO.Path]::GetFullPath((Get-Process -Id $ownerPid).Path)).StartsWith($runtime,[StringComparison]::OrdinalIgnoreCase)){throw 'Native observer target is not from the disposable runtime'}
$ownedMenu=$false
$cancelPosted=$false
if($env:OMP_MONITOR_NATIVE_CANCEL -eq '1'){
  $deadline=[DateTime]::UtcNow.AddSeconds(12)
  while([DateTime]::UtcNow -lt $deadline){
    $info=New-Object OwnedMonitorWindow+GuiInfo
    $info.size=[Runtime.InteropServices.Marshal]::SizeOf($info)
    if([OwnedMonitorWindow]::GetGUIThreadInfo($thread,[ref]$info) -and $info.menuOwner -ne [IntPtr]::Zero -and ($info.menuOwner -eq $owner -or [OwnedMonitorWindow]::GetAncestor($info.menuOwner,3) -eq $owner)){$ownedMenu=$true;break}
    Start-Sleep -Milliseconds 50
  }
  if(-not $ownedMenu){throw 'No native menu belonging to the exact owned HWND was observed; no dismissal sent'}
  $cancelPosted=[OwnedMonitorWindow]::PostMessage($owner,31,[IntPtr]::Zero,[IntPtr]::Zero)
  if(-not $cancelPosted){throw 'Owned menu cancellation could not be posted'}
}
$rect=New-Object OwnedMonitorWindow+Rect
if(-not [OwnedMonitorWindow]::GetWindowRect($owner,[ref]$rect)){throw 'Owned native window bounds unavailable'}
$extended=[OwnedMonitorWindow]::ExtendedStyle($owner)
$x=[int]($rect.left+($rect.right-$rect.left)/2)
$y=[int]($rect.top+($rect.right-$rect.left)/2)
$hit=[OwnedMonitorWindow]::HitTest($owner,$x,$y)
$styleTransparent=(($extended -band 32)-ne 0)
$pointTarget='not-probed'
$centerPixel=$null
$cornerPixel=$null
if($env:OMP_MONITOR_NATIVE_BACKDROP_HWND){
  $backdrop=[IntPtr]::new([long]$env:OMP_MONITOR_NATIVE_BACKDROP_HWND)
  if(-not [OwnedMonitorWindow]::IsWindow($backdrop)){throw 'Owned input backdrop HWND is closed'}
  [uint32]$backdropPid=0
  [void][OwnedMonitorWindow]::GetWindowThreadProcessId($backdrop,[ref]$backdropPid)
  if($backdropPid -ne [uint32]$env:OMP_MONITOR_NATIVE_BACKDROP_PID -or $backdropPid -eq $ownerPid){throw 'Owned input backdrop PID mismatch'}
  if(-not ([IO.Path]::GetFullPath((Get-Process -Id $backdropPid).Path)).StartsWith($runtime,[StringComparison]::OrdinalIgnoreCase)){throw 'Input backdrop is not from the disposable runtime'}
  $backdropRect=New-Object OwnedMonitorWindow+Rect
  if(-not [OwnedMonitorWindow]::GetWindowRect($backdrop,[ref]$backdropRect) -or $rect.left -lt $backdropRect.left -or $rect.right -gt $backdropRect.right -or $rect.top -lt $backdropRect.top -or $rect.bottom -gt $backdropRect.bottom){throw 'Owned input backdrop does not cover the complete probe viewport'}
  $target=[OwnedMonitorWindow]::RootAt($x,$y)
  if($target -eq $owner){$pointTarget='orb'}elseif($target -eq $backdrop){$pointTarget='backdrop'}else{$pointTarget='other'}
  $corner=[OwnedMonitorWindow]::RootAt($rect.left+2,$rect.top+2)
  if($pointTarget -eq 'other' -or ($corner -ne $owner -and $corner -ne $backdrop)){throw 'Owned viewport is occluded by another window; no screen pixels read'}
  $centerPixel=[OwnedMonitorWindow]::ScreenPixel($x,$y)
  $cornerPixel=[OwnedMonitorWindow]::ScreenPixel($rect.left+2,$rect.top+2)
}
[pscustomobject]@{ownerVerified=$true;visible=[OwnedMonitorWindow]::IsWindowVisible($owner);styleTransparent=$styleTransparent;hitTest=$hit;inputTransparent=($styleTransparent -or $hit -eq -1);pointTarget=$pointTarget;centerPixel=$centerPixel;cornerPixel=$cornerPixel;topmost=(($extended -band 8)-ne 0);layered=(($extended -band 524288)-ne 0);ownedNativeMenu=$ownedMenu;cancelPosted=$cancelPosted;rect=$rect}|ConvertTo-Json -Compress
`;
    return runOwnedPowerShell(
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        OMP_MONITOR_NATIVE_ROOT: root,
        OMP_MONITOR_NATIVE_TOKEN: nativeToken,
        OMP_MONITOR_NATIVE_HWND: nativeHandle(window),
        OMP_MONITOR_NATIVE_CANCEL: cancelMenu ? "1" : "0",
        OMP_MONITOR_NATIVE_BACKDROP_HWND: backdrop?.handle ?? "",
        OMP_MONITOR_NATIVE_BACKDROP_PID: backdrop ? String(backdrop.pid) : "",
      },
      20_000,
      "Owned native observer failed",
    );
  };
  const observeNativeInput = (window) => {
    let observer = nativeObservers.get(window);
    if (observer) return observer.calls;
    const original = window.setIgnoreMouseEvents;
    const calls = [];
    window.setIgnoreMouseEvents = function (...args) {
      const result = original.apply(this, args);
      calls.push({ ignore: args[0], forward: args[1]?.forward === true, at: Date.now() });
      return result;
    };
    observer = { original, calls };
    nativeObservers.set(window, observer);
    return calls;
  };
  const artFacts = (window, hostId = "orb-art") =>
    evaluate(
      window,
      `(() => {
        const host=document.getElementById(${JSON.stringify(hostId)});
        if(!host?.classList.contains('as-orb-art')) return null;
        const paint=host.querySelector('.as-orb-paint'),fx=host.querySelector('.as-orb-fx'),canvas=host.querySelector('.as-orb-gl');
        const alphaCount=c=>{if(!c || !c.width || !c.height)return 0;const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let positive=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>0)positive++;return positive;};
        const usesGpu=getComputedStyle(canvas).display!=='none',gl=usesGpu?canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:false,powerPreference:'low-power'}):null,program=gl?.getParameter(gl.CURRENT_PROGRAM);
        const uniform=name=>{const location=program&&gl.getUniformLocation(program,name);if(location===null||!program)return null;const value=gl.getUniform(program,location);return typeof value==='number'?value:Array.from(value||[]);};
        return {
          style:host.dataset.style,appearance:host.dataset.appearance,static:host.dataset.static,embedded:host.dataset.embedded,
          opacity:Number(getComputedStyle(host).opacity),viewport:{width:innerWidth,height:innerHeight},size:Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--orb-size')),
          host:{width:host.getBoundingClientRect().width,height:host.getBoundingClientRect().height},
          errors:Array.from(document.querySelectorAll('.as-orb-render-error,[data-render-error]'),node=>({text:node.textContent,error:node.dataset.renderError,hidden:node.hidden,display:getComputedStyle(node).display})),
          paintAlpha:alphaCount(paint),fxAlpha:alphaCount(fx),
          gpu:usesGpu?{context:!!gl,lost:gl?.isContextLost(),linked:!!program&&gl.getProgramParameter(program,gl.LINK_STATUS),error:gl?.getError(),resolution:uniform('uRes'),heat:uniform('uH'),effects:uniform('uFx'),moving:uniform('uMoving'),peak:uniform('uPeak'),waves:uniform('uWaves')}:null,
          peakAnimations:host.querySelector('.as-orb-peak').getAnimations().filter(animation=>animation.playState==='running').length,
          nameplate:{hidden:document.getElementById('orb-nameplate').hidden,text:document.getElementById('orb-name').textContent}
        };
      })()`,
    );
  const expectArt = async (window, { style, appearance, static: isStatic, host = "orb-art" }) => {
    let facts;
    await until(async () => {
      facts = await artFacts(window, host);
      const painted =
        style === "led" || style === "liquid" ? facts?.gpu?.linked : (facts?.paintAlpha ?? 0) > 0;
      return (
        facts &&
        (facts.errors.length > 0 ||
          (facts.style === style &&
            facts.appearance === appearance &&
            (isStatic === undefined || facts.static === String(isStatic)) &&
            painted))
      );
    }, `real ${style} ${appearance} art`);
    assert.deepEqual(
      facts.errors,
      [],
      "GPU failure labels are failures even when a later style hides them",
    );
    if (style === "led" || style === "liquid") {
      assert.equal(facts.gpu?.context, true, "Original LED/liquid must obtain real WebGL 2");
      assert.equal(facts.gpu.lost, false);
      assert.equal(facts.gpu.linked, true, "The real instrument shader must link and be current");
      assert.equal(facts.gpu.error, 0, "The real instrument draw must not leave a GL error");
      assert.ok(facts.gpu.resolution.every((value) => value > 0));
    } else {
      assert.ok(facts.paintAlpha > 0, "Native canvas instrument must actually paint pixels");
    }
    return facts;
  };
  const observeGpu = (window) =>
    evaluate(
      window,
      `(() => {
    const prototype=HTMLCanvasElement.prototype,original=prototype.getContext,contexts=new Map();
    prototype.getContext=function(type,...args){
      const context=Reflect.apply(original,this,[type,...args]);
      if(type==='webgl2'&&context)contexts.set(context,this);
      return context;
    };
    window.__ownedGpuObserver={contexts,restore(){prototype.getContext=original;contexts.clear();}};
  })()`,
    );
  const observedGpuFacts = (window) =>
    evaluate(
      window,
      `(() => {
    return Array.from(window.__ownedGpuObserver.contexts,([gl,canvas])=>{
      const lost=gl.isContextLost(),program=lost?null:gl.getParameter(gl.CURRENT_PROGRAM);
      return {detached:!canvas.isConnected,lost,error:lost?null:gl.getError(),linked:!!program&&gl.getProgramParameter(program,gl.LINK_STATUS),width:canvas.width,height:canvas.height};
    });
  })()`,
    );
  const meanNativeAlpha = async (window) => {
    const pixels = (await window.webContents.capturePage()).toBitmap();
    let alpha = 0;
    for (let index = 3; index < pixels.length; index += 4) alpha += pixels[index];
    return alpha / (pixels.length / 4);
  };
  const capture = async (window, name, transparentOrb = false) => {
    assert.match(name, /^[a-z0-9-]+\.png$/);
    const view = await state(window);
    const viewport = await evaluate(window, "({width:innerWidth,height:innerHeight})");
    const image = await window.webContents.capturePage();
    const size = image.getSize();
    assert.ok(size.width > 0 && size.height > 0, "Native pixels must be nonempty");
    const entry = { name, surface: view.surface, instanceId: view.instanceId, size, viewport };
    if (transparentOrb) {
      assert.equal(
        view.surface,
        "orb",
        "Transparent captures must be the actual separate orb page",
      );
      const pixels = image.toBitmap();
      assert.equal(pixels.length, size.width * size.height * 4);
      const sx = size.width / viewport.width;
      const sy = size.height / viewport.height;
      assert.ok(Math.abs(sx - sy) < 0.03, "Native capture scale must preserve the actual viewport");
      const alpha = (x, y) => pixels[(y * size.width + x) * 4 + 3];
      for (const [cx, cy] of [
        [0, 0],
        [size.width - 4, 0],
        [0, size.height - 4],
        [size.width - 4, size.height - 4],
      ])
        for (let y = cy; y < cy + 4; y++)
          for (let x = cx; x < cx + 4; x++)
            assert.equal(
              alpha(x, y),
              0,
              "True transparent native orb corners must remain alpha zero",
            );
      const disc = view.preferences.size;
      let positive = 0;
      let sampled = 0;
      let annulusPositive = 0;
      let annulusSampled = 0;
      for (let y = 0; y < size.height; y++)
        for (let x = 0; x < size.width; x++) {
          const dx = (x + 0.5) / sx - 0.75 * disc;
          const dy = (y + 0.5) / sy - 0.75 * disc;
          const radiusSquared = dx * dx + dy * dy;
          if (radiusSquared <= 0.25 * disc * disc) {
            sampled++;
            positive += Number(alpha(x, y) > 0);
          }
          // Outside the center HTML readout: this must be actual shader/canvas
          // instrument pixels, not text making a blank GL canvas look successful.
          if (radiusSquared >= 0.16 * disc * disc && radiusSquared <= 0.2304 * disc * disc) {
            annulusSampled++;
            annulusPositive += Number(alpha(x, y) > 0);
          }
        }
      assert.ok(
        positive > sampled * 0.02,
        "Positive disc pixels must come from the actual rendered art",
      );
      assert.ok(
        annulusPositive > annulusSampled * 0.25,
        "The actual outer instrument, not only its HTML readout, must paint pixels",
      );
      entry.alpha = {
        corners: 0,
        positiveDiscPixels: positive,
        sampledDiscPixels: sampled,
        positiveInstrumentAnnulusPixels: annulusPositive,
        sampledInstrumentAnnulusPixels: annulusSampled,
      };
      entry.art = await expectArt(window, {
        style: view.preferences.style,
        appearance: view.preferences.appearance,
      });
    }
    fs.writeFileSync(path.join(evidence, name), image.toPNG());
    report.captures.push(entry);
    return { image, entry };
  };
  const captureNameplate = async (window, name) => {
    const bounds = await evaluate(
      window,
      `(() => { const plate=document.getElementById('orb-nameplate'),r=plate.getBoundingClientRect();return {hidden:plate.hidden,text:document.getElementById('orb-name').textContent,x:r.x,y:r.y,width:r.width,height:r.height,viewport:{width:innerWidth,height:innerHeight}}; })()`,
    );
    assert.equal(bounds.hidden, false);
    assert.ok(bounds.text.startsWith("workspace-"));
    assert.ok(bounds.width > 20 && bounds.height >= 16);
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= bounds.viewport.width + 1);
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= bounds.viewport.height + 1);
    const image = await window.webContents.capturePage();
    const size = image.getSize();
    const sx = size.width / bounds.viewport.width;
    const sy = size.height / bounds.viewport.height;
    const cropped = image.crop({
      x: Math.max(0, Math.floor(bounds.x * sx)),
      y: Math.max(0, Math.floor(bounds.y * sy)),
      width: Math.max(1, Math.floor(bounds.width * sx)),
      height: Math.max(1, Math.floor(bounds.height * sy)),
    });
    const bitmap = cropped.toBitmap();
    assert.ok(bitmap.some((value, index) => index % 4 === 3 && value > 0));
    fs.writeFileSync(path.join(evidence, name), cropped.toPNG());
    const view = await state(window);
    report.captures.push({
      name,
      surface: "orb-nameplate",
      instanceId: view.instanceId,
      placement: view.nameplatePlacement,
      bounds,
    });
  };
  const armEffects = async (window) => {
    await evaluate(
      window,
      `(() => {
        if(window.__ownedArtProbe?.timer)clearInterval(window.__ownedArtProbe.timer);
        const probe=window.__ownedArtProbe={samples:0,pulse:false,peak:false,fx:false,stationaryRing:false,pill:false,pillMotion:false,static:true,errors:[]};
        const sample=()=>{
          const host=document.getElementById('orb-art'),canvas=host?.querySelector('.as-orb-gl'),fx=host?.querySelector('.as-orb-fx'),paint=host?.querySelector('.as-orb-paint');if(!host||document.hidden)return;
          probe.samples++;probe.static=probe.static&&host.dataset.static==='true';
          for(const node of document.querySelectorAll('.as-orb-render-error,[data-render-error]'))probe.errors.push(node.dataset.renderError||node.textContent);
          if(canvas&&getComputedStyle(canvas).display!=='none'){
            const gl=canvas.getContext('webgl2'),program=gl?.getParameter(gl.CURRENT_PROGRAM);
            const uniform=name=>{const location=program&&gl.getUniformLocation(program,name);return location===null||!program?null:gl.getUniform(program,location);};
            const waves=uniform('uWaves'),peak=uniform('uPeak');if(waves)for(let i=0;i<waves.length;i+=4)if(waves[i]>=0&&waves[i]<1)probe.pulse=true;
            if(peak!==null&&peak>=0&&peak<1.8)probe.peak=true;
          }
          if(fx?.width){const data=fx.getContext('2d').getImageData(0,0,fx.width,fx.height).data;for(let i=3;i<data.length;i+=4)if(data[i]>0){probe.fx=true;break;}}
          if(paint?.width&&!probe.stationaryRing){
            const data=paint.getContext('2d').getImageData(0,0,paint.width,paint.height).data,S=paint.width/1.5,c=paint.width/2,lo=(.51*S)**2,hi=(.56*S)**2;
            outer:for(let y=Math.max(0,Math.floor(c-.56*S));y<Math.min(paint.height,Math.ceil(c+.56*S));y++)
              for(let x=Math.max(0,Math.floor(c-.56*S));x<Math.min(paint.width,Math.ceil(c+.56*S));x++){
                const r2=(x+.5-c)**2+(y+.5-c)**2;
                if(r2>=lo&&r2<=hi&&data[(y*paint.width+x)*4+3]>0){probe.stationaryRing=true;break outer;}
              }
          }
          for(const animation of host.querySelector('.as-orb-peak')?.getAnimations()||[]){
            if(animation.playState!=='running')continue;probe.pill=true;
            const keyframes=animation.effect.getKeyframes();
            for(const property of ['transform','translate','scale','rotate','left','top'])
              if(keyframes.some(frame=>frame[property]!==keyframes[0]?.[property]))probe.pillMotion=true;
          }
        };
        sample();probe.timer=setInterval(sample,25);probe.stop=setTimeout(()=>{clearInterval(probe.timer);probe.timer=null;},8000);
      })()`,
    );
  };
  const effectsResult = async (window, stop = false) =>
    evaluate(
      window,
      `(() => { const p=window.__ownedArtProbe;if(!p)return null;${stop ? "clearInterval(p.timer);clearTimeout(p.stop);p.timer=null;" : ""}return {samples:p.samples,pulse:p.pulse,peak:p.peak,fx:p.fx,stationaryRing:p.stationaryRing,pill:p.pill,pillMotion:p.pillMotion,static:p.static,errors:p.errors}; })()`,
    );
  const waitActivity = async (orb, baseline, { response: responseChanged, peak: peakChanged }) => {
    await until(
      async () => {
        const current = await state(orb);
        return (
          current.snapshot?.today.requests === expectedRequests &&
          current.snapshot.today.outputTokens === expectedOutput &&
          current.activity.responseSequence ===
            baseline.responseSequence + Number(responseChanged) &&
          current.activity.peakSequence === baseline.peakSequence + Number(peakChanged)
        );
      },
      "real collector completion and native activity sequences",
      8_000,
    );
    const current = await state(orb);
    assert.equal(current.snapshot.activity.lastResponseAt, lastLiveEnd);
    assert.equal(current.activity.lastResponseAt, lastLiveEnd);
    if (peakChanged) {
      assert.equal(
        current.activity.lastPeakAt,
        current.snapshot.activity.peakObservedAt,
        "Native peak event freshness must use the contributing completion, not a future bucket endpoint",
      );
      assert.equal(current.activity.lastPeakAt, lastLiveEnd);
    }
    return current;
  };
  const parseCsv = (text) => {
    assert.equal(text.charCodeAt(0), 0xfeff, "Native export must retain UTF-8 BOM");
    const records = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let i = 1; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        if (quoted && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = !quoted;
      } else if (!quoted && (c === "," || c === "\n")) {
        row.push(cell);
        cell = "";
        if (c === "\n") {
          records.push(row);
          row = [];
        }
      } else if (c !== "\r" || quoted) cell += c;
    }
    if (cell || row.length) records.push([...row, cell]);
    assert.equal(quoted, false);
    const columns = records.shift();
    assert.ok(columns.includes("output_tokens") && columns.includes("range_start"));
    return records
      .filter((record) => record.some(Boolean))
      .map((record) => {
        assert.equal(record.length, columns.length);
        return Object.fromEntries(columns.map((column, index) => [column, record[index]]));
      });
  };
  const saveNativeCsv = async (window, { name, range, ui = false }) => {
    const token = randomUUID();
    const destination = path.join(root, `monitor-export-${randomUUID()}.csv`);
    assert.ok(owned(destination));
    assert.equal(fs.existsSync(destination), false);
    fs.writeFileSync(
      path.join(root, ".omp-monitor-export-owner.json"),
      JSON.stringify({ token, root }),
    );
    const current = (await state(window)).snapshot;
    const exporting = evaluate(
      window,
      ui
        ? `(async()=>{document.getElementById('export').click();const deadline=Date.now()+25000;while(Date.now()<deadline){const text=document.getElementById('toast').textContent;if(text)return text;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('No selected-date export consumer result');})()`
        : "window.ompMonitor.exportCsv()",
      35_000,
    );
    const native = runOwnedPowerShell(
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "windows-native-monitor-save.ps1"),
      ],
      {
        OMP_MONITOR_EXPORT_ROOT: root,
        OMP_MONITOR_EXPORT_PATH: destination,
        OMP_MONITOR_EXPORT_TOKEN: token,
        OMP_MONITOR_EXPORT_OWNER: nativeHandle(window),
        OMP_MONITOR_EXPORT_DEFAULT: `omp-monitor-${range?.startDate ?? new Date(current.updatedAt).toISOString().slice(0, 10)}.csv`,
      },
      25_000,
      "Owned native save-dialog driver failed",
    );
    const [result, confirmation] = await Promise.all([exporting, native]);
    assert.equal(result, ui ? "CSV saved for the selected dates, scope and coverage." : "saved");
    assert.equal(confirmation.ownedNativeDialog, true);
    assert.equal(confirmation.destinationOwned, true);
    assert.equal(confirmation.filenameControlMatched, true);
    assert.equal(confirmation.saveButtonActivated, true);
    const csv = fs.readFileSync(destination, "utf8");
    const rows = parseCsv(csv);
    assert.ok(rows.length > 0, "Native Save must produce consumer-readable numeric rows");
    fs.copyFileSync(destination, path.join(evidence, name));
    return { rows, native: confirmation, name };
  };
  let first;
  let second;
  let dashboard;
  let history;
  let settings;
  let firstId;
  let secondId;
  let projectA;
  let projectB;
  let persisted;
  try {
    await group(
      "Isolation, exact main preload, owned surface identities and sender rejection",
      async (entry) => {
        await main.loadURL("omp-desktop://app/local-monitor-smoke");
        await evaluate(main, "window.paseoDesktop.monitor.open()");
        dashboard = await waitView("dashboard");
        firstId = (await state(dashboard)).instanceId;
        first = await waitView("orb", firstId);
        const initial = await expectUsage(first, 3, 350);
        assert.equal(initial.today.totalTokens, 425);
        assert.equal(initial.agents.filter((agent) => agent.kind === "subagent").length, 1);
        assert.equal(initial.pricing.networkEnabled, false);
        assert.equal(initial.pricing.currencies.length, 38);
        assert.ok(initial.today.estimatedCostUsd > 0);
        assert.equal((await state(first)).activity.responseSequence, 0);
        assert.equal((await state(first)).activity.peakSequence, 0);
        assert.equal((await state(first)).maxWindows, 8);
        assert.equal((await state(first)).windowCount, 1);
        const disc = (await state(first)).preferences.size;
        const expectedViewport = {
          width: Math.ceil(1.5 * disc),
          height: Math.ceil(1.5 * disc + 32),
        };
        const nativeBounds = first.getBounds();
        entry.initialOrbGeometry = {
          bounds: nativeBounds,
          viewport: await evaluate(first, "({width:innerWidth,height:innerHeight})"),
        };
        assert.deepEqual(
          { width: nativeBounds.width, height: nativeBounds.height },
          expectedViewport,
          "Native minimum sizing must not enlarge the transparent orb",
        );
        assert.deepEqual(
          entry.initialOrbGeometry.viewport,
          expectedViewport,
          "The actual initial WebView must fit the original orb viewport, not a default 400-pixel surface",
        );
        assert.equal((await state(dashboard)).surface, "dashboard");
        assert.equal(
          await evaluate(first, "document.getElementById('orb-nameplate').hidden"),
          true,
          "Original automatic nameplate stays hidden for a single unscoped orb",
        );
        projectA = initial.scopes.projects.find((project) => project.startsWith("workspace-a "));
        projectB = initial.scopes.projects.find((project) => project.startsWith("workspace-b "));
        assert.ok(projectA && projectB && projectA !== projectB);
        await expectSource(dashboard, 350, 3);
        const before = (await views())
          .map(({ view }) => `${view.surface}:${view.instanceId}`)
          .sort();
        for (const preload of ["preload.js", "monitor/preload.js"]) {
          const rogue = new BrowserWindow({
            show: false,
            webPreferences: isolatedWebPreferences(preload),
          });
          untrustedWindows.add(rogue);
          try {
            await rogue.loadURL(
              preload === "preload.js"
                ? "omp-desktop://app/unregistered"
                : "omp-desktop://monitor/local-monitor",
            );
            if (preload === "preload.js")
              await expectRejected(
                rogue,
                "window.paseoDesktop.monitor.open()",
                /main application window/,
              );
            else {
              for (const source of [
                "window.ompMonitor.ready()",
                "window.ompMonitor.configure({style:'needle'})",
                "window.ompMonitor.newWindow()",
                "window.ompMonitor.openSurface('settings')",
                "window.ompMonitor.exportCsv()",
                "window.ompMonitor.closeAll()",
              ])
                await expectRejected(rogue, source, /Unauthorized monitor sender/);
            }
            assert.deepEqual(
              (await views()).map(({ view }) => `${view.surface}:${view.instanceId}`).sort(),
              before,
            );
          } finally {
            rogue.destroy();
            untrustedWindows.delete(rogue);
          }
        }
        await evaluate(main, "window.paseoDesktop.monitor.open()");
        assert.equal(await waitView("orb", firstId), first);
        assert.equal(await waitView("dashboard", firstId), dashboard);
        entry.surfaceIdentity = { orb: firstId, dashboard: firstId };
        entry.source = { requests: 3, outputTokens: 350, totalTokens: 425, subagents: 1 };
      },
    );
    await group("Original four separate surfaces and real guarded full CSV Save", async (entry) => {
      await click(dashboard, "#open-settings");
      settings = await waitView("settings", firstId);
      await observeGpu(settings);
      await page(settings, "general");
      await select(settings, "language", "en");
      await select(settings, "appearance", "dark");
      await page(settings, "effects");
      await select(settings, "effects", "off");
      await configure(first, { nameMode: "always", opacity: 1 });
      await fixtureMotion(first, false);
      await fixtureMotion(dashboard, false);
      await click(dashboard, "#source-omp");
      history = await waitView("history", firstId);
      for (const window of [first, dashboard, history, settings]) {
        assert.equal(await evaluate(window, "typeof require"), "undefined");
        assert.equal(await evaluate(window, "typeof process"), "undefined");
        const view = await state(window);
        assert.equal(view.instanceId, firstId);
        assert.equal(view.windowCount, 1, "Panels must never consume the eight-orb budget");
        assert.equal(
          await evaluate(
            window,
            "Array.from(document.querySelectorAll('section[id$=\"-surface\"]')).filter(node=>!node.hidden).map(node=>node.id).join(',')",
          ),
          `${view.surface}-surface`,
        );
      }
      const full = await saveNativeCsv(dashboard, { name: "native-export-full.csv" });
      const today = full.rows.find((row) => row.section === "today");
      assert.equal(Number(today.requests), 3);
      assert.equal(Number(today.output_tokens), 350);
      assert.equal(Number(today.total_tokens), 425);
      assert.equal(today.profile, "all");
      assert.equal(today.project, "all");
      assert.ok(full.rows.some((row) => row.section === "resources"));
      assert.ok(
        full.rows.some(
          (row) =>
            row.section === "daily" &&
            row.date === yesterdayKey &&
            Number(row.output_tokens) === 700,
        ),
      );
      await capture(dashboard, "original-dashboard-dark.png");
      await capture(history, "original-history-dark.png");
      await page(settings, "general");
      await capture(settings, "original-settings-dark.png");
      entry.export = { name: full.name, native: full.native };
      entry.surfaces = (await views()).map(({ view }) => ({
        surface: view.surface,
        instanceId: view.instanceId,
        orbCount: view.windowCount,
      }));
    });
    await group(
      "Five real transparent instruments, nine title themes and dark/porcelain surfaces",
      async (entry) => {
        await page(settings, "orb");
        const styles = await evaluate(
          settings,
          "Array.from(document.querySelectorAll('#style-cards button[role=\"radio\"][data-style]'),node=>node.dataset.style)",
        );
        const themes = await evaluate(
          settings,
          "Array.from(document.getElementById('title-theme').options,option=>option.value)",
        );
        assert.deepEqual(styles.slice().sort(), ["led", "liquid", "minimal", "needle", "reactor"]);
        assert.deepEqual(themes.slice().sort(), [
          "animals",
          "cultivation",
          "engineer",
          "gameRank",
          "mage",
          "space",
          "vehicles",
          "wind",
          "wuxia",
        ]);
        for (const appearance of ["dark", "light"]) {
          await configure(settings, { appearance, effects: "off" });
          for (const style of styles) {
            await click(settings, `#style-${style}`);
            await until(
              async () => (await state(first)).preferences.style === style,
              `native ${style} preference`,
            );
            assert.equal(
              await evaluate(
                settings,
                `document.getElementById(${JSON.stringify(`style-${style}`)}).getAttribute('aria-checked')`,
              ),
              "true",
            );
            await expectArt(first, { style, appearance, static: true });
            await capture(
              first,
              `original-orb-${style}-${appearance === "light" ? "porcelain" : "dark"}.png`,
              true,
            );
          }
          await expectArt(dashboard, { style: "led", appearance, static: true, host: "hero-art" });
          await capture(
            dashboard,
            `original-dashboard-${appearance === "light" ? "porcelain" : "dark"}-hero.png`,
          );
          await capture(
            history,
            `original-history-${appearance === "light" ? "porcelain" : "dark"}-panel.png`,
          );
          await page(settings, "general");
          await capture(
            settings,
            `original-settings-${appearance === "light" ? "porcelain" : "dark"}-panel.png`,
          );
          await page(settings, "orb");
        }
        await configure(settings, {
          appearance: "dark",
          style: "liquid",
          redline: 100,
          effects: "off",
        });
        await expectArt(first, { style: "liquid", appearance: "dark", static: true });
        await capture(first, "original-liquid-readout-surface-split.png", true);
        await configure(settings, { redline: 2000, style: "led" });
        await page(settings, "general");
        for (const theme of themes) {
          await click(settings, `#theme-${theme}`);
          await until(
            async () => (await state(first)).preferences.titleTheme === theme,
            `native ${theme} title theme`,
          );
          assert.equal(
            await evaluate(
              settings,
              `document.getElementById(${JSON.stringify(`theme-${theme}`)}).getAttribute('aria-checked')`,
            ),
            "true",
          );
          assert.equal(
            await evaluate(
              first,
              `agentSpeedVisuals.themes[${JSON.stringify(theme)}].en.includes(document.querySelector('#orb-art .as-orb-title').textContent)`,
            ),
            true,
            "Accepted title theme must reach the actual floating readout",
          );
        }
        await select(settings, "language", "zh");
        await configure(first, { appearance: "dark", style: "led", titleTheme: "cultivation" });
        await until(
          () => evaluate(dashboard, "document.documentElement.lang === 'zh-CN'"),
          "Chinese native surfaces",
        );
        await capture(dashboard, "original-dashboard-zh.png");
        await capture(settings, "original-settings-zh.png");
        await select(settings, "language", "en");
        entry.styles = styles;
        entry.titleThemes = themes;
        entry.appearances = ["dark", "light (original porcelain)"];
      },
    );
    await group(
      "Real measured completion/peak consumers, four effect levels, reduced motion and Off",
      async (entry) => {
        await page(settings, "effects");
        const choices = await evaluate(
          settings,
          "Array.from(document.getElementById('effects').options,option=>option.value)",
        );
        assert.deepEqual(choices, ["off", "soft", "standard", "max"]);
        for (const effects of choices) {
          await select(settings, "effects", effects);
          await until(
            async () => (await state(first)).preferences.effects === effects,
            `native ${effects} effects`,
          );
          await expectArt(first, { style: "led", appearance: "dark", static: effects === "off" });
          assert.equal(await evaluate(dashboard, "document.body.dataset.effects"), effects);
        }
        await expectArt(first, { style: "led", appearance: "dark", static: false });
        assert.equal(
          (await artFacts(first)).peakAnimations,
          0,
          "Opening/configuration must not celebrate old records",
        );
        let baseline = (await state(first)).activity;
        await armEffects(first);
        const completionAt = await appendCompletion("live-measured-completion", 30);
        await waitActivity(first, baseline, { response: true, peak: false });
        await until(
          async () => (await effectsResult(first)).pulse,
          "real completion wave reaches the original GLSL",
          3_000,
        );
        const completion = await effectsResult(first, true);
        assert.equal(completion.peak, false);
        assert.equal(completion.pill, false);
        assert.deepEqual(completion.errors, []);
        await capture(first, "original-measured-completion.png", true);
        await delay(1_000);
        baseline = (await state(first)).activity;
        const oldPeak = (await state(first)).snapshot.today.peakOutputTps;
        await armEffects(first);
        const peakAt = await appendCompletion("live-measured-peak", 12_000, -250);
        const peakView = await waitActivity(first, baseline, { response: true, peak: true });
        assert.ok(peakView.snapshot.today.peakOutputTps > oldPeak);
        assert.ok(peakView.snapshot.rate.measuredTps > 0);
        assert.notEqual(
          peakView.snapshot.activity.peakAt,
          peakView.activity.lastPeakAt,
          "The unaligned measured fixture must exercise distinct measurement and event timestamps",
        );
        await until(
          async () => {
            const probe = await effectsResult(first);
            return probe.pulse && probe.peak && probe.pill && probe.fx;
          },
          "actual measured-peak waves, particle pixels and animated original peak pill",
          3_000,
        );
        const peak = await effectsResult(first, true);
        assert.deepEqual(peak.errors, []);
        assert.equal(
          peak.pillMotion,
          true,
          "The normal-motion fixture positively exercises the pill movement probe",
        );
        const hero = await artFacts(dashboard, "hero-art");
        assert.equal(hero.gpu.effects, 1, "Original dashboard hero must stay capped at Soft");
        await capture(first, "original-measured-peak-effects.png", true);
        await capture(dashboard, "original-dashboard-measured-peak.png");
        for (const window of [first, dashboard, settings]) await fixtureMotion(window, true);
        await expectArt(first, { style: "led", appearance: "dark", static: true });
        await until(
          async () => (await artFacts(first)).gpu.moving === 0,
          "actual reduced-motion shader frame",
        );
        assert.equal(
          await evaluate(settings, "document.getElementById('reduced-motion-note').hidden"),
          false,
        );
        baseline = (await state(first)).activity;
        await armEffects(first);
        assert.equal(
          (await effectsResult(first)).stationaryRing,
          false,
          "The reduced-motion fixture begins without stale ring feedback",
        );
        await appendCompletion("reduced-motion-measured-peak", 24_000);
        await waitActivity(first, baseline, { response: true, peak: true });
        await until(
          async () => {
            const probe = await effectsResult(first);
            entry.reducedMotion = probe;
            return probe.stationaryRing && probe.pill;
          },
          "reduced motion retains stationary response feedback and a crossfading new-peak notification",
          3_000,
        );
        const reduced = await effectsResult(first, true);
        assert.ok(reduced.samples > 1);
        assert.equal(reduced.static, true);
        assert.equal(
          reduced.pulse,
          false,
          "Reduced motion replaces the expanding shader wave with stationary canvas feedback",
        );
        assert.equal(
          reduced.fx,
          false,
          "Reduced motion suppresses the moving lightning/particle overlay",
        );
        assert.equal(reduced.peak, false, "Reduced motion suppresses the moving LED peak sweep");
        assert.equal(
          reduced.pillMotion,
          false,
          "Reduced motion must not translate or scale its peak notification",
        );
        assert.equal((await artFacts(first)).gpu.moving, 0);
        assert.deepEqual(reduced.errors, []);
        await capture(first, "original-reduced-motion.png", true);
        for (const window of [first, dashboard, settings]) await fixtureMotion(window, false);
        await select(settings, "effects", "off");
        await expectArt(first, { style: "led", appearance: "dark", static: true });
        baseline = (await state(first)).activity;
        await armEffects(first);
        await appendCompletion("effects-off-measured-peak", 48_000);
        await waitActivity(first, baseline, { response: true, peak: true });
        await until(
          async () => (await effectsResult(first)).pill,
          "explicit Off retains the original independent new-peak notice",
          3_000,
        );
        const off = await effectsResult(first, true);
        assert.ok(off.samples > 1);
        assert.equal(off.static, true);
        for (const key of ["pulse", "peak", "fx", "stationaryRing", "pillMotion"])
          assert.equal(off[key], false, `Explicit Off must suppress ${key}`);
        assert.deepEqual(off.errors, []);
        await capture(first, "original-effects-off.png", true);
        // An in-flight user entry creates a real estimate, not a completion event.
        await select(settings, "effects", "max");
        await delay(1_900);
        baseline = (await state(first)).activity;
        await armEffects(first);
        append(mainFile, {
          type: "message",
          id: "estimated-only-start",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: [] },
        });
        await until(
          async () => (await state(first)).snapshot.rate.estimatedTps > 0,
          "real collector in-flight estimate",
          5_000,
        );
        assert.deepEqual(
          (await state(first)).activity,
          baseline,
          "Estimated-only observations must not manufacture completion/peak events",
        );
        const estimate = await effectsResult(first, true);
        assert.equal(estimate.pulse, false);
        assert.equal(estimate.peak, false);
        assert.equal(estimate.pill, false);
        await select(settings, "effects", "off");
        for (const file of [mainFile, childFile, otherFile])
          append(file, {
            type: "custom",
            customType: "session_exit",
            id: `owned-exit-${path.basename(file)}`,
            timestamp: new Date().toISOString(),
          });
        await until(async () => {
          const snapshot = (await state(first)).snapshot;
          return (
            snapshot.agents.every((agent) => agent.phase === "idle") &&
            snapshot.rate.estimatedTps === 0
          );
        }, "actual collector idle transition stops estimates");
        entry.effectChoices = choices;
        entry.completion = { at: completionAt, ...completion };
        entry.peak = {
          at: peakAt,
          measuredPeakTps: peakView.snapshot.today.peakOutputTps,
          ...peak,
        };
        entry.reducedMotion = reduced;
        entry.off = off;
        entry.estimatedOnly = estimate;
        entry.activitySource =
          "Appended numeric records -> production collector -> native activity bridge -> actual art uniforms/pixels/animations";
      },
    );
    await group(
      "Two project orbs, exact source totals and shared panel scope retargeting",
      async (entry) => {
        await page(settings, "orb");
        const existingIds = new Set(
          (await views())
            .filter(({ view }) => view.surface === "orb")
            .map(({ view }) => view.instanceId),
        );
        await click(settings, "#new-window");
        let newId;
        await until(async () => {
          newId = (await views()).find(
            ({ view }) => view.surface === "orb" && !existingIds.has(view.instanceId),
          )?.view.instanceId;
          return !!newId;
        }, "a distinct second orb identity");
        secondId = newId;
        second = await waitView("orb", secondId);
        await expectUsage(second, expectedRequests, expectedOutput);
        const originalPanels = { dashboard, history, settings };
        settings = await openPanel(second, "settings");
        assert.equal(
          settings,
          originalPanels.settings,
          "The original native settings panel must retarget, not duplicate",
        );
        await page(settings, "orb");
        await select(settings, "project", projectB);
        await expectUsage(second, 1, 50);
        assert.equal((await state(first)).snapshot.today.outputTokens, expectedOutput);
        dashboard = await openPanel(second, "dashboard");
        assert.equal(dashboard, originalPanels.dashboard);
        await expectSource(dashboard, 50, 1);
        await click(dashboard, "#source-omp");
        history = await waitView("history", secondId);
        assert.equal(history, originalPanels.history);
        assert.equal(
          await evaluate(history, "document.getElementById('history-project').value"),
          projectB,
        );
        await select(history, "history-project", projectA);
        await expectUsage(second, expectedRequests - 1, expectedOutput - 50);
        await expectSource(dashboard, expectedOutput - 50, expectedRequests - 1);
        await select(history, "history-project", projectB);
        await expectUsage(second, 1, 50);
        settings = await openPanel(first, "settings");
        await page(settings, "orb");
        await select(settings, "profile", "owned-fixture");
        await select(settings, "project", projectA);
        await expectUsage(first, expectedRequests - 1, expectedOutput - 50);
        assert.deepEqual((await state(second)).scope, { profile: null, project: projectB });
        dashboard = await openPanel(first, "dashboard");
        history = await openPanel(first, "history");
        await expectSource(dashboard, expectedOutput - 50, expectedRequests - 1);
        assert.equal((await state(history)).instanceId, firstId);
        assert.equal((await state(settings)).instanceId, firstId);
        await configure(first, { style: "liquid", size: 196, opacity: 0.82, nameMode: "always" });
        await configure(second, { style: "minimal", size: 112, opacity: 1, nameMode: "always" });
        assert.equal(
          (await state(first)).preferences.style,
          "liquid",
          "Styles and sizes belong to an individual orb",
        );
        assert.equal((await state(first)).preferences.size, 196);
        assert.equal((await state(second)).preferences.size, 112);
        await configure(first, { opacity: 1, fadeWhenIdle: false, clickThrough: true });
        await expectArt(first, { style: "liquid", appearance: "dark", static: true });
        await until(
          () =>
            evaluate(
              first,
              "Number(getComputedStyle(document.getElementById('orb-art')).opacity)===1",
            ),
          "full rendered opacity",
        );
        const fullAlpha = await meanNativeAlpha(first);
        await configure(first, { opacity: 0.82 });
        await until(
          () =>
            evaluate(
              first,
              "Number(getComputedStyle(document.getElementById('orb-art')).opacity)===0.82",
            ),
          "dimmed rendered opacity",
        );
        const dimmedAlpha = await meanNativeAlpha(first);
        const opacityRatio = dimmedAlpha / fullAlpha;
        assert.ok(
          Math.abs(opacityRatio - 0.82) < 0.04,
          `Opacity must be applied once to actual rendered pixels; ratio=${opacityRatio}`,
        );
        entry.opacity = { fullAlpha, dimmedAlpha, ratio: opacityRatio };
        await configure(first, { clickThrough: false });
        await expectArt(second, { style: "minimal", appearance: "dark", static: true });
        await capture(first, "original-project-a-orb.png", true);
        await capture(second, "original-project-b-orb.png", true);
        await captureNameplate(first, "original-project-a-nameplate.png");
        await captureNameplate(second, "original-project-b-nameplate.png");
        entry.orbs = [
          {
            instanceId: firstId,
            project: projectA,
            requests: expectedRequests - 1,
            outputTokens: expectedOutput - 50,
          },
          { instanceId: secondId, project: projectB, requests: 1, outputTokens: 50 },
        ];
        entry.sharedPanelsRetargetedWithoutReplacement = true;
      },
    );
    await group(
      "Original visibility toggle, native pin/click-through/hit policy and owned native menu",
      async (entry) => {
        await checkbox(dashboard, "orb-visible", false);
        await until(
          async () => !(await state(first)).orbVisible && !first.isVisible(),
          "native orb hides while dashboard survives",
        );
        assert.equal(first.isDestroyed(), false);
        assert.equal(dashboard.isVisible(), true);
        assert.equal(history.isDestroyed(), false);
        assert.equal(second.isVisible(), true);
        await checkbox(dashboard, "orb-visible", true);
        await until(
          async () => (await state(first)).orbVisible && first.isVisible(),
          "native orb reappears",
        );
        await page(settings, "orb");
        await checkbox(settings, "pin", false);
        assert.equal(
          (await inspectNative(first)).topmost,
          false,
          "Native pin clears on the actual owned HWND",
        );
        await checkbox(settings, "pin", true);
        const nativePinned = await inspectNative(first);
        assert.equal(nativePinned.ownerVerified, true);
        assert.equal(nativePinned.topmost, true);
        const calls = observeNativeInput(first);
        const pointer = async (point, hovered) => {
          first.webContents.send("paseo:monitor:pointer", point);
          await until(
            () =>
              evaluate(
                first,
                `document.getElementById('orb-surface').dataset.hovered === ${JSON.stringify(String(hovered))}`,
              ),
            "real pointer bridge hit policy",
            3_000,
          );
        };
        const backdrop = await startInputBackdrop(first);
        try {
          const size = (await state(first)).preferences.size;
          await pointer({ x: 0, y: 0 }, false);
          await pointer({ x: 0.75 * size, y: 0.75 * size }, true);
          entry.backdrop = backdrop.baseline;
          entry.nativeInteractive = await inspectNative(first, false, backdrop);
          assert.equal(
            entry.nativeInteractive.inputTransparent,
            false,
            "The actual owned disc must accept hits before enabling click-through",
          );
          assert.equal(
            entry.nativeInteractive.pointTarget,
            "orb",
            "Positive control routes to the interactive orb",
          );
          assert.ok(
            pixelDelta(entry.nativeInteractive.cornerPixel, backdrop.baseline.cornerPixel) <= 3,
            "Interactive orb corners remain transparent within compositor quantization",
          );
          assert.ok(
            pixelDelta(entry.nativeInteractive.centerPixel, backdrop.baseline.centerPixel) >= 16,
            "Interactive orb remains visibly painted above the owned backdrop",
          );
          await pointer({ x: 0, y: 0 }, false);
          entry.transparentCorner = await inspectNative(first, false, backdrop);
          assert.equal(
            entry.transparentCorner.pointTarget,
            "backdrop",
            "Transparent orb margin must pass native hits through",
          );
          const plate = await evaluate(
            first,
            "(() => {const r=document.getElementById('orb-nameplate').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()",
          );
          await pointer({ x: plate.x + plate.width / 2, y: plate.y + plate.height / 2 }, true);
          entry.nameplateHit = await inspectNative(first, false, backdrop);
          assert.equal(
            entry.nameplateHit.pointTarget,
            "orb",
            "Visible nameplate must enable native input",
          );
          await pointer({ x: plate.x + 0.1, y: plate.y + 0.1 }, false);
          entry.nameplateCorner = await inspectNative(first, false, backdrop);
          assert.equal(
            entry.nameplateCorner.pointTarget,
            "backdrop",
            "Rounded nameplate corner must remain click-through",
          );
          await checkbox(settings, "click-through", true);
          await until(
            async () => (await state(first)).preferences.clickThrough,
            "accepted native click-through preference",
          );
          const nativeClickThrough = await inspectNative(first, false, backdrop);
          entry.clickThrough = nativeClickThrough;
          assert.equal(
            nativeClickThrough.inputTransparent,
            true,
            "The actual owned HWND must reject hits while click-through is enabled",
          );
          assert.equal(
            nativeClickThrough.pointTarget,
            "backdrop",
            "Click-through must reach a different owned process beneath the visible orb",
          );
          assert.ok(
            pixelDelta(nativeClickThrough.cornerPixel, backdrop.baseline.cornerPixel) <= 3,
            "Click-through preserves actual compositor transparency",
          );
          assert.ok(
            pixelDelta(nativeClickThrough.centerPixel, backdrop.baseline.centerPixel) >= 16,
            "Click-through must not hide the instrument",
          );
          await invoke(first, "setInteractive", true);
          await state(first);
          entry.clickThroughOverride = await inspectNative(first, false, backdrop);
          assert.equal(
            entry.clickThroughOverride.pointTarget,
            "backdrop",
            "Native click-through must override a renderer interactivity request",
          );
          assert.equal(
            await evaluate(first, "document.getElementById('orb-surface').dataset.clickThrough"),
            "true",
          );
          await expectRejected(first, "window.ompMonitor.beginDrag()", /cannot drag/);
          await expectRejected(dashboard, "window.ompMonitor.beginDrag()", /cannot drag/);
          await checkbox(settings, "click-through", false);
          await until(
            async () => !(await state(first)).preferences.clickThrough,
            "click-through can be disabled from settings",
          );
        } finally {
          await stopInputBackdrop(backdrop);
        }
        // Observe and cancel the exact owned OS popup, not recursive SDK
        // template-construction counts or mocked menu forwarding.
        const cancellation = inspectNative(first, true);
        const nativeMenu = (await Promise.all([invoke(first, "showMenu"), cancellation]))[1];
        assert.equal(nativeMenu.ownedNativeMenu, true);
        assert.equal(nativeMenu.cancelPosted, true);
        assert.equal(first.isDestroyed(), false);
        entry.visibility = "Original dashboard toggle hides only its own orb";
        entry.pin = nativePinned;
        entry.nativeIgnoreCalls = calls.map(({ ignore, forward }) => ({ ignore, forward }));
        entry.nativeMenu = nativeMenu;
      },
    );
    await group(
      "Settings-only selection and recovery of a hidden click-through secondary orb",
      async (entry) => {
        const originalSettings = settings;
        const firstScope = (await state(first)).scope;
        const secondScope = (await state(second)).scope;
        await configure(second, { clickThrough: true });
        await invoke(second, "setOrbVisible", false);
        await until(
          async () => !second.isVisible() && !(await state(second)).orbVisible,
          "secondary orb is actually hidden",
        );
        const summaries = (await state(settings)).orbs;
        assert.equal(summaries.length, 2);
        const hidden = summaries.find((orb) => orb.instanceId === secondId);
        assert.ok(hidden);
        assert.equal(hidden.visible, false);
        assert.equal(hidden.clickThrough, true);
        assert.equal(hidden.style, "minimal");
        assert.equal(hidden.size, 112);
        assert.deepEqual(hidden.scope, secondScope);
        const nativeHidden = await inspectNative(second);
        assert.equal(nativeHidden.visible, false);
        for (const window of [first, dashboard, history])
          await expectRejected(window, `window.ompMonitor.selectOrb(${JSON.stringify(secondId)})`);
        await expectRejected(
          settings,
          "window.ompMonitor.selectOrb('not-an-owned-monitor-instance')",
        );
        assert.equal((await state(settings)).instanceId, firstId);
        await page(settings, "orb");
        await until(
          () =>
            evaluate(
              settings,
              "document.querySelectorAll('#orb-list [role=\"option\"]').length===2",
            ),
          "both real orb management options render",
        );
        await click(settings, '#orb-list [role="option"]:nth-child(2)');
        settings = await waitView("settings", secondId);
        assert.equal(
          settings,
          originalSettings,
          "Orb management must retarget the existing settings panel",
        );
        await page(settings, "orb");
        await until(
          () =>
            evaluate(
              settings,
              `document.getElementById('settings-orb-name').textContent===${JSON.stringify(projectB)} && document.getElementById('project').value===${JSON.stringify(projectB)} && !document.getElementById('settings-orb-visible').checked && document.getElementById('click-through').checked`,
            ),
          "settings consumers expose the hidden secondary orb and its click-through state",
        );
        await capture(settings, "original-settings-hidden-secondary.png");
        await checkbox(settings, "settings-orb-visible", true);
        await checkbox(settings, "click-through", false);
        await until(async () => {
          const current = await state(second);
          return second.isVisible() && current.orbVisible && !current.preferences.clickThrough;
        }, "settings controls recover the actual secondary orb");
        const calls = observeNativeInput(second);
        const size = (await state(second)).preferences.size;
        second.webContents.send("paseo:monitor:pointer", { x: 0, y: 0 });
        await until(
          () =>
            evaluate(second, "document.getElementById('orb-surface').dataset.hovered==='false'"),
          "recovered orb receives transparent-point pointer state",
        );
        const mark = calls.length;
        second.webContents.send("paseo:monitor:pointer", { x: size * 0.75, y: size * 0.75 });
        await until(
          () => calls.slice(mark).some((call) => !call.ignore),
          "recovered secondary disc enables real native input",
        );
        assert.deepEqual((await state(first)).scope, firstScope);
        assert.deepEqual((await state(second)).scope, secondScope);
        assert.equal((await state(first)).orbVisible, true);
        assert.equal((await state(first)).preferences.clickThrough, false);
        assert.equal((await state(dashboard)).instanceId, firstId);
        assert.equal((await state(history)).instanceId, firstId);
        const recovered = (await state(settings)).orbs.find((orb) => orb.instanceId === secondId);
        assert.equal(recovered.visible, true);
        assert.equal(recovered.clickThrough, false);
        await capture(settings, "original-settings-recovered-secondary.png");
        await capture(second, "original-recovered-secondary-orb.png", true);
        await click(settings, '#orb-list [role="option"]:first-child');
        settings = await waitView("settings", firstId);
        await page(settings, "orb");
        await until(
          () =>
            evaluate(
              settings,
              `document.getElementById('project').value===${JSON.stringify(projectA)}`,
            ),
          "settings returns to the original orb",
        );
        entry.hidden = hidden;
        entry.nativeHidden = nativeHidden;
        entry.recovered = recovered;
        entry.settingsNativeWindowReused = true;
        entry.nonSettingsSendersRejected = true;
        entry.recoveredNativeInput = calls
          .slice(mark)
          .map(({ ignore, forward }) => ({ ignore, forward }));
      },
    );
    await group("Eight-orb capacity independent of three shared panels", async (entry) => {
      const extras = [];
      for (let index = 0; index < 6; index++) {
        const before = new Set(
          (await views())
            .filter(({ view }) => view.surface === "orb")
            .map(({ view }) => view.instanceId),
        );
        await invoke(first, "newWindow");
        let added;
        await until(async () => {
          added = (await views()).find(
            ({ view }) => view.surface === "orb" && !before.has(view.instanceId),
          );
          return !!added;
        }, "new independently identified orb");
        extras.push(added.window);
      }
      const all = await views();
      assert.equal(all.filter(({ view }) => view.surface === "orb").length, 8);
      assert.deepEqual(
        all
          .filter(({ view }) => view.surface !== "orb")
          .map(({ view }) => view.surface)
          .sort(),
        ["dashboard", "history", "settings"],
      );
      for (const { view } of all) {
        assert.equal(view.windowCount, 8);
        assert.equal(view.maxWindows, 8);
      }
      await page(settings, "orb");
      for (const { window, view } of all)
        if (view.surface === "orb") await configure(window, { style: "led" });
      await until(
        () =>
          evaluate(
            settings,
            "document.querySelectorAll('#orb-list .as-orb-art[data-style=\"led\"]').length===8",
          ),
        "all eight original style thumbnails render",
      );
      await capture(settings, "original-settings-eight-orb-list.png");
      entry.capacityArt = [];
      for (const { window, view } of all) {
        if (view.surface !== "orb") continue;
        const appearance = await evaluate(window, "document.body.dataset.appearance");
        const facts = await expectArt(window, { style: "led", appearance });
        entry.capacityArt.push({
          instanceId: view.instanceId,
          contextLost: facts.gpu.lost,
          linked: facts.gpu.linked,
        });
      }
      assert.deepEqual(
        await evaluate(
          settings,
          "Array.from(document.querySelectorAll('.as-orb-render-error,[data-render-error]'),node=>node.dataset.renderError||node.textContent)",
        ),
        [],
        "At-capacity management thumbnails must not evict live instrument contexts",
      );
      entry.thumbnailGpu = await observedGpuFacts(settings);
      for (const context of entry.thumbnailGpu) {
        if (context.lost) continue;
        assert.equal(
          context.error,
          0,
          "Real retained settings GPU contexts, including the detached thumbnail owner, must have no GL errors",
        );
        assert.equal(
          context.linked,
          true,
          "The real retained settings GPU program must remain linked",
        );
      }
      await evaluate(
        settings,
        "(() => {window.__ownedGpuObserver.restore();delete window.__ownedGpuObserver;})()",
      );
      await until(
        () => evaluate(settings, "document.getElementById('new-window').disabled"),
        "eight-orb add control disables",
      );
      await expectRejected(first, "window.ompMonitor.newWindow()", /window limit/);
      assert.equal((await views()).filter(({ view }) => view.surface === "orb").length, 8);
      entry.orbIdentities = all
        .filter(({ view }) => view.surface === "orb")
        .map(({ view }) => view.instanceId);
      entry.panelSurfaces = ["dashboard", "history", "settings"];
      for (const window of [first, second]) {
        const original = all.find((candidate) => candidate.window === window);
        await configure(window, { style: original.view.preferences.style });
      }
      for (const window of extras) await closeView(window);
      assert.equal((await state(first)).windowCount, 2);
      assert.equal((await state(second)).snapshot.today.outputTokens, 50);
    });
    await group(
      "All 38 offline currencies, shared real pricing state and selected-history-date native CSV",
      async (entry) => {
        await page(settings, "cost");
        const pricing = (await state(first)).snapshot.pricing;
        const currencies = pricing.currencies;
        assert.equal(new Set(currencies).size, 38);
        assert.equal(pricing.networkEnabled, false);
        assert.equal(
          await evaluate(settings, "document.getElementById('network-enabled').checked"),
          false,
        );
        assert.equal(
          await evaluate(settings, "document.getElementById('public-refresh').disabled"),
          true,
        );
        await expectRejected(settings, "window.ompMonitor.refreshPublicData()", /disabled/);
        const firstCost = (await state(first)).snapshot.today.costUsd;
        const secondCost = (await state(second)).snapshot.today.costUsd;
        const converted = [];
        for (const currency of currencies) {
          await select(settings, "currency", currency);
          await until(async () => {
            const a = (await state(first)).snapshot.pricing;
            const b = (await state(second)).snapshot.pricing;
            return (
              a.currency === currency &&
              b.currency === currency &&
              a.exchangeRate > 0 &&
              b.exchangeRate === a.exchangeRate
            );
          }, `shared offline ${currency} rate`);
          assert.equal((await state(first)).snapshot.today.costUsd, firstCost);
          assert.equal((await state(second)).snapshot.today.costUsd, secondCost);
          assert.equal((await state(first)).snapshot.pricing.networkEnabled, false);
          assert.equal(
            await evaluate(settings, "document.getElementById('currency').value"),
            currency,
          );
          if (currency !== "USD")
            assert.ok(
              (
                await evaluate(settings, "document.getElementById('currency-rate').textContent")
              ).includes(currency),
            );
          converted.push({
            currency,
            exchangeRate: (await state(first)).snapshot.pricing.exchangeRate,
          });
        }
        await select(settings, "currency", "CNY");
        await until(
          async () => (await state(first)).snapshot.pricing.currency === "CNY",
          "persisted offline CNY",
        );
        await capture(settings, "original-settings-offline-38-currencies.png");
        history = await openPanel(first, "history");
        await click(history, "#history-custom");
        await until(
          () => evaluate(history, "!document.getElementById('custom-range-popover').hidden"),
          "original custom history range",
        );
        await evaluate(
          history,
          `(() => {document.getElementById('history-from').value=${JSON.stringify(yesterdayKey)};document.getElementById('history-to').value=${JSON.stringify(yesterdayKey)};document.getElementById('history-apply').click();})()`,
        );
        await until(
          () =>
            evaluate(
              history,
              `document.getElementById('history-custom').getAttribute('aria-pressed')==='true' && document.getElementById('history-output').textContent==='700' && Array.from(document.querySelectorAll('#history-rows tr')).every(row=>row.dataset.date===${JSON.stringify(yesterdayKey)})`,
            ),
          "selected history date renders its own usage",
        );
        const selected = await saveNativeCsv(history, {
          name: "native-export-selected-history-date.csv",
          range: { startDate: yesterdayKey, endDate: yesterdayKey },
          ui: true,
        });
        assert.equal(selected.rows.length, 1);
        const row = selected.rows[0];
        assert.equal(row.section, "daily");
        assert.equal(row.date, yesterdayKey);
        assert.equal(row.range_start, yesterdayKey);
        assert.equal(row.range_end, yesterdayKey);
        assert.equal(row.profile, "owned-fixture");
        assert.equal(row.project, projectA);
        assert.equal(Number(row.requests), 1);
        assert.equal(Number(row.output_tokens), 700);
        assert.equal(row.display_currency, "CNY");
        assert.ok(Number(row.usd_exchange_rate) > 0);
        assert.equal(
          selected.rows.some((item) => ["today", "resources", "agent"].includes(item.section)),
          false,
        );
        await capture(history, "original-history-selected-date.png");
        entry.currencies = converted;
        entry.export = {
          name: selected.name,
          native: selected.native,
          date: yesterdayKey,
          rows: 1,
          outputTokens: 700,
        };
      },
    );
    await group(
      "Native position/size/style persistence, nameplate edge placement and cold reopen",
      async (entry) => {
        const area = screen.getPrimaryDisplay().workArea;
        const moveOwned = async (window, position) => {
          const before = window.getBounds();
          window.setBounds({ ...before, ...position });
          // This exercises native drag lifecycle, snapping and persistence, not a
          // physical drag. No global cursor, mouse or keyboard state is changed.
          await evaluate(
            window,
            "(async()=>{await window.ompMonitor.beginDrag();await window.ompMonitor.endDrag();})()",
          );
          const bounds = window.getBounds();
          const size = (await state(window)).preferences.size;
          assert.equal(bounds.width, Math.ceil(size * 1.5));
          assert.equal(bounds.height, Math.ceil(size * 1.5 + 32));
          assert.ok(bounds.x + size * 0.25 >= area.x - 1);
          assert.ok(bounds.x + size * 1.25 <= area.x + area.width + 1);
          assert.ok(bounds.y + size * 0.25 >= area.y - 1);
          assert.ok(bounds.y + size * 1.25 <= area.y + area.height + 1);
          return bounds;
        };
        await moveOwned(first, {
          x: area.x + 24,
          y: Math.round(area.y + area.height - 196 * 1.25),
        });
        await until(
          async () => (await state(first)).nameplatePlacement === "above",
          "original nameplate moves above at the screen bottom",
        );
        await capture(first, "original-orb-bottom-nameplate-above.png", true);
        await captureNameplate(first, "original-nameplate-above.png");
        await moveOwned(first, { x: area.x + 24, y: area.y + 48 });
        await moveOwned(second, {
          x: area.x + Math.min(300, Math.max(80, area.width - 180)),
          y: area.y + 48,
        });
        await until(
          async () => (await state(first)).nameplatePlacement === "below",
          "nameplate returns below away from edge",
        );
        persisted = new Map();
        for (const window of [first, second]) {
          const view = await state(window);
          persisted.set(view.instanceId, {
            preferences: view.preferences,
            scope: view.scope,
            bounds: window.getBounds(),
            orbVisible: view.orbVisible,
            requests: view.snapshot.today.requests,
            output: view.snapshot.today.outputTokens,
          });
        }
        const beforeHistory = history;
        await closeView(history, "#history-surface [data-close]");
        assert.equal(first.isDestroyed(), false);
        history = await openPanel(first, "history");
        assert.notEqual(
          history,
          beforeHistory,
          "Closing and reopening history must create a new native panel while keeping its orb",
        );
        await closeView(dashboard, "#close");
        assert.equal(first.isDestroyed(), false);
        assert.equal(second.isDestroyed(), false);
        await evaluate(
          first,
          "document.getElementById('orb-surface').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))",
        );
        dashboard = await waitView("dashboard", firstId);
        await expectSource(dashboard, expectedOutput - 50, expectedRequests - 1);
        await closeAll(first);
        await controller.dispose();
        const saved = JSON.parse(fs.readFileSync(path.join(cache, "windows.json"), "utf8"));
        assert.equal(saved.orbs.length, 2);
        for (const record of saved.orbs) {
          const expected = persisted.get(record.id);
          assert.ok(expected);
          assert.deepEqual(record.preferences, expected.preferences);
          assert.deepEqual(record.scope, expected.scope);
          assert.ok(
            Object.values(record.positions).some(
              (position) => position.x === expected.bounds.x && position.y === expected.bounds.y,
            ),
          );
        }
        controller = createController();
        await evaluate(main, "window.paseoDesktop.monitor.open()");
        first = await waitView("orb", firstId);
        second = await waitView("orb", secondId);
        dashboard = await waitView("dashboard", firstId);
        for (const window of [first, second]) {
          const view = await state(window);
          const expected = persisted.get(view.instanceId);
          await expectUsage(window, expected.requests, expected.output);
          assert.deepEqual(view.preferences, expected.preferences);
          assert.deepEqual(view.scope, expected.scope);
          assert.deepEqual(window.getBounds(), expected.bounds);
          assert.equal(view.orbVisible, expected.orbVisible);
          assert.equal(
            view.activity.responseSequence,
            0,
            "Cold catch-up must establish a new baseline",
          );
          assert.equal(
            view.activity.peakSequence,
            0,
            "Cold catch-up must not replay a measured peak",
          );
          assert.equal((await inspectNative(window)).topmost, expected.preferences.pinned);
        }
        assert.equal((await state(first)).snapshot.pricing.currency, "CNY");
        assert.equal((await state(first)).snapshot.pricing.networkEnabled, false);
        history = await openPanel(first, "history");
        settings = await openPanel(first, "settings");
        await capture(first, "original-project-a-cold-reopen.png", true);
        await capture(second, "original-project-b-cold-reopen.png", true);
        entry.records = Array.from(persisted, ([instanceId, value]) =>
          Object.assign({ instanceId }, value),
        );
        entry.physicalDragClaimed = false;
        entry.coldControllerAndCollectorRecreated = true;
      },
    );
    await group(
      "Actual worker failure marks live metrics unknown without fabricating history",
      async (entry) => {
        const before = (await state(first)).snapshot.today;
        const worker = controller.worker;
        assert.ok(
          worker && typeof worker.terminate === "function",
          "Terminate only the actual worker owned by this disposable controller",
        );
        await worker.terminate();
        await until(
          async () => (await state(first)).workerError,
          "actual worker exit reaches the native error bridge",
        );
        await until(
          () =>
            evaluate(
              dashboard,
              "document.getElementById('coverage-status').dataset.status==='error' && document.getElementById('speed-value').textContent==='—' && !document.getElementById('banner').hidden",
            ),
          "worker failure consumer shows unknown live value and an explicit error",
        );
        assert.equal(
          await evaluate(first, "document.querySelector('#orb-art .as-orb-value').textContent"),
          "—",
        );
        assert.equal((await state(first)).snapshot.today.outputTokens, before.outputTokens);
        assert.equal((await state(first)).snapshot.today.costUsd, before.costUsd);
        await capture(dashboard, "original-dashboard-worker-error.png");
        await capture(first, "original-orb-worker-error.png", true);
        await invoke(dashboard, "refresh");
        await expectUsage(first, expectedRequests - 1, expectedOutput - 50);
        await expectUsage(second, 1, 50);
        await expectSource(dashboard, expectedOutput - 50, expectedRequests - 1);
        entry.failureSource = "Owned production Worker.terminate(); no snapshot replacement";
        entry.liveValue = "unknown";
        entry.previousNumericHistoryRetained = true;
        entry.recoveredFromRealCollector = true;
      },
    );
    await group(
      "Final close/reopen with missing source, unknown metrics and blocked fabricated export",
      async (entry) => {
        await closeAll(first);
        await controller.dispose();
        fs.renameSync(sessions, unavailableSessions);
        controller = createController();
        await evaluate(main, "window.paseoDesktop.monitor.open()");
        first = await waitView("orb", firstId);
        second = await waitView("orb", secondId);
        dashboard = await waitView("dashboard", firstId);
        history = await openPanel(first, "history");
        settings = await openPanel(first, "settings");
        await until(
          async () => (await state(first)).snapshot?.status === "unavailable",
          "missing real root remains unavailable",
        );
        await until(
          () =>
            evaluate(
              dashboard,
              "document.getElementById('today-output').textContent==='—' && document.getElementById('today-requests').textContent==='—' && document.getElementById('speed-value').textContent==='—' && document.getElementById('source-omp').hidden",
            ),
          "missing source dashboard metrics are unknown, not fabricated zeros",
        );
        await until(
          () =>
            evaluate(
              history,
              "document.getElementById('history-output').textContent==='—' && document.getElementById('history-requests').textContent==='—' && document.getElementById('export').disabled",
            ),
          "missing history source disables export and remains unknown",
        );
        await page(settings, "data");
        assert.equal(
          await evaluate(settings, "document.getElementById('today-total').textContent"),
          "—",
        );
        assert.equal(
          await evaluate(first, "document.querySelector('#orb-art .as-orb-value').textContent"),
          "—",
        );
        for (const window of [first, second, dashboard, history, settings])
          assert.equal(await invoke(window, "exportCsv"), "unavailable");
        assert.equal((await state(first)).activity.responseSequence, 0);
        assert.equal((await state(first)).activity.peakSequence, 0);
        await capture(dashboard, "original-dashboard-missing-source.png");
        await capture(history, "original-history-missing-source.png");
        await capture(settings, "original-settings-missing-source.png");
        await capture(first, "original-orb-missing-source.png", true);
        fs.renameSync(unavailableSessions, sessions);
        await invoke(dashboard, "refresh");
        await expectUsage(first, expectedRequests - 1, expectedOutput - 50);
        await expectUsage(second, 1, 50);
        await expectSource(dashboard, expectedOutput - 50, expectedRequests - 1);
        assert.equal((await state(first)).snapshot.pricing.currency, "CNY");
        assert.equal((await state(first)).snapshot.pricing.networkEnabled, false);
        entry.missingSource =
          "Owned synthetic root temporarily renamed; restored before completion and again guarded in finally";
        entry.allSurfaceExports = "unavailable";
        entry.recoveredRequests = expectedRequests;
        entry.recoveredOutputTokens = expectedOutput;
      },
    );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = String(error.stack || error);
    const running = report.groups.find((entry) => entry.status === "running");
    if (running) running.status = "failed";
    for (const { window, view } of await views().catch(() => []))
      await capture(window, `failure-${view.surface}-${window.id}.png`).catch(() => undefined);
    fs.writeFileSync(
      path.join(evidence, "native-monitor-result.json"),
      JSON.stringify(report, null, 2),
    );
    throw error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (work) => {
      try {
        await work();
      } catch (error) {
        cleanupErrors.push(String(error.stack || error));
      }
    };
    const closingWindows = BrowserWindow.getAllWindows();
    for (const window of motionWindows)
      await cleanup(async () => {
        if (!window.isDestroyed()) await evaluate(window, "window.__ownedMotionFixture?.restore()");
      });
    for (const [window, observer] of nativeObservers)
      await cleanup(() => {
        if (!window.isDestroyed()) window.setIgnoreMouseEvents = observer.original;
      });
    await cleanup(() => controller.dispose());
    for (const window of closingWindows)
      await cleanup(() => {
        if (!window.isDestroyed()) window.destroy();
      });
    await cleanup(() =>
      until(
        () => closingWindows.every((window) => window.isDestroyed()),
        "all windows in the disposable runtime are actually closed",
        5_000,
      ),
    );
    for (const driver of ownedDrivers)
      await cleanup(async () => {
        driver.kill();
        await until(
          () => driver.exitCode !== null || driver.signalCode !== null,
          "owned native observer/Save driver exits",
          5_000,
        );
      });
    await cleanup(() => {
      if (fs.existsSync(unavailableSessions) && !fs.existsSync(sessions))
        fs.renameSync(unavailableSessions, sessions);
    });
    for (const [file, bytes] of originalFixtures)
      await cleanup(() => {
        assert.ok(owned(file));
        fs.writeFileSync(file, bytes);
      });
    report.cleanup = {
      ownedWindowsClosed: cleanupErrors.length === 0,
      syntheticFixturesRestored: cleanupErrors.length === 0,
      nativeDriversClosed: cleanupErrors.length === 0,
      errors: cleanupErrors,
    };
    if (cleanupErrors.length) report.status = "failed";
    fs.writeFileSync(
      path.join(evidence, "native-monitor-result.json"),
      JSON.stringify(report, null, 2),
    );
  }
  if (report.cleanup.errors.length)
    throw new Error(`Owned native smoke cleanup failed: ${report.cleanup.errors.join("\n")}`);
  console.log(`Local monitor native smoke passed: ${JSON.stringify(report)}`);
  app.exit(0);
}
