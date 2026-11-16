const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const repo = path.resolve(__dirname, "../../..");
let ownedNativeRuntime;
let ownedNativeTray;

async function waitFor(label, check, timeout = 30_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await check();
    if (last) return last;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
}

async function drive() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-speed-native-")));
  const home = path.join(root, "home");
  const userData = path.join(root, "userData");
  const agent = path.join(root, "numeric-agent");
  const project = path.join(root, "project");
  const evidence = path.join(root, "evidence");
  for (const directory of [home, userData, project, evidence, path.join(agent, "sessions", "bucket")]) fs.mkdirSync(directory, { recursive: true });
  const legacy = path.join(userData, "local-monitor");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "sources.json"), JSON.stringify({ version: 1, enabled: true, folder: path.join(agent, "sessions") }));
  fs.writeFileSync(path.join(legacy, "preserved-history-marker.txt"), "owned legacy state\n");
  const now = Date.now();
  const records = [
    { type: "session", version: 3, id: "smoke", timestamp: new Date(now - 60000).toISOString(), cwd: project },
    { type: "message", id: "reply", timestamp: new Date(now).toISOString(), message: { role: "assistant", model: "fixture", provider: "fixture", api: "fixture", timestamp: now - 1000, duration: 1000, ttft: 50, stopReason: "stop", usage: { input: 10, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0 } }, content: [{ type: "text", text: "Synthetic smoke" }] } },
  ];
  fs.writeFileSync(path.join(agent, "sessions", "bucket", "smoke.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  const config = path.join(root, "empty-config.yml");
  fs.writeFileSync(config, "{}\n");
  console.log(`Agent Speed native evidence: ${evidence}`);
  const env = { PATH: process.env.PATH, HOME: home, CFFIXED_USER_HOME: home, TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8", SHELL: "/bin/zsh", OMP_AGENT_DIR: path.join(home, ".omp", "agent"), PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"), OMP_CONFIG_FILES: config, PI_CONFIG_FILES: config, OMP_ELECTRON_USER_DATA_DIR: userData, PASEO_DISABLE_APP_UPDATES: "1", OMP_AGENT_SPEED_NATIVE_SMOKE_ROOT: root };
  const child = spawn(require("@iriscat/mini-electron"), [__filename], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  child.stdout.on("data", chunk => { logs.push(chunk.toString()); process.stdout.write(chunk); });
  child.stderr.on("data", chunk => { logs.push(chunk.toString()); process.stderr.write(chunk); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  clearTimeout(timer);
  fs.writeFileSync(path.join(evidence, "runtime.log"), logs.join(""));
  assert.equal(code, 0, `Native smoke failed; evidence=${evidence}`);
}

async function runNative() {
  const { app, BrowserWindow, protocol, Menu, Tray, nativeImage } = require("electron");
  const root = process.env.OMP_AGENT_SPEED_NATIVE_SMOKE_ROOT;
  const userData = path.join(root, "userData");
  const evidence = path.join(root, "evidence");
  app.setPath("userData", userData);
  protocol.registerSchemesAsPrivileged([{ scheme: "omp-desktop", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  await app.whenReady();
  assert.ok(process.versions.miniElectron, "Use the real mini-electron runtime");
  const host = require(path.join(repo, "packages/desktop/dist/plugins/local-runtime-electron.js"));
  const native = require(path.join(repo, "packages/desktop/dist/plugins/native-entry.js"));
  const mainWindows = require(path.join(repo, "packages/desktop/dist/window/main-windows.js"));
  const nativeErrors = [];
  const loadUrl = BrowserWindow.prototype.loadURL;
  BrowserWindow.prototype.loadURL = function (...arguments_) {
    this.webContents.on("preload-error", (_event, preload, error) => { nativeErrors.push({ preload, error: String(error) }); console.error("Native preload error:", preload, error); });
    return loadUrl.apply(this, arguments_);
  };
  const wallpaper = require(path.join(repo, "packages/desktop/dist/wallpaper/commands.js"));
  const wallpaperProtocol = require(path.join(repo, "packages/desktop/dist/wallpaper/media-protocol.js"));
  protocol.handle("omp-desktop", async request => {
    const url = new URL(request.url);
    if (url.hostname === "plugin-native") return native.handlePluginNativeDocument(decodeURIComponent(url.pathname)) ?? new Response("Not found", { status: 404 });
    const response = await wallpaperProtocol.handleWallpaperProtocolRequest(request, url, null);
    if (response) return response;
    return new Response("<!doctype html><title>Agent Speed isolated host</title><body>Isolated folder-plugin IPC host</body>", { headers: { "content-type": "text/html" } });
  });
  const main = new BrowserWindow({ width: 640, height: 240, show: false, webPreferences: { preload: path.join(repo, "packages/desktop/dist/preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  mainWindows.registerMainWindow(main);
  wallpaper.registerWallpaperWindow(main);
  await host.setupLocalPlugins({ startupBarrier: Promise.resolve(), openApp: async () => {}, openAgent: async () => {} });
  ownedNativeRuntime = host.getLocalPluginRuntime();
  await main.loadURL("omp-desktop://app/native-plugin-smoke");
  const evaluate = source => main.webContents.executeJavaScript(source);
  const snapshot = () => evaluate("window.paseoDesktop.plugins.getSnapshot()");
  const current = async () => (await snapshot()).installations.find(record => record.id === "agent-speed");
  const directory = path.join(repo, "plugins/agent-speed");
  const inspected = await evaluate(`window.paseoDesktop.plugins.inspectDirectory({directory:${JSON.stringify(directory)}})`);
  assert.equal(inspected.nativeEntry, path.join(directory, "dist/cjs/native.js"));
  assert.ok(inspected.capabilities.includes("native.main"));
  await evaluate(`window.paseoDesktop.plugins.installDirectory(${JSON.stringify({ directory, expectedRevision: (await snapshot()).revision, approval: { trusted: true, version: inspected.version, capabilities: inspected.capabilities } })})`);
  assert.equal((await current()).enabled, false);
  assert.equal(native.getPluginNativeTrayItems().length, 0);
  const patch = async enabled => evaluate(`window.paseoDesktop.plugins.patch(${JSON.stringify({ installationId: "agent-speed", expectedRevision: (await current()).revision, patch: { enabled } })})`);
  await patch(true);
  assert.equal((await current()).status, "waiting");
  assert.equal(native.getPluginNativeTrayItems().length, 0);
  await evaluate("window.paseoDesktop.plugins.startupReady()");
  await waitFor("native plugin active", async () => { const record = await current(); if (record.status === "failed") throw new Error(record.error); return record.status === "active"; });
  const data = path.join(userData, "desktop-plugins/data/agent-speed/native");
  assert.equal(fs.readFileSync(path.join(data, "preserved-history-marker.txt"), "utf8"), "owned legacy state\n");
  const iconPath = path.join(repo, "packages/desktop/assets", process.platform === "win32" ? "icon.ico" : "trayTemplate.png");
  const icon = nativeImage.createFromPath(iconPath);
  assert.equal(icon.isEmpty(), false);
  if (process.platform === "darwin") icon.setTemplateImage(true);
  ownedNativeTray = new Tray(process.platform === "win32" ? iconPath : icon);
  ownedNativeTray.setToolTip("Agent Speed isolated native smoke");
  let menu;
  let quitPreparation;
  const refreshTrayMenu = () => {
    menu = Menu.buildFromTemplate([{ label: "Show App", click: () => main.showInactive() }, ...native.getPluginNativeTrayItems(), { type: "separator" }, { label: "Quit", click: () => { quitPreparation = ownedNativeRuntime.dispose(); } }]);
    ownedNativeTray.setContextMenu(menu);
  };
  const stopTrayUpdates = native.onPluginNativeTrayItemsChanged(refreshTrayMenu);
  refreshTrayMenu();
  console.log("Native tray menu:", menu.items.map(item => item.label));
  assert.equal(native.getPluginNativeTrayItems().length, 1);
  menu.items[1].click();
  const ownedWindows = () => BrowserWindow.getAllWindows().filter(window => window !== main && !window.isDestroyed());
  await waitFor("native monitor window", () => ownedWindows().some(window => window.webContents.getURL().startsWith("omp-desktop://plugin-native/")));
  await delay(2500);
  const report = { runtime: process.versions.miniElectron, installed: await current(), windows: [], nativeErrors };
  for (const [index, window] of ownedWindows().entries()) {
    const state = await window.webContents.executeJavaScript("(async()=>({url:location.href,title:document.title,text:document.body.innerText,bridge:typeof window.ompMonitor,ready:window.ompMonitor?await window.ompMonitor.ready().then(state=>({state})).catch(error=>({error:String(error)})):null,controls:Array.from(document.querySelectorAll('button,[role=button],select,input')).map(e=>({id:e.id,text:e.textContent?.trim().slice(0,80),type:e.type}))}))()");
    report.windows.push({ ...state, bounds: window.getBounds(), visible: window.isVisible() });
    fs.writeFileSync(path.join(evidence, `native-window-${index}.png`), (await window.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(evidence, "initial-report.json"), JSON.stringify(report, null, 2));
  console.log("Native monitor windows:", JSON.stringify({ runtime: report.runtime, nativeErrors, windows: report.windows.map(window => ({ surface: window.ready?.state?.surface, bridge: window.bridge, error: window.ready?.error, text: window.text.slice(0, 500) })) }));
  assert.equal(nativeErrors.length, 0, "Native preloads must initialize successfully");
  for (const window of report.windows) {
    assert.equal(window.bridge, "object");
    assert.equal(window.ready.error, undefined);
    assert.equal(window.text.includes("Could not connect"), false);
  }
  const viewState = window => window.webContents.executeJavaScript("window.ompMonitor ? window.ompMonitor.ready() : null");
  const findView = surface => waitFor(surface, async () => {
    for (const window of ownedWindows()) {
      const state = await viewState(window);
      if (state?.surface === surface) return { window, state };
    }
    return false;
  });
  const capture = async (window, name) => {
    await delay(250);
    fs.writeFileSync(path.join(evidence, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const click = async (window, id) => {
    const clicked = await window.webContents.executeJavaScript(`(() => {const element=document.getElementById(${JSON.stringify(id)});if(!element||element.disabled||!element.getClientRects().length)return false;element.click();return true;})()`);
    assert.equal(clicked, true, `Visible native control: ${id}`);
  };
  const dashboard = await findView("dashboard");
  const orb = await findView("orb");
  const observed = await waitFor("collected output", async () => { const state = await viewState(dashboard.window); if (state.workerError) throw new Error("Native monitor worker failed"); return state.snapshot?.today.outputTokens === 100 ? state : false; });
  assert.equal(observed.snapshot.today.requests, 1);
  assert.equal(observed.snapshot.today.measuredOutputTokens, 100);
  assert.equal(observed.snapshot.today.measuredDurationMs, 1000);
  await capture(dashboard.window, "dashboard");
  await capture(orb.window, "orb");
  const record = await current();
  const clientScope = { installationId: "agent-speed", generation: record.generation, clientActivationId: "agent-speed-native-smoke", mode: "active" };
  await evaluate(`window.paseoDesktop.plugins.openClientScope(${JSON.stringify(clientScope)})`);
  const opened = await evaluate(`window.paseoDesktop.plugins.publish(${JSON.stringify({ ...clientScope, method: "open-monitor", input: {} })})`);
  assert.equal(opened.opened, true);
  await click(dashboard.window, "open-history");
  const history = await findView("history");
  assert.equal(history.state.snapshot.days.reduce((sum, day) => sum + day.outputTokens, 0), 100);
  await capture(history.window, "history");
  await click(dashboard.window, "open-settings");
  const settings = await findView("settings");
  assert.equal(settings.state.ompSource.sessions, 1);
  await capture(settings.window, "settings");
  await click(settings.window, "nav-cost");
  const currencies = await settings.window.webContents.executeJavaScript("document.getElementById('currency').options.length");
  assert.equal(currencies, 38);
  await capture(settings.window, "pricing");
  await click(settings.window, "nav-orb");
  await capture(settings.window, "orb-settings");
  await click(dashboard.window, "new-board");
  const board = await findView("board");
  assert.equal(board.state.snapshot.today.outputTokens, 100);
  await capture(board.window, "board");
  const agent = observed.snapshot.agents[0];
  assert.ok(agent, "Collected agent must be available for performance details");
  await dashboard.window.webContents.executeJavaScript("window.ompMonitor.configure({showPerformance:true})");
  const content = await dashboard.window.webContents.executeJavaScript("({width:innerWidth,height:innerHeight})");
  if (process.platform === "darwin") {
    assert.equal(dashboard.window.getBounds().width, content.width, "Frameless macOS bounds must match the real content viewport");
    assert.equal(dashboard.window.getBounds().height, content.height, "Frameless macOS bounds must match the real content viewport");
  }
  await dashboard.window.webContents.executeJavaScript(`window.ompMonitor.showPerfCard(${JSON.stringify({ agentId: agent.id, anchor: { x: 0, y: 0, width: content.width, height: content.height }, rowTop: 80, topCount: 0, subAgents: 0, facts: [] })})`);
  const { window: tooltip, state: performance } = await waitFor("performance card", async () => {
    for (const window of ownedWindows()) {
      const url = window.webContents.getURL();
      if (!url.startsWith("omp-desktop://plugin-native/") || url === dashboard.window.webContents.getURL()) continue;
      const state = await window.webContents.executeJavaScript("window.ompMonitor ? window.ompMonitor.readyPerfCard() : null");
      if (state?.request?.agentId === agent.id) return { window, state };
    }
    return false;
  });
  assert.equal(performance.request.agentId, agent.id);
  await capture(tooltip, "performance-card");
  await dashboard.window.webContents.executeJavaScript("window.ompMonitor.showPerfCard(null)");
  assert.deepEqual(nativeErrors, [], "All secondary native documents must load without preload errors");
  fs.writeFileSync(path.join(evidence, "surface-report.json"), JSON.stringify({ dashboard: true, orb: true, nativeRpc: true, outputTokens: 100, measuredDurationMs: 1000, history: true, settings: true, currencies, board: true, performanceCard: true }, null, 2));
  const priorSources = fs.readFileSync(path.join(data, "sources.json"), "utf8");
  fs.writeFileSync(path.join(userData, "local-monitor/sources.json"), JSON.stringify({ version: 1, enabled: false, folder: path.join(root, "must-not-replace") }));
  await patch(false);
  await waitFor("native disabled", async () => (await current()).status === "disabled");
  assert.equal(native.getPluginNativeTrayItems().length, 0);
  assert.equal(menu.items.some(item => item.label === "Agent Speed…"), false, "Disabled native entries must leave the real tray menu");
  assert.equal(ownedWindows().length, 0);
  for (const window of report.windows) assert.equal(native.handlePluginNativeDocument(new URL(window.url).pathname), undefined);
  assert.equal(fs.readFileSync(path.join(data, "sources.json"), "utf8"), priorSources);
  await patch(true);
  await waitFor("native reactivated", async () => { const record = await current(); if (record.status === "failed") throw new Error(record.error); return record.status === "active"; });
  assert.equal(fs.readFileSync(path.join(data, "sources.json"), "utf8"), priorSources);
  menu.items.find(item => item.label === "Agent Speed…").click();
  await waitFor("monitor reopened", () => ownedWindows().length > 0);
  const reopenedDashboard = await findView("dashboard");
  assert.equal(reopenedDashboard.state.preferences.showPerformance, true, "Re-enable must preserve saved native preferences");
  assert.equal(reopenedDashboard.state.snapshot.today.outputTokens, 100);
  await evaluate(`window.paseoDesktop.plugins.clearData(${JSON.stringify({ installationId: "agent-speed", expectedRevision: (await current()).revision })})`);
  assert.equal((await current()).status, "disabled", "Clearing configuration follows the existing disable contract");
  assert.equal(native.getPluginNativeTrayItems().length, 0);
  assert.equal(ownedWindows().length, 0);
  await patch(true);
  await waitFor("native active after data reset", async () => { const record = await current(); if (record.status === "failed") throw new Error(record.error); return record.status === "active"; });
  assert.equal(fs.existsSync(path.join(data, "preserved-history-marker.txt")), false, "Clear data must not resurrect legacy contents");
  assert.equal(fs.readFileSync(path.join(userData, "local-monitor/preserved-history-marker.txt"), "utf8"), "owned legacy state\n");
  menu.items.find(item => item.label === "Agent Speed…").click();
  const resetDashboard = await findView("dashboard");
  assert.equal(resetDashboard.state.snapshot.today.outputTokens, 0, "Cleared usage must remain empty after re-enabling");
  assert.ok(ownedWindows().length > 0, "Quit must exercise open native windows");
  const quittingDocuments = ownedWindows().map(window => new URL(window.webContents.getURL()).pathname);
  menu.items.find(item => item.label === "Quit").click();
  await quitPreparation;
  assert.equal(native.getPluginNativeTrayItems().length, 0);
  assert.equal(ownedWindows().length, 0);
  for (const pathname of quittingDocuments) assert.equal(native.handlePluginNativeDocument(pathname), undefined);
  assert.deepEqual(nativeErrors, [], "Re-enabled and reset native documents must load without preload errors");
  stopTrayUpdates();
  ownedNativeTray.destroy();
  main.destroy();
  fs.writeFileSync(path.join(evidence, "lifecycle-report.json"), JSON.stringify({ installed: true, approvedNativeMain: true, disabledUntilEnabled: true, startupBarrier: true, legacyCopied: true, enabledTrayAndWindows: true, disableClosedWindowsAndTray: true, documentsRevoked: true, reenablePreservedData: true, reenablePreservedPreferences: true, clearDisabledPlugin: true, clearDidNotResurrectLegacy: true, clearedUsageStayedEmpty: true, quitClosedResources: true }, null, 2));
  console.log("Agent Speed native plugin install/approval/startup/tray/window/migration/disable/reenable/clear/quit smoke passed");
  app.exit(0);
}

(process.env.OMP_AGENT_SPEED_NATIVE_SMOKE_ROOT ? runNative() : drive()).catch(async error => {
  console.error(error.stack || error);
  if (process.env.OMP_AGENT_SPEED_NATIVE_SMOKE_ROOT) {
    try {
      await ownedNativeRuntime?.dispose();
    } catch (cleanupError) {
      console.error("Owned native runtime cleanup failed:", cleanupError);
    }
    ownedNativeTray?.destroy();
    require("electron").app.exit(1);
  } else process.exitCode = 1;
});
