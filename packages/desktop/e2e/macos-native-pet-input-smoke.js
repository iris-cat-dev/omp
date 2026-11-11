"use strict";

// One command (build product modules separately first):
// node packages/desktop/e2e/macos-native-pet-input-smoke.js \
//   --runtime=/tmp/omp-unified-plugin-smoke-2s3uFs/native-runtime/Electron.app/Contents/MacOS/Electron \
//   --native-root=/Users/bytedance/Project/mini-electron
// The launcher compiles the N-API helper with xcrun, then starts an isolated GUI
// package. No stock Electron, daemon, model, DOM input, or replacement preload.
// Evidence keeps the actual Iris renderer script and raw native _renderer-event
// envelopes. The default run covers both displays, both zooms and all three sizes;
// --input-only is a diagnosis run, not acceptance of the complete size matrix.
// --remaining skips verified primary zoom-1 layouts, primary input and config
// clamps; it collects primary zoom-1.5 layouts plus external layouts and input.
// --external-only reuses all verified primary layouts/input and config clamps;
// it requires a real negative-coordinate display for external layouts/input.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const OWNED_ROOT = "/tmp/omp-unified-plugin-smoke-2s3uFs";

function inside(root, candidate) {
  const relative = path.relative(root, fs.realpathSync(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function bounded(label, promise, milliseconds = 5_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}
async function until(label, read, accept, milliseconds = 5_000) {
  const deadline = Date.now() + milliseconds;
  let observed;
  do {
    observed = await bounded(label, Promise.resolve().then(read));
    if (accept(observed)) return observed;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(observed)}`);
}
function argument(name, fallback) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
}
function launch() {
  assert.equal(process.platform, "darwin", "The native input harness requires macOS AppKit");
  const root = fs.realpathSync(OWNED_ROOT);
  const runtime = fs.realpathSync(argument("runtime", path.join(root, "native-runtime/Electron.app/Contents/MacOS/Electron")));
  assert.ok(inside(root, runtime), "Only the owned native runtime may be launched");
  const nativeRoot = fs.realpathSync(argument("native-root", "/Users/bytedance/Project/mini-electron"));
  const desktopRoot = fs.realpathSync(path.resolve(__dirname, ".."));
  const run = fs.mkdtempSync(path.join(root, "native-pet-input-"));
  const name = `omp-native-pet-input-${randomUUID()}`;
  const paths = Object.fromEntries(["home", "appData", "userData", "sessionData", "temp", "logs", "crashDumps", "cache"].map((key) => [key, path.join(run, key)]));
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
  // Foundation uses CFFIXED_USER_HOME, rather than trusting HOME alone. The GUI
  // still checks the actual native early userData before creating any window.
  fs.mkdirSync(path.join(paths.home, "Library", "Application Support", name), { recursive: true });
  const entry = path.join(run, path.basename(__filename));
  fs.copyFileSync(__filename, entry);
  fs.cpSync(path.join(desktopRoot, "..", "plugins", "desktop-pet", "assets", "pets"), path.join(run, "assets", "pets"), { recursive: true });
  fs.writeFileSync(path.join(run, "package.json"), JSON.stringify({ name, productName: name, version: "1.0.0", main: path.basename(entry) }));
  fs.writeFileSync(path.join(run, "ownership.json"), JSON.stringify({ kind: "omp-native-pet-input", name, root, run }));
  const helper = path.join(run, "native-pet-input.node");
  const sdk = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8", timeout: 30_000 }).trim();
  const compile = ["clang++", "-std=c++20", "-fobjc-arc", "-bundle", "-undefined", "dynamic_lookup", "-isysroot", sdk,
    `-I${path.join(nativeRoot, "third_party", "libnode", "src")}`, "-framework", "AppKit", "-framework", "ApplicationServices",
    path.join(__dirname, "macos-native-pet-input-helper.mm"), "-o", helper];
  console.log(JSON.stringify({ kind: "launch", run, runtime, compile: ["xcrun", ...compile] }));
  execFileSync("xcrun", compile, { stdio: "inherit", timeout: 30_000 });
  const originalFocus = require(helper).preserve();
  const env = {
    PATH: process.env.PATH,
    LANG: process.env.LANG || "en_US.UTF-8",
    HOME: paths.home,
    CFFIXED_USER_HOME: paths.home,
    TMPDIR: `${paths.temp}${path.sep}`,
    XDG_CONFIG_HOME: paths.appData,
    XDG_CACHE_HOME: paths.cache,
    OMP_HOME: path.join(run, "omp-home"),
    OMP_PET_INPUT_CONFIG: JSON.stringify({ root, run, name, paths, helper, desktopRoot, originalFocus, inputOnly: process.argv.includes("--input-only"), remainingOnly: process.argv.includes("--remaining"), externalOnly: process.argv.includes("--external-only") }),
  };
  const stdout = path.join(run, "native.stdout.log");
  const stderr = path.join(run, "native.stderr.log");
  const bundle = path.resolve(runtime, "../../..");
  const openArgs = ["-W", "-n", "-a", bundle, "--stdout", stdout, "--stderr", stderr,
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--args", `--app=${run}`];
  const result = spawnSync("/usr/bin/open", openArgs, { cwd: run, env, stdio: "inherit", timeout: 180_000 });
  for (const file of [stdout, stderr]) if (fs.existsSync(file)) process.stdout.write(fs.readFileSync(file, "utf8"));
  // Evidence and owned profile remain for inspection; no user process is killed.
  console.log(JSON.stringify({ kind: "launch-result", run, status: result.status, signal: result.signal, error: result.error?.message || null }));
  if (result.error) throw result.error;
  const observations = JSON.parse(fs.readFileSync(path.join(run, "evidence", "observations.json"), "utf8"));
  const completion = observations.at(-1);
  process.exitCode = result.status === 0 && completion?.label === "native input acceptance" && completion.kind === "pass" ? 0 : 1;
}

async function runNative() {
  const { app, BrowserWindow, ipcMain, protocol, screen } = require("electron");
  assert.equal(process.platform, "darwin");
  assert.ok(process.versions.miniElectron, "A genuine mini-electron GUI runtime is required");
  const config = JSON.parse(process.env.OMP_PET_INPUT_CONFIG || "null");
  assert.ok(config, "Launch through the owned Node entry point");
  const { root, run, name, paths, helper, desktopRoot } = config;
  assert.equal(fs.realpathSync(OWNED_ROOT), root);
  assert.ok(inside(root, run));
  assert.equal(app.getName(), name, "The copied GUI package must retain its unique namespace");
  const early = app.getPath("userData");
  // Check canonical ownership before ready, settings, sessions, or BrowserWindow.
  // A runtime that ignores CFFIXED_USER_HOME fails here, rather than borrowing a
  // real Library/Application Support namespace or silently weakening isolation.
  assert.ok(fs.existsSync(early) && inside(run, early), `Native early userData escaped the owned root: ${early}`);
  assert.equal(path.basename(fs.realpathSync(early)), name);
  const marker = JSON.parse(fs.readFileSync(path.join(run, "ownership.json"), "utf8"));
  assert.equal(marker.kind, "omp-native-pet-input");
  assert.equal(marker.name, name);
  for (const [key, directory] of Object.entries(paths)) {
    assert.ok(inside(run, directory), `Native ${key} must remain owned`);
    app.setPath(key, fs.realpathSync(directory));
  }
  assert.equal(fs.realpathSync(app.getPath("home")), fs.realpathSync(process.env.HOME));
  const evidence = path.join(run, "evidence");
  fs.mkdirSync(evidence);
  const rows = [];
  const failures = [];
  const record = (kind, label, observed, assertion = null) => {
    const row = { kind, label, observed, assertion };
    rows.push(row);
    console.log(JSON.stringify(row));
    fs.writeFileSync(path.join(evidence, "observations.json"), JSON.stringify(rows, null, 2));
  };
  const check = (label, observed, assertion, passes) => {
    record(passes ? "pass" : "fail", label, observed, assertion);
    if (!passes) failures.push(label);
  };
  const native = require(helper);
  const originalFocusedWindowId = BrowserWindow.getFocusedWindow()?.id ?? null;
  const original = native.preserve(config.originalFocus);
  record("state", "original focus and cursor", { originalFocusedWindowId, native: original, earlyUserData: fs.realpathSync(early), paths });
  const mode = config.externalOnly ? "external-only" : config.remainingOnly ? "remaining" : config.inputOnly ? "input-only" : "full";
  record("state", "requested native matrix", { mode }, "Targeted modes reuse separately qualified coverage; they do not claim a new full matrix");
  let owner;
  let controller;
  let pet;
  let disposeInteractiveTrace;
  let finished = false;
  const finish = async (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    if (error) {
      failures.push(error.message);
      record("fail", "native harness execution", { message: error.message, stack: error.stack });
    }
    try {
      disposeInteractiveTrace?.();
      if (controller) await bounded("Dispose owned plugin runtime", controller.dispose());
    } catch (cleanupError) {
      failures.push(cleanupError.message);
      record("fail", "owned runtime cleanup", { message: cleanupError.message });
    }
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
    record("state", "restoration", { originalFocusedWindowId, remainingOwnedWindows: BrowserWindow.getAllWindows().length, native: native.restore() });
    record(failures.length ? "fail" : "pass", "native input acceptance", { failures, evidence, mode }, "Every required assertion in the requested native matrix must pass");
    app.exit(failures.length ? 1 : 0);
  };
  const watchdog = setTimeout(() => { void finish(new Error("Native pet input GUI exceeded 150s")); }, 150_000);
  app.on("window-all-closed", () => {});
  protocol.registerSchemesAsPrivileged([{ scheme: "omp-desktop", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
  const product = (relative) => require(path.join(desktopRoot, "dist", relative));
  const rendering = require(require.resolve("@omp-desktop/plugin-desktop-pet/rendering", { paths: [desktopRoot] }));
  const { DEFAULT_PET_ACTIVITY, petWindowSize, PET_SPRITE_SIZE } = rendering;
  const { getLocalPluginRuntime, setupBuiltinLocalPlugins, handleBuiltinPluginResource } = product("plugins/local-runtime-electron.js");
  const { getDesktopSettingsStore } = product("settings/desktop-settings-electron.js");
  const { registerMainWindow, getMainWindows } = product("window/main-windows.js");
  const { registerWallpaperWindow } = product("wallpaper/commands.js");
  const { wallpaperMediaRegistry } = product("wallpaper/media-registry.js");
  const { getNativeProtocolRequestIdentity, bindWallpaperProtocolDocument } = product("wallpaper/media-request-authorization.js");
  const preload = path.join(desktopRoot, "dist", "preload.js");
  assert.ok(fs.existsSync(preload), "Use the existing production preload");
  const evaluate = (contents, source) => bounded("Real renderer evaluation", contents.executeJavaScript(`(${source})`));
  const navigationAttempts = [];
  try {
    await bounded("Native app ready", app.whenReady());
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const external = displays.find((display) => display.workArea.x < 0);
    record("state", "real attached displays", displays.map(({ id, bounds, workArea, scaleFactor }) => ({ id, bounds, workArea, scaleFactor })));
    if (!external) {
      record("blocked", "negative-coordinate external display", { availableDisplayIds: displays.map(display => display.id) }, "Reconnect a real negative-X external display to complete the required multi-display matrix");
      failures.push("The required attached negative-coordinate external display is unavailable");
    }
    const ownerTitle = `${name}-focus-owner`;
    const petTitle = `${name}-iris-overlay`;
    owner = new BrowserWindow({ ...primary.workArea, title: ownerTitle, show: false, frame: false, backgroundColor: "#192238", webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    registerMainWindow(owner);
    registerWallpaperWindow(owner);
    const ownerHTML = `<!doctype html><title>${ownerTitle}</title><style>body{margin:0;background:#192238;color:white;font:18px sans-serif}input{position:absolute;left:20px;top:20px;width:300px;height:32px}p{position:absolute;left:20px;top:70px}</style><input id="focus-owner" value="native-"><p>Owned native focus and alpha-through recipient</p><script>window.nativeOwnerEvents=[];for(const type of ['pointerdown','pointerup','click'])addEventListener(type,e=>nativeOwnerEvents.push({type,target:e.target.id,trusted:e.isTrusted,screenX:e.screenX,screenY:e.screenY,clientX:e.clientX,clientY:e.clientY}));</script>`;
    protocol.handle("omp-desktop", async (request) => {
      const { hostname, pathname } = new URL(request.url);
      const identity = getNativeProtocolRequestIdentity(request);
      if (hostname === "app" && identity?.isDocument) assert.ok(bindWallpaperProtocolDocument(identity, wallpaperMediaRegistry, getMainWindows()), "Bind the real native main document owner");
      const resource = await handleBuiltinPluginResource(hostname, pathname);
      if (resource) return resource;
      assert.equal(hostname, "app", "Unexpected protocol resource");
      return new Response(ownerHTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    });
    await bounded("Production builtin plugin setup", setupBuiltinLocalPlugins({
      resourceRoot: path.join(run, "assets"), startupBarrier: Promise.resolve(),
      openApp() { navigationAttempts.push({ action: "openApp" }); throw new Error("Standalone input fixture has no real App navigation host"); },
      openAgent(target) { navigationAttempts.push({ action: "openAgent", target }); throw new Error("Standalone input fixture has no real App task navigation host"); },
    }));
    await bounded("Owned main document load", owner.loadURL("omp-desktop://app/native-pet-input"));
    await until("Production preload and focus field ready", () => evaluate(owner.webContents, "({ ready: document.readyState, bridge: !!window.paseoDesktop?.plugins, input: !!document.getElementById('focus-owner') })"), (value) => value.ready === "complete" && value.bridge && value.input);
    const settings = getDesktopSettingsStore();
    const patchPet = async (patch) => {
      const current = (await settings.getPlugins()).installations.find(({ id }) => id === "desktop-pet");
      assert.ok(current);
      await bounded("Patch owned pet config", settings.patchPlugin({ installationId: current.id, expectedRevision: current.revision, patch }));
    };
    const windowsBeforeActivation = new Set(BrowserWindow.getAllWindows().map((window) => window.id));
    const observeCreated = (...arguments_) => {
      const window = arguments_.find((value) => value?.webContents && typeof value.isDestroyed === "function");
      if (!window || windowsBeforeActivation.has(window.id)) return;
      record("state", "owned activation creates native window", { id: window.id, url: window.webContents.getURL(), bounds: window.getBounds() });
      window.webContents.on("did-fail-load", (...details) => record("state", "owned activation document load failure", { id: window.id, details: details.filter((value) => value === null || ["string", "number", "boolean"].includes(typeof value)) }));
      window.webContents.on("did-finish-load", () => record("state", "owned activation document load event", { id: window.id, url: window.webContents.getURL() }));
      const contents = window.webContents;
      contents.on("did-start-navigation", (_event, url, inPlace, mainFrame, processId, routingId) => {
        const frame = contents.mainFrame;
        record("state", "owned activation document navigation start", { contentsId: contents.id, url, inPlace, mainFrame, processId, routingId, nativeURL: contents.getURL(), frame: { nativeID: frame?.nativeID ?? null, routingId: frame?.routingId ?? null, detached: frame?.detached ?? null, url: frame?.url ?? null, navigationToken: frame?.navigationToken ?? null } });
      });
      const traceInteractive = (nativeEvent, type, payload, requestId) => {
        if (!type.startsWith("ipc-") || typeof payload?.channel !== "string" || !payload.channel.startsWith("paseo:overlay:")) return;
        const frame = contents.mainFrame;
        record("state", "real overlay renderer IPC", {
          type, channel: payload.channel, args: payload.args, requestId,
          contentsId: contents.id,
          nativeURL: contents.getURL(),
          expectedInteractiveChannel: `paseo:overlay:${contents.id}:interactive`,
          valueType: typeof payload.args?.[0],
          nativeFrameId: nativeEvent.frameId,
          nativeFrameGeneration: nativeEvent.frameGeneration,
          mainFrame: { nativeID: frame?.nativeID ?? null, routingId: frame?.routingId ?? null, detached: frame?.detached ?? null, url: frame?.url ?? null, navigationToken: frame?.navigationToken ?? null },
        });
      };
      contents.on("_renderer-event", traceInteractive);
      disposeInteractiveTrace = () => contents.removeListener("_renderer-event", traceInteractive);
    };
    app.on("browser-window-created", observeCreated);
    try {
      await patchPet({ enabled: true, config: { selectedId: "iris", size: "medium", position: { x: primary.workArea.x + 400, y: primary.workArea.y + 300 } } });
      controller = getLocalPluginRuntime();
      controller.startupReady();
      await bounded("Owned plugin startup idle", controller.whenIdle());
      const created = await until("Unique owned native overlay candidate", () => ({
        candidates: BrowserWindow.getAllWindows().filter((window) => !windowsBeforeActivation.has(window.id) && !window.isDestroyed()).map((window) => ({ id: window.id, url: window.webContents.getURL(), bounds: window.getBounds(), visible: window.isVisible() })),
        installations: controller.getSnapshot().installations.map(({ id, status, generation, error }) => ({ id, status, generation, error })),
      }), (value) => value.candidates.length === 1);
      record("state", "unique owned overlay candidate", created);
      pet = BrowserWindow.getAllWindows().find((window) => window.id === created.candidates[0].id);
      assert.ok(pet, "The unique owned activation window must still exist");
    } finally {
      app.removeListener("browser-window-created", observeCreated);
    }
    pet.setTitle(petTitle);
    const ready = await until("Real Iris overlay document and renderer ready", () => evaluate(pet.webContents, "({ href: location.href, pathname: location.pathname, ready: document.readyState, bridge: !!window.ompOverlay, canvas: !!document.getElementById('mascot'), image: typeof image !== 'undefined' && !!image, pose: typeof poseImage !== 'undefined' && !!poseImage, state: typeof state !== 'undefined' ? state?.descriptor?.id : null })"), (value) => value.pathname.startsWith("/plugin-overlay/desktop-pet/") && value.ready === "complete" && value.bridge && value.canvas && value.image && value.pose && value.state === "iris");
    record("state", "actual Iris alpha bridge producer", await evaluate(pet.webContents, "({ setInteractive: setInteractive.toString(), bridgeInteractive: typeof bridge.interactive, bridgeInteractiveSource: bridge.interactive.toString(), bridgeReady: typeof bridge.ready })"));
    const rendererSource = await evaluate(pet.webContents, "Array.from(document.scripts).find(script => script.nonce === 'omp-pet-renderer').textContent");
    assert.equal(typeof rendererSource, "string", "Evidence must come from the actual production renderer document");
    const rendererSourceFile = path.join(evidence, "actual-iris-renderer.js");
    fs.writeFileSync(rendererSourceFile, rendererSource);
    record("source", "actual Iris renderer source", { file: rendererSourceFile });
    record("state", "actual Iris renderer location and readiness", { id: pet.id, nativeURL: pet.webContents.getURL(), renderer: ready, native: native.geometry(petTitle) });
    const bridgeReadiness = await evaluate(pet.webContents, "bridge.ready()");
    assert.equal(bridgeReadiness?.descriptor?.id, "iris", "The genuine production bind/ready Promise must resolve to this Iris state");
    record("state", "actual Iris production bind and ready resolved", { id: bridgeReadiness.descriptor.id });
    await until("Actual native overlay is visible and nonfocusable", () => native.geometry(petTitle), (value) => value.visible && !value.canBecomeKey);
    // Read-only input observers. These do not send or alter any input/action.
    await evaluate(pet.webContents, `(() => { window.nativePetEvents=[]; for(const type of ['pointerdown','pointermove','pointerup','click','gotpointercapture','lostpointercapture']) canvas.addEventListener(type,e=>nativePetEvents.push({type,trusted:e.isTrusted,buttons:e.buttons,screenX:e.screenX,screenY:e.screenY,clientX:e.clientX,clientY:e.clientY})); return true; })()`);
    const binding = controller.getSnapshot().installations.find(({ id }) => id === "desktop-pet");
    assert.ok(binding && binding.status === "active", "The real builtin service must be active");
    const clientActivationId = `${name}-activity`;
    await evaluate(owner.webContents, `window.paseoDesktop.plugins.openClientScope(${JSON.stringify({ installationId: binding.id, generation: binding.generation, clientActivationId, mode: "active" })})`);
    let revision = 0;
    const publish = async (count) => {
      const activity = { ...DEFAULT_PET_ACTIVITY, connected: true, fontFamily: "sans-serif", serverIds: ["owned-native-input"], revisions: { "owned-native-input": null }, tasks: Array.from({ length: count }, (_, index) => ({ serverId: "owned-native-input", agentId: `owned-${index}`, title: "Owned activity layout fixture", status: "ready", updatedAt: ++revision })) };
      await evaluate(owner.webContents, `window.paseoDesktop.plugins.publish(${JSON.stringify({ installationId: binding.id, generation: binding.generation, clientActivationId, method: "pet.activity", input: activity })})`);
      await until("Real service activity update", () => evaluate(pet.webContents, "state.activity.tasks.length"), (value) => value === count);
    };
    const petState = () => evaluate(pet.webContents, "({ dragging, moved, pointerStart, patStarted, interactive, pointer: {...pointer}, pointerAlpha: pointer.x >= canvasLeft && pointer.x < canvasRight && pointer.y >= canvasTop && pointer.y < canvasBottom ? ctx.getImageData(Math.floor((pointer.x-canvasLeft)*canvas.width/(canvasRight-canvasLeft)), Math.floor((pointer.y-canvasTop)*canvas.height/(canvasBottom-canvasTop)), 1, 1).data[3] : null, canvas: {left:canvasLeft,top:canvasTop,right:canvasRight,bottom:canvasBottom}, events: nativePetEvents.slice(), tasks: state.activity.tasks.length })");
    const ownerState = () => evaluate(owner.webContents, "({ active: document.activeElement?.id, value: document.getElementById('focus-owner').value, selectionStart: document.getElementById('focus-owner').selectionStart, selectionEnd: document.getElementById('focus-owner').selectionEnd, events: nativeOwnerEvents.slice() })");
    const measure = () => evaluate(pet.webContents, `(() => {const c=canvas.getBoundingClientRect(),b=bubble.getBoundingClientRect(),d=ctx.getImageData(0,0,canvas.width,canvas.height).data;let painted=0;for(let i=3;i<d.length;i+=4)if(d[i]>16)painted++;return {viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio,bitmap:{width:canvas.width,height:canvas.height},painted,canvas:{x:c.x,y:c.y,width:c.width,height:c.height},bubble:{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom,hidden:bubble.hidden,text:bubble.textContent}}})()`);
    const focusState = async () => ({ focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null, app: native.appState(), owner: native.geometry(ownerTitle), pet: native.geometry(petTitle), field: await ownerState() });
    const screenshot = async (label) => {
      await bounded("Native renderer prepareToShow", pet.webContents.prepareToShow());
      const file = path.join(evidence, `${label}.png`);
      const image = await bounded("Capture real native renderer", pet.webContents.capturePage());
      fs.writeFileSync(file, image.toPNG());
      record("screenshot", label, { file, bitmap: image.getSize(), geometry: native.geometry(petTitle), layout: await measure() });
    };
    const position = async (display, size, desired) => {
      owner.setBounds(display.workArea);
      owner.show();
      app.focus();
      owner.focus();
      await patchPet({ config: { size, position: desired } });
      const expected = petWindowSize(size);
      const x = Math.max(display.workArea.x, Math.min(desired.x, display.workArea.x + display.workArea.width - expected.width));
      const y = Math.max(display.workArea.y, Math.min(desired.y, display.workArea.y + display.workArea.height - expected.height));
      await until("Native config position, dimensions and Iris layout", async () => ({ native: native.geometry(petTitle), layout: await measure() }), (value) => value.native.x === x && value.native.y === y && value.native.width === expected.width && value.native.height === expected.height && value.layout.canvas.width === PET_SPRITE_SIZE[size] && value.layout.painted > 500);
    };
    const focusInput = async () => {
      await until("Owned native window becomes key before input", focusState, (value) => value.focusedWindowId === owner.id && value.owner.isKey);
      const geometry = native.geometry(ownerTitle);
      const zoom = owner.webContents.getZoomFactor();
      const point = { x: geometry.x + 100 * zoom, y: geometry.y + 36 * zoom };
      record("state", "native owner input target", { point, geometry, zoom, focus: await focusState() });
      native.warp(point.x, point.y);
      await delay(100);
      record("input", "native owner field press", native.mouse("down", point.x, point.y));
      native.mouse("up", point.x, point.y);
      await until("Native owner input owns focus", focusState, (value) => value.focusedWindowId === owner.id && value.owner.isKey && value.field.active === "focus-owner");
      const before = await ownerState();
      const expected = before.value.slice(0, before.selectionStart) + "b" + before.value.slice(before.selectionEnd);
      native.key("b");
      await until("Native NSEvent keyboard edits real owner field", ownerState, (value) => value.value === expected && value.selectionStart === before.selectionStart + 1 && value.selectionEnd === before.selectionStart + 1);
    };
    const targets = () => until("Iris must expose opaque core and transparent canvas pixels", () => evaluate(pet.webContents, `(() => {
      const c=canvas.getBoundingClientRect(),b=bubble.getBoundingClientRect(),d=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let art=null,blank=null;
      for(let y=8;y<canvas.height-8;y++)for(let x=8;x<canvas.width-8;x++){
        const cx=c.x+(x+.5)*c.width/canvas.width,cy=c.y+(y+.5)*c.height/canvas.height;
        if(!bubble.hidden&&cx>=b.x&&cx<b.right&&cy>=b.y&&cy<b.bottom)continue;
        if(!art&&y>canvas.height*.45&&y<canvas.height*.8&&x>canvas.width*.3&&x<canvas.width*.7){let solid=true;for(let dy=-6;dy<=6;dy++)for(let dx=-6;dx<=6;dx++)if(d[((y+dy)*canvas.width+x+dx)*4+3]<200)solid=false;if(solid)art={x:cx,y:cy};}
        if(!blank){let clear=true;for(let dy=-6;dy<=6;dy++)for(let dx=-6;dx<=6;dx++)if(d[((y+dy)*canvas.width+x+dx)*4+3]!==0)clear=false;if(clear)blank={x:cx,y:cy};}
      }
      return {art,blank};
    })()`), (value) => !!value.art && !!value.blank);
    const cursorAlphaPolicy = async (point, interactive) => {
      const actual = native.warp(point.x, point.y);
      assert.ok(Math.abs(actual.x - point.x) <= 1 && Math.abs(actual.y - point.y) <= 1, "Native cursor warp must preserve desktop DIP coordinates");
      const startedAt = Date.now();
      const samples = [];
      try {
        const observed = await until("Production native cursor alpha policy", async () => {
          const value = { native: native.geometry(petTitle), cursor: screen.getCursorScreenPoint(), renderer: await petState() };
          samples.push({ elapsedMs: Date.now() - startedAt, cursor: value.cursor, nativeOrigin: { x: value.native.x, y: value.native.y }, ignoresMouseEvents: value.native.ignoresMouseEvents, pointer: value.renderer.pointer, pointerAlpha: value.renderer.pointerAlpha, interactive: value.renderer.interactive });
          return value;
        }, (value) => Math.abs(value.cursor.x - point.x) <= 1 && Math.abs(value.cursor.y - point.y) <= 1 && Math.abs(value.renderer.pointer.x + value.native.x - point.x) <= 1 && Math.abs(value.renderer.pointer.y + value.native.y - point.y) <= 1 && value.renderer.interactive === interactive && value.native.ignoresMouseEvents === !interactive);
        return { actual, observed };
      } finally {
        record("diagnostic", "production cursor alpha policy samples", { point, expectedInteractive: interactive, samples }, "Read-only samples preserve the hovered pixel, renderer producer and native policy before timeout or external cursor movement");
      }
    };
    const hover = async (point, interactive) => {
      const { actual } = await cursorAlphaPolicy(point, interactive);
      const hit = native.hit(point.x, point.y);
      record("native-hit", interactive ? "opaque native recipient" : "transparent native recipient", { cursor: actual, hit, pet: native.geometry(petTitle) }, "AppKit hit lookup plus native ignoresMouseEvents, not DOM alpha alone");
      assert.equal(hit.recipient.title, interactive ? petTitle : ownerTitle);
      native.mouse("move", point.x, point.y);
    };
    const alphaAndDrag = async (label, display, mainZoom) => {
      await position(display, "medium", { x: display.workArea.x + 400, y: display.workArea.y + 300 });
      owner.webContents.setZoomFactor(mainZoom);
      await until("Owned main zoom applies", () => owner.webContents.getZoomFactor(), (value) => Math.abs(value - mainZoom) < 1e-6);
      // Cursor-only diagnostics require no AppKit recipient, click or key window.
      // All click, threshold, keyboard and retained-focus assertions remain gated.
      const diagnosticTargets = await targets();
      const diagnosticGeometry = native.geometry(petTitle);
      for (const [target, expectedInteractive] of [["blank", false], ["art", true], ["blank", false]]) {
        const local = diagnosticTargets[target];
        const point = { x: diagnosticGeometry.x + local.x, y: diagnosticGeometry.y + local.y };
        try {
          const policy = await cursorAlphaPolicy(point, expectedInteractive);
          record("diagnostic", `${label}: cursor-only ${target} alpha policy`, { expectedInteractive, local, point, ...policy }, "Production cursor→renderer interactive→raw IPC→native ignore policy only; no click/drag/focus acceptance");
        } catch (error) {
          record("diagnostic", `${label}: cursor-only ${target} alpha policy`, { expectedInteractive, local, point, message: error.message, native: native.geometry(petTitle), cursor: screen.getCursorScreenPoint(), renderer: await petState() }, "Failed production policy diagnostic; no click/drag/focus acceptance");
          failures.push(`${label}: cursor-only ${target} alpha policy: ${error.message}`);
        }
      }
      await focusInput();
      const baselineFocus = await focusState();
      check(`${label}: main zoom isolation`, { mainZoom: owner.webContents.getZoomFactor(), petZoom: pet.webContents.getZoomFactor(), dpr: (await measure()).dpr }, "Companion zoom remains 1 at main zoom 1 / 1.5", Math.abs(pet.webContents.getZoomFactor() - 1) < 1e-6);
      const local = await targets();
      const geometry = native.geometry(petTitle);
      const world = (point) => ({ x: geometry.x + point.x, y: geometry.y + point.y });
      const blank = world(local.blank);
      await hover(blank, false);
      const ownerBefore = await ownerState();
      const petBefore = await petState();
      const routed = native.mouse("down", blank.x, blank.y);
      native.mouse("up", blank.x, blank.y);
      const through = await until("Transparent pixel delivers native click to owned underlay", ownerState, (value) => value.events.filter((event) => event.type === "click").length > ownerBefore.events.filter((event) => event.type === "click").length);
      const petAfter = await petState();
      check(`${label}: native alpha-through`, { local: local.blank, screen: blank, route: routed, underlay: through, pet: petAfter }, "Native ignored pet routes trusted click to owner; pet sees no pointerdown", routed.recipient.title === ownerTitle && through.events.at(-1).trusted && petAfter.events.filter((event) => event.type === "pointerdown").length === petBefore.events.filter((event) => event.type === "pointerdown").length);
      // Reacquire the same real input before testing nonfocusable opaque input.
      await focusInput();
      const focusBeforeDrag = await focusState();
      for (const distance of [3, 4, 5]) {
        await position(display, "medium", { x: display.workArea.x + 400, y: display.workArea.y + 300 });
        const core = (await targets()).art;
        const origin = native.geometry(petTitle);
        const start = { x: origin.x + core.x, y: origin.y + core.y };
        await hover(start, true);
        const before = await petState();
        const down = native.mouse("down", start.x, start.y);
        const pressed = await until("Trusted native pet pointerdown", petState, (value) => !!value.pointerStart && value.events.findLast((event) => event.type === "pointerdown")?.trusted === true);
        const pressedEvent = pressed.events.findLast((event) => event.type === "pointerdown");
        assert.ok(Math.abs(pressedEvent.screenX - start.x) <= 1 && Math.abs(pressedEvent.screenY - start.y) <= 1, "Trusted pointerdown must preserve the real desktop target");
        native.warp(start.x + distance, start.y);
        record("input", `${label}: ${distance}px native drag`, native.mouse("drag", start.x + distance, start.y));
        if (distance >= 4) {
          try { await until("Native threshold starts dragging", petState, (value) => value.dragging, 750); } catch (error) { record("state", `${label}: threshold wait`, { message: error.message }); }
        } else await delay(200);
        const boundary = await petState();
        const draggedEvent = boundary.events.findLast((event) => event.type === "pointermove" && event.buttons === 1);
        const observedDistance = draggedEvent && boundary.pointerStart ? Math.hypot(draggedEvent.screenX - boundary.pointerStart.x, draggedEvent.screenY - boundary.pointerStart.y) : null;
        check(`${label}: ${distance}px trusted native displacement`, { distance, observedDistance, pressedEvent, draggedEvent }, "The real renderer receives the requested 3 / 4 / 5 desktop-pixel displacement", draggedEvent?.trusted === true && observedDistance === distance);
        const boundaryGeometry = native.geometry(petTitle);
        check(`${label}: ${distance}px threshold`, { distance, down, origin, boundaryGeometry, boundary }, distance < 4 ? "3px does not start dragging or move the window" : "Reaching 4px starts dragging", distance < 4 ? !boundary.dragging && boundaryGeometry.x === origin.x && boundaryGeometry.y === origin.y : boundary.dragging);
        if (boundary.dragging) {
          // Host captures the cursor at drag-start; subsequent delta moves bounds.
          await delay(100);
          native.warp(start.x + distance + 24, start.y + 12);
          native.mouse("drag", start.x + distance + 24, start.y + 12);
          const movedBounds = await until("Native drag timer moves real window", () => native.geometry(petTitle), (value) => value.x !== origin.x || value.y !== origin.y);
          check(`${label}: ${distance}px native movement`, { origin, movedBounds, cursor: screen.getCursorScreenPoint() }, "Captured native cursor delta moves overlay within workArea", movedBounds.x === origin.x + 24 && movedBounds.y === origin.y + 12);
          if (distance === 5 && display.workArea.x < 0) {
            const edge = { x: display.workArea.x + 8, y: display.workArea.y + 8 };
            native.warp(edge.x, edge.y);
            const input = native.mouse("drag", edge.x, edge.y);
            const clamped = await until("Native captured drag clamps external top-left", () => native.geometry(petTitle), (value) => value.x === display.workArea.x && value.y === display.workArea.y);
            check(`${label}: native negative-edge drag clamp`, { input, edge, clamped, workArea: display.workArea }, "Captured native drag clamps to external negative-X workArea, not primary", clamped.x === display.workArea.x && clamped.y === display.workArea.y);
          }
        }
        const end = screen.getCursorScreenPoint();
        record("input", `${label}: ${distance}px native release`, native.mouse("up", end.x, end.y));
        const released = await until("Native pet release ends capture", petState, (value) => !value.dragging && !value.pointerStart);
        const finalBounds = native.geometry(petTitle);
        if (boundary.dragging) {
          check(`${label}: ${distance}px no action-click on release`, { before, released, navigationAttempts }, "Drag release does not pet/open/navigation; raw browser click events are recorded separately", released.patStarted === -1 && navigationAttempts.length === 0);
          const persisted = await until("Real drag-end persists owned config", async () => (await settings.getPlugins()).installations.find(({ id }) => id === "desktop-pet").config.position, (value) => value?.x === finalBounds.x && value?.y === finalBounds.y);
          record("state", `${label}: native drag persisted position`, persisted);
        }
        const focusAfter = await focusState();
        check(`${label}: ${distance}px no focus theft`, { before: focusBeforeDrag, after: focusAfter, initial: baselineFocus }, "Original owned focusedWindowId, native key window, input identity/draft/selection survive opaque pet input", focusAfter.focusedWindowId === owner.id && focusAfter.owner.isKey && !focusAfter.pet.canBecomeKey && !focusAfter.pet.isKey && focusAfter.field.active === "focus-owner" && focusAfter.field.value === focusBeforeDrag.field.value && focusAfter.field.selectionStart === focusBeforeDrag.field.selectionStart && focusAfter.field.selectionEnd === focusBeforeDrag.field.selectionEnd);
        await screenshot(`${label}-drag-${distance}px`);
        await delay(900); // Let the real pat animation from the sub-threshold release finish.
      }
      const beforeKey = await ownerState();
      const expectedKeyValue = beforeKey.value.slice(0, beforeKey.selectionStart) + "b" + beforeKey.value.slice(beforeKey.selectionEnd);
      native.key("b");
      const afterKey = await until("Retained native focus still accepts keyboard", ownerState, (value) => value.active === "focus-owner" && value.value === expectedKeyValue && value.selectionStart === beforeKey.selectionStart + 1 && value.selectionEnd === beforeKey.selectionStart + 1);
      record("state", `${label}: native keyboard after drag`, afterKey);
    };
    // Complete independent display/size evidence before a fatal input precondition.
    const layoutDisplays = config.externalOnly ? (external ? [external] : []) : (external ? [primary, external] : [primary]);
    for (const display of layoutDisplays) {
      for (const zoom of config.remainingOnly && display.id === primary.id ? [1.5] : [1, 1.5]) {
        const label = `${display.id === primary.id ? "primary" : "negative-external"}-main-zoom-${zoom}`;
        for (const size of config.inputOnly ? [] : ["small", "medium", "large"]) {
          owner.webContents.setZoomFactor(zoom);
          await position(display, size, { x: display.workArea.x + 400, y: display.workArea.y + 300 });
          let anchor;
          for (const count of [0, 1, 12]) {
            await publish(count);
            const layout = await until("Bubble layout settles", measure, (value) => !value.bubble.hidden && value.painted > 500);
            const nativeGeometry = native.geometry(petTitle);
            const { canvas: c, bubble: b, viewport } = layout;
            const offset = b.right - c.x;
            check(`${label}: ${size}/${count} bubble bounds`, { native: nativeGeometry, layout, anchor }, "Bubble remains within native viewport, left of face, with invariant pet-side corner", b.x >= 7 && b.y >= 0 && b.right <= viewport.width && b.bottom <= viewport.height && b.right < c.x + c.width / 2 && (anchor === undefined || Math.abs(offset - anchor) < 1));
            anchor ??= offset;
            check(`${label}: ${size}/${count} backing scale`, { displayScale: display.scaleFactor, nativeScale: nativeGeometry.scale, dpr: layout.dpr, bitmap: layout.bitmap, canvas: c }, "Attached display scale is 2; canvas backing pixels match actual devicePixelRatio", display.scaleFactor === 2 && nativeGeometry.scale === 2 && Math.abs(layout.dpr - 2) < 1e-6 && layout.bitmap.width === Math.round(c.width * layout.dpr) && layout.bitmap.height === Math.round(c.height * layout.dpr));
            await screenshot(`${label}-${size}-${count}-tasks`);
          }
        }
      }
    }
    owner.webContents.setZoomFactor(1);
    for (const size of external && !config.inputOnly && !config.remainingOnly && !config.externalOnly ? ["small", "medium", "large"] : []) {
      const dimensions = petWindowSize(size);
      for (const desired of [
        { x: external.workArea.x - 300, y: external.workArea.y - 200 },
        { x: external.workArea.x + external.workArea.width - dimensions.width + 10, y: external.workArea.y + external.workArea.height - dimensions.height + 10 },
      ]) {
        const expected = { x: Math.max(external.workArea.x, Math.min(desired.x, external.workArea.x + external.workArea.width - dimensions.width)), y: Math.max(external.workArea.y, Math.min(desired.y, external.workArea.y + external.workArea.height - dimensions.height)) };
        await position(external, size, desired);
        const observed = await until("Production external clamp settles", () => native.geometry(petTitle), (value) => value.x === expected.x && value.y === expected.y);
        check(`${size}: negative external edge clamp`, { desired, expected, observed, workArea: external.workArea }, "Native external bounds are clamped without losing negative X", observed.x < 0 && observed.x >= external.workArea.x && observed.y >= external.workArea.y && observed.x + observed.width <= external.workArea.x + external.workArea.width && observed.y + observed.height <= external.workArea.y + external.workArea.height);
        await screenshot(`negative-clamp-${size}-${desired.x < external.workArea.x ? "top-left" : "bottom-right"}`);
      }
    }
    await publish(0);
    const inputDisplays = config.remainingOnly || config.externalOnly ? (external ? [external] : []) : (external ? [primary, external] : [primary]);
    for (const display of inputDisplays) {
      for (const zoom of [1, 1.5]) {
        const label = `${display.id === primary.id ? "primary" : "negative-external"}-main-zoom-${zoom}`;
        await alphaAndDrag(label, display, zoom);
      }
    }
    record("uncovered", "real task/App navigation and multi-host freshness", {
      reason: "This standalone native-input fixture has no real App workspace/agent navigation host or daemon. Navigation adapters throw rather than imitate completion. Activity captions use owned tasks published through the real production client scope/service, not provider/model calls.",
      navigationAttempts,
      coveredZoom: config.externalOnly ? "External layouts and real input at main zoom 1 / 1.5 only when physically attached. All verified primary layouts/input and negative configuration clamps are reused." : config.remainingOnly ? "Remaining layouts: primary main zoom 1.5; external main zoom 1 / 1.5 and real external input only when physically attached. Verified primary input at both zooms is reused." : "Real main BrowserWindow zoom factors 1 and 1.5; production nonfocusable companion intentionally remains zoom 1.",
      inputRoute: "AppKit windowNumberAtPoint and native ignoresMouseEvents choose an owned recipient, then NSEvent travels through NSApp.sendEvent. Native cursor is warped for the production pointer/drag timer. This does not claim global HID/physical-device automation.",
      notExercised: ["direct companion zoom override (not a production UI setting)", "display hotplug", "task menu selection", "multi-host priority/freshness"],
    });
    await finish();
  } catch (error) {
    await finish(error);
  }
}

if (process.versions.electron) {
  runNative().catch((error) => {
    console.error(JSON.stringify({ kind: "fail", label: "early native initialization", observed: { message: error.message, stack: error.stack } }));
    require("electron").app.exit(1);
  });
} else {
  try { launch(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
