const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const nodeUtil = require("node:util");
const { smokeBundledPlugins } = require("./windows-native-plugins-smoke.js");

// Invoked by packaged-app-smoke.js on Windows. A visible, unlocked desktop is
// required for the owned-window surface screenshots; no Inspector/CDP is used.
const TIMEOUT_MS = 480_000;
const COMMAND_TIMEOUT_MS = 30_000;
const STATS_COMMAND_TIMEOUT_MS = 65_000;
const BRIDGE_KEYS = [
  "platform",
  "invoke",
  "getPendingOpenProject",
  "agentNavigation",
  "window",
  "pet",
  "remoteSsh",
  "dialog",
  "notification",
  "events",
  "opener",
  "editor",
  "menu",
  "webUtils",
];

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function isolatedEnvironment({ root, stagedApp, daemonHome, listen, userData }) {
  const profile = path.join(root, "profile");
  const agent = path.join(profile, ".omp", "agent");
  const temporary = path.join(root, "temp");
  const directories = [
    profile,
    agent,
    temporary,
    userData,
    daemonHome,
    path.join(profile, "AppData", "Local"),
    path.join(profile, "AppData", "Roaming"),
    path.join(profile, "Documents"),
    path.join(profile, "Desktop"),
    path.join(profile, "Downloads"),
  ];
  directories.forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
  const emptyConfig = path.join(root, "empty-config.yml");
  fs.writeFileSync(emptyConfig, "{}\n");
  // Do not inherit API keys, auth-file overrides, user PATH tools, Node hooks,
  // another daemon's home, shell profiles, or any user OMP configuration.
  const env = {};
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "SystemDrive",
    "ComSpec",
    "PATHEXT",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "SESSIONNAME",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "ProgramData",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const windows = env.SystemRoot || "C:\\Windows";
  return {
    ...env,
    ComSpec: path.join(windows, "System32", "cmd.exe"),
    PATH: [
      path.join(stagedApp, "resources", "bin"),
      path.join(windows, "System32"),
      windows,
      path.join(windows, "System32", "WindowsPowerShell", "v1.0"),
    ].join(path.delimiter),
    HOME: profile,
    USERPROFILE: profile,
    HOMEDRIVE: path.parse(profile).root.replace(/[\\/]$/, ""),
    HOMEPATH: profile.slice(path.parse(profile).root.length - 1),
    APPDATA: path.join(profile, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(profile, "AppData", "Local"),
    TEMP: temporary,
    TMP: temporary,
    USERNAME: "omp-native-smoke",
    OMP_PROFILE: "default",
    PI_PROFILE: "default",
    OMP_AGENT_DIR: agent,
    PI_CODING_AGENT_DIR: agent,
    OMP_CONFIG_DIR: ".omp",
    PI_CONFIG_DIR: ".omp",
    OMP_CONFIG_FILES: emptyConfig,
    PI_CONFIG_FILES: emptyConfig,
    XDG_CONFIG_HOME: path.join(profile, ".config"),
    XDG_CACHE_HOME: path.join(profile, ".cache"),
    XDG_DATA_HOME: path.join(profile, ".local", "share"),
    XDG_STATE_HOME: path.join(profile, ".local", "state"),
    OMP_DESKTOP_HOME: daemonHome,
    PASEO_HOME: daemonHome,
    PASEO_LISTEN: listen,
    PASEO_HOST: listen,
    PASEO_ELECTRON_USER_DATA_DIR: userData,
    PASEO_DISABLE_APP_UPDATES: "1",
    PASEO_WEB_UI_ENABLED: "false",
    PASEO_ELECTRON_FLAGS: "--lang=zh-CN",
    NO_COLOR: "1",
  };
}

function nativeProfilePaths(env) {
  const profile = env.USERPROFILE;
  const userData = env.PASEO_ELECTRON_USER_DATA_DIR;
  return {
    home: profile,
    appData: env.APPDATA,
    userData,
    sessionData: userData,
    temp: env.TEMP,
    desktop: path.join(profile, "Desktop"),
    documents: path.join(profile, "Documents"),
    downloads: path.join(profile, "Downloads"),
    music: path.join(profile, "Music"),
    pictures: path.join(profile, "Pictures"),
    videos: path.join(profile, "Videos"),
    recent: path.join(env.APPDATA, "Microsoft", "Windows", "Recent"),
    logs: path.join(userData, "logs"),
    crashDumps: path.join(userData, "Crashpad"),
    cache: path.join(userData, "Cache"),
    userCache: path.join(userData, "Cache"),
  };
}

function reserveNativeEarlyProfile(env) {
  // Read the OS-known folder without launching Electron or consulting any user
  // OMP configuration. Environment variables alone do not establish this path.
  const script =
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); " +
    "[Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData) | ConvertTo-Json -Compress";
  const probeEnv = { ...env };
  // Only this read-only OS query uses the parent's profile locators. It still
  // receives no provider secrets, auth overrides, Node hooks, user PATH or shell
  // profile. Reserve a real-ApplicationData fallback even when the GUI's known
  // folders honor its controlled USERPROFILE/APPDATA environment.
  for (const name of ["USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA"]) {
    if (process.env[name] === undefined) delete probeEnv[name];
    else probeEnv[name] = process.env[name];
  }
  const probe = spawnSync(
    path.join(
      env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { env: probeEnv, encoding: "utf8", windowsHide: true, timeout: 20_000 },
  );
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `Cannot resolve the native early ApplicationData directory read-only: ${probe.error || probe.stderr || probe.stdout}`,
    );
  }
  const appData = JSON.parse(probe.stdout.trim());
  assert.ok(
    typeof appData === "string" && path.isAbsolute(appData) && fs.statSync(appData).isDirectory(),
    "Windows must provide an existing absolute ApplicationData root",
  );
  // This fresh sibling namespace is explicitly owned test data. Never reuse,
  // inspect, or delete an existing installed-app directory.
  const directory = fs.mkdtempSync(path.join(appData, "omp-desktop-native-smoke-"));
  try {
    const profile = {
      appData,
      directory,
      name: path.basename(directory),
      token: require("node:crypto").randomUUID(),
      marker: path.join(directory, ".omp-native-smoke-owner.json"),
      entriesBefore: fs.readdirSync(directory),
    };
    fs.writeFileSync(
      profile.marker,
      `${JSON.stringify({
        kind: "omp-native-smoke-early-profile",
        directory,
        token: profile.token,
        driverPid: process.pid,
      })}\n`,
      { flag: "wx" },
    );
    return profile;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function cleanupNativeEarlyProfile(profile) {
  assert.equal(
    path.relative(path.join(profile.appData, profile.name), profile.directory),
    "",
    "Only the reserved native namespace may be cleaned",
  );
  assert.match(profile.name, /^omp-desktop-native-smoke-[a-zA-Z0-9]{6}$/);
  const info = fs.lstatSync(profile.directory);
  assert.ok(
    info.isDirectory() && !info.isSymbolicLink(),
    "Never follow a substituted early-profile directory",
  );
  const owner = JSON.parse(fs.readFileSync(profile.marker, "utf8"));
  assert.equal(owner.kind, "omp-native-smoke-early-profile");
  assert.equal(
    owner.token,
    profile.token,
    "Never remove an early profile without its exact ownership marker",
  );
  assert.equal(path.relative(owner.directory, profile.directory), "");
  const entriesAfter = fs.readdirSync(profile.directory, { withFileTypes: true }).map((entry) => {
    let type = "file";
    if (entry.isSymbolicLink()) type = "link";
    else if (entry.isDirectory()) type = "directory";
    return { name: entry.name, type };
  });
  fs.rmSync(profile.directory, { recursive: true, maxRetries: 20, retryDelay: 100 });
  return { entriesAfter, removed: true };
}

function stageApplication(appPath, stagedApp, earlyProfile) {
  fs.cpSync(appPath, stagedApp, { recursive: true, dereference: true });
  const resources = path.join(stagedApp, "resources");
  const app = path.join(resources, "app");
  // The production builder config is asar:false. Never extract a different
  // archive layout and accidentally hide its file-identity/pet asset failures.
  assert.ok(
    fs.existsSync(app) && !fs.existsSync(path.join(resources, "app.asar")),
    "Select the actual resources/app package produced by electron-builder.yml (asar:false); archived packages are not rewritten/extracted by smoke",
  );
  const metadataPath = path.join(app, "package.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const originalMain = metadata.main;
  assert.equal(originalMain, "dist/main.js", "Smoke must bootstrap the actual desktop main entry");
  assert.ok(fs.existsSync(path.join(app, originalMain)), "Packaged dist/main.js must exist");
  const bootstrapName = "omp-native-smoke-bootstrap.cjs";
  fs.copyFileSync(
    path.join(__dirname, "windows-native-smoke-bootstrap.js"),
    path.join(app, bootstrapName),
  );
  fs.copyFileSync(
    path.join(__dirname, "windows-native-plugin-operations.js"),
    path.join(app, "omp-native-plugin-operations.cjs"),
  );
  fs.writeFileSync(
    metadataPath,
    `${JSON.stringify(
      { ...metadata, name: earlyProfile.name, productName: earlyProfile.name, main: bootstrapName },
      null,
      2,
    )}\n`,
  );
  return {
    originalMain,
    originalAppName: metadata.productName || metadata.name,
    originalPackageName: metadata.name,
    earlyName: earlyProfile.name,
  };
}

function mainWindow(state, target = "main") {
  return state.windows.find((window) => {
    const url = new URL(window.url || "about:blank");
    return (
      url.protocol === "omp-desktop:" &&
      (target === "pet"
        ? url.hostname === "pet" && url.pathname === "/desktop-pet"
        : url.hostname === "app")
    );
  });
}

async function until(label, predicate, timeoutMs = COMMAND_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}; last result: ${JSON.stringify(last)}`);
}

function makeController({ child, control, deadline, getAbort }) {
  let sequence = 0;
  return async (request) => {
    const current = ++sequence;
    writeJson(path.join(control, `${current}.request.json`), request);
    const responsePath = path.join(control, `${current}.response.json`);
    let timeoutMs = COMMAND_TIMEOUT_MS;
    if (request.action === "plugins") timeoutMs = 90_000;
    else if (request.action === "stats") timeoutMs = STATS_COMMAND_TIMEOUT_MS;
    const commandDeadline = Math.min(deadline, Date.now() + timeoutMs);
    while (Date.now() < commandDeadline) {
      if (getAbort()) throw getAbort();
      const failure = readJson(path.join(control, "bootstrap-failure.json"));
      if (failure) throw new Error(failure.error);
      const response = readJson(responsePath);
      if (response) {
        if (!response.ok) throw new Error(response.error);
        return response.value;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Isolated packaged app exited (code ${child.exitCode}, signal ${child.signalCode})`,
        );
      }
      await delay(30);
    }
    throw new Error(`Native smoke controller timed out: ${request.action}`);
  };
}

function rendererPage(command, target = "main") {
  return {
    evaluate: (fn, argument) =>
      command({
        action: "evaluate",
        target,
        source: `(${fn.toString()})(${JSON.stringify(argument) ?? "undefined"})`,
      }),
    snapshot: (name) => command({ action: "capture", target, name }),
  };
}

function nativeHelper({ script, request, label, evidence, control, env }) {
  const requestPath = path.join(control, `${label}.native-request.json`);
  writeJson(requestPath, request);
  writeJson(path.join(evidence, `${label}-native-request.json`), request);
  const result = spawnSync(
    path.join(
      env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, script),
      "-RequestPath",
      requestPath,
    ],
    { encoding: "utf8", env, windowsHide: true, timeout: 20_000 },
  );
  if (
    request.inputObservationPath === path.join(control, "pet-interactivity.observation") &&
    fs.existsSync(request.inputObservationPath)
  ) {
    fs.copyFileSync(
      request.inputObservationPath,
      path.join(evidence, `${label}-interactivity.observation`),
    );
  }
  if (result.error || result.status !== 0) {
    throw new Error(
      `Owned-window native helper ${label} failed: ${result.error || result.stderr || result.stdout}`,
    );
  }
  const observed = JSON.parse(result.stdout.trim());
  writeJson(path.join(evidence, `${label}-native.json`), observed);
  return observed;
}

function nativeProbe({
  state,
  window,
  label,
  evidence,
  control,
  env,
  screenshot = false,
  minimized = false,
  chromeHitTests = false,
}) {
  const screenshotPath = screenshot ? path.join(evidence, `${label}-native.png`) : null;
  if (screenshot)
    assert.equal(
      new URL(window.url).hostname,
      "app",
      "Only the owned main surface may be screen-captured",
    );
  const native = nativeHelper({
    script: "windows-native-window-probe.ps1",
    request: {
      pid: state.pid,
      handle: window.handle,
      captureTarget: "main",
      screenshot: screenshotPath,
      chromeHitTests,
    },
    label,
    evidence,
    control,
    env,
  });
  assert.equal(native.visible, true, `${label}: the native HWND must be visible`);
  assert.equal(
    native.minimized,
    minimized,
    `${label}: OS minimization state must match the real native action`,
  );
  assert.equal(
    native.maximized,
    window.maximized,
    `${label}: OS and runtime maximized state must agree`,
  );
  const scale = native.dpi / 96;
  if (!minimized)
    assert.ok(
      Math.abs(native.clientSize.width - Math.round(window.contentSize[0] * scale)) <= 2 &&
        Math.abs(native.clientSize.height - Math.round(window.contentSize[1] * scale)) <= 2,
      `${label}: OS client size and runtime content size disagree: ${JSON.stringify({ native, window })}`,
    );
  if (screenshot)
    assert.ok(native.sampledColors > 12, `${label}: the live owned app surface is blank`);
  if (screenshot)
    assert.equal(native.foreground, true, `${label}: capture must retain owned main foreground`);
  return native;
}

async function checkViewport({ command, page, evidence, control, env, label, maximized }) {
  let sample;
  await until(`${label} DOM viewport matching the native content size`, async () => {
    const state = await command({ action: "inspect" });
    const window = mainWindow(state);
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
      rootChildren: document.querySelector("#root")?.childElementCount || 0,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    sample = { state, window, viewport };
    return (
      window &&
      window.visible &&
      !window.minimized &&
      window.maximized === maximized &&
      viewport.rootChildren > 0 &&
      Math.abs(viewport.width - window.contentSize[0]) <= 1 &&
      Math.abs(viewport.height - window.contentSize[1]) <= 1
    );
  });
  // Wait beyond the restore animation before measuring/capturing the real surface.
  await delay(350);
  const state = await command({ action: "inspect" });
  const window = mainWindow(state);
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
    rootChildren: document.querySelector("#root")?.childElementCount || 0,
  }));
  assert.ok(
    window?.visible &&
      !window.minimized &&
      window.maximized === maximized &&
      viewport.rootChildren > 0 &&
      Math.abs(viewport.width - window.contentSize[0]) <= 1 &&
      Math.abs(viewport.height - window.contentSize[1]) <= 1,
    `${label}: real native/DOM viewport changed before its settled capture`,
  );
  sample = { state, window, viewport };
  const native = nativeProbe({ ...sample, label, evidence, control, env, screenshot: true });
  const capture = await page.snapshot(`${label}-renderer.png`);
  assert.deepEqual(
    capture.window.bounds,
    window.bounds,
    `${label}: main moved/resized between native and renderer capture`,
  );
  assert.deepEqual(
    capture.window.contentSize,
    window.contentSize,
    `${label}: main client changed between captures`,
  );
  assert.ok(
    Math.abs(capture.imageSize.width - Math.round(sample.viewport.width * sample.viewport.dpr)) <=
      2 &&
      Math.abs(
        capture.imageSize.height - Math.round(sample.viewport.height * sample.viewport.dpr),
      ) <= 2,
    `${label}: capturePage dimensions do not match the rendered viewport`,
  );
  const result = { ...sample, native, capture };
  writeJson(path.join(evidence, `${label}.json`), result);
  return result;
}

async function smokeWindows({ command, page, evidence, control, env, report }) {
  const options = { command, page, evidence, control, env };
  const initialState = await command({ action: "inspect" });
  const window = mainWindow(initialState);
  assert.ok(window, "The real owned main must exist before native input");
  const focus = nativeHelper({
    script: "windows-native-focus.ps1",
    request: { pid: initialState.pid, handle: window.handle },
    label: "main-initial-focus",
    evidence,
    control,
    env,
  });
  assert.equal(focus.focused, true, "One-time owned caption input must acquire main foreground");
  const initial = await checkViewport({ ...options, label: "main-initial", maximized: false });
  const chrome = nativeProbe({
    ...initial,
    label: "main-native-resize-hit-tests",
    evidence,
    control,
    env,
    chromeHitTests: true,
  });
  assert.equal(chrome.chromeHitTests?.length, 4, "Probe all four real native resize edges");
  for (const hit of chrome.chromeHitTests)
    assert.equal(
      hit.hit,
      hit.expected,
      `${hit.name}: the real normal-window edge must remain resizable`,
    );
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    await page.evaluate(() => window.paseoDesktop.window.getCurrentWindow().toggleMaximize());
    await checkViewport({ ...options, label: `main-maximized-${cycle}`, maximized: true });
    if (cycle === 1) {
      const state = await command({ action: "inspect" });
      const snap = nativeHelper({
        script: "windows-native-restore-snap.ps1",
        request: { pid: state.pid, handle: mainWindow(state).handle },
        label: "main-continuous-restore-snap",
        evidence,
        control,
        env,
      });
      // This is physical caption input, not a JS setPosition or an isolated
      // final screenshot. Persist the full button/geometry/GUI-thread trace
      // before asserting so an unsafe environment or a failed Snap is visible.
      report.windowGestures = {
        restoreSnap: snap,
        notExercised: [
          "physical ordinary normal-window drag and titlebar double-click",
          "visual Snap preview and transition ghosting (this helper records no desktop pixels)",
          "other displays/DPI transitions beyond the owned window's current monitor",
        ],
      };
      assert.equal(
        snap.passed,
        true,
        `Continuous owned native restore/Snap failed: ${snap.failure}`,
      );
      assert.equal(snap.captionHit, 2, "Physical left down must target actual native HTCAPTION");
      assert.equal(
        snap.downCount,
        1,
        "Both gesture legs must share exactly one physical left down",
      );
      assert.equal(snap.upCount, 1, "The only physical left up must follow the top hold");
      assert.equal(snap.leftReleased, true, "Always release the injected left button");
      assert.equal(snap.cursorRestored, true, "Restore the unchanged injected cursor");
      const held = snap.samples.filter(
        (sample) => sample.phase !== "before-down" && sample.phase !== "released-at-top",
      );
      assert.ok(
        held.every((sample) => sample.leftHeld),
        "No intermediate physical left up is allowed",
      );
      for (const phase of ["restored-held", "top-held"]) {
        const samples = held.filter((sample) => sample.phase === phase);
        assert.ok(
          samples.length >= 2,
          `${phase}: observe the button and move loop across the pause`,
        );
        assert.ok(samples.at(-1).ms > samples[0].ms, `${phase}: held observations must span time`);
        assert.ok(
          samples.every(
            (sample) =>
              sample.inMoveSize &&
              sample.moveSizeHandle === snap.handle &&
              !sample.maximized &&
              sample.ms >= snap.downMs &&
              sample.ms <= snap.upMs,
          ),
          `${phase}: the same held HWND must remain restored in the actual OS move loop`,
        );
      }
      const released = snap.samples.at(-1);
      assert.equal(released.phase, "released-at-top");
      assert.equal(released.leftHeld, false);
      assert.equal(released.inMoveSize, false, "Release must end the native system move loop");
      assert.equal(
        released.maximized,
        true,
        "The same continuous native gesture must Snap on release",
      );
      assert.equal(
        snap.finalMaximized,
        true,
        "Native IsZoomed must prove successful top-edge Snap",
      );
      await checkViewport({ ...options, label: "main-continuous-snap-maximized", maximized: true });
      report.checks.push(
        "physical native HTCAPTION maximize→restore→hold→return to current monitor top without left-up→hold→release Snap; owned GUI_INMOVESIZE/button/geometry trace and release IsZoomed",
      );
    }
    await page.evaluate(() => window.paseoDesktop.window.getCurrentWindow().toggleMaximize());
    const restored = await checkViewport({
      ...options,
      label: `main-restored-${cycle}`,
      maximized: false,
    });
    assert.deepEqual(
      restored.window.contentSize,
      initial.window.contentSize,
      "Restoring the real application must recover the original content dimensions",
    );
  }
  await command({ action: "minimize" });
  const minimizedState = await until("real main native minimization", async () => {
    const state = await command({ action: "inspect" });
    return mainWindow(state)?.minimized ? state : null;
  });
  nativeProbe({
    state: minimizedState,
    window: mainWindow(minimizedState),
    label: "main-minimized",
    evidence,
    control,
    env,
    minimized: true,
  });
  await command({ action: "restore" });
  const afterMinimize = await checkViewport({
    ...options,
    label: "main-after-minimize-restore",
    maximized: false,
  });
  assert.deepEqual(
    afterMinimize.window.contentSize,
    initial.window.contentSize,
    "Native minimize/restore must recover the original real client dimensions",
  );
  report.checks.push(
    "real preload maximize/restore twice plus native minimize/restore; four real normal-window resize-edge hit-tests; DOM/runtime/OS geometry; renderer and guarded owned-foreground native surface screenshots (interactive no-drag CSS is covered separately by browser tests)",
  );
}

async function smokeCompanionMenu({
  command,
  page,
  petPage,
  state,
  window,
  evidence,
  control,
  env,
  report,
}) {
  const before = await page.evaluate(() => window.paseoDesktop.invoke("get_desktop_settings"));
  const point = await petPage.evaluate(() => {
    const canvas = document.querySelector("#mascot");
    const rect = canvas.getBoundingClientRect();
    const { data, width, height } = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height);
    const hasOpaquePatch = (x, y) => {
      for (let dy = -3; dy <= 3; dy += 1)
        for (let dx = -3; dx <= 3; dx += 1)
          if (data[((y + dy) * width + x + dx) * 4 + 3] < 240) return false;
      return true;
    };
    let selected = null;
    let distance = Infinity;
    for (let y = 3; y < height - 3; y += 1) {
      for (let x = 3; x < width - 3; x += 1) {
        const candidate = (x - width / 2) ** 2 + (y - height / 2) ** 2;
        if (candidate >= distance) continue;
        if (hasOpaquePatch(x, y)) {
          distance = candidate;
          selected = {
            x: rect.x + ((x + 0.5) * rect.width) / width,
            y: rect.y + ((y + 0.5) * rect.height) / height,
          };
        }
      }
    }
    return selected;
  });
  assert.ok(point, "The real companion must expose a safely opaque native right-click target");
  const menu = nativeHelper({
    script: "windows-native-pet-menu-smoke.ps1",
    request: {
      pid: state.pid,
      petHandle: window.handle,
      petCssPoint: point,
      inputObservationPath: path.join(control, "pet-interactivity.observation"),
      observationRunId: path.basename(path.dirname(control)),
    },
    label: "pet-menu-outside-click",
    evidence,
    control,
    env,
  });
  assert.equal(menu.menuOpened, true, "Actual right click must open the owned native pet menu");
  assert.equal(
    menu.dismissedAfterOutsideClick,
    true,
    "One native outside click must dismiss the menu",
  );
  assert.equal(
    menu.petNoActivate,
    true,
    "Outside dismissal must preserve companion no-activate style",
  );
  assert.equal(
    menu.petVisible,
    true,
    "Outside dismissal must not invoke the hide-companion command",
  );
  const after = await page.evaluate(() => window.paseoDesktop.invoke("get_desktop_settings"));
  assert.deepEqual(
    after.pet,
    before.pet,
    "Outside dismissal must not select hide/reset menu actions",
  );
  assert.ok(mainWindow(await command({ action: "inspect" }), "pet")?.visible);
  report.checks.push(
    "actual companion right click opens the owned OS menu; one native click on a separate owned window dismisses it without hiding/resetting the pet",
  );
}

async function smokeCompanion({ command, page, evidence, control, env, report }) {
  const pets = await page.evaluate(() => window.paseoDesktop.invoke("list_desktop_pets"));
  assert.ok(
    Array.isArray(pets) && pets.some((pet) => pet.id === "iris" && pet.builtIn),
    "The genuine packaged pet library must include built-in Iris",
  );
  report.companions = pets.map(({ id, name, builtIn }) => ({ id, name, builtIn }));
  const petPage = rendererPage(command, "pet");
  for (const [size, sprite] of [
    ["small", 112],
    ["medium", 152],
    ["large", 200],
  ]) {
    await page.evaluate(
      (chosenSize) =>
        window.paseoDesktop.invoke("patch_desktop_settings", {
          pet: { enabled: true, selectedId: "iris", size: chosenSize },
        }),
      size,
    );
    await until(`real ${size} companion window`, async () => {
      const window = mainWindow(await command({ action: "inspect" }), "pet");
      return window?.visible && !window.minimized;
    });
    let measurement;
    await until(`${size} companion spritesheet pixels and viewport`, async () => {
      measurement = await petPage.evaluate(() => {
        const canvas = document.querySelector("#mascot");
        const bubble = document.querySelector("#bubble");
        if (!canvas || !bubble) return null;
        const c = canvas.getBoundingClientRect(),
          b = bubble.getBoundingClientRect();
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 16) painted += 1;
        return {
          width: innerWidth,
          height: innerHeight,
          painted,
          bubbleHidden: bubble.hidden,
          caption: bubble.textContent,
          canvas: { x: c.x, y: c.y, width: c.width, height: c.height },
          bubble: { x: b.x, y: b.y, right: b.right, bottom: b.bottom },
        };
      });
      const state = await command({ action: "inspect" });
      const window = mainWindow(state, "pet");
      return (
        measurement &&
        window?.visible &&
        !window.minimized &&
        measurement.painted > 500 &&
        Math.abs(measurement.canvas.width - sprite) <= 1 &&
        !measurement.bubbleHidden &&
        measurement.width === window.contentSize[0] &&
        measurement.height === window.contentSize[1] &&
        window.contentSize[0] === sprite + 108 &&
        window.contentSize[1] === sprite + 76
      );
    });
    assert.ok(
      measurement.bubble.right < measurement.canvas.x + measurement.canvas.width / 2,
      `${size}: companion bubble must remain to the upper left of the pet's face`,
    );
    assert.ok(
      measurement.bubble.x >= 7 &&
        measurement.bubble.y >= 0 &&
        measurement.bubble.right <= measurement.width &&
        measurement.bubble.bottom <= measurement.height,
      `${size}: companion caption must remain inside its native viewport`,
    );
    const state = await command({ action: "inspect" });
    const window = mainWindow(state, "pet");
    const native = nativeProbe({ state, window, label: `pet-${size}`, evidence, control, env });
    assert.equal(
      native.noActivate,
      true,
      "Companion must have native WS_EX_NOACTIVATE, not steal focus",
    );
    assert.equal(
      native.toolWindow,
      true,
      "Companion must be a native tool window, not a taskbar app",
    );
    assert.equal(
      native.appWindow,
      false,
      "Companion must not carry native WS_EX_APPWINDOW/taskbar style",
    );
    assert.equal(native.topmost, true, "Companion must retain its native always-on-top style");
    assert.equal(
      native.foreground,
      false,
      "The real showInactive companion must never become the foreground window",
    );
    const capture = await petPage.snapshot(`pet-${size}-renderer.png`);
    writeJson(path.join(evidence, `pet-${size}.json`), { measurement, window, native, capture });
  }
  const menuState = await command({ action: "inspect" });
  const menuWindow = mainWindow(menuState, "pet");
  assert.ok(menuWindow?.visible, "The real companion must remain visible before menu input");
  await smokeCompanionMenu({
    command,
    page,
    petPage,
    state: menuState,
    window: menuWindow,
    evidence,
    control,
    env,
    report,
  });
  await page.evaluate(() =>
    window.paseoDesktop.invoke("patch_desktop_settings", { pet: { enabled: false } }),
  );
  await until(
    "disabled companion HWND destruction",
    async () => !mainWindow(await command({ action: "inspect" }), "pet"),
  );
  report.checks.push(
    "real companion library, enable/render/three sizes/disable; native visible/non-minimized/no-activate/tool-window/topmost state",
  );
}

const STATS_RANGES = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000,
  all: null,
};

const STATS_FIXTURE_BODY = "SYNTHETIC_STATS_ASSISTANT_BODY_DO_NOT_EXPOSE";
const STATS_FIXTURE_ERROR = "SYNTHETIC_STATS_ERROR_DO_NOT_EXPOSE";

function statsFixtureEntry(row, parentId) {
  return {
    type: "message",
    id: row.entry,
    parentId,
    timestamp: new Date(row.timestamp).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: STATS_FIXTURE_BODY }],
      api: "synthetic-fixture",
      provider: row.provider,
      model: row.model,
      usage: {
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        totalTokens: row.totalTokens,
        premiumRequests: 0,
        cost: { input: 0, output: row.costUsd, cacheRead: 0, cacheWrite: 0, total: row.costUsd },
      },
      stopReason: row.stop,
      ...(row.stop === "error" ? { errorMessage: STATS_FIXTURE_ERROR } : {}),
      timestamp: row.timestamp,
    },
  };
}

function appendStatsFixtureEntry(fixture, row) {
  const previous = fixture.rows.findLast((entry) => entry.session === row.session);
  assert.ok(previous, "Refresh must append to an existing controlled native transcript");
  fs.appendFileSync(
    path.join(fixture.sessionsPath, row.session),
    `${JSON.stringify(statsFixtureEntry(row, previous.entry))}\n`,
  );
  fixture.rows.push(row);
}

function seedStatsFixture(profile) {
  const statsPath = path.join(profile, ".omp", "stats.db");
  assert.equal(
    fs.existsSync(statsPath),
    false,
    "Only a newly owned empty profile may receive synthetic smoke statistics",
  );
  const sessionsPath = path.join(
    profile,
    ".omp",
    "agent",
    "sessions",
    "--synthetic-stats-fixture--",
  );
  assert.equal(fs.existsSync(sessionsPath), false, "Never overwrite an existing native transcript");
  const baseTime = Date.now();
  // Owned synthetic assistant JSONL, never copied user transcripts or model calls.
  // Native parser.ts consumes message.usage and classifies agents by file depth:
  // <project>/<file>.jsonl = main; nested = subagent; __advisor.jsonl = advisor.
  // Provider-reported totalTokens deliberately differs from the four bucket sum.
  const rows = [
    {
      entry: "fixture-1",
      session: "fixture-main.jsonl",
      provider: "fixture-alpha",
      model: "fixture-fast",
      agent: "main",
      offsetMs: -300_000,
      stop: "stop",
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 150,
      costUsd: 1.25,
      unpriced: 0,
    },
    {
      entry: "fixture-2",
      session: "fixture-main/fixture-worker.jsonl",
      provider: "fixture-beta",
      model: "fixture-slow",
      agent: "subagent",
      offsetMs: -7_200_000,
      stop: "error",
      input: 100,
      output: 200,
      cacheRead: 300,
      cacheWrite: 400,
      totalTokens: 1300,
      costUsd: 2.5,
      unpriced: 0,
    },
    {
      entry: "fixture-3",
      session: "fixture-main/fixture-worker.jsonl",
      provider: "xai-oauth",
      model: "fixture-unpriced",
      agent: "subagent",
      offsetMs: -600_000,
      stop: "stop",
      input: 5,
      output: 10,
      cacheRead: 15,
      cacheWrite: 20,
      totalTokens: 70,
      costUsd: 0,
      unpriced: 0,
    },
    {
      entry: "fixture-4",
      session: "fixture-main/__advisor.jsonl",
      provider: "fixture-alpha",
      model: "fixture-fast",
      agent: "advisor",
      offsetMs: -2 * 86_400_000,
      stop: "stop",
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 25,
      costUsd: 0.5,
      unpriced: 0,
    },
    {
      entry: "fixture-5",
      session: "fixture-archive.jsonl",
      provider: "fixture-alpha",
      model: "fixture-fast",
      agent: "main",
      offsetMs: -10 * 86_400_000,
      stop: "stop",
      input: 2,
      output: 4,
      cacheRead: 6,
      cacheWrite: 8,
      totalTokens: 30,
      costUsd: 0.75,
      unpriced: 0,
    },
    {
      entry: "fixture-6",
      session: "fixture-archive.jsonl",
      provider: "fixture-beta",
      model: "fixture-slow",
      agent: "main",
      offsetMs: -45 * 86_400_000,
      stop: "stop",
      input: 3,
      output: 6,
      cacheRead: 9,
      cacheWrite: 12,
      totalTokens: 40,
      costUsd: 1,
      unpriced: 0,
    },
    {
      entry: "fixture-7",
      session: "fixture-oldest.jsonl",
      provider: "fixture-alpha",
      model: "fixture-fast",
      agent: "main",
      offsetMs: -100 * 86_400_000,
      stop: "stop",
      input: 4,
      output: 8,
      cacheRead: 12,
      cacheWrite: 16,
      totalTokens: 50,
      costUsd: 1.5,
      unpriced: 0,
    },
  ];
  for (const row of rows) row.timestamp = baseTime + row.offsetMs;
  for (const session of new Set(rows.map((row) => row.session))) {
    const entries = rows
      .filter((row) => row.session === session)
      .sort((left, right) => left.timestamp - right.timestamp);
    const sessionPath = path.join(sessionsPath, session);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    const header = {
      type: "session",
      version: 3,
      id: `synthetic-stats-${path.basename(session, ".jsonl")}`,
      timestamp: new Date(entries[0].timestamp).toISOString(),
      cwd: profile,
    };
    fs.writeFileSync(
      sessionPath,
      `${[
        header,
        ...entries.map((row, index) => statsFixtureEntry(row, entries[index - 1]?.entry ?? null)),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      { flag: "wx" },
    );
  }
  assert.equal(
    fs.existsSync(statsPath),
    false,
    "Fixture creation must not prebuild the native index",
  );
  return {
    kind: "controlled-native-session-jsonl-with-missing-index",
    statsPath,
    sessionsPath,
    baseTime,
    rows,
    parserSource: "packages/stats/src/parser.ts:47-55,227-303",
    ingestCommand:
      "configured bundled omp --profile default stats --summary (through real Stats RPC)",
    initialIndex: "missing",
  };
}

function expectedStatsFixture(fixture, range) {
  const span = STATS_RANGES[range];
  const rows = fixture.rows.filter((row) => span === null || row.timestamp >= Date.now() - span);
  const metrics = (entries) => {
    const sum = (key) => entries.reduce((total, row) => total + row[key], 0);
    return {
      totalRequests: entries.length,
      failedRequests: entries.filter((row) => row.stop === "error").length,
      totalInputTokens: sum("input"),
      totalOutputTokens: sum("output"),
      totalCacheReadTokens: sum("cacheRead"),
      totalCacheWriteTokens: sum("cacheWrite"),
      totalTokens: sum("totalTokens"),
      totalCostUsd: sum("costUsd"),
      unpricedRequests: entries.filter(
        (row) =>
          row.totalTokens > 0 &&
          row.costUsd === 0 &&
          (row.provider === "xai-oauth" || row.unpriced === 1),
      ).length,
      transcriptCount: new Set(entries.map((row) => row.session)).size,
      firstTimestamp: entries.length ? Math.min(...entries.map((row) => row.timestamp)) : null,
      lastTimestamp: entries.length ? Math.max(...entries.map((row) => row.timestamp)) : null,
    };
  };
  const group = (keys) => {
    const groups = new Map();
    for (const row of rows) {
      const groupKey = JSON.stringify(keys.map((field) => row[field]));
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(row);
    }
    return [...groups.values()]
      .map((entries) => {
        const result = metrics(entries);
        for (const field of keys) {
          result[field === "agent" ? "agentType" : field] = entries[0][field];
        }
        return result;
      })
      .sort((left, right) => {
        if (keys[0] !== "agent" && left.totalRequests !== right.totalRequests)
          return right.totalRequests - left.totalRequests;
        for (const key of keys) {
          const field = key === "agent" ? "agentType" : key;
          if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
        }
        return 0;
      });
  };
  return {
    overall: metrics(rows),
    byModel: group(["provider", "model"]),
    byProvider: group(["provider"]),
    byAgentType: group(["agent"]),
    indexedThrough: Math.max(...fixture.rows.map((row) => row.timestamp)),
  };
}

function readStatsSource(profile) {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(path.join(profile, ".omp", "stats.db"), { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 1000; BEGIN");
    return {
      columns: database
        .prepare("PRAGMA table_info(messages)")
        .all()
        .map((column) => column.name),
      ...database
        .prepare(`SELECT COUNT(*) AS requests, COUNT(DISTINCT entry_id) AS uniqueEntries,
        COUNT(DISTINCT session_file) AS transcripts, COALESCE(SUM(total_tokens), 0) AS totalTokens,
        TOTAL(cost_total) AS cost, MAX(timestamp) AS indexedThrough FROM messages`)
        .get(),
    };
  } finally {
    database.close();
  }
}

async function navigateChinese(page, route) {
  await page.evaluate((destination) => {
    const key = "@omp-desktop:app-settings";
    const settings = JSON.parse(localStorage.getItem(key) || "{}");
    localStorage.setItem(key, JSON.stringify({ ...settings, language: "zh-CN" }));
    setTimeout(() => window.location.assign(destination), 0);
    return true;
  }, route);
}

async function smokeInstallation({ command, page, serverId, omp, report, evidence }) {
  const rpc = await command({ action: "installation" });
  assert.equal(
    rpc.serverInfo?.serverId,
    serverId,
    "Installation status must come from the isolated daemon",
  );
  assert.equal(rpc.serverInfo?.features?.ompInstall, true);
  assert.equal(rpc.installation?.installed, true, "The real daemon must detect the bundled OMP");
  assert.equal(rpc.installation?.source, "bundled");
  assert.equal(
    typeof rpc.installation.version,
    "string",
    "Installation version must cross the real runtime/SDK boundary as a string",
  );
  assert.equal(path.resolve(rpc.installation.installPath), path.resolve(omp.binaryPath));
  assert.ok(
    omp.version.includes(rpc.installation.version),
    "CLI and installation RPC must identify the same bundled OMP version",
  );
  const route = `/settings/hosts/${encodeURIComponent(serverId)}/agents`;
  await navigateChinese(page, route);
  let snapshot;
  await until("real host installation card with detected bundled OMP", async () => {
    snapshot = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="host-page-omp-install-card"]');
      const button = document.querySelector('[data-testid="host-page-omp-install-button"]');
      return {
        url: location.href,
        text: card?.textContent || "",
        body: document.body.textContent,
        busy: !button || button.getAttribute("aria-disabled") === "true",
      };
    });
    return (
      !snapshot.busy &&
      snapshot.text.includes(rpc.installation.version) &&
      snapshot.text.includes(rpc.installation.installPath)
    );
  });
  assert.equal(
    snapshot.body.includes("installation.trim is not a function"),
    false,
    "The genuine installation renderer must consume the actual native RPC result",
  );
  await page.snapshot("omp-installation-renderer.png");
  report.installation = { rpc, route, snapshot };
  writeJson(path.join(evidence, "omp-installation.json"), report.installation);
  report.checks.push(
    "real read-only installation RPC and host Agents card detect the exact bundled OMP path/version; no download/update requested",
  );
}

async function smokeUsage({
  command,
  page,
  profile,
  serverId,
  fixture,
  report,
  evidence,
  control,
  env,
}) {
  const route = `/settings/hosts/${encodeURIComponent(serverId)}/usage`;
  report.usage = {
    status: "running",
    route,
    fixture,
    ranges: {},
    nativeIndexer: {
      binaryPath: report.cli.omp.binaryPath,
      version: report.cli.omp.version,
      args: ["--profile", "default", "stats", "--summary"],
      invokedBy: "real Desktop Stats RPC",
    },
    notExercised: [
      "unsupported native schema and forced native index refresh failure/timeout",
      "real user credentials/transcripts, provider quotas, paid/model requests",
    ],
  };
  const readRpc = async (range) => {
    const result = await command({ action: "stats", range });
    assert.equal(
      result.serverInfo?.serverId,
      serverId,
      "Stats must come from the actual isolated desktop daemon",
    );
    assert.equal(
      result.serverInfo?.features?.ompStats,
      true,
      "Native Stats support is mandatory, never skipped for a stale UI/package",
    );
    assert.equal(result.stats?.source, "omp_stats_db");
    assert.equal(result.stats?.range, range);
    assert.equal(
      result.stats?.status,
      "available",
      "The real Stats RPC must ingest the owned JSONL before reading the native index",
    );
    assert.deepEqual(result.stats?.scope, { kind: "host_profile", profile: "default" });
    assert.ok(
      Number.isFinite(Date.parse(result.stats?.fetchedAt)),
      "Native Stats must supply its actual index read time",
    );
    const expected = expectedStatsFixture(fixture, range);
    for (const key of ["overall", "byModel", "byProvider", "byAgentType", "indexedThrough"]) {
      assert.deepEqual(
        result.stats[key],
        expected[key],
        `${range}: production SQL/RPC ${key} must match independent fixture facts`,
      );
    }
    assert.deepEqual(
      Object.keys(result.stats).sort(),
      [
        "source",
        "scope",
        "range",
        "status",
        "fetchedAt",
        "indexedThrough",
        "overall",
        "byModel",
        "byProvider",
        "byAgentType",
      ].sort(),
      "Stats DTO must expose only aggregate numeric facts and approved metadata",
    );
    for (const row of [
      result.stats.overall,
      ...result.stats.byModel,
      ...result.stats.byProvider,
      ...result.stats.byAgentType,
    ]) {
      for (const key of Object.keys(expected.overall)) {
        assert.ok(
          row[key] === null || (typeof row[key] === "number" && Number.isFinite(row[key])),
          `${range}: ${key} must be a numeric fact or an empty timestamp, never transcript data`,
        );
      }
    }
    const serialized = JSON.stringify(result.stats);
    for (const privateValue of [
      STATS_FIXTURE_BODY,
      STATS_FIXTURE_ERROR,
      fixture.statsPath,
      fixture.sessionsPath,
      ...fixture.rows.map((row) => row.entry),
    ]) {
      assert.equal(
        serialized.includes(privateValue),
        false,
        "Native transcript bodies, errors, entry IDs and filesystem paths must not enter Stats DTOs",
      );
    }
    return { rpc: result, expected };
  };
  const inspect = () =>
    page.evaluate(() => {
      const section = document.querySelector('[data-testid="omp-native-stats-section"]');
      const refresh = document.querySelector('[data-testid="omp-native-stats-refresh"]');
      const keys = [
        "requests",
        "failed",
        "transcripts",
        "totalTokens",
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "cacheHitRate",
        "cost",
      ];
      const groups = ["byModel", "byProvider", "byAgentType"];
      return {
        url: location.href,
        text: section?.textContent || "",
        summary: Boolean(document.querySelector('[data-testid="omp-native-stats-summary"]')),
        values: Object.fromEntries(
          keys.map((key) => [
            key,
            document
              .querySelector(`[data-testid="omp-native-stats-${key}"]`)
              ?.textContent?.trim() ?? null,
          ]),
        ),
        groups: Object.fromEntries(
          groups.map((key) => [
            key,
            [...document.querySelectorAll(`[data-testid="omp-native-stats-${key}-row"]`)].map(
              (row) => ({
                label: row
                  .querySelector('[data-testid="omp-native-stats-breakdown-label"]')
                  ?.textContent?.trim(),
                provider:
                  row
                    .querySelector('[data-testid="omp-native-stats-breakdown-provider"]')
                    ?.textContent?.trim() ?? null,
                requests: row
                  .querySelector('[data-testid="omp-native-stats-breakdown-requests"]')
                  ?.textContent?.trim(),
                tokens: row
                  .querySelector('[data-testid="omp-native-stats-breakdown-tokens"]')
                  ?.textContent?.trim(),
                cost: row
                  .querySelector('[data-testid="omp-native-stats-breakdown-cost"]')
                  ?.textContent?.trim(),
              }),
            ),
          ]),
        ),
        indexedThrough: document
          .querySelector('[data-testid="omp-native-stats-indexedThrough"]')
          ?.textContent?.trim(),
        fetchedAt: document
          .querySelector('[data-testid="omp-native-stats-fetchedAt"]')
          ?.textContent?.trim(),
        detailsExpanded:
          document
            .querySelector('[data-testid="omp-native-stats-details-toggle"]')
            ?.getAttribute("aria-expanded") === "true",
        busy: !refresh || refresh.getAttribute("aria-disabled") === "true",
      };
    });
  const click = (controlId) =>
    page.evaluate((id) => {
      const button = document.querySelector(`[data-testid="${id}"]`);
      if (!(button instanceof HTMLElement) || button.getAttribute("aria-disabled") === "true") {
        throw new Error(`Missing/disabled real Usage control: ${id}`);
      }
      button.scrollIntoView({ block: "nearest" });
      button.click();
      return true;
    }, controlId);
  const expectedUi = (statistics) =>
    page.evaluate((expected) => {
      const number = new Intl.NumberFormat("zh-CN");
      const currency = new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      });
      const headlineCurrency = new Intl.NumberFormat("zh-CN", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const cost = (row, formatter = currency) =>
        row.unpricedRequests > 0 && row.unpricedRequests === row.totalRequests
          ? "未定价"
          : formatter.format(row.totalCostUsd);
      const fields = {
        requests: "totalRequests",
        failed: "failedRequests",
        transcripts: "transcriptCount",
        totalTokens: "totalTokens",
        input: "totalInputTokens",
        output: "totalOutputTokens",
        cacheRead: "totalCacheReadTokens",
        cacheWrite: "totalCacheWriteTokens",
      };
      const agentNames = { main: "主代理", subagent: "子代理", advisor: "顾问代理" };
      const promptTokens =
        expected.overall.totalInputTokens +
        expected.overall.totalCacheReadTokens +
        expected.overall.totalCacheWriteTokens;
      const cacheHitRate =
        promptTokens > 0
          ? new Intl.NumberFormat("zh-CN", {
              style: "percent",
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            }).format(expected.overall.totalCacheReadTokens / promptTokens)
          : "—";
      return {
        values: {
          ...Object.fromEntries(
            Object.entries(fields).map(([key, field]) => [
              key,
              number.format(expected.overall[field]),
            ]),
          ),
          cacheHitRate,
          cost: cost(
            expected.overall,
            expected.overall.totalCostUsd > 0 && expected.overall.totalCostUsd < 0.01
              ? currency
              : headlineCurrency,
          ),
        },
        groups: Object.fromEntries(
          ["byModel", "byProvider", "byAgentType"].map((key) => [
            key,
            expected[key].map((row) => {
              let label = agentNames[row.agentType];
              if (key === "byModel") label = row.model;
              else if (key === "byProvider") label = row.provider;
              return {
                label,
                provider: key === "byModel" ? row.provider : null,
                requests: number.format(row.totalRequests),
                tokens: number.format(row.totalTokens),
                cost: cost(row),
              };
            }),
          ]),
        ),
        indexedThrough: `最新已索引请求：${new Date(expected.indexedThrough).toLocaleString("zh-CN")}`,
      };
    }, statistics);
  const checkUi = async (range, expected) => {
    const formatted = await expectedUi(expected);
    let snapshot;
    await until(
      `${range} Usage totals from the real native fixture`,
      async () => {
        snapshot = await inspect();
        report.usage.lastDom = snapshot;
        return (
          !snapshot.busy &&
          snapshot.summary &&
          JSON.stringify(snapshot.values) === JSON.stringify(formatted.values)
        );
      },
      STATS_COMMAND_TIMEOUT_MS,
    );
    const groups = {};
    for (const key of ["byProvider", "byModel", "byAgentType"]) {
      if (expected[key].length === 0) {
        groups[key] = [];
        continue;
      }
      await click(`omp-native-stats-tab-${key}`);
      await until(`${range} ${key} breakdown`, async () => {
        snapshot = await inspect();
        return JSON.stringify(snapshot.groups[key]) === JSON.stringify(formatted.groups[key]);
      });
      groups[key] = snapshot.groups[key];
    }
    if (!snapshot.detailsExpanded) await click("omp-native-stats-details-toggle");
    await until(`${range} index timestamps`, async () => {
      snapshot = await inspect();
      return snapshot.indexedThrough === formatted.indexedThrough && Boolean(snapshot.fetchedAt);
    });
    snapshot.groups = groups;
    await click("omp-native-stats-details-toggle");
    if (expected.byProvider.length > 0) {
      await click("omp-native-stats-tab-byProvider");
      await until("Provider breakdown restored", async () => {
        const current = await inspect();
        return current.groups.byProvider.length === expected.byProvider.length;
      });
    }
    report.usage.lastDom = snapshot;
    return snapshot;
  };
  report.usage.indexBeforePage = { exists: fs.existsSync(fixture.statsPath) };
  assert.equal(
    report.usage.indexBeforePage.exists,
    false,
    "Opening Usage must build the missing index; no helper may pre-sync it",
  );
  await navigateChinese(page, route);
  // Observe the real renderer before issuing any auxiliary Stats RPC. Otherwise
  // that RPC's native sync could hide a broken page-open indexing path.
  report.usage.opened = await checkUi("24h", expectedStatsFixture(fixture, "24h"));
  report.usage.sourceBefore = readStatsSource(profile);
  assert.equal(report.usage.sourceBefore.requests, 7);
  assert.equal(report.usage.sourceBefore.uniqueEntries, 7);
  assert.equal(report.usage.sourceBefore.transcripts, 5);
  assert.equal(report.usage.sourceBefore.totalTokens, 1665);
  assert.equal(report.usage.sourceBefore.cost, 7.5);
  // Verify default 24h, every actual range control, and all RPC breakdowns.
  for (const range of ["24h", "1h", "7d", "30d", "90d", "all"]) {
    if (range !== "24h") await click(`omp-native-stats-range-${range}`);
    const snapshot = await checkUi(range, expectedStatsFixture(fixture, range));
    const result = await readRpc(range);
    report.usage.ranges[range] = { ...result, snapshot };
    if (range === "24h" || range === "all")
      await page.snapshot(`usage-${range}-zh-cn-renderer.png`);
  }
  await click("omp-native-stats-range-24h");
  await checkUi("24h", expectedStatsFixture(fixture, "24h"));
  const refreshRow = {
    entry: "fixture-refresh-1",
    session: "fixture-main.jsonl",
    provider: "fixture-alpha",
    model: "fixture-fast",
    agent: "main",
    timestamp: Date.now(),
    stop: "stop",
    input: 7,
    output: 14,
    cacheRead: 21,
    cacheWrite: 28,
    totalTokens: 99,
    costUsd: 0.25,
    unpriced: 0,
  };
  appendStatsFixtureEntry(fixture, refreshRow);
  report.usage.sourceAfterAppend = readStatsSource(profile);
  assert.deepEqual(
    report.usage.sourceAfterAppend,
    report.usage.sourceBefore,
    "Appending JSONL must leave a genuinely stale index until the real refresh",
  );
  // No navigation/cache replacement or auxiliary Stats RPC after the append:
  // only this real Refresh click may sync the new request into the mounted UI.
  await click("omp-native-stats-refresh");
  const refreshedDom = await checkUi("24h", expectedStatsFixture(fixture, "24h"));
  report.usage.sourceAfterRefresh = readStatsSource(profile);
  assert.equal(report.usage.sourceAfterRefresh.requests, 8);
  assert.equal(report.usage.sourceAfterRefresh.uniqueEntries, 8);
  assert.equal(report.usage.sourceAfterRefresh.totalTokens, 1764);
  assert.equal(report.usage.sourceAfterRefresh.indexedThrough, refreshRow.timestamp);
  const refreshed = await readRpc("24h");
  assert.equal(refreshed.expected.overall.totalRequests, 4);
  assert.equal(refreshed.expected.overall.totalTokens, 1619);
  assert.equal(refreshed.expected.overall.totalCostUsd, 4);
  report.usage.refresh = { ...refreshed, snapshot: refreshedDom };
  await click("omp-native-stats-range-all");
  const allDom = await checkUi("all", expectedStatsFixture(fixture, "all"));
  const allAfterRefresh = await readRpc("all");
  assert.equal(allAfterRefresh.expected.overall.totalRequests, 8);
  assert.equal(allAfterRefresh.expected.overall.totalTokens, 1764);
  assert.equal(allAfterRefresh.expected.overall.totalCostUsd, 7.75);
  report.usage.allAfterRefresh = { ...allAfterRefresh, snapshot: allDom };
  report.usage.sourceAfter = readStatsSource(profile);
  assert.equal(report.usage.sourceAfter.requests, 8);
  assert.equal(report.usage.sourceAfter.uniqueEntries, 8);
  assert.equal(report.usage.sourceAfter.totalTokens, 1764);
  assert.equal(report.usage.sourceAfter.indexedThrough, refreshRow.timestamp);
  assert.deepEqual(
    report.usage.sourceAfter,
    report.usage.sourceAfterRefresh,
    "Subsequent Stats RPC syncs must not duplicate native indexed requests",
  );
  report.usage.repeatReads = [];
  for (let iteration = 1; iteration <= 2; iteration++) {
    const repeated = await readRpc("all");
    const source = readStatsSource(profile);
    assert.deepEqual(
      source,
      report.usage.sourceAfter,
      "Repeated native index syncs/reads must preserve unique requests, tokens and costs",
    );
    report.usage.repeatReads.push({ iteration, ...repeated, source });
  }
  report.usage.surface = await checkViewport({
    command,
    page,
    evidence,
    control,
    env,
    label: "usage-zh-cn",
    maximized: false,
  });
  report.usage.status = "passed";
  writeJson(path.join(evidence, "usage-zh-cn.json"), report.usage);
  report.checks.push(
    "mandatory real Stats native JSONL ingestion/SQL/RPC and Chinese Usage; missing index built on open; six ranges, independent native total_tokens, model/provider/main/subagent/advisor breakdowns, unpriced costs, numeric-only DTOs; append JSONL then genuine Refresh before auxiliary RPC; repeat syncs without duplicate requests",
  );
}

function cleanupOwnedProcesses(root, env) {
  const prefix = `${path.resolve(root)}${path.sep}`;
  const wql = prefix
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/%/g, "[%]")
    .replace(/_/g, "[_]");
  const filter = `ExecutablePath LIKE '${wql}%'`.replace(/'/g, "''");
  const script =
    `$ErrorActionPreference='Stop'; $filter='${filter}'; ` +
    `$owned=@(Get-CimInstance Win32_Process -Filter $filter); ` +
    `foreach($item in $owned){ & "$env:SystemRoot\\System32\\taskkill.exe" /pid $item.ProcessId /t /f | Out-Null }; ` +
    `Start-Sleep -Milliseconds 300; $remaining=@(Get-CimInstance Win32_Process -Filter $filter); ` +
    `if($remaining.Count -gt 0){throw ('Owned smoke processes remain: '+($remaining.ProcessId -join ','))}`;
  const result = spawnSync(
    path.join(
      env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { env, encoding: "utf8", timeout: 20_000, windowsHide: true },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Owned process cleanup failed: ${result.error || result.stderr || result.stdout}`,
    );
}

async function removeSandbox(root) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code) || attempt === 14) throw error;
      await delay(200);
    }
  }
}

function waitForOwnedExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  const { promise, resolve } = Promise.withResolvers();
  let timer;
  const finish = (exited) => {
    clearTimeout(timer);
    child.off("exit", onExit);
    resolve(exited);
  };
  const onExit = () => finish(true);
  timer = setTimeout(() => finish(false), 10_000);
  child.once("exit", onExit);
  return promise;
}

async function smokeWindowsPackagedApp({
  appPath,
  executableName,
  reserveLocalTcpPort,
  configureIsolatedDaemonHome,
  runColdCli,
  runCliChecks,
  runPetCreation,
  stopDaemon,
}) {
  assert.equal(process.platform, "win32", "The native Windows driver must run on Windows");
  appPath = path.resolve(appPath);
  assert.equal(
    path.basename(executableName),
    executableName,
    "Executable name must not contain path components",
  );
  assert.ok(
    fs.existsSync(path.join(appPath, `${executableName}.exe`)),
    "Selected packaged executable must exist",
  );
  const evidenceBase = process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR?.trim()
    ? path.resolve(process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR)
    : os.tmpdir();
  const evidenceRelative = path.relative(appPath, evidenceBase);
  assert.ok(
    evidenceRelative === ".." ||
      evidenceRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(evidenceRelative),
    "Smoke evidence must be outside the original application; only the disposable copy may be changed",
  );
  fs.mkdirSync(evidenceBase, { recursive: true });
  // A fresh run directory prevents an interrupted capture from being confused
  // with old screenshots/report files when the same artifact root is reused.
  const evidence = fs.mkdtempSync(path.join(evidenceBase, "omp-native-packaged-evidence-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-native-packaged-smoke-"));
  const stagedApp = path.join(root, "win-unpacked");
  const control = path.join(root, "control");
  const userData = path.join(root, "user-data");
  const daemonHome = path.join(root, "daemon");
  fs.mkdirSync(control);
  const listen = `127.0.0.1:${await reserveLocalTcpPort()}`;
  const env = isolatedEnvironment({ root, stagedApp, daemonHome, listen, userData });
  const report = {
    status: "running",
    originalApp: appPath,
    sandbox: root,
    evidence,
    checks: [],
    limitations: [
      "Requires a visible unlocked Windows desktop; activates/captures only the owned app HWND.",
      "No paid model requests, real user authentication, Inspector/CDP, or stock Electron fallback are used.",
      "A fresh marked early-startup namespace is created beneath OS ApplicationData and strictly removed; existing app profiles are never reused.",
      "The copied package main/early metadata name are instrumented; product branding is restored in memory, and renderer/preloads/IPC/daemon/bundled binaries remain real.",
    ],
  };
  console.log(`Packaged desktop native smoke evidence: ${evidence}`);
  let child = null;
  let command = null;
  let abort = null;
  let failure = null;
  let earlyProfile = null;
  const stdout = [],
    stderr = [];
  const onSignal = () => {
    abort = new Error("Native packaged smoke was interrupted");
    failure ||= abort;
    report.status = "failed";
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  async function finalize() {
    try {
      if (child) await stopDaemon({ appPath: stagedApp, env });
    } catch (error) {
      failure ||= error;
      report.status = "failed";
      report.daemonStopError = String(error);
    }
    if (command && !abort) {
      await command({ action: "quit" }).catch((error) => {
        failure ||= error;
        report.status = "failed";
        report.quitError = String(error);
      });
      if (!(await waitForOwnedExit(child))) {
        failure ||= new Error("The real packaged app did not exit after its normal quit lifecycle");
        report.status = "failed";
        report.forcedTermination = true;
      }
    }
    try {
      cleanupOwnedProcesses(root, env);
      report.ownedProcessesStopped = true;
      if (earlyProfile) report.earlyProfileCleanup = cleanupNativeEarlyProfile(earlyProfile);
    } catch (error) {
      failure ||= error;
      report.status = "failed";
      report.cleanupError = error.stack || String(error);
    }
    if (child) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    fs.writeFileSync(path.join(evidence, "app-stdout.log"), stdout.join(""));
    fs.writeFileSync(path.join(evidence, "app-stderr.log"), stderr.join(""));
    for (const [source, name] of [
      [path.join(userData, "logs", "main.log"), "desktop-main.log"],
      [path.join(daemonHome, "daemon.log"), "daemon.log"],
    ]) {
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(evidence, name));
    }
    try {
      if (!report.cleanupError) {
        await removeSandbox(root);
        report.sandboxRemoved = true;
      }
    } catch (error) {
      failure ||= error;
      report.status = "failed";
      report.cleanupError = error.stack || String(error);
    }
    writeJson(path.join(evidence, "report.json"), report);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  try {
    earlyProfile = reserveNativeEarlyProfile(env);
    report.earlyProfile = earlyProfile;
    const staging = stageApplication(appPath, stagedApp, earlyProfile);
    report.staging = staging;
    const { originalMain, originalAppName } = staging;
    configureIsolatedDaemonHome(daemonHome, listen);
    const fixture = seedStatsFixture(env.HOME);
    report.statsFixture = {
      kind: fixture.kind,
      seededRequests: fixture.rows.length,
      statsPath: fixture.statsPath,
      sessionsPath: fixture.sessionsPath,
      initialIndex: fixture.initialIndex,
      parserSource: fixture.parserSource,
      ingestCommand: fixture.ingestCommand,
      evidence: path.join(evidence, "stats-fixture.json"),
    };
    writeJson(report.statsFixture.evidence, fixture);
    // A fresh profile has no integration preferences or auto-install path. Never
    // invoke CLI/shortcut installation, login-at-startup, or auth flows in smoke.
    report.coldCli = await runColdCli({ appPath: stagedApp, env });
    report.checks.push("cold bundled CLI daemon start/status/stop in isolated profile");
    const configPath = path.join(control, "config.json");
    const deadline = Date.now() + TIMEOUT_MS;
    writeJson(configPath, {
      originalMain,
      originalAppName,
      control,
      evidence,
      driverPid: process.pid,
      deadline,
      nativePaths: nativeProfilePaths(env),
      earlyProfile,
    });
    const launchEnv = { ...env, OMP_DESKTOP_NATIVE_SMOKE_CONFIG: configPath };
    child = spawn(path.join(stagedApp, `${executableName}.exe`), [], {
      cwd: env.HOME,
      env: launchEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
    });
    child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.once("error", (error) => {
      abort = error;
    });
    command = makeController({ child, control, deadline, getAbort: () => abort });
    const page = rendererPage(command);
    await until("real packaged main window", async () => {
      const state = await command({ action: "inspect" });
      report.runtime = state;
      return mainWindow(state)?.visible;
    });
    assert.equal(
      report.runtime.packaged,
      true,
      "The selected runtime must retain genuine packaged mode",
    );
    assert.equal(
      report.runtime.name,
      "OMP Desktop",
      "The genuine product main must restore its normal runtime identity",
    );
    assert.ok(
      report.runtime.miniElectron,
      "The native Windows smoke requires a genuine mini-electron runtime, not stock Electron",
    );
    assert.equal(
      path.resolve(report.runtime.executable),
      path.join(stagedApp, `${executableName}.exe`),
    );
    assert.equal(path.resolve(report.runtime.resources), path.join(stagedApp, "resources"));
    assert.equal(path.resolve(report.runtime.userData), userData);
    assert.equal(path.resolve(report.runtime.home), env.HOME);
    await until("real renderer root and preload bridge", async () => {
      const state = await page.evaluate(() => ({
        children: document.querySelector("#root")?.childElementCount || 0,
        keys: Object.keys(window.paseoDesktop || {}),
        platform: window.paseoDesktop?.platform,
      }));
      return (
        state.children > 0 &&
        state.platform === "win32" &&
        BRIDGE_KEYS.every((key) => state.keys.includes(key))
      );
    });
    const status = await until(
      "renderer-started real desktop daemon",
      async () => {
        const rendererDaemon = await page.evaluate(() =>
          window.paseoDesktop.invoke("desktop_daemon_status"),
        );
        return rendererDaemon?.status === "running" &&
          rendererDaemon.desktopManaged &&
          typeof rendererDaemon.pid === "number" &&
          rendererDaemon.serverId &&
          rendererDaemon.listen === listen &&
          path.resolve(rendererDaemon.home) === daemonHome
          ? rendererDaemon
          : null;
      },
      60_000,
    );
    report.daemon = status;
    report.checks.push(
      "genuine packaged mini-electron app, renderer, preload bridge and renderer-started isolated local daemon",
    );
    const secondary = spawnSync(path.join(stagedApp, `${executableName}.exe`), [], {
      cwd: env.HOME,
      env: { ...launchEnv, OMP_DESKTOP_NATIVE_SMOKE_SECONDARY: "1" },
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    if (secondary.error || secondary.status !== 0)
      throw new Error(
        `Second native instance did not exit cleanly: ${secondary.error || secondary.stderr}`,
      );
    const after = await page.evaluate(() => window.paseoDesktop.invoke("desktop_daemon_status"));
    assert.equal(
      after.pid,
      status.pid,
      "A second native instance must preserve the primary daemon PID",
    );
    assert.equal(
      after.serverId,
      status.serverId,
      "A second native instance must preserve the primary daemon identity",
    );
    const secondaryState = await command({ action: "inspect" });
    assert.equal(
      secondaryState.pid,
      report.runtime.pid,
      "The primary native GUI process must survive a secondary launch",
    );
    assert.equal(
      secondaryState.windows.filter(
        (window) => new URL(window.url || "about:blank").hostname === "app",
      ).length,
      1,
      "A secondary launch must focus the existing main window, not create another one",
    );
    report.secondary = { exitCode: secondary.status, runtime: secondaryState };
    report.checks.push("real second instance preserves primary daemon");
    report.cli = await runCliChecks({
      appPath: stagedApp,
      env: launchEnv,
      createTerminal: (input) => command({ action: "terminal-create", ...input }),
    });
    report.checks.push(
      "bundled OMP --version and exact provider executable detection; CLI daemon status; real interactive terminal echo",
    );
    await smokeInstallation({
      command,
      page,
      serverId: status.serverId,
      omp: report.cli.omp,
      report,
      evidence,
    });
    // Establish the owned capture fixture BEFORE exercising restore/resize.
    // Ambient topmost tools remain untouched; do not repaint by raising the
    // target between a restore action and its surface observation.
    const originalSurfaceTopmost = await command({
      action: "main-surface-topmost",
      enabled: true,
    });
    assert.equal(typeof originalSurfaceTopmost, "boolean");
    report.nativeSurfaceFixture = {
      originalTopmost: originalSurfaceTopmost,
      raisedOnlyOwnedMain: true,
      restoredBeforeCompanion: false,
    };
    try {
      await smokeWindows({ command, page, evidence, control, env, report });
      await smokeUsage({
        command,
        page,
        profile: env.HOME,
        serverId: status.serverId,
        fixture,
        report,
        evidence,
        control,
        env,
      });
      await smokeBundledPlugins({
        command,
        page,
        stagedApp,
        profile: env.HOME,
        serverId: status.serverId,
        evidence,
        report,
        until,
        navigateChinese,
      });
    } finally {
      await command({ action: "main-surface-topmost", enabled: originalSurfaceTopmost });
      const restoredState = await command({ action: "inspect" });
      const restoredNative = nativeProbe({
        state: restoredState,
        window: mainWindow(restoredState),
        label: "main-surface-fixture-restored",
        evidence,
        control,
        env,
      });
      assert.equal(
        restoredNative.topmost,
        originalSurfaceTopmost,
        "Restore the owned main's original native topmost flag before companion qualification",
      );
      report.nativeSurfaceFixture.restoredBeforeCompanion = true;
    }
    await smokeCompanion({ command, page, evidence, control, env, report });
    report.petInstaller = await runPetCreation({ page, appPath: stagedApp, env: launchEnv });
    report.checks.push(
      "real generated pet installer preserves daemon lifetime and selected companion",
    );
    report.finalDaemon = await page.evaluate(() =>
      window.paseoDesktop.invoke("desktop_daemon_status"),
    );
    assert.equal(report.finalDaemon.status, "running");
    assert.equal(report.finalDaemon.pid, status.pid);
    assert.equal(report.finalDaemon.serverId, status.serverId);
    report.status = "passed";
  } catch (error) {
    failure = error;
    report.status = "failed";
    report.error = nodeUtil.inspect(error, { depth: 8, colors: false });
    if (command && !abort) {
      await command({ action: "capture", name: "failure-renderer.png" }).catch((captureError) => {
        report.failureCaptureError = String(captureError);
      });
      report.failureRuntime = await command({ action: "inspect" }).catch((inspectError) => ({
        error: String(inspectError),
      }));
    }
  } finally {
    await finalize();
  }
  if (failure)
    throw new Error(
      `Native packaged smoke failed. Evidence: ${evidence}\n${nodeUtil.inspect(failure, { depth: 8, colors: false })}`,
      { cause: failure },
    );
  console.log(
    `Packaged desktop native smoke passed (${report.checks.length} scenario groups). Evidence: ${evidence}`,
  );
  return report;
}

module.exports = {
  smokeWindowsPackagedApp,
  isolatedEnvironment,
  nativeProfilePaths,
  reserveNativeEarlyProfile,
  cleanupNativeEarlyProfile,
  cleanupOwnedProcesses,
};
