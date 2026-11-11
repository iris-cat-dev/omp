const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

// Run the real companion in the selected mini-electron process and an owned profile.
// No daemon, model credentials, or installed-app data are used.
if (!process.versions.electron) {
  assert.equal(
    process.platform,
    "win32",
    "This native smoke targets the official Windows mini-electron runtime",
  );
  const {
    isolatedEnvironment,
    nativeProfilePaths,
    reserveNativeEarlyProfile,
    cleanupNativeEarlyProfile,
    cleanupOwnedProcesses,
  } = require("./windows-native-packaged-smoke");
  const desktopRoot = path.resolve(__dirname, "..");
  const desktopMetadata = JSON.parse(
    fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
  );
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pet-layout-"));
  let env;
  let earlyProfile;
  try {
    const entry = path.join(temporary, path.basename(__filename));
    fs.copyFileSync(__filename, entry);
    fs.cpSync(path.join(desktopRoot, "..", "plugins", "desktop-pet", "assets", "pets"), path.join(temporary, "assets", "pets"), {
      recursive: true,
    });
    // Use an owned copy of the official runtime so every native process can be
    // identified/cleaned by its executable path, even after a timeout or crash.
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
    earlyProfile = reserveNativeEarlyProfile(env);
    fs.writeFileSync(
      path.join(temporary, "package.json"),
      `${JSON.stringify(
        {
          name: earlyProfile.name,
          productName: earlyProfile.name,
          version: desktopMetadata.version,
          main: path.basename(entry),
        },
        null,
        2,
      )}\n`,
    );
    env.OMP_PET_LAYOUT_EARLY_PROFILE = JSON.stringify(earlyProfile);
    env.OMP_PET_LAYOUT_SOURCE_ROOT = desktopRoot;
    env.OMP_PET_LAYOUT_NATIVE_PATHS = JSON.stringify(nativeProfilePaths(env));
    if (process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR) {
      env.OMP_PET_LAYOUT_EVIDENCE = path.resolve(process.env.PASEO_DESKTOP_SMOKE_ARTIFACT_DIR);
    }
    const result = spawnSync(
      path.join(stagedRuntime, path.basename(runtime)),
      [`--app=${temporary}`],
      {
        cwd: temporary,
        env,
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: false,
      },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    process.exitCode = result.status === 0 ? 0 : 1;
  } finally {
    if (env) cleanupOwnedProcesses(temporary, env);
    if (earlyProfile) cleanupNativeEarlyProfile(earlyProfile);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
} else {
  runNativeSmoke().catch((error) => {
    console.error(error);
    require("electron").app.exit(1);
  });
}

async function runNativeSmoke() {
  const { app, BrowserWindow, protocol, screen } = require("electron");
  assert.ok(
    process.versions.miniElectron,
    "Pet layout smoke requires a genuine mini-electron runtime, not stock Electron",
  );
  const desktopRoot = process.env.OMP_PET_LAYOUT_SOURCE_ROOT;
  assert.ok(desktopRoot, "The owned launch must supply the actual product module directory");
  const nativePaths = JSON.parse(process.env.OMP_PET_LAYOUT_NATIVE_PATHS);
  const ownedRoot = path.resolve(__dirname);
  const isOwnedPath = (directory) => {
    const relative = path.relative(ownedRoot, path.resolve(directory));
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const earlyProfile = JSON.parse(process.env.OMP_PET_LAYOUT_EARLY_PROFILE);
  const marker = JSON.parse(fs.readFileSync(earlyProfile.marker, "utf8"));
  const earlyUserData = app.getPath("userData");
  assert.ok(
    isOwnedPath(earlyUserData) || path.relative(earlyProfile.directory, earlyUserData) === "",
    "Official runtime early userData must stay in the owned sandbox or exact reserved namespace",
  );
  assert.equal(
    path.basename(earlyUserData),
    earlyProfile.name,
    "The native early root must retain its unique name",
  );
  assert.equal(marker.kind, "omp-native-smoke-early-profile");
  assert.equal(
    app.getName(),
    earlyProfile.name,
    "Native startup must use the copied package's unique namespace",
  );
  assert.equal(
    marker.token,
    earlyProfile.token,
    "The native early profile must retain its exact ownership marker",
  );
  for (const [name, directory] of Object.entries(nativePaths)) {
    assert.ok(isOwnedPath(directory), `Native ${name} must stay in the owned profile`);
    fs.mkdirSync(directory, { recursive: true });
    app.setPath(name, directory);
  }
  assert.equal(
    fs.realpathSync(app.getPath("home")),
    fs.realpathSync(process.env.HOME),
    "Native home must stay in the owned profile",
  );
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
  const product = (relative) => require(path.join(desktopRoot, "dist", relative));
  const { DEFAULT_PET_ACTIVITY, petWindowSize, PET_SPRITE_SIZE } = require("@omp-desktop/plugin-desktop-pet/rendering");
  const { getLocalPluginRuntime, setupBuiltinLocalPlugins, handleBuiltinPluginResource, createLocalPluginCommandHandlers } = product("plugins/local-runtime-electron.js");
  const { getDesktopSettingsStore } = product("settings/desktop-settings-electron.js");
  const { registerMainWindow, getMainWindows } = product("window/main-windows.js");
  const { registerWallpaperWindow } = product("wallpaper/commands.js");
  const { wallpaperMediaRegistry } = product("wallpaper/media-registry.js");
  const { getNativeProtocolRequestIdentity, bindWallpaperProtocolDocument } = product("wallpaper/media-request-authorization.js");
  const preload = path.join(desktopRoot, "dist", "preload.js");
  assert.ok(
    fs.existsSync(preload),
    "Use the actual production desktop preload, never a test replacement bridge",
  );
  await app.whenReady();
  await setupBuiltinLocalPlugins({ openApp() {}, openAgent() {}, startupBarrier: Promise.resolve(), resourceRoot: path.join(ownedRoot, "assets") });
  protocol.handle("omp-desktop", async (request) => {
    const { hostname, pathname } = new URL(request.url);
    const identity = getNativeProtocolRequestIdentity(request);
    if (hostname === "app" && identity?.isDocument) {
      assert.ok(bindWallpaperProtocolDocument(identity, wallpaperMediaRegistry, getMainWindows()), "The native main document must bind its actual owner before returning its body");
    }
    const resource = await handleBuiltinPluginResource(hostname, pathname);
    return resource || new Response("<!doctype html><title>Pet layout smoke controls</title>");
  });
  const main = new BrowserWindow({
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  registerMainWindow(main);
  registerWallpaperWindow(main);
  await main.loadURL("omp-desktop://app/pet-layout-smoke");
  const workArea = screen.getPrimaryDisplay().workArea;
  const settings = getDesktopSettingsStore();
  const patchPet = async (patch) => {
    const current = (await settings.getPlugins()).installations.find(({ id }) => id === "desktop-pet");
    return settings.patchPlugin({ installationId: current.id, expectedRevision: current.revision, patch });
  };
  await patchPet({ enabled: true, config: { selectedId: "iris", size: "medium", position: { x: workArea.x + 16, y: workArea.y + 16 } } });
  const controller = getLocalPluginRuntime();
  try {
    controller.startupReady();
    await controller.whenIdle();
    const binding = controller.getSnapshot().installations.find(({ id }) => id === "desktop-pet");
    const clientActivationId = "owned-pet-layout-smoke";
    await evaluateRenderer(main.webContents, `window.paseoDesktop.plugins.openClientScope(${JSON.stringify({ installationId: binding.id, generation: binding.generation, clientActivationId, mode: "active" })})`);
    const publishActivity = (activity) => evaluateRenderer(main.webContents, `window.paseoDesktop.plugins.publish(${JSON.stringify({ installationId: binding.id, generation: binding.generation, clientActivationId, method: "pet.activity", input: activity })})`);
    let pet;
    await until(() => {
      pet = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL().startsWith("omp-desktop://overlay/plugin-overlay/"),
      );
      return Boolean(pet);
    });
    assert.ok(pet, "The real companion window must open");
    let sequence = 0;
    const labels = {
      ...DEFAULT_PET_ACTIVITY.labels,
      idle: "空闲",
      ready: "等待你查看",
      taskCount: "{{count}} 个任务",
    };
    const publish = async (count) => {
      const activity = {
        ...DEFAULT_PET_ACTIVITY,
        connected: true,
        serverIds: ["layout-smoke"],
        revisions: { "layout-smoke": null },
        fontFamily: "sans-serif",
        labels,
        tasks: Array.from({ length: count }, (_, index) => ({
          serverId: "layout-smoke",
          agentId: `main-${index}`,
          title: "Owned smoke conversation",
          status: "ready",
          updatedAt: ++sequence,
        })),
      };
      await publishActivity(activity);
      const caption = count ? labels.ready + (count > 1 ? ` · ${count} 个任务` : "") : labels.idle;
      await until(
        async () => (await evaluateRenderer(pet.webContents, "bubble.textContent")) === caption,
      );
    };
    const measure = () =>
      evaluateRenderer(
        pet.webContents,
        `(() => {
      const c=canvas.getBoundingClientRect(),b=bubble.getBoundingClientRect();
      const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let painted=0;for(let i=3;i<data.length;i+=4)if(data[i]>16)painted++;
      return {viewport:{width:innerWidth,height:innerHeight},painted,
        canvas:{x:c.x,y:c.y,width:c.width,height:c.height},
        bubble:{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}};
    })()`,
      );
    const settled = async (size) => {
      let current;
      await until(async () => {
        current = await measure();
        const [width, height] = pet.getContentSize();
        const expected = petWindowSize(size);
        return (
          current.painted > 500 &&
          Math.abs(current.canvas.width - PET_SPRITE_SIZE[size]) < 1 &&
          width === expected.width &&
          height === expected.height &&
          current.viewport.width === width &&
          current.viewport.height === height
        );
      });
      return current;
    };
    const check = (current, message, anchor) => {
      const { canvas: c, bubble: b, viewport } = current;
      assert.ok(
        b.right < c.x + c.width / 2,
        `${message}: bubble must remain left of the pet's face`,
      );
      assert.ok(
        b.x >= 7 && b.y >= 0 && b.right <= viewport.width && b.bottom <= viewport.height,
        `${message}: bubble must remain inside its native window`,
      );
      const offset = b.right - c.x;
      if (anchor !== undefined) {
        assert.ok(
          Math.abs(offset - anchor) < 1,
          `${message}: caption changes must not move the pet-side corner`,
        );
      }
      console.log(`PASS ${message}`);
      return offset;
    };
    for (const size of ["small", "medium", "large"]) {
      await patchPet({ config: { size } });
      await publish(0);
      const anchor = check(await settled(size), `${size}: idle`);
      for (const count of [1, 3, 12]) {
        await publish(count);
        check(await settled(size), `${size}: ${count} conversations`, anchor);
      }
    }
    await patchPet({ config: { size: "medium" } });
    const anchor = check(await settled("medium"), "medium restored");
    for (const level of [1, -1, 0]) {
      main.webContents.setZoomLevel(level);
      await until(() => Math.abs(main.webContents.getZoomFactor() - 1.2 ** level) < 0.000001);
      await delay(100);
      assert.ok(
        Math.abs(pet.webContents.getZoomFactor() - 1) < 0.000001,
        "Main-window zoom must not scale or reposition the companion",
      );
      check(await settled("medium"), `main zoom level ${level}`, anchor);
    }
    const original = pet.getBounds();
    for (const bounds of [
      { ...original, width: original.width + 48, height: original.height + 32 },
      original,
    ]) {
      pet.setBounds(bounds);
      await until(async () => {
        const m = await measure();
        return m.viewport.width === bounds.width && m.viewport.height === bounds.height;
      });
      check(await measure(), `viewport ${bounds.width}x${bounds.height}`, anchor);
    }
    // Exercise the actual alpha hit-test after the sprite's origin and viewport change.
    const points = await evaluateRenderer(
      pet.webContents,
      `(() => {
      const c=canvas.getBoundingClientRect(),d=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      for(let y=Math.floor(canvas.height*.65);y<canvas.height*.8;y++)for(let x=Math.floor(canvas.width*.45);x<canvas.width*.55;x++){
        if(d[(y*canvas.width+x)*4+3]>200)return {art:{x:c.x+(x+.5)*c.width/canvas.width,y:c.y+(y+.5)*c.height/canvas.height},blank:{x:innerWidth-2,y:innerHeight-2}};
      }
      throw new Error('The companion has no opaque body hit target');
    })()`,
    );
    for (const [point, expected] of [
      [points.art, true],
      [points.blank, false],
    ]) {
      pet.webContents.send("paseo:overlay:pointer", point);
      await until(
        async () => (await evaluateRenderer(pet.webContents, "interactive")) === expected,
      );
    }
    console.log("PASS opaque pet hit target and transparent click-through area");
    await smokeCustomBubbles({
      app,
      main,
      BrowserWindow,
      library: { importDirectory: (directory) => createLocalPluginCommandHandlers().import_desktop_pet({ directory }) },
      settings: { patchPet },
      labels,
      publishActivity,
    });
  } finally {
    await controller.dispose();
    main.destroy();
  }
  app.exit(0);
}

async function smokeCustomBubbles({ app, main, BrowserWindow, library, settings, labels, publishActivity }) {
  const states = [
    "idle",
    "offline",
    "running",
    "needs_input",
    "ready",
    "blocked",
    "dragging",
    "petted",
  ];
  const makeProfile = (name, appearance) => ({
    appearance,
    states: Object.fromEntries(
      states.map((state) => [
        state,
        { messages: [`${name} ${state}`], delayMs: 0, durationMs: 0, repeatDelayMs: 0 },
      ]),
    ),
  });
  const first = makeProfile("蓝色伙伴", {
    background: "#102846",
    foreground: "#E5F0FA",
    border: "#579ED9",
    shape: "thought",
    fontSize: 13,
    fontWeight: "normal",
    padding: 8,
    borderRadius: 10,
    maxWidth: 200,
    animation: "pop",
  });
  first.states.idle = {
    messages: ["蓝色伙伴第一句", "蓝色伙伴第二句"],
    delayMs: 1800,
    durationMs: 700,
    repeatDelayMs: 1600,
  };
  const second = makeProfile("紫色伙伴", {
    background: "#452044",
    foreground: "#FFF2FB",
    border: "#C786BA",
    shape: "rounded",
    fontSize: 15,
    fontWeight: "bold",
    padding: 10,
    borderRadius: 4,
    maxWidth: 180,
    animation: "fade",
  });
  second.states.idle.messages = [];
  const builtIn = path.join(app.getAppPath(), "assets", "pets", "iris");
  const base = JSON.parse(fs.readFileSync(path.join(builtIn, "pet.json"), "utf8"));
  const installed = [];
  for (const [index, profile] of [first, second].entries()) {
    const directory = path.join(__dirname, `owned-bubble-profile-${index}`);
    fs.mkdirSync(directory);
    fs.copyFileSync(path.join(builtIn, "sprites.png"), path.join(directory, "sprites.png"));
    fs.writeFileSync(
      path.join(directory, "pet.json"),
      JSON.stringify({
        ...base,
        name: `Owned bubble profile ${index}`,
        bubble: profile,
      }),
    );
    installed.push(await library.importDirectory(directory));
  }
  let sequence = 0;
  const publish = async (status) => {
    const activity = {
      connected: true,
      serverIds: ["bubble-smoke"],
      revisions: { "bubble-smoke": null },
      fontFamily: "sans-serif",
      labels,
      tasks: status
        ? [
            {
              serverId: "bubble-smoke",
              agentId: "owned-task",
              title: "Owned bubble task",
              status,
              updatedAt: ++sequence,
            },
          ]
        : [],
    };
    await publishActivity(activity);
  };
  const select = async (id) => {
    await settings.patchPet({ config: { selectedId: id } });
    let window;
    await until(async () => {
      window = BrowserWindow.getAllWindows().find(
        (item) =>
          !item.isDestroyed() &&
          new URL(item.webContents.getURL() || "about:blank").pathname.startsWith("/plugin-overlay/"),
      );
      return (
        window &&
        (await evaluateRenderer(
          window.webContents,
          `typeof state!=='undefined'&&state?.descriptor.id===${JSON.stringify(id)}`,
        ))
      );
    });
    return window;
  };
  const inspect = (window) =>
    evaluateRenderer(
      window.webContents,
      `(() => {
    const style=getComputedStyle(bubble),bounds=bubble.getBoundingClientRect();
    return {text:bubble.textContent,hidden:bubble.hidden,background:style.backgroundColor,
      color:style.color,fontSize:style.fontSize,shape:bubble.dataset.shape,
      bounds:{left:bounds.left,top:bounds.top,right:bounds.right,bottom:bounds.bottom},
      viewport:{width:innerWidth,height:innerHeight}};
  })()`,
    );
  const expectLine = async (window, text) => {
    let current;
    await until(async () => {
      current = await inspect(window);
      return !current.hidden && current.text === text;
    });
    assert.ok(current.bounds.left >= 0 && current.bounds.top >= 0);
    assert.ok(current.bounds.right <= current.viewport.width);
    assert.ok(current.bounds.bottom <= current.viewport.height);
    return current;
  };
  const evidence = process.env.OMP_PET_LAYOUT_EVIDENCE;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const snapshot = async (window, name) => {
    if (!evidence) return;
    await delay(220);
    const image = await window.webContents.capturePage();
    assert.ok(!image.isEmpty(), "The real custom companion capture must contain a surface");
    fs.writeFileSync(path.join(evidence, name), image.toPNG());
  };
  await publish(null);
  let pet = await select(installed[0].id);
  assert.equal(
    (await inspect(pet)).hidden,
    true,
    "Custom initial delay must suppress stock dialogue",
  );
  await expectLine(pet, "蓝色伙伴第一句");
  await publish(null);
  await until(async () => (await inspect(pet)).hidden);
  await expectLine(pet, "蓝色伙伴第二句");
  await publish("needs_input");
  const blue = await expectLine(pet, "蓝色伙伴 needs_input");
  assert.equal(blue.background, "rgb(16, 40, 70)");
  assert.equal(blue.shape, "thought");
  assert.equal(blue.fontSize, "13px");
  await snapshot(pet, "custom-bubble-blue.png");

  pet = await select(installed[1].id);
  const purple = await expectLine(pet, "紫色伙伴 needs_input");
  assert.equal(purple.background, "rgb(69, 32, 68)");
  assert.equal(purple.shape, "rounded");
  assert.equal(purple.fontSize, "15px");
  await snapshot(pet, "custom-bubble-purple.png");
  await publish(null);
  await until(async () => (await inspect(pet)).hidden);
  await delay(300);
  assert.equal(
    (await inspect(pet)).hidden,
    true,
    "Explicit silence must not fall back to a stock line",
  );
  await publish("ready");
  await expectLine(pet, "紫色伙伴 ready");

  pet = await select("iris");
  const legacy = await expectLine(pet, labels.ready);
  assert.equal(legacy.background, "rgb(255, 240, 228)");
  await snapshot(pet, "legacy-bubble-after-custom.png");
  if (evidence)
    fs.writeFileSync(
      path.join(evidence, "custom-bubbles.json"),
      JSON.stringify(
        {
          status: "passed",
          nativeRuntime: process.versions.miniElectron,
          fixtureArt: "owned copies of bundled Iris; no generated images or model calls",
          checks: [
            "initial delay",
            "display duration",
            "repeat rotation",
            "task transition",
            "independent themes and dialogue",
            "explicit silence",
            "legacy isolation",
          ],
          blue,
          purple,
          legacy,
        },
        null,
        2,
      ),
    );
  console.log(
    "PASS real imported custom profiles: independent themes, dialogue, delays, hide/repeat, silence, and legacy isolation",
  );
}

async function evaluateRenderer(contents, source) {
  let timer;
  try {
    return await Promise.race([
      contents.executeJavaScript(`(${source})`),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The real renderer preload action must settle within 5 seconds")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(predicate) {
  const deadline = Date.now() + 5_000;
  do {
    if (await predicate()) return;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the real companion renderer");
}
