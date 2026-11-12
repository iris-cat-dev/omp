"use strict";

// Build Desktop product modules separately. This command never builds them:
// node packages/desktop/e2e/macos-native-wallpaper-smoke.js \
//   --agent-route=/h/desktop/agent/bdce1615-485e-4941-9774-6a54e371ce17 \
//   --workspace-id=wks_705e3fb0d9596972
// Uses only the owned mini-electron GUI, production preload/protocol/plugin runtime,
// real React App on 18091, the idle agent on 18771, and owned B18772 (desktop-other).
// --file-evidence=<owned observations.json> reuses unchanged, already-passed
// file/opacity/off/null GUI evidence and resumes the remaining native scenarios.
// --url-evidence=<owned observations.json> likewise reuses only URL states/races;
// retry, independent windows, previews and native controls still execute here.
// --independent-evidence=<owned observations.json> resumes remaining menu/picker/theme
// UI after already-passed retry/window/project/preview/remote/model observations.
// --surfaces-evidence=<owned observations.json> reuses passed current-window retry,
// settled menu and input observations and exercises only the actual App theme change.
// --picker-cancel-only retains picker acceptance/deletion/re-add as blocked when
// the current native event authorization permits visible owned-sheet cancel only.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const ROOT = "/tmp/omp-unified-plugin-smoke-2s3uFs";
const APP_ORIGIN = "http://localhost:18091";
const arg = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
function inside(root, candidate) {
  const relative = path.relative(root, fs.realpathSync(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function bounded(label, promise, ms = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); })]).finally(() => clearTimeout(timer));
}
async function until(label, read, accept, ms = 10000) {
  const deadline = Date.now() + ms;
  let last;
  do {
    last = await bounded(label, Promise.resolve().then(read), ms);
    if (accept(last)) return last;
    await delay(30);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}
function requireProduct(desktopRoot, relative) {
  const output = path.join(desktopRoot, "dist", relative);
  const source = path.join(desktopRoot, "src", relative.replace(/\.js$/, ".ts"));
  assert.ok(fs.existsSync(output), `Prerequisite: parent must compile Desktop first; missing ${output}`);
  if (fs.existsSync(source)) assert.ok(fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs,
    `Prerequisite: parent must compile current Desktop source first; stale ${output}`);
  return output;
}
function launch() {
  assert.equal(process.platform, "darwin", "This is real macOS GUI acceptance, not Windows/Linux or Node acceptance");
  const root = fs.realpathSync(ROOT);
  const runtime = fs.realpathSync(arg("runtime", path.join(root, "native-runtime/Electron.app/Contents/MacOS/Electron")));
  assert.ok(inside(root, runtime), "Refusing a runtime outside the owned root");
  const nativeRoot = fs.realpathSync(arg("native-root", "/Users/bytedance/Project/mini-electron"));
  const desktopRoot = fs.realpathSync(path.resolve(__dirname, ".."));
  for (const module of ["preload.js", "plugins/local-runtime-electron.js", "wallpaper/commands.js", "wallpaper/media-protocol.js", "settings/desktop-settings-electron.js", "daemon/daemon-manager.js"]) requireProduct(desktopRoot, module);
  const sdkRoot = path.join(desktopRoot, "sdk-dist/node_modules/@oh-my-pi/pi-coding-agent");
  assert.ok(fs.existsSync(path.join(desktopRoot, "sdk-dist/manifest.json")) && fs.existsSync(path.join(sdkRoot, "package.json")), "Prerequisite: real Desktop SDK closure packages/desktop/sdk-dist is missing");
  const route = arg("agent-route", "/h/desktop/agent/bdce1615-485e-4941-9774-6a54e371ce17");
  assert.match(route, /^\/h\/desktop\/agent\/[0-9a-f-]{36}$/i, "Use the UI slice's actual owned idle agent route");
  const workspaceId = arg("workspace-id", "wks_705e3fb0d9596972");
  assert.match(workspaceId, /^wks_[a-z0-9]+$/i);
  const otherWorkspaceId = arg("other-workspace-id", "wks_a2b5fc586b8b2c4c");
  assert.match(otherWorkspaceId, /^wks_[a-z0-9]+$/i); assert.notEqual(otherWorkspaceId, workspaceId);
  const fileEvidenceInput = arg("file-evidence", null);
  const fileEvidence = fileEvidenceInput ? fs.realpathSync(fileEvidenceInput) : null;
  if (fileEvidence) { assert.ok(inside(root, fileEvidence)); assert.equal(path.basename(fileEvidence), "observations.json"); }
  const urlEvidenceInput = arg("url-evidence", null);
  const urlEvidence = urlEvidenceInput ? fs.realpathSync(urlEvidenceInput) : null;
  if (urlEvidence) { assert.ok(inside(root, urlEvidence)); assert.equal(path.basename(urlEvidence), "observations.json"); }
  const independentEvidenceInput = arg("independent-evidence", null);
  const independentEvidence = independentEvidenceInput ? fs.realpathSync(independentEvidenceInput) : null;
  if (independentEvidence) { assert.ok(inside(root, independentEvidence)); assert.equal(path.basename(independentEvidence), "observations.json"); }
  const pickerCancelOnly = arg("picker-cancel-only", null) !== null;
  const surfacesEvidenceInput = arg("surfaces-evidence", null);
  const surfacesEvidence = surfacesEvidenceInput ? fs.realpathSync(surfacesEvidenceInput) : null;
  if (surfacesEvidence) { assert.ok(inside(root, surfacesEvidence)); assert.equal(path.basename(surfacesEvidence), "observations.json"); assert.ok(fileEvidence && urlEvidence && independentEvidence, "Surface reuse requires the unchanged full matrix evidence"); }
  const run = fs.mkdtempSync(path.join(root, "native-wallpaper-"));
  const name = `omp-native-wallpaper-${randomUUID()}`;
  const paths = Object.fromEntries(["home", "appData", "userData", "sessionData", "temp", "logs", "crashDumps", "cache"].map(key => [key, path.join(run, key)]));
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(paths.home, "Library/Application Support", name), { recursive: true });
  fs.mkdirSync(path.join(run, "fixtures"));
  const iris = path.join(desktopRoot, "../../plugins/desktop-pet/assets/pets/iris/sprites.png");
  assert.ok(fs.existsSync(iris), "Prerequisite: the existing Iris PNG is missing");
  for (let index = 0; index < 50; index++) fs.copyFileSync(iris, path.join(run, "fixtures", `iris-${String(index).padStart(2, "0")}.png`));
  fs.cpSync(path.join(desktopRoot, "../../plugins/desktop-pet/assets/pets"), path.join(run, "assets", "pets"), { recursive: true });
  fs.copyFileSync(__filename, path.join(run, path.basename(__filename)));
  fs.writeFileSync(path.join(run, "package.json"), JSON.stringify({ name, productName: name, version: "1.0.0", main: path.basename(__filename) }));
  fs.writeFileSync(path.join(run, "ownership.json"), JSON.stringify({ kind: "omp-native-wallpaper", root, run, name }));
  const helper = path.join(run, "native-wallpaper.node");
  const sdk = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8", timeout: 30000 }).trim();
  execFileSync("xcrun", ["clang++", "-std=c++20", "-fobjc-arc", "-bundle", "-undefined", "dynamic_lookup", "-isysroot", sdk,
    `-I${path.join(nativeRoot, "third_party/libnode/src")}`, "-framework", "AppKit", "-framework", "ApplicationServices",
    path.join(__dirname, "macos-native-wallpaper-helper.mm"), "-o", helper], { stdio: "inherit", timeout: 30000 });
  console.log(JSON.stringify({ kind: "launch", run, runtime, route, workspaceId }));
  const result = spawnSync(runtime, [`--app=${run}`], { cwd: run, timeout: 300000, stdio: "inherit", env: {
    PATH: process.env.PATH, LANG: process.env.LANG || "en_US.UTF-8", HOME: paths.home, CFFIXED_USER_HOME: paths.home,
    TMPDIR: `${paths.temp}${path.sep}`, XDG_CONFIG_HOME: paths.appData, XDG_CACHE_HOME: paths.cache,
    OMP_DESKTOP_SDK_ROOT: sdkRoot,
    OMP_HOME: path.join(run, "omp-home"), OMP_WALLPAPER_CONFIG: JSON.stringify({ root, run, name, paths, helper, desktopRoot, route, workspaceId, otherWorkspaceId, fileEvidence, urlEvidence, independentEvidence, pickerCancelOnly, surfacesEvidence }),
  } });
  console.log(JSON.stringify({ kind: "launch-result", run, status: result.status, signal: result.signal, error: result.error?.message || null }));
  if (result.error) throw result.error;
  process.exitCode = result.status === 0 ? 0 : 1;
}

async function runNative() {
  const { app, BrowserWindow, protocol, ipcMain, dialog } = require("electron");
  assert.equal(process.platform, "darwin");
  assert.ok(process.versions.miniElectron, "Prerequisite: genuine mini-electron native GUI required");
  const config = JSON.parse(process.env.OMP_WALLPAPER_CONFIG || "null");
  assert.ok(config, "Launch through the owned Node entry");
  const { root, run, name, paths, helper, desktopRoot, route, workspaceId, otherWorkspaceId, fileEvidence, urlEvidence, independentEvidence, pickerCancelOnly, surfacesEvidence } = config;
  assert.equal(fs.realpathSync(ROOT), root);
  assert.ok(inside(root, run));
  assert.equal(app.getName(), name);
  const early = app.getPath("userData");
  assert.ok(fs.existsSync(early) && inside(run, early), `Native early userData escaped owned root: ${early}`);
  assert.equal(path.basename(fs.realpathSync(early)), name);
  const marker = JSON.parse(fs.readFileSync(path.join(run, "ownership.json"), "utf8"));
  assert.equal(marker.kind, "omp-native-wallpaper");
  assert.equal(marker.name, name);
  for (const [key, directory] of Object.entries(paths)) {
    assert.ok(inside(run, directory), `Native ${key} escaped ownership`);
    app.setPath(key, fs.realpathSync(directory));
  }
  assert.equal(fs.realpathSync(app.getPath("home")), fs.realpathSync(process.env.HOME));
  const evidence = path.join(run, "evidence");
  fs.mkdirSync(evidence);
  const rows = [];
  const failures = [];
  const record = (kind, label, observed, assertion) => {
    const row = { time: Date.now(), kind, label, observed, assertion: assertion ?? null };
    rows.push(row);
    console.log(JSON.stringify(row));
    fs.writeFileSync(path.join(evidence, "observations.json"), JSON.stringify(rows, null, 2));
  };
  const check = (label, observed, assertion, passes) => {
    record(passes ? "pass" : "fail", label, observed, assertion);
    if (!passes) failures.push(label);
  };
  const native = require(helper);
  record("state", "isolated native profile and original focus", { early: fs.realpathSync(early), paths, native: native.preserve() });
  // Observe the real API without replacing its native implementation, arguments,
  // callback or public Promise. This is a receipt, never a picker substitute.
  const nativeOpenDialog = dialog._showOpenDialog;
  if (typeof nativeOpenDialog === "function") {
    dialog._showOpenDialog = function () {
      record("state", "actual _showOpenDialog native entry", { browserWindowID: arguments[0], options: arguments[1], argumentTypes: Array.from(arguments, value => typeof value), app: native.appState(), panels: native.sheetState() });
      return nativeOpenDialog.apply(this, arguments);
    };
  } else record("state", "native dialog entry observation unavailable", { type: typeof nativeOpenDialog });
  const publicOpenDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = function () {
    const started = Date.now();
    record("state", "actual production dialog public invocation", { windowId: arguments[0]?.id ?? null, options: arguments[1] ?? arguments[0], app: native.appState(), panels: native.sheetState() });
    const result = publicOpenDialog.apply(this, arguments);
    result.then(value => record("state", "actual production dialog public resolution", { elapsed: Date.now() - started, canceled: value.canceled, count: value.filePaths.length, allPathsOwned: value.filePaths.every(file => inside(run, file)), panels: native.sheetState() }), error => record("state", "actual production dialog public rejection", { elapsed: Date.now() - started, error: error.message, panels: native.sheetState() }));
    return result;
  };
  const product = relative => require(requireProduct(desktopRoot, relative));
  const { getDesktopSettingsStore } = product("settings/desktop-settings-electron.js");
  const { getLocalPluginRuntime, setupBuiltinLocalPlugins, handleBuiltinPluginResource, releaseLocalPluginDocument } = product("plugins/local-runtime-electron.js");
  const { registerMainWindow, markMainWindowLoading, isMainWindowSender, getMainWindowDocumentVersion, getMainWindows, markMainWindowContentReady } = product("window/main-windows.js");
  const { registerWindowManager } = product("window/window-manager.js");
  const { registerWallpaperWindow } = product("wallpaper/commands.js");
  const { wallpaperMediaRegistry: registry } = product("wallpaper/media-registry.js");
  const { handleWallpaperProtocolRequest } = product("wallpaper/media-protocol.js");
  const { getCommittedWallpaperDocumentIdentity } = product("wallpaper/media-request-authorization.js");
  const { validateWallpaperFile } = product("wallpaper/files.js");
  const windows = [];
  const pendingResponses = new Map();
  const urlRequests = [];
  let server;
  let controller;
  let finished = false;
  const finish = async error => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    if (error) { failures.push(error.message); record("fail", "native execution", { message: error.message, stack: error.stack }); }
    if (error) for (const window of windows) if (!window.isDestroyed()) {
      try { const events = await evaluate(window, `window.__wallpaperInputEvents||[]`); if(events.length) { fs.writeFileSync(path.join(evidence, `native-input-events-${window.id}.json`), JSON.stringify(events,null,2)); record("state", "actual native input failure sequence", {windowId:window.id,count:events.length,last:events.slice(-40)}); } }
      catch (traceError) { record("fail", "capture actual native input sequence", { message: traceError.message }); }
      try { const view = await evaluate(window, `(async()=>{const snapshot=await window.paseoDesktop.plugins.getSnapshot();return {href:location.href,wallpaper:snapshot.installations.find(item=>item.id==='wallpaper'),provider:snapshot.backgroundProvider,events:window.__wallpaperNativeEvents||[],manager:document.querySelector('[data-testid="plugin-row-local:wallpaper"]')?.innerText||'',configuration:document.querySelector('[data-testid="wallpaper-settings"]')?.innerText||'',body:document.body?.innerText.slice(-8000)||''};})()`); record("state", "actual native plugin failure state", {windowId:window.id,...view}); }
      catch (pluginError) { record("fail", "capture actual native plugin state", { message: pluginError.message }); }
      try { await snapshot(window, "actual-native-failure-state"); }
      catch (captureError) { record("fail", "capture actual failure state", { message: captureError.message }); }
    }
    for (const responses of pendingResponses.values()) for (const response of responses) response.destroy();
    if (server) await bounded("Close owned URL server", new Promise(resolve => server.close(resolve))).catch(error => { failures.push(error.message); });
    if (controller) await bounded("Dispose owned plugin runtime", controller.dispose()).catch(error => { failures.push(error.message); });
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    record("state", "owned cleanup and focus restoration", { windows: windows.filter(window => !window.isDestroyed()).length, native: native.restore() });
    const blocked = rows.filter(row => row.kind === "blocked").map(row => ({ label: row.label, observed: row.observed }));
    record(failures.length ? "fail" : blocked.length ? "blocked" : "pass", "native wallpaper acceptance", { failures, blocked, evidence, reusedFileEvidence: fileEvidence || null, reusedUrlEvidence: urlEvidence || null, reusedIndependentEvidence: independentEvidence || null, reusedSurfacesEvidence: surfacesEvidence || null }, blocked.length ? "Required GUI criteria remain blocked by the named prerequisites; exercised observations retain their own result" : "Every required GUI assertion passes; no Node/mock/platform substitution");
    app.exit(failures.length ? 1 : blocked.length ? 2 : 0);
  };
  const watchdog = setTimeout(() => { void finish(new Error("Native wallpaper GUI exceeded 270s")); }, 270000);
  app.on("window-all-closed", () => {});
  protocol.registerSchemesAsPrivileged([{ scheme: "omp-desktop", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
  const evaluate = (window, source) => bounded("Production renderer evaluation", window.webContents.executeJavaScript(`(${source})`));
  const snapshot = async (window, label) => {
    await bounded("Prepare genuine native renderer", window.webContents.prepareToShow());
    const image = await bounded("Capture genuine native renderer", window.webContents.capturePage());
    const file = path.join(evidence, `${String(rows.length).padStart(3, "0")}-${label.replace(/[^a-z0-9-]/gi, "-")}.png`);
    fs.writeFileSync(file, image.toPNG());
    const dimensions = image.getSize();
    assert.ok(fs.statSync(file).size > 1000 && dimensions.width > 0 && dimensions.height > 0, "Actual native screenshot must contain pixels");
    record("screenshot", label, { file, dimensions, native: native.geometry(window.getTitle()) });
  };
  const click = async (window, selector, text = null) => {
    window.show(); window.focus();
    await until("Owned native window becomes key", () => native.geometry(window.getTitle()), value => value.isKey);
    const bounds = await evaluate(window, `(() => { window.__wallpaperPointerReceipts=[]; if(!window.__wallpaperPointerObserver){window.__wallpaperPointerObserver=true; for(const type of ['pointerdown','pointerup','click']) document.addEventListener(type,event=>{const node=event.target.closest?.('[data-testid]')||event.target;window.__wallpaperPointerReceipts.push({type,trusted:event.isTrusted,testid:node.dataset?.testid,tag:node.tagName,disabled:!!node.disabled,x:event.clientX,y:event.clientY});},true);} const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(node=>{const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&(${JSON.stringify(text)}===null||node.textContent.trim()===${JSON.stringify(text)});}); if(nodes.length!==1)throw Error('Expected one visible product control '+${JSON.stringify(selector)}+' found '+nodes.length);const node=nodes[0];node.scrollIntoView({block:'nearest',inline:'nearest'});const r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,disabled:!!node.disabled,control:node.dataset?.testid,hit:{tag:hit?.tagName,testid:hit?.closest?.('[data-testid]')?.dataset.testid},targetHit:hit===node||node.contains(hit)};})()`);
    record("state", "actual native DOM click target", { windowId: window.id, selector, ...bounds });
    assert.ok(!bounds.disabled, `Actual product control is disabled: ${selector}`);
    const geometry = native.geometry(window.getTitle());
    const x = geometry.x + bounds.x, y = geometry.y + bounds.y;
    record("state", "native click hit recipient", { expected: geometry, x, y, hit: native.hit(x, y) });
    record("input", selector, { down: native.mouse("down", x, y), up: native.mouse("up", x, y) });
    await delay(100);
    record("state", "actual native DOM pointer receipts", { windowId: window.id, selector, events: await evaluate(window, `window.__wallpaperPointerReceipts.slice(-6)`) });
  };
  const state = window => evaluate(window, `(() => {
    const input = window.__wallpaperInput;
    const surface = window.__wallpaperSurface;
    const alpha = color => { if(color==='transparent') return 0; const values=color.match(/[\\d.]+/g)?.map(Number)||[]; return color.startsWith('rgba') ? values[3] : 1; };
    const scroll = window.__wallpaperScroll || [];
    const media=[...document.images,...document.querySelectorAll('video')].filter(node => /wallpaper-media|127\\.0\\.0\\.1/.test(node.currentSrc||node.src||'')).map(node=>({src:node.currentSrc||node.src,ready:node.tagName==='VIDEO'?node.readyState>=2:node.complete&&node.naturalWidth>0,width:node.videoWidth||node.naturalWidth,height:node.videoHeight||node.naturalHeight}));
    return {href:location.href,inputConnected:!!input?.isConnected,identity:document.querySelector('[data-testid="message-input-root"] textarea')===input,focused:document.activeElement===input,value:input?.value,selection:[input?.selectionStart,input?.selectionEnd,input?.selectionDirection],surfaceConnected:!!surface?.isConnected,surface:surface?getComputedStyle(surface).backgroundColor:null,alpha:surface?alpha(getComputedStyle(surface).backgroundColor):null,scroll:scroll.map(node=>({connected:node.isConnected,top:node.scrollTop,left:node.scrollLeft})),media};
  })()`);
  let baseline;
  const stable = async (window, label, expectedAlpha) => {
    const observed = await until(label, async () => ({ ...await state(window), nativeKey: native.geometry(window.getTitle()).isKey }), value => Math.abs(value.alpha - expectedAlpha) < 0.025 && (!baseline || (value.focused && value.nativeKey)));
    if (baseline) {
      check(`${label}: composer identity/focus/selection/draft/scroll`, observed,
        "Same real input node, focus, selection, draft, surface and nonzero scroll offsets",
        observed.inputConnected && observed.identity && observed.focused && observed.nativeKey && observed.surfaceConnected && observed.value === baseline.value &&
        JSON.stringify(observed.selection) === JSON.stringify(baseline.selection) && JSON.stringify(observed.scroll) === JSON.stringify(baseline.scroll));
    } else {
      record("blocked", `${label}: input identity/focus/selection/draft/scroll`, { nativeKey: observed.nativeKey }, "Real native input baseline was unavailable; this surface/lease assertion does not establish input preservation");
    }
    check(`${label}: surface alpha`, observed, `Expected ${expectedAlpha}`, Math.abs(observed.alpha - expectedAlpha) < 0.025);
    await snapshot(window, label);
    return observed;
  };
  const patch = async fields => {
    const store = getDesktopSettingsStore();
    const current = (await store.getPlugins()).installations.find(item => item.id === "wallpaper");
    assert.ok(current);
    await store.patchPlugin({ installationId: current.id, expectedRevision: current.revision, patch: fields });
    return (await store.getPlugins()).installations.find(item => item.id === "wallpaper");
  };
  const configPatch = fields => patch({ config: fields });
  const holding = (window, purpose) => {
    const owner = registry.getOwner(window.webContents);
    const lease = owner?.installations.get("wallpaper");
    return { epoch: owner?.epoch, nativeIdentity: owner?.nativeIdentity, revision: lease?.[purpose].revision, media: [...(lease?.[purpose].media.values() || [])].map(media => ({ id: media.id, candidateId: media.candidateId, scope: media.scope, uri: media.uri })) };
  };
  const now = new Date().toISOString();
  const hosts = [
    { serverId: "desktop", label: "Owned desktop acceptance", appearance: { color: "none", badgeDisplay: null }, lifecycle: {}, connections: [{ id: "direct:localhost:18771", type: "directTcp", endpoint: "localhost:18771" }], preferredConnectionId: "direct:localhost:18771", createdAt: now, updatedAt: now },
    { serverId: "desktop-other", label: "Owned secondary host acceptance", appearance: { color: "none", badgeDisplay: null }, lifecycle: {}, connections: [{ id: "direct:127.0.0.1:18772", type: "directTcp", endpoint: "127.0.0.1:18772" }], preferredConnectionId: "direct:127.0.0.1:18772", createdAt: now, updatedAt: now },
  ];
  const initialStorage = { "@omp-desktop:daemon-registry": JSON.stringify(hosts), "@omp-desktop:app-settings": JSON.stringify({ theme: "auto", language: "zh-CN" }), "@omp-desktop:e2e": "owned-native-wallpaper", "omp-native-wallpaper-initialized": "1" };
  try {
    await bounded("Native app ready", app.whenReady());
    const store = getDesktopSettingsStore();
    await store.patch({ daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: false } });
    const library0 = await store.getWallpaperLibrary();
    check("fresh owned library", library0, "No inherited candidates", library0.items.length === 0);
    const irisBytes = fs.readFileSync(path.join(run, "fixtures/iris-00.png"));
    let retryFailures = true;
    server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      response.setHeader("Content-Type", "image/png"); response.setHeader("Cache-Control", "no-store"); response.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", request.headers["access-control-request-headers"] || "*");
      response.once("finish", () => record("state", "owned real HTTP response finished", { pathname: url.pathname, method: request.method, origin: request.headers.origin ?? null, requestedHeaders: request.headers["access-control-request-headers"] ?? null, privateNetwork: request.headers["access-control-request-private-network"] ?? null, status: response.statusCode, bytes: request.method === "OPTIONS" ? 0 : response.statusCode === 200 ? (url.pathname === "/probe-native-ascii.txt" ? Buffer.byteLength("owned-native-ascii") : irisBytes.length) : null, chunked: response.chunkedEncoding, headers: response._header }));
      if (request.method === "OPTIONS") { response.statusCode = 204; response.end(); return; }
      urlRequests.push({ path: url.pathname, method: request.method, time: Date.now() });
      if (url.pathname === "/probe-native-ascii.txt") { response.setHeader("Content-Type", "text/plain; charset=utf-8"); response.end("owned-native-ascii"); return; }
      if (url.pathname.startsWith("/hold-")) { const list = pendingResponses.get(url.pathname) || []; list.push(response); pendingResponses.set(url.pathname, list); }
      else if (url.pathname.startsWith("/error") && retryFailures) { response.statusCode = 500; response.end("Owned intentional image load failure"); }
      else response.end(irisBytes);
    });
    await bounded("Owned loopback URL server", new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
    const urlOrigin = `http://127.0.0.1:${server.address().port}`;
    const release = pathname => { const responses = pendingResponses.get(pathname) || []; assert.ok(responses.length, `No real pending media request for ${pathname}`); let delivered = 0; for (const response of responses) if (!response.destroyed) { response.end(irisBytes); delivered++; } pendingResponses.delete(pathname); record("state", "release real delayed image", { pathname, requests: responses.length, delivered, bytes: irisBytes.length }); };
    const { registerDaemonManager } = product("daemon/daemon-manager.js");
    registerDaemonManager({ prepareForAppUpdate: async () => { throw new Error("Updates are outside the owned wallpaper acceptance"); } });
    registerWindowManager();
    product("features/dialogs.js").registerDialogHandlers();
    // Native host registry bootstrap resolves legacy SSH metadata even for TCP
    // profiles. Use the production store in this owned userData, not a bridge stub.
    product("features/remote-ssh/ipc.js").registerRemoteSshHandlers();
    product("features/menu.js").setupApplicationMenu({ onNewWindow: () => { throw new Error("Use the harness-owned second window"); } });
    const { AgentNavigationInbox } = product("agent-navigation.js");
    const inbox = new AgentNavigationInbox();
    ipcMain.handle("paseo:agent-navigation:ready", event => inbox.windowReady(event.sender.id));
    const { CloseChoiceRequestBroker } = product("window/close-choice-request.js");
    const closeChoiceRequests = new CloseChoiceRequestBroker();
    const { PendingOpenProjectStore } = product("pending-open-project-store.js");
    const pendingProjects = new PendingOpenProjectStore();
    const presentedOwnedWindows = new WeakSet();
    ipcMain.handle("paseo:get-pending-open-project", event => pendingProjects.take(event.sender.id));
    ipcMain.handle("paseo:window:closeChoiceReady", event => closeChoiceRequests.getPending(event.sender.id));
    ipcMain.handle("paseo:window:respondCloseChoice", (event, response) => closeChoiceRequests.respond(event.sender.id, response));
    // Main's real sender/document-version guard and presentation primitives.
    // These are stateful production delegates, never canned ready/null responses.
    ipcMain.handle("paseo:window:content-ready", async event => {
      if (!isMainWindowSender(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error("Content readiness requires a main application window");
      const window = getMainWindows().find(candidate => candidate.webContents === event.sender);
      if (!window) return;
      const documentVersion = getMainWindowDocumentVersion(window);
      await event.sender.prepareToShow();
      if (finished || documentVersion !== getMainWindowDocumentVersion(window)) return;
      if (isMainWindowSender(event.sender) && event.senderFrame === event.sender.mainFrame) {
        markMainWindowContentReady(window);
        presentedOwnedWindows.add(window);
        record("state", "production main-window presentation", { windowId: window.id, documentVersion, presented: presentedOwnedWindows.has(window) });
      }
    });
    protocol.handle("omp-desktop", async request => {
      const url = new URL(request.url);
      const protectedResponse = await handleWallpaperProtocolRequest(request, url, APP_ORIGIN);
      if (protectedResponse) return protectedResponse;
      const resource = await handleBuiltinPluginResource(url.hostname, decodeURIComponent(url.pathname));
      if (resource) return resource;
      return new Response("Not found", { status: 404 });
    });
    await setupBuiltinLocalPlugins({ resourceRoot: path.join(run, "assets"), startupBarrier: Promise.resolve(), openApp() { throw new Error("Wallpaper acceptance must not open an unrelated window"); }, openAgent() { throw new Error("Wallpaper acceptance must not dispatch a model/task navigation"); } });
    controller = getLocalPluginRuntime();
    await patch({ enabled: true, config: { source: "none", candidateId: null, url: null, opacity: 0.85 } });
    const pluginDocument = await store.getPlugins();
    await store.selectPluginBackground({ installationId: "wallpaper", extensionId: "wallpaper" }, pluginDocument.revision);
    const createWindow = async (suffix, pathname) => {
      const window = new BrowserWindow({ title: `${name}-${suffix}`, width: 1120, height: 800, x: suffix === "A" ? 70 : 150, y: suffix === "A" ? 90 : 130, show: false, backgroundColor: "#181818", webPreferences: { preload: path.join(desktopRoot, "dist/preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      windows.push(window);
      const windowTitle = `${name}-${suffix}-${window.id}`;
      window.setTitle(windowTitle);
      registerMainWindow(window); registerWallpaperWindow(window);
      window.on("show", () => presentedOwnedWindows.add(window));
      const contentsId = window.webContents.id;
      window.webContents.once("destroyed", () => { releaseLocalPluginDocument(contentsId); pendingProjects.delete(contentsId); });
      window.on("close", event => record("renderer-lifecycle", "native window close requested", { windowId: window.id, suffix, prevented: event.defaultPrevented }));
      window.on("closed", () => record("renderer-lifecycle", "native window closed", { windowId: window.id, suffix }));
      window.webContents.on("destroyed", () => record("renderer-lifecycle", "native contents destroyed", { windowId: window.id, contentsId, suffix }));
      window.webContents.on("render-process-gone", (_event, details) => record("renderer-lifecycle", "native renderer process gone", { windowId: window.id, suffix, details }));
      window.webContents.on("did-start-navigation", (_event, _url, isSameDocument, isMainFrame) => {
        if (isMainFrame && !isSameDocument) markMainWindowLoading(window);
      });
      // The product title is not overwritten in HTML; this app-owned unique title
      // is used solely to resolve the actual AppKit renderer for native input.
      window.webContents.on("page-title-updated", event => event.preventDefault());
      window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
        const details = typeof level === "object" ? level : { level, message, line, sourceId };
        record("renderer-console", suffix, details);
      });
      const documentURL = new URL(pathname, APP_ORIGIN).href;
      // Match main.ts's development URL route. Metro's lazy modules need its
      // real HTTP document origin; a scheme-proxied document is not equivalent.
      await bounded("Load actual React App", window.loadURL(documentURL), 30000);
      await until("Real HTTP document and production preload ready", () => evaluate(window, `({ready:document.readyState,body:!!document.body,bridge:!!window.paseoDesktop?.plugins})`), value => value.ready === "complete" && value.body && value.bridge, 30000);
      const initialized = await evaluate(window, `(() => { if(localStorage.getItem('omp-native-wallpaper-initialized')) return false; for(const [key,value] of Object.entries(${JSON.stringify(initialStorage)})) localStorage.setItem(key,value); return true; })()`);
      if (initialized) {
        record("state", "owned HTTP profile preparation", { windowId: window.id, documentURL, nextDocument: "fresh registered native BrowserWindow" });
        const preparedContents = window.webContents;
        window.destroy();
        await until("Owned preparer scopes and document lease released", () => ({ destroyed: window.isDestroyed(), owner: registry.getOwner(preparedContents), registered: getMainWindows().includes(window) }), value => value.destroyed && value.owner === null && !value.registered);
        return createWindow(suffix, pathname);
      }
      record("state", "actual native document owner", { windowId: window.id, owner: registry.getOwner(window.webContents)?.nativeIdentity, committed: getCommittedWallpaperDocumentIdentity(window.webContents), version: getMainWindowDocumentVersion(window) });
      await evaluate(window, `(async()=>{window.__wallpaperNativeEvents=[];for(const name of ['desktop-plugins-changed','omp:wallpaper:libraryChanged'])await window.paseoDesktop.events.on(name,event=>{const payload=event&&typeof event==='object'&&'payload'in event?event.payload:event;window.__wallpaperNativeEvents.push({name,time:performance.now(),revision:payload?.revision,wallpaper:payload?.installations?.find(item=>item.id==='wallpaper'),candidates:payload?.items?.map(item=>item.candidateId)});});return true;})()`);
      const debug = window.webContents.debugger;
      if (debug && typeof debug.attach === "function" && typeof debug.sendCommand === "function" && typeof debug.on === "function") {
        try {
          debug.attach("1.3");
          const requests = new Map();
          debug.on("message", (_event, method, params) => {
            if (method === "Network.requestWillBeSent" && params.request.url.startsWith(urlOrigin)) requests.set(params.requestId, params.request.url);
            if (method === "Network.loadingFailed" && requests.has(params.requestId)) record("native-network", "owned URL failed", { windowId: window.id, url: requests.get(params.requestId), errorText: params.errorText, blockedReason: params.blockedReason, canceled: params.canceled });
            if (method === "Network.responseReceived" && params.response.url.startsWith(urlOrigin)) record("native-network", "owned URL response", { windowId: window.id, url: params.response.url, status: params.response.status, mimeType: params.response.mimeType });
          });
          await debug.sendCommand("Network.enable");
          window.webContents.once("destroyed", () => { try { debug.detach(); } catch { /* The owned debugger closes with its renderer. */ } });
          record("state", "native network debugger availability", { windowId: window.id, attached: true });
        } catch (error) { record("state", "native network debugger availability", { windowId: window.id, attached: false, error: error.message }); }
      } else record("state", "native network debugger availability", { windowId: window.id, attached: false, reason: "This actual runtime exposes no network debugger API" });
      window.setTitle(windowTitle); window.show(); window.focus();
      return window;
    };
    const first = await createWindow("A", route);
    let settingsWindow;
    if (!surfacesEvidence) {
    settingsWindow = await createWindow("plugin-catalog", "/");
    await until("Actual native settings gear", () => evaluate(settingsWindow, `!!document.querySelector('[data-testid="sidebar-settings"]')`), Boolean, 30000);
    await click(settingsWindow, '[data-testid="sidebar-settings"]');
    await until("Actual native settings sidebar", () => evaluate(settingsWindow, `!!document.querySelector('[data-testid="settings-sidebar"]')`), Boolean, 30000);
    await click(settingsWindow, '[data-testid="settings-sidebar"] [role="button"]', "插件");
    const catalog = await until("Actual native wallpaper manager row", () => evaluate(settingsWindow, `({href:location.href,row:document.querySelector('[data-testid="plugin-row-local:wallpaper"]')?.innerText||'',body:document.body?.innerText.slice(-6000)||''})`), value => !!value.row, 30000);
    catalog.snapshot = await evaluate(settingsWindow, `window.paseoDesktop.plugins.getSnapshot()`);
    record("state", "actual native wallpaper client manager", catalog);
    await snapshot(settingsWindow, "native-wallpaper-client-manager");
    await click(settingsWindow, '[data-testid="plugin-row-local:wallpaper"] button:not([role="switch"])');
    const configuration = await until("Actual native wallpaper settings contribution", () => evaluate(settingsWindow, `({ready:!!document.querySelector('[data-testid="wallpaper-settings"]'),body:document.body?.innerText.slice(-8000)||''})`), value => value.ready, 30000);
    record("state", "actual native wallpaper controller configuration", configuration);
    await evaluate(settingsWindow, `(()=>{document.querySelector('[data-testid="wallpaper-settings"]').scrollIntoView({block:'start'});return true;})()`);
    await snapshot(settingsWindow, "native-wallpaper-controller-configuration");
    settingsWindow.hide();
    }
    first.show(); first.focus();
    await until("Real owned idle agent composer", () => evaluate(first, `({bridge:!!window.paseoDesktop?.plugins,composer:!!document.querySelector('[data-testid="message-input-root"] textarea'),route:location.pathname,body:document.body?.innerText.slice(-2000)||''})`), value => value.bridge && value.composer && value.route.includes(workspaceId), 30000);
    await evaluate(first, `(() => { window.__wallpaperInputEvents=[]; for(const type of ['keydown','keyup','beforeinput','input','select','selectionchange','focus','blur','scroll']) document.addEventListener(type,event=>{const input=document.querySelector('[data-testid="message-input-root"] textarea');if(!input||(event.target!==input&&event.target!==document))return;window.__wallpaperInputEvents.push({type,time:performance.now(),trusted:event.isTrusted,key:event.key||null,code:event.code||null,length:input.value.length,selection:[input.selectionStart,input.selectionEnd,input.selectionDirection],focused:document.activeElement===input,top:input.scrollTop});},true);return true;})()`);
    let nativeInputAvailable = true;
    let inputFailure = null;
    const draft = "owned-wallpaper-draft-" + "native editing remains unchanged ".repeat(96);
    try {
      await click(first, '[data-testid="message-input-root"] textarea');
      native.text(draft);
      await until("Real native keyboard draft", () => evaluate(first, `document.querySelector('[data-testid="message-input-root"] textarea').value`), value => value === draft);
      first.focus();
      await until("Real native key before selecting baseline", () => native.geometry(first.getTitle()), value => value.isKey);
      native.keyCode(0, 2);
      await until("Real native selected draft", () => evaluate(first, `(()=>{const input=document.querySelector('[data-testid="message-input-root"] textarea');return [input.selectionStart,input.selectionEnd];})()`), value => value[0] === 0 && value[1] === draft.length);
      await delay(250);
    } catch (error) {
      nativeInputAvailable = false;
      inputFailure = { message: error.message, native: native.geometry(first.getTitle()), focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null };
      check("native input prerequisite", inputFailure, "Owned AppKit renderer must really become key and receive native input; guard remains strict", false);
    }
    await evaluate(first, `(() => { const input=document.querySelector('[data-testid="message-input-root"] textarea'); window.__wallpaperInput=input; let surface=input.parentElement; while(surface && (getComputedStyle(surface).backgroundColor==='transparent'||getComputedStyle(surface).backgroundColor==='rgba(0, 0, 0, 0)')) surface=surface.parentElement; if(!surface) throw Error('No production composer color surface'); window.__wallpaperSurface=surface; const scroll=[input]; if(${nativeInputAvailable}) { for(let node=input.parentElement;node;node=node.parentElement) if(node.scrollHeight>node.clientHeight+10) scroll.push(node); for(const node of scroll) if(node.scrollHeight>node.clientHeight+10) node.scrollTop=Math.min(31,node.scrollHeight-node.clientHeight); } window.__wallpaperScroll=scroll; return true; })()`);
    if (nativeInputAvailable) {
      baseline = await state(first);
      check("nontrivial real input baseline", baseline, "Selected native-entered draft and at least one nonzero actual scroll offset", baseline.identity && baseline.focused && baseline.value === draft && baseline.selection[0] !== baseline.selection[1] && baseline.scroll.some(item => item.top > 0));
      record("state", "native input event baseline", await evaluate(first, `({count:window.__wallpaperInputEvents.length,last:window.__wallpaperInputEvents.slice(-40)})`));
    } else {
      record("blocked", "input preservation baseline", inputFailure, "Independent actual native rendering/lease matrix continues; input acceptance remains failed");
    }
    await stable(first, "none-initial", 1);

    // File candidates are validated by production, not a fake registry/file response.
    // One real native picker addition is exercised below; bulk files only stress
    // the production preview ceiling without fifty manual picker interactions.
    const files = await Promise.all(Array.from({ length: 49 }, (_, index) => validateWallpaperFile(path.join(run, "fixtures", `iris-${String(index).padStart(2, "0")}.png`))));
    const added = await store.addWallpaperCandidates(files);
    check("add does not apply or copy originals", { config: (await store.getPlugins()).installations.find(item => item.id === "wallpaper").config, library: added.library, originals: files.map(file => fs.existsSync(file.path)) }, "source none and original files remain; library paths are originals", added.library.items.every(item => files.some(file => file.path === item.path)) && (await store.getPlugins()).installations.find(item => item.id === "wallpaper").config.source === "none");
    const A = added.library.items[0], B = added.library.items[1];
    const waitFile = async (window, candidate) => until("Current genuine file image decoded", async () => ({ lease: holding(window, "background"), state: await state(window) }), value => value.lease.media[0]?.candidateId === candidate.candidateId && value.state.media.some(media => media.ready && media.src === value.lease.media[0].uri));
    if (fileEvidence) {
      assert.ok(inside(root, fileEvidence));
      const previous = JSON.parse(fs.readFileSync(fileEvidence, "utf8"));
      const labels = ["file-opacity-0", "file-opacity-0.85", "file-opacity-1", "off-retains-file-opacity-one", "reenable-retained-file", "null-provider-retains-file-config", "reselected-provider-retains-file", "file-null-candidate", "url-explicit-null", "none-explicit-nulls"];
      for (const label of labels) for (const assertion of ["composer identity/focus/selection/draft/scroll", "surface alpha"]) assert.ok(previous.some(row => row.kind === "pass" && row.label === `${label}: ${assertion}`), `Prior genuine GUI evidence is missing ${label}: ${assertion}`);
      record("reuse", "unchanged file/opacity/off/null GUI matrix", { fileEvidence, labels });
    } else {
      for (const opacity of [0, 0.85, 1]) {
        await configPatch({ source: "file", candidateId: A.candidateId, url: null, opacity });
        await waitFile(first, A);
        const observed = await stable(first, `file-opacity-${opacity}`, 1 - opacity);
        const lease = holding(first, "background");
        check(`file-opacity-${opacity}: real protected media`, { lease, media: observed.media }, "Native-bound production background lease and decoded actual image", lease.nativeIdentity?.contentsId === first.webContents.id && lease.media.length === 1 && lease.media[0].candidateId === A.candidateId && observed.media.some(item => item.ready && item.src.includes("wallpaper-media")));
      }
      await patch({ enabled: false }); await stable(first, "off-retains-file-opacity-one", 1);
      check("off retains configured choice", (await store.getPlugins()).installations.find(item => item.id === "wallpaper"), "Disabled, original A and opacity 1 retained", (await store.getPlugins()).installations.find(item => item.id === "wallpaper").config.candidateId === A.candidateId);
      await patch({ enabled: true }); await stable(first, "reenable-retained-file", 0);
      const beforeDeselect = await store.getPlugins();
      await store.selectPluginBackground(null, beforeDeselect.revision);
      await stable(first, "null-provider-retains-file-config", 1);
      check("null provider revokes playback without erasing selection", { provider: (await store.getPlugins()).backgroundProvider, config: (await store.getPlugins()).installations.find(item => item.id === "wallpaper").config, holding: holding(first, "background") }, "Null provider, retained A/opacity 1, no playback holding", (await store.getPlugins()).backgroundProvider === null && (await store.getPlugins()).installations.find(item => item.id === "wallpaper").config.candidateId === A.candidateId && holding(first, "background").media.length === 0);
      await store.selectPluginBackground({ installationId: "wallpaper", extensionId: "wallpaper" }, (await store.getPlugins()).revision);
      await waitFile(first, A); await stable(first, "reselected-provider-retains-file", 0);
      await configPatch({ source: "file", candidateId: null, opacity: 0.85 }); await stable(first, "file-null-candidate", 1);
      await configPatch({ source: "url", url: null }); await stable(first, "url-explicit-null", 1);
      await configPatch({ source: "none", candidateId: null, url: null }); await stable(first, "none-explicit-nulls", 1);
    }
    if (urlEvidence) {
      assert.ok(inside(root, urlEvidence));
      const previous = JSON.parse(fs.readFileSync(urlEvidence, "utf8"));
      const labels = ["url-loading-opacity-0", "url-ready-opacity-0", "url-loading-opacity-0.85", "url-ready-opacity-0.85", "url-loading-opacity-1", "url-ready-opacity-1", "late-A1-B-still-opaque", "A2-current-ready", "URL-real-load-failure"];
      for (const label of labels) for (const assertion of ["composer identity/focus/selection/draft/scroll", "surface alpha"]) assert.ok(previous.some(row => row.kind === "pass" && row.label === `${label}: ${assertion}`), `Prior genuine GUI evidence is missing ${label}: ${assertion}`);
      assert.ok(previous.some(row => row.label === "actual native HTTP PNG decode diagnostic" && row.observed.image.decoded && row.observed.png.bytes === irisBytes.length));
      record("reuse", "unchanged URL opacity/loading/race GUI matrix", { urlEvidence, labels });
    } else {
      const httpDiagnostic = await evaluate(first, `(async()=>{const uri=${JSON.stringify(urlOrigin + "/probe-native-png.png")};const read=async(url,kind)=>{let stage='fetch';try{const response=await fetch(url);stage=kind==='text'?'read-text':'read-array-buffer';if(kind==='text')return {stage:'complete',status:response.status,type:response.headers.get('content-type'),text:await response.text()};const bytes=new Uint8Array(await response.arrayBuffer());return {stage:'complete',status:response.status,type:response.headers.get('content-type'),bytes:bytes.length,prefix:Array.from(bytes.subarray(0,16))};}catch(error){return {stage,error:String(error)};}};const text=await read(${JSON.stringify(urlOrigin + "/probe-native-ascii.txt")},'text'),png=await read(uri,'png');const image=new Image();image.src=uri;let decoded=true,error=null;try{await image.decode();}catch(failure){decoded=false;error=String(failure);}return {origin:location.origin,baseURI:document.baseURI,secure:isSecureContext,text,png,image:{decoded,error,width:image.naturalWidth,height:image.naturalHeight}};})()`);
      record("state", "actual native HTTP PNG decode diagnostic", { expectedBytes: irisBytes.length, ...httpDiagnostic });
      for (const opacity of [0, 0.85, 1]) {
        const pathname = `/hold-opacity-${opacity}.png`;
        await configPatch({ source: "url", url: `${urlOrigin}${pathname}`, opacity });
        await until("Real delayed URL request", () => pendingResponses.get(pathname)?.length || 0, count => count > 0);
        await stable(first, `url-loading-opacity-${opacity}`, 1);
        check(`URL ${opacity}: cannot be ready early`, await state(first), "Unreleased real URL is not decoded", !(await state(first)).media.some(item => item.src.includes(pathname) && item.ready));
        release(pathname);
        await until("Released URL genuinely decoded", () => state(first), value => value.media.some(media => media.ready && media.src.includes(pathname)));
        await stable(first, `url-ready-opacity-${opacity}`, 1 - opacity);
      }
      // A→B→A uses three different real request attempts. A late load event from
      // the removed B element cannot settle or change the current A surface.
      const heldA = "/hold-race-A1.png", heldB = "/hold-race-B.png", finalA = "/hold-race-A2.png";
      await configPatch({ url: `${urlOrigin}${heldA}`, opacity: 0.85 });
      await until("A1 pending", () => pendingResponses.get(heldA)?.length || 0, count => count > 0);
      await configPatch({ url: `${urlOrigin}${heldB}` });
      await until("B pending", () => pendingResponses.get(heldB)?.length || 0, count => count > 0);
      await configPatch({ url: `${urlOrigin}${finalA}` });
      await until("A2 pending", () => pendingResponses.get(finalA)?.length || 0, count => count > 0);
      release(heldA); release(heldB);
      await stable(first, "late-A1-B-still-opaque", 1);
      release(finalA); await stable(first, "A2-current-ready", 0.15);
    }
    const observeRetryWindow = async () => {
      // Ready is published before AppearanceProvider's passive effect. The sidebar
      // is a primary authored surface, not an intentionally opaque popover: apply.ts
      // gives surfaceSidebar alpha 1-opacity and base surface0 alpha zero.
      try {
        const appearance = await until("Retried current window actually applies ready-media surface alpha", () => evaluate(settingsWindow, `(() => {const node=document.querySelector('[data-testid="settings-sidebar"]');if(!node)throw Error('Missing actual settings sidebar');const color=getComputedStyle(node).backgroundColor;return {color,alpha:color==='transparent'?0:color.startsWith('rgba')?Number(color.match(/[\\d.]+/g)[3]):1};})()`), value => Math.abs(value.alpha - 0.15) < 0.025, 5000);
        check("retry current native window ready-media sidebar alpha", appearance, "Actual primary surface alpha 0.15; opaque controls are observed separately", Math.abs(appearance.alpha - 0.15) < 0.025);
      } catch (error) { check("retry current native window ready-media sidebar alpha", { message: error.message }, "Actual primary surface must apply ready media; capture real major regions even on failure", false); }
      await bounded("Prepare genuine retried native window", settingsWindow.webContents.prepareToShow());
      const observed = await evaluate(settingsWindow, `(() => {const alpha=color=>color==='transparent'?0:color.startsWith('rgba')?Number(color.match(/[\\d.]+/g)[3]):1;const describe=node=>{if(!node)return null;const style=getComputedStyle(node),r=node.getBoundingClientRect();return {tag:node.tagName,testid:node.dataset?.testid,color:style.backgroundColor,alpha:alpha(style.backgroundColor),opacity:style.opacity,x:r.x,y:r.y,width:r.width,height:r.height};};const regions=['[data-testid="settings-sidebar"]','[data-testid="wallpaper-settings"]','body'].map(selector=>{const node=document.querySelector(selector),ancestors=[];for(let parent=node?.parentElement,depth=0;parent&&depth<4;parent=parent.parentElement,depth++)ancestors.push(describe(parent));return {selector,surface:describe(node),ancestors};});const media=[...document.images].filter(node=>(node.currentSrc||node.src).includes('/error-retry.png')).map(node=>{const layers=[];for(let parent=node,depth=0;parent&&depth<6;parent=parent.parentElement,depth++){const style=getComputedStyle(parent);layers.push({...describe(parent),backgroundImage:style.backgroundImage});}return {src:node.currentSrc||node.src,ready:node.complete&&node.naturalWidth>0,width:node.naturalWidth,height:node.naturalHeight,layers};});return {href:location.href,visibility:document.visibilityState,regions,media};})()`);
      record("state", "actual retried native window regions and media layers", { ...observed, native: native.geometry(settingsWindow.getTitle()), app: native.appState(), first: await state(first) });
      await snapshot(settingsWindow, "actual-retry-window-major-regions");
    };
    if (independentEvidence) {
      assert.ok(inside(root, independentEvidence));
      const previous = JSON.parse(fs.readFileSync(independentEvidence, "utf8"));
      const labels = ["real retry and per-window media failure isolation", "two real documents hold independent leases", "actual project switch retains local wallpaper ownership", "closing second releases only second document", "real IPC preview limit accepts 48", "real IPC preview limit rejects 49", "late preview release cannot clear competing activation", "competing activation release cleans only its preview lease", "preview release leaves background intact", "stale preview revision rejected", "released activation cannot call old RPC", "real remote host keeps Desktop wallpaper local", "opaque-model-popup-controls"];
      for (const label of labels) assert.ok(previous.some(row => row.kind === "pass" && row.label === label), `Prior genuine GUI evidence is missing ${label}`);
      for (const label of ["URL-real-retry-success", "return-file-A", "file-B", "file-A-again", "second-window-does-not-remount-first", "second-close-first-remains-ready", "preview-lifecycle-preserves-composer", "real-remote-window-release-preserves-local-background"]) for (const assertion of ["composer identity/focus/selection/draft/scroll", "surface alpha"]) assert.ok(previous.some(row => row.kind === "pass" && row.label === `${label}: ${assertion}`), `Prior genuine GUI evidence is missing ${label}: ${assertion}`);
      record("reuse", "unchanged independent native GUI matrix", { independentEvidence, labels });
      if (nativeInputAvailable && !surfacesEvidence) {
        try {
          await configPatch({ source: "url", url: `${urlOrigin}/error-retry.png`, opacity: 0.85 });
          await until("Missing retry visual prerequisite: real error control", () => evaluate(settingsWindow, `!!document.querySelector('[data-testid="wallpaper-settings"] div[role="alert"] button')`), Boolean);
          retryFailures = false;
          await click(settingsWindow, '[data-testid="wallpaper-settings"] div[role="alert"] button');
          await until("Missing retry visual prerequisite: actual image decoded", () => evaluate(settingsWindow, `({ready:[...document.images].some(node=>(node.currentSrc||node.src).includes('/error-retry.png')&&node.complete&&node.naturalWidth>0),retry:!!document.querySelector('[data-testid="wallpaper-settings"] div[role="alert"] button')})`), value => value.ready && !value.retry);
          await observeRetryWindow();
        } catch (error) { check("retry actual native major-region render prerequisite", { message: error.message }, "Current native document must remain available for the missing visual observation", false); }
        finally { if (!settingsWindow.isDestroyed()) settingsWindow.hide(); first.show(); first.focus(); }
      } else if (!surfacesEvidence) record("blocked", "retry actual native major-region render prerequisite", inputFailure, "Requires genuine native input");
      await configPatch({ source: "file", candidateId: A.candidateId, url: null, opacity: 0.85 });
      await waitFile(first, A);
    } else {
    await configPatch({ source: "url", url: `${urlOrigin}/error-retry.png`, opacity: 0.85 });
    await until("Real URL failure response requested", () => urlRequests.filter(request => request.path === "/error-retry.png").length, count => count > 0);
    await stable(first, "URL-real-load-failure", 1);
    if (nativeInputAvailable) {
      try {
        await until("Real failed controller offers retry", () => evaluate(settingsWindow, `!!document.querySelector('[data-testid="wallpaper-settings"] div[role="alert"] button')`), Boolean);
        retryFailures = false;
        const beforeRetry = urlRequests.filter(request => request.path === "/error-retry.png").length;
        await click(settingsWindow, '[data-testid="wallpaper-settings"] div[role="alert"] button');
        const retried = await until("Real settings retry decodes same URL", () => evaluate(settingsWindow, `({media:[...document.images].filter(node=>(node.currentSrc||node.src).includes('/error-retry.png')).map(node=>({src:node.currentSrc||node.src,ready:node.complete&&node.naturalWidth>0})),retry:!!document.querySelector('[data-testid="wallpaper-settings"] div[role="alert"] button')})`), value => value.media.some(media => media.ready) && !value.retry);
        check("real retry and per-window media failure isolation", { retried, first: await state(first), requests: urlRequests.filter(request => request.path === "/error-retry.png") }, "Second document retry loads same real URL; first failed document remains opaque", urlRequests.filter(request => request.path === "/error-retry.png").length > beforeRetry && Math.abs((await state(first)).alpha - 1) < 0.025);
        await observeRetryWindow();
        await snapshot(settingsWindow, "real-same-URL-retry-second-window");
      } catch (error) {
        check("real retry and per-window media failure isolation", { message: error.message, settingsDestroyed: settingsWindow.isDestroyed(), contentsDestroyed: settingsWindow.webContents.isDestroyed(), first: await state(first) }, "Genuine retry must leave its native renderer alive and decode; independent native scenarios continue with this failure retained", false);
      } finally {
        if (!settingsWindow.isDestroyed()) settingsWindow.hide();
        first.show(); first.focus();
        await until("First owned native key restored", () => native.geometry(first.getTitle()), value => value.isKey);
      }
    } else {
      record("blocked", "native retry control and per-window UI retry", inputFailure, "Requires genuine key/native click; no DOM click or replacement controller");
    }
    await configPatch({ url: `${urlOrigin}/retry-success.png` }); await stable(first, "URL-real-retry-success", 0.15);
    await configPatch({ source: "file", candidateId: A.candidateId, url: null }); await waitFile(first, A); await stable(first, "return-file-A", 0.15);
    await configPatch({ candidateId: B.candidateId }); await waitFile(first, B); await stable(first, "file-B", 0.15);
    await configPatch({ candidateId: A.candidateId }); await waitFile(first, A); await stable(first, "file-A-again", 0.15);

    const second = await createWindow("B", route);
    await until("Second real agent composer", () => evaluate(second, `!!document.querySelector('[data-testid="message-input-root"] textarea')`), Boolean, 30000);
    await until("Second independent production lease", () => holding(second, "background"), value => value.media.length === 1);
    const secondLease = holding(second, "background");
    check("two real documents hold independent leases", { first: holding(first, "background"), second: secondLease }, "Different native contents/epochs/media IDs for the same file", holding(first, "background").epoch !== secondLease.epoch && holding(first, "background").media[0].id !== secondLease.media[0].id);
    const beforeProject = { config: (await store.getPlugins()).installations.find(item => item.id === "wallpaper").config, library: await store.getWallpaperLibrary(), first: holding(first, "background"), second: secondLease };
    try {
      const selector = `[data-testid^="sidebar-workspace-row-"][data-testid$="${otherWorkspaceId}"]`;
      const rows = await until("Existing owned second workspace row", () => evaluate(second, `([...document.querySelectorAll(${JSON.stringify(selector)})].map(node=>({testid:node.dataset.testid,label:node.textContent})))`), value => value.length === 1, 30000);
      await click(second, selector);
      const projectRoute = await until("Actual owned project route switch", () => evaluate(second, `location.href`), value => value.includes(otherWorkspaceId), 30000);
      await waitFile(second, A);
      const afterProject = { config: (await store.getPlugins()).installations.find(item => item.id === "wallpaper").config, library: await store.getWallpaperLibrary(), first: holding(first, "background"), second: holding(second, "background") };
      check("actual project switch retains local wallpaper ownership", { rows, projectRoute, beforeProject, afterProject }, "Real workspace changes retain Desktop config/library and the untouched first lease; switched document stays natively authorized", JSON.stringify(beforeProject.config) === JSON.stringify(afterProject.config) && JSON.stringify(beforeProject.library) === JSON.stringify(afterProject.library) && beforeProject.first.media[0].id === afterProject.first.media[0].id && afterProject.second.media[0].candidateId === A.candidateId && afterProject.second.media[0].scope.installationId === "wallpaper" && afterProject.second.nativeIdentity.contentsId === second.webContents.id);
      await snapshot(second, "actual-owned-project-switch-local-wallpaper");
    } catch (error) { check("actual project switch retains local wallpaper ownership", { message: error.message, otherWorkspaceId }, "Second owned workspace must be actually reachable through the native sidebar", false); }
    if (!second.isDestroyed()) second.hide(); first.show(); first.focus();
    await stable(first, "second-window-does-not-remount-first", 0.15);
    const secondContents = second.webContents;
    if (!second.isDestroyed()) second.destroy();
    check("closing second releases only second document", { secondOwner: registry.getOwner(secondContents), first: holding(first, "background") }, "Second owner gone; first lease unchanged", registry.getOwner(secondContents) === null && holding(first, "background").media.length === 1);
    await stable(first, "second-close-first-remains-ready", 0.15);

    // Production preload creates actual management activations. Commands travel
    // through production scope authorization/revisions, not direct registry.set.
    const fixtureScope = `native-wallpaper-previews-${randomUUID()}`;
    const scope = await evaluate(first, `(async () => { const record=(await paseoDesktop.plugins.getSnapshot()).installations.find(item=>item.id==='wallpaper'); const scope={installationId:record.id,generation:record.generation,clientActivationId:${JSON.stringify(fixtureScope)},mode:'manage'}; await paseoDesktop.plugins.openClientScope(scope); window.__wallpaperScope=scope; const response=await paseoDesktop.plugins.publish({...scope,method:'wallpaper:getContext',input:{}}); if(!response.ok) throw Error(JSON.stringify(response)); window.__wallpaperEpoch=response.data.epoch; return scope; })()`);
    const preview = (ids, revision) => evaluate(first, `(async () => paseoDesktop.plugins.publish({...window.__wallpaperScope,method:'wallpaper:setPreviews',input:{epoch:window.__wallpaperEpoch,revision:${revision},candidateIds:${JSON.stringify(ids)}}}))()`);
    const preview48 = await preview(added.library.items.slice(0, 48).map(item => item.candidateId), 1);
    check("real IPC preview limit accepts 48", { response: preview48, holding: holding(first, "previews") }, "48 bounded authorized preview leases", preview48.ok && preview48.data.media.length === 48 && holding(first, "previews").media.length === 48);
    const preview49 = await preview(added.library.items.slice(0, 49).map(item => item.candidateId), 2);
    check("real IPC preview limit rejects 49", preview49, "invalid-request without increasing held media", !preview49.ok && preview49.code === "invalid-request" && holding(first, "previews").media.length === 48);
    const competitorScope = `native-wallpaper-competitor-${randomUUID()}`;
    const competing = await evaluate(first, `(async () => { const scope={...window.__wallpaperScope,clientActivationId:${JSON.stringify(competitorScope)}}; await paseoDesktop.plugins.openClientScope(scope); window.__wallpaperCompetitor=scope; return paseoDesktop.plugins.publish({...scope,method:'wallpaper:setPreviews',input:{epoch:window.__wallpaperEpoch,revision:1,candidateIds:[${JSON.stringify(B.candidateId)}]}}); })()`);
    const staleClear = await preview([], 3);
    check("late preview release cannot clear competing activation", { competing, staleClear, holding: holding(first, "previews") }, "New B holding survives previous client's clear", competing.ok && !staleClear.ok && staleClear.code === "stale-document" && holding(first, "previews").media[0]?.candidateId === B.candidateId);
    await evaluate(first, `(async () => { await paseoDesktop.plugins.releaseClientScope(window.__wallpaperCompetitor); })()`);
    check("competing activation release cleans only its preview lease", { previews: holding(first, "previews"), background: holding(first, "background") }, "Preview cleared, unrelated active background stays", holding(first, "previews").media.length === 0 && holding(first, "background").media.length === 1);
    const released = await preview([], 4);
    check("preview release leaves background intact", { released, previews: holding(first, "previews"), background: holding(first, "background") }, "Empty previews; same active file background", released.ok && holding(first, "previews").media.length === 0 && holding(first, "background").media.length === 1);
    const stale = await preview([A.candidateId], 1).then(value => ({ value }), error => ({ error: error.message }));
    check("stale preview revision rejected", stale, "Superseded activation revision cannot reacquire", !!stale.error || stale.value?.ok === false);
    await evaluate(first, `(async () => { await paseoDesktop.plugins.releaseClientScope(window.__wallpaperScope); })()`);
    const staleActivation = await preview([A.candidateId], 5).then(value => ({ value }), error => ({ error: error.message }));
    check("released activation cannot call old RPC", { scope, result: staleActivation }, "Production bridge rejects released client activation", !!staleActivation.error);
    await stable(first, "preview-lifecycle-preserves-composer", 0.15);
    const beforeRemote = { config: (await store.getPlugins()).installations.find(item => item.id === "wallpaper").config, library: await store.getWallpaperLibrary(), first: holding(first, "background") };
    let remoteWindow;
    try {
      remoteWindow = await createWindow("remote-host", "/h/desktop-other/settings");
      const remoteUI = await until("Actual second daemon connected in native App", () => evaluate(remoteWindow, `(() => {const identity=document.querySelector('[data-testid="host-page-identity"]');return {href:location.href,identity:identity?.textContent||''};})()`), value => value.href.includes("desktop-other") && value.identity.includes("Online") && value.identity.includes("18772"), 30000);
      await waitFile(remoteWindow, A);
      const afterRemote = { config: (await store.getPlugins()).installations.find(item => item.id === "wallpaper").config, library: await store.getWallpaperLibrary(), first: holding(first, "background"), remote: holding(remoteWindow, "background") };
      check("real remote host keeps Desktop wallpaper local", { remoteUI, beforeRemote, afterRemote }, "Real B18772 is online; unchanged local file library/config/A lease, separate native document lease on the remote route", JSON.stringify(beforeRemote.config) === JSON.stringify(afterRemote.config) && JSON.stringify(beforeRemote.library) === JSON.stringify(afterRemote.library) && beforeRemote.first.media[0].id === afterRemote.first.media[0].id && afterRemote.remote.nativeIdentity.contentsId === remoteWindow.webContents.id && afterRemote.remote.media[0].candidateId === A.candidateId && afterRemote.remote.media[0].scope.installationId === "wallpaper" && afterRemote.remote.media[0].id !== afterRemote.first.media[0].id);
      await snapshot(remoteWindow, "real-B18772-local-wallpaper-native-document");
    } catch (error) {
      check("real secondary host native acceptance prerequisite", { message: error.message, route: "/h/desktop-other/settings", endpoint: "127.0.0.1:18772" }, "UI slice's real owned B daemon must remain online; no simulated remote host", false);
    } finally {
      if (remoteWindow && !remoteWindow.isDestroyed()) remoteWindow.destroy();
      first.show(); first.focus();
    }
    await stable(first, "real-remote-window-release-preserves-local-background", 0.15);
    }

    if (surfacesEvidence) {
      const previous = JSON.parse(fs.readFileSync(surfacesEvidence, "utf8"));
      const labels = ["retry current native window ready-media sidebar alpha", "opaque-attachment-menu", "menus retain genuine input and complete draft", "post-menu-native-editing-baseline: composer identity/focus/selection/draft/scroll", "picker-dialog-lifecycle-keeps-agent-input: composer identity/focus/selection/draft/scroll"];
      for (const label of labels) assert.ok(previous.some(row => row.kind === "pass" && row.label === label), `Prior genuine surface evidence is missing ${label}`);
      assert.ok(previous.some(row => row.label === "actual-retry-window-major-regions" && row.kind === "screenshot"));
      record("reuse", "passed current-window retry, settled menu and genuine input GUI", { surfacesEvidence, labels });
      record("blocked", "native file-picker remaining GUI", { prerequisite: "Actual OS-visible NSRemoteView pixels and user-assisted system-picker selection/cancellation; CGPost is TCC-denied" }, "Keep qnw0Gy observed native invocation/owner and failed Escape distinct; accept/delete/re-add and visual opacity remain required");
    } else if (nativeInputAvailable) {
    await click(first, '[data-testid="message-input-attach-button"]');
    await until("Real product attachment menu", () => evaluate(first, `!!document.querySelector('[data-testid="message-input-attachment-menu"]')`), Boolean);
    const opaque = async (selector, label) => {
      let observed;
      try {
        const settled = await until(`${label}: real entering animation settles`, () => evaluate(first, `(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing product surface');const surfaces=[];for(let root=node,depth=0;root&&depth<8;root=root.parentElement,depth++){const style=getComputedStyle(root);surfaces.push({tag:root.tagName,testid:root.dataset.testid,color:style.backgroundColor,opacity:style.opacity});}return {visibility:document.visibilityState,hidden:document.hidden,timeline:document.timeline.currentTime,surfaces,animations:node.getAnimations({subtree:true}).map(animation=>({currentTime:animation.currentTime,playState:animation.playState,startTime:animation.startTime}))};})()`), value => value.surfaces.every(item => Number(item.opacity) === 1), 5000);
        observed = settled.surfaces;
        record("state", `${label}: actual native settled animation`, settled);
      } catch (error) {
        check(label, { message: error.message }, "Actual native menu must reach opaque resting state; no animation/style substitution", false);
        await snapshot(first, label);
        return;
      }
      const alpha = color => color === "transparent" ? 0 : color.startsWith("rgba") ? Number(color.match(/[\d.]+/g)?.[3]) : 1;
      const surface = observed.find(item => alpha(item.color) > 0);
      const passes = !!surface && alpha(surface.color) === 1 && observed.every(item => Number(item.opacity) === 1);
      check(label, observed, "An opaque product surface and no translucent ancestor", passes); await snapshot(first, label);
    };
    await opaque('[data-testid="message-input-attachment-menu"]', "opaque-attachment-menu");
    native.keyCode(53, 0); await delay(100);
    if (!independentEvidence) {
    await click(first, 'button[aria-label^="选择模型"]');
    await until("Real product model popup", () => evaluate(first, `!!document.querySelector('[data-testid="agent-controls-model-sheet"], [data-testid="combobox-desktop-container"]')`), Boolean);
    await opaque('[data-testid="agent-controls-model-sheet"], [data-testid="combobox-desktop-container"]', "opaque-model-popup-controls");
    native.keyCode(53, 0); await delay(100);
    }
    await click(first, '[data-testid="message-input-root"] textarea');
    native.keyCode(0, 2);
    await until("Post-menu native selected draft", () => evaluate(first, `(()=>{const input=document.querySelector('[data-testid="message-input-root"] textarea');return [input.selectionStart,input.selectionEnd];})()`), value => value[0] === 0 && value[1] === draft.length);
    const postMenu = await state(first);
    check("menus retain genuine input and complete draft", postMenu, "Same input node and draft after real menu interactions", postMenu.identity && postMenu.value === baseline.value && postMenu.focused);
    baseline = postMenu;
    await stable(first, "post-menu-native-editing-baseline", 0.15);

    // A real production settings document exercises actual picker and confirmation
    // dialog; it never replaces the agent document or its composer controls.
    if (settingsWindow.isDestroyed()) {
      settingsWindow = await createWindow("post-retry-plugin-catalog", "/");
      await until("New genuine settings gear", () => evaluate(settingsWindow, `!!document.querySelector('[data-testid="sidebar-settings"]')`), Boolean, 30000);
      await click(settingsWindow, '[data-testid="sidebar-settings"]');
      await until("New genuine settings sidebar", () => evaluate(settingsWindow, `!!document.querySelector('[data-testid="settings-sidebar"]')`), Boolean);
      await click(settingsWindow, '[data-testid="settings-sidebar"] [role="button"]', "插件");
      await until("New genuine wallpaper row", () => evaluate(settingsWindow, `!!document.querySelector('[data-testid="plugin-row-local:wallpaper"]')`), Boolean);
      await click(settingsWindow, '[data-testid="plugin-row-local:wallpaper"] button:not([role="switch"])');
      await until("New genuine wallpaper settings", () => evaluate(settingsWindow, `!!document.querySelector('[data-testid="wallpaper-settings"]')`), Boolean);
    }
    try {
    if (pickerCancelOnly) record("blocked", "actual production picker accept/delete/re-add GUI", { prerequisite: "User-assisted native picker acceptance; global CGPost is TCC-denied and no prompt or bypass is authorized" }, "Adding without applying/copying, opaque deletion, original preservation and fresh re-add remain required");
    await click(settingsWindow, '[data-testid="wallpaper-add-files"]');
    const panel = await until("Native production open panel", () => native.sheetState(), value => value.openPanel || value.sheet);
    check("real production native picker is visible owned sheet with solid backing", panel, "Visible NSOpenPanel attached to this settings document; window and backing alpha 1 do not establish remote-view pixel opacity", panel.panels.some(item => item.visible && item.sheetParentTitle === settingsWindow.getTitle() && item.alpha === 1 && item.backgroundAlpha === 1));
    const panelFile = path.join(evidence, `${String(rows.length).padStart(3, "0")}-actual-production-native-open-panel.png`);
    record("screenshot", "actual-production-native-open-panel", { file: panelFile, native: native.panelView(panelFile) });
    if (pickerCancelOnly) record("blocked", "actual native file-picker visual opacity", { prerequisite: "OS-visible NSRemoteView pixels or human visual inspection; owned NSView cache does not capture the remote file-chooser contents" }, "Keep the actual pane artifact, but no visual opacity claim from NSWindow.isOpaque or backing alpha alone");
    if (pickerCancelOnly) {
      const beforeCancel = await store.getWallpaperLibrary();
      native.keyCode(53, 0);
      await until("Real production native picker actually canceled", () => native.sheetState(), value => !value.panels.some(item => item.visible && item.sheetParentTitle === settingsWindow.getTitle()));
      await until("Production picker action restored after native cancellation", () => evaluate(settingsWindow, `(() => {const button=document.querySelector('[data-testid="wallpaper-add-files"]');return button&&!button.disabled;})()`), Boolean);
      const afterCancel = await store.getWallpaperLibrary();
      check("actual native picker cancellation does not mutate wallpaper library", { beforeCancel, afterCancel }, "Original library unchanged by production canceled callback", JSON.stringify(beforeCancel) === JSON.stringify(afterCancel));
    } else {
    native.keyCode(5, 3); await delay(200);
    native.text(path.join(run, "fixtures/iris-49.png")); native.keyCode(36, 0); await delay(300); native.keyCode(36, 0);
    await until("Native picker committed original candidate", () => store.getWallpaperLibrary(), value => value.items.some(item => item.path === path.join(run, "fixtures/iris-49.png")), 15000);
    const afterPicker = await store.getWallpaperLibrary();
    const picked = afterPicker.items.find(item => item.path === path.join(run, "fixtures/iris-49.png"));
    check("native picker adds without applying or copying", { picked, config: (await store.getPlugins()).installations.find(item => item.id === "wallpaper").config }, "Original path recorded; active A remains selected", picked.path === path.join(run, "fixtures/iris-49.png") && (await store.getPlugins()).installations.find(item => item.id === "wallpaper").config.candidateId === A.candidateId);
    await click(settingsWindow, '[data-testid="wallpaper-manage"]');
    await evaluate(settingsWindow, `(() => { const grid=document.querySelector('[data-testid="wallpaper-settings"] [role="grid"]'); if(!grid) throw Error('Missing production candidate grid'); grid.scrollTop=grid.scrollHeight; })()`);
    await until("Actual virtualized picked candidate mounted", () => evaluate(settingsWindow, `!!document.querySelector('button[data-candidate-id="${picked.candidateId}"]')`), Boolean);
    await click(settingsWindow, `button[data-candidate-id="${picked.candidateId}"]`);
    await click(settingsWindow, '[data-testid="wallpaper-remove-selected"]');
    const dialog = await until("Actual wallpaper confirmation dialog", () => evaluate(settingsWindow, `(() => {const node=document.querySelector('dialog[open]');return node?{color:getComputedStyle(node).backgroundColor,opacity:getComputedStyle(node).opacity}:null;})()`), Boolean);
    check("opaque actual wallpaper dialog", dialog, "Solid product dialog and opacity 1", /^rgb\(/.test(dialog.color) && Number(dialog.opacity) === 1);
    await snapshot(settingsWindow, "opaque-real-wallpaper-delete-dialog");
    await click(settingsWindow, '[data-testid="wallpaper-confirm-remove"]');
    await until("Candidate removed", () => store.getWallpaperLibrary(), value => !value.items.some(item => item.candidateId === picked.candidateId));
    check("delete does not delete original file", { path: picked.path, exists: fs.existsSync(picked.path) }, "Original still exists", fs.existsSync(picked.path));
    await click(settingsWindow, '[data-testid="wallpaper-add-files"]');
    await until("Native production re-add panel", () => native.sheetState(), value => value.openPanel || value.sheet);
    native.keyCode(5, 3); await delay(200);
    native.text(picked.path); native.keyCode(36, 0); await delay(300); native.keyCode(36, 0);
    const readded = await until("Native picker re-adds fresh identity", () => store.getWallpaperLibrary(), value => value.items.some(item => item.path === picked.path && item.candidateId !== picked.candidateId));
    check("same path native picker re-add never revives removed identity", { old: picked.candidateId, new: readded.items.find(item => item.path === picked.path)?.candidateId }, "A fresh candidate identity from actual picker", readded.items.some(item => item.path === picked.path && item.candidateId !== picked.candidateId) && !readded.items.some(item => item.candidateId === picked.candidateId));
    }
    } catch (error) {
      check("real native picker and deletion UI lifecycle", { message: error.message, panels: native.sheetState(), app: native.appState() }, "Actual owned sheet, selection, opaque confirmation and fresh re-add are required; failure stays recorded", false);
      if (!settingsWindow.isDestroyed()) await snapshot(settingsWindow, "actual-native-picker-failure");
    } finally {
    if (!settingsWindow.isDestroyed()) settingsWindow.destroy(); first.show(); first.focus();
    await stable(first, "picker-dialog-lifecycle-keeps-agent-input", 0.15);
    }
    } else {
      record("blocked", "opaque menus/dialog/model controls and native picker lifecycle", inputFailure, "Cannot open actual native input-dependent product surfaces until the owned window can become key");
    }
    record("state", "local ownership under actual host/workspace route", { route: (await state(first)).href, workspaceId, library: (await store.getWallpaperLibrary()).items.map(item => ({ candidateId: item.candidateId, path: item.path })), requests: urlRequests }, "All local file paths and playback leases remain in this isolated Desktop profile; URL traffic uses only owned loopback server");
    check("local wallpaper never follows daemon/project source", { library: await store.getWallpaperLibrary(), background: holding(first, "background"), hosts }, "Every candidate remains owned and every lease uses native window document owner, never host/agent identity", (await store.getWallpaperLibrary()).items.every(item => inside(run, item.path)) && holding(first, "background").nativeIdentity.contentsId === first.webContents.id && hosts.every(host => host.connections.every(connection => connection.endpoint === (host.serverId === "desktop" ? "localhost:18771" : "127.0.0.1:18772"))));
    record("state", "existing unchanged native authorization evidence", { reused: "Canonical Request.nativeRequest identity, Range, A/B, full navigation and binary media were already exercised by the parent; protected handler was moved unchanged and actual GUI file loads above use it." });
    // Cmd+Alt+T is the real production theme.cycle shortcut. It reaches
    // _layout.tsx updateSettings and the canonical AppSettings writer without
    // moving focus from the composer or changing real macOS appearance.
    if (nativeInputAvailable) {
      const readTheme = () => evaluate(first, `(() => {const input=document.querySelector('[data-testid="message-input-root"] textarea');return {preference:JSON.parse(localStorage.getItem('@omp-desktop:app-settings')).theme,colorScheme:document.documentElement.style.colorScheme,foreground:input?getComputedStyle(input).color:null};})()`);
      const originalTheme = (await readTheme()).preference;
      const selectTheme = async target => {
        for (let index = 0; index < 9; index++) {
          const previous = await readTheme();
          if (previous.preference === target) return previous;
          await until("Genuine key recipient before production theme shortcut", () => native.geometry(first.getTitle()), value => value.isKey);
          const recipient = native.keyCode(17, 6);
          const current = await until("Production native Cmd+Alt+T persists actual App theme", readTheme, value => value.preference !== previous.preference);
          record("input", "actual native production theme.cycle canonical writer", { chord: "Cmd+Alt+T", previous, current, recipient });
          const input = await state(first);
          check("theme shortcut retains actual composer input", input, "Same node/focus/selection/draft/scroll across actual native shortcut", input.identity && input.focused && input.value === baseline.value && JSON.stringify(input.selection) === JSON.stringify(baseline.selection) && JSON.stringify(input.scroll) === JSON.stringify(baseline.scroll));
        }
        throw new Error(`Production theme.cycle never reached ${target}`);
      };
      try {
        await selectTheme("light");
        const lightColors = await until("Actual App light appearance applied", readTheme, value => value.preference === "light" && value.colorScheme === "light");
        const light = await stable(first, "native-app-light-theme-input-preservation", 0.15);
        record("state", "actual native App light foreground and wallpaper", { colors: lightColors, background: holding(first, "background") });
        await selectTheme("dark");
        const darkColors = await until("Actual App dark appearance applied", readTheme, value => value.preference === "dark" && value.colorScheme === "dark");
        const dark = await stable(first, "native-app-dark-theme-input-preservation", 0.15);
        record("state", "actual native App dark foreground and wallpaper", { colors: darkColors, background: holding(first, "background") });
        check("real App theme foreground and surfaces actually changed", { lightColors, darkColors, lightSurface: light.surface, darkSurface: dark.surface }, "Production theme changes foreground and panel RGB while actual wallpaper remains decoded", lightColors.foreground !== darkColors.foreground && light.surface !== dark.surface && light.media.some(item => item.ready) && dark.media.some(item => item.ready));
      } finally {
        await selectTheme(originalTheme);
        await stable(first, "native-app-original-theme-restored-input-preservation", 0.15);
        record("state", "actual original App theme preference restored", await readTheme());
      }
    } else record("blocked", "actual App theme input preservation", inputFailure, "Requires the genuine owned native keyboard recipient");
    record("blocked", "real OS system theme auto-follow", { prerequisite: "Authorized real macOS appearance transition" }, "App theme light/dark is exercised above; real user macOS appearance is unchanged");
    await finish();
  } catch (error) { await finish(error); }
}
if (process.versions.miniElectron || process.versions.electron) {
  runNative().catch(error => { console.error(error.stack || error); require("electron").app.exit(1); });
} else launch();
