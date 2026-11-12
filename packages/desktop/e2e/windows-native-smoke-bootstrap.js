// This entry exists only in the driver's disposable resources/app copy. It does not
// replace a preload, daemon, IPC handler, or any product method.
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
const config = JSON.parse(fs.readFileSync(process.env.OMP_DESKTOP_NATIVE_SMOKE_CONFIG, "utf8"));

const ownedRoot = path.dirname(config.control);
const isOwnedPath = (value) => {
  const relative = path.relative(ownedRoot, path.resolve(value));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
// Upstream selects an early session root before this entry. Windows can honor
// the controlled profile environment or use the real OS-known AppData folder;
// both are safe only under the fresh sandbox or the exact reserved namespace.
const nativeProfileIsolation = {
  preEntrySessionRoot: app.getPath("userData"),
  preEntryName: app.getName(),
  appliedNames: Object.keys(config.nativePaths),
};
const marker = JSON.parse(fs.readFileSync(config.earlyProfile.marker, "utf8"));
const inSandbox = isOwnedPath(nativeProfileIsolation.preEntrySessionRoot);
const inReservedNamespace =
  path.relative(config.earlyProfile.directory, nativeProfileIsolation.preEntrySessionRoot) === "";
if (
  (!inSandbox && !inReservedNamespace) ||
  nativeProfileIsolation.preEntryName !== config.earlyProfile.name ||
  path.basename(nativeProfileIsolation.preEntrySessionRoot) !== config.earlyProfile.name ||
  marker.kind !== "omp-native-smoke-early-profile" ||
  marker.token !== config.earlyProfile.token
) {
  throw new Error(
    "SMOKE_NATIVE_PROFILE_ISOLATION_UNAVAILABLE: native early userData escaped both owned namespaces",
  );
}
nativeProfileIsolation.preEntrySessionRootOwned = true;
nativeProfileIsolation.preEntryLocation = inSandbox
  ? "sandbox"
  : "reserved_application_data_namespace";
for (const [name, directory] of Object.entries(config.nativePaths)) {
  if (!isOwnedPath(directory))
    throw new Error(`Native smoke ${name} must remain inside the owned sandbox`);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
// Restore branding only in memory. Keep disk metadata unique for future native
// processes; the real product main will apply its normal APP_NAME afterward.
app.setName(config.originalAppName);

require(path.join(__dirname, config.originalMain));

// Second-instance launches must run only the original application.
if (process.env.OMP_DESKTOP_NATIVE_SMOKE_SECONDARY !== "1") {
  serve().catch((error) => {
    writeJson(path.join(config.control, "bootstrap-failure.json"), {
      error: error.stack || String(error),
    });
    app.exit(1);
  });
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function selectWindow() {
  return BrowserWindow.getAllWindows().find((window) => {
    if (window.isDestroyed()) return false;
    const url = new URL(window.webContents.getURL() || "about:blank");
    return url.protocol === "omp-desktop:" && url.hostname === "app";
  });
}

function windowState(window) {
  const handle = window.getNativeWindowHandle();
  return {
    id: window.id,
    url: window.webContents.getURL(),
    bounds: window.getBounds(),
    // getContentBounds trapped in Windows mini-electron 0.1.7; do not call it.
    contentSize: window.getContentSize(),
    visible: window.isVisible(),
    minimized: window.isMinimized(),
    maximized: window.isMaximized(),
    handle: (handle.length === 8
      ? handle.readBigUInt64LE()
      : BigInt(handle.readUInt32LE())
    ).toString(),
  };
}


function setMainSurfaceTopmost(window, request) {
  if ((request.target && request.target !== "main") || typeof request.enabled !== "boolean") {
    throw new Error("Only the owned main surface fixture may change its topmost flag");
  }
  const previous = window.isAlwaysOnTop();
  window.setAlwaysOnTop(request.enabled);
  return previous;
}

async function evaluateRenderer(contents, source) {
  let timer;
  try {
    const value = await Promise.race([
      contents.executeJavaScript(`(${source})`),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The real renderer action did not settle within 25 seconds")),
          25_000,
        );
      }),
    ]);
    // Keep the JSON command response's value field for actions returning undefined.
    return value ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function runDaemonOperation(client, request) {
  if (request.action === "stats") return client.getOmpStats({ range: request.range });
  if (request.action === "installation")
    return client.getOmpInstallationStatus({ checkForUpdates: false });
  const cwd = fs.realpathSync(request.cwd);
  const relative = path.relative(fs.realpathSync(path.dirname(config.control)), cwd);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Smoke terminals must stay inside the disposable profile");
  }
  const opened = await client.openProject(cwd);
  if (!opened.workspace)
    throw new Error(opened.error || "The real daemon did not open the owned terminal workspace");
  const payload = await client.createTerminal(cwd, request.name, undefined, {
    workspaceId: opened.workspace.id,
    // The real SDK disables cmd's HKCU AutoRun; CLI list/send/capture/kill use this PTY.
    command: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
    args: ["/d", "/q"],
  });
  if (!payload.terminal)
    throw new Error(payload.error || "The real daemon did not create an owned terminal");
  return { id: payload.terminal.id };
}

async function runDaemonCommand(request) {
  // Use the actual packaged CLI connector with an explicit isolated host.
  const connector = path.join(
    __dirname,
    "node_modules",
    "@omp-desktop",
    "cli",
    "dist",
    "utils",
    "client.js",
  );
  const { connectToDaemon } = await import(pathToFileURL(connector).href);
  const client = await connectToDaemon({ host: process.env.PASEO_LISTEN, timeout: 10_000 });
  let timer;
  try {
    const serverInfo = client.getLastServerInfoMessage();
    let feature = null;
    if (request.action === "stats") feature = "ompStats";
    if (request.action === "installation") feature = "ompInstall";
    if (feature && serverInfo?.features?.[feature] !== true) {
      throw new Error(
        `The real packaged daemon must advertise server_info.features.${feature}=true`,
      );
    }
    let timeoutMs = 10_000;
    if (request.action === "stats") timeoutMs = 60_000;
    const payload = await Promise.race([
      runDaemonOperation(client, request),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The real ${request.action} RPC did not settle`)),
          timeoutMs,
        );
      }),
    ]);
    if (request.action === "stats") return { serverInfo, stats: payload.stats };
    if (request.action === "installation") return { serverInfo, installation: payload };
    return payload;
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}

async function command(request) {
  if (request.action === "inspect") {
    return {
      pid: process.pid,
      packaged: app.isPackaged,
      version: app.getVersion(),
      name: app.getName(),
      miniElectron: process.versions.miniElectron || null,
      electron: process.versions.electron,
      executable: process.execPath,
      resources: process.resourcesPath,
      userData: app.getPath("userData"),
      home: app.getPath("home"),
      nativeProfileIsolation,
      windows: BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed())
        .map(windowState),
    };
  }
  if (["stats", "installation", "terminal-create"].includes(request.action)) {
    return runDaemonCommand(request);
  }
  if (request.action === "quit") {
    setTimeout(() => app.quit(), 50);
    return true;
  }
  const window = selectWindow(request.target || "main");
  if (!window) throw new Error(`The real ${request.target || "main"} BrowserWindow is not ready`);
  if (request.action === "minimize" || request.action === "restore") {
    if (request.target && request.target !== "main")
      throw new Error("Only the owned main window may be minimized/restored");
    window[request.action]();
    return true;
  }
  if (request.action === "main-surface-topmost") {
    return setMainSurfaceTopmost(window, request);
  }
  if (request.action === "evaluate") {
    return evaluateRenderer(window.webContents, request.source);
  }
  if (request.action === "capture") {
    if (!/^[a-z0-9-]+\.png$/.test(request.name)) throw new Error("Unsafe capture filename");
    const image = await window.webContents.capturePage();
    const imageSize = image.getSize();
    if (imageSize.width < 1 || imageSize.height < 1)
      throw new Error("Native capturePage was empty");
    const destination = path.join(config.evidence, request.name);
    fs.writeFileSync(destination, image.toPNG());
    return { path: destination, imageSize, window: windowState(window) };
  }
  throw new Error(`Unknown smoke controller action: ${request.action}`);
}

async function serve() {
  const observed = new Set();
  const observe = (window) => {
    if (observed.has(window.id)) return;
    observed.add(window.id);
    window.webContents.on("console-message", (_event, level, message) => {
      const details = level && typeof level === "object" ? level : { level, message };
      fs.appendFileSync(
        path.join(config.evidence, "renderer-console.log"),
        `${new Date().toISOString()} window=${window.id} console ${JSON.stringify(details)}\n`,
      );
    });
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
      const details = code && typeof code === "object" ? code : { code, description, url };
      fs.appendFileSync(
        path.join(config.evidence, "renderer-console.log"),
        `did-fail-load window=${window.id} ${JSON.stringify(details)}\n`,
      );
    });
    window.webContents.on("preload-error", (_event, file, error) => {
      fs.appendFileSync(
        path.join(config.evidence, "renderer-console.log"),
        `preload-error window=${window.id} ${file} ${error?.stack || error}\n`,
      );
    });
  };
  app.on("browser-window-created", (_event, window) => observe(window));
  await app.whenReady();
  BrowserWindow.getAllWindows().forEach(observe);
  writeJson(path.join(config.control, "bootstrap-ready.json"), { pid: process.pid });
  let sequence = 1;
  while (Date.now() < config.deadline) {
    try {
      process.kill(config.driverPid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      app.quit();
      return;
    }
    const requestPath = path.join(config.control, `${sequence}.request.json`);
    if (!fs.existsSync(requestPath)) {
      await delay(30);
      continue;
    }
    const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    let response;
    try {
      response = { ok: true, value: await command(request) };
    } catch (error) {
      response = { ok: false, error: error.stack || String(error) };
    }
    writeJson(path.join(config.control, `${sequence}.response.json`), response);
    sequence += 1;
    if (request.action === "quit") return;
  }
  throw new Error("The native packaged smoke controller exceeded its owned deadline");
}
