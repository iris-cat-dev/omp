const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

// Run the real companion in its own Electron process, profile, and asset directory.
// No daemon, model credentials, or installed-app data are used.
if (!process.versions.electron) {
  const desktopRoot = path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pet-layout-"));
  try {
    const entry = path.join(temporary, path.basename(__filename));
    fs.copyFileSync(__filename, entry);
    fs.cpSync(path.join(desktopRoot, "assets", "pets"), path.join(temporary, "assets", "pets"), {
      recursive: true,
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const result = spawnSync(
      process.env.ELECTRON_PATH || require("electron"),
      [entry, desktopRoot],
      {
        env,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    process.exitCode = result.status === 0 ? 0 : 1;
  } finally {
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
  const desktopRoot = process.argv[2];
  for (const name of ["userData", "sessionData", "logs", "crashDumps"]) {
    const directory = path.join(__dirname, name);
    fs.mkdirSync(directory);
    app.setPath(name, directory);
  }
  app.setName("OMP Pet Layout Smoke");
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
  const { PET_HTML } = product("pets/html.js");
  const { DesktopPetController } = product("pets/controller.js");
  const { DEFAULT_PET_ACTIVITY } = product("pets/activity.js");
  const { getPetLibrary } = product("pets/library.js");
  const { getDesktopSettingsStore } = product("settings/desktop-settings-electron.js");
  const { registerMainWindow } = product("window/main-windows.js");
  const { petWindowSize, PET_SPRITE_SIZE } = product("pets/geometry.js");
  const preload = path.join(__dirname, "controls-preload.js");
  fs.writeFileSync(
    preload,
    'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("petLayoutSmoke",{publish:activity=>ipcRenderer.invoke("paseo:pet:publishActivity",activity)});',
  );
  await app.whenReady();
  protocol.handle("omp-desktop", async (request) => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/desktop-pet") {
      return new Response(PET_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const resource = await getPetLibrary().handleResource(pathname);
    return resource || new Response("<!doctype html><title>Pet layout smoke controls</title>");
  });
  const main = new BrowserWindow({
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  registerMainWindow(main);
  await main.loadURL("omp-desktop://app/pet-layout-smoke");
  const workArea = screen.getPrimaryDisplay().workArea;
  await getDesktopSettingsStore().patch({
    pet: {
      enabled: true,
      selectedId: "iris",
      size: "medium",
      position: { x: workArea.x + 16, y: workArea.y + 16 },
    },
  });
  const controller = new DesktopPetController({ openApp() {}, openTask() {} });
  try {
    await controller.initialize();
    const pet = BrowserWindow.getAllWindows().find(
      (window) => new URL(window.webContents.getURL()).pathname === "/desktop-pet",
    );
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
      await main.webContents.executeJavaScript(
        `window.petLayoutSmoke.publish(${JSON.stringify(activity)})`,
      );
      const caption = count ? labels.ready + (count > 1 ? ` · ${count} 个任务` : "") : labels.idle;
      await until(
        async () => (await pet.webContents.executeJavaScript("bubble.textContent")) === caption,
      );
    };
    const measure = () =>
      pet.webContents.executeJavaScript(`(() => {
      const c=canvas.getBoundingClientRect(),b=bubble.getBoundingClientRect();
      const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let painted=0;for(let i=3;i<data.length;i+=4)if(data[i]>16)painted++;
      return {viewport:{width:innerWidth,height:innerHeight},painted,
        canvas:{x:c.x,y:c.y,width:c.width,height:c.height},
        bubble:{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}};
    })()`);
    const settled = async (size) => {
      let current;
      await until(async () => {
        current = await measure();
        const bounds = pet.getContentBounds();
        const expected = petWindowSize(size);
        return (
          current.painted > 500 &&
          Math.abs(current.canvas.width - PET_SPRITE_SIZE[size]) < 1 &&
          bounds.width === expected.width &&
          bounds.height === expected.height &&
          current.viewport.width === bounds.width &&
          current.viewport.height === bounds.height
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
      await getDesktopSettingsStore().patch({ pet: { size } });
      await publish(0);
      const anchor = check(await settled(size), `${size}: idle`);
      for (const count of [1, 3, 12]) {
        await publish(count);
        check(await settled(size), `${size}: ${count} conversations`, anchor);
      }
    }
    await getDesktopSettingsStore().patch({ pet: { size: "medium" } });
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
    const points = await pet.webContents.executeJavaScript(`(() => {
      const c=canvas.getBoundingClientRect(),d=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      for(let y=Math.floor(canvas.height*.65);y<canvas.height*.8;y++)for(let x=Math.floor(canvas.width*.45);x<canvas.width*.55;x++){
        if(d[(y*canvas.width+x)*4+3]>200)return {art:{x:c.x+(x+.5)*c.width/canvas.width,y:c.y+(y+.5)*c.height/canvas.height},blank:{x:innerWidth-2,y:innerHeight-2}};
      }
      throw new Error('The companion has no opaque body hit target');
    })()`);
    for (const [point, expected] of [
      [points.art, true],
      [points.blank, false],
    ]) {
      pet.webContents.send("paseo:pet:pointer", point);
      await until(
        async () => (await pet.webContents.executeJavaScript("interactive")) === expected,
      );
    }
    console.log("PASS opaque pet hit target and transparent click-through area");
  } finally {
    controller.dispose();
    main.destroy();
  }
  app.exit(0);
}

async function until(predicate) {
  const deadline = Date.now() + 5_000;
  do {
    if (await predicate()) return;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("Timed out waiting for the real companion renderer");
}
