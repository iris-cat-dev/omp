// Loaded through NODE_OPTIONS in the real signed app; product entry and resources stay unchanged.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");

if (process.env.ELECTRON_RUN_AS_NODE !== "1" && process.env.OMP_DESKTOP_NATIVE_SMOKE_SECONDARY !== "1") {
  // Node preloads run before mini-electron registers its electron API.
  setImmediate(() => {
    const { app, BrowserWindow } = require("electron");
    const config = JSON.parse(fs.readFileSync(process.env.OMP_DESKTOP_NATIVE_SMOKE_CONFIG, "utf8"));
    const root = fs.realpathSync(config.root);
    const owned = (file) => {
      const relative = path.relative(root, fs.realpathSync(file));
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    const write = (file, value) => {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
      fs.renameSync(`${file}.tmp`, file);
    };
    const mainWindow = () => BrowserWindow.getAllWindows().find((window) =>
      !window.isDestroyed() && window.webContents.getURL().startsWith("omp-desktop://app/"));

    async function createTerminal(request) {
      const cwd = fs.realpathSync(request.cwd);
      if (!owned(cwd)) throw new Error("Smoke terminal escaped its owned profile");
      const connector = path.join(process.resourcesPath, "app/node_modules/@omp-desktop/cli/dist/utils/client.js");
      const { connectToDaemon } = await import(pathToFileURL(connector).href);
      const client = await connectToDaemon({ host: process.env.PASEO_LISTEN, timeout: 10_000 });
      try {
        const opened = await client.openProject(cwd);
        if (!opened.workspace) throw new Error(opened.error || "Owned terminal workspace was not created");
        const created = await client.createTerminal(cwd, request.name, undefined, {
          workspaceId: opened.workspace.id, command: "/bin/zsh", args: ["-l"],
        });
        if (!created.terminal) throw new Error(created.error || "Owned native terminal was not created");
        return { id: created.terminal.id };
      } finally {
        await client.close();
      }
    }

    async function command(request) {
      if (request.action === "inspect") return {
        pid: process.pid, packaged: app.isPackaged, version: app.getVersion(),
        miniElectron: process.versions.miniElectron, executable: process.execPath,
        resources: process.resourcesPath, home: app.getPath("home"), userData: app.getPath("userData"),
      };
      if (request.action === "terminal-create") return createTerminal(request);
      if (request.action === "quit") {
        setTimeout(() => app.quit(), 50);
        return true;
      }
      const deadline = Date.now() + 25_000;
      let window;
      while (!(window = mainWindow()) && Date.now() < deadline) await delay(100);
      if (!window) throw new Error("Real packaged app window did not load");
      if (request.action === "window-state") return { visible: window.isVisible(), bounds: window.getBounds(), url: window.webContents.getURL() };
      if (request.action === "evaluate") return (await window.webContents.executeJavaScript(request.source)) ?? null;
      if (request.action === "capture") {
        const image = await window.webContents.capturePage();
        const size = image.getSize();
        if (size.width < 1 || size.height < 1) throw new Error("Native window capture was empty");
        const destination = path.join(config.evidence, "app.png");
        fs.writeFileSync(destination, image.toPNG());
        return { path: destination, size };
      }
      throw new Error(`Unknown native smoke action: ${request.action}`);
    }

    async function serve() {
      if (!owned(app.getPath("home")) || !owned(app.getPath("userData")))
        throw new Error("Native app profile escaped the owned smoke root");
      await app.whenReady();
      write(path.join(config.control, "ready.json"), { pid: process.pid });
      for (let sequence = 1; Date.now() < config.deadline;) {
        try { process.kill(config.driverPid, 0); }
        catch (error) {
          if (error.code !== "ESRCH") throw error;
          app.quit();
          return;
        }
        const file = path.join(config.control, `${sequence}.request.json`);
        if (!fs.existsSync(file)) { await delay(30); continue; }
        const request = JSON.parse(fs.readFileSync(file, "utf8"));
        let response;
        try { response = { ok: true, value: await command(request) }; }
        catch (error) { response = { ok: false, error: error.stack || String(error) }; }
        write(path.join(config.control, `${sequence}.response.json`), response);
        sequence += 1;
        if (request.action === "quit") return;
      }
      throw new Error("Native packaged smoke exceeded its owned deadline");
    }

    serve().catch((error) => {
      write(path.join(config.control, "failure.json"), { error: error.stack || String(error) });
      app.exit(1);
    });
  });
}
